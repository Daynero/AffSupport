import { useEffect, useState } from 'react';
import { subresourceTicket } from './subresource-paths';

/**
 * A subresource URL that carries a capability ticket instead of the session
 * token.
 *
 * Asynchronous because a ticket has to be asked for, which is the one cost of
 * keeping the session token out of URLs. Returns null until the ticket arrives,
 * so a caller renders whatever it already renders while an image is loading —
 * there is no new state to design for.
 */
export function useSubresourceUrl(
  path: string | null,
  extra: Record<string, string> = {}
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Serialised rather than passed as an object: a fresh object literal on every
  // render would restart the effect forever.
  const extraKey = JSON.stringify(extra);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let active = true;
    void resolve(path, JSON.parse(extraKey) as Record<string, string>).then(next => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
  }, [path, extraKey]);

  return url;
}

/**
 * Builds the ticketed URL, reaching for the origin and token only when a
 * component actually asks for one.
 *
 * Imported dynamically rather than at module load: `client` reads the stored
 * token as soon as it is imported, which needs a DOM — and a component that
 * merely names an image should not drag `localStorage` into a test that renders
 * it to a string. This runs inside an effect, so by then there is a browser.
 */
async function resolve(path: string, extra: Record<string, string>): Promise<string | null> {
  const { agentUrl } = await import('./client');
  const { pairingToken } = await import('./pairing-token');
  const ticket = await subresourceTicket(agentUrl, pairingToken(), path);
  if (!ticket) return null;
  return `${agentUrl}${path}?${new URLSearchParams({ ...extra, ticket }).toString()}`;
}
