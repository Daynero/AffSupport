import {
  TEAM_ANALYTICS_BOOLEAN_KEYS,
  TEAM_ANALYTICS_NUMERIC_RANGES,
  TEAM_ANALYTICS_PROPERTY_ENUMS,
  TEAM_ANALYTICS_PROPERTY_KEYS
} from '@video-compressor/shared';
import type { Json } from '../lib/database.types';
import {
  ANALYTICS_BOOLEAN_KEYS,
  ANALYTICS_NUMERIC_RANGES,
  ANALYTICS_PROPERTY_ENUMS,
  ANALYTICS_PROPERTY_KEYS,
  ANALYTICS_PROPERTY_RULES,
  type AnalyticsPropertyRule
} from './events';

/**
 * 031 FR-048 — the flat description of what the two client sanitizers let
 * through, merged key by key, which the database guard
 * (`analytics_properties_are_safe_v2`) must accept and nothing more. The
 * contract test feeds every entry to the real guard body in PGlite.
 *
 * Where the sanitizers disagree the guard must be the wider one: it sits
 * downstream of both, so a vocabulary is the union and a range is the hull.
 */
export interface AnalyticsGuardContractEntry {
  key: string;
  /** How the web sanitizer treats the key; absent for a team-only key. */
  kind: AnalyticsPropertyRule['kind'] | null;
  /** The closed vocabulary, when the key has one in either sanitizer. */
  enum: readonly string[] | null;
  boolean: boolean;
  /** The closed numeric range, when the key has one in either sanitizer. */
  range: readonly [number, number] | null;
  /** One value the guard must accept for this key. */
  representative: Json;
}

const EVENT_LIST_SAMPLE = 'home_viewed,tool_opened';
const OPAQUE_ID_SAMPLE = 'abc123';
const TOKEN_SAMPLE = 'sample';

function representativeFor(
  kind: AnalyticsPropertyRule['kind'] | null,
  values: readonly string[] | null,
  isBoolean: boolean,
  range: readonly [number, number] | null
): Json {
  if (values) return values[0];
  if (isBoolean) return true;
  if (range) return range[0];
  switch (kind) {
    case 'event_list':
      return EVENT_LIST_SAMPLE;
    case 'id':
      return OPAQUE_ID_SAMPLE;
    default:
      return TOKEN_SAMPLE;
  }
}

export function describeAnalyticsGuardContract(): AnalyticsGuardContractEntry[] {
  const keys = [...new Set([...ANALYTICS_PROPERTY_KEYS, ...TEAM_ANALYTICS_PROPERTY_KEYS])];
  return keys.map(key => {
    const rule: AnalyticsPropertyRule | undefined = Object.prototype.hasOwnProperty.call(
      ANALYTICS_PROPERTY_RULES,
      key
    )
      ? ANALYTICS_PROPERTY_RULES[key as keyof typeof ANALYTICS_PROPERTY_RULES]
      : undefined;
    const webEnum = ANALYTICS_PROPERTY_ENUMS[key];
    const teamEnum = TEAM_ANALYTICS_PROPERTY_ENUMS[key];
    const values =
      webEnum || teamEnum ? [...new Set([...(webEnum ?? []), ...(teamEnum ?? [])])] : null;
    const isBoolean =
      ANALYTICS_BOOLEAN_KEYS.includes(key) || TEAM_ANALYTICS_BOOLEAN_KEYS.includes(key);
    const webRange = ANALYTICS_NUMERIC_RANGES[key];
    const teamRange = TEAM_ANALYTICS_NUMERIC_RANGES[key];
    const range: readonly [number, number] | null =
      webRange && teamRange
        ? [Math.min(webRange[0], teamRange[0]), Math.max(webRange[1], teamRange[1])]
        : (webRange ?? teamRange ?? null);
    const kind = rule?.kind ?? null;
    return {
      key,
      kind,
      enum: values,
      boolean: isBoolean,
      range,
      representative: representativeFor(kind, values, isBoolean, range)
    };
  });
}
