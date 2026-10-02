import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { transcribe } from '../apps/agent/src/whisper/transcriber.js';
import { segmentsFromTextWithWords } from '../apps/agent/src/transcription/document-store.js';
import { allOf, describeRequiring, requireEnvFlag, requirePath } from './support/requires.js';

// The user's media stays outside the repository. Opt in with the original
// 68-second Hindi sample to check real model behavior, not only process stubs.
const inputPath = process.env.HINDI_TRANSCRIPTION_SAMPLE ?? '';
const sample = allOf(
  requireEnvFlag('RUN_REAL_TRANSCRIPTION_COVERAGE'),
  requirePath(inputPath || 'HINDI_TRANSCRIPTION_SAMPLE')
);

describeRequiring(sample, 'Hindi speech coverage regression', () => {
  it('retains the previously skipped middle and final spoken passages', async () => {
    const result = await transcribe({
      inputPath,
      language: 'hi',
      quality: 'accurate',
      createEnglishPivot: true,
      onProgress: () => {}
    }).done;
    if (process.env.TRANSCRIPTION_COVERAGE_OUTPUT) {
      await writeFile(process.env.TRANSCRIPTION_COVERAGE_OUTPUT, JSON.stringify(result));
    }
    expect(result.code).toBe(0);
    // 13–31 s, 41–49 s and 49–68 s were silently discarded by the
    // long-form decoder. Check each independently, including the CTA's end.
    for (const passage of ['फार्मेसी', 'सांडों', 'बिस्तर', 'रक्त', 'छूट', 'खत्म मत करने दो']) {
      expect(result.text).toContain(passage);
    }
    const visible = segmentsFromTextWithWords('coverage', result.text, result.words)
      .map(segment => segment.sourceText)
      .join(' ');
    for (const passage of ['फार्मेसी', 'बिस्तर', 'रक्त', 'छूट', 'खत्म मत करने दो']) {
      expect(visible).toContain(passage);
    }
    const timed = segmentsFromTextWithWords('coverage', result.text, result.words).flatMap(
      segment => segment.words
    );
    expect(timed.length).toBeGreaterThan(180);
    expect(result.englishText).toMatch(/pharmac|pills/iu);
    expect(result.englishText).toMatch(/confidence/iu);
    expect(result.englishText).toMatch(/boxes/iu);
    expect(
      result.words.every(
        (word, index) =>
          word.endMs >= word.startMs &&
          word.endMs <= 69_000 &&
          (index === 0 || word.startMs >= result.words[index - 1].startMs)
      )
    ).toBe(true);
  }, 600_000);
});
