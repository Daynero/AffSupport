import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobImageEmbedding } from '@video-compressor/shared';
import { optimalSettings } from './helpers.js';

/**
 * How the encoder reports a run that went wrong before FFmpeg could say so itself:
 * the tool could not be started, the held final picture could not be built or muxed,
 * or the body's timing could not be read. Each must come back as a failure the queue
 * can name, never as a success and never as a stop.
 */
type Script = { code: number | null; error?: string };
const scripts: Script[] = [];
const spawned: string[][] = [];

function fakeChild(script: Script) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  setImmediate(() => {
    if (script.error) {
      child.emit(
        'error',
        Object.assign(new Error(`spawn ${script.error}`), { code: script.error })
      );
    } else {
      child.emit('spawn');
      child.stdout.write('out_time_us=500000\nprogress=end\n');
    }
    child.emit('close', script.code);
  });
  return child;
}

const held = vi.hoisted(() => ({ step: 'ok' as 'ok' | 'failed', timing: 1 as number | null }));

vi.mock('../apps/agent/src/power/spawn.js', () => ({
  activeGovernorOrNull: () => null,
  spawnManaged: (_governor: unknown, _command: string, args: string[]) => {
    spawned.push(args);
    return fakeChild(scripts.shift() ?? { code: 0 });
  }
}));
vi.mock('../apps/agent/src/ffmpeg/held-picture.js', () => ({
  buildHeldPicture: async () => ({ step: held.step })
}));
vi.mock('../apps/agent/src/ffmpeg/tools.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/agent/src/ffmpeg/tools.js')>()),
  concatSegmentDuration: async () => held.timing
}));

const { encodeVideo } = await import('../apps/agent/src/ffmpeg/encoder.js');

const image = { id: 'end', name: 'end.png', path: '/images/end.png' };
const embedding = {
  sourceStartSeconds: 0,
  sourceDurationSeconds: 4,
  sourceHasAudio: false,
  width: 1080,
  height: 1920,
  frameRate: 30,
  imageEmbedding: {
    startImage: null,
    endImage: image,
    startDurationMode: 'one-frame',
    customStartDurationMs: 0,
    finalDurationMode: 'custom',
    finalDurationSeconds: 3,
    fitMode: 'cover',
    replaceExisting: false
  } as unknown as JobImageEmbedding,
  startImagePath: null,
  endImagePath: '/images/end.png'
};

beforeEach(() => {
  scripts.length = 0;
  spawned.length = 0;
  held.step = 'ok';
  held.timing = 1;
});

describe('encoder failure paths', () => {
  it('names a tool that could not be started on a plain encode', async () => {
    scripts.push({ code: null, error: 'ENOENT' });
    const progress: Array<number | null> = [];
    const { done } = encodeVideo('/in.mp4', '/out.mp4', 10, optimalSettings, false, value =>
      progress.push(value)
    );
    const result = await done;
    expect(result.spawnErrorCode).toBe('ENOENT');
    expect(result.stderr).toContain('spawn ENOENT');
    expect(result.cancelled).toBe(false);
  });

  it('names a held pass whose tool could not be started', async () => {
    scripts.push({ code: null, error: 'EACCES' });
    const { done } = encodeVideo(
      '/in.mp4',
      '/out.mp4',
      4,
      optimalSettings,
      false,
      () => {},
      embedding,
      null
    );
    const result = await done;
    expect(result.spawnErrorCode).toBe('EACCES');
    expect(spawned).toHaveLength(1);
  });

  it('reports a held picture that could not be built as HELD_SCREEN_FAILED', async () => {
    held.step = 'failed';
    const { done } = encodeVideo(
      '/in.mp4',
      '/out.mp4',
      4,
      optimalSettings,
      false,
      () => {},
      embedding,
      null
    );
    expect(await done).toEqual({
      code: 1,
      stderr: 'HELD_SCREEN_FAILED',
      cancelled: false,
      spawnErrorCode: null
    });
  });

  it('keeps the real mux failure rather than a generic one', async () => {
    scripts.push({ code: 0 }, { code: 3 });
    const { done } = encodeVideo(
      '/in.mp4',
      '/out.mp4',
      4,
      optimalSettings,
      false,
      () => {},
      embedding,
      null
    );
    const result = await done;
    expect(result.code).toBe(3);
    expect(result.stderr).not.toBe('HELD_SCREEN_FAILED');
  });

  it('refuses to join when the body timing cannot be read', async () => {
    held.timing = null;
    const { done } = encodeVideo(
      '/in.mp4',
      '/out.mp4',
      4,
      optimalSettings,
      false,
      () => {},
      embedding,
      null
    );
    expect(await done).toEqual({
      code: 1,
      stderr: 'BODY_TIMING_UNREADABLE',
      cancelled: false,
      spawnErrorCode: null
    });
  });
});
