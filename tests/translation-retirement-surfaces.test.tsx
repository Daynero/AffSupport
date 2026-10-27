import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../apps/web/src/locales/en';
import { uk } from '../apps/web/src/locales/uk';

describe('original-only product surfaces', () => {
  it.each([en, uk])('has no retired product labels or model notices', dictionary => {
    const entries = Object.entries(dictionary).filter(([key]) =>
      /transcription|creativeLibrary|teamBatch/iu.test(key)
    );
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.map(([, text]) => text).join(' ')).not.toMatch(
      /TranslateGemma|Gemma|translator|translation|переклад/iu
    );
  });
  it('does not package exclusive runtime licenses or expose a second text column', () => {
    const files = [
      'scripts/package-mac.sh',
      'scripts/package-dev-mac.sh',
      'scripts/package-beta-mac.sh',
      'scripts/stage-windows-runtime.mjs',
      'scripts/windows-smoke.mjs',
      'THIRD_PARTY_NOTICES.md'
    ];
    for (const file of files)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /TranslateGemma|llama\.cpp|multilingual-e5|GEMMA_TERMS/u
      );
    expect(existsSync('apps/agent/src/translation')).toBe(false);
    expect(
      readFileSync('apps/web/src/transcription/TranscriptTextModal.tsx', 'utf8')
    ).not.toContain('data-side="target"');
  });
});
