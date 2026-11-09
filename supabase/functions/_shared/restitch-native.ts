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
