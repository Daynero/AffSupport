import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('queue file handling', () => {
  it('warns for duplicates and rejects unsupported extensions', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-files-'));
    const video = path.join(directory, 'clip.mov');
    const text = path.join(directory, 'notes.txt');
    await writeFile(video, 'not a real video');
    await writeFile(text, 'text');
    const queue = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {});
    expect(await queue.add([video])).toEqual([]);
    expect((await queue.add([video]))[0].reason).toBe('duplicate');
    expect((await queue.add([text]))[0].reason).toBe('unsupported-format');
  });

  it('analyzes supported videos and exposes readable FFprobe metadata', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-analyze-'));
    const video = path.join(directory, 'clip.mp4');
    expect(await makeVideo(video, 0.5, '160x90', 29.97)).toBe(0);
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
    await queue.add([video]);
    expect(queue.state().jobs[0]).toMatchObject({
      status: 'ready',
      sourceWidth: 160,
      sourceHeight: 90,
      sourceCodec: 'h264'
    });
    expect(queue.state().jobs[0].sourceFrameRate).toBeCloseTo(29.97, 2);
  });

  it('adds uploaded files and rejects the same browser-file signature as a duplicate', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-uploaded-'));
    const first = path.join(directory, 'first.mp4');
    const second = path.join(directory, 'second.mp4');
    expect(await makeVideo(first, 0.3, '160x90', 10)).toBe(0);
    await copyFile(first, second);
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [], {
      ...optimalSettings,
      outputMode: 'chosen-folder',
      outputFolder: directory
    });
    expect(await queue.addUploaded(first, 'clip.mp4', 'clip.mp4:100:123')).toEqual([]);
    const warnings = await queue.addUploaded(second, 'clip.mp4', 'clip.mp4:100:123');
    expect(warnings[0].reason).toBe('duplicate');
    expect(queue.state().jobs).toHaveLength(1);
  });
});

describe('selected batch behavior', () => {
  it('drains active work before an update and refuses new batches', () => {
    const processing = makeJob('processing', 'queued', { batchId: 'batch' });
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {},
      [processing],
      { ...optimalSettings },
      { id: 'batch', jobIds: ['processing'], startedAt: Date.now(), finishedAt: null }
    );
    queue.requestUpdateDrain('0.5.3+9');
    expect(queue.state().update).toEqual({ state: 'draining', targetBuildId: '0.5.3+9' });
    expect(queue.acceptingNewTasks()).toBe(false);
  });

  it('marks an idle update as pending immediately', () => {
    const queue = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {});
    queue.requestUpdateDrain('0.5.3+9');
    expect(queue.state().update).toEqual({ state: 'pending', targetBuildId: '0.5.3+9' });
    expect(queue.acceptingNewTasks()).toBe(false);
  });

  it('starts only selected ready files and leaves other files ready', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-selected-'));
    const first = path.join(directory, 'first.mp4');
    const second = path.join(directory, 'second.mp4');
    expect(await makeVideo(first, 0.4, '160x90', 10)).toBe(0);
    await copyFile(first, second);
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
    await queue.add([first, second]);
    const firstId = queue.state().jobs[0].id;
    expect(await queue.start([firstId])).toBe(true);
    await until(() => !queue.state().running);
    expect(queue.state().jobs.map(job => job.status)).toEqual(['completed', 'ready']);
    expect(queue.state().batch?.jobIds).toEqual([firstId]);
  }, 15_000);

  it('does not remove an active or queued job', () => {
    const processing = makeJob('processing', 'processing', { batchId: 'batch' });
    const queued = makeJob('queued', 'queued', { batchId: 'batch' });
    const ready = makeJob('ready', 'ready');
    const queue = new JobQueue(
      { ffmpeg: false, ffprobe: false },
      () => {},
      [processing, queued, ready],
      { ...optimalSettings },
      { id: 'batch', jobIds: ['processing', 'queued'], startedAt: Date.now(), finishedAt: null }
    );
    expect(queue.remove('processing')).toBe(false);
    expect(queue.remove('queued')).toBe(false);
    expect(queue.removeMany(['processing', 'queued', 'ready'])).toBe(1);
    expect(queue.state().jobs.map(job => job.id)).toEqual(['processing', 'queued']);
  });

  it('keeps reliable start and finish timestamps and preserves the output after row removal', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-timestamps-'));
    const input = path.join(directory, 'source.mp4');
    expect(await makeVideo(input, 0.5, '160x90', 10)).toBe(0);
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
    await queue.add([input]);
    const id = queue.state().jobs[0].id;
    await queue.start([id]);
    await until(() => !queue.state().running);
    const completed = queue.state().jobs[0];
    expect(completed).toMatchObject({
      finalWidth: 160,
      finalHeight: 90,
      finalCodec: 'h264'
    });
    expect(completed.startedAt).toBeTypeOf('number');
    expect(completed.finishedAt).toBeGreaterThanOrEqual(completed.startedAt!);
    await access(completed.outputPath);
    expect(queue.remove(id)).toBe(true);
    await expect(access(completed.outputPath)).resolves.toBeUndefined();
  }, 15_000);

  it('records a failure duration and allows a retry without stopping another selected job', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-failure-'));
    const bad = path.join(directory, 'bad.mov');
    const good = path.join(directory, 'good.mp4');
    await writeFile(bad, 'not video');
    expect(await makeVideo(good, 0.4, '160x90', 10)).toBe(0);
    const badJob = makeJob('bad-job', 'ready', {
      inputPath: bad,
      outputPath: path.join(directory, 'bad-compressed.mp4'),
      durationSeconds: 1
    });
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [badJob], {
      ...optimalSettings
    });
    await queue.add([good]);
    const goodId = queue.state().jobs[1].id;
    await queue.start([badJob.id, goodId]);
    await until(() => !queue.state().running);
    expect(queue.state().jobs[0].status).toBe('failed');
    expect(queue.state().jobs[0].startedAt).toBeTypeOf('number');
    expect(queue.state().jobs[0].finishedAt).toBeGreaterThanOrEqual(
      queue.state().jobs[0].startedAt!
    );
    expect(queue.state().jobs[1].status).toBe('completed');
    expect(await queue.retry(badJob.id)).toBe(true);
    expect(queue.state().jobs[0].status).toBe('ready');
  }, 15_000);

  it('cancels the active FFmpeg job without completing it', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'queue-cancel-'));
    const input = path.join(directory, 'long.mp4');
    expect(await makeVideo(input, 4, '1280x720', 30)).toBe(0);
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {});
    await queue.add([input]);
    const id = queue.state().jobs[0].id;
    await queue.start([id]);
    await until(
      () =>
        queue.state().jobs[0].status === 'processing' && queue.state().jobs[0].startedAt !== null
    );
    expect(await queue.cancel(id)).toBe(true);
    await until(() => !queue.state().running);
    expect(queue.state().jobs[0]).toMatchObject({ status: 'cancelled', finalSize: null });
    expect(queue.state().jobs[0].finishedAt).toBeGreaterThanOrEqual(
      queue.state().jobs[0].startedAt!
    );
  }, 20_000);
});

function makeVideo(file: string, duration: number, size: string, rate: number) {
  return new Promise<number | null>((resolve, reject) => {
    const process = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=${rate}`,
        '-t',
        String(duration),
        '-c:v',
        'libx264',
        '-an',
        file
      ],
      { shell: false }
    );
    process.on('error', reject);
    process.on('close', resolve);
  });
}

async function until(check: () => boolean) {
  const end = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
