import type { TranscriptWord } from '@video-compressor/shared';

/**
 * Index of the word active at `currentMs`, or -1 when the playhead is in a gap
 * (silence between words) or outside the transcript. Words are assumed sorted
 * and non-overlapping (the merge step guarantees monotonic spans), so a binary
 * search keeps this cheap enough to call every animation frame without
 * re-scanning the whole document.
 */
export function activeWordIndex(words: readonly TranscriptWord[], currentMs: number): number {
  let low = 0;
  let high = words.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].startMs <= currentMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) return -1;
  return currentMs <= words[candidate].endMs ? candidate : -1;
}

/** Flattens a document's segments into one ordered word list with segment ids. */
export interface FlatWord {
  segmentId: string;
  word: TranscriptWord;
}

export function flattenWords(
  segments: readonly { id: string; words: readonly TranscriptWord[] }[]
): FlatWord[] {
  const flat: FlatWord[] = [];
  for (const segment of segments) {
    for (const word of segment.words) flat.push({ segmentId: segment.id, word });
  }
  return flat;
}
