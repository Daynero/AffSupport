import { PRODUCTION_BACKEND_ORIGIN } from '../../../packages/shared/dist/release.js';

/**
 * Whether the native restitch and catalog video routes answer.
 *
 * Shipped to production in 1.4.1: a production stack (SOTY_ENVIRONMENT unset
 * or `production`) answers unconditionally. A beta stack keeps the isolation
 * rule it always had -- the routes answer only when the stack is provably the
 * local one -- so a beta that merely resembles production cannot exercise them
 * against real data. Any other environment value answers nothing.
 */
export function nativeRestitchEnabled(input: {
  enabled: unknown;
  environment: unknown;
  oauthMode: unknown;
  siteUrl: unknown;
}): boolean {
  if (input.environment === undefined || input.environment === 'production') return true;
  if (input.environment === 'beta') return nativeRestitchBetaIsolated(input);
  return false;
}

/** The isolated-beta rule: an explicit switch, the beta environment, testing
 * OAuth and the exact loopback web origin. Experiments that stay beta-only
 * (CATALOG_NATIVE_SHEETS_BETA) still require all of it. */
export function nativeRestitchBetaIsolated(input: {
  enabled: unknown;
  environment: unknown;
  oauthMode: unknown;
  siteUrl: unknown;
}): boolean {
  if (
    input.enabled !== 'true' ||
    input.environment !== 'beta' ||
    input.oauthMode !== 'testing' ||
    typeof input.siteUrl !== 'string'
  )
    return false;
  try {
    return new URL(input.siteUrl).origin === 'http://127.0.0.1:5175';
  } catch {
    return false;
  }
}

const BETA_FUNCTION_ORIGIN = 'http://127.0.0.1:54321';

/** Where an agent reaches the Edge functions for catalog video work. A beta agent
 * stays on the local stack; a production agent must get the hosted origin, never the
 * beta loopback (1.4.1 sent loopback URLs to production agents, which refused them
 * locally as PERMISSION_DENIED before any byte was requested). */
export function catalogVideoFunctionBase(environment: unknown): string {
  return (
    (environment === 'beta' ? BETA_FUNCTION_ORIGIN : PRODUCTION_BACKEND_ORIGIN) + '/functions/v1'
  );
}

/** The only origins a process grant may name for an agent. */
export function isCatalogVideoFunctionOrigin(origin: string): boolean {
  return origin === BETA_FUNCTION_ORIGIN || origin === PRODUCTION_BACKEND_ORIGIN;
}

/** Whether the targeted catalog cell writer (video-link publication and
 * non-video updates written as typed cells) answers. Production answers
 * unconditionally since 1.4.2: before that every due deferred publication was
 * blocked as writer_unsupported there. A beta keeps its explicit opt-in
 * (CATALOG_NATIVE_SHEETS_BETA) on top of the isolation rule. */
export function targetedCatalogWriterEnabled(input: {
  enabled: unknown;
  variants: unknown;
  environment: unknown;
  oauthMode: unknown;
  siteUrl: unknown;
}): boolean {
  if (input.environment === undefined || input.environment === 'production') return true;
  if (input.environment === 'beta')
    return (
      input.enabled === 'true' &&
      nativeRestitchBetaIsolated({
        enabled: input.variants,
        environment: input.environment,
        oauthMode: input.oauthMode,
        siteUrl: input.siteUrl
      })
    );
  return false;
}
