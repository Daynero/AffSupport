import { describe, expect, it } from 'vitest';
import { buildWhisperArgs } from '../apps/agent/src/whisper/transcriber.js';

describe('Whisper transcription safeguards', () => {
  it('keeps timestamp tokens enabled while writing a plain-text transcript', () => {
    const args = buildWhisperArgs(
      {
        wavPath: '/tmp/input.wav',
        outputBase: '/tmp/transcript',
        language: 'hi'
      },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );

    expect(args).toContain('-otxt');
    expect(args).not.toContain('-nt');
    expect(args).not.toContain('--no-timestamps');
    expect(args).toEqual(expect.arrayContaining(['--vad', '-vm', '/tmp/silero.bin', '-l', 'hi']));
  });
});
