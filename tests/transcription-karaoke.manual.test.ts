import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { transcribe } from '../apps/agent/src/whisper/transcriber.js';

const execFileAsync = promisify(execFile);
const runReal = process.env.RUN_REAL_KARAOKE_SMOKE === '1' && process.platform === 'darwin';

/**
 * Opt-in integration check for the exact lag-then-jump regression. It creates
 * synthetic speech locally, runs the installed large-v3 model through the real
 * chunk/JSON/merge path, and asserts that timestamps remain distributed over
 * the media instead of collapsing several words onto a segment end.
 */
describe.runIf(runReal)('real local karaoke timestamp smoke', () => {
  it('keeps every synthetic spoken word monotonic and spread across playback time', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-karaoke-smoke-'));
    try {
      const inputPath = path.join(dir, 'fixture.aiff');
      await execFileAsync('/usr/bin/say', [
        '-v',
        'Samantha',
        '-r',
        '165',
        '-o',
        inputPath,
        'Today we verify that every highlighted word follows the audio smoothly without waiting and jumping forward.'
      ]);

      const media = await probeMedia(inputPath);
      const result = await transcribe({
        inputPath,
        language: 'en',
        onProgress: () => {}
      }).done;

      expect(result.code).toBe(0);
      expect(media.duration).not.toBeNull();
      expect(result.words.length).toBeGreaterThanOrEqual(8);
      expect(new Set(result.words.map(word => word.startMs)).size).toBeGreaterThanOrEqual(8);
      expect(
        result.words.every(
          (word, index, words) =>
            word.startMs >= 0 &&
            word.endMs >= word.startMs &&
            (index === 0 || word.startMs >= words[index - 1].startMs)
        )
      ).toBe(true);

      const durationMs = (media.duration ?? 0) * 1_000;
      const first = result.words[0];
      const last = result.words.at(-1)!;
      expect(last.endMs - first.startMs).toBeGreaterThan(durationMs * 0.45);
      expect(last.endMs).toBeLessThanOrEqual(durationMs + 750);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
