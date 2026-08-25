import { useEffect, useState } from 'react';
import { ticketedUrl } from './client';

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
    void ticketedUrl(path, JSON.parse(extraKey) as Record<string, string>).then(next => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
  }, [path, extraKey]);

  return url;
}
