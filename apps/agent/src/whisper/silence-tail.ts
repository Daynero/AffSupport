/**
 * Where the sound in a file actually stops.
 *
 * A creative that has been through the stitcher carries its final photo for thirty to sixty
 * minutes, and under that photo is silence this application generated itself. Measured on one
 * real file: fifty-nine minutes of audio, of which seventy seconds is speech and fifty-eight
 * minutes is the held screen. Whisper listened to all of it — about two hours of work on an M1
 * to recover seventy seconds of text.
 *
 * So the tail is cut before whisper is asked anything. This is not a quality trade: what is
 * removed is below the noise floor for half a minute or more, at the very end of the file.
 * There is no speech in it to lose — the only thing a model can produce from silence is the
 * invented subtitle credit that VAD exists to prevent.
 *
 * Three rules keep it honest:
 *
 * - **Only the tail.** A gap in the middle is left exactly where it is, so every timestamp the
 *   transcript carries still lines up with the source.
 * - **Only a long one.** A pause between sentences is not a tail; the run has to be long enough
 *   that no one could mistake it for one.
 * - **With room to spare.** The cut lands a couple of seconds after the last sound, so a word
 *   trailing off into quiet keeps its ending.
 */

import { open } from 'node:fs/promises';

/** 16-bit mono PCM at 16 kHz — what `runExtract` writes, and all this reads. */
const BYTES_PER_SAMPLE = 2;
const SAMPLE_RATE = 16_000;
/** Header of a canonical RIFF/WAVE file; the extract writes exactly this shape. */
const HEADER_BYTES = 44;

/**
 * Peak amplitude that still counts as silence, as a fraction of full scale.
 *
 * −50 dBFS. Generated silence is digital zero, and a quiet room floor sits well below this; a
 * spoken word, even a soft one, is far above it.
 */
const SILENCE_PEAK = 0.00316;
/** How much quiet must sit at the end before any of it is treated as a tail. */
export const MIN_TAIL_SECONDS = 30;
/** Kept after the last sound, so a fading word is not clipped. */
export const TAIL_PAD_SECONDS = 2;
/** Read backwards in blocks rather than loading an hour of audio into memory. */
const BLOCK_SAMPLES = 1 << 16;

export interface SpeechExtent {
  /** Total length of the audio, in seconds. */
  durationSeconds: number;
  /** Where the last sound is, in seconds; 0 when the file is silent throughout. */
  lastSoundSeconds: number;
  /**
   * What whisper should be given, in seconds — the whole file when there is no tail worth
   * removing, so the caller can pass this on without deciding anything itself.
   */
  audibleSeconds: number;
  /** How much was cut. Zero means nothing was. */
  trimmedSeconds: number;
}

/**
 * Scans backwards from the end of a PCM WAV for the last sample that is not silence.
 *
 * Backwards on purpose: the answer is almost always in the last few seconds of a normal file,
 * and in a stitched one it is an hour away from the end — either way the scan stops as soon as
 * it finds sound, rather than reading the whole file to learn what it already knew.
 */
export async function measureSpeechExtent(wavPath: string): Promise<SpeechExtent> {
  const handle = await open(wavPath, 'r');
  try {
    const { size } = await handle.stat();
    const dataBytes = Math.max(0, size - HEADER_BYTES);
    const totalSamples = Math.floor(dataBytes / BYTES_PER_SAMPLE);
    const durationSeconds = totalSamples / SAMPLE_RATE;
    if (totalSamples === 0) {
      return { durationSeconds: 0, lastSoundSeconds: 0, audibleSeconds: 0, trimmedSeconds: 0 };
    }

    const threshold = Math.round(SILENCE_PEAK * 32_767);
    const buffer = Buffer.allocUnsafe(BLOCK_SAMPLES * BYTES_PER_SAMPLE);
    let lastSoundSample = -1;
    for (let end = totalSamples; end > 0 && lastSoundSample < 0; end -= BLOCK_SAMPLES) {
      const start = Math.max(0, end - BLOCK_SAMPLES);
      const count = end - start;
      const { bytesRead } = await handle.read(
        buffer,
        0,
        count * BYTES_PER_SAMPLE,
        HEADER_BYTES + start * BYTES_PER_SAMPLE
      );
      const samples = Math.floor(bytesRead / BYTES_PER_SAMPLE);
      for (let index = samples - 1; index >= 0; index -= 1) {
        if (Math.abs(buffer.readInt16LE(index * BYTES_PER_SAMPLE)) > threshold) {
          lastSoundSample = start + index;
          break;
        }
      }
    }

    const lastSoundSeconds = lastSoundSample < 0 ? 0 : lastSoundSample / SAMPLE_RATE;
    const tail = durationSeconds - lastSoundSeconds;
    // A file with nothing in it at all is left alone: whisper returning nothing is the right
    // answer, and a zero-length input is not.
    if (lastSoundSample < 0 || tail < MIN_TAIL_SECONDS) {
      return { durationSeconds, lastSoundSeconds, audibleSeconds: durationSeconds, trimmedSeconds: 0 };
    }
    const audibleSeconds = Math.min(durationSeconds, lastSoundSeconds + TAIL_PAD_SECONDS);
    return {
      durationSeconds,
      lastSoundSeconds,
      audibleSeconds,
      trimmedSeconds: durationSeconds - audibleSeconds
    };
  } finally {
    await handle.close();
  }
}
