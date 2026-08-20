/**
 * The Agent pairing token: where it is kept, how it arrives, and the budget
 * that lets the app re-pair without asking.
 *
 * It lives apart from `api/client` for one reason that matters more than tidiness:
 * the token arrives in the URL fragment of the very first page load, and that page
 * is frequently the sign-in screen. `AgentProvider` — and with it `api/client` —
 * mounts only after authentication, so anything that waits for it consumes the
 * fragment far too late. The tray's "Open Soty" redirects through `/local` to
 * `…/#agentToken=…`; the login redirect that follows rewrites the URL and the
 * token is gone. The user then had to hunt for "find the agent" in an app the
 * Agent itself had just opened.
 *
 * This module has no heavy imports on purpose, so the entry chunk can consume the
 * fragment before the first render without dragging the whole API client along.
 */

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY = 'agentToken';
const INSTALL_STARTED_KEY = 'wishly.agent-install-started.v1';
const INSTALL_PAIRING_WINDOW_MS = 15 * 60 * 1000;
const AUTOPAIR_KEY = 'wishly.agent-autopair.v1';
const AUTOPAIR_WINDOW_MS = 60_000;
const AUTOPAIR_LIMIT = 2;

const channel =
  typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel('local-video-compressor-pairing');

const listeners = new Set<() => void>();
let current = readStored();

function readStored() {
  const stored = localStorage.getItem(STORAGE_KEY) ?? '';
  return TOKEN_PATTERN.test(stored) ? stored : '';
}

function adopt(value: string) {
  if (!TOKEN_PATTERN.test(value) || value === current) return false;
  current = value;
  localStorage.setItem(STORAGE_KEY, value);
  return true;
}

// A second tab that pairs shares the result: the token is per-Agent, not per-tab.
channel?.addEventListener('message', event => {
  if (typeof event.data === 'string' && adopt(event.data))
    for (const listener of [...listeners]) listener();
});

/** The token every Agent request carries, or '' when this browser is unpaired. */
export function pairingToken() {
  return current;
}

export function hasPairingToken() {
  return Boolean(current);
}

/**
 * Notified when a token arrives from another tab. Returns an unsubscribe.
 *
 * A Set rather than a single slot: `AgentProvider` is not guaranteed to be the
 * only listener, and a second subscriber silently evicting the first is the kind
 * of bug that only shows up as "sometimes it does not connect".
 */
export function onPairingToken(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Takes the token out of `#agentToken=…` and clears it from the address bar.
 *
 * Safe to call more than once and safe to call before React renders — which is
 * exactly when it must run, ahead of any routing decision that would rewrite
 * the URL.
 */
export function consumePairingToken() {
  const value = new URLSearchParams(location.hash.slice(1)).get('agentToken');
  if (!value || !TOKEN_PATTERN.test(value)) return false;
  adopt(value);
  sessionStorage.removeItem(INSTALL_STARTED_KEY);
  channel?.postMessage(value);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export function markAgentInstallStarted() {
  sessionStorage.setItem(INSTALL_STARTED_KEY, String(Date.now()));
}

export function agentInstallAwaitingPairing() {
  const started = Number(sessionStorage.getItem(INSTALL_STARTED_KEY));
  if (!Number.isFinite(started) || Date.now() - started > INSTALL_PAIRING_WINDOW_MS) {
    sessionStorage.removeItem(INSTALL_STARTED_KEY);
    return false;
  }
  return true;
}

/**
 * Budget for re-pairing without being asked.
 *
 * Automatic pairing is a full navigation that comes back to this page, so a
 * token the Agent then rejects again would spin the tab forever. Two attempts a
 * minute is enough for the case this exists for — the Agent restarted and minted
 * a new token — while any repeating failure falls through to the manual button
 * after the second try. Per tab (sessionStorage), because the loop being guarded
 * against is this tab's.
 *
 * Only a *connection* releases the budget, never the arrival of a token:
 * resetting on arrival would refill it on every lap of the very loop this
 * guards, and the tab would navigate forever.
 */
export function claimAutomaticPairing(now = Date.now()) {
  const [since, count] = (sessionStorage.getItem(AUTOPAIR_KEY) ?? '').split(':').map(Number);
  const fresh = !Number.isFinite(since) || now - since > AUTOPAIR_WINDOW_MS;
  const attempts = fresh ? 0 : count;
  if (!Number.isFinite(attempts) || attempts >= AUTOPAIR_LIMIT) return false;
  sessionStorage.setItem(AUTOPAIR_KEY, `${fresh ? now : since}:${attempts + 1}`);
  return true;
}

export function releaseAutomaticPairing() {
  sessionStorage.removeItem(AUTOPAIR_KEY);
}
