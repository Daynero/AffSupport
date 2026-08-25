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
/**
 * How long a fetched installer counts as "this person has Soty".
 *
 * A day, in `localStorage`, because of what the answer is used for. It decides
 * whether a page that cannot see the Agent offers "Open Soty" or "Download
 * Soty", and downloading is the wrong answer for anyone who already has it —
 * they read the whole screen as a failure and have nowhere to go.
 *
 * The old fifteen minutes in `sessionStorage` was scoped to re-pairing, where
 * being wrong costs one extra click. It is far too tight for this: an unsigned
 * build on Windows means an unzip, a SmartScreen warning and a first launch,
 * and the tab that started the download is often closed along the way. Both
 * limits threw away a true answer.
 *
 * Nothing is risked by the wider window. The flag never grants access — it
 * chooses which button leads, and permits an automatic re-pair that is itself
 * budgeted to two attempts a minute.
 */
const INSTALL_PAIRING_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Set the first time this browser sees the Agent, and never cleared.
 *
 * The hosted page cannot tell "Soty is not installed" apart from "Soty is
 * installed and this browser refuses to look at loopback" — Safari, Firefox's
 * tracking protection and a denied Chrome local-network prompt all produce the
 * same failed fetch. Once the Agent has answered even once, the second reading
 * is overwhelmingly the likelier one, and the install screen is the wrong
 * screen to show.
 *
 * Kept forever on purpose: the browsers that block the probe block it every
 * time, so an expiring flag would send the same person back to the download
 * button a day later. Uninstalling costs one click on the download that stays
 * on every one of these screens.
 */
const AGENT_SEEN_KEY = 'wishly.agent-seen.v1';
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
  if (!TOKEN_PATTERN.test(value)) return false;
  // Marked even when the token is unchanged: only the Agent mints one, so its
  // arrival is proof the Agent exists on this computer regardless of whether
  // this browser already held the same value.
  markAgentSeen();
  if (value === current) return false;
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
  localStorage.removeItem(INSTALL_STARTED_KEY);
  channel?.postMessage(value);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

/**
 * Adopts a token that arrived through the in-page handshake.
 *
 * The same adoption the fragment path performs, minus the URL cleanup it has no
 * URL to do — and it broadcasts, so the tabs that waited for the election get
 * the result rather than each starting a handshake of their own.
 */
export function storePairingToken(value: string): boolean {
  if (!TOKEN_PATTERN.test(value)) return false;
  const changed = adopt(value);
  localStorage.removeItem(INSTALL_STARTED_KEY);
  channel?.postMessage(value);
  if (changed) for (const listener of [...listeners]) listener();
  return true;
}

export function markAgentInstallStarted() {
  localStorage.setItem(INSTALL_STARTED_KEY, String(Date.now()));
}

/** Records that the Agent has proved it exists on this computer. */
export function markAgentSeen() {
  localStorage.setItem(AGENT_SEEN_KEY, '1');
}

/**
 * Whether this browser has any evidence that Soty is on this computer.
 *
 * The question every "we cannot reach the Agent" screen has to answer before
 * it picks a headline. True means the leading action is "Open Soty"; false
 * means it is "Download Soty". Being wrong in the first direction costs one
 * extra click on a download that is still on screen — being wrong in the other
 * tells someone who already installed Soty to install it again.
 */
export function agentKnown() {
  return (
    localStorage.getItem(AGENT_SEEN_KEY) === '1' ||
    hasPairingToken() ||
    agentInstallAwaitingPairing()
  );
}

export function agentInstallAwaitingPairing() {
  const started = Number(localStorage.getItem(INSTALL_STARTED_KEY));
  if (!Number.isFinite(started) || Date.now() - started > INSTALL_PAIRING_WINDOW_MS) {
    localStorage.removeItem(INSTALL_STARTED_KEY);
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
 * after the second try.
 *
 * **Per browser, not per tab (D4).** It used to live in `sessionStorage`, so
 * three open tabs burned three separate budgets against one local app and the
 * third fell through to a manual screen for no reason the user could see. The
 * loop being guarded against belongs to the browser, because the token being
 * re-fetched does.
 *
 * Only a *connection* releases the budget, never the arrival of a token:
 * resetting on arrival would refill it on every lap of the very loop this
 * guards, and the tab would navigate forever.
 */
export function claimAutomaticPairing(now = Date.now()) {
  const [since, count] = (localStorage.getItem(AUTOPAIR_KEY) ?? '').split(':').map(Number);
  const fresh = !Number.isFinite(since) || now - since > AUTOPAIR_WINDOW_MS;
  const attempts = fresh ? 0 : count;
  if (!Number.isFinite(attempts) || attempts >= AUTOPAIR_LIMIT) return false;
  localStorage.setItem(AUTOPAIR_KEY, `${fresh ? now : since}:${attempts + 1}`);
  return true;
}

export function releaseAutomaticPairing() {
  localStorage.removeItem(AUTOPAIR_KEY);
}

/**
 * How long a tab waits for another tab's handshake before doing its own.
 *
 * Short, because the cost of waiting is a visibly idle page and the cost of not
 * waiting is a duplicate handshake — neither is serious, and the shorter one is
 * the better default.
 */
const CLAIM_WAIT_MS = 400;

/** How long the whole handshake may take before the caller falls back. */
const HANDSHAKE_TIMEOUT_MS = 4_000;

/**
 * Re-pairs without navigating away from the page.
 *
 * The old path was a full-page navigation that came back with a token in the
 * fragment. It works, and it destroys everything on screen — an editable
 * transcript, a half-filled form, an open dialog — to deliver a string
 * (FR-038). This frames a document the local app serves, which posts the token
 * back and nothing else.
 *
 * Three things are checked before a message is believed, and the risk of this
 * whole feature is concentrated in them: the message came from the frame this
 * function created, its origin is the local app's, and it carries the nonce
 * this call generated. A mistake in any one turns a fix into a way for a page
 * to harvest a session token.
 *
 * Resolves null on timeout, so the caller keeps the existing navigation as a
 * fallback and nothing is ever worse than it was.
 */
export async function handshakeForToken(agentOrigin: string): Promise<string | null> {
  if (typeof document === 'undefined' || typeof BroadcastChannel === 'undefined') return null;

  // One handshake per browser, not one per tab: three tabs noticing the same
  // dead token at the same moment should produce one frame, not three.
  const claimed = await claimHandshake();
  if (!claimed) return waitForBroadcastToken();

  const nonce = crypto.randomUUID().replace(/-/gu, '');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  frame.src = `${agentOrigin}/pair/handshake?nonce=${encodeURIComponent(nonce)}`;

  return new Promise<string | null>(resolve => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      frame.remove();
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      // Origin first: a message from anywhere else is not worth parsing.
      if (event.origin !== agentOrigin) return;
      // Then provenance — this is the frame we created, not some other one that
      // happens to be same-origin with the local app.
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; nonce?: unknown; token?: unknown };
      if (data?.type !== 'soty:pairing') return;
      // Then the nonce: proof this is the answer to *this* request.
      if (data.nonce !== nonce) return;
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/u.test(data.token)) return;
      finish(data.token);
    };

    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    document.body.append(frame);
  });
}

/** Elects one tab to perform the handshake. Returns false if another one won. */
async function claimHandshake(): Promise<boolean> {
  const key = `${AUTOPAIR_KEY}:claim`;
  const now = Date.now();
  const held = Number(localStorage.getItem(key) ?? '0');
  if (Number.isFinite(held) && now - held < CLAIM_WAIT_MS) return false;
  localStorage.setItem(key, String(now));
  return true;
}

/** Waits for the tab that won the election to broadcast what it got. */
function waitForBroadcastToken(): Promise<string | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, HANDSHAKE_TIMEOUT_MS);
    const stop = onPairingToken(() => {
      clearTimeout(timer);
      stop();
      resolve(pairingToken() || null);
    });
  });
}
