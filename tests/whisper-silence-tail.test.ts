import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  measureSpeechExtent,
  MIN_TAIL_SECONDS,
  TAIL_PAD_SECONDS
} from '../apps/agent/src/whisper/silence-tail.js';
import { buildWhisperArgs } from '../apps/agent/src/whisper/transcriber.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * Not listening to silence.
 *
 * A creative that has been through the stitcher carries its final photo — and the silence this
 * application generated to sit under it — for half an hour or more. Measured on a real one:
 * fifty-nine minutes of audio holding seventy seconds of speech, which cost about two hours of
 * whisper on an M1. What is asserted here is that the tail is found exactly, that only a tail
 * is ever removed, and that an ordinary recording is handed over whole.
 */

const SAMPLE_RATE = 16_000;
let directory = '';

/** A 16 kHz mono PCM WAV: `seconds` of tone, then `silentSeconds` of digital silence. */
async function wav(seconds: number, silentSeconds: number, name = 'audio.wav'): Promise<string> {
  const total = Math.round((seconds + silentSeconds) * SAMPLE_RATE);
  const sounded = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(total * 2);
  for (let index = 0; index < sounded; index += 1) {
    // Loud enough that no threshold could mistake it for room noise.
    data.writeInt16LE(Math.round(Math.sin(index / 12) * 12_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const file = path.join(directory, name);
  await writeFile(file, Buffer.concat([header, data]));
  return file;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'silence-tail-'));
});

afterEach(async () => {
  await removeTemporaryDirectory(directory);
});

describe('the silence at the end of a file', () => {
  it('finds where the sound stops, and offers only what has sound in it', async () => {
    // The shape of a stitched creative, in miniature: a little speech, a long held screen.
    const file = await wav(70, 3504);
    const extent = await measureSpeechExtent(file);

    expect(extent.durationSeconds).toBeCloseTo(3574, 0);
    expect(extent.lastSoundSeconds).toBeCloseTo(70, 1);
    // The pad keeps a word that fades into the quiet.
    expect(extent.audibleSeconds).toBeCloseTo(70 + TAIL_PAD_SECONDS, 1);
    expect(extent.trimmedSeconds).toBeGreaterThan(3400);
  });

  it('leaves an ordinary recording exactly as long as it is', async () => {
    const file = await wav(120, 0);
    const extent = await measureSpeechExtent(file);
    expect(extent.trimmedSeconds).toBe(0);
    expect(extent.audibleSeconds).toBe(extent.durationSeconds);
  });

  it('does not touch a pause between sentences', async () => {
    // Well under the minimum: quiet this short is speech, not a tail.
    const file = await wav(30, MIN_TAIL_SECONDS - 5);
    const extent = await measureSpeechExtent(file);
    expect(extent.trimmedSeconds).toBe(0);
  });

  it('hands over a file that is silent throughout rather than cutting it to nothing', async () => {
    const file = await wav(0, 120);
    const extent = await measureSpeechExtent(file);
    // Whisper returning nothing is the right answer here; a zero-length input is not.
    expect(extent.lastSoundSeconds).toBe(0);
    expect(extent.audibleSeconds).toBe(extent.durationSeconds);
    expect(extent.trimmedSeconds).toBe(0);
  });

  it('reads an empty file without inventing a length', async () => {
    const file = path.join(directory, 'empty.wav');
    await writeFile(file, Buffer.alloc(0));
    expect(await measureSpeechExtent(file)).toEqual({
      durationSeconds: 0,
      lastSoundSeconds: 0,
      audibleSeconds: 0,
      trimmedSeconds: 0
    });
  });
});

describe('what whisper is told to listen to', () => {
  const base = { wavPath: '/tmp/audio.wav', outputBase: '/tmp/out', language: 'en' };

  it('is given a stopping point when there is a tail to skip', () => {
    const args = buildWhisperArgs({ ...base, audibleSeconds: 71.7565 }, { vadModelPath: null });
    const duration = args[args.indexOf('-d') + 1];
    // Milliseconds, rounded up, so the last fraction of a second is never clipped.
    expect(duration).toBe('71757');
  });

  it('is given no stopping point for a file that is audible throughout', () => {
    expect(buildWhisperArgs({ ...base }, { vadModelPath: null })).not.toContain('-d');
    expect(
      buildWhisperArgs({ ...base, audibleSeconds: null }, { vadModelPath: null })
    ).not.toContain('-d');
  });

  it('still asks for the accuracy settings it always did', () => {
    const args = buildWhisperArgs({ ...base, audibleSeconds: 60 }, { vadModelPath: null });
    // Beam search and best-of are the quality of the result; trimming silence must not have
    // quietly bought its speed from them.
    expect(args.slice(args.indexOf('-bs'), args.indexOf('-bs') + 2)).toEqual(['-bs', '5']);
    expect(args.slice(args.indexOf('-bo'), args.indexOf('-bo') + 2)).toEqual(['-bo', '5']);
  });
});
