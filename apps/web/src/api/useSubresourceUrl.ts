import { useEffect, useState } from 'react';
import { subresourceTicket } from './subresource-paths';

/**
 * A subresource URL that carries a capability ticket instead of the session
 * token.
 *
 * Asynchronous because a ticket has to be asked for, which is the one cost of
 * keeping the session token out of URLs.
 *
 * Three answers, not two: `undefined` while the ticket is being asked for, `null` when the
 * answer was no, and the URL when it was yes. Both absences used to be `null`, so a caller
 * could not tell a slow ticket from a refused one — and a refused one put an `<img>` with an
 * empty `src` on screen, which fires neither `load` nor `error`, so the Landing Optimizer's
 * comparison sat on a spinner for ever. A caller that does not care can keep treating both as
 * falsy, which is what every other one here does.
 */
export function useSubresourceUrl(
  path: string | null,
  extra: Record<string, string> = {}
): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  // Serialised rather than passed as an object: a fresh object literal on every
  // render would restart the effect forever.
  const extraKey = JSON.stringify(extra);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    // A path that changed goes back to "asking", so a stale refusal is not read as this
    // path's answer.
    setUrl(undefined);
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
