/** An isolated beta may exercise the unfinished native path. Production cannot
 * activate it merely by sending a header or setting the feature switch. */
export function nativeRestitchBetaEnabled(input: {
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
