import { MATERIAL_CATEGORIES, type MaterialCategory } from './material-category.js';
import { isRecord } from './contract.js';
import type { LandingRenderFailureReason, LandingTileState } from './landing-gallery.js';

export const TEAM_ANALYTICS_EVENT_NAMES = [
  'team_workspace_session',
  'team_onboarding_started',
  'team_onboarding_completed',
  'team_find_started',
  'team_find_completed',
  'team_preview_started',
  'team_preview_completed',
  'team_file_attempt_started',
  'team_file_attempt_completed',
  'team_workflow_started',
  'team_workflow_completed',
  'team_landing_gallery_view',
  'team_landing_open',
  'team_landing_render'
] as const;
export type TeamAnalyticsEventName = (typeof TEAM_ANALYTICS_EVENT_NAMES)[number];

export type TeamAnalyticsOutcome =
  'success' | 'failure' | 'cancelled' | 'blocked' | 'unsupported' | 'ready' | 'failed';
export type TeamAnalyticsCue = 'geo' | 'offer' | 'language' | 'category';
export type TeamAnalyticsAction = 'upload' | 'download' | 'rename' | 'move' | 'trash';
export type TeamAnalyticsStorage = 'my_drive' | 'shared_drive';
export type TeamAnalyticsSizeBucket = 'tiny' | 'small' | 'medium' | 'large' | 'agent';
export type TeamAnalyticsCacheState = 'cold' | 'warm' | 'unknown';
export type TeamAnalyticsStage =
  'finding' | 'previewing' | 'downloading' | 'processing' | 'uploading' | 'finalizing';

export interface TeamAnalyticsProperties {
  flow_id?: string;
  study_run_id?: string;
  attempt_id?: string;
  workflow_id?: string;
  duration_ms?: number;
  category?: MaterialCategory;
  cue_category?: TeamAnalyticsCue;
  action?: TeamAnalyticsAction;
  storage_kind?: TeamAnalyticsStorage;
  size_bucket?: TeamAnalyticsSizeBucket;
  cache_state?: TeamAnalyticsCacheState;
  attempt_number?: number;
  stage?: TeamAnalyticsStage;
  outcome?: TeamAnalyticsOutcome;
  retryable?: boolean;
  assisted?: boolean;
  invite_persisted?: boolean;
  root_confirmed?: boolean;
  sync_queued?: boolean;
  workspace_session?: boolean;
  discovery_completed?: boolean;
  production_completed?: boolean;
  window_index?: number;
  item_count?: number;
  ready_count?: number;
  tile_state?: LandingTileState;
  had_agent?: boolean;
  reason?: LandingRenderFailureReason;
}

const ID_KEYS = new Set(['flow_id', 'study_run_id', 'attempt_id', 'workflow_id']);
const BOOLEAN_KEYS = new Set([
  'retryable',
  'assisted',
  'invite_persisted',
  'root_confirmed',
  'sync_queued',
  'workspace_session',
  'discovery_completed',
  'production_completed',
  'had_agent'
]);
const safeOpaqueId = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
const OUTCOMES = new Set<TeamAnalyticsOutcome>([
  'success',
  'failure',
  'cancelled',
  'blocked',
  'unsupported',
  'ready',
  'failed'
]);
const CUES = new Set<TeamAnalyticsCue>(['geo', 'offer', 'language', 'category']);
const ACTIONS = new Set<TeamAnalyticsAction>(['upload', 'download', 'rename', 'move', 'trash']);
const STORAGE = new Set<TeamAnalyticsStorage>(['my_drive', 'shared_drive']);
const SIZE_BUCKETS = new Set<TeamAnalyticsSizeBucket>([
  'tiny',
  'small',
  'medium',
  'large',
  'agent'
]);
const CACHE_STATES = new Set<TeamAnalyticsCacheState>(['cold', 'warm', 'unknown']);
const STAGES = new Set<TeamAnalyticsStage>([
  'finding',
  'previewing',
  'downloading',
  'processing',
  'uploading',
  'finalizing'
]);
const TILE_STATES = new Set<LandingTileState>([
  'ready',
  'candidate',
  'rendering',
  'needs_agent',
  'agent_outdated',
  'error'
]);
const LANDING_FAILURE_REASONS = new Set<LandingRenderFailureReason>([
  'unsupported',
  'corrupt',
  'protected',
  'too_large',
  'render_error'
]);

export const TEAM_ANALYTICS_FORBIDDEN_FIELDS = Object.freeze([
  'email',
  'filename',
  'file_name',
  'path',
  'query',
  'transcript',
  'content',
  'drive_id',
  'folder_id',
  'material_id',
  'provider',
  'grant',
  'grant_id',
  'ticket',
  'vault_id',
  'access_token',
  'refresh_token',
  'session_uri',
  'session_url',
  'upload_uri',
  'metadata',
  'offer',
  'tags',
  'geo',
  'language'
]);

export function sanitizeTeamAnalyticsProperties(input: unknown): TeamAnalyticsProperties {
  if (!isRecord(input)) return {};
  const output: TeamAnalyticsProperties = {};
  for (const [key, value] of Object.entries(input)) {
    if (ID_KEYS.has(key) && typeof value === 'string' && safeOpaqueId.test(value)) {
      output[key as 'flow_id'] = value;
    } else if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      output[key as 'retryable'] = value;
    } else if (
      key === 'duration_ms' &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 31_536_000_000
    ) {
      output.duration_ms = Math.round(value);
    } else if (
      key === 'attempt_number' &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 10_000
    ) {
      output.attempt_number = value;
    } else if (
      key === 'window_index' &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 4
    ) {
      output.window_index = value;
    } else if (
      key === 'category' &&
      typeof value === 'string' &&
      (MATERIAL_CATEGORIES as readonly string[]).includes(value)
    ) {
      output.category = value as MaterialCategory;
    } else if (key === 'cue_category' && CUES.has(value as TeamAnalyticsCue)) {
      output.cue_category = value as TeamAnalyticsCue;
    } else if (key === 'action' && ACTIONS.has(value as TeamAnalyticsAction)) {
      output.action = value as TeamAnalyticsAction;
    } else if (key === 'storage_kind' && STORAGE.has(value as TeamAnalyticsStorage)) {
      output.storage_kind = value as TeamAnalyticsStorage;
    } else if (key === 'size_bucket' && SIZE_BUCKETS.has(value as TeamAnalyticsSizeBucket)) {
      output.size_bucket = value as TeamAnalyticsSizeBucket;
    } else if (key === 'cache_state' && CACHE_STATES.has(value as TeamAnalyticsCacheState)) {
      output.cache_state = value as TeamAnalyticsCacheState;
    } else if (key === 'stage' && STAGES.has(value as TeamAnalyticsStage)) {
      output.stage = value as TeamAnalyticsStage;
    } else if (key === 'outcome' && OUTCOMES.has(value as TeamAnalyticsOutcome)) {
      output.outcome = value as TeamAnalyticsOutcome;
    } else if (
      (key === 'item_count' || key === 'ready_count') &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 1_000_000
    ) {
      output[key as 'item_count'] = value;
    } else if (key === 'tile_state' && TILE_STATES.has(value as LandingTileState)) {
      output.tile_state = value as LandingTileState;
    } else if (
      key === 'reason' &&
      LANDING_FAILURE_REASONS.has(value as LandingRenderFailureReason)
    ) {
      output.reason = value as LandingRenderFailureReason;
    }
  }
  return output;
}

export function containsForbiddenTeamAnalyticsField(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const forbidden = new Set(TEAM_ANALYTICS_FORBIDDEN_FIELDS);
  return Object.keys(input).some(key => forbidden.has(key.toLocaleLowerCase('en-US')));
}
