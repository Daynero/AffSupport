import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { replaceFile } from '../files/replace-file.js';
import path from 'node:path';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptSegment,
  TranscriptWord,
  TranslationDocument,
  TranscriptionReliability
} from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { lexicalUnitSpans, splitTextForTranslation } from '../translation/segmentation.js';
import { buildSegmentsFromWords, type WhisperWord } from '../whisper/words.js';

/** Canonical sidecar directory, shared by the queue and the persisted-state loader. */
export function transcriptionDocumentsRoot(): string {
  return (
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH ??
    path.join(applicationSupportRoot(), 'TranscriptionDocuments')
  );
}

/** The JSON sidecar file for one job id inside `dir`. */
export function transcriptionDocumentFile(dir: string, jobId: string): string {
  // jobIds are server-generated UUIDs; guard anyway so a stray value can
  // never escape the documents directory.
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '');
  return path.join(dir, `${safe}.json`);
}

// Match bounded phrases so a missing timing token cannot steal a later
// occurrence of a common word and consume the rest of the alignment cursor.
const WORD_ALIGNMENT_LOOKAHEAD = 32;

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
  return lexicalUnitSpans(text).map(({ start, end }) => ({
    normalized: text.slice(start, end).normalize('NFKC').toLocaleLowerCase(),
    start,
    end
  }));
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
 * Splits a merged plain-text transcript into bounded translation-sized
 * segments. Whisper usually emits sentence-ish lines, but rapid speech can
 * contain almost no sentence punctuation and previously produced 50–60 second
 * segments. Those overwhelmed the small local translator and triggered
 * hallucinated repetition. Long lines are now split at natural punctuation or
 * lexical boundaries before word timings are attached.
 */
export function segmentsFromText(jobId: string, text: string): TranscriptSegment[] {
  return splitTextForTranslation(text).map((sourceText, index) => ({
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
  const unitsBySegment = segments.map(segment => lexicalUnits(segment.sourceText));
  const sources = unitsBySegment.flat();
  const matches = new Map<LexicalUnit, TimedLexicalUnit>();
  const hasProvenance = words.every(
    word => word.canonicalStart !== undefined && word.canonicalEnd !== undefined
  );
  if (hasProvenance) {
    const anchored = new Map(words.map(word => [word.canonicalStart, word]));
    let offset = 0;
    for (const [index, segment] of segments.entries()) {
      const start = text.indexOf(segment.sourceText, offset);
      offset = start + segment.sourceText.length;
      for (const unit of unitsBySegment[index]) {
        const word = anchored.get(start + unit.start);
        if (
          word &&
          word.canonicalEnd === start + unit.end &&
          word.text.normalize('NFKC').toLocaleLowerCase() === unit.normalized
        ) {
          matches.set(unit, {
            normalized: unit.normalized,
            startMs: word.startMs,
            endMs: word.endMs,
            confidence: word.confidence
          });
        }
      }
    }
  }
  const candidateIndexes = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    const indexes = candidateIndexes.get(candidate.normalized) ?? [];
    indexes.push(index);
    candidateIndexes.set(candidate.normalized, indexes);
  }
  let sourceCursor = 0;
  let candidateCursor = 0;
  // Align phrases, rather than greedily binding a missing common word to its
  // next occurrence. Bounded windows keep long recordings linear in length.
  while (!hasProvenance && sourceCursor < sources.length && candidateCursor < candidates.length) {
    const sourceCount = Math.min(WORD_ALIGNMENT_LOOKAHEAD, sources.length - sourceCursor);
    const candidateCount = Math.min(
      WORD_ALIGNMENT_LOOKAHEAD * 2,
      candidates.length - candidateCursor
    );
    const width = candidateCount + 1;
    const table = new Uint16Array((sourceCount + 1) * width);
    for (let i = sourceCount - 1; i >= 0; i -= 1) {
      for (let j = candidateCount - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          sources[sourceCursor + i].normalized === candidates[candidateCursor + j].normalized
            ? 1 + table[(i + 1) * width + j + 1]
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    if (table[0] === 0) {
      // A long discarded decode can exceed the local DP horizon. Re-enter at
      // a consecutive phrase, not a single common word far down the timeline.
      let anchor: { source: number; candidate: number } | null = null;
      for (
        let s = sourceCursor;
        s < Math.min(sources.length - 2, sourceCursor + sourceCount);
        s++
      ) {
        const indexes = candidateIndexes.get(sources[s].normalized) ?? [];
        let low = 0;
        let high = indexes.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (indexes[mid] < candidateCursor) low = mid + 1;
          else high = mid;
        }
        for (const c of indexes.slice(low, low + 128)) {
          if (
            c + 2 < candidates.length &&
            sources[s + 1].normalized === candidates[c + 1].normalized &&
            sources[s + 2].normalized === candidates[c + 2].normalized
          ) {
            if (!anchor || c < anchor.candidate) anchor = { source: s, candidate: c };
            break;
          }
        }
      }
      if (anchor) {
        sourceCursor = anchor.source;
        candidateCursor = anchor.candidate;
        continue;
      }
    }
    let i = 0;
    let j = 0;
    while (i < sourceCount && j < candidateCount) {
      const source = sources[sourceCursor + i];
      const candidate = candidates[candidateCursor + j];
      if (source.normalized === candidate.normalized) {
        matches.set(source, candidate);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
      // Refill before the horizon can bias the next phrase's alignment.
      if (i >= WORD_ALIGNMENT_LOOKAHEAD / 2 || j >= WORD_ALIGNMENT_LOOKAHEAD) break;
    }
    sourceCursor += i;
    candidateCursor += j;
  }

  for (const [segmentIndex, segment] of segments.entries()) {
    const aligned: TranscriptWord[] = [];
    for (const source of unitsBySegment[segmentIndex]) {
      const candidate = matches.get(source);
      if (!candidate) continue;
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
  words: WhisperWord[] = [],
  englishText = '',
  englishWords: WhisperWord[] = [],
  reliability?: TranscriptionReliability
): TranscriptionDocument {
  const text = job.text ?? '';
  const segments = text
    ? segmentsFromTextWithWords(job.id, text, words)
    : words.length
      ? buildSegmentsFromWords(job.id, words)
      : [];
  // Missing word timing must not make a whole phrase seek to 00:00. The
  // original audio window is a navigation fallback, explicitly approximate.
  if (reliability?.ranges?.length) {
    let textCursor = 0;
    let rangeCursor = 0;
    for (const segment of segments) {
      const start = text.indexOf(segment.sourceText, textCursor);
      textCursor = start + segment.sourceText.length;
      while (
        rangeCursor + 1 < reliability.ranges.length &&
        reliability.ranges[rangeCursor].canonicalEnd <= start
      )
        rangeCursor++;
      if (segment.words.length) continue;
      const range = reliability.ranges[rangeCursor];
      if (range.canonicalStart < textCursor && range.canonicalEnd > start) {
        segment.startMs = range.startMs;
        segment.endMs = range.endMs;
        segment.timingSource = 'window';
      }
    }
  }
  const translationSourceSegments = buildTranslationSourceSegments(
    segments,
    englishText,
    englishWords
  );
  return {
    jobId: job.id,
    sourceLanguage: job.detectedLanguage ?? job.requestedLanguage ?? 'auto',
    modelVersion,
    // The merged text is the canonical transcript. Word JSON is an auxiliary
    // timing source and must never be allowed to reconstruct different text.
    segments,
    ...(reliability
      ? {
          reliability: {
            ...reliability,
            warnings: [...reliability.warnings],
            timedWords: segments.flatMap(segment => segment.words).length
          }
        }
      : {}),
    ...(translationSourceSegments
      ? {
          translationSource: {
            language: 'en',
            modelVersion: `${modelVersion}:speech-to-en`,
            segments: translationSourceSegments
          }
        }
      : {}),
    translations: {}
  };
}

/**
 * Re-buckets Whisper's sequential English speech translation onto the visible
 * source segments. Both streams follow the same audio but may choose different
 * sentence boundaries, so cumulative source word weight is more stable than
 * trying to match misspelled cross-language words or fragile exact timestamps.
 */
export function buildTranslationSourceSegments(
  sourceSegments: TranscriptSegment[],
  englishText: string,
  englishWords: WhisperWord[] = []
): Array<{ sourceSegmentId: string; text: string }> | null {
  const normalized = englishText.replace(/[^\S\r\n]+/gu, ' ').trim();
  if (!sourceSegments.length || !normalized) return null;
  const pivotUnits = lexicalUnits(normalized);
  if (pivotUnits.length < sourceSegments.length) return null;

  const weights = sourceSegments.map(segment =>
    Math.max(1, lexicalUnits(segment.sourceText).length)
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const averagePivotUnits = pivotUnits.length / sourceSegments.length;
  const temporalEnds = translationSourceTemporalEnds(
    sourceSegments,
    normalized,
    englishWords,
    pivotUnits
  );
  const mapped: Array<{ sourceSegmentId: string; text: string }> = [];
  let cumulativeWeight = 0;
  let unitCursor = 0;
  let charCursor = 0;

  for (let index = 0; index < sourceSegments.length; index += 1) {
    cumulativeWeight += weights[index];
    const remainingSegments = sourceSegments.length - index - 1;
    const proportionalEnd =
      index === sourceSegments.length - 1
        ? pivotUnits.length
        : Math.round((cumulativeWeight / totalWeight) * pivotUnits.length);
    const latestEnd = pivotUnits.length - remainingSegments;
    const temporalEnd = temporalEnds.get(index);
    const unitEnd =
      index === sourceSegments.length - 1
        ? pivotUnits.length
        : temporalEnd !== undefined && temporalEnd > unitCursor && temporalEnd <= latestEnd
          ? temporalEnd
          : preferredTranslationSourceBoundary(
              normalized,
              pivotUnits,
              unitCursor,
              proportionalEnd,
              latestEnd,
              averagePivotUnits
            );
    const charEnd = pivotUnits[unitEnd]?.start ?? normalized.length;
    const part = normalized.slice(charCursor, charEnd).replace(/\s+/gu, ' ').trim();
    if (!part) return null;
    mapped.push({ sourceSegmentId: sourceSegments[index].id, text: part });
    unitCursor = unitEnd;
    charCursor = charEnd;
  }
  return mapped;
}

function translationSourceTemporalEnds(
  sourceSegments: TranscriptSegment[],
  text: string,
  words: WhisperWord[],
  units: LexicalUnit[]
): Map<number, number> {
  const ends = new Map<number, number>();
  if (!words.length || !sourceSegments.some(segment => segment.endMs > segment.startMs))
    return ends;

  const pivotSegments = segmentsFromTextWithWords('__translation-pivot__', text, words);
  const anchors: Array<{ unitIndex: number; startMs: number; endMs: number }> = [];
  let segmentSearchStart = 0;
  let unitSearchStart = 0;
  for (const segment of pivotSegments) {
    const segmentStart = text.indexOf(segment.sourceText, segmentSearchStart);
    if (segmentStart < 0) continue;
    segmentSearchStart = segmentStart + segment.sourceText.length;
    for (const word of segment.words) {
      const globalStart = segmentStart + word.sourceStart;
      while (unitSearchStart < units.length && units[unitSearchStart].start < globalStart) {
        unitSearchStart += 1;
      }
      if (unitSearchStart >= units.length) break;
      anchors.push({
        unitIndex: unitSearchStart,
        startMs: word.startMs,
        endMs: word.endMs
      });
    }
  }
  if (anchors.length < sourceSegments.length) return ends;

  for (let index = 0; index < sourceSegments.length - 1; index += 1) {
    const segment = sourceSegments[index];
    // Artificial 32-word cuts are better snapped to English punctuation by the
    // proportional mapper. Exact audio timing is most valuable at a genuine
    // source sentence boundary, especially for adjacent short slogans.
    if (!/[.!?…।॥؟。！？]$/u.test(segment.sourceText.trim()) || segment.endMs <= 0) continue;
    const nextStart = sourceSegments[index + 1].startMs;
    const boundaryMs =
      nextStart > 0 && nextStart >= segment.endMs ? (segment.endMs + nextStart) / 2 : segment.endMs;
    const nextAnchor = anchors.find(anchor => (anchor.startMs + anchor.endMs) / 2 >= boundaryMs);
    if (nextAnchor) ends.set(index, nextAnchor.unitIndex);
  }
  return ends;
}

function preferredTranslationSourceBoundary(
  text: string,
  units: LexicalUnit[],
  unitCursor: number,
  targetEnd: number,
  latestEnd: number,
  averageUnits: number
): number {
  const radius = Math.max(4, Math.min(16, Math.round(averageUnits / 2)));
  const minEnd = Math.min(latestEnd, Math.max(unitCursor + 1, targetEnd - radius));
  const maxEnd = Math.max(minEnd, Math.min(latestEnd, targetEnd + radius));
  let bestEnd = Math.min(maxEnd, Math.max(minEnd, targetEnd));
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let end = minEnd; end <= maxEnd; end += 1) {
    const nextStart = units[end]?.start ?? text.length;
    const between = text.slice(units[end - 1].end, nextStart);
    const rank = /[.!?…।॥؟。！？]["'»”’)\]}]*\s*$/u.test(between)
      ? 4
      : /\r?\n/u.test(between)
        ? 3
        : /[,;:،؛]["'»”’)\]}]*\s*$/u.test(between)
          ? 2
          : /\s/u.test(between)
            ? 1
            : 0;
    const score = rank * 100 - Math.abs(end - targetEnd);
    if (score > bestScore) {
      bestScore = score;
      bestEnd = end;
    }
  }
  return bestEnd;
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
    return transcriptionDocumentFile(this.dir, jobId);
  }

  async save(
    document: TranscriptionDocument,
    shouldCommit: () => boolean = () => true
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(document.jobId);
    // A unique temp name per write so concurrent saves for the same document
    // never collide on one `.part` file; the rename then atomically replaces.
    const partial = `${target}.${randomBytes(6).toString('hex')}.part`;
    try {
      await writeFile(partial, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
      if (!shouldCommit()) return;
      await replaceFile(partial, target);
    } finally {
      await rm(partial, { force: true }).catch(() => {});
    }
  }

  async load(jobId: string): Promise<TranscriptionDocument | null> {
    try {
      const raw = await readFile(this.file(jobId), 'utf8');
      const document = validDocument(JSON.parse(raw));
      return document?.jobId === jobId ? document : null;
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    await rm(this.file(jobId), { force: true }).catch(() => {});
  }
}

/**
 * The shape every reader relies on, checked once at the door.
 *
 * A sidecar is a file, and a file can be truncated by a crash mid-write of an older build,
 * edited by hand, or written by a version with a different idea of the fields. Every
 * consumer used to trust the cast and throw somewhere far from the cause; a document that
 * does not hold up is treated as absent instead, which the callers already handle.
 */
export function validDocument(value: unknown): TranscriptionDocument | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.jobId !== 'string' || typeof raw.sourceLanguage !== 'string') return null;
  if (!Array.isArray(raw.segments)) return null;
  if (raw.reliability !== undefined) {
    if (!raw.reliability || typeof raw.reliability !== 'object') return null;
    const reliability = raw.reliability as Record<string, unknown>;
    if (
      !['windows', 'retries', 'recoveredWindows', 'timedWords', 'totalWords'].every(
        key =>
          typeof reliability[key] === 'number' &&
          Number.isSafeInteger(reliability[key]) &&
          (reliability[key] as number) >= 0
      ) ||
      !Array.isArray(reliability.warnings)
    )
      return null;
    if (
      reliability.ranges !== undefined &&
      (!Array.isArray(reliability.ranges) ||
        !reliability.ranges.every(
          range =>
            range &&
            typeof range === 'object' &&
            ['canonicalStart', 'canonicalEnd', 'startMs', 'endMs'].every(
              key =>
                typeof range[key] === 'number' && Number.isFinite(range[key]) && range[key] >= 0
            ) &&
            Number.isInteger(range.canonicalStart) &&
            Number.isInteger(range.canonicalEnd) &&
            range.canonicalEnd >= range.canonicalStart &&
            range.endMs >= range.startMs
        ))
    )
      return null;
    for (const warning of reliability.warnings as unknown[]) {
      if (!warning || typeof warning !== 'object') return null;
      const w = warning as Record<string, unknown>;
      if (
        ![
          'SEAM_UNCERTAIN',
          'DECODE_UNCERTAIN',
          'COVERAGE_UNVERIFIED',
          'TIMINGS_PARTIAL',
          'PIVOT_UNAVAILABLE'
        ].includes(String(w.code)) ||
        typeof w.startMs !== 'number' ||
        typeof w.endMs !== 'number' ||
        !Number.isFinite(w.startMs) ||
        !Number.isFinite(w.endMs) ||
        w.startMs < 0 ||
        w.endMs < w.startMs
      )
        return null;
    }
  }
  if (raw.translationSource !== undefined) {
    if (!raw.translationSource || typeof raw.translationSource !== 'object') return null;
    const source = raw.translationSource as Record<string, unknown>;
    if (
      typeof source.language !== 'string' ||
      typeof source.modelVersion !== 'string' ||
      !Array.isArray(source.segments) ||
      !source.segments.every(
        segment =>
          segment &&
          typeof segment === 'object' &&
          typeof segment.sourceSegmentId === 'string' &&
          typeof segment.text === 'string'
      )
    )
      return null;
  }
  for (const segment of raw.segments as unknown[]) {
    if (!segment || typeof segment !== 'object') return null;
    const entry = segment as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.sourceText !== 'string') return null;
    if (
      entry.timingSource !== undefined &&
      entry.timingSource !== 'words' &&
      entry.timingSource !== 'window'
    )
      return null;
    if (!Array.isArray(entry.words)) return null;
    const range = (from: unknown, to: unknown) =>
      typeof from === 'number' &&
      typeof to === 'number' &&
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      from >= 0 &&
      to >= from;
    if (!range(entry.startMs, entry.endMs)) return null;
    for (const word of entry.words as unknown[]) {
      if (!word || typeof word !== 'object') return null;
      const w = word as Record<string, unknown>;
      if (
        typeof w.id !== 'string' ||
        typeof w.text !== 'string' ||
        !range(w.startMs, w.endMs) ||
        !range(w.sourceStart, w.sourceEnd) ||
        !Number.isInteger(w.sourceStart) ||
        !Number.isInteger(w.sourceEnd) ||
        (w.sourceEnd as number) > entry.sourceText.length ||
        entry.sourceText.slice(w.sourceStart as number, w.sourceEnd as number) !== w.text ||
        (w.confidence !== null &&
          (typeof w.confidence !== 'number' ||
            !Number.isFinite(w.confidence) ||
            w.confidence < 0 ||
            w.confidence > 1))
      )
        return null;
    }
  }
  if (raw.translations !== undefined && (!raw.translations || typeof raw.translations !== 'object'))
    return null;
  const translations =
    raw.translations && typeof raw.translations === 'object' ? raw.translations : {};
  if (Array.isArray(translations)) return null;
  for (const translation of Object.values(translations)) {
    if (!translation || typeof translation !== 'object') return null;
    const t = translation as Record<string, unknown>;
    if (
      typeof t.targetLanguage !== 'string' ||
      typeof t.modelVersion !== 'string' ||
      !['queued', 'processing', 'completed', 'failed'].includes(String(t.status)) ||
      !Array.isArray(t.segments)
    )
      return null;
    for (const segment of t.segments as unknown[]) {
      if (!segment || typeof segment !== 'object') return null;
      const s = segment as Record<string, unknown>;
      if (
        typeof s.sourceSegmentId !== 'string' ||
        typeof s.translatedText !== 'string' ||
        !Array.isArray(s.alignments)
      )
        return null;
      for (const link of s.alignments as unknown[]) {
        if (!link || typeof link !== 'object') return null;
        const a = link as Record<string, unknown>;
        if (
          !['sourceStart', 'sourceEnd', 'targetStart', 'targetEnd'].every(
            key => typeof a[key] === 'number' && Number.isInteger(a[key]) && (a[key] as number) >= 0
          ) ||
          (a.targetEnd as number) > s.translatedText.length ||
          (a.targetEnd as number) < (a.targetStart as number) ||
          (a.sourceEnd as number) < (a.sourceStart as number) ||
          typeof a.confidence !== 'number' ||
          !Number.isFinite(a.confidence) ||
          a.confidence < 0 ||
          a.confidence > 1
        )
          return null;
      }
    }
  }
  return {
    ...(raw as unknown as TranscriptionDocument),
    modelVersion: typeof raw.modelVersion === 'string' ? raw.modelVersion : '',
    translations: translations as TranscriptionDocument['translations']
  };
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
    await replaceFile(partial, target).catch(async error => {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    });
  }

  /**
   * Removes entries nothing will read again.
   *
   * The cache grew for as long as the application was installed: one file per transcript
   * and language, and a translator update orphaned every one of them, since the model
   * version is part of the key. An entry from another model version, or one untouched for
   * the given age, goes; a torn `.part` from a crash goes with it.
   */
  async sweep(options: { currentModelVersion?: string; maxAgeMs: number }): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - options.maxAgeMs;
    let removed = 0;
    for (const entry of entries) {
      const file = path.join(this.dir, entry);
      try {
        if (entry.endsWith('.part')) {
          await rm(file, { force: true });
          removed += 1;
          continue;
        }
        if (!entry.endsWith('.json')) continue;
        const info = await stat(file);
        let stale = info.mtimeMs < cutoff;
        if (!stale && options.currentModelVersion) {
          const value = JSON.parse(await readFile(file, 'utf8')) as Partial<TranslationDocument>;
          stale = value.modelVersion !== options.currentModelVersion;
        }
        if (stale) {
          await rm(file, { force: true });
          removed += 1;
        }
      } catch {
        // Unreadable is as good as stale: a cache entry that cannot be parsed is never served.
        await rm(file, { force: true }).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }
}
