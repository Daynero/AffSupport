// Stable, machine-readable output shapes for the Soty analytics CLI.
// The coding agent parses these; keep field names and meanings stable.

export type PeriodToken = 'today' | '7d' | '30d' | '90d' | 'all';

export interface ResolvedPeriod {
  /** Human token echoed back to the caller. */
  token: string;
  /** ISO start of the window, or null for "all time" (no lower bound). */
  start: string | null;
  /** ISO end of the window (inclusive upper bound; equals `as_of` when fixed). */
  end: string;
  /** Short human description, e.g. "last 7 days". */
  label: string;
  /** 031 — present when the caller fixed the window's end with `--as-of`. */
  as_of?: string;
}

/** Which newer analytics columns and tables the database has (`schema.ts` probes it). */
export interface AnalyticsSchema {
  events: { attempt_id: boolean; agent_instance_id: boolean; agent_platform: boolean };
  tables: {
    agent_journal_records: boolean;
    analytics_daily_events: boolean;
    analytics_daily_tool_outcomes: boolean;
    analytics_catalog_sync_jobs: boolean;
  };
}

/** What a command reports as `data.schema`: the probe and the objects it could not see. */
export interface SchemaSummary extends AnalyticsSchema {
  /** `analytics_events.<column>` and `<table>` names this connection cannot read. */
  missing: string[];
}

/* ---------------------------------------------------------------------------
 * 031 — shapes shared by every aggregating command.
 * ------------------------------------------------------------------------- */

/** `created_at − occurred_at` over the period, in milliseconds (FR-055). */
export interface DeliveryLag {
  p50: number | null;
  p95: number | null;
  samples: number;
}

/**
 * A signal the CLI knows about but no client emits today. It replaces a number
 * so a zero is never read as "it never happened" (FR-056, SC-014). `events`
 * names the event(s) that would prove the signal.
 */
export interface UnsupportedSignal {
  status: 'unsupported_by_producer';
  events: string[];
  note?: string;
}

export const UNSUPPORTED_BY_PRODUCER = 'unsupported_by_producer' as const;

export type StageRow = StageMetric | (UnsupportedSignal & { stage: string });
export type FrictionRow = FrictionSignal | (UnsupportedSignal & { signal: string });

export function isUnsupported(value: unknown): value is UnsupportedSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === UNSUPPORTED_BY_PRODUCER
  );
}

/** Aggregating list commands wrap their rows so `delivery_lag_ms` has a home. */
export interface ToolsData {
  tools: ToolRow[];
  delivery_lag_ms: DeliveryLag;
}
export interface EventsData {
  events: EventRow[];
  delivery_lag_ms: DeliveryLag;
}
export interface FunnelData {
  stages: FunnelStage[];
  delivery_lag_ms: DeliveryLag;
}
export interface StagesData {
  stages: StageRow[];
  delivery_lag_ms: DeliveryLag;
}
export interface ErrorsData {
  clusters: ErrorCluster[];
  delivery_lag_ms: DeliveryLag;
}
export interface FrictionData {
  signals: FrictionRow[];
  delivery_lag_ms: DeliveryLag;
}
export interface FeaturesData {
  features: FeatureMetric[];
  /** Interaction signals the registry declares but nothing emits. */
  unsupported: Array<UnsupportedSignal & { signal: string }>;
  delivery_lag_ms: DeliveryLag;
}
export interface CohortsData {
  cohort_by: 'local-app-version' | 'platform' | 'web-build';
  cohorts: CohortMetric[];
  /** Explains the `no_agent_context` cohort (events sent while no Agent was connected). */
  note: string;
  delivery_lag_ms: DeliveryLag;
}
export interface JourneyData {
  events: JourneyEvent[];
  delivery_lag_ms: DeliveryLag;
}

export const NO_AGENT_CONTEXT_COHORT = 'no_agent_context';
export const NO_AGENT_CONTEXT_NOTE =
  'no_agent_context: events sent while no Agent was connected (browser-only screens or before pairing); not an unknown build.';

/* ---------------------------------------------------------------------------
 * 031 — `audit` (FR-056): the coverage registry against the observed period.
 * ------------------------------------------------------------------------- */

export type AuditStatus = 'covered' | 'partial' | 'uncovered' | 'declared_but_never_emitted';

export interface AuditCapability {
  id: string;
  tool: string;
  status: AuditStatus;
  producer_status: 'emitted' | 'pending_producer' | 'unsupported_by_producer';
  source: 'events' | 'authoritative_table';
  /** Expected signals (and `correlation`) not observed in the period. */
  missing: string[];
  /** Start events observed; `0` with `status: uncovered` means nothing arrived. */
  samples: number;
  /** Start ids with no terminal carrying the same id inside the period. */
  orphan_starts: number;
  /** Start ids that do meet a terminal with the same id. */
  correlated_pairs: number;
  observed: Array<{
    event: string;
    role: 'start' | 'terminal' | 'readiness' | 'error';
    events: number;
    users: number;
    correlated: number;
  }>;
  unobservable: string[];
  note?: string;
}

export interface AuditUnknownCode {
  tool: string;
  /** Error rows whose `error_code` resolved to `unknown` (or was absent). */
  unknown_code: number;
  /** Error rows whose `error_stage` resolved to `unknown` (or was absent). */
  unknown_stage: number;
  errors: number;
}

export interface AuditDelivery {
  reports: number;
  rejected: number;
  evicted: number;
  expired: number;
  by_event: Array<{ event_name: string; rejected_reports: number; evicted_reports: number }>;
  note: string;
}

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export interface AuditFinding {
  /** sha256 of `${capability}|${status}|${missing.sort().join(',')}` — stable across runs. */
  id: string;
  capability: string;
  status: AuditStatus | 'orphan_starts' | 'unknown_codes' | 'uncovered_builds' | 'delivery_losses';
  severity: FindingSeverity;
  missing: string[];
  evidence: string[];
}

export interface AuditData {
  registry_size: number;
  capabilities: AuditCapability[];
  unknown_codes: AuditUnknownCode[];
  delivery: AuditDelivery;
  /** Web builds seen in the period that emitted no link event (032 coverage). */
  uncovered_builds: string[];
  delivery_lag_ms: DeliveryLag;
  findings: AuditFinding[];
  summary: Record<AuditStatus, number>;
  /** Which newer columns and tables this database has (`schema.ts`); `note` when any is missing. */
  schema: SchemaSummary & { note?: string };
}

/** `inspect` on a database without the envelope v3 columns: what it could not read. */
export interface InspectSchemaNote {
  missing: string[];
  note: string;
}

/** What `audit --write` saves: the envelope without `generated_at`, so an unchanged snapshot yields identical bytes (SC-017). */
export interface AuditArtifact {
  ok: true;
  command: 'audit';
  as_of: string;
  period: ResolvedPeriod;
  data: AuditData;
}

/* ---------------------------------------------------------------------------
 * 031 — `inspect <id>` (FR-056): one attempt across every tool.
 * ------------------------------------------------------------------------- */

export interface InspectStages {
  expected: string[];
  observed: string[];
  missing: string[];
}

export interface InspectAgentIdentity {
  local_app_versions: string[];
  local_app_builds: string[];
  web_build_ids: string[];
  platforms: string[];
  architectures: string[];
  /** The latest Agent run (`/health` instanceId) that emitted an event of this attempt. */
  agent_instance_id: string | null;
  /** Every Agent run seen; more than one means the Agent restarted during the attempt. */
  agent_instance_ids: string[];
  /** The Agent's own platform (envelope v3), beside the browser's `platforms`. */
  agent_platforms: string[];
  note: string;
}

export interface InspectFound {
  found: true;
  id: string;
  /** Which column or property carried the id. */
  matched_by: Array<'run_id' | 'flow_id' | 'attempt_id' | 'workflow_id' | 'properties'>;
  capability: string | null;
  tool: string | null;
  stages: InspectStages;
  terminal: { event: string; outcome: string; occurred_at: string } | null;
  last_proven_stage: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  delivery_lag_ms: DeliveryLag;
  agent: InspectAgentIdentity;
  events: JourneyEvent[];
  schema?: InspectSchemaNote;
}

export interface InspectNotFound {
  found: false;
  id: string;
  schema?: InspectSchemaNote;
}

export type InspectData = InspectFound | InspectNotFound;

export const INSPECT_AGENT_NOTE =
  'agent_instance_id/agent_platforms come from the Agent (envelope v3) and are empty for events from web builds before 031; platforms/architectures come from the browser.';

export interface CommandEnvelope<T> {
  ok: true;
  command: string;
  generated_at: string;
  period: ResolvedPeriod;
  data: T;
}

export type TeamMetricStatus = 'pass' | 'fail' | 'insufficient';

export interface TeamPilotCriterion {
  attempts: number;
  successes: number;
  success_rate: number | null;
  status: TeamMetricStatus;
}

export interface TeamFindCueMetric {
  cue: 'geo' | 'offer' | 'language' | 'category';
  attempts: number;
  successes: number;
}

export interface TeamFindCriterion extends TeamPilotCriterion {
  cues: TeamFindCueMetric[];
}

export interface TeamActivationWindow {
  window_index: 1 | 2 | 3 | 4;
  denominator: number;
  numerator: number;
  rate: number | null;
  status: TeamMetricStatus;
}

/** Storage lifecycle counters (011): how many spaces got connected, indexed, previewed — and how often storage needed a person. */
export interface TeamStorageMetrics {
  storage_connected: number;
  index_completed: number;
  previews_ready: number;
  attention: number;
  attention_reasons: Array<{ reason: string; count: number }>;
}

export interface TeamWorkspaceData {
  sc001: TeamPilotCriterion;
  sc005: TeamFindCriterion;
  sc009: {
    windows: TeamActivationWindow[];
    all_windows_pass: boolean | null;
  };
  storage: TeamStorageMetrics;
}

export function buildCommandEnvelope<T>(
  command: string,
  period: ResolvedPeriod,
  data: T,
  generatedAt = new Date().toISOString()
): CommandEnvelope<T> {
  return { ok: true, command, generated_at: generatedAt, period, data };
}

const TEAM_OUTPUT_FORBIDDEN_KEYS = new Set([
  'team_id',
  'workspace_key',
  'member_user_id',
  'user_id',
  'email',
  'name',
  'filename',
  'file_name',
  'path',
  'query',
  'drive_id',
  'folder_id',
  'material_id',
  'metadata',
  'content',
  'transcript',
  'provider',
  'grant',
  'ticket',
  'session_id',
  'session_uri'
]);

/** Defense in depth for the aggregate-only team-workspace CLI response. */
export function teamWorkspaceOutputIsPrivate(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(teamWorkspaceOutputIsPrivate);
  if (value && typeof value === 'object') {
    return Object.entries(value).every(
      ([key, entry]) =>
        !TEAM_OUTPUT_FORBIDDEN_KEYS.has(key.toLocaleLowerCase('en-US')) &&
        teamWorkspaceOutputIsPrivate(entry)
    );
  }
  if (typeof value !== 'string') return true;
  return (
    !/@/u.test(value) &&
    !/[/\\]/u.test(value) &&
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value) &&
    !/(?:bearer|oauth|token|grant|ticket|session_uri)/iu.test(value)
  );
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: string;
  hint?: string;
}

export interface TopListItem {
  name: string;
  count: number;
}

export interface OverviewData {
  total_users: number;
  new_users: number;
  active_users: number;
  sessions: number;
  total_events: number;
  tool_opens: number;
  compression_batches: number;
  videos_added: number;
  videos_compressed: number;
  compressions_completed: number;
  compressions_failed: number;
  top_locales: TopListItem[];
  top_platforms: TopListItem[];
  top_app_versions: TopListItem[];
  top_agent_versions: TopListItem[];
}

export interface CompressorData {
  unique_users: number;
  tool_opens: number;
  videos_added: number;
  compression_started: number;
  compression_completed: number;
  compression_failed: number;
  started_without_completion: number;
  batch_count: number;
  total_videos_compressed: number;
  average_batch_size: number | null;
  total_input_bytes: number;
  total_output_bytes: number;
  saved_bytes: number;
  average_saving_percent: number | null;
  success_rate: number | null;
  average_duration_ms: number | null;
}

export interface UsersData {
  total_users: number;
  new_users: number;
  active_users: number;
  last_active: UserSummary[];
}

export interface UserSummary {
  id: string;
  email: string | null;
  display_name: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  event_count?: number;
  compressions?: number;
}

export interface TopUsersData {
  by: 'activity' | 'compressions';
  users: UserSummary[];
}

export interface UserDetailData {
  id: string;
  email: string | null;
  display_name: string | null;
  language: string | null;
  plan: string | null;
  account_status: string | null;
  registered_at: string | null;
  last_login_at: string | null;
  last_seen_at: string | null;
  sessions: number;
  total_events: number;
  compressions_completed: number;
  videos_compressed: number;
  tool_usage: TopListItem[];
  event_breakdown: TopListItem[];
  recent_events: RecentEvent[];
}

export interface RecentEvent {
  event_name: string;
  tool: string | null;
  created_at: string;
  properties: Record<string, unknown>;
}

export interface ToolRow {
  tool: string;
  opens: number;
  unique_users: number;
  inputs: number;
  starts: number;
  completions: number;
  failures: number;
  cancellations: number;
}

export interface EventRow {
  event_name: string;
  count: number;
  unique_users: number;
}

export interface FunnelStage {
  stage: string;
  users: number;
  conversion_from_previous: number | null;
  conversion_from_start: number | null;
}

export interface StageMetric {
  stage: string;
  events: number;
  users: number;
}

export interface ErrorCluster {
  error_code: string;
  error_stage: string;
  error_fingerprint: string;
  tool: string;
  local_app_version: string;
  occurrences: number;
  users: number;
  recovered: number;
  last_seen_at: string;
}

export interface FrictionSignal {
  signal: string;
  users: number;
  sessions: number;
}

export interface FeatureMetric {
  feature: string;
  impressions: number;
  interactions: number;
  successful_operations: number;
  unique_users: number;
}

export interface JourneyEvent {
  event_id: string;
  occurred_at: string;
  session_sequence: number | null;
  session_id: string | null;
  installation_id: string | null;
  flow_id: string | null;
  run_id: string | null;
  event_name: string;
  tool: string | null;
  local_app_version: string | null;
  local_app_build: string | null;
  web_build_id: string | null;
  platform: string | null;
  architecture: string | null;
  properties: Record<string, unknown>;
}

export interface CohortMetric {
  cohort: string;
  users: number;
  events: number;
  successes: number;
  failures: number;
}

export interface RetentionMetric {
  registered_users: number;
  active_after_1d: number;
  active_after_7d: number;
  active_after_30d: number;
}

/* ---------------------------------------------------------------------------
 * 032 — the browser ↔ Agent link (`connection` command). Aggregates only:
 * no user, session, installation or instance id ever appears here.
 * ------------------------------------------------------------------------- */

export interface ConnectionReasonRow {
  reason: string;
  events: number;
  users: number;
}

export interface ConnectionBrowserRow {
  browser_family: string;
  users: number;
}

export interface ConnectionOriginRow {
  link_origin: string;
  users: number;
  events: number;
}

export interface ConnectionData {
  users_with_loss: number;
  losses: number;
  recoveries: number;
  /** `duration_ms` of `link_recovered`: how long the break lasted. */
  recovery_ms: { p50: number | null; p95: number | null; samples: number };
  recovery_mode: { auto: number; manual: number; local_copy: number };
  failed_checks_by_reason: ConnectionReasonRow[];
  blocked_by_browser: ConnectionBrowserRow[];
  origins: ConnectionOriginRow[];
  inconsistencies: { events: number; users: number };
  /**
   * Which web builds seen in the period emit link events at all. A build on the
   * `without` list predates 032 (or lost its analytics) — it is uncovered, and
   * a missing `link_lost` from it says nothing about its link.
   */
  coverage: {
    web_builds_with_link_events: number;
    web_builds_without: string[];
    note: string;
  };
}

export const CONNECTION_COVERAGE_NOTE = 'builds without link events are uncovered, not healthy';

/* ---------------------------------------------------------------------------
 * 028 — manual sync diagnostics (`sync` command). One row per catalog sync job,
 * from the read-only view `public.analytics_catalog_sync_jobs`. No cursors,
 * tokens, lease owners or Drive names ever appear here; `scope_hash` is a
 * 12-character digest that matches a worker log line and nothing else.
 * ------------------------------------------------------------------------- */

export interface SyncJobRow {
  job_id: string;
  connection_id: string;
  connection_state: string;
  job_kind: string;
  phase: string;
  state: string;
  scope_hash: string | null;
  requested_by: string | null;
  request_id: string | null;
  request_outcome: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  scan_completed_at: string | null;
  last_progress_at: string | null;
  lease_expires_at: string | null;
  lease_epoch: number;
  run_count: number;
  attempts: number;
  lease_lost_count: number;
  no_progress_runs: number | null;
  next_attempt_at: string;
  replay_after: number | null;
  confirmed_sequence: number | null;
  confirmed_at: string | null;
  recovery_count: number | null;
  last_recovery_at: string | null;
  canonical_job_id: string | null;
  canonical_state: string | null;
  canonical_error_code: string | null;
  canonical_next_attempt_at: string | null;
  last_error_code: string | null;
  error_detail: string | null;
  cancel_requested_at: string | null;
  files_listed: number;
  files_added: number;
  files_updated: number;
  files_removed: number;
  items_unavailable: number;
  folders_done: number;
}

export interface SyncConnection {
  connection_id: string;
  connection_state: string;
  canonical: {
    job_id: string;
    state: string;
    error_code: string | null;
    next_attempt_at: string | null;
    confirmed_sequence: number | null;
    recovery_count: number | null;
  } | null;
  jobs: SyncJobRow[];
}

export interface SyncData {
  team_id: string;
  connections: SyncConnection[];
}

/** Keys that must never reach the terminal or the JSON envelope. */
export const SYNC_OUTPUT_FORBIDDEN_KEYS = new Set([
  'cursor',
  'folder_queue',
  'confirmed_cursor',
  'page_token',
  'change_page_token',
  'lease_owner',
  'requested_folder_id',
  'owner_email_normalized',
  'name',
  'root_folder_name'
]);

export function syncOutputIsPrivate(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(syncOutputIsPrivate);
  if (typeof value !== 'object' || value === null) return true;
  return Object.entries(value).every(
    ([key, nested]) => !SYNC_OUTPUT_FORBIDDEN_KEYS.has(key) && syncOutputIsPrivate(nested)
  );
}

/* ---------------------------------------------------------------------------
 * 033 — the agent journal in the database (`journal`) and one-command
 * investigation of a user (`investigate`). Opaque ids only: no email, name,
 * path, URL or credential ever appears; `investigateOutputIsPrivate` checks.
 * ------------------------------------------------------------------------- */

/** One agent journal record as the CLI returns it; props already passed the server fence again. */
export interface JournalRecordRow {
  seq: number;
  category: string;
  code: string;
  props: Record<string, string | number | boolean>;
  agent_instance_id: string;
  installation_id: string | null;
  /** When the agent wrote it (its clock). */
  recorded_at: string;
  /** When the database stored it (server clock; `--as-of` bounds this). */
  received_at: string;
  /** `received_at − recorded_at`: how long the record waited on the user's machine. */
  lag_ms: number | null;
}

/** `journal` on a database without `agent_journal_records` (or no grant on it). */
export interface JournalUnavailable {
  available: false;
  reason: 'journal_table_missing';
  records: [];
}

/** What `journal` returns: the records, or why there are none to read. */
export type JournalResult = JournalData | JournalUnavailable;

export interface JournalData {
  available: true;
  subject: {
    kind: 'user' | 'installation' | 'agent_instance';
    user_id: string | null;
    installation_id: string | null;
    agent_instance_id: string | null;
  };
  /** Records in the period, oldest first; the newest `--limit` when there are more. */
  records: JournalRecordRow[];
  total: number;
  truncated: boolean;
  lag_ms: DeliveryLag;
}

export type InvestigateSubjectKind = 'user' | 'installation' | 'run' | 'flow' | 'attempt';

export interface InvestigateSubject {
  kind: InvestigateSubjectKind;
  /** The id that was passed in; null when it was an email (never echoed). */
  id: string | null;
  user_id: string | null;
  installation_ids: string[];
  agent_instance_ids: string[];
}

export interface InvestigateEnvironment {
  web_builds: string[];
  local_app_versions: string[];
  local_app_builds: string[];
  agent_platforms: string[];
  browser_platforms: string[];
  architectures: string[];
  browser_families: string[];
  link_origins: string[];
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** The newest local app version any user ran in the period (the stale-agent baseline). */
  newest_local_app_version_seen: string | null;
}

export interface InvestigateSession {
  session_id: string;
  started_at: string;
  ended_at: string;
  events: number;
  tools: string[];
  failures: number;
}

export interface InvestigateChainStep {
  event: string;
  at: string;
  stage: string | null;
}

export interface InvestigateOperation {
  id: string;
  id_kind: 'run_id' | 'workflow_id' | 'attempt_id';
  status: 'failed' | 'unfinished' | 'cancelled';
  capability: string | null;
  tool: string | null;
  stages: InspectStages;
  last_proven_stage: string | null;
  chain: InvestigateChainStep[];
  terminal: { event: string; outcome: string; occurred_at: string } | null;
  error_code: string | null;
  error_stage: string | null;
  fingerprint: string | null;
  agent_instance_ids: string[];
  started_at: string | null;
  last_seen_at: string | null;
}

export interface InvestigateLink {
  losses: number;
  recoveries: Array<{
    flow_id: string | null;
    at: string;
    duration_ms: number | null;
    mode: string;
  }>;
  unrecovered: Array<{ flow_id: string | null; at: string; reason: string | null }>;
  failed_checks_by_reason: Array<{ reason: string; events: number }>;
  inconsistencies: number;
  pairing_rejected: number;
}

export interface InvestigateErrorCluster {
  fingerprint: string;
  tool: string;
  error_stage: string;
  error_code: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface InvestigateFailureRef {
  kind: 'operation' | 'error' | 'readiness' | 'link_lost';
  ref: string;
  at: string;
  fingerprint: string | null;
}

export interface InvestigateJournalWindow {
  failure: InvestigateFailureRef;
  records: JournalRecordRow[];
}

export interface InvestigateSyncSummary {
  status: 'ok' | 'none' | 'unavailable';
  team_id: string | null;
  connections: Array<{
    connection_id: string;
    connection_state: string;
    jobs: number;
    states: Record<string, number>;
    error_codes: string[];
    last_updated_at: string | null;
  }>;
  note: string;
}

export interface InvestigateBlindSpot {
  kind:
    | 'no_events_in_period'
    | 'web_build_without_link_events'
    | 'agent_version_without_journal'
    | 'agent_journal_missing'
    | 'analytics_disabled'
    | 'analytics_delivery_losses'
    | 'sync_unavailable'
    | 'journal_table_missing'
    | 'envelope_v3_missing';
  detail: string;
  values: string[];
}

export type InvestigateFindingKind = 'fact' | 'hypothesis' | 'insufficient';

export interface InvestigateFinding {
  /** sha256 of the rule and its key: the same finding has the same id on every run. */
  id: string;
  kind: InvestigateFindingKind;
  severity: FindingSeverity;
  rule: string;
  title: string;
  /** `event:<id>`, `run:<id>`, `journal:<agent_instance_id>:<seq>`. */
  evidence: string[];
  fingerprint?: string;
  code_locations: Array<{ fingerprint: string; matched: string; files: string[]; check: string }>;
  next_step: string;
}

export interface InvestigateData {
  subject: InvestigateSubject;
  environment: InvestigateEnvironment;
  sessions: { count: number; recent: InvestigateSession[] };
  operations: InvestigateOperation[];
  link: InvestigateLink;
  errors: InvestigateErrorCluster[];
  journal_around_failures: InvestigateJournalWindow[];
  sync: InvestigateSyncSummary;
  coverage: { events: number; journal_records: number; blind_spots: InvestigateBlindSpot[] };
  findings: InvestigateFinding[];
  /** Which newer columns and tables this database has (`schema.ts`). */
  schema: SchemaSummary;
}

const INVESTIGATE_FORBIDDEN_KEYS = new Set([
  'email',
  'email_normalized',
  'owner_email_normalized',
  'display_name',
  'name',
  'path',
  'file_name',
  'filename',
  'url',
  'token',
  'error_detail'
]);

/** A repo-relative source file: the one kind of path `investigate` may print (`code_locations`). */
const REPO_FILE = /^(apps|packages|supabase)\/[\w.@-]+(\/[\w.@-]+)*$/;
const CREDENTIAL = /bearer|oauth|token=|authorization/i;

/**
 * 033 FR-011 — defense in depth for `investigate` and `journal`: no forbidden key anywhere, and
 * no string that is an address, a URL, a credential or a path. The only path allowed is a
 * repo-relative source file inside a `files` array.
 */
export function investigateOutputIsPrivate(value: unknown, key = ''): boolean {
  if (Array.isArray(value)) return value.every(item => investigateOutputIsPrivate(item, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).every(
      ([entryKey, entry]) =>
        !INVESTIGATE_FORBIDDEN_KEYS.has(entryKey.toLowerCase()) &&
        investigateOutputIsPrivate(entry, entryKey)
    );
  }
  if (typeof value !== 'string') return true;
  if (key === 'files') return REPO_FILE.test(value) && !value.includes('..');
  return (
    !value.includes('@') &&
    !value.includes('://') &&
    !/[/\\]/.test(value) &&
    !CREDENTIAL.test(value)
  );
}
