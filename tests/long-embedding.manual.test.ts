import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultImageEmbeddingSettings,
  type AgentSettings,
  type ImageAsset
} from '../packages/shared/src/types.js';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import {
  commandExists,
  ffmpegPath,
  ffprobePath,
  probeMedia
} from '../apps/agent/src/ffmpeg/tools.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { optimalEncoding, optimalSettings } from './helpers.js';

const runLong = process.env.RUN_LONG_EMBED_TEST === '1' ? it : it.skip;
let directory = '';
let available = false;

beforeAll(async () => {
  available = (await commandExists(ffmpegPath)) && (await commandExists(ffprobePath));
  if (available) directory = await mkdtemp(path.join(os.tmpdir(), 'long-static-embedding-'));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('manual long static embedding verification', () => {
  runLong(
    'encodes a real 30-minute final image with matching silent audio',
    async () => {
      if (!available) return;
      const input = path.join(directory, 'original.mp4');
      const image = path.join(directory, 'final.png');
      const output = path.join(directory, 'long_embedded_compressed.mp4');
      expect(
        await run(ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=96x54:rate=24',
          '-t',
          '0.5',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-an',
          input
        ])
      ).toBe(0);
      expect(
        await run(ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=navy:size=48x96',
          '-frames:v',
          '1',
          '-threads',
          '1',
          image
        ])
      ).toBe(0);
      const before = await digest(input);
      const source = await probeMedia(input);
      const endDuration = 30 * 60;
      const operation = encodeVideo(
        input,
        output,
        source.duration! + endDuration,
        optimalEncoding,
        false,
        () => {},
        {
          sourceDurationSeconds: source.duration!,
          sourceHasAudio: false,
          width: 96,
          height: 54,
          frameRate: 24,
          imageEmbedding: {
            startImage: null,
            endImage: imageAsset(),
            finalDurationMode: 'random-30-40',
            finalDurationSeconds: endDuration,
            fitMode: 'cover'
          },
          startImagePath: null,
          endImagePath: image
        }
      );
      const result = await operation.done;
      expect(result.code, result.stderr).toBe(0);
      const media = await probeMedia(output);
      expect(media).toMatchObject({
        width: 96,
        height: 54,
        frameRate: 24,
        hasAudio: true,
        audioChannels: 2
      });
      expect(media.duration).toBeCloseTo(source.duration! + endDuration, 0);
      expect(Math.abs((media.audioDuration ?? 0) - (media.videoDuration ?? 0))).toBeLessThan(0.12);
      expect(await digest(input)).toBe(before);
    },
    10 * 60_000
  );

  runLong(
    'freezes and encodes different 40–50 minute durations for two jobs',
    async () => {
      if (!available) return;
      const imageRoot = path.join(directory, 'random-images');
      const outputFolder = path.join(directory, 'random-results');
      await mkdir(imageRoot, { recursive: true });
      const endImage = imageAsset();
      const image = path.join(imageRoot, `${endImage.id}.png`);
      expect(
        await run(ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=teal:size=48x96',
          '-frames:v',
          '1',
          '-threads',
          '1',
          image
        ])
      ).toBe(0);
      const inputs = [
        path.join(directory, 'random-one.mp4'),
        path.join(directory, 'random-two.mp4')
      ];
      for (const input of inputs) {
        expect(
          await run(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=96x54:rate=24',
            '-t',
            '0.25',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-an',
            input
          ])
        ).toBe(0);
      }
      const settings: AgentSettings = {
        ...optimalSettings,
        outputMode: 'chosen-folder',
        outputFolder,
        imageEmbedding: {
          ...defaultImageEmbeddingSettings(),
          enabled: true,
          endImage,
          finalDurationMode: 'random-40-50'
        }
      };
      const randomValues = [0.1, 0.9];
      const queue = new JobQueue(
        { ffmpeg: true, ffprobe: true },
        () => {},
        [],
        settings,
        null,
        new ImageAssetStore(imageRoot),
        () => randomValues.shift() ?? 0.5
      );
      await queue.add(inputs);
      expect(await queue.start(queue.state().jobs.map(job => job.id))).toBe(true);
      expect(queue.state().jobs.map(job => job.imageEmbedding?.finalDurationSeconds)).toEqual([
        2460, 2940
      ]);
      await until(() => !queue.state().running, 2 * 60_000);
      const completed = queue.state().jobs;
      expect(completed.map(job => job.status)).toEqual(['completed', 'completed']);
      expect(completed[0].finalDurationSeconds).not.toBe(completed[1].finalDurationSeconds);
      for (const job of completed) {
        expect(job.finalDurationSeconds).toBeCloseTo(
          (job.durationSeconds ?? 0) + (job.imageEmbedding?.finalDurationSeconds ?? 0),
          0
        );
      }
    },
    10 * 60_000
  );
});

function imageAsset(): ImageAsset {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    fileName: 'final.png',
    width: 48,
    height: 96,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

async function digest(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

const run = (command: string, args: string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    child.on('error', reject);
    child.on('close', resolve);
  });

async function until(check: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
