export const protectedPaths = ['/', '/compressor', '/account', '/admin'] as const;
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
