import type { DriveFileMetadata } from '../../supabase/functions/_shared/drive';
import type { TeamTestDb } from '../support/team-db';

export function catalogFile(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: 'file',
    name: 'file.txt',
    mimeType: 'text/plain',
    parents: ['root'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: false,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    size: 10,
    modifiedAt: '2026-09-24T10:00:00Z',
    version: '1',
    checksum: null,
    appProperties: {},
    ...overrides
  };
}

/** Wire fixture intentionally differs from parsed metadata. */
export function providerFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file',
    name: 'file.txt',
    mimeType: 'text/plain',
    parents: ['root'],
    trashed: false,
    capabilities: { canDownload: true },
    version: '1',
    ...overrides
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function listingPages(count: number, pageSize = 100) {
  return Array.from({ length: Math.ceil(count / pageSize) }, (_, page) => ({
    files: Array.from({ length: Math.min(pageSize, count - page * pageSize) }, (_, i) =>
      providerFile({ id: `file-${page * pageSize + i}` })
    ),
    ...(page * pageSize + pageSize < count ? { nextPageToken: `page-${page + 1}` } : {})
  }));
}

/* ---------------------------------------------------------------------------
 * 028 — manual sync lifecycle fixtures.
 * ------------------------------------------------------------------------- */

/** The JSON body Drive returns with a non-2xx status. */
export function driveErrorBody(reason: string, location?: string, message = reason) {
  return {
    error: {
      code: 403,
      message,
      errors: [{ domain: 'global', reason, message, ...(location ? { location } : {}) }]
    }
  };
}

export const DRIVE_RATE_LIMIT_BODY = driveErrorBody('userRateLimitExceeded');
export const DRIVE_PERMISSION_BODY = driveErrorBody('insufficientFilePermissions');
export const DRIVE_PAGE_TOKEN_BODY = driveErrorBody('invalid', 'pageToken', 'Invalid Value');

/** A Drive shortcut: it points at another item and must never be walked as an ancestor. */
export function shortcutFile(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return catalogFile({
    id: 'shortcut',
    name: 'shortcut.lnk',
    mimeType: 'application/vnd.google-apps.shortcut',
    shortcutTargetId: 'elsewhere',
    ...overrides
  });
}

export type SyncScenario =
  | 'waiter-canonical-failed'
  | 'waiter-canonical-retry'
  | 'waiter-canonical-missing'
  | 'leased-expired'
  | 'detached';

export interface SeededSyncScenario {
  job: string;
  canonical: string | null;
}

/**
 * Seeds one lifecycle situation on a connection the caller already created.
 * A finite insert makes the trigger create a canonical job, which the scenario
 * then bends into the shape under test.
 */
export async function seedSyncScenario(
  db: TeamTestDb,
  connection: string,
  scenario: SyncScenario,
  options: { folder?: string; scanCompletedAgo?: string } = {}
): Promise<SeededSyncScenario> {
  const folder = options.folder ?? `folder-${scenario}`;
  const [job] = await db.root<{ id: string }>(
    `insert into private.catalog_sync_jobs
      (connection_id, job_kind, phase, cursor, folder_queue, requested_folder_id, next_attempt_at)
     values ($1, 'user_subtree', 'initial_scan', '{"changePageToken":"seed"}', $2::jsonb, $3,
       now() - interval '1 minute') returning id`,
    [connection, JSON.stringify([folder]), folder]
  );
  const [canonical] = await db.root<{ id: string }>(
    `select id from private.catalog_sync_jobs
     where connection_id = $1 and job_kind = 'incremental'
       and state in ('pending', 'leased', 'retry') order by created_at desc limit 1`,
    [connection]
  );
  const jobId = job!.id;
  const canonicalId = canonical?.id ?? null;
  const parkWaiter = async () => {
    // Before 028 the waiter had no scan_completed_at; the migration test seeds
    // through the older schema on purpose.
    const [column] = await db.root<{ present: boolean }>(
      `select exists (select 1 from information_schema.columns
        where table_schema = 'private' and table_name = 'catalog_sync_jobs'
          and column_name = 'scan_completed_at') as present`
    );
    await db.root(
      `update private.catalog_sync_jobs set state = 'pending', phase = 'change_replay',
        replay_after = 1, scan_initialized = true, updated_at = now() - $2::interval
        ${column?.present ? ', scan_completed_at = now() - $2::interval' : ''}
       where id = $1`,
      [jobId, options.scanCompletedAgo ?? '5 minutes']
    );
  };
  switch (scenario) {
    case 'waiter-canonical-failed':
      await parkWaiter();
      await db.root(
        `update private.catalog_sync_jobs set state = 'failed', last_error_code = 'PERMISSION_DENIED',
          completed_at = now() where id = $1`,
        [canonicalId]
      );
      break;
    case 'waiter-canonical-retry':
      await parkWaiter();
      await db.root(
        `update private.catalog_sync_jobs set state = 'retry', attempts = 3,
          last_error_code = 'DRIVE_UNAVAILABLE', next_attempt_at = now() + interval '14 minutes'
         where id = $1`,
        [canonicalId]
      );
      break;
    case 'waiter-canonical-missing':
      await parkWaiter();
      await db.root(
        `update private.catalog_sync_jobs set state = 'canceled', completed_at = now() where id = $1`,
        [canonicalId]
      );
      break;
    case 'leased-expired':
      await db.root(
        `update private.catalog_sync_jobs set state = 'leased', lease_owner = 'dead-worker',
          lease_epoch = 1, lease_expires_at = now() - interval '20 minutes',
          next_attempt_at = now() - interval '20 minutes' where id = $1`,
        [jobId]
      );
      await db.root(
        `update private.catalog_sync_authority set lease_epoch = 1 where connection_id = $1`,
        [connection]
      );
      break;
    case 'detached':
      await db.root(
        `update public.team_drive_connections set state = 'detached', detached_at = now()
         where id = $1`,
        [connection]
      );
      break;
  }
  return { job: jobId, canonical: canonicalId };
}
