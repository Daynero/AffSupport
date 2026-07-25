import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptSegment,
  TranscriptWord,
  TranslationDocument
} from '@video-compressor/shared';
import { buildSegmentsFromWords, type WhisperWord } from '../whisper/words.js';

const LEXICAL_UNIT = /[\p{L}\p{M}\p{N}]+/gu;
const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Overlapping 20-second primary/recovery windows can put several alternative
// decodings between two consecutive canonical words. Keep the search local so
// a missing word cannot accidentally jump karaoke to a later repeated phrase.
const WORD_ALIGNMENT_LOOKAHEAD = 512;

interface LexicalUnit {
  normalized: string;
  start: number;
  end: number;
}

interface TimedLexicalUnit {
  normalized: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

function lexicalUnits(text: string): LexicalUnit[] {
  const units: LexicalUnit[] = [];
  for (const match of text.matchAll(LEXICAL_UNIT)) {
    const value = match[0];
    const start = match.index;
    if (!NO_SPACE_SCRIPT.test(value)) {
      units.push({
        normalized: value.normalize('NFKC').toLocaleLowerCase(),
        start,
        end: start + value.length
      });
      continue;
    }

    // Scripts that normally omit spaces would otherwise turn an entire line
    // into one lexical unit while whisper emits several timestamped tokens.
    // Split those runs into visible code points and keep combining marks on the
    // preceding base character.
    let cursor = start;
    for (const point of Array.from(value)) {
      const end = cursor + point.length;
      if (/^\p{M}$/u.test(point) && units.length && units.at(-1)?.end === cursor) {
        const previous = units[units.length - 1];
        previous.normalized += point.normalize('NFKC').toLocaleLowerCase();
        previous.end = end;
      } else {
        units.push({
          normalized: point.normalize('NFKC').toLocaleLowerCase(),
          start: cursor,
          end
        });
      }
      cursor = end;
    }
  }
  return units;
}

function trailingPunctuationEnd(text: string, end: number): number {
  let cursor = end;
  while (cursor < text.length) {
    const point = String.fromCodePoint(text.codePointAt(cursor) ?? 0);
    if (/[\s\p{L}\p{M}\p{N}]/u.test(point)) break;
    cursor += point.length;
  }
  return cursor;
}

function timedLexicalUnits(words: WhisperWord[]): TimedLexicalUnit[] {
  return words
    .map((word, index) => ({ word, index }))
    .sort(
      (left, right) =>
        left.word.startMs - right.word.startMs ||
        left.word.endMs - right.word.endMs ||
        left.index - right.index
    )
    .flatMap(({ word }) => {
      const units = lexicalUnits(word.text);
      const startMs = Math.max(0, Math.round(word.startMs));
      const endMs = Math.max(startMs, Math.round(word.endMs));
      const durationMs = endMs - startMs;
      return units.map((unit, index) => ({
        normalized: unit.normalized,
        // A whisper word can contain punctuation-separated lexical units
        // (`50,000`, `araw-araw`). Divide its span so the resulting karaoke
        // words stay ordered and non-overlapping.
        startMs: startMs + Math.round((durationMs * index) / units.length),
        endMs: startMs + Math.round((durationMs * (index + 1)) / units.length),
        confidence: word.confidence
      }));
    });
}

/**
 * Splits a merged plain-text transcript into structured segments. The
 * transcriber joins sentence-ish lines with `\n`, so one line becomes one
 * segment. Character offsets in each segment's words index into `sourceText`;
 * word-level timestamps are added by the whisper pipeline once available, so
 * `words` is empty here and `startMs`/`endMs` stay at 0 until then.
 */
export function segmentsFromText(jobId: string, text: string): TranscriptSegment[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((sourceText, index) => ({
      id: `${jobId}-s${index}`,
      startMs: 0,
      endMs: 0,
      sourceText,
      words: []
    }));
}

/**
 * Keeps the already-deduplicated plain transcript authoritative and attaches
 * word timings only to lexical units that occur in that text, in order.
 *
 * Timestamp candidates come from several overlapping whisper windows. Sorting
 * every candidate by time and rebuilding text from them interleaves alternative
 * decodings of the same audio (for example `Hindi ito Hindi nakadepende ito`).
 * Treating candidates as alignment metadata instead means they can never add,
 * remove, or repeat visible transcript text.
 */
export function segmentsFromTextWithWords(
  jobId: string,
  text: string,
  words: WhisperWord[]
): TranscriptSegment[] {
  const segments = segmentsFromText(jobId, text);
  if (!segments.length || !words.length) return segments;

  const candidates = timedLexicalUnits(words);
  const candidateIndexes = new Map<string, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const indexes = candidateIndexes.get(candidates[index].normalized) ?? [];
    indexes.push(index);
    candidateIndexes.set(candidates[index].normalized, indexes);
  }

  let candidateCursor = 0;
  for (const segment of segments) {
    const aligned: TranscriptWord[] = [];
    for (const source of lexicalUnits(segment.sourceText)) {
      const indexes = candidateIndexes.get(source.normalized);
      if (!indexes) continue;

      // Find the first occurrence at or after the current timeline cursor.
      let low = 0;
      let high = indexes.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (indexes[middle] < candidateCursor) low = middle + 1;
        else high = middle;
      }
      const candidateIndex = indexes[low];
      if (
        candidateIndex === undefined ||
        candidateIndex - candidateCursor > WORD_ALIGNMENT_LOOKAHEAD
      ) {
        continue;
      }

      const candidate = candidates[candidateIndex];
      const sourceEnd = trailingPunctuationEnd(segment.sourceText, source.end);
      aligned.push({
        id: `${segment.id}-w${aligned.length}`,
        text: segment.sourceText.slice(source.start, sourceEnd),
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        confidence: candidate.confidence,
        sourceStart: source.start,
        sourceEnd
      });
      candidateCursor = candidateIndex + 1;
    }
    segment.words = aligned;
    if (aligned.length) {
      segment.startMs = aligned[0].startMs;
      segment.endMs = aligned[aligned.length - 1].endMs;
    }
  }
  return segments;
}

/**
 * Stable hash of the source transcript, used as the invariant part of the
 * translation cache key so a re-transcription that yields identical text
 * reuses cached translations, while any text change invalidates them.
 */
export function sourceContentHash(segments: TranscriptSegment[]): string {
  const hash = createHash('sha256');
  for (const segment of segments) hash.update(segment.sourceText).update('\n');
  return hash.digest('hex').slice(0, 32);
}

/**
 * Builds the structured document for a completed job. When word timestamps are
 * available they drive sentence-sized segments with per-word timing (for
 * karaoke); otherwise it falls back to one segment per transcript line.
 */
export function buildTranscriptionDocument(
  job: TranscriptionJob,
  modelVersion: string,
  words: WhisperWord[] = []
): TranscriptionDocument {
  const text = job.text ?? '';
  return {
    jobId: job.id,
    sourceLanguage: job.detectedLanguage ?? job.requestedLanguage ?? 'auto',
    modelVersion,
    // The merged text is the canonical transcript. Word JSON is an auxiliary
    // timing source and must never be allowed to reconstruct different text.
    segments: text
      ? segmentsFromTextWithWords(job.id, text, words)
      : words.length
        ? buildSegmentsFromWords(job.id, words)
        : [],
    translations: {}
  };
}

/** Text-only document (no word timestamps). Kept for the fallback path. */
export function buildTextTranscriptionDocument(
  job: TranscriptionJob,
  modelVersion: string
): TranscriptionDocument {
  return buildTranscriptionDocument(job, modelVersion, []);
}

/**
 * Persists structured transcription documents as local JSON sidecars under
 * Application Support, never beside the source media. Documents are large
 * (words + translations) so they are fetched on demand, never streamed in SSE.
 */
export class TranscriptionDocumentStore {
  constructor(private readonly dir: string) {}

  private file(jobId: string): string {
    // jobIds are server-generated UUIDs; guard anyway so a stray value can
    // never escape the documents directory.
    const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '');
    return path.join(this.dir, `${safe}.json`);
  }

  async save(document: TranscriptionDocument): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(document.jobId);
    // A unique temp name per write so concurrent saves for the same document
    // never collide on one `.part` file; the rename then atomically replaces.
    const partial = `${target}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(partial, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
    await rename(partial, target).catch(async error => {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    });
  }

  async load(jobId: string): Promise<TranscriptionDocument | null> {
    try {
      const raw = await readFile(this.file(jobId), 'utf8');
      return JSON.parse(raw) as TranscriptionDocument;
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    await rm(this.file(jobId), { force: true }).catch(() => {});
  }
}

/**
 * Cross-document translation cache keyed by the exact
 * sourceHash+sourceLanguage+targetLanguage+modelVersion tuple. The filename is
 * a SHA-256 of the key so embedded separators never become path characters.
 */
export class TranslationCacheStore {
  constructor(private readonly dir: string) {}

  private file(cacheKey: string): string {
    const digest = createHash('sha256').update(cacheKey).digest('hex');
    return path.join(this.dir, `${digest}.json`);
  }

  async load(cacheKey: string): Promise<TranslationDocument | null> {
    try {
      const raw = await readFile(this.file(cacheKey), 'utf8');
      const value = JSON.parse(raw) as TranslationDocument;
      return value.cacheKey === cacheKey && value.status === 'completed' ? value : null;
    } catch {
      return null;
    }
  }

  async save(translation: TranslationDocument): Promise<void> {
    if (!translation.cacheKey || translation.status !== 'completed') return;
    await mkdir(this.dir, { recursive: true });
    const target = this.file(translation.cacheKey);
    const partial = `${target}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(partial, JSON.stringify(translation), { encoding: 'utf8', mode: 0o600 });
    await rename(partial, target).catch(async error => {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    });
  }
}
