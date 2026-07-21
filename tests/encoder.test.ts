import { describe, expect, it } from 'vitest';
import { isAudioCopyFailure } from '../apps/agent/src/ffmpeg/encoder.js';
import {
  commandExists,
  MediaToolUnavailableError,
  probeMedia
} from '../apps/agent/src/ffmpeg/tools.js';
describe('FFmpeg safeguards', () => {
  it('retries only recognizable audio container failures', () => {
    expect(isAudioCopyFailure('Could not find tag for codec pcm_s16le in stream #1')).toBe(true);
    expect(isAudioCopyFailure('No space left on device')).toBe(false);
  });
  it('reports a missing tool', async () =>
    expect(await commandExists('definitely-not-a-real-ffmpeg-command')).toBe(false));

  it('distinguishes a missing FFprobe runtime from damaged media', async () => {
    await expect(
      probeMedia('/tmp/video.mp4', 'definitely-not-a-real-ffprobe-command')
    ).rejects.toEqual(new MediaToolUnavailableError('ffprobe', 'ENOENT'));
  });
});
