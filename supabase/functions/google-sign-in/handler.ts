/**
 * Google sign-in that returns to the site, not to `<ref>.supabase.co`.
 *
 * Supabase's hosted Google provider registers its own `/auth/v1/callback` with
 * Google, and that host cannot pass brand verification (see
 * `_shared/google-redirect.ts`). This function runs the same authorization-code
 * flow with PKCE against the site's `/auth/callback`, exchanges the code with
 * the client secret it already holds for Drive, and hands the browser the ID
 * token only. The browser then signs in with `signInWithIdToken`, so the
 * account, its identity row and the session are exactly the ones Supabase would
 * have produced.
 *
 * It takes over only when the Drive client is the client Supabase itself trusts
 * for Google. Otherwise Supabase would reject the token's audience after the
 * person had already consented, so the answer is `legacy` and the browser keeps
 * the provider redirect it always used. Nobody is locked out by a console step
 * done in the wrong order.
 */

export const SIGN_IN_SCOPES = 'openid email profile';

export type SignInStartInput = {
  codeChallenge: string;
  nonceHash: string;
  state: string;
};

export type SignInExchangeInput = {
  code: string;
  codeVerifier: string;
};

export type SignInStartResult =
  { mode: 'direct'; authorizationUrl: string } | { mode: 'legacy'; reason: SignInLegacyReason };

export type SignInLegacyReason = 'not_configured' | 'client_mismatch' | 'provider_unreachable';

export type SignInDependencies = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string | null;
  /** The client ID Supabase's Google provider sends people to Google with. */
  providerClientId: () => Promise<string | null>;
  exchangeCode: (body: URLSearchParams) => Promise<{ status: number; payload: unknown }>;
};

export class SignInError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'EXPIRED' | 'UNAVAILABLE' | 'INVALID_RESPONSE',
    readonly status: number
  ) {
    super(code);
    this.name = 'SignInError';
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function base64Url(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' && value.length >= min && value.length <= max && BASE64URL.test(value)
  );
}

export function parseStartInput(body: Record<string, unknown>): SignInStartInput {
  const { codeChallenge, nonceHash, state } = body;
  // An S256 challenge is 43 characters; a SHA-256 nonce digest is 64 hex digits.
  if (
    !base64Url(codeChallenge, 43, 43) ||
    typeof nonceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(nonceHash) ||
    !base64Url(state, 22, 128)
  ) {
    throw new SignInError('INVALID_INPUT', 400);
  }
  return { codeChallenge, nonceHash, state };
}

export function parseExchangeInput(body: Record<string, unknown>): SignInExchangeInput {
  const { code, codeVerifier } = body;
  if (typeof code !== 'string' || code.length < 1 || code.length > 4096) {
    throw new SignInError('INVALID_INPUT', 400);
  }
  if (!base64Url(codeVerifier, 43, 128)) throw new SignInError('INVALID_INPUT', 400);
  return { code, codeVerifier };
}

export async function startSignIn(
  input: SignInStartInput,
  dependencies: SignInDependencies
): Promise<SignInStartResult> {
  const { clientId, clientSecret, redirectUri } = dependencies;
  if (!clientId || !clientSecret || !redirectUri)
    return { mode: 'legacy', reason: 'not_configured' };
  let providerClientId: string | null;
  try {
    providerClientId = await dependencies.providerClientId();
  } catch {
    providerClientId = null;
  }
  if (!providerClientId) return { mode: 'legacy', reason: 'provider_unreachable' };
  if (providerClientId !== clientId) return { mode: 'legacy', reason: 'client_mismatch' };

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SIGN_IN_SCOPES);
  url.searchParams.set('state', input.state);
  // Supabase compares the token's nonce with the SHA-256 of the one the browser
  // keeps, so Google is given the digest and the browser the original.
  url.searchParams.set('nonce', input.nonceHash);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { mode: 'direct', authorizationUrl: url.toString() };
}

export async function exchangeSignInCode(
  input: SignInExchangeInput,
  dependencies: SignInDependencies
): Promise<{ idToken: string }> {
  const { clientId, clientSecret, redirectUri } = dependencies;
  if (!clientId || !clientSecret || !redirectUri) throw new SignInError('UNAVAILABLE', 503);
  let answer: { status: number; payload: unknown };
  try {
    answer = await dependencies.exchangeCode(
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    );
  } catch {
    throw new SignInError('UNAVAILABLE', 503);
  }
  const payload =
    answer.payload && typeof answer.payload === 'object'
      ? (answer.payload as Record<string, unknown>)
      : null;
  if (answer.status < 200 || answer.status >= 300) {
    if (payload?.error === 'invalid_grant') throw new SignInError('EXPIRED', 409);
    throw new SignInError('UNAVAILABLE', 503);
  }
  // Only the ID token leaves: the access token would be a Google credential in
  // the browser for no purpose the sign-in has.
  const idToken = payload?.id_token;
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new SignInError('INVALID_RESPONSE', 502);
  }
  return { idToken };
}

/** Reads `client_id` from the provider redirect Supabase's authorize endpoint answers with. */
export function clientIdFromAuthorizeRedirect(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.hostname !== 'accounts.google.com') return null;
    return url.searchParams.get('client_id');
  } catch {
    return null;
  }
}
