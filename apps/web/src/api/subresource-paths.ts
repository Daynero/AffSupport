/**
 * Paths of the subresources the browser fetches for itself.
 *
 * Separate from `client.ts` on purpose. That module reads the stored pairing
 * token at import time, so anything importing it needs a DOM — and a component
 * that only wants to name an image should not drag `localStorage` into a test
 * that renders it to a string. These are pure functions over their arguments.
 *
 * Pair them with `useSubresourceUrl`, which turns a path into a ticketed URL.
 */

export function imageContentPath(id: string): string {
  return `/api/images/${encodeURIComponent(id)}/content`;
}

export function landingPreviewPath(
  jobId: string,
  assetId: string,
  side: 'before' | 'after'
): string {
  return `/api/landing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(
    assetId
  )}/preview/${side}`;
}

export function transcriptionMediaPath(id: string): string {
  return `/api/transcription/jobs/${encodeURIComponent(id)}/media`;
}

/**
 * A short-lived ticket for one subresource, cached until it is nearly expired.
 *
 * Lives here rather than in `client.ts` because the token is read at call time,
 * not at import time — which is what lets a component that renders an image be
 * tested without a DOM. Cached because a gallery renders the same image
 * repeatedly and a video seeks within one file; refreshed a minute early so a
 * request never leaves with a ticket that expires in flight.
 */
const ticketCache = new Map<string, { ticket: string; expiresAt: number }>();
const TICKET_REFRESH_MARGIN_MS = 60_000;

export async function subresourceTicket(
  agentOrigin: string,
  token: string,
  path: string
): Promise<string | null> {
  const cached = ticketCache.get(path);
  if (cached && cached.expiresAt - TICKET_REFRESH_MARGIN_MS > Date.now()) return cached.ticket;
  try {
    const response = await fetch(`${agentOrigin}/api/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ path })
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { ticket?: unknown; expiresInMs?: unknown };
    if (typeof body.ticket !== 'string') return null;
    const lifetime = typeof body.expiresInMs === 'number' ? body.expiresInMs : 5 * 60_000;
    ticketCache.set(path, { ticket: body.ticket, expiresAt: Date.now() + lifetime });
    return body.ticket;
  } catch {
    return null;
  }
}

/** Forgets every cached ticket. Called when the session token changes. */
export function clearSubresourceTickets(): void {
  ticketCache.clear();
}
