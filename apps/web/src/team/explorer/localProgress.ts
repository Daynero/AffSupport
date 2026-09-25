import type { LocalOperationStage } from '@video-compressor/shared';

/** Confirmed local work only; no server percentage or guessed duration. */
export function localStageProgress(input: {
  stage: LocalOperationStage;
  confirmedBytes: number;
  totalBytes: number;
  completedItems: number;
  totalItems: number;
  succeeded?: boolean;
}): number | 'indeterminate' {
  const fraction = (done: number, total: number): number | 'indeterminate' =>
    Number.isFinite(done) && Number.isFinite(total) && total > 0
      ? Math.round((Math.min(total, Math.max(0, done)) / total) * 100)
      : 'indeterminate';
  switch (input.stage) {
    case 'preparing':
    case 'updating_catalog':
      return 'indeterminate';
    case 'creating_folders':
      return fraction(input.completedItems, input.totalItems);
    case 'transferring':
      return fraction(input.confirmedBytes, input.totalBytes);
    case 'moving':
      return input.totalItems <= 1
        ? 'indeterminate'
        : fraction(input.completedItems, input.totalItems);
    case 'done':
      return input.succeeded ? 100 : 'indeterminate';
  }
}
