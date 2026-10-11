import { searchHitRanges } from '@video-compressor/shared';

/**
 * The words a query matched, marked in a result (search rework, 2026-10).
 *
 * A list of fifty names reads faster when the part you typed stands out — the
 * way Drive and Linear mark it. Built from text nodes and `<mark>` elements,
 * never from HTML: a file name is whatever somebody called it on Drive.
 */

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** The text cut into plain and matched runs, in order; joined, they are the NFC text. */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const shown = text.normalize('NFC');
  if (shown === '') return [];
  const ranges = searchHitRanges(shown, query);
  if (ranges.length === 0) return [{ text: shown, hit: false }];
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: shown.slice(at, start), hit: false });
    parts.push({ text: shown.slice(start, end), hit: true });
    at = end;
  }
  if (at < shown.length) parts.push({ text: shown.slice(at), hit: false });
  return parts;
}

export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="search-hit">
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </>
  );
}
