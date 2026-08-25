import {
  COMPRESSION_LIFECYCLE,
  canTransition,
  isSettled,
  type CompressionJob,
  type QueueBatch
} from '@video-compressor/shared';

export interface BatchMetrics {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  progress: number;
}

export function batchMetrics(jobs: CompressionJob[], batch: QueueBatch | null): BatchMetrics {
  if (!batch) return { total: 0, queued: 0, processing: 0, completed: 0, failed: 0, progress: 0 };
  const ids = new Set(batch.jobIds);
  const batchJobs = jobs.filter(job => ids.has(job.id));
  const progress = batchJobs.length
    ? batchJobs.reduce((total, job) => {
        // Asked of the same declaration the agent enforces. The list this replaces was the
        // interface's own second opinion about which statuses mean "over", and it had
        // already drifted from the agent's.
        if (isSettled(COMPRESSION_LIFECYCLE, job.status)) return total + 100;
        return total + (job.progress ?? 0);
      }, 0) / batchJobs.length
    : 0;
  return {
    total: batchJobs.length,
    queued: batchJobs.filter(job => job.status === 'queued').length,
    processing: batchJobs.filter(job => job.status === 'processing').length,
    completed: batchJobs.filter(job => job.status === 'completed').length,
    // Counted together on purpose: from the batch summary's point of view a run that broke
    // and a run the application could not finish are both work that did not get done. The
    // row itself still tells them apart, which is where the distinction matters.
    failed: batchJobs.filter(job => job.status === 'failed' || job.status === 'interrupted').length,
    progress
  };
}

export function selectableJobIds(jobs: CompressionJob[]) {
  return jobs.filter(job => job.status !== 'analyzing').map(job => job.id);
}

export function newestJobsFirst(jobs: CompressionJob[]) {
  return [...jobs].reverse();
}

export function readySelectedIds(jobs: CompressionJob[], selected: ReadonlySet<string>) {
  return jobs.filter(job => selected.has(job.id) && job.status === 'ready').map(job => job.id);
}

export function startableSelectedIds(jobs: CompressionJob[], selected: ReadonlySet<string>) {
  return jobs.filter(job => selected.has(job.id) && startable(job)).map(job => job.id);
}

/**
 * Can this job be started, whether for the first time or again?
 *
 * `ready` has never run; a settled job has, and re-running it is a declared transition. The
 * question is asked of the table so that the button the interface offers and the request the
 * agent accepts cannot disagree — which they did, in both directions, before this.
 */
export function startable(job: CompressionJob): boolean {
  return job.status === 'ready' || isSettled(COMPRESSION_LIFECYCLE, job.status);
}

/** Can this job be stopped right now? */
export function stoppable(job: CompressionJob): boolean {
  return canTransition(COMPRESSION_LIFECYCLE, job.status, 'cancelled');
}

/** Why the compress action is unavailable, or null when it can run. */
export type CompressBlock =
  | 'running'
  /** Reports itself busy while holding nothing. See `compressBlock`. */
  | 'stuck'
  | 'embedding-needs-image'
  | 'invalid-image-duration'
  | 'nothing-selected'
  | 'nothing-startable'
  | null;

/**
 * Single source of truth for the primary action's disabled state. It used to
 * live inline in the button, so a stuck reason left the user with a grey
 * button and nothing on screen to explain it.
 */
export function compressBlock(input: {
  running: boolean;
  embeddingEnabled: boolean;
  embeddingHasImages: boolean;
  embeddingFormValid: boolean;
  selectedCount: number;
  startableCount: number;
  /** Jobs the local app says are queued or in flight right now. */
  activeCount?: number;
}): CompressBlock {
  // "Busy" with nothing queued and nothing in flight is not busy — it is a
  // queue that has lost track of itself, which users met as a greyed-out
  // button above a panel of zeroes and no way forward. Saying "already
  // running" there is the interface repeating a claim its own numbers
  // contradict; naming it as stuck at least matches what is on screen.
  if (input.running && input.activeCount === 0) return 'stuck';
  if (input.running) return 'running';
  if (input.embeddingEnabled && !input.embeddingHasImages) return 'embedding-needs-image';
  if (!input.embeddingFormValid) return 'invalid-image-duration';
  if (!input.selectedCount) return 'nothing-selected';
  if (!input.startableCount) return 'nothing-startable';
  return null;
}

export function removableSelectedIds(jobs: CompressionJob[], selected: ReadonlySet<string>) {
  return jobs.filter(job => selected.has(job.id) && !stoppable(job)).map(job => job.id);
}

export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
  checked: boolean,
  orderedIds: string[],
  lastIndex: number | null,
  shiftKey: boolean
) {
  const next = new Set(selected);
  const index = orderedIds.indexOf(id);
  if (shiftKey && lastIndex !== null && index >= 0) {
    const start = Math.min(lastIndex, index);
    const end = Math.max(lastIndex, index);
    for (const value of orderedIds.slice(start, end + 1)) {
      if (checked) next.add(value);
      else next.delete(value);
    }
  } else if (checked) next.add(id);
  else next.delete(id);
  return { selected: next, lastIndex: index >= 0 ? index : lastIndex };
}

export function isValidIntegerInput(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value.trim())) return false;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum;
}

export function elapsedMilliseconds(job: CompressionJob, now = Date.now()) {
  if (job.startedAt === null) return null;
  return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

export type TimerState = 'running' | 'completed' | 'failed' | 'cancelled' | null;
export function timerState(job: CompressionJob): TimerState {
  if (job.startedAt === null) return null;
  if (job.status === 'completed') return 'completed';
  if (job.status === 'failed' || job.status === 'interrupted') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  return job.status === 'processing' ? 'running' : null;
}
