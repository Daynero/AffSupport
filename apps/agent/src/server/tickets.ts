import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Capability tickets: a way to name one resource in a URL without putting the
 * session token in it.
 *
 * A subresource — an image, a preview frame, a media stream — has to be
 * fetchable by the browser's own loader, which means the credential travels in
 * the URL. And a URL is not a secret: it lands in the referrer of anything the
 * page links to, in the local app's own access log, in a proxy's cache, and in
 * whatever the user pastes when they ask for help. The session token in that
 * position is the whole machine's worth of access sitting in a place designed
 * to be copied.
 *
 * A ticket is the same idea shrunk to fit: derived from the session secret, so
 * no new state is stored; bound to one method and one path, so it cannot be
 * pointed at a different resource; and valid for five minutes, so a leak costs
 * one image for a short while rather than everything for as long as the app
 * runs.
 *
 * It is deliberately not a bearer token for the API. It authorises exactly one
 * request shape and nothing else.
 */

/**
 * Five minutes.
 *
 * Long enough that a slow video seek, a retried range request or a page the
 * user left open for a moment still works; short enough that a URL copied into
 * a bug report is worthless by the time anyone reads it.
 */
export const TICKET_TTL_MS = 5 * 60_000;

/** What the signature covers. Order matters only in that both sides agree. */
function payload(method: string, path: string, expiresAt: number): string {
  return `${method.toUpperCase()}|${path}|${expiresAt}`;
}

function sign(secret: string, method: string, path: string, expiresAt: number): string {
  return createHmac('sha256', secret)
    .update(payload(method, path, expiresAt))
    .digest('base64url');
}

/**
 * Mints a ticket for one method and one path.
 *
 * `path` must be the request path without a query string: the query is where
 * the ticket itself travels, and including it would mean signing a value that
 * contains its own signature.
 */
export function issueTicket(
  secret: string,
  method: string,
  path: string,
  now = Date.now()
): string {
  const expiresAt = now + TICKET_TTL_MS;
  return `${expiresAt}.${sign(secret, method, path, expiresAt)}`;
}

/**
 * Whether a ticket authorises this exact request, right now.
 *
 * Compared in constant time, and the expiry is checked *after* the signature:
 * an attacker learning that a forged ticket was rejected for being expired
 * rather than for being forged is a small leak, and there is no reason to
 * provide it.
 */
export function ticketAuthorises(
  secret: string,
  method: string,
  path: string,
  ticket: unknown,
  now = Date.now()
): boolean {
  if (typeof ticket !== 'string') return false;
  const separator = ticket.indexOf('.');
  if (separator <= 0) return false;
  const expiresAt = Number(ticket.slice(0, separator));
  if (!Number.isSafeInteger(expiresAt)) return false;
  const supplied = ticket.slice(separator + 1);
  const expected = sign(secret, method, path, expiresAt);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // the length of a base64url HMAC is not a secret.
  if (suppliedBytes.length !== expectedBytes.length) return false;
  if (!timingSafeEqual(suppliedBytes, expectedBytes)) return false;
  return now < expiresAt;
}
