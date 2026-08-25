import { describe, expect, it } from 'vitest';
import { TICKET_TTL_MS, issueTicket, ticketAuthorises } from '../apps/agent/src/server/tickets.js';

/**
 * FR-024. The subresource half of C4.
 *
 * A URL is not a secret: it lands in referrers, access logs, proxy caches and
 * bug reports. The session token used to travel in one, which put the whole
 * machine's worth of access in a place designed to be copied.
 */

const SECRET = 'a'.repeat(64);
const IMAGE = '/api/images/abc123/content';
const OTHER_IMAGE = '/api/images/def456/content';

describe('a capability ticket', () => {
  it('authorises the exact request it was minted for', () => {
    const ticket = issueTicket(SECRET, 'GET', IMAGE);
    expect(ticketAuthorises(SECRET, 'GET', IMAGE, ticket)).toBe(true);
  });

  it('does not authorise a different resource', () => {
    // The property that makes this worth doing at all: a leaked ticket for one
    // image is a leaked ticket for that image.
    const ticket = issueTicket(SECRET, 'GET', IMAGE);
    expect(ticketAuthorises(SECRET, 'GET', OTHER_IMAGE, ticket)).toBe(false);
  });

  it('does not authorise a different method', () => {
    const ticket = issueTicket(SECRET, 'GET', IMAGE);
    expect(ticketAuthorises(SECRET, 'DELETE', IMAGE, ticket)).toBe(false);
  });

  it('expires', () => {
    const now = 1_000_000;
    const ticket = issueTicket(SECRET, 'GET', IMAGE, now);
    expect(ticketAuthorises(SECRET, 'GET', IMAGE, ticket, now + TICKET_TTL_MS - 1)).toBe(true);
    // A URL copied into a bug report is worthless by the time anyone reads it.
    expect(ticketAuthorises(SECRET, 'GET', IMAGE, ticket, now + TICKET_TTL_MS)).toBe(false);
  });

  it('is not the session token, and cannot be turned back into it', () => {
    const ticket = issueTicket(SECRET, 'GET', IMAGE);
    expect(ticket).not.toContain(SECRET);
  });

  it('does not authorise anything under a different secret', () => {
    // A restarted local app mints a new secret; tickets from the previous run
    // stop working, which is the correct behaviour and not a regression.
    const ticket = issueTicket(SECRET, 'GET', IMAGE);
    expect(ticketAuthorises('b'.repeat(64), 'GET', IMAGE, ticket)).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['a value with no separator', 'deadbeef'],
    ['a non-numeric expiry', 'soon.deadbeef'],
    ['a forged signature', `${Date.now() + 60_000}.${'A'.repeat(43)}`],
    ['a number', 42],
    ['nothing at all', undefined]
  ])('refuses %s', (_why, candidate) => {
    expect(ticketAuthorises(SECRET, 'GET', IMAGE, candidate)).toBe(false);
  });

  it('refuses a ticket whose expiry was edited', () => {
    const now = 1_000_000;
    const ticket = issueTicket(SECRET, 'GET', IMAGE, now);
    const signature = ticket.slice(ticket.indexOf('.') + 1);
    // The expiry is inside the signature, so pushing it out invalidates it —
    // which is the difference between a signed ticket and a timestamped one.
    const extended = `${now + TICKET_TTL_MS * 100}.${signature}`;
    expect(ticketAuthorises(SECRET, 'GET', IMAGE, extended, now)).toBe(false);
  });
});
