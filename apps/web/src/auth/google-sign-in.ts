/**
 * The browser half of `supabase/functions/google-sign-in`.
 *
 * Google returns to this site's `/auth/callback` instead of to Supabase, which is
 * what lets the OAuth client carry only a domain the owner can verify. The page
 * keeps the PKCE verifier, the state and the raw nonce for the length of one
 * round trip; the function exchanges the code; Supabase signs in with the ID
 * token. When the function says `legacy` — or cannot be reached at all — the
 * caller falls back to the provider redirect, so sign-in never depends on this
 * path being ready.
 */

const STORAGE_KEY = 'soty.google-sign-in.v1';
const FLOW_LIFETIME_MS = 15 * 60 * 1000;

type StoredFlow = { state: string; verifier: string; nonce: string; createdAt: number };

export type GoogleSignInEndpoint = { supabaseUrl: string; publishableKey: string };

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomToken(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function call<T>(endpoint: GoogleSignInEndpoint, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${endpoint.supabaseUrl}/functions/v1/google-sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: endpoint.publishableKey },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => null)) as
    { ok: true; value: T } | { ok: false; error?: { code?: string } } | null;
  if (!response.ok || !payload || !payload.ok) {
    throw new Error(
      payload && !payload.ok ? (payload.error?.code ?? 'UNAVAILABLE') : 'UNAVAILABLE'
    );
  }
  return payload.value;
}

/**
 * Asks the function for a Google authorization URL. Returns it when this path is
 * ready, or null when the caller should use the provider redirect instead.
 */
export async function beginGoogleSignIn(endpoint: GoogleSignInEndpoint): Promise<string | null> {
  const flow: StoredFlow = {
    state: randomToken(32),
    verifier: randomToken(48),
    nonce: randomToken(32),
    createdAt: Date.now()
  };
  try {
    const result = await call<{ mode: 'direct'; authorizationUrl: string } | { mode: 'legacy' }>(
      endpoint,
      {
        action: 'start',
        state: flow.state,
        codeChallenge: base64Url(await sha256(flow.verifier)),
        nonceHash: hex(await sha256(flow.nonce))
      }
    );
    if (result.mode !== 'direct') return null;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(flow));
    return result.authorizationUrl;
  } catch {
    return null;
  }
}

function readFlow(): StoredFlow | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as StoredFlow | null;
    if (!parsed || typeof parsed.state !== 'string') return null;
    if (Date.now() - parsed.createdAt > FLOW_LIFETIME_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether this callback belongs to a sign-in this tab started. Supabase's own
 * redirect arrives with a `code` and no `state`, so the two never collide.
 */
export function isDirectGoogleCallback(params: URLSearchParams): boolean {
  const state = params.get('state');
  return Boolean(state && readFlow()?.state === state);
}

/** Exchanges the code for an ID token and returns it with the nonce Supabase must see. */
export async function finishGoogleSignIn(
  endpoint: GoogleSignInEndpoint,
  code: string
): Promise<{ idToken: string; nonce: string }> {
  const flow = readFlow();
  sessionStorage.removeItem(STORAGE_KEY);
  if (!flow) throw new Error('WRONG_STATE');
  const { idToken } = await call<{ idToken: string }>(endpoint, {
    action: 'exchange',
    code,
    codeVerifier: flow.verifier
  });
  return { idToken, nonce: flow.nonce };
}

export function forgetGoogleSignIn(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
