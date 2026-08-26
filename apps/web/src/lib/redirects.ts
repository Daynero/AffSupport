import { webTools } from './tool-registry';

/**
 * Where a completed sign-in may return to. `/auth/handoff` is on the list because
 * the website signs in *on behalf of* the Agent's copy of the app: the sign-in it
 * is sent to must be able to come back and finish handing the session over.
 *
 * The tool paths are read from the registry rather than repeated here. Written
 * out by hand, this list said `/compressor` and nothing else, so a deep link to
 * the transcription tool, the landing optimiser or the landing previewer was
 * quietly downgraded to `/` at sign-in: the person arrived at the home page
 * having asked for a tool, with nothing on screen explaining why. Three of the
 * four tools, for as long as the two lists had been apart.
 */
export const protectedPaths = [
  '/',
  '/account',
  '/admin',
  '/auth/handoff',
  ...webTools.map(tool => tool.path)
] as const;
export type ProtectedPath = (typeof protectedPaths)[number];

const RETURN_PATH_KEY = 'wishly.auth.return-path.v1';

export function safeReturnPath(candidate: string | null | undefined): ProtectedPath | string {
  if (!candidate) return '/';
  try {
    const base = new URL('https://wishly.invalid');
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin) return '/';
    if (!protectedPaths.includes(parsed.pathname as ProtectedPath)) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

export function rememberReturnPath(candidate: string | null | undefined) {
  const path = safeReturnPath(candidate);
  sessionStorage.setItem(RETURN_PATH_KEY, path);
  return path;
}

export function takeReturnPath() {
  const path = safeReturnPath(sessionStorage.getItem(RETURN_PATH_KEY));
  sessionStorage.removeItem(RETURN_PATH_KEY);
  return path;
}

export function loginUrl(returnPath: string) {
  return `/login?returnTo=${encodeURIComponent(safeReturnPath(returnPath))}`;
}

export function clearReturnPath() {
  sessionStorage.removeItem(RETURN_PATH_KEY);
}
