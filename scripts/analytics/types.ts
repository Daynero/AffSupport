// Stable, machine-readable output shapes for the Soty analytics CLI.
// The coding agent parses these; keep field names and meanings stable.

export type PeriodToken = 'today' | '7d' | '30d' | '90d' | 'all';

export interface ResolvedPeriod {
  /** Human token echoed back to the caller. */
  token: string;
  /** ISO start of the window, or null for "all time" (no lower bound). */
  start: string | null;
  /** ISO end of the window (exclusive upper bound). */
  end: string;
  /** Short human description, e.g. "last 7 days". */
  label: string;
}

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
