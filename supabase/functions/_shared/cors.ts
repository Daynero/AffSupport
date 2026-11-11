import {
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN
} from '../../../packages/shared/dist/release.js';

/**
 * The installed Agent serves the same authenticated web UI on 43120 (and the
 * isolated beta Agent on 43140). Those origins call Edge Functions directly,
 * so they need the same narrow local CORS allowance as Vite development.
 */
const LOCAL_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5175',
  'http://localhost:5175',
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
  // 051: the candidate address is the same production, so it is trusted exactly
  // when the configured site is production -- never in beta, never as a wildcard.
  if (configured === PRODUCTION_SITE_ORIGIN) origins.add(PREVIEW_SITE_ORIGIN);
  return origins;
}

/**
 * The site a browser flow should return to: the candidate address when the flow
 * started there and the configured site is production, otherwise the configured
 * site. Only these two exact origins can ever be chosen.
 */
export function returnSiteOrigin(
  siteUrl: string | null | undefined,
  startedFrom: string | null | undefined
): string | null {
  const configured = normalizeOrigin(siteUrl);
  if (configured === PRODUCTION_SITE_ORIGIN && normalizeOrigin(startedFrom) === PREVIEW_SITE_ORIGIN)
    return PREVIEW_SITE_ORIGIN;
  return configured;
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
