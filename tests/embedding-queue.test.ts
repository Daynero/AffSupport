import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultImageEmbeddingSettings,
  type AgentSettings,
  type ImageAsset
} from '../packages/shared/src/types.js';
import { probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('sequential queue with embedded images', () => {
  it('processes horizontal, vertical and square videos with stereo, mono and missing audio', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding queue '));
    const imageRoot = path.join(directory, 'image assets');
    const outputFolder = path.join(directory, 'results');
    await mkdir(imageRoot, { recursive: true });
    const start = imageAsset('11111111-1111-4111-8111-111111111111', 'opening.png', 90, 160);
    const end = imageAsset('22222222-2222-4222-8222-222222222222', 'ending.png', 200, 80);
    expect(await createImage(path.join(imageRoot, `${start.id}.png`), 'red', '90x160')).toBe(0);
    expect(await createImage(path.join(imageRoot, `${end.id}.png`), 'green', '200x80')).toBe(0);

    const sources = [
      { file: path.join(directory, 'horizontal stereo.mp4'), size: '160x90', audio: 'stereo' },
      { file: path.join(directory, 'vertical mono.mp4'), size: '90x160', audio: 'mono' },
      { file: path.join(directory, 'square silent.mp4'), size: '120x120', audio: 'none' }
    ] as const;
    for (const source of sources) {
      expect(await createVideo(source.file, source.size, source.audio)).toBe(0);
    }
    const before = await Promise.all(sources.map(source => sha256(source.file)));
    const settings: AgentSettings = {
      ...optimalSettings,
      outputMode: 'chosen-folder',
      outputFolder,
      imageEmbedding: {
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        startImage: start,
        endImage: end,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 0.3,
        fitMode: 'cover'
      }
    };
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [],
      settings,
      null,
      new ImageAssetStore(imageRoot)
    );
    await queue.add(sources.map(source => source.file));
    const sourceJobs = queue.state().jobs;
    expect(sourceJobs.map(job => job.sourceHasAudio)).toEqual([true, true, false]);
    expect(sourceJobs[1].sourceAudioChannels).toBe(1);
    expect(await queue.start(sourceJobs.map(job => job.id))).toBe(true);
    await until(() => !queue.state().running, 20_000);

    const completed = queue.state().jobs;
    expect(completed.map(job => job.status)).toEqual(['completed', 'completed', 'completed']);
    for (let index = 0; index < completed.length; index++) {
      const job = completed[index];
      const media = await probeMedia(job.outputPath);
      expect(path.basename(job.outputPath)).toContain('_embedded_compressed');
      expect(job.progress).toBe(100);
      expect(job.processingStage).toBeNull();
      expect(media.hasAudio).toBe(true);
      expect(media.audioChannels).toBe(2);
      expect(media.frameRate).toBeCloseTo(30, 2);
      expect(media.duration).toBeCloseTo((job.durationSeconds ?? 0) + 1 / 30 + 0.3, 1);
      expect(await sha256(sources[index].file)).toBe(before[index]);
    }
    expect(completed[0]).toMatchObject({ finalWidth: 160, finalHeight: 90 });
    expect(completed[1]).toMatchObject({ finalWidth: 90, finalHeight: 160 });
    expect(completed[2]).toMatchObject({ finalWidth: 120, finalHeight: 120 });
  }, 30_000);

  it('reports a damaged image per job and continues the rest of the batch', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding damaged '));
    const imageRoot = path.join(directory, 'images');
    await mkdir(imageRoot, { recursive: true });
    const damaged = imageAsset('33333333-3333-4333-8333-333333333333', 'damaged.png', 20, 20);
    await writeFile(path.join(imageRoot, `${damaged.id}.png`), 'not an image');
    const files = [path.join(directory, 'one.mp4'), path.join(directory, 'two.mp4')];
    for (const file of files) expect(await createVideo(file, '80x80', 'none')).toBe(0);
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [],
      {
        ...optimalSettings,
        imageEmbedding: {
          ...defaultImageEmbeddingSettings(),
          enabled: true,
          startImage: damaged
        }
      },
      null,
      new ImageAssetStore(imageRoot)
    );
    await queue.add(files);
    expect(await queue.start(queue.state().jobs.map(job => job.id))).toBe(true);
    await until(() => !queue.state().running, 10_000);
    expect(queue.state().jobs.map(job => job.status)).toEqual(['failed', 'failed']);
    for (const job of queue.state().jobs) {
      expect(job.error).toMatch(/damaged/i);
      expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt!);
    }
  }, 15_000);
});

function imageAsset(id: string, fileName: string, width: number, height: number): ImageAsset {
  return {
    id,
    fileName,
    width,
    height,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

function createImage(file: string, color: string, size: string) {
  return run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=${size}`,
    '-frames:v',
    '1',
    '-threads',
    '1',
    file
  ]);
}

function createVideo(file: string, size: string, audio: 'stereo' | 'mono' | 'none') {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=30`
  ];
  if (audio !== 'none') args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', '0.45', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio !== 'none') {
    args.push('-c:a', 'aac', '-ac', audio === 'mono' ? '1' : '2', '-shortest');
  } else {
    args.push('-an');
  }
  args.push(file);
  return run('ffmpeg', args);
}

const run = (command: string, args: string[]) =>
  new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    child.on('error', reject);
    child.on('close', resolve);
  });

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function until(check: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
