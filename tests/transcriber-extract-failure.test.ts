import { access, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describeRequiring(ffmpegBinaries, 'a running Whisper pass', () => {
  it('returns the transcription-stage error after successfully preparing audio', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'soty-whisper-failure-'));
    const source = path.join(directory, 'short.wav');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.5',
      '-y',
      source
    ]);
    vi.stubEnv(
      'WHISPER_PATH',
      await writeStubTool(directory, 'failed-whisper', {
        exitCode: 5,
        stderr: 'auto-detected language: en\nprogress = 10 %',
        durationMs: 10
      })
    );
    vi.resetModules();
    const { transcribe } = await import('../apps/agent/src/whisper/transcriber.js');
    const languages: string[] = [];
    const result = await transcribe({
      inputPath: source,
      language: 'auto',
      durationSeconds: 0.5,
      onProgress: () => {},
      onLanguage: value => languages.push(value)
    }).done;
    expect(result).toMatchObject({
      code: 5,
      cancelled: false,
      failedStage: 'transcribe',
      detectedLanguage: 'en'
    });
    expect(languages).toContain('en');
  });
});

describe('transcription extract failures', () => {
  it('reports an FFmpeg exit as an extract failure and releases a pre-start pause', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'soty-extract-failure-'));
    const marker = path.join(directory, 'spawned');
    vi.stubEnv(
      'FFMPEG_PATH',
      await writeStubTool(directory, 'failed-ffmpeg', {
        exitCode: 7,
        stderr: 'Cannot decode audio',
        progress: true,
        durationMs: 200,
        spawnMarker: marker
      })
    );
    vi.resetModules();
    const { transcribe } = await import('../apps/agent/src/whisper/transcriber.js');
    const progress: (number | null)[] = [];
    const handle = transcribe({
      inputPath: path.join(directory, 'bad.mp4'),
      language: 'auto',
      durationSeconds: 2,
      onProgress: value => progress.push(value)
    });
    expect(handle.setPaused(true)).toBe('no-child');
    expect(handle.setPaused(false)).toBe('released');
    await vi.waitFor(() => access(marker), { timeout: 2_000 });
    expect(handle.setPaused(true)).toBe('unsupported');
    expect(handle.setPaused(false)).toBe('released');
    const result = await handle.done;
    expect(result).toMatchObject({
      code: 7,
      cancelled: false,
      failedStage: 'extract',
      stderr: expect.stringContaining('Cannot decode audio')
    });
    expect(progress.length).toBeGreaterThan(0);
  });

  it('cancels a running extract without starting a later transcription stage', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'soty-extract-cancel-'));
    const marker = path.join(directory, 'spawned');
    vi.stubEnv(
      'FFMPEG_PATH',
      await writeStubTool(directory, 'slow-ffmpeg', {
        durationMs: 5_000,
        spawnMarker: marker
      })
    );
    vi.resetModules();
    const { transcribe } = await import('../apps/agent/src/whisper/transcriber.js');
    const handle = transcribe({
      inputPath: path.join(directory, 'slow.mp4'),
      language: 'auto',
      durationSeconds: 2,
      onProgress: () => {}
    });
    await vi.waitFor(() => access(marker), { timeout: 2_000 });
    handle.cancel();
    expect(await handle.done).toMatchObject({ cancelled: true, failedStage: null });
  });
});
