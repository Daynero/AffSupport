import { query } from './db.js';

/**
 * 057 T061: the storage of R2 spaces (US9/US10, research.md R13) — the ledger, reservations, the
 * purge queue and its delay, the last daily reconciliation (orphans, missing objects), the
 * derivative backfill queue and the commit → signal delay — read through the SELECT-only
 * projection `public.analytics_space_storage` (20261226390000). Deleted spaces appear by their
 * tombstone until their bytes are gone. Before the projection exists the answer is
 * `unsupported`, never a row of zeros: a missing projection proves nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATEGORIES = ['materials', 'catalogs', 'process', 'attachments', 'versions', 'trash'];
const RECONCILIATION_STATES = ['running', 'done', 'failed'];
const LIMIT = 100;

export interface SpaceStorageRow {
  team_id: string;
  space_state: 'live' | 'deleted';
  pilot: boolean | null;
  ledger: {
    capacity_bytes: string;
    used_bytes: string;
    shared_bytes: string;
    reserved_bytes: string;
    counted_objects: number;
    live_objects: number;
    uncertain_reservations: number;
    used_by_category: Record<string, string>;
  } | null;
  purge: {
    due: number;
    in_flight: number;
    failed: number;
    oldest_due_at: string | null;
    deleted_7d: number;
    delete_delay_p95_s: number | null;
    delete_delay_max_s: number | null;
  } | null;
  reconciliation: {
    state: string;
    started_at: string;
    finished_at: string | null;
    listed: number;
    ledger: number;
    orphans_found: number;
    orphans_deleted: number;
    orphans_waiting: number;
    missing: number;
    foreign_keys: number;
    error: string | null;
  } | null;
  derivatives: { pending: number; failed: number; oldest_pending_at: string | null } | null;
  commit_signal: { commits_7d: number; p95_ms: number | null } | null;
  removal: {
    queued_at: string;
    finished_at: string | null;
    deleted_objects: number;
    error: string | null;
  } | null;
}

export interface SpaceStorageDiagnosis {
  status: 'ok' | 'unsupported';
  spaces: SpaceStorageRow[];
  findings: string[];
  blind_spots: string[];
}

const BLIND_SPOTS = [
  'Realtime delivery to a browser is not observable: the commit → signal delay is the server side only.',
  'Objects R2 lists but the ledger never had are orphans only after the daily reconciliation pass; between passes they are unknown.',
  'Unfinished multipart uploads are not listed by R2; the bucket lifecycle rule aborts them after a day.'
];

const count = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('space-storage: malformed count in projection');
  return parsed;
};
const bytes = (value: unknown): string => {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^-?\d{1,20}$/u.test(text))
    throw new Error('space-storage: malformed byte count in projection');
  return text;
};
const time = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : String(value));
  if (!Number.isFinite(parsed)) throw new Error('space-storage: malformed time in projection');
  return new Date(parsed).toISOString();
};
const decimal = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('space-storage: malformed number in projection');
  return parsed;
};
const code = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : /^[A-Z][A-Z0-9_]{0,95}$/u.test(String(value))
      ? String(value)
      : 'UNKNOWN';

async function hasProjection(): Promise<boolean> {
  const rows = await query<{ present: boolean }>(
    `select exists (select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'analytics_space_storage') as present`,
    []
  );
  return rows[0]?.present === true;
}

function categories(value: unknown): Record<string, string> {
  const object = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (object === null || object === undefined) return {};
  if (typeof object !== 'object' || Array.isArray(object))
    throw new Error('space-storage: malformed categories in projection');
  return Object.fromEntries(
    Object.entries(object as Record<string, unknown>)
      .filter(([category]) => CATEGORIES.includes(category))
      .map(([category, amount]) => [category, bytes(amount)])
  );
}

function row(raw: Record<string, unknown>): SpaceStorageRow {
  const teamId = String(raw.team_id ?? '');
  if (!UUID.test(teamId)) throw new Error('space-storage: malformed space id in projection');
  const state = raw.space_state === 'deleted' ? 'deleted' : 'live';
  if (state === 'deleted')
    return {
      team_id: teamId,
      space_state: 'deleted',
      pilot: null,
      ledger: null,
      purge: null,
      reconciliation: null,
      derivatives: null,
      commit_signal: null,
      removal: {
        queued_at: time(raw.removed_queued_at) ?? '',
        finished_at: time(raw.removed_finished_at),
        deleted_objects: count(raw.removed_deleted_objects ?? 0),
        error: code(raw.removed_error)
      }
    };
  const reconciliationState = raw.reconciliation_state;
  return {
    team_id: teamId,
    space_state: 'live',
    pilot: raw.pilot === true,
    ledger: {
      capacity_bytes: bytes(raw.capacity_bytes),
      used_bytes: bytes(raw.used_bytes),
      shared_bytes: bytes(raw.shared_bytes),
      reserved_bytes: bytes(raw.reserved_bytes),
      counted_objects: count(raw.counted_objects),
      live_objects: count(raw.live_objects),
      uncertain_reservations: count(raw.uncertain_reservations),
      used_by_category: categories(raw.used_by_category)
    },
    purge: {
      due: count(raw.purges_due),
      in_flight: count(raw.purges_in_flight),
      failed: count(raw.purges_failed),
      oldest_due_at: time(raw.oldest_due_at),
      deleted_7d: count(raw.purges_deleted_7d),
      delete_delay_p95_s: decimal(raw.delete_delay_p95_s),
      delete_delay_max_s: decimal(raw.delete_delay_max_s)
    },
    reconciliation:
      typeof reconciliationState === 'string'
        ? {
            state: RECONCILIATION_STATES.includes(reconciliationState)
              ? reconciliationState
              : 'unknown',
            started_at: time(raw.reconciliation_started_at) ?? '',
            finished_at: time(raw.reconciliation_finished_at),
            listed: count(raw.reconciliation_listed),
            ledger: count(raw.reconciliation_ledger),
            orphans_found: count(raw.orphans_found),
            orphans_deleted: count(raw.orphans_deleted),
            orphans_waiting: count(raw.orphans_waiting),
            missing: count(raw.missing_objects),
            foreign_keys: count(raw.foreign_keys),
            error: code(raw.reconciliation_error)
          }
        : null,
    derivatives: {
      pending: count(raw.derivative_jobs_pending),
      failed: count(raw.derivative_jobs_failed),
      oldest_pending_at: time(raw.derivative_oldest_pending_at)
    },
    commit_signal: {
      commits_7d: count(raw.commits_7d ?? 0),
      p95_ms: decimal(raw.commit_signal_p95_ms)
    },
    removal: null
  };
}

/** What a person on call should look at first, from the rows alone. */
function findings(spaces: readonly SpaceStorageRow[], asOf: number): string[] {
  const out: string[] = [];
  for (const space of spaces) {
    const id = space.team_id;
    if (space.removal && space.removal.finished_at === null)
      out.push(
        `${id}: deleted space still has bytes in R2 (${space.removal.deleted_objects} deleted so far${space.removal.error ? `, last error ${space.removal.error}` : ''})`
      );
    if (!space.ledger || !space.purge) continue;
    if (BigInt(space.ledger.used_bytes) > BigInt(space.ledger.capacity_bytes))
      out.push(`${id}: over capacity`);
    if (space.purge.failed > 0) out.push(`${id}: ${space.purge.failed} purge(s) gave up`);
    if (space.purge.oldest_due_at && asOf - Date.parse(space.purge.oldest_due_at) > 15 * 60_000)
      out.push(`${id}: a purge has been due for more than 15 minutes (SC-014)`);
    const reconciliation = space.reconciliation;
    if (!reconciliation) out.push(`${id}: never reconciled`);
    else {
      if (reconciliation.missing > 0)
        out.push(`${id}: ${reconciliation.missing} committed object(s) missing from R2`);
      if (
        reconciliation.orphans_found >
        reconciliation.orphans_deleted + reconciliation.orphans_waiting
      )
        out.push(`${id}: orphan(s) past their grace not yet deleted`);
      if (asOf - Date.parse(reconciliation.started_at) > 36 * 3600_000)
        out.push(`${id}: last reconciliation is older than a day and a half`);
    }
    if (space.ledger.uncertain_reservations > 0)
      out.push(
        `${id}: ${space.ledger.uncertain_reservations} reservation(s) wait for their multipart`
      );
  }
  return out;
}

export async function getSpaceStorageDiagnosis(
  id: string | null,
  asOf: string = new Date().toISOString()
): Promise<SpaceStorageDiagnosis> {
  if (!(await hasProjection()))
    return {
      status: 'unsupported',
      spaces: [],
      findings: [],
      blind_spots: [
        'The space storage projection (analytics_space_storage, 057) is not in this database: nothing about R2 spaces can be said, not even zero.',
        ...BLIND_SPOTS
      ]
    };
  if (id !== null && !UUID.test(id))
    return { status: 'ok', spaces: [], findings: [], blind_spots: BLIND_SPOTS };
  const rows = await query<Record<string, unknown>>(
    `select * from public.analytics_space_storage
      where ($1::uuid is null or team_id = $1::uuid)
      order by space_state desc, team_id limit ${LIMIT + 1}`,
    [id]
  );
  const spaces = rows.slice(0, LIMIT).map(row);
  return {
    status: 'ok',
    spaces,
    findings: findings(spaces, Date.parse(asOf)),
    blind_spots: [
      ...(rows.length > LIMIT ? [`Truncated at ${LIMIT} spaces; name one space to see it.`] : []),
      ...BLIND_SPOTS
    ]
  };
}
