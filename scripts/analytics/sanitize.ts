/**
 * 031 FR-055 — the CLI returns event properties only through the client's own
 * allowlist, so `journey`, `inspect`, `run` and `diagnose` can never print a key
 * the browser would have refused to send. The allowlist is imported from the
 * client (`ANALYTICS_PROPERTY_KEYS`), not mirrored, so the two cannot drift.
 *
 * The import is type-erased apart from two frozen arrays; `events.ts` pulls the
 * shared contract only, never React or the DOM.
 */
import {
  ANALYTICS_PROPERTY_KEYS,
  analyticsEventNames
} from '../../apps/web/src/analytics/events.js';

const ALLOWED_KEYS: ReadonlySet<string> = new Set(ANALYTICS_PROPERTY_KEYS);

/** The database guard refuses these in any value; a stored row cannot carry them, but the CLI checks again. */
const SECRET_VALUE = /bearer|oauth|token=|authorization/i;
const PATH_LIKE = /[/\\]/;

export type SanitizedProperties = Record<string, string | number | boolean>;

/**
 * Keep allowlisted keys with primitive values; drop nested structures, path-like
 * strings and anything that smells like a credential. Idempotent and total: a
 * non-object input yields `{}`.
 */
export function sanitizeEventProperties(input: unknown): SanitizedProperties {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: SanitizedProperties = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'string' && !SECRET_VALUE.test(value) && !PATH_LIKE.test(value)) {
      output[key] = value.length > 128 ? value.slice(0, 128) : value;
    }
  }
  return output;
}

/** Every event name the client can send today, as a plain set for lookups. */
export const CLIENT_EVENT_NAMES: ReadonlySet<string> = new Set<string>(analyticsEventNames);
