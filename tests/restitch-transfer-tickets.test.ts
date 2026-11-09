import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { landingTicket } from '../supabase/functions/drive-transfer/landing-ticket';
import {
  restitchTicket,
  type RestitchTicketPurpose
} from '../supabase/functions/drive-transfer/restitch-ticket';
const secret = 'synthetic-secret-with-at-least-32-characters';
const id = '470000ab-0000-4000-8000-000000000099';
it('reconstructs one exact screen ticket with a fixed independent HMAC vector', async () => {
  const expected = createHmac('sha256', secret)
    .update(`soty:restitch-screen-range-ticket:v1:${id}`)
    .digest('base64url');
  const ticket = await restitchTicket(secret, id, 'screen_range');
  expect(ticket).toBe(expected);
  expect(await restitchTicket(secret, id.toUpperCase(), 'screen_range')).toBe(ticket);
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
});
it('separates control, image, source and existing landing ticket purposes', async () => {
  const tickets = await Promise.all([
    restitchTicket(secret, id, 'control'),
    restitchTicket(secret, id, 'screen_range'),
    restitchTicket(secret, id, 'source_range'),
    landingTicket(secret, id)
  ]);
  expect(new Set(tickets).size).toBe(4);
});
it('binds ticket reconstruction to the original row and server key', async () => {
  const ticket = await restitchTicket(secret, id, 'screen_range');
  expect(
    await restitchTicket(secret, '47000000-0000-4000-8000-000000000098', 'screen_range')
  ).not.toBe(ticket);
  expect(await restitchTicket(secret + '-rotated', id, 'screen_range')).not.toBe(ticket);
});
it.each(['download_range', 'finalize', '__proto__', 'constructor'])(
  'refuses unrelated or inherited purpose %s',
  async purpose => {
    await expect(
      restitchTicket(secret, id, purpose as RestitchTicketPurpose)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
);
it.each(['', 'not-a-row-id', id + ':screen_range'])(
  'refuses malformed private row identity %s',
  async grantId => {
    await expect(restitchTicket(secret, grantId, 'control')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
  }
);
it.each(['', 'short', 'x'.repeat(4097)])(
  'refuses an unavailable or invalid server key without returning it',
  async value => {
    await expect(restitchTicket(value, id, 'control')).rejects.toMatchObject({
      code: 'DRIVE_UNAVAILABLE',
      message: 'DRIVE_UNAVAILABLE'
    });
  }
);
