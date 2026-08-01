// Stable, machine-readable output shapes for the Wishly analytics CLI.
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

export interface TeamWorkspaceData {
  sc001: TeamPilotCriterion;
  sc005: TeamFindCriterion;
  sc009: {
    windows: TeamActivationWindow[];
    all_windows_pass: boolean | null;
  };
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
  starts: number;
  completions: number;
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
