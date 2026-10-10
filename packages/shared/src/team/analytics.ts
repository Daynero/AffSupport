import { MATERIAL_CATEGORIES, type MaterialCategory } from './material-category.js';
import {
  TEAM_STORAGE_ATTENTION_REASONS,
  isRecord,
  type TeamStorageAttentionReason
} from './contract.js';
import type { LandingRenderFailureReason, LandingTileState } from './landing-gallery.js';
import {
  CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS,
  CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES,
  type CreativeLibraryContributionAction,
  type CreativeLibraryContributionCategory
} from './creative-library.js';

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
  'team_landing_render',
  'team_library_batch_completed',
  'team_library_processing_completed',
  'team_task_completed',
  // 011 — storage lifecycle, read by the analytics CLI as `data.storage`.
  'team_storage_connected',
  'team_index_completed',
  'team_previews_ready',
  'team_storage_attention'
] as const;
export type TeamAnalyticsEventName = (typeof TEAM_ANALYTICS_EVENT_NAMES)[number];

/**
 * The outcome vocabulary is the database guard's, verbatim. `ready`/`failed`
 * used to be accepted here and refused there, so every `team_landing_render`
 * was lost at ingestion (031 FR-048); the client now says `success`/`failure`.
 */
export const TEAM_ANALYTICS_OUTCOMES = [
  'success',
  'failure',
  'cancelled',
  'blocked',
  'skipped',
  'unsupported'
] as const;
export type TeamAnalyticsOutcome = (typeof TEAM_ANALYTICS_OUTCOMES)[number];
export const TEAM_ANALYTICS_CUES = ['geo', 'offer', 'language', 'category'] as const;
export type TeamAnalyticsCue = (typeof TEAM_ANALYTICS_CUES)[number];
export const TEAM_ANALYTICS_ACTIONS = ['upload', 'download', 'rename', 'move', 'trash'] as const;
export type TeamAnalyticsAction = (typeof TEAM_ANALYTICS_ACTIONS)[number];
export const TEAM_ANALYTICS_STORAGES = ['my_drive', 'shared_drive'] as const;
export type TeamAnalyticsStorage = (typeof TEAM_ANALYTICS_STORAGES)[number];
export const TEAM_ANALYTICS_SIZE_BUCKETS = ['tiny', 'small', 'medium', 'large', 'agent'] as const;
export type TeamAnalyticsSizeBucket = (typeof TEAM_ANALYTICS_SIZE_BUCKETS)[number];
export const TEAM_ANALYTICS_CACHE_STATES = ['cold', 'warm', 'unknown'] as const;
export type TeamAnalyticsCacheState = (typeof TEAM_ANALYTICS_CACHE_STATES)[number];
export const TEAM_ANALYTICS_STAGES = [
  'finding',
  'previewing',
  'downloading',
  'processing',
  'uploading',
  'finalizing'
] as const;
export type TeamAnalyticsStage = (typeof TEAM_ANALYTICS_STAGES)[number];
const LANDING_TILE_STATES = [
  'ready',
  'candidate',
  'rendering',
  'needs_agent',
  'agent_outdated',
  'error'
] as const satisfies readonly LandingTileState[];
const LANDING_RENDER_FAILURE_REASONS = [
  'unsupported',
  'corrupt',
  'protected',
  'too_large',
  'render_error'
] as const satisfies readonly LandingRenderFailureReason[];

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
  contribution_category?: CreativeLibraryContributionCategory;
  contribution_action?: CreativeLibraryContributionAction;
  selection_count?: number;
  folder_count?: number;
  file_count?: number;
  unavailable_count?: number;
  attention_reason?: TeamStorageAttentionReason;
}

/**
 * One rule per property. `sanitizeTeamAnalyticsProperties` reads this table and
 * nothing else, and the four exported views below are derived from it, so the
 * client allowlist the database guard is tested against has a single source
 * (031 FR-048).
 *
 * - `id`: an opaque identifier, the database's `^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$`.
 * - `boolean`: a boolean or nothing — never the string "true".
 * - `number`: finite, inside the closed range; `integer` refuses fractions,
 *   otherwise the value is rounded.
 * - `enum`: a value outside the vocabulary is dropped, never passed through.
 */
export type TeamAnalyticsPropertyRule =
  | { kind: 'id' }
  | { kind: 'boolean' }
  | { kind: 'number'; range: readonly [number, number]; integer?: boolean }
  | { kind: 'enum'; values: readonly string[] };

const ONE_YEAR_MS = 31_536_000_000;
/** The bound the database guard puts on every `*_count` of the team events. */
export const TEAM_ANALYTICS_COUNT_MAX = 100_000;

export const TEAM_ANALYTICS_PROPERTY_RULES: Readonly<
  Record<keyof TeamAnalyticsProperties, TeamAnalyticsPropertyRule>
> = {
  flow_id: { kind: 'id' },
  study_run_id: { kind: 'id' },
  attempt_id: { kind: 'id' },
  workflow_id: { kind: 'id' },
  duration_ms: { kind: 'number', range: [0, ONE_YEAR_MS] },
  category: { kind: 'enum', values: MATERIAL_CATEGORIES },
  cue_category: { kind: 'enum', values: TEAM_ANALYTICS_CUES },
  action: { kind: 'enum', values: TEAM_ANALYTICS_ACTIONS },
  storage_kind: { kind: 'enum', values: TEAM_ANALYTICS_STORAGES },
  size_bucket: { kind: 'enum', values: TEAM_ANALYTICS_SIZE_BUCKETS },
  cache_state: { kind: 'enum', values: TEAM_ANALYTICS_CACHE_STATES },
  attempt_number: { kind: 'number', range: [1, 10_000], integer: true },
  stage: { kind: 'enum', values: TEAM_ANALYTICS_STAGES },
  outcome: { kind: 'enum', values: TEAM_ANALYTICS_OUTCOMES },
  retryable: { kind: 'boolean' },
  assisted: { kind: 'boolean' },
  invite_persisted: { kind: 'boolean' },
  root_confirmed: { kind: 'boolean' },
  sync_queued: { kind: 'boolean' },
  workspace_session: { kind: 'boolean' },
  discovery_completed: { kind: 'boolean' },
  production_completed: { kind: 'boolean' },
  window_index: { kind: 'number', range: [1, 4], integer: true },
  item_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX], integer: true },
  ready_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX], integer: true },
  tile_state: { kind: 'enum', values: LANDING_TILE_STATES },
  had_agent: { kind: 'boolean' },
  reason: { kind: 'enum', values: LANDING_RENDER_FAILURE_REASONS },
  contribution_category: { kind: 'enum', values: CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES },
  contribution_action: { kind: 'enum', values: CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS },
  selection_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX], integer: true },
  folder_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX], integer: true },
  file_count: { kind: 'number', range: [0, 1_000_000], integer: true },
  unavailable_count: { kind: 'number', range: [0, TEAM_ANALYTICS_COUNT_MAX], integer: true },
  attention_reason: { kind: 'enum', values: TEAM_STORAGE_ATTENTION_REASONS }
};

type TeamAnalyticsPropertyKey = keyof TeamAnalyticsProperties;

const ruleEntries = Object.entries(TEAM_ANALYTICS_PROPERTY_RULES) as [
  TeamAnalyticsPropertyKey,
  TeamAnalyticsPropertyRule
][];

export const TEAM_ANALYTICS_PROPERTY_KEYS: readonly string[] = Object.freeze(
  ruleEntries.map(([key]) => key)
);
export const TEAM_ANALYTICS_PROPERTY_ENUMS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      ruleEntries.flatMap(([key, rule]) => (rule.kind === 'enum' ? [[key, rule.values]] : []))
    )
  );
export const TEAM_ANALYTICS_BOOLEAN_KEYS: readonly string[] = Object.freeze(
  ruleEntries.flatMap(([key, rule]) => (rule.kind === 'boolean' ? [key] : []))
);
export const TEAM_ANALYTICS_NUMERIC_RANGES: Readonly<Record<string, [number, number]>> =
  Object.freeze(
    Object.fromEntries(
      ruleEntries.flatMap(([key, rule]): [string, [number, number]][] =>
        rule.kind === 'number' ? [[key, [rule.range[0], rule.range[1]]]] : []
      )
    )
  );

const safeOpaqueId = /^[a-z0-9][a-z0-9_-]{0,95}$/i;

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

function isTeamAnalyticsPropertyKey(key: string): key is TeamAnalyticsPropertyKey {
  return Object.prototype.hasOwnProperty.call(TEAM_ANALYTICS_PROPERTY_RULES, key);
}

function sanitizeTeamAnalyticsValue(
  rule: TeamAnalyticsPropertyRule,
  value: unknown
): string | number | boolean | undefined {
  switch (rule.kind) {
    case 'id':
      return typeof value === 'string' && safeOpaqueId.test(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      if (rule.integer && !Number.isInteger(value)) return undefined;
      if (value < rule.range[0] || value > rule.range[1]) return undefined;
      return rule.integer ? value : Math.round(value);
    }
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? value : undefined;
  }
}

export function sanitizeTeamAnalyticsProperties(input: unknown): TeamAnalyticsProperties {
  if (!isRecord(input)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isTeamAnalyticsPropertyKey(key)) continue;
    const clean = sanitizeTeamAnalyticsValue(TEAM_ANALYTICS_PROPERTY_RULES[key], value);
    if (clean !== undefined) output[key] = clean;
  }
  return output as TeamAnalyticsProperties;
}

export function containsForbiddenTeamAnalyticsField(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const forbidden = new Set(TEAM_ANALYTICS_FORBIDDEN_FIELDS);
  return Object.keys(input).some(key => forbidden.has(key.toLocaleLowerCase('en-US')));
}
