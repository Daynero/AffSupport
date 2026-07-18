import type { CompressionJob, QueueBatch } from '@video-compressor/shared';

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
  const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const progress = batchJobs.length
    ? batchJobs.reduce((total, job) => {
        if (finished.has(job.status)) return total + 100;
        return total + (job.progress ?? 0);
      }, 0) / batchJobs.length
    : 0;
  return {
    total: batchJobs.length,
    queued: batchJobs.filter(job => job.status === 'queued').length,
    processing: batchJobs.filter(job => job.status === 'processing').length,
    completed: batchJobs.filter(job => job.status === 'completed').length,
    failed: batchJobs.filter(job => ['failed', 'interrupted'].includes(job.status)).length,
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

export function removableSelectedIds(jobs: CompressionJob[], selected: ReadonlySet<string>) {
  return jobs
    .filter(job => selected.has(job.id) && !['processing', 'queued'].includes(job.status))
    .map(job => job.id);
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
