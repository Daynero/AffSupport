import { TeamFunctionError } from '../_shared/errors.ts';

export type RestitchTicketPurpose = 'control' | 'screen_range' | 'source_range';
const DOMAINS: Readonly<Record<RestitchTicketPurpose, string>> = {
  control: 'soty:restitch-control-ticket:v1',
  screen_range: 'soty:restitch-screen-range-ticket:v1',
  source_range: 'soty:restitch-source-range-ticket:v1'
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Derive/reconstruct a purpose-bound opaque ticket, following the landing seam.
 * A trusted factory may precompute its hash, but must never return the ticket
 * before its row, original owner scope and screen reservation commit together.
 * This MAC alone grants nothing without that acknowledged private row.
 * Consumption must check that exact row, current owner and one-use dispatch.
 * Never use this ticket with the generic download/upload or landing endpoints.
 */
export async function restitchTicket(
  secret: string,
  grantId: string,
  purpose: RestitchTicketPurpose
): Promise<string> {
  if (
    typeof grantId !== 'string' ||
    !UUID.test(grantId) ||
    typeof purpose !== 'string' ||
    !Object.hasOwn(DOMAINS, purpose)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096)
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${DOMAINS[purpose]}:${grantId.toLowerCase()}`)
    )
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
