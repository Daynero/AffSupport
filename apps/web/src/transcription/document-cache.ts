import type { TranscriptionDocument, TranscriptionJob } from '@video-compressor/shared';
import { transcriptionDocument } from '../api/client';

/**
 * Structured documents, remembered per job.
 *
 * A document is words and timings for every segment — for an hour of speech, a few
 * megabytes — and it does not change once the run that produced it has finished. Opening
 * the same file twice, or copying it after viewing it, used to fetch and parse it again
 * each time. The key carries the run's finish time so a transcription made again replaces
 * the old text instead of serving it from here.
 */
const documents = new Map<string, Promise<TranscriptionDocument>>();
/** Enough for a working session; the oldest entry goes when a new one would exceed it. */
const CAPACITY = 24;
const DOCUMENT_TIMEOUT_MS = 60_000;

type CacheJob = Pick<TranscriptionJob, 'id' | 'finishedAt' | 'translation'>;

/**
 * A document changes when the run that produced it changes, and again each time a
 * translation into some language finishes — the translation lives inside it. Both are in
 * the key, so a copy or export made after a translation lands sees that translation.
 */
function cacheKey(job: CacheJob): string {
  const translation = job.translation
    ? `${job.translation.targetLanguage}:${job.translation.status}`
    : 'none';
  return `${job.id}@${job.finishedAt ?? 0}@${translation}`;
}

/**
 * The request is never tied to one caller's abort signal: a shared promise cancelled by
 * whoever asked first would fail everyone who asked after — in development React mounts
 * an effect twice, and the second mount was handed the first mount's aborted fetch. A
 * caller that goes away simply ignores the result.
 */
export function loadTranscriptDocument(job: CacheJob): Promise<TranscriptionDocument> {
  const key = cacheKey(job);
  const cached = documents.get(key);
  if (cached) {
    // Re-inserted so it counts as recently used.
    documents.delete(key);
    documents.set(key, cached);
    return cached;
  }
  // A deadline of its own: a hung agent left this promise pending forever, and everything
  // behind it — the viewer, copy, export — waited with it. A minute is generous for a local
  // JSON file of any realistic size.
  const controller = new AbortController();
  const deadline = window.setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);
  const pending = transcriptionDocument(job.id, controller.signal)
    .finally(() => window.clearTimeout(deadline))
    .catch(error => {
      // A failed fetch is not worth remembering; the next attempt asks again.
      if (documents.get(key) === pending) documents.delete(key);
      throw error;
    });
  documents.set(key, pending);
  while (documents.size > CAPACITY) {
    const oldest = documents.keys().next().value;
    if (oldest === undefined) break;
    documents.delete(oldest);
  }
  return pending;
}

/** Drops every remembered document; for a job list that was cleared. */
export function forgetTranscriptDocuments(): void {
  documents.clear();
}

/**
 * Fetches several documents with a ceiling on how many are in flight.
 *
 * "Copy all finished" over a long queue used to open one request per file at once; the
 * agent answered them all, and the browser spent the next seconds parsing megabytes of JSON
 * it would then throw away. Four at a time is well within what feels immediate and keeps
 * the page responsive while it happens.
 */
export async function loadTranscriptDocuments(
  jobs: readonly CacheJob[],
  options: { concurrency?: number; signal?: AbortSignal } = {}
): Promise<TranscriptionDocument[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: TranscriptionDocument[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      if (options.signal?.aborted) throw new Error('aborted');
      results[index] = await loadTranscriptDocument(jobs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}
