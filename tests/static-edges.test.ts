import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultImageEmbeddingSettings,
  type AgentSettings,
  type ImageAsset
} from '../packages/shared/src/types.js';
import { detectStaticEdgeTrims } from '../apps/agent/src/images/static-edges.js';
import { commandExists, probeMedia } from '../apps/agent/src/ffmpeg/tools.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('re-embedding static edge removal', () => {
  it('finds static runs at the beginning and end of a video', async () => {
    if (!(await commandExists('ffmpeg'))) return;
    directory = await mkdtemp(path.join(os.tmpdir(), 'static-video-edges-'));
    const input = path.join(directory, 'previously-embedded.mp4');
    expect(await createEdgedVideo(input)).toBe(0);
    const media = await probeMedia(input);
    const trims = await detectStaticEdgeTrims(input, media.duration!, media.frameRate!);

    expect(trims.startSeconds).toBeGreaterThanOrEqual(0.2);
    expect(trims.startSeconds).toBeLessThanOrEqual(0.3);
    expect(trims.endSeconds).toBeGreaterThanOrEqual(0.3);
    expect(trims.endSeconds).toBeLessThanOrEqual(0.5);
  }, 15_000);

  it('trims the detected edges before embedding the new image', async () => {
    if (!(await commandExists('ffmpeg'))) return;
    directory = await mkdtemp(path.join(os.tmpdir(), 'replace-static-video-edges-'));
    const input = path.join(directory, 'previously-embedded.mp4');
    const imageRoot = path.join(directory, 'images');
    const image = imageAsset();
    const imagePath = path.join(imageRoot, `${image.id}.png`);
    await mkdir(imageRoot, { recursive: true });
    expect(await createEdgedVideo(input)).toBe(0);
    expect(
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:size=160x90',
        '-frames:v',
        '1',
        '-threads',
        '1',
        imagePath
      ])
    ).toBe(0);
    const settings: AgentSettings = {
      ...optimalSettings,
      outputMode: 'chosen-folder',
      outputFolder: directory,
      imageEmbedding: {
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        endImages: [image],
        replaceExisting: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 0.2
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
    await queue.add([input]);
    const id = queue.state().jobs[0].id;
    expect(await queue.start([id])).toBe(true);
    await until(() => !queue.state().running);

    const completed = queue.state().jobs[0];
    expect(completed.status).toBe('completed');
    expect(completed.imageEmbedding?.sourceTrimStartSeconds).toBeGreaterThanOrEqual(0.2);
    expect(completed.imageEmbedding?.sourceTrimEndSeconds).toBeGreaterThanOrEqual(0.3);
    const expectedDuration =
      completed.durationSeconds! -
      completed.imageEmbedding!.sourceTrimStartSeconds -
      completed.imageEmbedding!.sourceTrimEndSeconds +
      0.2;
    expect(completed.finalDurationSeconds).toBeCloseTo(expectedDuration, 1);
  }, 20_000);
});

function createEdgedVideo(output: string) {
  return run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=160x90:rate=10:duration=0.3',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=10:duration=0.6',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=160x90:rate=10:duration=0.4',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    output
  ]);
}

function imageAsset(): ImageAsset {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    fileName: 'new-end.png',
    width: 160,
    height: 90,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

function run(command: string, args: string[]) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
