import type { QueueState, CompressionJob } from '@video-compressor/shared';

/**
 * Keeps object identity stable for anything a snapshot did not change.
 *
 * Every broadcast from the local app arrives as freshly parsed JSON, so every
 * job in it is a new object even when nothing about it moved. React compares by
 * reference, so a progress tick on one job re-renders every row in the queue —
 * two hundred rows rebuilt to redraw one number, several times a second.
 *
 * This walks the arriving snapshot and hands back the *previous* object
 * wherever the contents match, so the rows that did not change compare equal
 * and stay put. The comparison is a shallow field-by-field one: jobs are flat
 * records of primitives plus two small nested objects, and a deep walk would
 * cost more than the render it saves.
 */

/** Fields whose nested objects are compared one level down. */
const NESTED_KEYS = ['encoding', 'imageEmbedding'] as const;

function sameNested(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => {
    const first = left[key];
    const second = right[key];
    // One more level, for the image assets nested inside the embedding.
    if (first && second && typeof first === 'object' && typeof second === 'object') {
      return JSON.stringify(first) === JSON.stringify(second);
    }
    return first === second;
  });
}

function sameJob(previous: CompressionJob, next: CompressionJob): boolean {
  const keys = Object.keys(next) as (keyof CompressionJob)[];
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every(key => {
    if ((NESTED_KEYS as readonly string[]).includes(key as string)) {
      return sameNested(previous[key], next[key]);
    }
    return previous[key] === next[key];
  });
}

/**
 * Returns a snapshot that reuses previous references wherever nothing changed.
 *
 * If no job changed at all, the previous jobs *array* is returned too — so a
 * component subscribed to the list, rather than to a row, also skips its
 * render. That is the case that matters most: a heartbeat that changes nothing
 * should cost nothing.
 */
export function reconcileQueue(previous: QueueState | null, next: QueueState): QueueState {
  if (!previous) return next;

  let changed = false;
  const jobs = next.jobs.map(job => {
    const before = previous.jobs.find(candidate => candidate.id === job.id);
    if (before && sameJob(before, job)) return before;
    changed = true;
    return job;
  });

  // A removal or a reordering is a change to the list even when every job in it
  // is untouched.
  const sameLength = jobs.length === previous.jobs.length;
  const sameOrder = sameLength && jobs.every((job, index) => job === previous.jobs[index]);

  return { ...next, jobs: changed || !sameOrder ? jobs : previous.jobs };
}
