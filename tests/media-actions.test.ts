import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_CONVERSION_FORMATS,
  ImageConversionError,
  type ImageConversionFormat
} from '../apps/agent/src/media-actions/image-converter.js';
import { MediaActionQueue } from '../apps/agent/src/media-actions/queue.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let root = '';

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root);
  root = '';
});

describe('native media action queue', () => {
  it('exposes only the requested image targets', () => {
    expect(IMAGE_CONVERSION_FORMATS).toEqual(['png', 'jpeg', 'webp']);
  });

  it('serializes work and reserves distinct sibling paths', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media queue '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let active = 0;
    let maximumActive = 0;
    const outputs: string[] = [];
    const queue = new MediaActionQueue(
      () => {},
      async (inputPath, outputPath) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        outputs.push(outputPath);
        await writeFile(outputPath, `converted from ${inputPath}`, { flag: 'wx' });
        active -= 1;
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );

    const accepted = await queue.addImageConversions([source, source], 'jpeg');
    await queue.shutdown();

    expect(maximumActive).toBe(1);
    expect(outputs.map(value => path.basename(value))).toEqual(['photo.jpg', 'photo_2.jpg']);
    expect(accepted.map(job => path.basename(job.outputPath ?? ''))).toEqual([
      'photo.jpg',
      'photo_2.jpg'
    ]);
    expect(queue.state().jobs.every(job => job.status === 'completed')).toBe(true);
  });

  it('skips a matching source and preserves structured converter failures', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media failures '));
    const png = path.join(root, 'already.PNG');
    const source = path.join(root, 'source.png');
    await Promise.all([writeFile(png, 'source'), writeFile(source, 'source')]);
    const attempted: ImageConversionFormat[] = [];
    const queue = new MediaActionQueue(
      () => {},
      async (_inputPath, _outputPath, format) => {
        attempted.push(format);
        throw new ImageConversionError('ENCODE_FAILED', 'The encoder rejected this image.');
      }
    );

    await queue.addImageConversions([png], 'png');
    await queue.addImageConversions([source], 'webp');
    await queue.shutdown();

    expect(attempted).toEqual(['webp']);
    expect(queue.state().jobs).toMatchObject([
      {
        status: 'skipped',
        errorCode: 'ALREADY_TARGET_FORMAT'
      },
      {
        status: 'failed',
        errorCode: 'ENCODE_FAILED',
        error: 'The encoder rejected this image.'
      }
    ]);
  });

  it('replans when a target appears after the request was accepted', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly late collision '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let attempts = 0;
    const queue = new MediaActionQueue(
      () => {},
      async (_inputPath, outputPath) => {
        attempts += 1;
        if (attempts === 1) {
          await writeFile(outputPath, 'created by another process', { flag: 'wx' });
          throw new ImageConversionError('OUTPUT_EXISTS', 'The target appeared.');
        }
        await writeFile(outputPath, 'converted', { flag: 'wx' });
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );

    await queue.addImageConversions([source], 'jpeg');
    await queue.shutdown();

    expect(attempts).toBe(2);
    expect(queue.state().jobs[0]).toMatchObject({
      outputPath: path.join(root, 'photo_2.jpg'),
      status: 'completed'
    });
  });
});

describe('stopping a native media action', () => {
  it('records a stopped conversion as cancelled rather than failed', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media cancel '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      (_input, _output, _format, signal) =>
        new Promise((_resolve, reject) => {
          started();
          // A real converter surfaces an abort as a rejection, which is exactly why the
          // queue cannot read "threw" as "failed".
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    const [job] = await queue.addImageConversions([source], 'jpeg');
    await running;

    expect(await queue.cancel(job.id)).toBe(true);
    const stopped = queue.state().jobs.find(candidate => candidate.id === job.id);
    // The distinction A3 is about: the user stopped this, nothing broke. Reporting it as
    // failed sends them looking for a problem with their file.
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.error).toBeNull();
    await queue.shutdown();
  });

  it('never starts a conversion stopped while it was still queued', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media queued cancel '));
    const first = path.join(root, 'first.png');
    const second = path.join(root, 'second.png');
    await writeFile(first, 'source');
    await writeFile(second, 'source');
    const converted: string[] = [];
    let release!: () => void;
    const holding = new Promise<void>(resolve => {
      release = resolve;
    });
    let firstStarted!: () => void;
    const firstRunning = new Promise<void>(resolve => {
      firstStarted = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      async (inputPath, outputPath) => {
        if (inputPath === first) {
          firstStarted();
          await holding;
        }
        converted.push(path.basename(inputPath));
        await writeFile(outputPath, 'converted', { flag: 'wx' });
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );

    const [, queuedJob] = await queue.addImageConversions([first, second], 'jpeg');
    await firstRunning;

    expect(await queue.cancel(queuedJob.id)).toBe(true);
    release();
    await queue.shutdown();

    // Spawning after a stop is the same defect as spawning after a cancel between stages:
    // the user's stop is followed by a full conversion at full speed.
    expect(converted).toEqual(['first.png']);
    expect(queue.state().jobs.find(job => job.id === queuedJob.id)?.status).toBe('cancelled');
  });

  it('reports how many runs a stop-everything actually stopped', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media cancel all '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      (_input, _output, _format, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    await queue.addImageConversions([source, source, source], 'jpeg');
    await running;

    // One running plus two queued. A count rather than a boolean, because "stop everything"
    // that stopped nothing and "stop everything" that stopped three are different answers.
    expect(await queue.cancelAll()).toBe(3);
    expect(queue.state().jobs.every(job => job.status === 'cancelled')).toBe(true);
    expect(queue.workActive()).toBe(false);
    await queue.shutdown();
  });
});

describe('a quit that runs out of time for the conversions it is holding', () => {
  it('records what it abandoned as cancelled rather than as failed or still running', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media abandon '));
    const first = path.join(root, 'one.png');
    const second = path.join(root, 'two.png');
    await writeFile(first, 'source');
    await writeFile(second, 'source');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      (_input, _output, _format, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    await queue.addImageConversions([first, second], 'jpeg');
    await running;

    vi.useFakeTimers();
    try {
      const quit = queue.shutdown();
      // Past the drain deadline: the encoder is signalled and the queue behind it is
      // never picked up.
      await vi.advanceTimersByTimeAsync(60_000);
      await quit;
    } finally {
      vi.useRealTimers();
    }

    // The one that was running was stopped by the quit, and the one still waiting will
    // never run. Neither broke, and neither is still happening — which is what the last
    // broadcast before exit would otherwise have claimed.
    expect(queue.state().jobs.map(job => job.status)).toEqual(['cancelled', 'cancelled']);
    expect(queue.state().jobs.every(job => job.error === null)).toBe(true);
    expect(queue.state().running).toBe(false);
  });

  it('leaves no half-written file beside the original', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media abandon sweep '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      async (_input, outputPath, _format, signal) => {
        // What a killed encoder leaves: the converter's own temporary, written and never
        // cleared, because nothing got as far as clearing it.
        const parsed = path.parse(outputPath);
        await writeFile(
          path.join(parsed.dir, `.${parsed.name}.soty-${randomUUID()}${parsed.ext}`),
          'partial'
        );
        return new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    );

    await queue.addImageConversions([source], 'jpeg');
    await running;

    vi.useFakeTimers();
    try {
      const quit = queue.shutdown();
      await vi.advanceTimersByTimeAsync(60_000);
      await quit;
    } finally {
      vi.useRealTimers();
    }

    // Only the original is left. A partial conversion beside it is a file the user did not
    // ask for and that nothing will ever finish.
    expect(await readdir(root)).toEqual(['photo.png']);
  });

  it('does not touch a file the user put there', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media abandon spare '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    // Same leading dot and the same marker, but not one of ours: the UUID is what makes a
    // temporary this application's, and a sweep that went by prefix alone would take it.
    const decoy = path.join(root, '.photo.soty-notes.jpg');
    await writeFile(decoy, 'mine');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const queue = new MediaActionQueue(
      () => {},
      (_input, _output, _format, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    await queue.addImageConversions([source], 'jpeg');
    await running;

    vi.useFakeTimers();
    try {
      const quit = queue.shutdown();
      await vi.advanceTimersByTimeAsync(60_000);
      await quit;
    } finally {
      vi.useRealTimers();
    }

    expect((await readdir(root)).sort()).toEqual(['.photo.soty-notes.jpg', 'photo.png']);
  });
});

describe('where a native media action reaches the interface', () => {
  it('omits the list entirely on an agent that does not offer the bridge', () => {
    const compressor = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {});
    // Absent, not empty: an older agent and one whose platform has no file manager
    // integration must be indistinguishable from the interface's point of view.
    expect(compressor.state().mediaActions).toBeUndefined();
  });

  it('carries the conversions on the compressor state rather than a channel of its own', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media on state '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');

    const actions = new MediaActionQueue(
      () => {},
      async (_input, outputPath) => {
        await writeFile(outputPath, 'converted', { flag: 'wx' });
        return { outputPath, width: 1, height: 1, size: 1 };
      }
    );
    const compressor = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {});
    compressor.setMediaActionSource(() => actions.state());

    await actions.addImageConversions([source], 'jpeg');
    await actions.shutdown();

    // Every REST reply is a whole QueueState too, so the list has to be there and not
    // only on the broadcast — otherwise anything else clicked would blank it.
    expect(compressor.state().mediaActions?.jobs).toHaveLength(1);
    expect(compressor.state().mediaActions?.jobs[0]).toMatchObject({
      kind: 'image-conversion',
      targetFormat: 'jpeg',
      status: 'completed'
    });
  });

  it('reflects a stop through the same state', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wishly media stop on state '));
    const source = path.join(root, 'photo.png');
    await writeFile(source, 'source');
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const actions = new MediaActionQueue(
      () => {},
      (_input, _output, _format, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const compressor = new JobQueue({ ffmpeg: false, ffprobe: false }, () => {});
    compressor.setMediaActionSource(() => actions.state());

    await actions.addImageConversions([source], 'jpeg');
    await running;
    expect(compressor.state().mediaActions?.running).toBe(true);

    await actions.cancelAll();
    expect(compressor.state().mediaActions?.running).toBe(false);
    expect(compressor.state().mediaActions?.jobs[0].status).toBe('cancelled');
    await actions.shutdown();
  });
});
