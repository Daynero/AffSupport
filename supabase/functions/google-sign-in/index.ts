import { corsHeadersForRequest } from '../_shared/cors.ts';
import { signInRedirectUri } from '../_shared/google-redirect.ts';
import {
  SignInError,
  clientIdFromAuthorizeRedirect,
  exchangeSignInCode,
  parseExchangeInput,
  parseStartInput,
  startSignIn,
  type SignInDependencies
} from './handler.ts';

const PROVIDER_LOOKUP_TTL_MS = 10 * 60 * 1000;
let providerLookup: { clientId: string | null; at: number } | null = null;

/**
 * Supabase publishes no setting for this, but its authorize endpoint answers
 * with the Google URL it would send a person to, and the client ID is in it.
 */
async function providerClientId(): Promise<string | null> {
  if (providerLookup && Date.now() - providerLookup.at < PROVIDER_LOOKUP_TTL_MS) {
    return providerLookup.clientId;
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return null;
  const response = await fetch(
    `${supabaseUrl.replace(/\/$/u, '')}/auth/v1/authorize?provider=google`,
    { redirect: 'manual', signal: AbortSignal.timeout(5_000) }
  );
  await response.body?.cancel();
  const clientId = clientIdFromAuthorizeRedirect(response.headers.get('location'));
  providerLookup = { clientId, at: Date.now() };
  return clientId;
}

function dependencies(): SignInDependencies {
  return {
    clientId: Deno.env.get('GOOGLE_CLIENT_ID'),
    clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET'),
    redirectUri: signInRedirectUri({ WISHLY_SITE_URL: Deno.env.get('WISHLY_SITE_URL') }),
    providerClientId,
    exchangeCode: async body => {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000)
      });
      return { status: response.status, payload: await response.json().catch(() => null) };
    }
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

Deno.serve(async request => {
  const cors = corsHeadersForRequest(request);
  if (!cors) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST')
    return json(405, { ok: false, error: { code: 'INVALID_INPUT' } }, cors);

  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new SignInError('INVALID_INPUT', 400);
    const record = body as Record<string, unknown>;
    if (record.action === 'start') {
      return json(
        200,
        { ok: true, value: await startSignIn(parseStartInput(record), dependencies()) },
        cors
      );
    }
    if (record.action === 'exchange') {
      return json(
        200,
        { ok: true, value: await exchangeSignInCode(parseExchangeInput(record), dependencies()) },
        cors
      );
    }
    throw new SignInError('INVALID_INPUT', 400);
  } catch (error) {
    const known = error instanceof SignInError ? error : new SignInError('UNAVAILABLE', 503);
    return json(known.status, { ok: false, error: { code: known.code } }, cors);
  }
});
