/** Launches are a separate workspace aggregate; Tasks remain unchanged. */
import type { LaunchNote } from './launches/notes.js';
import type { LaunchAnalyticsStage } from './launches/lifecycle.js';
export const LAUNCH_SCHEMA_VERSION = 1;
export const LAUNCH_CAMPAIGN_MAX = 100;
export const LAUNCH_BUDGET_MAX = 999999;
export const LAUNCH_ADS_MAX = 1000;
export const LAUNCH_URL_MAX = 8192;
export const LAUNCH_SUB_VALUE_MAX = 512;
export const LAUNCH_SUB_VARIABLES = [
  'buyer',
  'social',
  'adAccountSuffix',
  'creative',
  'catalogName'
] as const;
export type LaunchSubVariable = (typeof LAUNCH_SUB_VARIABLES)[number];
export type LaunchSubSlot = 'sub1' | 'sub2' | 'sub3';
export interface LaunchSubConfig {
  schemaVersion: 1;
  sub1: LaunchSubVariable[];
  sub2: LaunchSubVariable[];
  sub3: LaunchSubVariable[];
}
export interface LaunchCatalogConfig {
  productCount: number;
  restitchEnabled: boolean;
  finalDurationMode:
    'random-30-40' | 'random-40-50' | 'random-50-60' | 'random-centered' | 'custom';
  customFinalDurationSeconds: number | null;
  /** Inclusive random bounds, in seconds; absent for legacy centered windows. */
  finalDurationRangeSeconds?: readonly [number, number];
}
export interface LaunchConfig {
  schemaVersion: 1;
  agentRowId: string;
  offerId: string;
  buyerId: string;
  materialId: string;
  creativeAlias: string;
  campaignCount: number;
  maxBudget: number;
  /** Absent on legacy launches, which retain max/count allocation. */
  minBudget?: number;
  adsCount: number;
  budgetMode: 'auto' | 'manual';
  budgets: number[] | null;
  age: number;
  gender: 'M' | 'W' | 'ALL';
  advantagePlus: boolean;
  launchDate: string;
  timezone: string;
  method: 'catalog' | 'other';
  originalUrl: string;
  subConfig: LaunchSubConfig;
  catalog: LaunchCatalogConfig;
  notes?: LaunchNote[];
}
export type LaunchDraft = Partial<LaunchConfig>;
export interface LaunchSources {
  accountId: string;
  social: string;
  agentId: string;
  offer: string;
  buyer: string;
  materialVersion: string | null;
  materialChecksum?: string | null;
  materialDriveFileId?: string;
  catalogSettingsVersion?: string | null;
  restitchSettingsVersion?: string | null;
  materialType: 'video' | 'image';
}
export interface LaunchSourceSnapshot extends LaunchSources {
  schemaVersion: 1;
  agentRowId: string;
  offerId: string;
  buyerId: string;
  materialId: string;
  catalogSettingsVersion: string | null;
}
export interface LaunchCampaign {
  ordinal: number;
  budget: number;
  adStart: number;
  adEnd: number;
  name: string;
}
export interface LaunchPreview {
  advertisingUrl: string;
  subValues: Record<LaunchSubSlot, string | null>;
  campaigns: LaunchCampaign[];
}
export type LaunchParseResult<T> =
  { ok: true; value: T } | { ok: false; errors: Record<string, string> };
export const LAUNCH_GENERATION_STATES = [
  'accepted',
  'running',
  'waiting_dependency',
  'partial',
  'failed',
  'interrupted',
  'succeeded',
  'cancel_requested',
  'canceled_with_cleanup_pending',
  'canceled'
] as const;
export type LaunchGenerationState = (typeof LAUNCH_GENERATION_STATES)[number];
export type LaunchStage = LaunchAnalyticsStage | 'unknown';
export const LAUNCH_STEP_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled'
] as const;
export interface LaunchGenerationStep {
  id: string;
  stage: LaunchStage;
  state: (typeof LAUNCH_STEP_STATES)[number];
  attemptNo: number;
  errorCode: string | null;
}
export interface LaunchGeneration {
  id: string;
  requestKey?: string;
  inputVersion?: string;
  restitchOperationId?: string | null;
  state: LaunchGenerationState;
  stage: LaunchStage;
  steps?: LaunchGenerationStep[];
  stepsTruncated?: boolean;
  stateVersion: string;
  progress: { completed: number; total: number; unit: string; source: string } | null;
  errorCode: string | null;
  childOperationIds: string[];
}
export interface LaunchSummary {
  id: string;
  version: string;
  createdAt?: string;
  launchDate: string | null;
  offer: string;
  social: string;
  creativeAlias: string;
  method: 'catalog' | 'other';
  workStatus: 'todo' | 'in_progress' | 'done';
  assigneeId: string | null;
  budgets: number[];
  agentSuffix?: string;
  agentId?: string;
  accountName?: string;
  agentFree?: boolean;
  assigneeLabel?: string | null;
  gender?: LaunchConfig['gender'] | null;
  age?: number | null;
  campaignCount?: number;
  advantagePlus?: boolean;
  generationState: LaunchGenerationState | null;
  hasResult?: boolean;
}
export interface LaunchOverrides {
  advertisingUrl?: string;
  catalogName?: string;
  catalogUrl?: string;
  campaigns?: Record<string, { name?: string; budget?: string; adRange?: string }>;
  subValues?: Partial<Record<LaunchSubSlot, string>>;
}
export interface LaunchRevision {
  id: string;
  generationId?: string | null;
  revisionNo: number;
  kind: 'generated' | 'manual';
  config: LaunchConfig;
  sources: LaunchSources;
  baselineRevisionId: string | null;
  baseline: LaunchPreview;
  overrides: LaunchOverrides;
  catalog: {
    id: string;
    materialId: string;
    variant: number;
    name: string;
    url: string;
    restitchMaterialId: string | null;
  } | null;
  createdAt: string;
}
export interface LaunchDetail {
  id: string;
  version: string;
  draft: LaunchDraft;
  expectedSourceSnapshot: LaunchSourceSnapshot | null;
  assigneeId: string | null;
  workStatus: 'todo' | 'in_progress' | 'done';
  activeRevision: LaunchRevision | null;
  generation: LaunchGeneration | null;
}
export function launchInputsLocked(state: LaunchGenerationState | null): boolean {
  return state !== null && !['succeeded', 'canceled', 'failed'].includes(state);
}
export * from './launches/validation.js';
export * from './launches/url.js';
export * from './launches/budgets.js';
export * from './launches/naming.js';
export * from './launches/preview.js';
export * from './launches/revisions.js';

export * from './launches/persistence.js';

export * from './launches/lifecycle.js';

export * from './launches/defaults.js';

export * from './launches/notes.js';
