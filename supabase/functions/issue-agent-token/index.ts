import { createClient } from 'npm:@supabase/supabase-js@2';

// Issues a short-lived, ECDSA P-256 signed entitlement token that the local
// Wishly Agent verifies offline before performing tool operations. This is the
// server-side half of agent pairing: only signed-in users with an active
// account receive tokens, and blocking an account (profiles.account_status)
// stops new tokens immediately — installed agents lose access once the current
// token plus its offline grace window expires.

const TOKEN_PREFIX = 'wat1';
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function corsHeaders(origin: string | null) {
  const configuredOrigin = Deno.env.get('WISHLY_SITE_URL')?.replace(/\/$/, '');
  const allowed = new Set(
    [configuredOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173'].filter(Boolean)
  );
  if (!origin || !allowed.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin'
  };
}

function response(status: number, body: Record<string, unknown>, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...cors } });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function importSigningKey(pkcs8Base64: string): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(pkcs8Base64), character => character.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign'
  ]);
}

Deno.serve(async request => {
  const cors = corsHeaders(request.headers.get('origin'));
  if (!cors) return new Response('Origin not allowed.', { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, cors);

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer '))
    return response(401, { error: 'Authentication required.' }, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const signingKeyBase64 = Deno.env.get('AGENT_TOKEN_PRIVATE_KEY');
  if (!supabaseUrl || !serviceRoleKey || !signingKeyBase64)
    return response(503, { error: 'Entitlement issuing is not configured.' }, cors);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const jwt = authorization.slice('Bearer '.length);
  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(jwt);
  if (userError || !user) return response(401, { error: 'Session is no longer valid.' }, cors);

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('plan, account_status')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) return response(500, { error: 'Profile lookup failed.' }, cors);
  if (!profile || profile.account_status !== 'active')
    return response(403, { error: 'Account is not entitled.' }, cors);

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub: user.id,
    plan: profile.plan,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS
  };
  const payloadEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signedPart = `${TOKEN_PREFIX}.${payloadEncoded}`;

  let signature: ArrayBuffer;
  try {
    const key = await importSigningKey(signingKeyBase64);
    signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signedPart)
    );
  } catch {
    return response(503, { error: 'Entitlement signing key is invalid.' }, cors);
  }

  return response(
    200,
    {
      token: `${signedPart}.${base64UrlEncode(new Uint8Array(signature))}`,
      expiresAt: new Date(payload.exp * 1000).toISOString()
    },
    cors
  );
});
