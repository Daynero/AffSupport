export interface CharRange {
  start: number;
  end: number;
}

export function mergeRanges(ranges: CharRange[]): CharRange[] {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: CharRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
