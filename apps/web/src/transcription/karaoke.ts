import type { TranscriptWord } from '@video-compressor/shared';

/**
 * Index of the word active at `currentMs`, or -1 when the playhead is in a gap
 * (silence between words) or outside the transcript. Words are assumed sorted
 * and non-overlapping (the merge step guarantees monotonic spans), so a binary
 * search keeps this cheap enough to call every animation frame without
 * re-scanning the whole document.
 */
/**
 * How long after a word ends it stays lit while the next has not begun.
 *
 * Whisper's word spans leave small gaps between words and larger ones at every breath;
 * dropping the highlight in each gap made the follow-along blink several times a sentence.
 * Held for the length of a short pause, cleared at a real one.
 */
export const WORD_HOLD_MS = 300;

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
  if (currentMs <= words[candidate].endMs) return candidate;
  // In the gap after a word: keep it unless the gap is long, or the next word is about to
  // start and would only flicker.
  const next = words[candidate + 1];
  const withinHold = currentMs - words[candidate].endMs <= WORD_HOLD_MS;
  return withinHold && (!next || next.startMs > currentMs) ? candidate : -1;
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
