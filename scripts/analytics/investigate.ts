/**
 * 033 — `journal` and `investigate`: everything the database knows about one user's problem,
 * in one read-only call (FR-005, FR-006).
 *
 * `investigate` resolves an email, installation, run, flow or attempt id to one user (or one
 * anonymous installation), reads that subject's events and agent journal records in the
 * period, rebuilds every failed, unfinished or cancelled operation through `inspect`, and turns
 * what it saw into ranked findings: facts it can prove, hypotheses it can cite, and
 * "insufficient" with the blind spot named when it can do neither. Every finding carries the
 * code locations of its fingerprint (`code-map.ts`) so the next step is a file to open.
 *
 * Every query is a single SELECT bounded by the period's end (`--as-of`): events by
 * `created_at`, journal records by `received_at`. The email is used to resolve the subject
 * and never leaves this module.
 */
import { createHash } from 'node:crypto';
import { lookupCodeLocations } from './code-map.js';
import { capabilityById } from './coverage-registry.js';
import { query, queryOne } from './db.js';
import { getInspect, getSyncJobs, isoUtc } from './queries.js';
import { eventColumnSql, getSchema, hasEnvelopeV3, schemaSummary } from './schema.js';
import { sanitizeEventProperties, type SanitizedProperties } from './sanitize.js';
import type {
  AnalyticsSchema,
  DeliveryLag,
  FindingSeverity,
  InspectFound,
  InvestigateBlindSpot,
  InvestigateData,
  InvestigateEnvironment,
  InvestigateErrorCluster,
  InvestigateFailureRef,
  InvestigateFinding,
  InvestigateFindingKind,
  InvestigateJournalWindow,
  InvestigateLink,
  InvestigateOperation,
  InvestigateSession,
  InvestigateSubject,
  InvestigateSubjectKind,
  InvestigateSyncSummary,
  JournalData,
  JournalResult,
  JournalRecordRow,
  ResolvedPeriod
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** How far around a failure the journal is read (FR-005). */
export const JOURNAL_WINDOW_MS = 2 * 60 * 1000;
/** Most events / journal records one investigation reads; the newest win. */
const EVENT_LIMIT = 5000;
const JOURNAL_LIMIT = 5000;
/** Most non-successful operations rebuilt through `inspect`. */
const OPERATION_LIMIT = 25;

/** A subject that could not be resolved; the CLI turns it into `{ ok: false }`. */
export class SubjectNotFoundError extends Error {}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

/** Text columns can come back as numbers from a driver that coerces digits; keep them text. */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function iso(value: unknown): string {
  const raw = text(value) ?? '';
  return isoUtc(raw) ?? raw;
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))].sort();
}

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Numeric dotted versions, compared segment by segment (`1.2.10` > `1.2.9`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(part => Number.parseInt(part, 10));
  const pb = b.split(/[.+-]/).map(part => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

function lagOf(values: number[]): DeliveryLag {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (fraction: number) => {
    if (sorted.length === 0) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
  };
  return { p50: at(0.5), p95: at(0.95), samples: sorted.length };
}

/* ---------------------------------------------------------------------------
 * Journal records
 * ------------------------------------------------------------------------- */

const PROP_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/**
 * The server fence of `ingest_agent_journal`, repeated: a stored record cannot carry a path, an
 * address or a credential, but the CLI checks again before printing it.
 */
export function sanitizeJournalProps(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(input as Record<string, unknown>).sort()) {
    if (!PROP_KEY.test(key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (
        value.length >= 1 &&
        value.length <= 64 &&
        !/[/\\@]/.test(value) &&
        !lowered.includes('://') &&
        !lowered.includes('token') &&
        !lowered.includes('bearer')
      ) {
        out[key] = value;
      }
    }
  }
  return out;
}

interface JournalDbRow {
  seq: number;
  category: string;
  code: string;
  props: unknown;
  agent_instance_id: string;
  installation_id: string | null;
  recorded_at: string;
  received_at: string;
}

const JOURNAL_COLUMNS = `j.seq, j.category, j.code, j.props, j.agent_instance_id::text as agent_instance_id,
  j.installation_id::text as installation_id, j.recorded_at::text as recorded_at,
  j.received_at::text as received_at`;

function toJournalRow(row: JournalDbRow): JournalRecordRow {
  const recorded = iso(row.recorded_at);
  const received = iso(row.received_at);
  const lag = Date.parse(received) - Date.parse(recorded);
  return {
    seq: Number(row.seq),
    category: String(row.category),
    code: String(row.code),
    props: sanitizeJournalProps(row.props),
    agent_instance_id: String(row.agent_instance_id),
    installation_id: text(row.installation_id),
    recorded_at: recorded,
    received_at: received,
    lag_ms: Number.isFinite(lag) ? lag : null
  };
}

function compareJournal(a: JournalRecordRow, b: JournalRecordRow): number {
  return (
    a.recorded_at.localeCompare(b.recorded_at) ||
    a.agent_instance_id.localeCompare(b.agent_instance_id) ||
    a.seq - b.seq
  );
}

async function userIdByEmail(email: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `select u.id::text as id from public.analytics_users u where u.email_normalized = lower($1) limit 1`,
    [email.trim()]
  );
  return row?.id ?? null;
}

/**
 * `journal <email | installation_id | agent_instance_id>` — the agent's journal records in the
 * period, oldest first (the newest `limit` of them when there are more).
 */
export async function getJournal(
  subject: string,
  period: ResolvedPeriod,
  limit = 200
): Promise<JournalResult> {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 200, 1), 5000);
  // Before migration 20261124100000 (or without a grant on it) there is no journal to read.
  if (!(await getSchema()).tables.agent_journal_records) {
    if (!EMAIL.test(subject) && !UUID.test(subject)) {
      throw new SubjectNotFoundError(
        'journal takes an email, an installation_id or an agent_instance_id (uuid).'
      );
    }
    return { available: false, reason: 'journal_table_missing', records: [] };
  }
  let kind: JournalData['subject']['kind'];
  let userId: string | null = null;
  let installationId: string | null = null;
  let instanceId: string | null = null;

  if (EMAIL.test(subject)) {
    userId = await userIdByEmail(subject);
    if (!userId) throw new SubjectNotFoundError('No user found for that email.');
    kind = 'user';
  } else if (UUID.test(subject)) {
    const match = await queryOne<{ instance: boolean; installation: boolean }>(
      `select
         exists (select 1 from public.agent_journal_records j where j.agent_instance_id = $1::uuid) as instance,
         exists (select 1 from public.agent_journal_records j where j.installation_id = $1::uuid) as installation`,
      [subject]
    );
    if (match?.instance) {
      kind = 'agent_instance';
      instanceId = subject;
    } else if (match?.installation) {
      kind = 'installation';
      installationId = subject;
    } else {
      throw new SubjectNotFoundError(
        `No agent journal record carries ${subject} as an installation or agent instance.`
      );
    }
  } else {
    throw new SubjectNotFoundError(
      'journal takes an email, an installation_id or an agent_instance_id (uuid).'
    );
  }

  const where = `(($3::uuid is not null and j.user_id = $3::uuid)
      or ($4::uuid is not null and j.installation_id = $4::uuid)
      or ($5::uuid is not null and j.agent_instance_id = $5::uuid))
    and ($1::timestamptz is null or j.recorded_at >= $1::timestamptz)
    and j.received_at <= $2::timestamptz`;
  const params = [period.start, period.end, userId, installationId, instanceId];
  const [count, rows] = await Promise.all([
    queryOne<{ total: number }>(
      `select count(*)::int as total from public.agent_journal_records j where ${where}`,
      params
    ),
    query<JournalDbRow>(
      `select ${JOURNAL_COLUMNS}
       from public.agent_journal_records j
       where ${where}
       order by j.recorded_at desc, j.agent_instance_id desc, j.seq desc
       limit $6`,
      [...params, bounded]
    )
  ]);
  const records = rows.map(toJournalRow).sort(compareJournal);
  const total = Number(count?.total ?? 0);
  return {
    available: true,
    subject: {
      kind,
      user_id: userId,
      installation_id: installationId,
      agent_instance_id: instanceId
    },
    records,
    total,
    truncated: total > records.length,
    lag_ms: lagOf(records.map(r => r.lag_ms ?? Number.NaN))
  };
}

/* ---------------------------------------------------------------------------
 * investigate — subject
 * ------------------------------------------------------------------------- */

interface Scope {
  kind: InvestigateSubjectKind;
  id: string | null;
  userId: string | null;
  installationId: string | null;
  /** The operation the caller named, when it was a run, flow or attempt. */
  focus: string | null;
}

async function resolveSubject(
  input: string,
  period: ResolvedPeriod,
  schema: AnalyticsSchema
): Promise<Scope> {
  const value = input.trim();
  if (EMAIL.test(value)) {
    const userId = await userIdByEmail(value);
    if (!userId) throw new SubjectNotFoundError('No user found for that email.');
    return { kind: 'user', id: null, userId, installationId: null, focus: null };
  }
  if (!OPAQUE_ID.test(value)) {
    throw new SubjectNotFoundError(
      'investigate takes an email, an installation_id, a run_id, a flow_id or an attempt_id.'
    );
  }
  const asUuid = UUID.test(value) ? value : null;
  const owner = async (predicate: string) =>
    queryOne<{ user_id: string | null; installation_id: string | null }>(
      `select e.user_id::text as user_id, e.installation_id::text as installation_id
       from public.analytics_events e
       where $1::text is not null and ${predicate} and e.created_at <= $3::timestamptz
       order by (e.user_id is null), e.occurred_at asc, e.id asc
       limit 1`,
      [value, asUuid, period.end]
    );

  if (asUuid) {
    const run = await owner(`(e.run_id = $2::uuid or e.properties ->> 'run_id' = $1::text)`);
    if (run) return scopeOf('run', value, run, value);
    const flow = await owner(`(e.flow_id = $2::uuid or e.properties ->> 'flow_id' = $1::text)`);
    if (flow) return scopeOf('flow', value, flow, value);
    const installation = await owner(`e.installation_id = $2::uuid`);
    if (installation) {
      return {
        kind: 'installation',
        id: value,
        userId: installation.user_id,
        installationId: value,
        focus: null
      };
    }
    const journal = schema.tables.agent_journal_records
      ? await queryOne<{ user_id: string | null }>(
          `select j.user_id::text as user_id from public.agent_journal_records j
           where j.installation_id = $1::uuid and j.received_at <= $2::timestamptz
           order by j.recorded_at asc limit 1`,
          [value, period.end]
        )
      : null;
    if (journal) {
      return {
        kind: 'installation',
        id: value,
        userId: journal.user_id,
        installationId: value,
        focus: null
      };
    }
    const user = await queryOne<{ id: string }>(
      `select u.id::text as id from public.analytics_users u where u.id = $1::uuid`,
      [value]
    );
    if (user)
      return { kind: 'user', id: value, userId: user.id, installationId: null, focus: null };
  } else {
    // `$2::uuid is null` (always true here) also gives Postgres the type of the unused $2.
    const attempt = await owner(
      `$2::uuid is null and (${eventColumnSql(schema).attemptId} = $1::text
        or e.properties ->> 'workflow_id' = $1::text)`
    );
    if (attempt) return scopeOf('attempt', value, attempt, value);
  }
  throw new SubjectNotFoundError(
    `Nothing matches ${value} as a user, installation, run, flow or attempt id.`
  );
}

function scopeOf(
  kind: InvestigateSubjectKind,
  id: string,
  row: { user_id: string | null; installation_id: string | null },
  focus: string
): Scope {
  return {
    kind,
    id,
    userId: row.user_id,
    installationId: row.user_id ? null : row.installation_id,
    focus
  };
}

/* ---------------------------------------------------------------------------
 * investigate — reads
 * ------------------------------------------------------------------------- */

interface EventRow {
  row_id: number;
  event_id: string | null;
  occurred_at: string;
  created_at: string;
  session_id: string | null;
  session_sequence: number | null;
  installation_id: string | null;
  flow_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  workflow_id: string | null;
  event_name: string;
  tool: string | null;
  local_app_version: string | null;
  local_app_build: string | null;
  web_build_id: string | null;
  platform: string | null;
  architecture: string | null;
  agent_platform: string | null;
  agent_instance_id: string | null;
  error_code: string | null;
  error_stage: string | null;
  error_fingerprint: string | null;
  outcome: string | null;
  props: SanitizedProperties;
}

const SCOPE = `(($3::uuid is not null and e.user_id = $3::uuid)
  or ($3::uuid is null and e.installation_id = $4::uuid))`;
const RANGE = `($1::timestamptz is null or e.created_at >= $1::timestamptz) and e.created_at <= $2::timestamptz`;

async function readEvents(
  scope: Scope,
  period: ResolvedPeriod,
  schema: AnalyticsSchema
): Promise<EventRow[]> {
  const columns = eventColumnSql(schema);
  const rows = await query<Record<string, unknown>>(
    `select t.* from (
       select e.id as row_id, e.event_id::text as event_id, e.occurred_at as occurred_ts,
         e.occurred_at::text as occurred_at, e.created_at::text as created_at,
         e.session_id::text as session_id, e.session_sequence,
         e.installation_id::text as installation_id, e.flow_id::text as flow_id,
         coalesce(e.run_id::text, e.properties ->> 'run_id') as run_id,
         ${columns.attemptId} as attempt_id,
         e.properties ->> 'workflow_id' as workflow_id,
         e.event_name, coalesce(e.tool, e.properties ->> 'tool_identifier') as tool,
         coalesce(e.local_app_version, e.agent_version) as local_app_version, e.local_app_build,
         e.web_build_id, e.platform, e.architecture, ${columns.agentPlatform} as agent_platform,
         ${columns.agentInstanceId} as agent_instance_id,
         coalesce(e.error_code, e.properties ->> 'error_code') as error_code,
         coalesce(e.error_stage, e.properties ->> 'error_stage') as error_stage,
         coalesce(e.error_fingerprint, e.properties ->> 'error_fingerprint') as error_fingerprint,
         coalesce(e.outcome, e.properties ->> 'outcome') as outcome,
         e.properties
       from public.analytics_events e
       where ${SCOPE} and ${RANGE}
       order by e.occurred_at desc, e.session_sequence desc nulls last, e.id desc
       limit $5
     ) t
     order by t.occurred_ts asc, t.session_sequence asc nulls last, t.row_id asc`,
    [period.start, period.end, scope.userId, scope.installationId, EVENT_LIMIT]
  );
  return rows.map(row => ({
    row_id: Number(row.row_id),
    event_id: text(row.event_id),
    occurred_at: iso(row.occurred_at),
    created_at: iso(row.created_at),
    session_id: text(row.session_id),
    session_sequence: row.session_sequence === null ? null : Number(row.session_sequence),
    installation_id: text(row.installation_id),
    flow_id: text(row.flow_id),
    run_id: text(row.run_id),
    attempt_id: text(row.attempt_id),
    workflow_id: text(row.workflow_id),
    event_name: String(row.event_name),
    tool: text(row.tool),
    local_app_version: text(row.local_app_version),
    local_app_build: text(row.local_app_build),
    web_build_id: text(row.web_build_id),
    platform: text(row.platform),
    architecture: text(row.architecture),
    agent_platform: text(row.agent_platform),
    agent_instance_id: text(row.agent_instance_id),
    error_code: safeCode(text(row.error_code)),
    error_stage: safeWord(text(row.error_stage)),
    error_fingerprint: safeFingerprint(text(row.error_fingerprint)),
    outcome: safeWord(text(row.outcome)),
    props: sanitizeEventProperties(row.properties)
  }));
}

/** Codes, stages and fingerprints are closed vocabularies; anything else is not printed. */
function safeCode(value: string | null): string | null {
  return value && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : value ? 'unknown' : null;
}
function safeWord(value: string | null): string | null {
  return value && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
}
function safeFingerprint(value: string | null): string | null {
  return value && /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[A-Za-z][A-Za-z0-9_]*$/.test(value)
    ? value
    : null;
}

async function readJournal(
  scope: Scope,
  installations: string[],
  instances: string[],
  period: ResolvedPeriod,
  schema: AnalyticsSchema
): Promise<JournalRecordRow[]> {
  if (!schema.tables.agent_journal_records) return [];
  if (!scope.userId && installations.length === 0 && instances.length === 0) return [];
  const rows = await query<JournalDbRow>(
    `select ${JOURNAL_COLUMNS}
     from public.agent_journal_records j
     where (j.user_id = $3::uuid
         or j.installation_id = any($4::uuid[])
         or j.agent_instance_id = any($5::uuid[]))
       and ($1::timestamptz is null or j.recorded_at >= $1::timestamptz - interval '2 minutes')
       and j.received_at <= $2::timestamptz
     order by j.recorded_at desc, j.agent_instance_id desc, j.seq desc
     limit $6`,
    [period.start, period.end, scope.userId, installations, instances, JOURNAL_LIMIT]
  );
  return rows.map(toJournalRow).sort(compareJournal);
}

/** The newest local app version anyone ran in the period: the stale-agent baseline. */
async function newestVersionSeen(period: ResolvedPeriod): Promise<string | null> {
  const rows = await query<{ version: unknown }>(
    `select distinct coalesce(e.local_app_version, e.agent_version) as version
     from public.analytics_events e
     where ${RANGE} and coalesce(e.local_app_version, e.agent_version) is not null`,
    [period.start, period.end]
  );
  const versions = rows.map(row => text(row.version)).filter((v): v is string => !!v);
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** Of the web builds the subject used, those no user's link event came from in the period. */
async function buildsWithoutLinkEvents(
  builds: string[],
  period: ResolvedPeriod
): Promise<string[]> {
  if (builds.length === 0) return [];
  const rows = await query<{ web_build_id: unknown; covered: boolean }>(
    `select e.web_build_id, bool_or(e.event_name in (
         'link_check_started','link_check_completed','link_lost','link_recovered',
         'reconnect_clicked','blocked_by_browser_detected','link_inconsistency')) as covered
     from public.analytics_events e
     where ${RANGE} and e.web_build_id = any($3::text[])
     group by e.web_build_id`,
    [period.start, period.end, builds]
  );
  return sortedUnique(rows.filter(row => !row.covered).map(row => text(row.web_build_id)));
}

async function userActivity(
  userId: string | null,
  period: ResolvedPeriod
): Promise<{ email: string | null; activeInPeriod: boolean }> {
  if (!userId) return { email: null, activeInPeriod: false };
  const row = await queryOne<{ email: string | null; active: boolean }>(
    `select u.email_normalized as email,
       coalesce(greatest(u.last_seen_at, u.last_login_at) <= $3::timestamptz
         and ($2::timestamptz is null or greatest(u.last_seen_at, u.last_login_at) >= $2::timestamptz),
         false) as active
     from public.analytics_users u where u.id = $1::uuid`,
    [userId, period.start, period.end]
  );
  return { email: row?.email ?? null, activeInPeriod: Boolean(row?.active) };
}

async function syncSummary(
  email: string | null,
  period: ResolvedPeriod,
  schema: AnalyticsSchema
): Promise<InvestigateSyncSummary> {
  const note =
    'Spaces this user owns: current job state for jobs created by the end of the period; no cursor, name or error text.';
  if (!email) return { status: 'none', team_id: null, connections: [], note };
  if (!schema.tables.analytics_catalog_sync_jobs) {
    return { status: 'unavailable', team_id: null, connections: [], note };
  }
  let data;
  try {
    data = await getSyncJobs(email, 200);
  } catch {
    return { status: 'unavailable', team_id: null, connections: [], note };
  }
  if (!data) return { status: 'none', team_id: null, connections: [], note };
  const endMs = Date.parse(period.end);
  const connections = data.connections
    .map(connection => {
      const jobs = connection.jobs.filter(job => Date.parse(iso(job.created_at)) <= endMs);
      const states: Record<string, number> = {};
      for (const job of jobs) states[job.state] = (states[job.state] ?? 0) + 1;
      const sortedStates = Object.fromEntries(
        Object.entries(states).sort(([a], [b]) => a.localeCompare(b))
      );
      return {
        connection_id: connection.connection_id,
        connection_state: connection.connection_state,
        jobs: jobs.length,
        states: sortedStates,
        error_codes: sortedUnique(
          jobs.flatMap(job => [safeCode(job.last_error_code), safeCode(job.canonical_error_code)])
        ),
        last_updated_at:
          jobs
            .map(job => iso(job.updated_at))
            .sort()
            .at(-1) ?? null
      };
    })
    .filter(connection => connection.jobs > 0)
    .sort((a, b) => a.connection_id.localeCompare(b.connection_id));
  if (connections.length === 0) return { status: 'none', team_id: null, connections: [], note };
  return { status: 'ok', team_id: data.team_id, connections, note };
}

/* ---------------------------------------------------------------------------
 * investigate — assembly
 * ------------------------------------------------------------------------- */

function isFailureEvent(row: EventRow): boolean {
  return row.event_name === 'error_occurred' || row.event_name.endsWith('_failed');
}

function environmentOf(rows: EventRow[], newest: string | null): InvestigateEnvironment {
  return {
    web_builds: sortedUnique(rows.map(r => r.web_build_id)),
    local_app_versions: sortedUnique(rows.map(r => r.local_app_version)).sort(compareVersions),
    local_app_builds: sortedUnique(rows.map(r => r.local_app_build)),
    agent_platforms: sortedUnique(rows.map(r => r.agent_platform)),
    browser_platforms: sortedUnique(rows.map(r => r.platform)),
    architectures: sortedUnique(rows.map(r => r.architecture)),
    browser_families: sortedUnique(rows.map(r => text(r.props.browser_family))),
    link_origins: sortedUnique(rows.map(r => text(r.props.link_origin))),
    first_seen_at: rows[0]?.occurred_at ?? null,
    last_seen_at: rows.at(-1)?.occurred_at ?? null,
    newest_local_app_version_seen: newest
  };
}

function sessionsOf(rows: EventRow[], limit: number): InvestigateData['sessions'] {
  const sessions = new Map<string, InvestigateSession>();
  for (const row of rows) {
    if (!row.session_id) continue;
    let session = sessions.get(row.session_id);
    if (!session) {
      session = {
        session_id: row.session_id,
        started_at: row.occurred_at,
        ended_at: row.occurred_at,
        events: 0,
        tools: [],
        failures: 0
      };
      sessions.set(row.session_id, session);
    }
    session.events += 1;
    session.ended_at = row.occurred_at;
    if (row.tool && !session.tools.includes(row.tool)) session.tools.push(row.tool);
    if (isFailureEvent(row)) session.failures += 1;
  }
  const all = [...sessions.values()].map(s => ({ ...s, tools: [...s.tools].sort() }));
  const recent = all
    .sort(
      (a, b) => b.ended_at.localeCompare(a.ended_at) || a.session_id.localeCompare(b.session_id)
    )
    .slice(0, Math.max(1, limit));
  return { count: all.length, recent };
}

interface OperationGroup {
  id: string;
  id_kind: InvestigateOperation['id_kind'];
  rows: EventRow[];
}

function operationGroups(rows: EventRow[]): OperationGroup[] {
  const groups = new Map<string, OperationGroup>();
  for (const row of rows) {
    const key: [string, InvestigateOperation['id_kind']] | null = row.run_id
      ? [row.run_id, 'run_id']
      : row.workflow_id
        ? [row.workflow_id, 'workflow_id']
        : row.attempt_id
          ? [row.attempt_id, 'attempt_id']
          : null;
    if (!key || !OPAQUE_ID.test(key[0])) continue;
    let group = groups.get(key[0]);
    if (!group) {
      group = { id: key[0], id_kind: key[1], rows: [] };
      groups.set(key[0], group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

/** A quick in-memory reading: did the group end in success? Only the rest go through inspect. */
function endedInSuccess(group: OperationGroup): boolean {
  const terminal = [...group.rows]
    .reverse()
    .find(
      row =>
        /_(completed|failed|cancelled)$/.test(row.event_name) ||
        row.event_name === 'team_landing_render'
    );
  if (!terminal) return false;
  const outcome =
    terminal.outcome ??
    (terminal.event_name.endsWith('_failed')
      ? 'failure'
      : terminal.event_name.endsWith('_cancelled')
        ? 'cancelled'
        : 'success');
  return (
    outcome === 'success' &&
    !group.rows.some(
      row => row.event_name === 'error_occurred' && row.occurred_at > terminal.occurred_at
    )
  );
}

function errorOf(rows: EventRow[], tool: string | null) {
  const failing = [...rows].reverse().find(row => row.error_code || row.error_fingerprint);
  const code = failing?.error_code ?? null;
  const stage = failing?.error_stage ?? null;
  const fingerprint =
    failing?.error_fingerprint ??
    (code && stage && tool ? `${tool}:${stage}:${code}` : tool ? `${tool}:*` : null);
  return { code, stage, fingerprint };
}

async function operationsOf(
  groups: OperationGroup[],
  period: ResolvedPeriod,
  focus: string | null
): Promise<InvestigateOperation[]> {
  const candidates = groups
    .filter(group => group.id === focus || !endedInSuccess(group))
    .sort(
      (a, b) =>
        Number(b.id === focus) - Number(a.id === focus) ||
        (b.rows.at(-1)?.occurred_at ?? '').localeCompare(a.rows.at(-1)?.occurred_at ?? '') ||
        a.id.localeCompare(b.id)
    )
    .slice(0, OPERATION_LIMIT);

  const operations: InvestigateOperation[] = [];
  for (const group of candidates) {
    const inspected = await getInspect(group.id, period.end, 500);
    if (!inspected.found) continue;
    const found = inspected as InspectFound;
    const outcome = found.terminal?.outcome ?? null;
    const hasError = group.rows.some(isFailureEvent);
    let status: InvestigateOperation['status'];
    if (outcome === 'cancelled') status = 'cancelled';
    else if (outcome && outcome !== 'success') status = 'failed';
    else if (!found.terminal) status = hasError ? 'failed' : 'unfinished';
    else if (hasError) status = 'failed';
    else continue; // a focused run that succeeded
    // Team events carry no tool column; the capability the run matched still names one, so
    // a failed space operation is reported as `team:…` rather than as an unknown run.
    const tool =
      found.tool ??
      group.rows.find(row => row.tool)?.tool ??
      (found.capability ? (capabilityById(found.capability)?.tool ?? null) : null);
    const error = errorOf(group.rows, tool);
    const stageOf = (event: string) =>
      found.stages.expected.find(stage =>
        found.capability ? stageEventsOf(found, stage).includes(event) : false
      ) ?? null;
    operations.push({
      id: group.id,
      id_kind: group.id_kind,
      status,
      capability: found.capability,
      tool,
      stages: found.stages,
      last_proven_stage: found.last_proven_stage,
      chain: found.events.map(event => ({
        event: event.event_name,
        at: iso(event.occurred_at),
        stage: stageOf(event.event_name)
      })),
      terminal: found.terminal,
      error_code: status === 'failed' ? (error.code ?? 'unknown') : error.code,
      error_stage: error.stage,
      fingerprint: status === 'failed' ? error.fingerprint : null,
      agent_instance_ids: sortedUnique(group.rows.map(row => row.agent_instance_id)),
      started_at: found.first_seen_at,
      last_seen_at: found.last_seen_at
    });
  }
  return operations.sort(
    (a, b) =>
      Number(b.id === focus) - Number(a.id === focus) ||
      (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '') ||
      a.id.localeCompare(b.id)
  );
}

/** The events that prove one stage of the capability `inspect` matched. */
function stageEventsOf(found: InspectFound, stage: string): string[] {
  const capability = found.capability ? capabilityById(found.capability) : undefined;
  return [...(capability?.stageEvents[stage] ?? [])];
}

function linkOf(rows: EventRow[]): InvestigateLink {
  const lost = rows.filter(row => row.event_name === 'link_lost');
  const recovered = rows.filter(row => row.event_name === 'link_recovered');
  const unrecovered = lost.filter(
    loss =>
      !recovered.some(
        rec =>
          rec.occurred_at >= loss.occurred_at &&
          (loss.flow_id === null || rec.flow_id === null || rec.flow_id === loss.flow_id)
      )
  );
  const reasons = new Map<string, number>();
  for (const row of rows) {
    if (row.event_name !== 'link_check_completed') continue;
    if (row.outcome !== 'failure' && row.outcome !== 'blocked') continue;
    const reason = text(row.props.link_reason) ?? 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    losses: lost.length,
    recoveries: recovered.map(row => ({
      flow_id: row.flow_id,
      at: row.occurred_at,
      duration_ms: typeof row.props.duration_ms === 'number' ? row.props.duration_ms : null,
      mode: text(row.props.recovery_mode) ?? 'unknown'
    })),
    unrecovered: unrecovered.map(row => ({
      flow_id: row.flow_id,
      at: row.occurred_at,
      reason: text(row.props.link_reason)
    })),
    failed_checks_by_reason: [...reasons.entries()]
      .map(([reason, events]) => ({ reason, events }))
      .sort((a, b) => b.events - a.events || a.reason.localeCompare(b.reason)),
    inconsistencies: rows.filter(row => row.event_name === 'link_inconsistency').length,
    pairing_rejected: pairingRejections(rows).length
  };
}

function pairingRejections(rows: EventRow[]): EventRow[] {
  return rows.filter(
    row =>
      ['link_check_completed', 'link_lost', 'pairing_failed'].includes(row.event_name) &&
      row.props.link_reason === 'pairing_rejected'
  );
}

function errorClusters(rows: EventRow[]): InvestigateErrorCluster[] {
  const clusters = new Map<string, InvestigateErrorCluster>();
  for (const row of rows) {
    if (!isFailureEvent(row)) continue;
    const tool = row.tool ?? row.error_fingerprint?.split(':')[0] ?? 'unknown';
    const stage = row.error_stage ?? row.error_fingerprint?.split(':')[1] ?? 'unknown';
    const code = row.error_code ?? 'unknown';
    const fingerprint = row.error_fingerprint ?? `${tool}:${stage}:${code}`;
    const cluster = clusters.get(fingerprint);
    if (cluster) {
      cluster.occurrences += 1;
      cluster.last_seen_at = row.occurred_at;
    } else {
      clusters.set(fingerprint, {
        fingerprint,
        tool,
        error_stage: stage,
        error_code: code,
        occurrences: 1,
        first_seen_at: row.occurred_at,
        last_seen_at: row.occurred_at
      });
    }
  }
  return [...clusters.values()].sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.last_seen_at.localeCompare(a.last_seen_at) ||
      a.fingerprint.localeCompare(b.fingerprint)
  );
}

interface Failure extends InvestigateFailureRef {
  instances: string[];
  installations: string[];
  evidence: string[];
}

function eventRef(row: EventRow): string {
  return row.event_id ? `event:${row.event_id}` : `event:row-${row.row_id}`;
}

function failuresOf(
  rows: EventRow[],
  operations: InvestigateOperation[],
  groups: OperationGroup[]
): Failure[] {
  const failures: Failure[] = [];
  const operationIds = new Set(operations.map(op => op.id));
  for (const op of operations) {
    if (op.status === 'cancelled') continue;
    const group = groups.find(g => g.id === op.id);
    const rowsOf = group?.rows ?? [];
    const last = [...rowsOf].reverse().find(isFailureEvent) ?? rowsOf.at(-1);
    failures.push({
      kind: 'operation',
      ref: `run:${op.id}`,
      at: last?.occurred_at ?? op.last_seen_at ?? '',
      fingerprint: op.fingerprint,
      instances: op.agent_instance_ids,
      installations: sortedUnique(rowsOf.map(r => r.installation_id)),
      evidence: [`run:${op.id}`, ...rowsOf.filter(isFailureEvent).map(eventRef)]
    });
  }
  const inOperation = new Set(
    groups.filter(g => operationIds.has(g.id)).flatMap(g => g.rows.map(r => r.row_id))
  );
  const inSuccessfulGroup = new Set(
    groups.filter(g => !operationIds.has(g.id)).flatMap(g => g.rows.map(r => r.row_id))
  );
  for (const row of rows) {
    const base = {
      at: row.occurred_at,
      instances: sortedUnique([row.agent_instance_id]),
      installations: sortedUnique([row.installation_id]),
      evidence: [eventRef(row)]
    };
    if (row.event_name === 'tool_ready' && row.outcome === 'failure') {
      failures.push({
        kind: 'readiness',
        ref: eventRef(row),
        fingerprint: `readiness:${row.error_stage ?? 'unknown'}:${row.error_code ?? 'unknown'}`,
        ...base
      });
    } else if (row.event_name === 'link_lost') {
      failures.push({
        kind: 'link_lost',
        ref: eventRef(row),
        fingerprint: `link:${text(row.props.link_reason) ?? 'unknown'}`,
        ...base
      });
    } else if (
      row.event_name === 'error_occurred' &&
      !inOperation.has(row.row_id) &&
      !inSuccessfulGroup.has(row.row_id)
    ) {
      failures.push({
        kind: 'error',
        ref: eventRef(row),
        fingerprint:
          row.error_fingerprint ??
          `${row.tool ?? 'unknown'}:${row.error_stage ?? 'unknown'}:${row.error_code ?? 'unknown'}`,
        ...base
      });
    }
  }
  return failures.sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
}

function journalNear(failure: Failure, journal: JournalRecordRow[]): JournalRecordRow[] {
  const at = Date.parse(failure.at);
  if (!Number.isFinite(at)) return [];
  return journal.filter(record => {
    const delta = Math.abs(Date.parse(record.recorded_at) - at);
    if (!(delta <= JOURNAL_WINDOW_MS)) return false;
    if (failure.instances.length > 0) return failure.instances.includes(record.agent_instance_id);
    if (failure.installations.length > 0 && record.installation_id) {
      return failure.installations.includes(record.installation_id);
    }
    return true;
  });
}

/** Journal records that, near a failure, are a cause on their own (a proven tool failure). */
function isToolFailureRecord(record: JournalRecordRow): boolean {
  if (record.category === 'spawn' && record.code === 'exited') {
    return record.props.outcome === 'nonzero' || record.props.outcome === 'spawn_error';
  }
  if (record.category === 'picker' && record.code === 'exit') {
    return ['failed', 'unavailable', 'timeout'].includes(String(record.props.outcome));
  }
  return record.category === 'picker' && record.code === 'visibility_unknown';
}

/** Journal records worth citing as a possible cause of a failure without a code. */
function isNotableRecord(record: JournalRecordRow): boolean {
  if (isToolFailureRecord(record)) return true;
  const key = `${record.category}:${record.code}`;
  if (record.category === 'spawn' && record.code === 'exited')
    return record.props.outcome === 'signal';
  if (record.category === 'drop') return record.props.outcome !== 'found';
  if (record.category === 'entitlement') return record.props.decision === 'invalid';
  return [
    'boot:started',
    'shutdown:requested',
    'shutdown:failed',
    'shutdown:listen_failed',
    'stream:close_all',
    'stream:evict',
    'auth:token_mismatch',
    'auth:limiter_hit',
    'auth:route_budget_exceeded',
    'update:drain_requested'
  ].includes(key);
}

function journalRef(record: JournalRecordRow): string {
  return `journal:${record.agent_instance_id}:${record.seq}`;
}

function journalFingerprint(record: JournalRecordRow): string {
  return `journal:${record.category}:${record.code}`;
}

function journalLabel(record: JournalRecordRow): string {
  const outcome = typeof record.props.outcome === 'string' ? ` (${record.props.outcome})` : '';
  return `${record.category}:${record.code}${outcome}`;
}

/* ---------------------------------------------------------------------------
 * Findings
 * ------------------------------------------------------------------------- */

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const KIND_RANK: Record<InvestigateFindingKind, number> = {
  fact: 0,
  hypothesis: 1,
  insufficient: 2
};

class Findings {
  private readonly list: Array<InvestigateFinding & { at: string }> = [];

  add(input: {
    rule: string;
    key: string;
    kind: InvestigateFindingKind;
    severity: FindingSeverity;
    title: string;
    evidence: string[];
    fingerprint?: string;
    locate?: string[];
    next_step: string;
    at: string;
  }): void {
    const id = hashId([input.rule, input.kind, input.key]);
    if (this.list.some(finding => finding.id === id)) return;
    const locate = sortedUnique([...(input.locate ?? []), input.fingerprint]);
    const code_locations = locate
      .map(fingerprint => lookupCodeLocations(fingerprint))
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    this.list.push({
      id,
      kind: input.kind,
      severity: input.severity,
      rule: input.rule,
      title: input.title,
      evidence: [...new Set(input.evidence)],
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      code_locations,
      next_step: input.next_step,
      at: input.at
    });
  }

  ranked(): InvestigateFinding[] {
    return [...this.list]
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
          b.at.localeCompare(a.at) ||
          a.id.localeCompare(b.id)
      )
      .map(({ at: _at, ...finding }) => finding);
  }
}

const FIX_STEP =
  'Open the code locations, reproduce the failure with a failing test in tests, fix it, keep the regression green, then confirm after release with investigate or audit --as-of.';

function buildFindings(input: {
  rows: EventRow[];
  operations: InvestigateOperation[];
  failures: Failure[];
  windows: Map<Failure, JournalRecordRow[]>;
  journal: JournalRecordRow[];
  link: InvestigateLink;
  environment: InvestigateEnvironment;
  blindSpots: InvestigateBlindSpot[];
  errors: InvestigateErrorCluster[];
}): InvestigateFinding[] {
  const findings = new Findings();
  const { rows, operations, failures, windows, journal, environment, blindSpots } = input;

  if (rows.length === 0) {
    findings.add({
      rule: 'no_events',
      key: 'no_events',
      kind: 'insufficient',
      severity: 'high',
      title:
        'No analytics events for this subject in the period: there is not enough data to diagnose anything.',
      evidence: blindSpots.map(spot => `blind_spot:${spot.kind}`),
      next_step: `Name the blind spot to the owner (${blindSpots.map(s => s.kind).join(', ')}); widen --period, or add the missing signal as a task before guessing.`,
      at: ''
    });
    if (journal.length === 0) return findings.ranked();
  }

  // Failed operations.
  for (const op of operations) {
    if (op.status !== 'failed') continue;
    const failure = failures.find(f => f.ref === `run:${op.id}`);
    const near = failure ? (windows.get(failure) ?? []) : [];
    const notable = near.filter(isNotableRecord);
    const tool = op.tool ?? 'unknown';
    const known = op.error_code !== null && op.error_code !== 'unknown';
    if (known) {
      findings.add({
        rule: 'failed_operation_code',
        key: op.id,
        kind: 'fact',
        severity: 'high',
        title: `${tool} run failed at stage ${op.error_stage ?? 'unknown'} with ${op.error_code}; last proven stage ${op.last_proven_stage ?? 'none'}.`,
        evidence: [`run:${op.id}`, ...(failure?.evidence ?? []), ...notable.map(journalRef)],
        fingerprint: op.fingerprint ?? undefined,
        next_step: FIX_STEP,
        at: op.last_seen_at ?? ''
      });
    } else if (notable.length > 0) {
      const cited = sortedUnique(notable.map(journalFingerprint));
      findings.add({
        rule: 'failed_operation_unknown_with_journal',
        key: op.id,
        kind: 'hypothesis',
        severity: 'high',
        title: `${tool} run failed without a code; within 2 minutes the agent journal recorded ${sortedUnique(notable.map(journalLabel)).join(', ')}, a likely cause.`,
        evidence: [`run:${op.id}`, ...(failure?.evidence ?? []), ...notable.map(journalRef)],
        fingerprint: op.fingerprint ?? `${tool}:*`,
        locate: cited,
        next_step: `Confirm the cited journal records explain the failure, then give the agent a code for it in the closed list. ${FIX_STEP}`,
        at: op.last_seen_at ?? ''
      });
    } else {
      findings.add({
        rule: 'failed_operation_unknown',
        key: op.id,
        kind: 'insufficient',
        severity: 'medium',
        title: `${tool} run failed without a code and the agent journal has nothing around it.`,
        evidence: [`run:${op.id}`, ...(failure?.evidence ?? [])],
        fingerprint: op.fingerprint ?? `${tool}:*`,
        next_step:
          'Name the blind spot: the agent did not classify this failure. Add a code to the closed list for this branch as a task.',
        at: op.last_seen_at ?? ''
      });
    }
  }

  // Unfinished operations: a start without a terminal.
  for (const op of operations) {
    if (op.status !== 'unfinished') continue;
    const failure = failures.find(f => f.ref === `run:${op.id}`);
    const notable = failure ? (windows.get(failure) ?? []).filter(isNotableRecord) : [];
    findings.add({
      rule: 'unfinished_operation',
      key: op.id,
      kind: 'hypothesis',
      severity: notable.length > 0 ? 'medium' : 'low',
      title: `${op.tool ?? 'unknown'} run never reached a terminal; last proven stage ${op.last_proven_stage ?? 'none'}${notable.length > 0 ? `; the journal recorded ${sortedUnique(notable.map(journalLabel)).join(', ')}` : ''}.`,
      evidence: [`run:${op.id}`, ...notable.map(journalRef)],
      fingerprint: `${op.tool ?? 'unknown'}:*`,
      locate: sortedUnique(notable.map(journalFingerprint)),
      next_step:
        'Check whether the page closed, the link dropped or the local app restarted during the run (link and journal sections).',
      at: op.last_seen_at ?? ''
    });
  }

  // Journal tool failures next to any failure: spawn exits, picker failures.
  const toolFailures = new Map<string, { records: JournalRecordRow[]; failures: Failure[] }>();
  for (const failure of failures) {
    for (const record of (windows.get(failure) ?? []).filter(isToolFailureRecord)) {
      const label = journalLabel(record);
      const entry = toolFailures.get(label) ?? { records: [], failures: [] };
      if (!entry.records.includes(record)) entry.records.push(record);
      if (!entry.failures.includes(failure)) entry.failures.push(failure);
      toolFailures.set(label, entry);
    }
  }
  for (const [label, entry] of toolFailures) {
    const first = entry.records[0];
    findings.add({
      rule: 'journal_tool_failure',
      key: label,
      kind: 'fact',
      severity: 'high',
      title: `The agent journal recorded ${label} ${entry.records.length} time(s) within 2 minutes of ${entry.failures.length} failure(s).`,
      evidence: [...entry.records.map(journalRef), ...entry.failures.map(f => f.ref)],
      fingerprint: journalFingerprint(first),
      next_step: FIX_STEP,
      at: entry.records.at(-1)?.recorded_at ?? ''
    });
  }

  // Errors outside any operation (web-side checks, previews, team actions).
  for (const failure of failures.filter(f => f.kind === 'error')) {
    const fingerprint = failure.fingerprint ?? 'unknown';
    const sameFingerprint = failures.filter(
      f => f.kind === 'error' && f.fingerprint === fingerprint
    );
    const code = fingerprint.split(':')[2] ?? 'unknown';
    findings.add({
      rule: 'error_event',
      key: fingerprint,
      kind: code === 'unknown' ? 'insufficient' : 'fact',
      severity: 'medium',
      title: `error ${fingerprint} occurred ${sameFingerprint.length} time(s) outside a tracked run.`,
      evidence: sameFingerprint.flatMap(f => f.evidence),
      fingerprint,
      locate: sortedUnique(
        sameFingerprint
          .flatMap(f => (windows.get(f) ?? []).filter(isNotableRecord))
          .map(journalFingerprint)
      ),
      next_step:
        code === 'unknown'
          ? 'Name the blind spot: this error carries no code. Add one as a task.'
          : FIX_STEP,
      at: sameFingerprint.at(-1)?.at ?? ''
    });
  }

  // tool_ready failures.
  const readiness = failures.filter(f => f.kind === 'readiness');
  for (const fingerprint of sortedUnique(readiness.map(f => f.fingerprint))) {
    const same = readiness.filter(f => f.fingerprint === fingerprint);
    findings.add({
      rule: 'tool_ready_failure',
      key: fingerprint,
      kind: 'fact',
      severity: 'medium',
      title: `A tool page never became usable: tool_ready failed ${same.length} time(s) (${fingerprint}).`,
      evidence: same.flatMap(f => f.evidence),
      fingerprint,
      next_step: FIX_STEP,
      at: same.at(-1)?.at ?? ''
    });
  }

  // Link: lost without recovery, manual recovery, repeated pairing rejection.
  const lostRows = rows.filter(row => row.event_name === 'link_lost');
  for (const loss of input.link.unrecovered) {
    const row = lostRows.find(r => r.occurred_at === loss.at && r.flow_id === loss.flow_id);
    const fingerprint = `link:${loss.reason ?? 'unknown'}`;
    findings.add({
      rule: 'link_lost_unrecovered',
      key: `${loss.flow_id ?? 'none'}|${loss.at}`,
      kind: 'fact',
      severity: 'high',
      title: `The link to the local app was lost at ${loss.at} (reason ${loss.reason ?? 'unknown'}) and did not come back in the period.`,
      evidence: row ? [eventRef(row)] : [],
      fingerprint,
      next_step:
        'Read the journal around the loss (stream and shutdown records), then the link classifier for this reason.',
      at: loss.at
    });
  }
  const recoveredRows = rows.filter(row => row.event_name === 'link_recovered');
  const manual = recoveredRows.filter(row => row.props.recovery_mode === 'manual');
  if (manual.length > 0) {
    findings.add({
      rule: 'link_manual_recovery',
      key: 'manual',
      kind: 'fact',
      severity: 'low',
      title: `The link came back only after the user reconnected by hand ${manual.length} time(s).`,
      evidence: manual.map(eventRef),
      fingerprint: 'link:*',
      next_step: 'Check why automatic recovery did not succeed before the manual reconnect.',
      at: manual.at(-1)?.occurred_at ?? ''
    });
  }
  const rejections = pairingRejections(rows);
  if (rejections.length >= 2) {
    findings.add({
      rule: 'pairing_rejected_repeated',
      key: 'pairing_rejected',
      kind: 'fact',
      severity: 'medium',
      title: `The local app rejected the pairing ${rejections.length} times.`,
      evidence: rejections.map(eventRef),
      fingerprint: 'link:pairing_rejected',
      locate: ['journal:auth:handshake', 'journal:auth:limiter_hit'],
      next_step:
        'Read the auth records in the journal for the same time, then how the page renews its pairing.',
      at: rejections.at(-1)?.occurred_at ?? ''
    });
  }

  // Stale agent.
  const latestVersion = [...rows].reverse().find(row => row.local_app_version)?.local_app_version;
  const newest = environment.newest_local_app_version_seen;
  if (latestVersion && newest && compareVersions(latestVersion, newest) < 0) {
    const evidenceRow = [...rows].reverse().find(row => row.local_app_version === latestVersion);
    findings.add({
      rule: 'stale_agent',
      key: `${latestVersion}<${newest}`,
      kind: 'hypothesis',
      severity: 'medium',
      title: `The user's local app is ${latestVersion} while ${newest} is the newest seen in the period; the failure may already be fixed in a newer build.`,
      evidence: evidenceRow ? [eventRef(evidenceRow)] : [],
      fingerprint: 'agent:stale_version',
      next_step:
        'Check whether the failing code changed between the two versions before fixing; if it did, ask the user to update and confirm with investigate.',
      at: evidenceRow?.occurred_at ?? ''
    });
  }

  // A failure with no journal at all around anything: name the blind spot.
  if (failures.length > 0 && journal.length === 0) {
    const tableMissing = blindSpots.some(spot => spot.kind === 'journal_table_missing');
    findings.add({
      rule: 'journal_missing',
      key: 'journal_missing',
      kind: 'insufficient',
      severity: 'low',
      title: tableMissing
        ? 'There are failures but this database has no agent journal table to read around them.'
        : 'There are failures but no agent journal record reached the database for this subject.',
      evidence: blindSpots
        .filter(
          spot =>
            spot.kind === 'agent_journal_missing' ||
            spot.kind === 'agent_version_without_journal' ||
            spot.kind === 'journal_table_missing'
        )
        .map(spot => `blind_spot:${spot.kind}`),
      fingerprint: 'journal:*',
      next_step: tableMissing
        ? 'The journal migration (20261124100000) is not applied here; say the journal could not be read instead of guessing the cause.'
        : 'The journal forwarder may be off (analytics disabled, old web build) or the agent is older than the journal; say so instead of guessing the cause.',
      at: ''
    });
  }

  return findings.ranked();
}

function blindSpotsOf(input: {
  rows: EventRow[];
  journal: JournalRecordRow[];
  buildsWithoutLink: string[];
  activeInPeriod: boolean;
  sync: InvestigateSyncSummary;
  schema: AnalyticsSchema;
}): InvestigateBlindSpot[] {
  const { rows, journal, schema } = input;
  const journalReadable = schema.tables.agent_journal_records;
  const spots: InvestigateBlindSpot[] = [];
  if (!journalReadable) {
    spots.push({
      kind: 'journal_table_missing',
      detail:
        'This database has no agent_journal_records table visible to this role (migration 20261124100000 not applied): the agent journal could not be read at all.',
      values: []
    });
  }
  if (!hasEnvelopeV3(schema)) {
    spots.push({
      kind: 'envelope_v3_missing',
      detail:
        'analytics_events lacks envelope v3 columns (migration 20261117110000 not applied): attempt ids come from properties only, and Agent runs and platforms are unknown.',
      values: (['attempt_id', 'agent_instance_id', 'agent_platform'] as const).filter(
        column => !schema.events[column]
      )
    });
  }
  if (rows.length === 0) {
    spots.push({
      kind: 'no_events_in_period',
      detail: 'No analytics event from this subject arrived in the period.',
      values: []
    });
  }
  if (input.activeInPeriod && rows.length === 0) {
    spots.push({
      kind: 'analytics_disabled',
      detail:
        'The account was active in the period but sent no events: analytics disabled (beta or dev build), blocked, or an old web build.',
      values: []
    });
  }
  if (input.buildsWithoutLink.length > 0) {
    spots.push({
      kind: 'web_build_without_link_events',
      detail: 'Web builds this subject used that emitted no link event at all in the period.',
      values: input.buildsWithoutLink
    });
  }
  const journaled = new Set(journal.map(record => record.agent_instance_id));
  const versions = sortedUnique(rows.map(row => row.local_app_version)).sort(compareVersions);
  const silent = versions.filter(version => {
    const instances = sortedUnique(
      rows.filter(row => row.local_app_version === version).map(row => row.agent_instance_id)
    );
    return instances.length === 0 || !instances.some(instance => journaled.has(instance));
  });
  if (journalReadable && silent.length > 0) {
    spots.push({
      kind: 'agent_version_without_journal',
      detail: 'Local app versions with no agent journal record in the database for their runs.',
      values: silent
    });
  }
  if (journalReadable && rows.length > 0 && journal.length === 0) {
    spots.push({
      kind: 'agent_journal_missing',
      detail: 'No agent journal record for this subject in the period.',
      values: []
    });
  }
  let rejected = 0;
  let evicted = 0;
  let expired = 0;
  for (const row of rows) {
    if (row.event_name !== 'analytics_delivery_report') continue;
    rejected += typeof row.props.rejected_count === 'number' ? row.props.rejected_count : 0;
    evicted += typeof row.props.evicted_count === 'number' ? row.props.evicted_count : 0;
    expired += typeof row.props.expired_count === 'number' ? row.props.expired_count : 0;
  }
  if (rejected + evicted + expired > 0) {
    spots.push({
      kind: 'analytics_delivery_losses',
      detail: `The browser reported lost events: rejected ${rejected}, evicted ${evicted}, expired ${expired}.`,
      values: []
    });
  }
  if (input.sync.status === 'unavailable') {
    spots.push({
      kind: 'sync_unavailable',
      detail: 'The sync jobs view could not be read with this connection.',
      values: []
    });
  }
  return spots;
}

/**
 * `investigate <email | installation_id | run_id | flow_id | attempt_id>` — FR-005.
 * `sessionLimit` bounds `sessions.recent`.
 */
export async function getInvestigation(
  input: string,
  period: ResolvedPeriod,
  sessionLimit = 10
): Promise<InvestigateData> {
  const schema = await getSchema();
  const scope = await resolveSubject(input, period, schema);
  const [rows, newest, activity] = await Promise.all([
    readEvents(scope, period, schema),
    newestVersionSeen(period),
    userActivity(scope.userId, period)
  ]);
  const installations = sortedUnique([
    scope.installationId,
    ...rows.map(row => row.installation_id)
  ]);
  const instances = sortedUnique(rows.map(row => row.agent_instance_id));
  const journal = await readJournal(scope, installations, instances, period, schema);
  const journalInstances = sortedUnique([
    ...instances,
    ...journal.map(record => record.agent_instance_id)
  ]);

  const environment = environmentOf(rows, newest);
  const groups = operationGroups(rows);
  const operations = await operationsOf(groups, period, scope.focus);
  const link = linkOf(rows);
  const errors = errorClusters(rows);
  const failures = failuresOf(rows, operations, groups);
  const windows = new Map<Failure, JournalRecordRow[]>();
  for (const failure of failures) windows.set(failure, journalNear(failure, journal));
  const journalAroundFailures: InvestigateJournalWindow[] = failures
    .filter(failure => (windows.get(failure) ?? []).length > 0)
    .map(failure => ({
      failure: {
        kind: failure.kind,
        ref: failure.ref,
        at: failure.at,
        fingerprint: failure.fingerprint
      },
      records: windows.get(failure) ?? []
    }));

  const [buildsWithoutLink, sync] = await Promise.all([
    buildsWithoutLinkEvents(environment.web_builds, period),
    syncSummary(activity.email, period, schema)
  ]);
  const blindSpots = blindSpotsOf({
    rows,
    journal,
    buildsWithoutLink,
    activeInPeriod: activity.activeInPeriod,
    sync,
    schema
  });
  const findings = buildFindings({
    rows,
    operations,
    failures,
    windows,
    journal,
    link,
    environment,
    blindSpots,
    errors
  });

  const subject: InvestigateSubject = {
    kind: scope.kind,
    id: scope.id,
    user_id: scope.userId,
    installation_ids: installations,
    agent_instance_ids: journalInstances
  };
  return {
    subject,
    environment,
    sessions: sessionsOf(rows, sessionLimit),
    operations,
    link,
    errors,
    journal_around_failures: journalAroundFailures,
    sync,
    coverage: { events: rows.length, journal_records: journal.length, blind_spots: blindSpots },
    findings,
    schema: schemaSummary(schema)
  };
}
