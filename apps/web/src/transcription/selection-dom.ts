import { mergeRanges, type CharRange } from './alignment';

/** A contiguous run of segment text with its highlight flags. */
export interface TextPiece {
  text: string;
  start: number;
  end: number;
  /** Inside the resolved semantic selection (green/yellow). */
  selected: boolean;
  /** The current karaoke word / its aligned target span (distinct color). */
  active: boolean;
}

function inAny(ranges: readonly CharRange[], point: number): boolean {
  return ranges.some(range => point >= range.start && point < range.end);
}

/** Reconstructs discontiguous copied ranges in natural document order. */
export function joinRanges(text: string, ranges: readonly CharRange[]): string {
  const ordered = mergeRanges(ranges.map(range => ({ ...range })));
  if (!ordered.length) return '';
  let output = text.slice(ordered[0].start, ordered[0].end);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const range = ordered[index];
    const gap = text.slice(previous.end, range.start);
    output += /^[\s\p{P}]{0,8}$/u.test(gap) ? gap : ' ';
    output += text.slice(range.start, range.end);
  }
  return output.trim();
}

/**
 * Splits `text` into the minimal set of contiguous pieces such that every
 * piece is uniformly inside/outside the selection and karaoke ranges. Selection
 * and karaoke are independent layers that can overlap on the same run, so a
 * piece can be both `selected` and `active` at once (the UI combines them
 * without either overwriting the other). Pure — the React layer just maps
 * pieces to spans.
 */
export function splitTextByRanges(
  text: string,
  selected: readonly CharRange[],
  active: readonly CharRange[],
  extraBoundaries: readonly number[] = []
): TextPiece[] {
  const length = text.length;
  if (length === 0) return [];
  const bounds = new Set<number>([0, length]);
  for (const range of [...selected, ...active]) {
    if (range.start > 0 && range.start < length) bounds.add(range.start);
    if (range.end > 0 && range.end < length) bounds.add(range.end);
  }
  for (const boundary of extraBoundaries) {
    if (boundary > 0 && boundary < length) bounds.add(boundary);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const pieces: TextPiece[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const midpoint = (start + end) / 2;
    pieces.push({
      text: text.slice(start, end),
      start,
      end,
      selected: inAny(selected, midpoint),
      active: inAny(active, midpoint)
    });
  }
  return pieces;
}

/**
 * Character offset of (`node`, `offset`) within `root`, counting the text
 * content of every text node that precedes it in document order. Used to turn a
 * DOM Selection anchor/focus into a character index inside a segment. DOM-bound,
 * so it lives beside the pure splitter rather than being unit-tested here.
 */
export function charOffsetWithin(root: Node, node: Node, offset: number): number {
  const owner = root.ownerDocument ?? document;
  if (root !== node && !root.contains(node)) return root.textContent?.length ?? 0;
  try {
    const prefix = owner.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  } catch {
    // A stale native Range can briefly point at a span React just replaced.
    // Clamp to the segment end rather than throwing from pointerup.
    return root.textContent?.length ?? 0;
  }
}
