import { CATALOG_IMAGE_ERROR_CODES } from '../catalog-images.js';
/** Closed diagnostic vocabulary: user configuration and output never enter telemetry. */
export const LAUNCH_ANALYTICS_EVENTS = [
  'team_launch_intent',
  'team_launch_stage',
  'team_launch_terminal',
  'team_launch_visible',
  'team_launch_action'
] as const;
export const LAUNCH_ANALYTICS_STAGES = [
  'validation',
  'draft_saved',
  'accepted',
  'preparing',
  'restitch_preparing',
  'restitch_processing',
  'restitch_uploading',
  'catalog_planning',
  'catalog_creating',
  'catalog_sharing',
  'catalog_registering',
  'result_committing',
  'result_committed',
  'cancel',
  'cleanup'
] as const;
export const LAUNCH_ANALYTICS_ACTIONS = [
  'generate',
  'retry',
  'cancel',
  'save_draft',
  'refresh_sources',
  'save_overrides',
  'restore_config',
  'save_defaults',
  'copy_launch',
  'archive_launch',
  'assign_account',
  'release_account',
  'copy_field',
  'rename_dictionary',
  'archive_dictionary',
  'restore_dictionary'
] as const;
export const LAUNCH_ANALYTICS_FIELDS = [
  'advertising_url',
  'catalog_name',
  'catalog_url',
  'campaign_name',
  'budget',
  'ad_range',
  'sub1',
  'sub2',
  'sub3'
] as const;
export const LAUNCH_ANALYTICS_CODES = [
  ...CATALOG_IMAGE_ERROR_CODES,
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'SOURCE_CHANGED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'SPACE_BLOCKED',
  'LAUNCH_BUSY',
  'LAUNCH_VERSION_CONFLICT',
  'LAUNCH_URL_INVALID',
  'LAUNCH_SUB_INVALID',
  'LAUNCH_BUDGET_INVALID',
  'LAUNCH_RESULT_UNCERTAIN',
  'LEASE_MISMATCH',
  'DRIVE_UNAVAILABLE',
  'DRIVE_FILE_MISSING',
  'AGENT_UPDATE_REQUIRED',
  'AGENT_REQUIRED',
  'NEEDS_REAUTH',
  'RESTITCH_INVALID',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_POOL_EMPTY',
  'RESTITCH_SOURCE_FORBIDDEN',
  'RESTITCH_SOURCES_INVALID',
  'RESTITCH_CLIENT_OUTDATED',
  'PROCESS_FAILED',
  'PROCESS_CANCELED',
  'WRONG_STATE',
  'LAUNCH_INTERNAL_ERROR',
  'SHARE_NOT_ALLOWED',
  'NO_WORK',
  'UNKNOWN'
] as const;
export type LaunchAnalyticsStage = (typeof LAUNCH_ANALYTICS_STAGES)[number];
export type LaunchAnalyticsAction = (typeof LAUNCH_ANALYTICS_ACTIONS)[number];
export type LaunchAnalyticsField = (typeof LAUNCH_ANALYTICS_FIELDS)[number];
export type LaunchAnalyticsCode = (typeof LAUNCH_ANALYTICS_CODES)[number];
export function safeLaunchAnalyticsCode(value: unknown): LaunchAnalyticsCode {
  return LAUNCH_ANALYTICS_CODES.find(code => code === value) ?? 'UNKNOWN';
}
