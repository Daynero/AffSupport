import { describe, expect, it } from 'vitest';
import {
  CONFUSABLE_TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_LANGUAGE_CODES,
  confusableLanguages,
  type TranscriptionJob
} from '@video-compressor/shared';
import {
  parseDetectedLanguage,
  probeQuality,
  summarize,
  worthMoreWindows
} from '../apps/agent/src/whisper/language-probe.js';
import { languageForRun } from '../apps/agent/src/queue/transcription-queue.js';

function job(patch: Partial<TranscriptionJob>): TranscriptionJob {
  return {
    id: 'job',
    inputPath: '/tmp/a.mp4',
    fileName: 'a.mp4',
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 45,
    status: 'ready',
    progress: null,
    requestedLanguage: 'auto',
    detectedLanguage: null,
    text: null,
    characters: null,
    translation: null,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    ...patch
  };
}

describe('reading whisper.cpp language detection', () => {
  it('takes the language and its posterior from the detection line', () => {
    expect(
      parseDetectedLanguage('whisper_full_with_state: auto-detected language: uz (p = 0.512300)\n')
    ).toEqual({ language: 'uz', confidence: 0.5123 });
  });

  it('keeps a language printed without a probability, and reports none', () => {
    expect(parseDetectedLanguage('auto-detected language: EN\n')).toEqual({
      language: 'en',
      confidence: null
    });
  });

  it('answers nothing for output that never named a language', () => {
    expect(parseDetectedLanguage('error: failed to load model\n')).toEqual({
      language: null,
      confidence: null
    });
  });

  it('prefers the cheap model and gives up when neither is installed', () => {
    expect(probeQuality(quality => quality === 'fast')).toBe('fast');
    expect(probeQuality(quality => quality === 'accurate')).toBe('accurate');
    expect(probeQuality(() => true)).toBe('fast');
    expect(probeQuality(() => false)).toBeNull();
  });
});

describe('what the sampled fragments add up to', () => {
  it('shares the confidence each language won with, most confident first', () => {
    const summary = summarize([
      { language: 'az', confidence: 0.888 },
      { language: 'fa', confidence: 0.567 },
      { language: 'az', confidence: 0.514 },
      { language: 'en', confidence: 0.347 }
    ]);
    expect(summary.language).toBe('az');
    expect(summary.samples).toBe(4);
    expect(summary.candidates.map(candidate => candidate.language)).toEqual(['az', 'fa', 'en']);
    // (0.888 + 0.514) over four fragments — the model's own confidence, averaged, not
    // rescaled to fill the bar.
    expect(summary.candidates[0].share).toBeCloseTo(0.3505, 4);
    expect(summary.confidence).toBeCloseTo(0.3505, 4);
    // Deliberately short of one: the rest of each fragment's probability went to languages
    // whisper.cpp never printed, and claiming it for the winners is what put "100%" beside
    // a marker saying the answer was in doubt.
    expect(summary.candidates.reduce((sum, candidate) => sum + candidate.share, 0)).toBeCloseTo(
      0.579,
      3
    );
  });

  it('never reads a unanimous family as certain', () => {
    const summary = summarize([
      { language: 'hr', confidence: 0.7 },
      { language: 'hr', confidence: 0.72 },
      { language: 'hr', confidence: 0.68 },
      { language: 'hr', confidence: 0.74 }
    ]);
    // Four fragments out of four, and still the model's own seven tenths — not a hundred.
    expect(summary.candidates).toEqual([{ language: 'hr', share: 0.71 }]);
    expect(summary.confidence).toBeCloseTo(0.71, 6);
  });

  it('counts a fragment whose line carried no probability as a plain vote', () => {
    const summary = summarize([
      { language: 'de', confidence: null },
      { language: 'de', confidence: null },
      { language: 'nl', confidence: null }
    ]);
    expect(summary.candidates).toEqual([
      { language: 'de', share: 2 / 3 },
      { language: 'nl', share: 1 / 3 }
    ]);
  });

  it('answers nothing for no fragments at all', () => {
    expect(summarize([])).toEqual({
      language: null,
      confidence: null,
      candidates: [],
      samples: 0
    });
  });
});

describe('when more fragments are worth their encoder pass', () => {
  it('stops after one for a language the detector is confident and unambiguous about', () => {
    expect(worthMoreWindows({ language: 'en', confidence: 0.99 })).toBe(false);
    expect(worthMoreWindows({ language: 'uk', confidence: 0.92 })).toBe(false);
  });

  it('keeps listening when the answer is unsure or inside a family it mixes up', () => {
    expect(worthMoreWindows({ language: 'en', confidence: 0.4 })).toBe(true);
    expect(worthMoreWindows({ language: 'az', confidence: 0.99 })).toBe(true);
    expect(worthMoreWindows({ language: 'de', confidence: null })).toBe(true);
  });
});

describe('which language a run listens for', () => {
  it('obeys an explicit request over every guess', () => {
    expect(
      languageForRun(
        job({ requestedLanguage: 'de', detectedLanguage: 'az', languageSource: 'probe' })
      )
    ).toBe('de');
  });

  it('uses a probed or corrected language instead of asking whisper to decide again', () => {
    expect(languageForRun(job({ detectedLanguage: 'az', languageSource: 'probe' }))).toBe('az');
    expect(languageForRun(job({ detectedLanguage: 'uz', languageSource: 'manual' }))).toBe('uz');
  });

  it('leaves detection to the run when only a previous run had an opinion', () => {
    expect(languageForRun(job({ detectedLanguage: 'tr', languageSource: 'run' }))).toBe('auto');
    expect(languageForRun(job({}))).toBe('auto');
  });
});

describe('the languages automatic detection mixes up', () => {
  it('names the neighbours of the family Uzbek keeps being mistaken for', () => {
    expect(confusableLanguages('uz')).toContain('az');
    expect(confusableLanguages('az')).toContain('uz');
    expect(confusableLanguages('ps')).toContain('fa');
    // Regional tags and underscores reach the same entry.
    expect(confusableLanguages('uz_UZ')).toEqual(confusableLanguages('uz'));
  });

  it('claims nothing for languages the detector gets right', () => {
    expect(confusableLanguages('en')).toEqual([]);
    expect(confusableLanguages(null)).toEqual([]);
  });

  it('offers every confusable language in the picker, so a correction can be made', () => {
    const offered = new Set<string>(TRANSCRIPTION_LANGUAGE_CODES);
    for (const [code, neighbours] of Object.entries(CONFUSABLE_TRANSCRIPTION_LANGUAGES)) {
      expect(offered.has(code), `${code} is not in the picker`).toBe(true);
      for (const neighbour of neighbours) {
        expect(offered.has(neighbour), `${neighbour} is not in the picker`).toBe(true);
      }
    }
  });
});
