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
}

export interface InspectNotFound {
  found: false;
  id: string;
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
