/**
 * What the catalog manager's snapshot says about a row beyond its round (072, П5;
 * migration 20261224230000): the freshest sign that its work is moving, when a waiting round is
 * tried again, since when its last error stands, and which Drive folder the catalog belongs to.
 *
 * Every field is advisory. An older server sends none of them and the row falls back to what it
 * read before; a malformed value is dropped, never the row.
 */
export interface CatalogDriveConnectionInfo {
  /** The state of the Drive connection the catalog's sheet was found through. */
  state: string;
  /** That connection's folder. */
  folderName?: string;
  /** For a detached connection: the folder the space uses now, if any. */
  spaceFolderName?: string;
}

export interface CatalogManagerRuntime {
  lastUpdateErrorAt?: string | null;
  /** A variant heartbeat, a stage report or a re-stitch job's progress — the latest of them. */
  workHeartbeatAt?: string | null;
  /** When a running round is tried next. */
  roundNextAttemptAt?: string | null;
  /** A worker holds the round right now. */
  roundWorkerLive?: boolean;
  driveConnection?: CatalogDriveConnectionInfo | null;
}

const date = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : undefined;

function connectionFrom(value: unknown): CatalogDriveConnectionInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const state = text(row.state);
  if (!state || !/^[a-z_]{1,32}$/u.test(state)) return null;
  const folderName = text(row.folderName);
  const spaceFolderName = text(row.spaceFolderName);
  return {
    state,
    ...(folderName ? { folderName } : {}),
    ...(spaceFolderName ? { spaceFolderName } : {})
  };
}

/**
 * The runtime fields of one snapshot row. A server that knows them always sends
 * `drive_connection` for a catalog with a sheet, so its presence tells a new server's «no sign
 * of life» (null) from an old server's silence (undefined).
 */
export function parseCatalogManagerRuntime(row: Record<string, unknown>): CatalogManagerRuntime {
  if (!Object.prototype.hasOwnProperty.call(row, 'drive_connection')) return {};
  return {
    lastUpdateErrorAt: date(row.last_update_error_at),
    workHeartbeatAt: date(row.work_heartbeat_at),
    roundNextAttemptAt: date(row.round_next_attempt_at),
    roundWorkerLive: row.round_worker_live === true,
    driveConnection: connectionFrom(row.drive_connection)
  };
}
