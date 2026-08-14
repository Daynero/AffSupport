export interface LanguageDetectionResult {
  language: string | 'unknown';
  confidence: number;
  inspectedCharacters: number;
}

export interface VideoLanguageSample {
  startMs: number;
  durationMs: number;
}

/** Bounded, deterministic text heuristic used before an optional local speech/text model. */
export function detectLandingLanguage(
  text: string,
  options: { maximumCharacters?: number } = {}
): LanguageDetectionResult {
  const maximumCharacters = Math.min(20_000, Math.max(256, options.maximumCharacters ?? 8_000));
  const sample = text.normalize('NFC').slice(0, maximumCharacters);
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < 10) {
    return { language: 'unknown', confidence: 0, inspectedCharacters: sample.length };
  }
  const ukrainian = count(sample, /[іїєґІЇЄҐ]/gu);
  const cyrillic = count(sample, /\p{Script=Cyrillic}/gu);
  const latin = count(sample, /\p{Script=Latin}/gu);
  const russian = count(sample, /[ыэъёЫЭЪЁ]/gu);
  const polish = count(sample, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/gu);
  const total = Math.max(letters.length, 1);

  if (ukrainian > 0 && cyrillic / total > 0.45) {
    return {
      language: 'uk',
      confidence: boundedConfidence((cyrillic + ukrainian * 3) / total),
      inspectedCharacters: sample.length
    };
  }
  if (russian > 0 && cyrillic / total > 0.45) {
    return {
      language: 'ru',
      confidence: boundedConfidence((cyrillic + russian * 3) / total),
      inspectedCharacters: sample.length
    };
  }
  if (polish > 0 && latin / total > 0.45) {
    return {
      language: 'pl',
      confidence: boundedConfidence((latin + polish * 3) / total),
      inspectedCharacters: sample.length
    };
  }
  if (latin / total > 0.75) {
    return {
      language: 'en',
      confidence: boundedConfidence(latin / total),
      inspectedCharacters: sample.length
    };
  }
  return { language: 'unknown', confidence: 0, inspectedCharacters: sample.length };
}

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function boundedConfidence(value: number): number {
  return Math.round(Math.min(0.99, Math.max(0, value)) * 100) / 100;
}

/** At most two 5–8 second windows; short clips are sampled once from their start. */
export function chooseVideoLanguageSamples(durationMs: number): VideoLanguageSample[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const boundedDuration = Math.max(1, Math.round(durationMs));
  const sampleDuration = Math.min(8_000, boundedDuration);
  if (boundedDuration <= 13_000) return [{ startMs: 0, durationMs: sampleDuration }];
  const firstStart = Math.min(5_000, Math.max(0, boundedDuration - sampleDuration));
  const secondStart = Math.min(
    Math.max(firstStart + sampleDuration, Math.round(boundedDuration / 2)),
    boundedDuration - sampleDuration
  );
  return [
    { startMs: firstStart, durationMs: sampleDuration },
    { startMs: secondStart, durationMs: sampleDuration }
  ];
}

export function shouldCommitAutomaticLanguage(input: {
  sourceVersion: string;
  expectedSourceVersion: string;
  decisionRevision: number;
  expectedDecisionRevision: number;
  decisionSource: 'manual' | 'automatic' | 'unknown';
}): boolean {
  return (
    input.sourceVersion === input.expectedSourceVersion &&
    input.decisionRevision === input.expectedDecisionRevision &&
    input.decisionSource !== 'manual'
  );
}
