import { hasProductionSignal } from './auth.ts';

/**
 * Where Google sends people back to, on the production site's own domain.
 *
 * Google's brand verification asks that every domain in the OAuth client be one
 * the project owner has verified in Search Console. `<ref>.supabase.co` is on the
 * Public Suffix List, so Google treats it as a domain of its own, and nobody but
 * Supabase can verify it. Both returns therefore land on the site first: the
 * sign-in callback is a page of the app, and the Drive callback is a page that
 * forwards its query to the Edge Function unchanged.
 */
export const SIGN_IN_CALLBACK_PATH = '/auth/callback';
export const DRIVE_CALLBACK_PATH = '/oauth/drive/callback';

export type GoogleRedirectEnvironment = Readonly<{
  SUPABASE_URL?: string;
  WISHLY_SITE_URL?: string;
  GOOGLE_REDIRECT_URI?: string;
}>;

function siteOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The Drive authorization's redirect URI. The authorization start and the code
 * exchange must send the same string, so both read it here.
 *
 * Production always returns through the site. Elsewhere the configured value
 * stays in charge: the beta's Google test client is registered against the
 * local function URL, and nothing about verification applies to it.
 */
export function driveRedirectUri(environment: GoogleRedirectEnvironment): string | null {
  const site = siteOrigin(environment.WISHLY_SITE_URL);
  if (site && hasProductionSignal({ siteUrl: site })) return `${site}${DRIVE_CALLBACK_PATH}`;
  if (environment.GOOGLE_REDIRECT_URI) return environment.GOOGLE_REDIRECT_URI;
  if (!environment.SUPABASE_URL) return null;
  return `${environment.SUPABASE_URL.replace(/\/$/u, '')}/functions/v1/drive-oauth-callback`;
}

/** The sign-in redirect URI: the app's own callback page on the configured site. */
export function signInRedirectUri(environment: GoogleRedirectEnvironment): string | null {
  const site = siteOrigin(environment.WISHLY_SITE_URL);
  return site ? `${site}${SIGN_IN_CALLBACK_PATH}` : null;
}
