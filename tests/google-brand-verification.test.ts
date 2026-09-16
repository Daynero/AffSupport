import { describe, expect, it, vi } from 'vitest';
import {
  DRIVE_CALLBACK_PATH,
  driveRedirectUri,
  signInRedirectUri
} from '../supabase/functions/_shared/google-redirect';
import {
  SignInError,
  clientIdFromAuthorizeRedirect,
  exchangeSignInCode,
  parseExchangeInput,
  parseStartInput,
  startSignIn,
  type SignInDependencies
} from '../supabase/functions/google-sign-in/handler';
import { evaluateTeamProviderReadiness } from '../supabase/functions/drive-connect/readiness';
import { staticPublicPages } from '../apps/web/src/static-public-pages';

/**
 * Google brand verification accepts only domains the owner verified in Search
 * Console, and `<ref>.supabase.co` is on the Public Suffix List, so it can never
 * be one. Everything the Google client names has to be on the site.
 */

const production = 'https://soty.pp.ua';
const beta = 'http://127.0.0.1:5175';
const functionCallback = 'https://project.supabase.co/functions/v1/drive-oauth-callback';

describe('the Drive redirect URI', () => {
  it('returns through the production site whatever the configured value says', () => {
    expect(
      driveRedirectUri({
        WISHLY_SITE_URL: production,
        GOOGLE_REDIRECT_URI: functionCallback,
        SUPABASE_URL: 'https://project.supabase.co'
      })
    ).toBe(`${production}${DRIVE_CALLBACK_PATH}`);
  });

  it('keeps the configured value outside production, where the test client is registered', () => {
    expect(
      driveRedirectUri({
        WISHLY_SITE_URL: beta,
        GOOGLE_REDIRECT_URI: 'http://127.0.0.1:54321/functions/v1/drive-oauth-callback'
      })
    ).toBe('http://127.0.0.1:54321/functions/v1/drive-oauth-callback');
    expect(driveRedirectUri({ SUPABASE_URL: 'http://127.0.0.1:54321/' })).toBe(
      'http://127.0.0.1:54321/functions/v1/drive-oauth-callback'
    );
    expect(driveRedirectUri({})).toBeNull();
  });

  it('is what readiness reports and accepts', () => {
    const readiness = evaluateTeamProviderReadiness(
      {
        DRIVE_OAUTH_MODE: 'verified',
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        GOOGLE_REDIRECT_URI: functionCallback,
        WISHLY_SITE_URL: production,
        RESEND_API_KEY: 'resend-api-key',
        INVITE_EMAIL_FROM: 'Soty <team@example.test>',
        CATALOG_SYNC_SECRET: 'c'.repeat(32)
      },
      { siteUrl: production, requestOrigin: production }
    );
    expect(readiness.redirectUri).toBe(`${production}${DRIVE_CALLBACK_PATH}`);
    expect(readiness.services.googleDrive).toBe(true);
  });
});

describe('the sign-in redirect URI', () => {
  it('is the app callback page on the configured site', () => {
    expect(signInRedirectUri({ WISHLY_SITE_URL: `${production}/` })).toBe(
      `${production}/auth/callback`
    );
    expect(signInRedirectUri({})).toBeNull();
  });
});

const challenge = 'a'.repeat(43);
const nonceHash = 'f'.repeat(64);
const state = 'S'.repeat(43);

function dependencies(overrides: Partial<SignInDependencies> = {}): SignInDependencies {
  return {
    clientId: '1234-web.apps.googleusercontent.com',
    clientSecret: 'secret',
    redirectUri: `${production}/auth/callback`,
    providerClientId: async () => '1234-web.apps.googleusercontent.com',
    exchangeCode: async () => ({ status: 200, payload: { id_token: 'h.p.s', access_token: 'x' } }),
    ...overrides
  };
}

describe('google-sign-in start', () => {
  it('validates what the browser sends', () => {
    expect(parseStartInput({ codeChallenge: challenge, nonceHash, state })).toEqual({
      codeChallenge: challenge,
      nonceHash,
      state
    });
    for (const body of [
      { codeChallenge: 'short', nonceHash, state },
      { codeChallenge: challenge, nonceHash: 'NOT-HEX', state },
      { codeChallenge: challenge, nonceHash, state: 'x' },
      { codeChallenge: challenge, nonceHash, state: 'has spaces and more than enough characters' }
    ]) {
      expect(() => parseStartInput(body)).toThrow(SignInError);
    }
    expect(() => parseExchangeInput({ code: '', codeVerifier: 'v'.repeat(64) })).toThrow(
      SignInError
    );
    expect(() => parseExchangeInput({ code: 'c', codeVerifier: 'short' })).toThrow(SignInError);
  });

  it('builds a PKCE authorization that returns to the site', async () => {
    const result = await startSignIn(
      { codeChallenge: challenge, nonceHash, state },
      dependencies()
    );
    expect(result.mode).toBe('direct');
    const url = new URL((result as { authorizationUrl: string }).authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1234-web.apps.googleusercontent.com',
      redirect_uri: `${production}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce: nonceHash,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
  });

  it('leaves sign-in to Supabase unless Supabase trusts the same client', async () => {
    const input = { codeChallenge: challenge, nonceHash, state };
    await expect(startSignIn(input, dependencies({ clientSecret: undefined }))).resolves.toEqual({
      mode: 'legacy',
      reason: 'not_configured'
    });
    await expect(
      startSignIn(input, dependencies({ providerClientId: async () => 'other-client' }))
    ).resolves.toEqual({ mode: 'legacy', reason: 'client_mismatch' });
    await expect(
      startSignIn(
        input,
        dependencies({
          providerClientId: async () => {
            throw new Error('offline');
          }
        })
      )
    ).resolves.toEqual({ mode: 'legacy', reason: 'provider_unreachable' });
  });

  it('reads the provider client from the authorize redirect and nothing else', () => {
    expect(
      clientIdFromAuthorizeRedirect(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-web.apps.googleusercontent.com&scope=email'
      )
    ).toBe('1234-web.apps.googleusercontent.com');
    expect(clientIdFromAuthorizeRedirect('https://evil.example/?client_id=1234')).toBeNull();
    expect(clientIdFromAuthorizeRedirect(null)).toBeNull();
  });
});

describe('google-sign-in exchange', () => {
  it('sends the same redirect URI and returns the ID token alone', async () => {
    const exchangeCode = vi.fn(async (_body: URLSearchParams) => ({
      status: 200,
      payload: {
        id_token: 'header.payload.signature',
        access_token: 'ya29.secret',
        refresh_token: 'r'
      }
    }));
    const result = await exchangeSignInCode(
      { code: 'code', codeVerifier: 'v'.repeat(64) },
      dependencies({ exchangeCode })
    );
    expect(result).toEqual({ idToken: 'header.payload.signature' });
    const body = exchangeCode.mock.calls[0]![0];
    expect(body.get('redirect_uri')).toBe(`${production}/auth/callback`);
    expect(body.get('code_verifier')).toBe('v'.repeat(64));
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('maps a spent code and a malformed answer to their own errors', async () => {
    const input = { code: 'code', codeVerifier: 'v'.repeat(64) };
    await expect(
      exchangeSignInCode(
        input,
        dependencies({
          exchangeCode: async () => ({ status: 400, payload: { error: 'invalid_grant' } })
        })
      )
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(
      exchangeSignInCode(
        input,
        dependencies({ exchangeCode: async () => ({ status: 200, payload: {} }) })
      )
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(
      exchangeSignInCode(input, dependencies({ redirectUri: null }))
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('the static public pages', () => {
  const index =
    '<!doctype html><html lang="uk"><head><title>Soty — Твій помічник</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>';

  it('writes the homepage, privacy and terms with readable bodies and the app untouched', () => {
    const pages = staticPublicPages(index, 'support@example.test');
    expect(pages.map(page => page.fileName)).toEqual(['index.html', 'privacy.html', 'terms.html']);
    for (const page of pages) {
      expect(page.html).toContain('<div id="root"></div>');
      expect(page.html).toContain('<script type="module" src="/assets/index.js"></script>');
      expect(page.html).toContain('<a href="/privacy">Privacy Policy</a>');
    }
    const privacy = pages[1]!.html;
    expect(privacy).toContain('<title>Privacy Policy — Soty</title>');
    expect(privacy).toContain('<section id="google-drive">');
    expect(privacy).toContain('Limited Use');
    expect(privacy).toContain('mailto:support@example.test');
    expect(pages[0]!.html).toContain('<title>Soty — Твій помічник</title>');
  });

  it('refuses an index without the mount point or a missing support email', () => {
    expect(() => staticPublicPages('<html></html>', 'support@example.test')).toThrow();
    expect(() => staticPublicPages(index, '')).toThrow();
  });
});
