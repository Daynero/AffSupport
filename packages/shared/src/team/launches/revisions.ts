import { isRecord } from '../contract.js';
import type {
  LaunchConfig,
  LaunchPreview,
  LaunchOverrides,
  LaunchParseResult,
  LaunchSources
} from '../launches.js';
import { normalizeLaunchSub } from './validation.js';
import { LAUNCH_SUB_VALUE_MAX } from '../launches.js';
import { isLaunchUrl } from './url.js';
/** JSONB key order is irrelevant; ordered SUB/rows and exact URL strings are not. */
export function launchValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => launchValuesEqual(value, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left)
    .filter(key => left[key] !== undefined)
    .sort();
  const other = Object.keys(right)
    .filter(key => right[key] !== undefined)
    .sort();
  return (
    keys.length === other.length &&
    keys.every((key, index) => key === other[index] && launchValuesEqual(left[key], right[key]))
  );
}
/** Reuse the existing binary fingerprint; permission-only Drive versions do not change bytes. */
export function launchMaterialIdentity(source: LaunchSources): string | null {
  const checksum = source.materialChecksum;
  const identity =
    typeof checksum === 'string' && /^[0-9a-f]{32}$/iu.test(checksum)
      ? `md5:${checksum.toLowerCase()}`
      : source.materialVersion !== null
        ? `version:${source.materialVersion}`
        : null;
  return identity ? JSON.stringify([source.materialDriveFileId ?? null, identity]) : null;
}
/** Actual derived values determine catalog reuse, not the fact that a form field changed. */
export function launchRevisionImpact(
  previous: LaunchPreview,
  next: LaunchPreview,
  before: LaunchConfig,
  after: LaunchConfig,
  beforeSources?: LaunchSources,
  afterSources?: LaunchSources
): { namesChanged: boolean; urlChanged: boolean; mediaChanged: boolean; catalogChanged: boolean } {
  const namesChanged = JSON.stringify(previous.campaigns) !== JSON.stringify(next.campaigns);
  const urlChanged = previous.advertisingUrl !== next.advertisingUrl;
  const mediaChanged =
    before.materialId !== after.materialId ||
    (beforeSources !== undefined &&
      afterSources !== undefined &&
      (launchMaterialIdentity(beforeSources) === null ||
        launchMaterialIdentity(afterSources) === null ||
        launchMaterialIdentity(beforeSources) !== launchMaterialIdentity(afterSources) ||
        (after.catalog.restitchEnabled &&
          (beforeSources.restitchSettingsVersion == null ||
            afterSources.restitchSettingsVersion == null ||
            beforeSources.restitchSettingsVersion !== afterSources.restitchSettingsVersion)))) ||
    JSON.stringify({
      on: before.catalog.restitchEnabled,
      ...(before.catalog.restitchEnabled
        ? {
            mode: before.catalog.finalDurationMode,
            range:
              before.catalog.finalDurationMode === 'random-centered'
                ? before.catalog.finalDurationRangeSeconds
                : undefined,
            ...(before.catalog.finalDurationMode === 'custom' ||
            before.catalog.finalDurationMode === 'random-centered'
              ? { seconds: before.catalog.customFinalDurationSeconds }
              : {})
          }
        : {})
    }) !==
      JSON.stringify({
        on: after.catalog.restitchEnabled,
        ...(after.catalog.restitchEnabled
          ? {
              mode: after.catalog.finalDurationMode,
              range:
                after.catalog.finalDurationMode === 'random-centered'
                  ? after.catalog.finalDurationRangeSeconds
                  : undefined,
              ...(after.catalog.finalDurationMode === 'custom' ||
              after.catalog.finalDurationMode === 'random-centered'
                ? { seconds: after.catalog.customFinalDurationSeconds }
                : {})
            }
          : {})
      });
  return {
    namesChanged,
    urlChanged,
    mediaChanged,
    catalogChanged:
      after.method === 'catalog' &&
      (before.method !== 'catalog' ||
        urlChanged ||
        mediaChanged ||
        before.catalog.productCount !== after.catalog.productCount ||
        (beforeSources !== undefined &&
          afterSources !== undefined &&
          (beforeSources.catalogSettingsVersion == null ||
            afterSources.catalogSettingsVersion == null ||
            beforeSources.catalogSettingsVersion !== afterSources.catalogSettingsVersion)))
  };
}
export function parseLaunchOverrides(
  value: unknown,
  campaignCount: number
): LaunchParseResult<LaunchOverrides> {
  if (!isRecord(value)) return { ok: false, errors: { overrides: 'INVALID_INPUT' } };
  const errors: Record<string, string> = {};
  const result: LaunchOverrides = {};
  for (const key of Object.keys(value))
    if (!['advertisingUrl', 'catalogName', 'catalogUrl', 'campaigns', 'subValues'].includes(key))
      errors[key] = 'INVALID_INPUT';
  for (const key of ['advertisingUrl', 'catalogName', 'catalogUrl'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (
      typeof field !== 'string' ||
      !field.length ||
      field.length > 8192 ||
      /\p{Cc}/u.test(field) ||
      (key !== 'catalogName' && !isLaunchUrl(field))
    )
      errors[key] = 'INVALID_INPUT';
    else result[key] = field;
  }
  if (value.campaigns !== undefined) {
    if (!isRecord(value.campaigns)) errors.campaigns = 'INVALID_INPUT';
    else {
      result.campaigns = {};
      for (const [ordinal, row] of Object.entries(value.campaigns)) {
        if (
          !/^[1-9][0-9]{0,2}$/u.test(ordinal) ||
          Number(ordinal) < 1 ||
          Number(ordinal) > campaignCount ||
          !isRecord(row)
        ) {
          errors.campaigns = 'INVALID_INPUT';
          continue;
        }
        const parsed: { name?: string; budget?: string; adRange?: string } = {};
        for (const [key, text] of Object.entries(row)) {
          if (
            typeof text !== 'string' ||
            !text.length ||
            text.length > 2000 ||
            /\p{Cc}/u.test(text)
          ) {
            errors.campaigns = 'INVALID_INPUT';
            continue;
          }
          if (key === 'name') parsed.name = text;
          else if (
            key === 'budget' &&
            /^[1-9][0-9]{0,15}$/u.test(text) &&
            Number.isSafeInteger(Number(text)) &&
            Number(text) > 0
          )
            parsed.budget = text;
          else if (
            key === 'adRange' &&
            /^[1-9][0-9]{0,15}-[1-9][0-9]{0,15}$/u.test(text) &&
            text.split('-').every(x => Number.isSafeInteger(Number(x)) && Number(x) > 0) &&
            Number(text.split('-')[0]) <= Number(text.split('-')[1])
          )
            parsed.adRange = text;
          else errors.campaigns = 'INVALID_INPUT';
        }
        result.campaigns[ordinal] = parsed;
      }
    }
  }
  if (value.subValues !== undefined) {
    if (!isRecord(value.subValues)) errors.subValues = 'INVALID_INPUT';
    else {
      result.subValues = {};
      for (const [key, text] of Object.entries(value.subValues)) {
        if (
          (key !== 'sub1' && key !== 'sub2' && key !== 'sub3') ||
          typeof text !== 'string' ||
          normalizeLaunchSub(text, LAUNCH_SUB_VALUE_MAX) !== text
        )
          errors.subValues = 'LAUNCH_SUB_INVALID';
        else result.subValues[key] = text;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: result };
}
