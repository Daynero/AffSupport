import { describe, expect, it } from 'vitest';
import {
  RESTITCH_DETECTOR_VERSION,
  parseMaterialRestitchPrep,
  parseRestitchDrawResult,
  parseRestitchScreens,
  parseRestitchSourcesListing,
  parseTeamRestitchDefaults,
  parseTeamRestitchPrepareProgress,
  restitchDefaultsSaveable,
  usablePrep,
  type MaterialRestitchPrep
} from '../packages/shared/src/team/restitch.js';
import {
  STITCH_END_DURATION_MAX_SECONDS,
  STITCH_END_DURATION_MIN_SECONDS
} from '../packages/shared/src/stitcher.js';

/**
 * The contract a space's re-stitching settings live by.
 *
 * Two things are worth proving here and nowhere else: that "could this produce a file?" is one
 * predicate rather than one per screen, and that everything arriving from Postgres or from a
 * member's agent is narrowed rather than trusted. The permissions and the SQL refusals are
 * proved next door in `supabase/tests/database/team-restitch.test.sql`, against a real database
 * — asserting them twice would only mean asserting the mock twice.
 */

const profile = {
  path: '/tmp/creative.mp4',
  sizeBytes: 1_000,
  modifiedAtMs: 1_700_000_000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 40,
  width: 1080,
  height: 1080,
  pixelFormat: 'yuv420p',
  colorRange: 'tv',
  frameRate: 30,
  variableFrameRate: false,
  videoTimescale: 15360,
  durationSeconds: 123.7,
  hasAudio: true,
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: 2,
  audioBitrateKbps: 96,
  keyframeTimes: [0, 8.3]
};

const wireDefaults = {
  operation: 'restitch',
  startImageIds: ['a'],
  endImageIds: ['b'],
  fitMode: 'cover',
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: 2700,
  configured: true,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: 'someone'
};

describe('what a space may save', () => {
  it('needs somewhere to draw a photo from, unless it is removing the stitching', () => {
    const none = { startImageIds: [], endImageIds: [] };
    expect(restitchDefaultsSaveable({ operation: 'restitch', ...none })).toBe(false);
    expect(restitchDefaultsSaveable({ operation: 'stitch', ...none })).toBe(false);
    // Removing screens needs no photograph, so an empty library is not an obstacle.
    expect(restitchDefaultsSaveable({ operation: 'unstitch', ...none })).toBe(true);
  });

  it('accepts one pool or the other, not only both', () => {
    expect(
      restitchDefaultsSaveable({ operation: 'restitch', startImageIds: ['a'], endImageIds: [] })
    ).toBe(true);
    expect(
      restitchDefaultsSaveable({ operation: 'restitch', startImageIds: [], endImageIds: ['b'] })
    ).toBe(true);
  });
});

describe('a space’s defaults off the wire', () => {
  it('round-trips a set somebody actually saved', () => {
    const parsed = parseTeamRestitchDefaults(wireDefaults);
    if (!parsed.ok) throw new Error(`fixture should parse: ${parsed.error}`);
    expect(parsed.value).toMatchObject({
      operation: 'restitch',
      startImageIds: ['a'],
      endImageIds: ['b'],
      fitMode: 'cover',
      finalDurationMode: 'random-30-40',
      configured: true
    });
  });

  it('clamps the hold length instead of refusing it', () => {
    const long = parseTeamRestitchDefaults({
      ...wireDefaults,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 999_999
    });
    const short = parseTeamRestitchDefaults({
      ...wireDefaults,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: -5
    });
    expect(long.ok && long.value.customFinalDurationSeconds).toBe(STITCH_END_DURATION_MAX_SECONDS);
    expect(short.ok && short.value.customFinalDurationSeconds).toBe(
      STITCH_END_DURATION_MIN_SECONDS
    );
  });

  it('never reports a set as configured when it could not produce a file', () => {
    // A row can claim anything; the predicate decides. Otherwise a space edited around the
    // interface would offer a download that cannot run.
    const lying = parseTeamRestitchDefaults({
      ...wireDefaults,
      startImageIds: [],
      endImageIds: [],
      configured: true
    });
    expect(lying.ok && lying.value.configured).toBe(false);
  });

  it('falls back rather than failing on a value it does not recognise', () => {
    // An older build, or a drifted enum: a space must still be able to open its own settings.
    const odd = parseTeamRestitchDefaults({ ...wireDefaults, operation: 'nonsense', fitMode: 42 });
    expect(odd.ok).toBe(true);
    expect(odd.ok && odd.value.operation).toBe('restitch');
    expect(odd.ok && odd.value.fitMode).toBe('cover');
  });

  it('refuses anything that is not an object at all', () => {
    for (const value of [null, 'defaults', 7, []]) {
      expect(parseTeamRestitchDefaults(value).ok).toBe(false);
    }
  });
});

describe('what a run already knows about a material', () => {
  const wirePrep = {
    materialId: 'material-1',
    driveVersion: '7',
    detectorVersion: RESTITCH_DETECTOR_VERSION,
    detectedStartSeconds: 0.033,
    detectedEndSeconds: 1800,
    profile,
    unsupportedReason: null,
    preparedAt: '2026-09-02T00:00:00.000Z'
  };

  it('round-trips a record and its profile', () => {
    const parsed = parseMaterialRestitchPrep(wirePrep);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.profile?.keyframeTimes).toEqual([0, 8.3]);
  });

  it('is strict where the defaults are lenient', () => {
    // A wrong preparation produces a wrong file, so anything doubtful is treated as absent
    // rather than repaired.
    expect(parseMaterialRestitchPrep({ ...wirePrep, driveVersion: '' }).ok).toBe(false);
    expect(parseMaterialRestitchPrep({ ...wirePrep, detectedEndSeconds: -1 }).ok).toBe(false);
    expect(parseMaterialRestitchPrep({ ...wirePrep, profile: { path: '/x' } }).ok).toBe(false);
  });

  it('is only usable while it still describes the file in front of us', () => {
    const prep = parseMaterialRestitchPrep(wirePrep);
    if (!prep.ok) throw new Error('fixture should parse');
    const value: MaterialRestitchPrep = prep.value;
    expect(usablePrep(value, '7')).toBe(value);
    // The material was replaced: not an error, simply nothing prepared.
    expect(usablePrep(value, '8')).toBeNull();
    expect(usablePrep(value, null)).toBeNull();
    expect(usablePrep(null, '7')).toBeNull();
    // And a record whose edges were found by a detector we have since fixed: the file is the
    // same, the reading of it is not.
    expect(usablePrep({ ...value, detectorVersion: 0 }, '7')).toBeNull();
  });
});

describe('a preparation run’s progress', () => {
  it('accepts the four states and nothing else', () => {
    for (const state of ['inspecting', 'prepared', 'unsupported', 'failed']) {
      expect(
        parseTeamRestitchPrepareProgress({ materialId: 'm', state, done: 1, total: 3 }).ok
      ).toBe(true);
    }
    expect(
      parseTeamRestitchPrepareProgress({ materialId: 'm', state: 'almost', done: 1, total: 3 }).ok
    ).toBe(false);
  });

  it('drops a record it cannot trust without losing the event', () => {
    // The event still says which material and where the run is; only the untrusted half goes.
    const parsed = parseTeamRestitchPrepareProgress({
      materialId: 'm',
      state: 'prepared',
      done: 2,
      total: 3,
      prep: { materialId: 'm', driveVersion: '' }
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.prep).toBeNull();
    expect(parsed.ok && parsed.value.done).toBe(2);
  });
});

describe('where a space’s pictures come from (030)', () => {
  const base = {
    operation: 'restitch',
    startImageIds: [],
    endImageIds: [],
    fitMode: 'cover',
    finalDurationMode: 'random-40-50',
    customFinalDurationSeconds: 2700,
    configured: true
  };

  it('reads a row written before the field existed as legacy', () => {
    const parsed = parseTeamRestitchDefaults({ ...base, startImageIds: ['a'] });
    expect(parsed.ok && parsed.value.sourceMode).toBe('legacy');
    expect(parseTeamRestitchDefaults({ ...base, sourceMode: 'drive' }).ok).toBe(true);
    const drive = parseTeamRestitchDefaults({ ...base, sourceMode: 'drive' });
    expect(drive.ok && drive.value.sourceMode).toBe('drive');
    const odd = parseTeamRestitchDefaults({ ...base, sourceMode: 'bucket' });
    expect(odd.ok && odd.value.sourceMode).toBe('legacy');
  });

  it('does not judge a drive-mode set by its empty id lists', () => {
    expect(restitchDefaultsSaveable({ ...base, sourceMode: 'drive' } as never)).toBe(true);
    expect(
      restitchDefaultsSaveable({
        ...base,
        sourceMode: 'drive',
        startEnabled: false,
        endEnabled: false
      } as never)
    ).toBe(false);
    const parsed = parseTeamRestitchDefaults({ ...base, sourceMode: 'drive' });
    expect(parsed.ok && parsed.value.configured).toBe(true);
    const legacy = parseTeamRestitchDefaults({ ...base, sourceMode: 'legacy' });
    expect(legacy.ok && legacy.value.configured).toBe(false);
  });
});

describe('the pool listing, off the wire (030)', () => {
  const source = {
    materialId: 'm1',
    driveFileId: null,
    kind: 'folder',
    name: 'Finals',
    availability: 'available',
    imageCount: 3,
    skipped: { format: 1, size: 0, animated: 2 }
  };
  const pool = { state: 'ready', overLimit: false, eligibleCount: 3, sources: [source] };

  it('accepts a full listing and defaults what it may', () => {
    const parsed = parseRestitchSourcesListing({
      sourceMode: 'drive',
      legacyImageCount: 0,
      pools: { start: pool, end: { state: 'empty', sources: [] } }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected a valid pool listing');
    expect(parsed.value.pools.start.sources[0]).toEqual(source);
    expect(parsed.value.pools.end).toEqual({
      state: 'empty',
      overLimit: false,
      eligibleCount: 0,
      sources: []
    });
  });

  it('refuses the whole listing when one source cannot be read', () => {
    expect(
      parseRestitchSourcesListing({
        sourceMode: 'drive',
        pools: {
          start: { ...pool, sources: [{ ...source, availability: 'somewhere' }] },
          end: pool
        }
      }).ok
    ).toBe(false);
    expect(parseRestitchSourcesListing({ pools: { start: pool } }).ok).toBe(false);
  });
});

describe('a draw and the screens a job carries (030)', () => {
  const drawn = {
    slot: 'start',
    materialId: 'm1',
    checksum: 'abc',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    sizeBytes: 100,
    driveVersion: '7'
  };
  const grant = {
    ticket: 't',
    purpose: 'download_range',
    expiresAt: '2026-10-08T00:00:00Z',
    maxRangeBytes: 1,
    maxUses: 2
  };

  it('parses a draw and defaults the pool states', () => {
    const parsed = parseRestitchDrawResult({
      sourceMode: 'drive',
      pool: { start: 'ready' },
      screens: [drawn]
    });
    expect(parsed.ok && parsed.value.pool).toEqual({ start: 'ready', end: 'empty' });
    expect(parsed.ok && parsed.value.screens[0]?.fileName).toBe('a.jpg');
  });

  it('refuses a draw with one bad screen and a screen with a bad grant', () => {
    expect(
      parseRestitchDrawResult({ screens: [drawn, { ...drawn, mimeType: 'image/gif' }] }).ok
    ).toBe(false);
    expect(parseRestitchScreens([{ ...drawn, transfer: { transferUrl: 'u', grant } }]).ok).toBe(
      true
    );
    expect(parseRestitchScreens([{ ...drawn, transfer: { transferUrl: 'u' } }]).ok).toBe(false);
    expect(
      parseRestitchScreens([
        { ...drawn, transfer: null },
        { ...drawn, slot: 'top' }
      ]).ok
    ).toBe(false);
  });

  it('reads no screens as the legacy path, not as an error', () => {
    expect(parseRestitchScreens(undefined)).toEqual({ ok: true, value: null });
    expect(parseRestitchScreens(null)).toEqual({ ok: true, value: null });
    expect(parseRestitchScreens('nope').ok).toBe(false);
  });
});
