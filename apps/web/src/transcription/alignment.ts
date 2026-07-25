import type { AlignmentLink } from '@video-compressor/shared';

/** A half-open character range `[start, end)` inside a segment's text. */
export interface CharRange {
  start: number;
  end: number;
}

/** Confidence assigned when no word/phrase alignment exists and we fall back to
 * the whole matching segment — deliberately capped so it never reads as exact. */
export const FALLBACK_CONFIDENCE = 0.5;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rangesOverlap(a: CharRange, b: CharRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function normalizeSurface(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function rangesToText(text: string, ranges: readonly CharRange[]): string {
  return mergeRanges(ranges.map(range => ({ ...range })))
    .map(range => text.slice(range.start, range.end))
    .join(' ');
}

/**
 * Identical surface forms across the two columns — numbers like "25", codes,
 * URLs or proper nouns that survive translation untouched — are exact matches
 * no matter what score the aligner assigned. Callers use this to pin such a
 * selection's confidence to 1 instead of the aligner's noisy estimate.
 */
export function isExactSurfaceMatch(selected: string, mirrored: string): boolean {
  const left = normalizeSurface(selected);
  return left.length > 0 && left === normalizeSurface(mirrored);
}

function overlapLength(a: CharRange, b: CharRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function rangesLength(ranges: readonly CharRange[]): number {
  return mergeRanges(ranges.map(range => ({ ...range }))).reduce(
    (total, range) => total + range.end - range.start,
    0
  );
}

function coveredLength(needles: readonly CharRange[], coverage: readonly CharRange[]): number {
  const mergedNeedles = mergeRanges(needles.map(range => ({ ...range })));
  const mergedCoverage = mergeRanges(coverage.map(range => ({ ...range })));
  return mergedNeedles.reduce(
    (total, needle) =>
      total + mergedCoverage.reduce((inside, range) => inside + overlapLength(needle, range), 0),
    0
  );
}

/** Merges overlapping/adjacent ranges into a sorted, minimal set. */
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

export interface MirroredSelection {
  /** Resolved ranges in the *other* column, merged. */
  ranges: CharRange[];
  /** The source ranges the alignment actually covered (for confidence + highlight). */
  matched: CharRange[];
  /** True when no alignment link matched and we highlighted the whole segment. */
  usedFallback: boolean;
  /** 0–1 estimate of how well the selected pieces correspond (never fabricated). */
  confidence: number;
}

/**
 * Confidence for a resolved selection: the mean confidence of the alignment
 * links that matched, weighted by how much of the selection they actually
 * cover. Derived only from real alignment data — no random or length-only
 * guesses. A selection with no links returns 0 here (callers apply the capped
 * fallback instead).
 */
export function selectionConfidence(
  selection: CharRange,
  links: AlignmentLink[],
  side: 'source' | 'target',
  oppositeSelection?: readonly CharRange[],
  allLinks: readonly AlignmentLink[] = links
): number {
  if (!links.length) return 0;
  let weightedConfidence = 0;
  let weightTotal = 0;
  let boundaryCompleteness = 0;
  for (const link of links) {
    const linkedRange =
      side === 'source'
        ? { start: link.sourceStart, end: link.sourceEnd }
        : { start: link.targetStart, end: link.targetEnd };
    const overlap = overlapLength(selection, linkedRange);
    if (overlap <= 0) continue;
    weightedConfidence += clamp01(link.confidence) * overlap;
    weightTotal += overlap;
    boundaryCompleteness += (overlap / Math.max(1, linkedRange.end - linkedRange.start)) * overlap;
  }
  if (weightTotal <= 0) return 0;
  const meanConfidence = weightedConfidence / weightTotal;
  const selectionLength = Math.max(1, selection.end - selection.start);
  const covered = mergeRanges(
    links.map(link =>
      side === 'source'
        ? { start: link.sourceStart, end: link.sourceEnd }
        : { start: link.targetStart, end: link.targetEnd }
    )
  ).reduce((total, range) => total + overlapLength(selection, range), 0);
  const coverage = clamp01(covered / selectionLength);
  const boundaryScore = clamp01(boundaryCompleteness / weightTotal);

  const oppositeLinkRanges = links.map(link =>
    side === 'source'
      ? { start: link.targetStart, end: link.targetEnd }
      : { start: link.sourceStart, end: link.sourceEnd }
  );
  const mappedRanges =
    oppositeSelection?.length === 0 || oppositeSelection === undefined
      ? mergeRanges(oppositeLinkRanges)
      : mergeRanges(oppositeSelection.map(range => ({ ...range })));
  const oppositeCoverage = clamp01(
    coveredLength(mappedRanges, oppositeLinkRanges) / Math.max(1, rangesLength(mappedRanges))
  );

  // A many-to-one link can hide omitted articles, auxiliaries or inflections:
  // selecting "cat" may map to the same translated phrase as "the cat". Find
  // every link related through the mirrored side and penalize the portion of
  // those grammatical source/target units that the user did not select.
  const relatedLinks = allLinks.filter(link => {
    const opposite =
      side === 'source'
        ? { start: link.targetStart, end: link.targetEnd }
        : { start: link.sourceStart, end: link.sourceEnd };
    return mappedRanges.some(range => rangesOverlap(range, opposite));
  });
  const relatedOriginRanges = relatedLinks.map(link =>
    side === 'source'
      ? { start: link.sourceStart, end: link.sourceEnd }
      : { start: link.targetStart, end: link.targetEnd }
  );
  const relationCompleteness = clamp01(
    coveredLength(relatedOriginRanges, [selection]) / Math.max(1, rangesLength(relatedOriginRanges))
  );

  // Both-side coverage penalizes unaligned pieces; boundary completeness
  // catches partial words/phrases; relation completeness catches omitted
  // grammatical units in one-to-many and many-to-one alignments.
  return clamp01(
    meanConfidence *
      coverage *
      oppositeCoverage *
      (0.75 + 0.25 * boundaryScore) *
      (0.7 + 0.3 * relationCompleteness)
  );
}

/**
 * Resolves a selection in one column to ranges in the other via alignment
 * links. With no matching link it falls back to the whole opposite side at a
 * capped confidence, so the UI can honestly show "approximate" rather than a
 * fake word match.
 */
export function resolveMirroredSelection(
  selection: CharRange,
  links: AlignmentLink[],
  side: 'source' | 'target',
  oppositeLength: number,
  texts?: { origin: string; opposite: string }
): MirroredSelection {
  const matching = links.filter(link =>
    rangesOverlap(
      selection,
      side === 'source'
        ? { start: link.sourceStart, end: link.sourceEnd }
        : { start: link.targetStart, end: link.targetEnd }
    )
  );

  if (!matching.length) {
    return {
      ranges: oppositeLength > 0 ? [{ start: 0, end: oppositeLength }] : [],
      matched: [{ start: selection.start, end: selection.end }],
      usedFallback: true,
      confidence: FALLBACK_CONFIDENCE
    };
  }

  const ranges = mergeRanges(
    matching.map(link =>
      side === 'source'
        ? { start: link.targetStart, end: link.targetEnd }
        : { start: link.sourceStart, end: link.sourceEnd }
    )
  );
  const matched = mergeRanges(
    matching.map(link =>
      side === 'source'
        ? { start: link.sourceStart, end: link.sourceEnd }
        : { start: link.targetStart, end: link.targetEnd }
    )
  );
  let confidence = selectionConfidence(selection, matching, side, ranges, links);
  // An identical surface form on both sides is an exact match regardless of the
  // aligner's score — e.g. selecting "25" that maps to "25".
  if (
    texts &&
    isExactSurfaceMatch(
      texts.origin.slice(selection.start, selection.end),
      rangesToText(texts.opposite, ranges)
    )
  ) {
    confidence = 1;
  }
  return {
    ranges,
    matched,
    usedFallback: false,
    confidence
  };
}

export type ConfidenceGrade = 'exact' | 'high' | 'approx';

/** Textual grade so confidence is never conveyed by color alone (a11y). */
export function confidenceGrade(value: number): ConfidenceGrade {
  if (value >= 0.9) return 'exact';
  if (value > 0.55) return 'high';
  return 'approx';
}

/**
 * A continuous green→yellow color for a confidence value, interpolated between
 * the design system's success and warning tokens. Never red.
 */
export function confidenceColor(value: number): string {
  const normalized = value <= 0.55 ? 0 : value >= 0.9 ? 1 : (clamp01(value) - 0.55) / (0.9 - 0.55);
  const percent = Math.round(normalized * 100);
  return `color-mix(in oklab, var(--color-success) ${percent}%, var(--color-warning))`;
}
