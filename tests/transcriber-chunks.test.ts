import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeStubTool } from './support/stub-tools/index.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';

let directory = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

async function fixture(
  options: {
    failAt?: number;
    omitOutput?: boolean;
    silent?: boolean;
    stderr?: string;
    whisperAttempts?: readonly { text: string; json?: unknown; omitOutput?: boolean }[];
  } = {}
) {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-transcription-chunks-'));
  const source = path.join(directory, 'source.wav');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    options.silent ? 'anullsrc=r=16000:cl=mono:d=20' : 'sine=frequency=440:duration=20',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-y',
    source
  ]);
  const counter = path.join(directory, 'attempts');
  const texts = [
    'पहला वाक्य एक दो तीन',
    'एक दो तीन मध्य भाग चार पाँच छह',
    'चार पाँच छह अंतिम वाक्य सात आठ नौ'
  ];
  vi.stubEnv(
    'WHISPER_PATH',
    await writeStubTool(directory, 'whisper', {
      durationMs: 10,
      stderr: options.stderr ?? 'auto-detected language: hi',
      whisperTranscripts: options.omitOutput ? undefined : texts,
      whisperAttempts: options.whisperAttempts,
      attemptCounter: counter,
      attempts: Array.from({ length: 6 }, (_, index) => ({
        exitCode: index === options.failAt ? 7 : 0
      }))
    })
  );
  vi.resetModules();
  return {
    source,
    counter,
    texts,
    transcribe: (await import('../apps/agent/src/whisper/transcriber.js')).transcribe
  };
}

describeRequiring(ffmpegBinaries, 'bounded transcription pipeline', () => {
  const speechLog =
    'whisper_vad: detected 1 speech segments\nwhisper_vad: Including segment 0: 0.00 - 8.00 (duration: 8.00)\n';
  const speechJson = (text: string) => ({
    transcription: [
      {
        text,
        offsets: { from: 0, to: 8000 },
        tokens: [{ text: ` ${text}`, offsets: { from: 0, to: 8000 } }]
      }
    ]
  });

  it('retries an empty speech decode and keeps the recovered output', async () => {
    const sentence = 'A recovered spoken sentence.';
    const { source, counter, transcribe } = await fixture({
      stderr: speechLog,
      whisperAttempts: [{ text: '' }, { text: sentence, json: speechJson(sentence) }]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result.code).toBe(0);
    expect(result.text).toContain(sentence);
    expect(result.reliability).toMatchObject({ recoveredWindows: 1, retries: 1 });
    expect(await readFile(counter, 'utf8')).toBe('4');
  }, 20_000);

  it('recovers a decoder loop without deleting real repeated speech by text rule', async () => {
    const recovered = 'No no, this is the actual spoken sentence.';
    const { source, transcribe } = await fixture({
      stderr: speechLog,
      whisperAttempts: [
        {
          text: 'No. No. No. No. No. No. No. No.',
          json: speechJson('No. No. No. No. No. No. No. No.')
        },
        { text: recovered, json: speechJson(recovered) }
      ]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result.code).toBe(0);
    expect(result.text).toContain(recovered);
    expect(result.text).not.toContain('No. No. No. No.');
    expect(result.reliability?.recoveredWindows).toBeGreaterThan(0);
  }, 20_000);

  it('fails unexplained missing speech after exactly two retries', async () => {
    const { source, counter, transcribe } = await fixture({
      stderr: speechLog,
      whisperAttempts: [{ text: '' }, { text: '' }, { text: '' }]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 1, failedStage: 'transcribe', text: '' });
    expect(result.stderr).toContain('SPEECH_NOT_TRANSCRIBED');
    expect(await readFile(counter, 'utf8')).toBe('3');
  }, 20_000);
  it('never reads an earlier decode as a retry whose output files are missing', async () => {
    const { source, counter, transcribe } = await fixture({
      stderr: speechLog,
      whisperAttempts: [
        {
          text: 'Only the beginning',
          json: { transcription: [{ text: 'Only the beginning', offsets: { from: 0, to: 1000 } }] }
        },
        { text: '', omitOutput: true }
      ]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 1, text: '' });
    expect(result.reliability?.recoveredWindows).toBe(0);
    expect(result.stderr).toContain('WHISPER_OUTPUT_MISSING retry=1');
    expect(await readFile(counter, 'utf8')).toBe('2');
  }, 20_000);

  it('cancels at the start of recovery without spawning a retry', async () => {
    const { source, counter, transcribe } = await fixture({
      stderr: speechLog,
      whisperAttempts: [{ text: '' }]
    });
    const handle = transcribe({
      inputPath: source,
      language: 'en',
      onProgress: () => {},
      onPhase: phase => {
        if (phase === 'recover') handle.cancel();
      }
    });
    expect(await handle.done).toMatchObject({ cancelled: true, text: '' });
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 20_000);

  it('does not infer speech from music-like amplitude when VAD evidence is unavailable', async () => {
    const { source, counter, transcribe } = await fixture({
      stderr: '',
      whisperAttempts: [{ text: '' }, { text: '' }, { text: '' }]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 0, text: '' });
    expect(result.reliability).toMatchObject({ retries: 0 });
    expect(result.reliability?.warnings).toHaveLength(3);
    expect(await readFile(counter, 'utf8')).toBe('3');
  }, 20_000);

  it('suppresses decoder hallucinations on exact digital silence without retrying', async () => {
    const { source, counter, transcribe } = await fixture({ silent: true });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 0, text: '', words: [] });
    expect(result.reliability?.retries).toBe(0);
    await expect(readFile(counter, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('preserves canonical timings at a seam rather than discarding its unique owner', async () => {
    const first = 'We can do this now';
    const second = 'do this now and continue';
    const third = 'and continue to the end';
    const timedJson = (text: string, starts: number[]) => ({
      transcription: [
        {
          text,
          offsets: { from: 0, to: 8000 },
          tokens: text.split(' ').map((word, index) => ({
            text: ` ${word}`,
            offsets: { from: starts[index], to: starts[index] + 300 }
          }))
        }
      ]
    });
    const { source, transcribe } = await fixture({
      whisperAttempts: [
        { text: first, json: timedJson(first, [0, 1000, 6000, 6500, 7000]) },
        { text: second, json: timedJson(second, [0, 500, 1000, 6000, 6500]) },
        { text: third, json: timedJson(third, [0, 500, 3000, 4000, 5000]) }
      ]
    });
    const result = await transcribe({ inputPath: source, language: 'en', onProgress: () => {} })
      .done;
    expect(result.text).toBe('We can do this now and continue to the end');
    const { segmentsFromTextWithWords } =
      await import('../apps/agent/src/transcription/document-store.js');
    expect(
      segmentsFromTextWithWords('seam', result.text, result.words)
        .flatMap(segment => segment.words)
        .map(word => word.text)
        .join(' ')
    ).toBe(result.text);
  }, 20_000);
  it('covers every window in both source and English pivot and preserves the document text', async () => {
    const { source, counter, transcribe } = await fixture();
    const progress: number[] = [];
    const result = await transcribe({
      inputPath: source,
      language: 'auto',
      createEnglishPivot: true,
      onProgress: value => {
        if (value !== null) progress.push(value);
      }
    }).done;
    expect(result.code).toBe(0);
    expect(result.text).toBe('पहला वाक्य एक दो तीन मध्य भाग चार पाँच छह अंतिम वाक्य सात आठ नौ');
    expect(result.englishText).toBe(result.text);
    expect(await readFile(counter, 'utf8')).toBe('6');
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(
      true
    );
    const { segmentsFromTextWithWords } =
      await import('../apps/agent/src/transcription/document-store.js');
    expect(
      segmentsFromTextWithWords('test', result.text, [])
        .map(segment => segment.sourceText)
        .join('\n')
    ).toBe(result.text);
  }, 20_000);

  it('fails a middle window without returning a successful partial transcript', async () => {
    const { source, counter, transcribe } = await fixture({ failAt: 1 });
    const result = await transcribe({ inputPath: source, language: 'hi', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 7, text: '', failedStage: 'transcribe' });
    expect(await readFile(counter, 'utf8')).toBe('2');
  }, 20_000);

  it('keeps the full source when the optional pivot fails', async () => {
    const { source, counter, transcribe } = await fixture({ failAt: 4 });
    const result = await transcribe({
      inputPath: source,
      language: 'hi',
      createEnglishPivot: true,
      onProgress: () => {}
    }).done;
    expect(result.code).toBe(0);
    expect(result.text).toContain('अंतिम वाक्य सात आठ नौ');
    expect(result.englishText).toBe('');
    expect(await readFile(counter, 'utf8')).toBe('5');
  }, 20_000);

  it('rejects an exit-zero decoder that did not write its transcript', async () => {
    const { source, transcribe } = await fixture({ omitOutput: true });
    const result = await transcribe({ inputPath: source, language: 'hi', onProgress: () => {} })
      .done;
    expect(result).toMatchObject({ code: 1, text: '', failedStage: 'transcribe' });
    expect(result.stderr).toContain('WHISPER_OUTPUT_MISSING');
  }, 20_000);

  it('honors a cancellation between windows without spawning the next decoder', async () => {
    const { source, counter, transcribe } = await fixture();
    const handle = transcribe({
      inputPath: source,
      language: 'hi',
      onProgress: value => {
        if (value !== null && value >= 35) handle.cancel();
      }
    });
    expect(await handle.done).toMatchObject({ cancelled: true, text: '' });
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 20_000);
});
