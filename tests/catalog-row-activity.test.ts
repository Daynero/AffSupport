import { describe, expect, it } from 'vitest';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';
import { parseCatalogManagerRuntime } from '../apps/web/src/api/catalog-manager-runtime';
import {
  LIVE_WINDOW_MS,
  catalogDriveStanding,
  catalogRowActivity
} from '../apps/web/src/team/catalog-updater/catalogRowActivity';
import { needsAttention } from '../apps/web/src/team/catalog-updater/catalogRowState';

/**
 * 072 П5: one answer for what a catalog row is doing — the stop button, the lock on its settings,
 * the bar and whether the bar moves. The owner saw «run» beside work still under way.
 */

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SET = '72000000-0000-4000-8000-000000000101';

function row(patch: Partial<CatalogRegistryRow> = {}): CatalogRegistryRow {
  return {
    catalogId: '72000000-0000-4000-8000-000000000001',
    name: 'polo_v1_catalog',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit',
    videoId: '72000000-0000-4000-8000-000000000002',
    videoName: 'polo.mp4',
    folderName: null,
    productCount: 4,
    createdAt: ago(86_400_000),
    lastUpdatedAt: null,
    updateCount: 0,
    inUpdater: false,
    lastUpdateError: null,
    updateInterval: null,
    nextRunAt: null,
    updatePending: false,
    updateStage: null,
    activeRoundAt: null,
    activeAttemptId: null,
    progressAttemptId: null,
    restitchOperationId: null,
    restitchProgress: null,
    restitchStage: null,
    folderDriveId: null,
    ...patch
  };
}

const round = (patch: Partial<CatalogRegistryRow> = {}) =>
  row({
    updatePending: true,
    updateStage: 'preparing',
    activeRoundAt: ago(5 * 60_000),
    activeAttemptId: '72000000-0000-4000-8000-000000000003',
    // A current server: the runtime fields are there, null when nothing was seen.
    workHeartbeatAt: null,
    roundWorkerLive: false,
    roundNextAttemptAt: null,
    lastUpdateErrorAt: null,
    driveConnection: { state: 'connected', folderName: 'Root' },
    ...patch
  });

describe('catalogRowActivity', () => {
  it('an idle catalog has nothing to stop and nothing to lock', () => {
    expect(catalogRowActivity(row(), NOW)).toMatchObject({ active: false, stop: null });
  });

  it('a round is stopped from the row; with a fresh sign of life its bar moves', () => {
    const activity = catalogRowActivity(round({ workHeartbeatAt: ago(30_000) }), NOW);
    expect(activity).toMatchObject({ active: true, stop: 'round', motion: 'live', code: null });
    expect(catalogRowActivity(round({ roundWorkerLive: true }), NOW).motion).toBe('live');
  });

  it('a sign of life older than the window is a still bar, with the next try when known', () => {
    const stale = round({
      workHeartbeatAt: ago(LIVE_WINDOW_MS + 1),
      roundNextAttemptAt: new Date(NOW + 60_000).toISOString()
    });
    expect(catalogRowActivity(stale, NOW)).toMatchObject({
      motion: 'waiting',
      retryAt: new Date(NOW + 60_000).toISOString()
    });
    // A time already past is not offered as «next try».
    expect(
      catalogRowActivity(round({ roundNextAttemptAt: ago(1000) }), NOW).retryAt
    ).toBeNull();
  });

  // Root cause of «still updating, but the button says run»: work outside the round.
  it('videos made outside a round show Stop (not run), which only says why it cannot stop', () => {
    const creating = row({
      videoGeneration: { setId: SET, requestedCount: 2, registeredCount: 0, state: 'preparing' }
    });
    expect(catalogRowActivity(creating, NOW)).toMatchObject({ active: true, stop: 'videos' });
  });

  it('the delivery check after a round is the same update and cannot be stopped', () => {
    const verifying = row({
      profile: {
        reconciliationRequired: true,
        lastResult: 'running'
      } as CatalogRegistryRow['profile']
    });
    expect(catalogRowActivity(verifying, NOW)).toMatchObject({
      active: true,
      stop: 'verifying',
      motion: 'live'
    });
  });

  it('an error written during this round stands in the row; an older one does not', () => {
    const failing = round({
      lastUpdateError: 'DRIVE_UNAVAILABLE',
      lastUpdateErrorAt: ago(60_000)
    });
    expect(catalogRowActivity(failing, NOW)).toMatchObject({
      motion: 'problem',
      code: 'DRIVE_UNAVAILABLE'
    });
    expect(needsAttention(failing, NOW)).toBe(true);
    const earlier = round({
      lastUpdateError: 'DRIVE_UNAVAILABLE',
      lastUpdateErrorAt: ago(60 * 60_000)
    });
    expect(catalogRowActivity(earlier, NOW).motion).toBe('waiting');
    expect(needsAttention(earlier, NOW)).toBe(false);
    // A worker trying again right now is live work, not a standing error.
    expect(catalogRowActivity({ ...failing, roundWorkerLive: true }, NOW).motion).toBe('live');
  });

  it('a wait reason, a stalled computer and a refused re-stitch hold whatever moved before', () => {
    const waiting = round({
      workHeartbeatAt: ago(10_000),
      videoGeneration: {
        setId: SET,
        requestedCount: 1,
        registeredCount: 0,
        state: 'accepted',
        waitReason: 'AGENT_REQUIRED'
      }
    });
    expect(catalogRowActivity(waiting, NOW)).toMatchObject({
      motion: 'problem',
      code: 'AGENT_REQUIRED'
    });
    const unknownCode = round({
      videoGeneration: {
        setId: SET,
        requestedCount: 1,
        registeredCount: 0,
        state: 'accepted',
        waitReason: 'SOMETHING_NEWER'
      }
    });
    expect(catalogRowActivity(unknownCode, NOW).code).toBe('SOMETHING_NEWER');
    const stalled = round({
      videoGeneration: {
        setId: SET,
        requestedCount: 1,
        registeredCount: 0,
        state: 'accepted',
        backgroundStalled: true
      }
    });
    expect(catalogRowActivity(stalled, NOW)).toMatchObject({
      motion: 'stalled',
      code: 'AGENT_STALLED'
    });
    const refused = round({
      updateStage: 'waiting_video',
      profile: {
        restitch: true,
        restitchStatus: 'blocked',
        restitchBlockedCode: 'RESTITCH_POOL_EMPTY'
      } as CatalogRegistryRow['profile']
    });
    expect(catalogRowActivity(refused, NOW)).toMatchObject({
      motion: 'problem',
      code: 'RESTITCH_POOL_EMPTY'
    });
  });

  it('an older server without the runtime fields falls back to the round’s own report', () => {
    const legacy = row({
      updatePending: true,
      activeRoundAt: ago(60_000),
      activeAttemptId: 'a',
      progressAttemptId: 'a'
    });
    expect(catalogRowActivity(legacy, NOW).motion).toBe('live');
    expect(catalogRowActivity({ ...legacy, progressAttemptId: null }, NOW).motion).toBe(
      'waiting'
    );
  });
});

describe('catalogDriveStanding', () => {
  it('a catalog of a folder the space no longer uses is not a «reconnect Drive» case', () => {
    expect(
      catalogDriveStanding(
        row({
          lastUpdateError: 'NEEDS_REAUTH',
          driveConnection: {
            state: 'detached',
            folderName: 'Old',
            spaceFolderName: 'New'
          }
        })
      )
    ).toBe('other_folder');
  });
  it('a Drive failure whose connection works again is offered a retry', () => {
    expect(
      catalogDriveStanding(
        row({ lastUpdateError: 'NEEDS_REAUTH', driveConnection: { state: 'connected' } })
      )
    ).toBe('restored');
    expect(
      catalogDriveStanding(
        row({ lastUpdateError: 'NEEDS_REAUTH', driveConnection: { state: 'needs_reauth' } })
      )
    ).toBe('reconnect');
    expect(catalogDriveStanding(row({ lastUpdateError: 'NEEDS_REAUTH' }))).toBeNull();
  });
});

describe('parseCatalogManagerRuntime', () => {
  it('an older server sends nothing and the row keeps its fallbacks', () => {
    expect(parseCatalogManagerRuntime({ catalog_id: 'x' })).toEqual({});
  });
  it('keeps what is well-formed and drops the rest', () => {
    expect(
      parseCatalogManagerRuntime({
        drive_connection: { state: 'detached', folderName: 'Old', spaceFolderName: 7 },
        work_heartbeat_at: 'not a date',
        round_next_attempt_at: '2026-11-25T12:01:00Z',
        round_worker_live: 'yes'
      })
    ).toEqual({
      lastUpdateErrorAt: null,
      workHeartbeatAt: null,
      roundNextAttemptAt: '2026-11-25T12:01:00Z',
      roundWorkerLive: false,
      driveConnection: { state: 'detached', folderName: 'Old' }
    });
    expect(
      parseCatalogManagerRuntime({ drive_connection: { state: 'Not A State' } }).driveConnection
    ).toBeNull();
  });
});
