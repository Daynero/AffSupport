/**
 * Keeps provider thumbnail URLs private by deriving the authenticated Edge
 * relay from the already-authorized range URL.
 */
export function thumbnailRelayUrl(rangeUrl: string): string | null {
  try {
    const url = new URL(rangeUrl);
    if (!/^https?:$/u.test(url.protocol) || !url.pathname.endsWith('/range')) return null;
    url.pathname = `${url.pathname.slice(0, -'/range'.length)}/thumbnail`;
    return url.toString();
  } catch {
    return null;
  }
}
