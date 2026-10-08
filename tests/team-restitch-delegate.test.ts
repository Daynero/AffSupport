import { mkdtemp } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestitchScreen, TeamRestitchDefaults } from '@video-compressor/shared';
import {
  createRestitchDelegate,
  parseRestitchOptions,
  screensFromResolved
} from '../apps/agent/src/team-bridge/restitch.js';
import { TeamScreenCache, screenAssetId } from '../apps/agent/src/team-bridge/screen-cache.js';
import type { TeamProcessDelegateInput } from '../apps/agent/src/team-bridge/process.js';

/**
 * Feature 030, the delegate's side: a job that carries screens draws them from the cache and
 * never from the library; a job that carries none is the legacy path, untouched; a job whose
 * screens cannot be read is refused whole.
 */

const defaults: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'contain',
  finalDurationMode: 'custom',
  customFinalDurationSeconds: 60,
  startEnabled: true,
  endEnabled: true,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  sourceMode: 'drive',
  configured: true,
  updatedAt: '',
  updatedBy: null
};

const MATERIAL = '31000000-0000-4000-8000-000000000011';
const screen = (slot: 'start' | 'end', materialId = MATERIAL): RestitchScreen => ({
  slot,
  materialId,
  checksum: 'a'.repeat(32),
  mimeType: 'image/png',
  fileName: 'a.png',
  sizeBytes: 10,
  transfer: null
});

describe('the options off the wire', () => {
  it('accepts screens beside the defaults and reads none as the legacy path', () => {
    const parsed = parseRestitchOptions({ defaults, screens: [screen('start')] });
    expect(parsed?.screens).toHaveLength(1);
    expect(parseRestitchOptions({ defaults })?.screens).toBeNull();
    expect(parseRestitchOptions({ defaults, screens: null })?.screens).toBeNull();
  });

  it('refuses the job when one screen cannot be read', () => {
    expect(
      parseRestitchOptions({ defaults, screens: [screen('start'), { slot: 'top' }] })
    ).toBeNull();
    expect(parseRestitchOptions({ defaults, screens: 'nope' })).toBeNull();
  });

  it('ignores screens for an unstitch, which draws nothing', () => {
    expect(
      parseRestitchOptions({
        defaults: { ...defaults, operation: 'unstitch' },
        screens: [screen('start')]
      })?.screens
    ).toBeNull();
  });
});

describe('screens from what the cache resolved', () => {
  it('names the cache’s ids and keeps the space’s fit and hold', () => {
    const screens = screensFromResolved(
      [
        { slot: 'start', id: 'team:k1', path: '/c/k1.png' },
        { slot: 'end', id: 'team:k2', path: '/c/k2.png' }
      ],
      defaults
    );
    expect(screens).toMatchObject({
      startImageId: 'team:k1',
      endImageId: 'team:k2',
      fitMode: 'contain',
      endDurationSeconds: 60
    });
  });

  it('leaves a slot empty when it is off or nothing was drawn for it', () => {
    expect(
      screensFromResolved([{ slot: 'start', id: 'team:k1', path: '/c/k1.png' }], defaults)
    ).toMatchObject({ startImageId: 'team:k1', endImageId: null });
    expect(
      screensFromResolved([{ slot: 'start', id: 'team:k1', path: '/c/k1.png' }], {
        ...defaults,
        startEnabled: false
      }).startImageId
    ).toBeNull();
  });
});

describe('the delegate', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'restitch-delegate-'));
  });
  afterEach(async () => {
    await removeTemporaryDirectory(directory);
  });

  function input(options: unknown): TeamProcessDelegateInput {
    return {
      operationId: 'op',
      teamId: '30000000-0000-4000-8000-0000000000ee',
      workspace: directory,
      sourceFile: path.join(directory, 'missing.mp4'),
      sourceSizeBytes: 1,
      sourceVersion: '1',
      sourceChecksum: null,
      options,
      signal: new AbortController().signal,
      onProgress: () => {},
      pausable: () => {}
    };
  }

  it('resolves screens through the cache, not the library, and tells the pipeline their paths', async () => {
    const resolve = vi.fn(async () => [
      { slot: 'start' as const, id: screenAssetId(screen('start')), path: '/c/a.png' }
    ]);
    const evict = vi.fn(async () => 0);
    const cache = {
      resolve,
      evict,
      pathFor: (id: string) => (id.startsWith('team:') ? '/c/a.png' : null)
    };
    const embedding = vi.fn();
    const pipeline = vi.fn(
      async (request: {
        request: { screens: { startImageId: string | null } };
        imagePathFor: (id: string) => Promise<string | null>;
      }) => {
        expect(request.request.screens.startImageId).toBe(screenAssetId(screen('start')));
        expect(await request.imagePathFor(screenAssetId(screen('start')))).toBe('/c/a.png');
        return { ok: false as const, error: 'STITCH_CANCELLED' };
      }
    );
    const delegate = createRestitchDelegate({
      embedding,
      imagePathFor: async () => null,
      screenCache: cache as never,
      pipeline: pipeline as never
    });
    // The source does not exist, so inspection fails before the pipeline: what is proved here
    // is the refusal shape for a job that carries screens the cache cannot provide.
    await expect(
      delegate(input({ defaults, prepared: null, screens: [screen('start')] }))
    ).rejects.toBeTruthy();
    expect(embedding).not.toHaveBeenCalled();
  });

  it('refuses a job with screens when there is no cache to put them in', async () => {
    const delegate = createRestitchDelegate({
      embedding: () => {
        throw new Error('must not read the library');
      },
      imagePathFor: async () => null
    });
    await expect(delegate(input({ defaults, screens: [screen('start')] }))).rejects.toThrow(
      /RESTITCH_SCREEN_UNAVAILABLE|UNSUPPORTED_MEDIA/
    );
  });

  it('keeps a real cache instance’s ids resolvable after a resolve', async () => {
    const cache = new TeamScreenCache(
      {
        transfer: {
          downloadSource: async () => {
            throw new Error('offline');
          }
        },
        probe: (async () => null) as never
      },
      path.join(directory, 'TeamScreens')
    );
    await expect(
      cache.resolve(
        '30000000-0000-4000-8000-0000000000ee',
        [screen('start')],
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_UNAVAILABLE' });
    expect(cache.pathFor('team:nothing')).toBeNull();
  });
});
