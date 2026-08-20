/**
 * Carrying one sign-in from the website to the Agent's own copy of the app.
 *
 * The packaged app is deliberately served by the Agent on loopback rather than
 * loaded from the website: that keeps the interface and the Agent on one build,
 * and it sidesteps the browser's private-network prompt. The cost is a second
 * origin, and an origin is a storage boundary — `http://127.0.0.1:43120` cannot
 * see the Supabase session sitting in `https://soty.pp.ua`'s localStorage. So a
 * user who had just signed in on the website was met by the sign-in screen the
 * moment the tray opened the app, and signing in there did not help either: the
 * OAuth callback is registered against the website, so the exchange completed on
 * the *website's* origin and the app was still signed out. "Open Soty" led back
 * to sign-in every time.
 *
 * The website stays the one origin that signs in — no second callback URL to
 * register, no second place for a session to expire — and the app asks it for a
 * copy:
 *
 *   app `/auth/handoff?returnTo=<app origin>&next=<path>`  →
 *   website `/auth/handoff` (signing in first if it has to)  →
 *   app `/auth/handoff#access_token=…&refresh_token=…`  →  `setSession`
 *
 * The tokens ride in the fragment, which browsers never put on the wire, and the
 * app clears it from history as soon as it has them. `returnTo` is not taken on
 * trust: the website hands a session only to this installation's own Agent
 * origin, so the redirect cannot be pointed anywhere a session could leak.
 */
import { configuredAgentOrigin, configuredSiteUrl, servedByAgent } from '../lib/config';

export const HANDOFF_PATH = '/auth/handoff';

const ATTEMPT_KEY = 'wishly.auth.handoff-attempt.v1';
const DECLINED_KEY = 'wishly.auth.handoff-declined.v1';
const ATTEMPT_LIMIT = 2;

/**
 * The origin that owns sign-in for this page, or null when this page owns it.
 *
 * Null on the website itself, and null for a build whose site origin *is* the
 * Agent origin (beta packages the two together): there is no second storage area
 * to fetch a session from, and asking would be a redirect to ourselves.
 */
export function sessionHandoffOrigin(): string | null {
  if (!servedByAgent()) return null;
  const site = configuredSiteUrl().replace(/\/$/, '');
  return site && site !== location.origin ? site : null;
}

/** Where the app sends the browser to ask the website for a session. */
export function handoffRequestUrl(next: string): string | null {
  const site = sessionHandoffOrigin();
  if (!site) return null;
  const query = new URLSearchParams({ returnTo: location.origin, next: safeNext(next) });
  return `${site}${HANDOFF_PATH}?${query}`;
}

/**
 * The website's guard on where a session may be delivered.
 *
 * Only this installation's Agent origin qualifies. Anything else — another host,
 * another port, a scheme that is not loopback HTTP — is refused rather than
 * normalised, because the value decides who receives a live session.
 */
export function allowedHandoffReturn(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  let origin: string;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:') return null;
    origin = url.origin;
  } catch {
    return null;
  }
  if (origin !== configuredAgentOrigin() && !servedByAgent(origin)) return null;
  return origin;
}

/** The website's reply: the app's own `/auth/handoff` with the session attached. */
export function handoffDeliveryUrl(
  returnTo: string,
  session: { access_token: string; refresh_token: string },
  next: string | null
): string {
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    next: safeNext(next)
  });
  return `${returnTo}${HANDOFF_PATH}#${fragment}`;
}

/** Reads a delivered session out of the fragment, leaving nothing behind. */
export function takeDeliveredSession(): {
  accessToken: string;
  refreshToken: string;
  next: string;
} | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  const next = safeNext(fragment.get('next'));
  // Replace rather than push: the entry holding the tokens must not be something
  // the back button can return to.
  history.replaceState(null, '', HANDOFF_PATH);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, next };
}

/**
 * Only in-app paths, and only as a path: `next` comes back from another origin,
 * so treating it as a URL would make the app a redirector for whoever set it.
 */
export function safeNext(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.startsWith(HANDOFF_PATH) || candidate.startsWith('/auth/callback')) return '/';
  return candidate;
}

/**
 * Budget for asking without being asked to.
 *
 * The ask is a round trip through another origin, so a session that keeps failing
 * to install would bounce the tab between the two forever. After two tries the
 * app stops asking on its own and shows its sign-in screen, where the button asks
 * again — deliberately, and with the count reset.
 */
export function claimHandoffAttempt(): boolean {
  if (localStorage.getItem(DECLINED_KEY) === '1') return false;
  const attempts = Number(sessionStorage.getItem(ATTEMPT_KEY)) || 0;
  if (attempts >= ATTEMPT_LIMIT) return false;
  sessionStorage.setItem(ATTEMPT_KEY, String(attempts + 1));
  return true;
}

export function releaseHandoffAttempts() {
  sessionStorage.removeItem(ATTEMPT_KEY);
  localStorage.removeItem(DECLINED_KEY);
}

/**
 * Signing out has to stick.
 *
 * Without this, an explicit sign-out in the app would be undone by the next
 * automatic ask, which would find the website's session still live and put the
 * user straight back where they were. It is kept in localStorage rather than per
 * tab because "Open Soty" opens a new tab every time, and a sign-out that lasted
 * only until the next one would not be a sign-out. Asking for sign-in clears it.
 */
export function declineHandoff() {
  localStorage.setItem(DECLINED_KEY, '1');
}
