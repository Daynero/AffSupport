import { describe, expect, it } from 'vitest';
import {
  chooseVideoLanguageSamples,
  detectLandingLanguage,
  shouldCommitAutomaticLanguage
} from '../apps/agent/src/team-bridge/language-detection.js';
import {
  resolveVideoThumbnailTimeMs,
  videoThumbnailSeekTargetSeconds
} from '../apps/agent/src/team-bridge/thumbnail.js';

describe('Creative Library lightweight enrichment', () => {
  it('uses bounded landing text and returns Unknown when evidence is insufficient', () => {
    const ukrainian = `${'Привіт світе. '.repeat(2_000)} hidden-tail`;
    expect(detectLandingLanguage(ukrainian, { maximumCharacters: 4_000 })).toMatchObject({
      language: 'uk',
      inspectedCharacters: 4_000
    });
    expect(detectLandingLanguage('1234 !!!', { maximumCharacters: 4_000 }).language).toBe(
      'unknown'
    );
  });

  it('chooses one early and at most one later bounded video speech sample', () => {
    expect(chooseVideoLanguageSamples(120_000)).toEqual([
      { startMs: 5_000, durationMs: 8_000 },
      { startMs: 60_000, durationMs: 8_000 }
    ]);
    expect(chooseVideoLanguageSamples(9_000)).toEqual([{ startMs: 0, durationMs: 8_000 }]);
  });

  it('fences late automatic language results after a manual decision', () => {
    expect(
      shouldCommitAutomaticLanguage({
        sourceVersion: 'v1',
        expectedSourceVersion: 'v1',
        decisionRevision: 3,
        expectedDecisionRevision: 3,
        decisionSource: 'automatic'
      })
    ).toBe(true);
    expect(
      shouldCommitAutomaticLanguage({
        sourceVersion: 'v1',
        expectedSourceVersion: 'v1',
        decisionRevision: 4,
        expectedDecisionRevision: 3,
        decisionSource: 'manual'
      })
    ).toBe(false);
  });

  it('targets exactly one second and falls back to the final available instant', () => {
    expect(resolveVideoThumbnailTimeMs(90_000)).toBe(1_000);
    expect(resolveVideoThumbnailTimeMs(650)).toBe(650);
    expect(videoThumbnailSeekTargetSeconds(90)).toBe(1);
    expect(videoThumbnailSeekTargetSeconds(0.65)).toBe(0.65);
  });
});
