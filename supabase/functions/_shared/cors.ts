/**
 * The installed Agent serves the same authenticated web UI on 43120 (and the
 * isolated beta Agent on 43140). Those origins call Edge Functions directly,
 * so they need the same narrow local CORS allowance as Vite development.
 */
const LOCAL_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:43120',
  'http://localhost:43120',
  'http://127.0.0.1:43140',
  'http://localhost:43140'
]);

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function allowedBrowserOrigins(siteUrl = Deno.env.get('WISHLY_SITE_URL')): Set<string> {
  const origins = new Set(LOCAL_ORIGINS);
  const configured = normalizeOrigin(siteUrl);
  if (configured) origins.add(configured);
  return origins;
}

export function corsHeadersForRequest(
  request: Request,
  siteUrl = Deno.env.get('WISHLY_SITE_URL')
): Record<string, string> | null {
  const origin = normalizeOrigin(request.headers.get('origin'));
  if (!origin || !allowedBrowserOrigins(siteUrl).has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers':
      'authorization, apikey, content-type, content-range, range, x-client-info, x-idempotency-key, x-wishly-transfer-grant, x-wishly-upload-session',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export function corsPreflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const headers = corsHeadersForRequest(request);
  return headers
    ? new Response(null, { status: 204, headers })
    : new Response(null, { status: 403 });
}
