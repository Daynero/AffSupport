import { lexicalUnitSpans } from '../translation/segmentation.js';
import type { WhisperWord } from './words.js';

export interface AudioChunk {
  startSeconds: number;
  durationSeconds: number;
}

/** Dense Indic tokenization was the reason for bounded decoding in the first
 * place. Do not reintroduce token exhaustion in its recovery windows. */
export function recoveryContextSeconds(language: string | null): number {
  if (
    !language ||
    language === 'auto' ||
    ['hi', 'ur', 'bn', 'ta', 'te', 'ml', 'kn', 'mr', 'gu', 'pa', 'ne', 'si'].includes(language)
  )
    return 1;
  return 6;
}

/**
 * whisper.cpp's decoder can exhaust its token budget before its 30-second
 * window ends (especially in Indic scripts), then advance past untranscribed
 * speech. Bound each decode, with overlap to recover words cut at a boundary.
 */
export function transcriptionChunks(durationSeconds: number): AudioChunk[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 600_000) {
    throw new RangeError('Audio duration must be finite, non-negative and at most 600000 seconds.');
  }
  const chunks: AudioChunk[] = [];
  for (let startSeconds = 0; startSeconds < durationSeconds; startSeconds += 6) {
    const duration = Math.min(8, durationSeconds - startSeconds);
    chunks.push({ startSeconds, durationSeconds: duration });
    if (startSeconds + duration >= durationSeconds) break;
  }
  return chunks;
}

/**
 * Stitch TXT, never reconstruct it from token JSON: split Unicode tokens and
 * missing timestamps must not remove visible words. Match only the overlap's
 * tail/head. An anchor also repairs a clipped word after it; without an anchor
 * retain both texts rather than guessing which speech to delete.
 */
export function stitchChunkText(left: string, right: string): string {
  return stitchChunkResult(left, right).text;
}

export interface ChunkTextMerge {
  text: string;
  /** Character boundary retained from the previous canonical text. */
  leftEnd: number;
  /** First retained character of the incoming decode. */
  rightStart: number;
  rightOffset: number;
  ambiguous: boolean;
}

export function stitchChunkResult(
  left: string,
  right: string,
  timing?: {
    left: WhisperWord[];
    right: WhisperWord[];
    overlapStartMs: number;
    overlapEndMs: number;
  }
): ChunkTextMerge {
  if (!left) return { text: right, leftEnd: 0, rightStart: 0, rightOffset: 0, ambiguous: false };
  if (!right)
    return {
      text: left,
      leftEnd: left.length,
      rightStart: 0,
      rightOffset: left.length,
      ambiguous: false
    };
  // Never tokenize a whole accumulated recording just to inspect a seam.
  const tailStart = Math.max(0, left.length - 4096);
  const a = lexicalUnitSpans(left.slice(tailStart)).map(span => ({
    start: span.start + tailStart,
    end: span.end + tailStart
  }));
  const b = lexicalUnitSpans(right.slice(0, 4096));
  const uncertain = (): ChunkTextMerge => ({
    text: `${left}\n${right}`,
    leftEnd: left.length,
    rightStart: 0,
    rightOffset: left.length + 1,
    ambiguous: true
  });
  const join = (leftEnd: number, rightStart: number): ChunkTextMerge => {
    if (timing) {
      const earlier = timing.left.slice(-64).find(word => word.canonicalStart === leftEnd);
      const later = timing.right.find(word => word.canonicalStart === rightStart);
      if (
        earlier &&
        later &&
        (earlier.endMs < timing.overlapStartMs - 750 ||
          later.startMs > timing.overlapEndMs + 750 ||
          earlier.startMs > later.endMs + 750 ||
          later.startMs > earlier.endMs + 750)
      )
        return uncertain();
    }
    return {
      text: `${left.slice(0, leftEnd)}${right.slice(rightStart)}`,
      leftEnd,
      rightStart,
      rightOffset: leftEnd - rightStart,
      ambiguous: false
    };
  };
  const key = (text: string, span: { start: number; end: number }) =>
    text.slice(span.start, span.end).normalize('NFKC').toLocaleLowerCase();
  let best: { i: number; j: number; length: number } | null = null;
  for (let i = Math.max(0, a.length - 24); i < a.length; i += 1) {
    for (let j = 0; j < Math.min(timing ? 6 : 1, b.length); j += 1) {
      let length = 0;
      while (
        i + length < a.length &&
        j + length < b.length &&
        key(left, a[i + length]) === key(right, b[j + length])
      ) {
        length += 1;
      }
      // Require an actual phrase, near the end of the earlier decode. A lone
      // recurring word is not evidence of the same spoken occurrence.
      const exactShortOverlap =
        length === 2 &&
        j === 0 &&
        i + length === a.length &&
        key(left, a[i]) !== key(left, a[i + 1]);
      const remaining = a.length - (i + length);
      const clippedFinalWord =
        remaining === 1 &&
        j + length < b.length &&
        key(left, a[i + length]).length >= 2 &&
        key(right, b[j + length]).startsWith(key(left, a[i + length])) &&
        key(right, b[j + length]) !== key(left, a[i + length]);
      const anchorLeft = timing?.left.slice(-64).find(word => word.canonicalStart === a[i].start);
      const anchorRight = timing?.right.find(word => word.canonicalStart === b[j].start);
      const closeAnchor =
        anchorLeft && anchorRight && Math.abs(anchorLeft.startMs - anchorRight.startMs) <= 750;
      const tailWords =
        timing && remaining > 0
          ? timing.left
              .slice(-64)
              .filter(word => (word.canonicalStart ?? -1) >= a[i + length].start)
          : [];
      const timedContinuation =
        timing &&
        closeAnchor &&
        remaining <= 8 &&
        // A bounded decode can leave its last one or two lexical units without
        // token timing. Four synchronized anchor words still identify this
        // occurrence; an interior/long untimed continuation remains unsafe.
        (tailWords.length >= remaining || (length >= 4 && remaining <= 2)) &&
        tailWords.every(
          word =>
            word.startMs >= timing.overlapStartMs - 750 && word.endMs <= timing.overlapEndMs + 750
        ) &&
        timing.right.some(
          word =>
            (word.canonicalStart ?? -1) >= (b[j + length]?.start ?? right.length) &&
            word.endMs >= (tailWords.at(-1)?.endMs ?? 0) - 750
        );
      const skippedHead =
        timing?.right.filter(word => (word.canonicalStart ?? right.length) < b[j].start) ?? [];
      if (
        j > 0 &&
        (!closeAnchor ||
          skippedHead.length < j ||
          !skippedHead.every(
            word =>
              word.endMs <= anchorLeft.startMs + 750 && word.startMs >= timing!.overlapStartMs - 750
          ))
      )
        continue;
      // Only replace a proven suffix or one strictly clipped final word.
      // A shared interior phrase does not justify dropping its continuation.
      if (
        (!exactShortOverlap && !(length >= 2 && timedContinuation) && length < 3) ||
        (remaining !== 0 && !clippedFinalWord && !timedContinuation)
      )
        continue;
      if (!best || length > best.length) best = { i, j, length };
    }
  }
  if (!best) {
    // A proper name can be split differently in two decodes (e.g. Hindi
    // `प्रो मैन` / `प्रोमैन`), with the earlier window's final word clipped.
    // Match that strict character continuation at lexical boundaries only.
    const compact = (text: string) =>
      text
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
    const head = compact(right);
    for (let i = Math.max(0, a.length - 6); i <= a.length - 3; i += 1) {
      const tail = compact(left.slice(a[i].start));
      if (tail.length >= 12 && head.startsWith(tail)) {
        return join(a[i].start, 0);
      }
    }
    return uncertain();
  }
  return join(a[best.i].start, b[best.j].start);
}
