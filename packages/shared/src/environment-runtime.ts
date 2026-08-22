/**
 * Browser-safe environment helpers.
 *
 * Packaging identities live in environment.ts. Keeping them out of this
 * module lets production web builds validate their environment without
 * embedding beta bundle IDs, ports, or support-directory names.
 */
export type AppEnvironment = 'production' | 'beta';

export const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['production', 'beta'];

export type ParsedAppEnvironment =
  { ok: true; value: AppEnvironment } | { ok: false; error: string };

/**
 * Parses an untrusted environment value. Comparison is exact and
 * case-sensitive: a near miss must not silently enable beta behaviour.
 */
export function parseAppEnvironment(value: unknown): ParsedAppEnvironment {
  if (value === undefined || value === null) return { ok: true, value: 'production' };
  if (typeof value !== 'string') return { ok: false, error: 'environment must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: 'production' };
  if (trimmed === 'production' || trimmed === 'beta') return { ok: true, value: trimmed };
  return { ok: false, error: `unknown environment ${JSON.stringify(trimmed)}` };
}

/** Convenience for call sites that must fail closed without branching. */
export function appEnvironmentOrProduction(value: unknown): AppEnvironment {
  const parsed = parseAppEnvironment(value);
  return parsed.ok ? parsed.value : 'production';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when the value is an absolute URL served from this machine only. */
export function isLoopbackOrigin(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * True when the value points anywhere off this machine. An unparseable value
 * counts as production because a guard must prove an endpoint is local.
 */
export function isProductionEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !isLoopbackOrigin(trimmed);
}
