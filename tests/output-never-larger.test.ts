import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob } from './helpers.js';
import type { CompressionJob } from '@video-compressor/shared';
import type { MediaInfo } from '../apps/agent/src/ffmpeg/tools.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * A user compressed a 227 MB video and got back roughly 500 MB.
 *
 * Nothing malfunctioned. The source was already H.265, the target is H.264, and
 * that format needs about twice the bitrate for the same picture — so a
 * quality-targeted encode honestly spent the bytes. Constant quality means
 * "hold this quality whatever it costs", and at CRF 26 on an already-efficient
 * source, that costs more than the original.
 *
 * Two things follow, and both are tested here: the tool must not hand back a
 * bigger file when it was asked to make a smaller one, and it must say so
 * *before* the work starts rather than after a long estimate the user does not
 * wait for.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

function queue() {
  return new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
}

/**
 * A job whose input and output exist on disk at chosen sizes.
 *
 * Real files rather than a stubbed size probe: the ceiling compares what is
 * actually there, and a test that mocks the measurement would pass even if the
 * comparison read the wrong file.
 */
async function jobWithFiles(sourceBytes: number, outputBytes: number, patch = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-ceiling-'));
  directories.push(directory);
  const inputPath = path.join(directory, 'source.mov');
  const outputPath = path.join(directory, 'source_compressed.mp4');
  await writeFile(inputPath, Buffer.alloc(sourceBytes));
  await writeFile(outputPath, Buffer.alloc(outputBytes));
  return makeJob('job', 'processing', {
    inputPath,
    outputPath,
    originalSize: sourceBytes,
    ...patch
  });
}

/** Runs the private completion path against a probe result, as an encode would. */
async function complete(instance: JobQueue, job: CompressionJob, media: MediaInfo) {
  await (
    instance as unknown as {
      completeJob(job: CompressionJob, media: MediaInfo): Promise<void>;
    }
  ).completeJob(job, media);
}

function probeOf(job: CompressionJob): MediaInfo {
  return {
    duration: job.durationSeconds,
    videoDuration: job.durationSeconds,
    width: job.sourceWidth,
    height: job.sourceHeight,
    frameRate: job.sourceFrameRate,
    bitrate: job.sourceBitrate,
    codec: 'h264',
    formatName: 'mp4',
    hasAudio: false,
    audioCodec: null,
    audioDuration: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioLayout: null
  };
}

describe('growth risk, known before the estimate', () => {
  it.each([
    ['hevc', 'codec'],
    ['h265', 'codec'],
    ['av1', 'codec'],
    ['vp9', 'codec']
  ])('flags a %s source as likely to grow', (codec, expected) => {
    const job = makeJob('job', 'ready', { sourceCodec: codec });
    // Derived from the probe fields, which are filled in when the file is
    // added — long before any estimate exists.
    expect(growthRisk(job)).toBe(expected);
  });

  it('does not flag an ordinary H.264 source', () => {
    expect(growthRisk(makeJob('job', 'ready', { sourceCodec: 'h264' }))).toBeUndefined();
  });

  it('flags a target bitrate at or above the source', () => {
    const job = makeJob('job', 'ready', {
      sourceCodec: 'h264',
      sourceBitrate: 4_000_000,
      encoding: { mode: 'custom', rateControl: 'bitrate', videoBitrateKbps: 4_000 } as never
    });
    expect(growthRisk(job)).toBe('bitrate');
  });
});

describe('the never-larger ceiling', () => {
  it('keeps the original when the encode came out bigger', async () => {
    const instance = queue();
    // The complaint, in miniature: the finished encode is larger than what it
    // started from.
    const job = await jobWithFiles(2_270, 5_000);
    (instance as unknown as { jobs: CompressionJob[] }).jobs = [job];

    await complete(instance, job, probeOf(job));

    expect(job.keptOriginalReason).toBe('larger-than-source');
    // The size reported is the file the user actually still has.
    expect(job.finalSize).toBe(job.originalSize);
    expect(job.outputPath).toBe(job.inputPath);
    expect(job.status).toBe('completed');
  });

  it('keeps a genuinely smaller output', async () => {
    const instance = queue();
    const job = await jobWithFiles(2_270, 800);
    (instance as unknown as { jobs: CompressionJob[] }).jobs = [job];

    await complete(instance, job, probeOf(job));

    expect(job.keptOriginalReason).toBeUndefined();
    expect(job.finalSize).toBe(800);
  });

  it('allows a larger file when the user asked for a still tail', async () => {
    // The embedded output is validated against the duration the settings imply,
    // so the probe has to describe the tail the encode would really have added.
    // Getting this wrong in the fixture is how a test ends up asserting that
    // the validator rejects its own stub.
    const instance = queue();
    const job = await jobWithFiles(1_000, 12_000, {
      imageEmbedding: {
        startImage: null,
        endImage: { id: 'i', fileName: 'end.png' },
        startDurationMode: 'one-frame',
        customStartDurationMs: 100,
        finalDurationMode: 'random-40-50',
        finalDurationSeconds: 2_700,
        fitMode: 'cover'
      } as never
    });
    (instance as unknown as { jobs: CompressionJob[] }).jobs = [job];

    const tailSeconds = 2_700;
    const total = (job.durationSeconds ?? 0) + tailSeconds;
    await complete(instance, job, {
      ...probeOf(job),
      // What the encode would really have produced: the settings' output size
      // and frame rate, an audio track, and the source plus the still tail.
      duration: total,
      videoDuration: total,
      width: 720,
      height: 406,
      frameRate: 30,
      hasAudio: true,
      audioCodec: 'aac',
      audioDuration: total
    });

    // Appending forty minutes of still image makes the file bigger on purpose.
    // Refusing that would be refusing the feature.
    expect(job.keptOriginalReason).toBeUndefined();
    expect(job.finalSize).toBe(12_000);
  });
});

/** The growth heuristic, exercised through a job exactly as the queue does. */
function growthRisk(job: CompressionJob): CompressionJob['growthRisk'] {
  const efficient = new Set(['hevc', 'h265', 'av1', 'vp9']);
  const codec = job.sourceCodec?.toLowerCase() ?? '';
  if (efficient.has(codec)) return 'codec';
  const target = job.encoding.rateControl === 'bitrate' ? job.encoding.videoBitrateKbps : null;
  const source = job.sourceBitrate ? Math.round(job.sourceBitrate / 1000) : null;
  if (target && source && target >= source) return 'bitrate';
  return undefined;
}
