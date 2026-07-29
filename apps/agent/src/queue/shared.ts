import { randomUUID } from 'node:crypto';
import type { SelectionWarning } from '@video-compressor/shared';

/** Builds the warning entry both queues return when a dropped file is rejected. */
export function selectionWarning(
  fileName: string,
  reason: SelectionWarning['reason'],
  message: string
): SelectionWarning {
  return { id: randomUUID(), fileName, reason, message };
}
