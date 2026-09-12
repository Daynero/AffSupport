/**
 * Which space a Drive authorization belongs to, remembered across the trip to
 * Google and back.
 *
 * Google's redirect comes back to the bare `/team?drive=<code>`: the callback
 * is a server redirect built from one configured site URL, so the space the
 * authorization was for is not in the address. The resolver used to guess —
 * "the first owned space that is not ready" — which sent a person who had just
 * reconnected an existing space into the create-space wizard, and sent it for
 * a space they were not even looking at. Granting access in Google then landed
 * back on "connect with Google" every time: a loop with no way out.
 *
 * The press knows what the redirect cannot, so it writes it down before
 * leaving. `sessionStorage`, not `localStorage`: this is one tab's trip to
 * Google, and it should not outlive the tab or leak into a second one.
 */

const KEY = 'wishly.drive-authorization.v1';

/**
 * How long a written note may still be believed. An OAuth consent screen is a
 * minute's work; anything older is a `/team?drive=…` address that was reloaded
 * or pasted much later, and guessing from it is what caused the loop.
 */
const VALID_FOR_MS = 15 * 60 * 1000;

/**
 * Where the person was when they pressed connect, and therefore where they
 * must come back to. `wizard` is mid-creation — the space does not exist for
 * them yet, so its folder step is resumed; `space` is an existing space's own
 * settings, which must not be dragged into the creation flow.
 */
export type DriveAuthorizationIntent = 'wizard' | 'space';

export interface DriveAuthorizationTarget {
  teamId: string;
  intent: DriveAuthorizationIntent;
}

/** Written before the navigation to Google, by whichever surface started it. */
export function rememberDriveAuthorization(teamId: string, intent: DriveAuthorizationIntent): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ teamId, intent, at: Date.now() }));
  } catch {
    // Private windows and blocked site data throw on write. The return then
    // falls back to entering the space the resolver would have entered anyway,
    // which is a worse guess but never a loop.
  }
}

/** Read on the way back. Null means "decide without me". */
export function readDriveAuthorization(): DriveAuthorizationTarget | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const teamId = typeof record.teamId === 'string' ? record.teamId : '';
  const intent = record.intent === 'wizard' || record.intent === 'space' ? record.intent : null;
  const at = typeof record.at === 'number' ? record.at : 0;
  if (!/^[0-9a-f-]{36}$/i.test(teamId) || !intent) return null;
  if (!Number.isFinite(at) || Date.now() - at > VALID_FOR_MS) return null;
  return { teamId, intent };
}
