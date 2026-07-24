import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptSegment,
  TranslationDocument
} from '@video-compressor/shared';
import { buildSegmentsFromWords, type WhisperWord } from '../whisper/words.js';

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
  return {
    jobId: job.id,
    sourceLanguage: job.detectedLanguage ?? job.requestedLanguage ?? 'auto',
    modelVersion,
    segments: words.length
      ? buildSegmentsFromWords(job.id, words)
      : segmentsFromText(job.id, job.text ?? ''),
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
 * Application Support — deliberately separate from the plain `.txt` written
 * next to the source, which stays byte-for-byte unchanged. Documents are large
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
