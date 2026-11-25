import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TOOL_CONTRACTS,
  restitchBuiltinScreensSupported
} from '../packages/shared/src/release.js';
import {
  RESTITCH_BUILTIN_SCREENS,
  RESTITCH_DETECTOR_VERSION,
  type TeamRestitchDefaults
} from '../packages/shared/src/team/restitch.js';
import {
  builtinScreenBytes,
  builtinScreenId,
  builtinSlotsFor,
  withBuiltinSlots
} from '../apps/agent/src/team-bridge/builtin-screens.js';
import {
  createRestitchDelegate,
  drawnFinalDurationSeconds,
  screensFromResolved
} from '../apps/agent/src/team-bridge/restitch.js';
import { restitchPrepReport } from '../apps/agent/src/team-bridge/transfer.js';
import type { TeamProcessDelegateInput } from '../apps/agent/src/team-bridge/process.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * 071, the agent's half of «re-stitching works out of the box»: the agent carries Soty's
 * standard pictures byte for byte, renders them for the slots `builtin` names instead of the
 * compatibility fields the server writes for older agents, draws a space's own duration range,
 * and hands a background re-stitch's reading to the finalize.
 */

const defaults: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'cover',
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

/** What the server sends an agent for a space with no pictures of its own (20261224170000). */
const outOfTheBox: TeamRestitchDefaults = {
  ...defaults,
  startEnabled: false,
  automaticEndFrame: true,
  builtin: { version: 1, start: true, end: true }
};

const profile = (input: string) => ({
  path: input,
  sizeBytes: 1_000,
  modifiedAtMs: 1_700_000_000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 40,
  width: 1080,
  height: 1920,
  pixelFormat: 'yuv420p',
  colorRange: 'tv' as const,
  frameRate: 30,
  variableFrameRate: false,
  videoTimescale: 15360,
  durationSeconds: 120,
  hasAudio: true,
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: 2,
  audioBitrateKbps: 96,
  keyframeTimes: [0, 8.3]
});

describe('the standard pictures the agent carries', () => {
  it('are the web’s v1 files, byte for byte, and match the shared contract', async () => {
    for (const slot of ['start', 'end'] as const) {
      const web = await readFile(path.join('apps/web/public', RESTITCH_BUILTIN_SCREENS[slot].path));
      const carried = builtinScreenBytes(slot);
      expect(carried.equals(web)).toBe(true);
      expect(createHash('sha256').update(carried).digest('hex')).toBe(
        RESTITCH_BUILTIN_SCREENS[slot].sha256
      );
    }
  });

  it('is a capability of this agent', () => {
    expect(restitchBuiltinScreensSupported(AGENT_TOOL_CONTRACTS)).toBe(true);
    expect(
      restitchBuiltinScreensSupported({ ...AGENT_TOOL_CONTRACTS, teamRestitchBuiltinScreens: 0 })
    ).toBe(false);
  });

  it('undoes exactly the compatibility fields the server wrote, for the version it carries', () => {
    expect(withBuiltinSlots(outOfTheBox)).toMatchObject({ startEnabled: true, endEnabled: true });
    expect(withBuiltinSlots(outOfTheBox).automaticEndFrame).toBeUndefined();
    // Own start pictures beside a standard end: the server turned the end off.
    expect(
      withBuiltinSlots({
        ...defaults,
        endEnabled: false,
        builtin: { version: 1, start: false, end: true }
      })
    ).toMatchObject({ startEnabled: true, endEnabled: true });
    // A picture version this build does not carry keeps what older agents render.
    const newer = { ...outOfTheBox, builtin: { version: 2, start: true, end: true } };
    expect(builtinSlotsFor(newer)).toEqual({ start: false, end: false });
    expect(withBuiltinSlots(newer)).toBe(newer);
    // Unstitch draws nothing, and a launch's own automatic frame (no marker) stays.
    expect(builtinSlotsFor({ ...outOfTheBox, operation: 'unstitch' })).toEqual({
      start: false,
      end: false
    });
    const launch = { ...defaults, startEnabled: false, automaticEndFrame: true };
    expect(withBuiltinSlots(launch)).toBe(launch);
  });
});

describe('the delegate with standard pictures', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'restitch-builtin-'));
  });
  afterEach(async () => {
    await removeTemporaryDirectory(directory);
  });

  function input(options: unknown): TeamProcessDelegateInput {
    return {
      operationId: 'op-builtin',
      teamId: '30000000-0000-4000-8000-0000000000ee',
      workspace: directory,
      sourceFile: path.join(directory, 'source.mp4'),
      sourceSizeBytes: 1,
      sourceVersion: '7',
      sourceChecksum: null,
      options,
      signal: new AbortController().signal,
      onProgress: () => {},
      pausable: () => {}
    };
  }

  const prepared = {
    materialId: 'material-1',
    driveVersion: '7',
    detectorVersion: RESTITCH_DETECTOR_VERSION,
    detectedStartSeconds: 0,
    detectedEndSeconds: 0,
    profile: profile('/elsewhere/source.mp4'),
    unsupportedReason: null,
    preparedAt: '2026-11-25T00:00:00.000Z'
  };

  it('stitches Soty’s start and end pictures instead of skipping the start and reusing the last frame', async () => {
    const seen: { start: string | null; end: string | null; paths: (string | null)[] } = {
      start: null,
      end: null,
      paths: []
    };
    const pipeline = vi.fn(
      async (request: {
        request: { screens: { startImageId: string | null; endImageId: string | null } };
        imagePathFor: (id: string) => Promise<string | null>;
      }) => {
        seen.start = request.request.screens.startImageId;
        seen.end = request.request.screens.endImageId;
        for (const id of [seen.start, seen.end])
          seen.paths.push(id ? await request.imagePathFor(id) : null);
        return { ok: false as const, error: 'STITCH_CANCELLED' };
      }
    );
    const embedding = vi.fn(() => ({
      enabled: true,
      replaceExisting: true,
      startImages: [],
      endImages: [],
      disabledImageIds: [],
      startEnabled: true,
      endEnabled: true,
      fitMode: 'cover' as const,
      startDurationMode: 'one-frame' as const,
      customStartDurationMs: 100,
      finalDurationMode: 'custom' as const,
      customFinalDurationSeconds: 60
    }));
    const delegate = createRestitchDelegate({
      embedding: embedding as never,
      imagePathFor: async () => null,
      pipeline: pipeline as never
    });
    // The pipeline answers «cancelled»: what is proved is what it was asked to stitch. Had the
    // automatic end frame run, ffmpeg would have been asked to read a file that does not exist.
    await expect(delegate(input({ defaults: outOfTheBox, prepared, screens: [] }))).rejects.toThrow(
      'PROCESS_CANCELED'
    );
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(seen.start).toBe(builtinScreenId('start'));
    expect(seen.end).toBe(builtinScreenId('end'));
    for (const [index, slot] of (['start', 'end'] as const).entries()) {
      const file = seen.paths[index]!;
      expect(path.dirname(file)).toBe(directory);
      expect(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
      ).toBe(RESTITCH_BUILTIN_SCREENS[slot].sha256);
    }
  });
});

describe('the space’s own duration range (071)', () => {
  const range = {
    ...defaults,
    finalDurationMode: 'random-centered' as const,
    customFinalDurationSeconds: 1980,
    finalDurationRangeSeconds: [900, 3000] as const
  };

  it('draws any whole second inside the range, as the server does', () => {
    expect(drawnFinalDurationSeconds(range, () => 0)).toBe(900);
    expect(drawnFinalDurationSeconds(range, () => 0.999999999)).toBe(3000);
    expect(drawnFinalDurationSeconds(range, () => 0.5)).toBe(1950);
    // Without a range the mode keeps its launch meaning; the stitcher's draw applies.
    expect(drawnFinalDurationSeconds({ finalDurationMode: 'random-centered' }, () => 0)).toBeNull();
    expect(drawnFinalDurationSeconds({ finalDurationMode: 'random-40-50' }, () => 0)).toBeNull();
  });

  it('reaches the screens a delivery stitches', () => {
    const screens = screensFromResolved(
      [{ slot: 'end', id: 'team:end', path: '/c/end.png' }],
      range,
      () => 0
    );
    // Not centre ± 5 minutes (1680), the person's own lower edge.
    expect(screens.endDurationSeconds).toBe(900);
  });
});

describe('a background re-stitch keeps what it read', () => {
  const discovered = {
    detectorVersion: RESTITCH_DETECTOR_VERSION,
    detectedStartSeconds: 0.5,
    detectedEndSeconds: 12,
    profile: profile('/tmp/source.bin')
  };

  it('carries the finding with the Drive version of the bytes it read', () => {
    expect(restitchPrepReport(discovered, 'v7')).toEqual({ ...discovered, driveVersion: 'v7' });
  });

  it('drops anything it cannot vouch for', () => {
    expect(restitchPrepReport(discovered, null)).toBeUndefined();
    expect(restitchPrepReport(undefined, 'v7')).toBeUndefined();
    expect(restitchPrepReport({ ...discovered, detectorVersion: 0 }, 'v7')).toBeUndefined();
    expect(restitchPrepReport({ ...discovered, detectedEndSeconds: -1 }, 'v7')).toBeUndefined();
    expect(restitchPrepReport({ ...discovered, profile: null }, 'v7')).toBeUndefined();
  });
});
