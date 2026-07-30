const LEXICAL_RUN = /[\p{L}\p{M}\p{N}]+/gu;
const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const SENTENCE_BOUNDARY = /[.!?…।॥؟。！？]["'»”’)\]}]*\s*$/u;
const CLAUSE_BOUNDARY = /[,;:،؛]["'»”’)\]}]*\s*$/u;

export const MAX_TRANSLATION_SEGMENT_UNITS = 32;

interface TextUnit {
  start: number;
  end: number;
}

/**
 * Splits transcript text into bounded translation-sized units without changing
 * any visible wording. Existing newlines remain hard boundaries; a long line
 * is divided at the nearest sentence/clause punctuation (or, as a fallback, a
 * lexical boundary). Scripts that normally omit spaces are counted by visible
 * code point instead of treating a whole sentence as one word.
 */
export function splitTextForTranslation(
  text: string,
  options: { maxUnits?: number } = {}
): string[] {
  const maxUnits = Math.max(2, Math.floor(options.maxUnits ?? MAX_TRANSLATION_SEGMENT_UNITS));
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => splitLine(line, maxUnits));
}

function splitLine(line: string, maxUnits: number): string[] {
  const units = textUnits(line);
  if (units.length <= maxUnits) return [line];

  const parts: string[] = [];
  let unitStart = 0;
  let charStart = 0;

  while (units.length - unitStart > maxUnits) {
    const remaining = units.length - unitStart;
    // Balance all remaining pieces. This avoids a 32-word piece followed by a
    // tiny fragment when a 42-word line can instead become two coherent halves.
    const remainingPieces = Math.ceil(remaining / maxUnits);
    const targetEnd = unitStart + Math.ceil(remaining / remainingPieces);
    const minEnd = Math.max(unitStart + 2, targetEnd - Math.max(3, Math.floor(maxUnits / 4)));
    const maxEnd = Math.min(
      unitStart + maxUnits,
      targetEnd + Math.max(3, Math.floor(maxUnits / 5))
    );
    const cutUnit = preferredBoundary(line, units, minEnd, maxEnd, targetEnd);
    const cutChar = units[cutUnit]?.start ?? line.length;
    const part = line.slice(charStart, cutChar).trim();
    if (part) parts.push(part);
    charStart = cutChar;
    unitStart = cutUnit;
  }

  const tail = line.slice(charStart).trim();
  if (tail) parts.push(tail);
  return parts;
}

function preferredBoundary(
  line: string,
  units: TextUnit[],
  minEnd: number,
  maxEnd: number,
  targetEnd: number
): number {
  let bestEnd = targetEnd;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let end = minEnd; end <= maxEnd; end += 1) {
    const nextStart = units[end]?.start ?? line.length;
    const between = line.slice(units[end - 1].end, nextStart);
    const rank = SENTENCE_BOUNDARY.test(between)
      ? 3
      : CLAUSE_BOUNDARY.test(between)
        ? 2
        : /\s/u.test(between)
          ? 1
          : 0;
    const score = rank * 100 - Math.abs(end - targetEnd);
    if (score > bestScore) {
      bestScore = score;
      bestEnd = end;
    }
  }
  return bestEnd;
}

function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  for (const match of text.matchAll(LEXICAL_RUN)) {
    const value = match[0];
    const start = match.index;
    if (!NO_SPACE_SCRIPT.test(value)) {
      units.push({ start, end: start + value.length });
      continue;
    }

    let cursor = start;
    for (const point of Array.from(value)) {
      const end = cursor + point.length;
      if (/^\p{M}$/u.test(point) && units.length && units.at(-1)?.end === cursor) {
        units[units.length - 1].end = end;
      } else {
        units.push({ start: cursor, end });
      }
      cursor = end;
    }
  }
  return units;
}
