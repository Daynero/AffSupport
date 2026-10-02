export interface SpeechInterval {
  startMs: number;
  endMs: number;
}

/** A recovery signal, never permission to delete genuinely repeated speech. */
export function hasDecodeLoop(text: string, json: string): boolean {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  for (let size = 1; size <= 6; size++) {
    const repetitions = size === 1 ? 4 : 3;
    for (let start = 0; start + size * repetitions <= words.length; start++) {
      if (
        Array.from(
          { length: size * repetitions },
          (_, i) => words[start + i] === words[start + (i % size)]
        ).every(Boolean)
      )
        return true;
    }
  }
  const ranges = transcriptIntervals(json, Number.MAX_SAFE_INTEGER);
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = `${range.startMs}:${range.endMs}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** VAD evidence is independent of whether the text decoder emitted words. */
export function speechIntervalFromLog(line: string): SpeechInterval | null {
  const match = /Including segment \d+: ([\d.]+) - ([\d.]+)/u.exec(line);
  if (!match) return null;
  const startMs = Number(match[1]) * 1000;
  const endMs = Number(match[2]) * 1000;
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs > startMs
    ? { startMs, endMs }
    : null;
}

export function transcriptIntervals(json: string, durationMs: number): SpeechInterval[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('transcription' in parsed) ||
      !Array.isArray(parsed.transcription)
    )
      return [];
    return parsed.transcription.flatMap((segment: unknown) => {
      if (!segment || typeof segment !== 'object') return [];
      const value = segment as { text?: unknown; offsets?: { from?: unknown; to?: unknown } };
      const startMs = value.offsets?.from;
      const endMs = value.offsets?.to;
      return typeof value.text === 'string' &&
        /[\p{L}\p{N}]/u.test(value.text) &&
        typeof startMs === 'number' &&
        typeof endMs === 'number' &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        startMs >= 0 &&
        endMs > startMs &&
        endMs <= durationMs + 100
        ? [{ startMs, endMs: Math.min(durationMs, endMs) }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Largest uncovered part of independently detected speech. Silence gaps are excluded. */
export function missingSpeechMs(speech: SpeechInterval[], transcript: SpeechInterval[]): number {
  const intervals = [...transcript].sort((a, b) => a.startMs - b.startMs);
  let missing = 0;
  for (const utterance of speech) {
    let cursor = utterance.startMs;
    for (const interval of intervals) {
      if (interval.endMs <= cursor || interval.startMs >= utterance.endMs) continue;
      missing = Math.max(missing, Math.max(0, interval.startMs - cursor));
      cursor = Math.max(cursor, interval.endMs);
    }
    missing = Math.max(missing, Math.max(0, utterance.endMs - cursor));
  }
  return missing;
}
