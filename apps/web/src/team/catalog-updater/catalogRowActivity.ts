import type { CatalogRegistryRow } from '../../api/team';

/**
 * What a catalog in the manager is doing right now, in one answer (072, П5).
 *
 * The row's stop button used to follow only the round (`updatePending`), while its progress and
 * its words also followed the delivery check after the round and every video set of the catalog.
 * A catalog whose first videos were still being made, or whose table was being checked, showed
 * work in progress beside a «run» button (owner, 2026-11-25). Everything the row shows about work
 * — the button, the lock on its settings, the bar and whether the bar moves — reads this.
 */

/** What «Stop» would stop. Only a round can be stopped from the row. */
export type CatalogStopKind =
  /** The update round: the server cancels it. */
  | 'round'
  /** The check that the table took the changes: seconds long, nothing to stop. */
  | 'verifying'
  /** Videos made outside a round (the catalog's first videos, a scheduled link): not from here. */
  | 'videos';

/**
 * How the work stands. `live` is the only one that moves on screen: the server saw it move within
 * {@link LIVE_WINDOW_MS}. `waiting` is queued or between tries; `stalled` and `problem` need a
 * person, and the row says why with a way to fix it.
 */
export type CatalogWorkMotion = 'live' | 'waiting' | 'stalled' | 'problem';

export interface CatalogRowActivity {
  active: boolean;
  stop: CatalogStopKind | null;
  motion: CatalogWorkMotion | null;
  /** The code behind `problem` / `stalled`, when there is one. */
  code: string | null;
  /** When a waiting round is tried next, if the server said and it is still ahead. */
  retryAt: string | null;
}

/** Profile options configure the next run; the current stage belongs to the accepted run. */
export function needsVideo(row: CatalogRegistryRow) {
  if (row.updatePending && row.updateStage) {
    return row.updateStage === 'waiting_video' || row.updateStage === 'restitching';
  }
  return Boolean(row.profile?.restitch);
}

/** Four heartbeats of background work (30 s each) or a couple of stage reports. */
export const LIVE_WINDOW_MS = 2 * 60_000;

const IDLE: CatalogRowActivity = {
  active: false,
  stop: null,
  motion: null,
  code: null,
  retryAt: null
};

const VIDEO_WORK = ['accepted', 'preparing', 'cancel_requested'];

/** The delivery check that follows a round: the row reads it as the same update. */
export function catalogVerifying(row: CatalogRegistryRow): boolean {
  return Boolean(row.profile?.reconciliationRequired && row.profile.lastResult === 'running');
}

export function catalogRowActivity(
  row: CatalogRegistryRow,
  /** The server's clock now: the snapshot's observation time, or this browser's with its offset. */
  now: number
): CatalogRowActivity {
  // A round whose delivery could not be confirmed is a question for its history, not running work.
  if (row.profile?.reconciliationRequired && row.profile.lastResult !== 'running') return IDLE;
  const verifying = catalogVerifying(row);
  const generation = row.videoGeneration;
  const videos = Boolean(generation && VIDEO_WORK.includes(generation.state));
  if (!row.updatePending && !verifying && !videos) return IDLE;

  const stop: CatalogStopKind =
    row.updatePending && !row.profile?.reconciliationRequired
      ? 'round'
      : verifying || row.updatePending
        ? 'verifying'
        : 'videos';

  const nextTry = Date.parse(row.roundNextAttemptAt ?? '');
  const retryAt =
    row.updatePending && Number.isFinite(nextTry) && nextTry > now ? row.roundNextAttemptAt! : null;
  const result = (motion: CatalogWorkMotion, code: string | null = null): CatalogRowActivity => ({
    active: true,
    stop,
    motion,
    code,
    retryAt
  });

  // Definite reasons first: they hold until a person acts, whatever moved a minute ago.
  if (generation && videos) {
    if (generation.backgroundStalled)
      return result('stalled', generation.waitCode ?? generation.waitReason ?? 'AGENT_STALLED');
    // The raw code names it more exactly (a computer's own stop: DISK_FULL, …); the reason is
    // what every released web knows (072, П1).
    const waiting = generation.waitCode ?? generation.waitReason;
    if (waiting && generation.state === 'accepted') return result('problem', waiting);
  }
  if (
    row.updatePending &&
    needsVideo(row) &&
    row.profile?.restitchStatus === 'blocked' &&
    row.profile.restitchBlockedCode
  )
    return result('problem', row.profile.restitchBlockedCode);

  if (verifying || isMoving(row, now)) return result('live');

  // The round failed a try and waits for the next one: the error belongs to this round only if
  // it was written after the round began (it stays on the catalog until a success).
  const errorAt = Date.parse(row.lastUpdateErrorAt ?? '');
  const roundAt = Date.parse(row.activeRoundAt ?? '');
  if (
    row.updatePending &&
    row.lastUpdateError &&
    Number.isFinite(errorAt) &&
    Number.isFinite(roundAt) &&
    errorAt >= roundAt
  )
    return result('problem', row.lastUpdateError);
  return result('waiting');
}

function isMoving(row: CatalogRegistryRow, now: number): boolean {
  // A re-stitch job holds a live lease and reports progress (null when the lease lapsed).
  if (row.restitchOperationId) return true;
  if (row.workHeartbeatAt !== undefined || row.roundWorkerLive !== undefined) {
    const beat = Date.parse(row.workHeartbeatAt ?? '');
    return row.roundWorkerLive === true || (Number.isFinite(beat) && now - beat <= LIVE_WINDOW_MS);
  }
  // An older server: the round's own stage report under a live worker lease, or a video child.
  return Boolean(
    (row.activeAttemptId && row.progressAttemptId === row.activeAttemptId) ||
    (row.videoGeneration?.state === 'preparing' && row.videoGeneration.activeChildOperationId)
  );
}

/**
 * Why a catalog's settings cannot change now (072, П5), the same rule the server keeps
 * (patch_team_catalog_update_profile refuses while a round or a delivery check holds the catalog).
 */
export function catalogSettingsLock(
  row: CatalogRegistryRow,
  now: number
): 'running' | 'checking' | null {
  if (catalogRowActivity(row, now).active) return 'running';
  return row.profile?.reconciliationRequired ? 'checking' : null;
}

/** Drive codes a round ends with when the catalog's connection cannot be used. */
const DRIVE_CODES = new Set([
  'NEEDS_REAUTH',
  'ROOT_MISSING',
  'DRIVE_UNAVAILABLE',
  'CONNECTION_DETACHED'
]);

/**
 * Where the catalog stands with Drive, as far as its updates go:
 * - `other_folder` — the space moved to another folder; this catalog stays in the old one and no
 *   reconnecting reaches it;
 * - `reconnect` — the space's own connection needs signing in again (or its folder is gone);
 * - `restored` — the last update failed on Drive, and Drive works again: try once more;
 * - `null` — nothing about Drive to say.
 */
export type CatalogDriveStanding = 'other_folder' | 'reconnect' | 'restored' | null;

export function catalogDriveStanding(row: CatalogRegistryRow): CatalogDriveStanding {
  const state = row.driveConnection?.state;
  if (state === 'detached') return 'other_folder';
  if (state === 'needs_reauth' || state === 'root_missing') return 'reconnect';
  if (state === 'connected' && row.lastUpdateError && DRIVE_CODES.has(row.lastUpdateError))
    return 'restored';
  return null;
}
