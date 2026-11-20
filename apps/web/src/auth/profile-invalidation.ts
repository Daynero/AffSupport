export type ProfileRefreshSource = 'sibling' | 'focus' | 'visible';

/**
 * Coming back to a tab is one moment for a person and two events for a browser:
 * `visibilitychange` and `focus` arrive within milliseconds of each other, and each used to
 * start its own profile read. Measured over a week in November 2026: 13 227 background reads,
 * 5 024 of them less than two seconds after the one before — the second half of the same
 * return to the tab — and with them 10 000 analytics events that said nothing new.
 *
 * Within this window the two are one activation. A sibling's invalidation is never folded
 * in: that one reports a change, and a change must be read even if a read is under way.
 */
export const PROFILE_ACTIVATION_PAIR_MS = 1_000;

/**
 * Which of the two reads to keep matters. When a tab becomes visible the session library
 * re-validates the session and announces it, and the page answers by establishing the
 * identity again — which disowns every profile read started before that moment. The read
 * `visibilitychange` used to start at once was therefore thrown away two times out of three
 * (3 636 of 5 396 in the measured week), and the read that actually landed was the one the
 * paired `focus` queued behind it.
 *
 * So a visibility change waits this long before it reads: after the identity has been
 * re-established, where the read is kept. A focus that arrives on its own — another window
 * or another application, with the tab visible all along — involves no session event and
 * reads immediately.
 */
export const PROFILE_VISIBLE_SETTLE_MS = 250;

/** Only an opaque invalidation crosses tabs. Each recipient reads its own RLS profile. */
export function subscribeProfileInvalidation(
  project: string,
  refresh: (source: ProfileRefreshSource) => void
) {
  const key = `soty.auth.profile-change.v1:${new URL(project).origin}`;
  const storage = (event: StorageEvent) => {
    try {
      if (event.storageArea === localStorage && event.key === key && event.newValue)
        refresh('sibling');
    } catch {
      /* Restricted storage still has the focus/visibility fallback. */
    }
  };
  let activatedAt: number | null = null;
  let settling: ReturnType<typeof setTimeout> | null = null;
  /** True once per return to the tab, however many events the browser sends for it. */
  const firstOfActivation = () => {
    const now = Date.now();
    // Wall-clock time: only a moment that is both later and close counts as the same
    // activation, so a clock set backwards cannot silence the tab.
    if (
      activatedAt !== null &&
      now >= activatedAt &&
      now - activatedAt < PROFILE_ACTIVATION_PAIR_MS
    )
      return false;
    activatedAt = now;
    return true;
  };
  const focus = () => {
    // The visibility change that came with it is already waiting to read.
    if (settling !== null) return;
    if (firstOfActivation()) refresh('focus');
  };
  const visible = () => {
    if (document.visibilityState !== 'visible' || settling !== null) return;
    if (!firstOfActivation()) return;
    settling = setTimeout(() => {
      settling = null;
      refresh('visible');
    }, PROFILE_VISIBLE_SETTLE_MS);
  };
  window.addEventListener('storage', storage);
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', visible);
  return {
    publish() {
      try {
        localStorage.setItem(key, crypto.randomUUID());
      } catch {
        /* Saving a profile does not depend on browser storage. */
      }
    },
    dispose() {
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
      if (settling !== null) clearTimeout(settling);
      settling = null;
    }
  };
}
