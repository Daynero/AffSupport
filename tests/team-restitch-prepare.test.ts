import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usablePrep, type MaterialRestitchPrep } from '../packages/shared/src/team/restitch.js';
import {
  resolveWorkspaceFolder,
  WORKSPACE_FOLDER_MARK
} from '../supabase/functions/drive-ops/workspace-folder.js';
import { RestitchPrepareBridge } from '../apps/agent/src/team-bridge/restitch-prepare.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * Preparation: the button that makes the ten seconds possible.
 *
 * Two promises are tested here. The first is that looking at a space's videos happens once and
 * the answers survive — including the answer "this one cannot be served", which is worth as
 * much as any other. The second is that the space's folder is found by the mark this
 * application wrote on it and never by its name, so a member may rename or move it freely.
 */

const probeSource = vi.hoisted(() => vi.fn());
const detectStitching = vi.hoisted(() => vi.fn());
const ensureSilenceBank = vi.hoisted(() => vi.fn());

vi.mock('../apps/agent/src/stitcher/probe.js', () => ({ probeSource }));
vi.mock('../apps/agent/src/stitcher/plan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/plan.js')>();
  return { ...actual, detectStitching };
});
vi.mock('../apps/agent/src/stitcher/silence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/silence.js')>();
  return { ...actual, ensureSilenceBank };
});

let workspace = '';

const profile = (input: string) => ({
  path: input,
  sizeBytes: 1_000,
  modifiedAtMs: 1_700_000_000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 40,
  width: 1080,
  height: 1080,
  pixelFormat: 'yuv420p',
  colorRange: 'tv' as const,
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
});

const grant = {
  ticket: 'ticket',
  purpose: 'download_range' as const,
  expiresAt: '2099-01-01T00:00:00.000Z',
  maxRangeBytes: 1_000_000,
  maxUses: 8
};

function material(id: string) {
  return { materialId: id, driveVersion: '7', fileName: `${id}.mp4`, transferGrant: grant };
}

/** A transfer that writes a believable local copy and remembers being cleaned up. */
function transfer(cleaned: string[]) {
  return {
    downloadSource: vi.fn(async (request: { operationId: string }) => {
      const file = path.join(workspace, `${request.operationId.replaceAll(':', '_')}.mp4`);
      await writeFile(file, 'bytes');
      return {
        workspace,
        file,
        sizeBytes: 5,
        sourceVersion: '7',
        sourceChecksum: null,
        cleanup: async () => {
          cleaned.push(file);
        }
      };
    })
  };
}

/** Runs until the bridge says it is no longer running, or the wait is plainly wrong. */
async function settle(bridge: RestitchPrepareBridge, operationId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const report = bridge.report(operationId);
    if (report && report.state !== 'running') return report;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('preparation never finished');
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'restitch-prepare-'));
  probeSource.mockReset();
  detectStitching.mockReset();
  ensureSilenceBank.mockReset();
  ensureSilenceBank.mockResolvedValue({ ok: true, path: '/silence.aac' });
  probeSource.mockImplementation(async (input: string) => ({ ok: true, value: profile(input) }));
  detectStitching.mockResolvedValue({
    startSeconds: 0.033333,
    endSeconds: 1800,
    adjustedByUser: false
  });
});

afterEach(async () => {
  await removeTemporaryDirectory(workspace);
  vi.restoreAllMocks();
});

describe('preparing a space', () => {
  it('looks at every material once and hands back what it found', async () => {
    const cleaned: string[] = [];
    const bridge = new RestitchPrepareBridge({ transfer: transfer(cleaned) });
    bridge.start({
      operationId: 'prep-1',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a'), material('b')],
      audio: { sampleRate: 48000, channels: 2 }
    });

    const report = await settle(bridge, 'prep-1');
    expect(report.state).toBe('finished');
    expect(report.done).toBe(2);
    expect(report.findings.map(finding => finding.state)).toEqual(['prepared', 'prepared']);
    expect(report.findings[0]?.prep).toMatchObject({
      materialId: 'a',
      driveVersion: '7',
      detectedStartSeconds: 0.033333,
      detectedEndSeconds: 1800
    });
    // Every copy it made to read is gone again: the material is on the drive, not here.
    expect(cleaned).toHaveLength(2);
  });

  it('builds the shared silence once, before any material', async () => {
    const bridge = new RestitchPrepareBridge({ transfer: transfer([]) });
    bridge.start({
      operationId: 'prep-2',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a'), material('b'), material('c')],
      audio: { sampleRate: 48000, channels: 2 }
    });
    await settle(bridge, 'prep-2');
    // The eleven to nineteen seconds it costs are paid here rather than inside the first
    // download somebody is waiting on.
    expect(ensureSilenceBank).toHaveBeenCalledTimes(1);
  });

  it('inspects one material at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    probeSource.mockImplementation(async (input: string) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      concurrent -= 1;
      return { ok: true, value: profile(input) };
    });
    const bridge = new RestitchPrepareBridge({ transfer: transfer([]) });
    bridge.start({
      operationId: 'prep-3',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a'), material('b'), material('c')],
      audio: null
    });
    await settle(bridge, 'prep-3');
    // The power governor assumes one heavy process; three at once would be three fighting.
    expect(peak).toBe(1);
  });

  it('records that a material cannot be served, rather than dropping it', async () => {
    probeSource.mockImplementation(async (input: string) => ({
      ok: true,
      value: { ...profile(input), videoCodec: 'hevc' }
    }));
    const bridge = new RestitchPrepareBridge({ transfer: transfer([]) });
    bridge.start({
      operationId: 'prep-4',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a')],
      audio: null
    });
    const report = await settle(bridge, 'prep-4');
    expect(report.findings[0]?.state).toBe('unsupported');
    // Stored with a reason and no profile: there is nothing to cut, and knowing that is what
    // stops the answer being worked out again on every download.
    expect(report.findings[0]?.prep).toMatchObject({
      profile: null,
      unsupportedReason: 'video-codec'
    });
    expect(detectStitching).not.toHaveBeenCalled();
  });

  it('keeps what it already found when it is stopped', async () => {
    probeSource.mockImplementation(async (input: string) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ok: true, value: profile(input) };
    });
    const bridge = new RestitchPrepareBridge({ transfer: transfer([]) });
    bridge.start({
      operationId: 'prep-5',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a'), material('b'), material('c')],
      audio: null
    });
    // Long enough for the first to land, nowhere near long enough for all three.
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(bridge.cancel('prep-5')).toBe(true);

    const report = await settle(bridge, 'prep-5');
    expect(report.state).toBe('canceled');
    expect(report.done).toBeGreaterThanOrEqual(1);
    expect(report.done).toBeLessThan(3);
    // A stop is a stop, not an undo (FR-020).
    expect(report.findings.filter(finding => finding.state === 'prepared').length).toBe(
      report.done
    );
  });

  it('refuses a second run under the same name while one is going', async () => {
    const bridge = new RestitchPrepareBridge({ transfer: transfer([]) });
    const request = {
      operationId: 'prep-6',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a')],
      audio: null
    };
    bridge.start(request);
    expect(() => bridge.start(request)).toThrow('WRONG_STATE');
    await settle(bridge, 'prep-6');
  });

  it('publishes how far along it is, and nothing about the files', async () => {
    const update = vi.fn();
    const bridge = new RestitchPrepareBridge({
      transfer: transfer([]),
      events: { update } as never
    });
    bridge.start({
      operationId: 'prep-7',
      teamId: 'team',
      transferUrl: 'https://transfer.example',
      materials: [material('a')],
      audio: null
    });
    await settle(bridge, 'prep-7');
    const published = JSON.stringify(update.mock.calls);
    expect(update).toHaveBeenCalled();
    // The channel is a broadcast: a file's name has no business on it.
    expect(published).not.toContain('a.mp4');
    expect(published).toContain('"progress"');
  });
});

describe('a preparation stops being true', () => {
  const prepared: MaterialRestitchPrep = {
    materialId: 'a',
    driveVersion: '7',
    detectedStartSeconds: 0.033333,
    detectedEndSeconds: 1800,
    profile: profile('/wherever/it/was.mp4'),
    unsupportedReason: null,
    preparedAt: '2026-09-02T00:00:00.000Z'
  };

  it('when the file behind it is replaced', () => {
    expect(usablePrep(prepared, '7')).not.toBeNull();
    // A record describes a file's bytes, so it is true exactly as long as those bytes are.
    expect(usablePrep(prepared, '8')).toBeNull();
  });

  it('but not when the space changes what it draws', () => {
    // The photos, the fit, the hold length and the operation are all daily choices, and none
    // of them changes what was found inside the file — so none of them is in the record, and
    // changing any of them cannot invalidate it (FR-006).
    expect(Object.keys(prepared)).toEqual([
      'materialId',
      'driveVersion',
      'detectedStartSeconds',
      'detectedEndSeconds',
      'profile',
      'unsupportedReason',
      'preparedAt'
    ]);
    expect(usablePrep(prepared, '7')).not.toBeNull();
  });
});

describe('the space folder', () => {
  const folder = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'folder-1',
    name: 'Soty',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {},
    size: null,
    modifiedAt: null,
    version: null,
    checksum: null,
    appProperties: { [WORKSPACE_FOLDER_MARK]: 'team-1' },
    ...over
  });

  function drive(over: Record<string, unknown> = {}) {
    return {
      getFile: vi.fn(async () => folder()),
      findFolderByAppProperty: vi.fn(async () => null),
      createFolder: vi.fn(async () => folder({ id: 'folder-new' })),
      ...over
    } as never;
  }

  it('is created once, and never asked of a member', async () => {
    const client = drive();
    const resolved = await resolveWorkspaceFolder({
      teamId: 'team-1',
      rootFolderId: 'root',
      drive: client,
      cachedFolderId: null
    });
    expect(resolved).toMatchObject({ folderId: 'folder-new', created: true, name: 'Soty' });
    // The mark goes on at creation; everything afterwards depends on it.
    expect(client.createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ appProperties: { [WORKSPACE_FOLDER_MARK]: 'team-1' } })
    );
  });

  it('is still the same folder after somebody renames it', async () => {
    const client = drive({ getFile: vi.fn(async () => folder({ name: 'Матеріали' })) });
    const resolved = await resolveWorkspaceFolder({
      teamId: 'team-1',
      rootFolderId: 'root',
      drive: client,
      cachedFolderId: 'folder-1'
    });
    // The name is never the identity, so a rename costs nothing and creates nothing.
    expect(resolved).toMatchObject({ folderId: 'folder-1', created: false });
    expect(client.createFolder).not.toHaveBeenCalled();
    expect(client.findFolderByAppProperty).not.toHaveBeenCalled();
  });

  it('is still the same folder after somebody moves it', async () => {
    const client = drive({ getFile: vi.fn(async () => folder({ parents: ['somewhere-else'] })) });
    const resolved = await resolveWorkspaceFolder({
      teamId: 'team-1',
      rootFolderId: 'root',
      drive: client,
      cachedFolderId: 'folder-1'
    });
    expect(resolved).toMatchObject({ folderId: 'folder-1', created: false });
    expect(client.createFolder).not.toHaveBeenCalled();
  });

  it('is found by its mark when the id we remembered is stale', async () => {
    const client = drive({
      getFile: vi.fn(async () => folder({ trashed: true })),
      findFolderByAppProperty: vi.fn(async () => folder({ id: 'folder-2', name: 'Soty (1)' }))
    });
    const resolved = await resolveWorkspaceFolder({
      teamId: 'team-1',
      rootFolderId: 'root',
      drive: client,
      cachedFolderId: 'folder-1'
    });
    expect(resolved).toMatchObject({ folderId: 'folder-2', created: false });
    // Found rather than made: a second Soty folder beside the first would be the one thing
    // a member would notice and not understand.
    expect(client.createFolder).not.toHaveBeenCalled();
  });

  it('ignores a folder carrying another space’s mark', async () => {
    const client = drive({
      getFile: vi.fn(async () => folder({ appProperties: { [WORKSPACE_FOLDER_MARK]: 'team-2' } }))
    });
    const resolved = await resolveWorkspaceFolder({
      teamId: 'team-1',
      rootFolderId: 'root',
      drive: client,
      cachedFolderId: 'folder-1'
    });
    expect(resolved).toMatchObject({ folderId: 'folder-new', created: true });
  });
});
