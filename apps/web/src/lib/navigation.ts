import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { isLiteMotion, reportAnimatedTransition } from './motion-quality';
import { motionBetween, screenOf, type MotionKind } from './motion-registry';
import {
  beginNavigationAttempt,
  type NavHistory,
  type NavMode,
  type NavSkipReason,
  type NavigationAttempt
} from './navigation-analytics';

const NAVIGATION_EVENT = 'wishly-navigation';
export const BEFORE_NAVIGATION_EVENT = 'wishly-before-navigation';

/**
 * While a route view transition runs, one of these classes on <html> names
 * the group that moves (styles.css): the page viewport for a `page` move, the
 * space body for a `section` move. Gating by class keeps route and theme
 * motion independent, and keeps the two route motions from naming both.
 */
const PAGE_TRANSITION_CLASS = 'wishly-page-transition';
const SECTION_TRANSITION_CLASS = 'wishly-section-transition';

/**
 * How long a navigation waits for the destination's code before it moves
 * anyway (058, FR-006). Until then the current screen stays; after it, the
 * destination's skeleton stands in. Mirrors `--delay-skeleton` in tokens.css.
 */
export const WAIT_BEFORE_SKELETON_MS = 300;

/**
 * A `replace` this soon after a route change is the app correcting the
 * address it just arrived at (a redirect), not a second move: it applies
 * instantly, inside the change already on screen (FR-013).
 */
const REDIRECT_WINDOW_MS = 1_000;

/** Fallback entrance (no View Transitions API) lasts this long at most. */
const FALLBACK_ENTER_CLEAR_MS = 400;

/**
 * After a navigation has already waited out the skeleton delay for code that
 * did not arrive, the skeleton must not wait a second time: `data-nav-waited`
 * on <html> drops its delay for this long (styles/components.css).
 */
const NAV_WAITED_CLEAR_MS = 1_500;
let navWaitedTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Right after a route change the destination is often still asking for its
 * data. A skeleton that appears then must appear at once — a delayed one
 * leaves the transition crossfading into an empty viewport with the honeycomb
 * showing (058, beta smoke). `data-nav-recent` on <html> marks that window.
 */
const NAV_RECENT_CLEAR_MS = 1_500;
let navRecentTimer: ReturnType<typeof setTimeout> | null = null;

function markNavigationRecent() {
  const root = document.documentElement;
  root.dataset.navRecent = 'true';
  if (navRecentTimer) clearTimeout(navRecentTimer);
  navRecentTimer = setTimeout(() => {
    delete root.dataset.navRecent;
    navRecentTimer = null;
  }, NAV_RECENT_CLEAR_MS);
}

function markNavigationWaited() {
  const root = document.documentElement;
  root.dataset.navWaited = 'true';
  if (navWaitedTimer) clearTimeout(navWaitedTimer);
  navWaitedTimer = setTimeout(() => {
    delete root.dataset.navWaited;
    navWaitedTimer = null;
  }, NAV_WAITED_CLEAR_MS);
}

/* ---------------------------------------------------------------------------
 * Route preparers (058, FR-007). A part of the app that owns lazily loaded
 * screens registers one; every navigation asks them what its destination
 * needs, so a link anywhere — a tile, a menu item, a toast's action — waits
 * for the destination's code instead of crossfading into an empty viewport.
 * ------------------------------------------------------------------------- */

export type RoutePreparer = (path: string) => Promise<unknown> | void;
const routePreparers = new Set<RoutePreparer>();

export function registerRoutePreparer(preparer: RoutePreparer): () => void {
  routePreparers.add(preparer);
  return () => routePreparers.delete(preparer);
}

function prepareRoute(path: string): Promise<unknown> | void {
  const pending: Promise<unknown>[] = [];
  routePreparers.forEach(preparer => {
    try {
      const result = preparer(path);
      if (result) pending.push(result);
    } catch {
      // A preparer that throws prepares nothing; the screen's own Suspense copes.
    }
  });
  return pending.length > 0 ? Promise.all(pending) : undefined;
}

let routeTransitionActive = false;
let activeTransition: ViewTransition | null = null;
let transitionSeq = 0;
let navigationSeq = 0;
let lastCommitAt = Number.NEGATIVE_INFINITY;
let fallbackEnterTimer: ReturnType<typeof setTimeout> | null = null;

/** True while a route change is being applied inside a view transition. */
export function isRouteTransitionActive() {
  return routeTransitionActive;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ---------------------------------------------------------------------------
 * Scroll memory (058, FR-017). The browser's own restoration cannot know when
 * the next page has rendered, so it is switched off and done here: every
 * history entry carries a key, positions are remembered per key, a new page
 * opens at the top and Back returns to where the person was. The scroll is
 * applied in a layout effect right after the new route commits — before the
 * frame is painted and before a view transition takes its snapshot.
 * ------------------------------------------------------------------------- */

const ENTRY_KEY_FIELD = 'wishlyEntry';
const scrollPositions = new Map<string, number>();
let entryCounter = 0;

function newEntryKey(): string {
  entryCounter += 1;
  return `${Date.now().toString(36)}-${entryCounter}`;
}

function stateKey(state: unknown): string | null {
  if (state && typeof state === 'object' && ENTRY_KEY_FIELD in state) {
    const value = (state as Record<string, unknown>)[ENTRY_KEY_FIELD];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** The current entry's key, minted on first use for entries made elsewhere. */
function currentEntryKey(): string {
  const existing = stateKey(history.state);
  if (existing) return existing;
  const key = newEntryKey();
  const base =
    history.state && typeof history.state === 'object'
      ? (history.state as Record<string, unknown>)
      : {};
  try {
    history.replaceState({ ...base, [ENTRY_KEY_FIELD]: key }, '');
  } catch {
    // A state that cannot be cloned keeps no scroll memory; nothing else breaks.
  }
  return key;
}

function rememberScroll() {
  if (typeof window === 'undefined') return;
  scrollPositions.set(currentEntryKey(), window.scrollY);
}

/** What the next committed route should do with scroll and focus. */
let pendingArrival: { motion: Exclude<MotionKind, 'none'>; scrollTop: number } | null = null;

function settleArrival() {
  const arrival = pendingArrival;
  pendingArrival = null;
  if (!arrival) return;
  if (window.scrollY !== arrival.scrollTop) {
    try {
      window.scrollTo({ top: arrival.scrollTop, left: 0, behavior: 'instant' as ScrollBehavior });
    } catch {
      // Very old engines: scrolling is best effort.
    }
  }
  settleFocus(arrival.motion);
}

/**
 * Focus follows the person into the new screen only when it has nowhere else
 * to be (FR-024): the element that held it was removed or hidden with the old
 * screen. A tab, a menu item or a search field that is still on screen keeps
 * it — moving focus away from a tab would break the keyboard's tab strip.
 */
function settleFocus(motion: Exclude<MotionKind, 'none'>) {
  const active = document.activeElement as HTMLElement | null;
  const lost =
    !active ||
    active === document.body ||
    !active.isConnected ||
    active.closest('[hidden]') !== null;
  if (!lost) return;
  const target =
    (motion === 'section' ? document.querySelector('.team-space-shell-body') : null) ??
    document.querySelector('.page-viewport > main') ??
    document.querySelector('.page-viewport');
  if (!(target instanceof HTMLElement)) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------------------
 * Committing a route change.
 * ------------------------------------------------------------------------- */

function instantMode(
  motion: Exclude<MotionKind, 'none'>
): { mode: NavMode; reason: NavSkipReason } | null {
  const root = document.documentElement;
  if (prefersReducedMotion()) return { mode: 'instant_reduced', reason: 'none' };
  if (document.visibilityState === 'hidden') return { mode: 'instant_hidden', reason: 'none' };
  if (!('startViewTransition' in document))
    return { mode: 'fallback_enter', reason: 'unsupported' };
  // Both would fight over the same snapshots; the theme fade is already moving
  // the whole screen.
  if (root.classList.contains('is-theming')) return { mode: 'skipped', reason: 'theme_active' };
  if (motion === 'page' && isLiteMotion()) return { mode: 'instant_lite', reason: 'none' };
  return null;
}

/**
 * Without the View Transitions API the new content still arrives softly: a
 * short fade on what was just mounted (`data-nav-enter`, styles.css). The old
 * content is already gone, but the new one fills the same place on the next
 * frame, so there is no empty screen to see.
 */
function markFallbackEnter(motion: Exclude<MotionKind, 'none'>) {
  const root = document.documentElement;
  root.dataset.navEnter = motion;
  if (fallbackEnterTimer) clearTimeout(fallbackEnterTimer);
  fallbackEnterTimer = setTimeout(() => {
    delete root.dataset.navEnter;
    fallbackEnterTimer = null;
  }, FALLBACK_ENTER_CLEAR_MS);
}

/**
 * Applies a route state change, wrapped in a View Transition when the browser
 * supports it and nothing argues against motion.
 *
 * - `page`: the page viewport crossfades (complementary opacity, so where both
 *   screens are opaque nothing behind them shows through), and the topbar's
 *   two clusters glide to their new places when the shell width changes.
 * - `section`: only the space body crossfades; the space header and tabs stay.
 * - A newer navigation skips the running transition and starts its own: only
 *   the last destination ever plays (FR-012).
 */
function commitRouteChange(
  apply: () => void,
  motion: MotionKind,
  scrollTop: number,
  attempt: NavigationAttempt | null
) {
  lastCommitAt = now();
  if (motion === 'none' || typeof document === 'undefined') {
    apply();
    return;
  }
  pendingArrival = { motion, scrollTop };
  markNavigationRecent();
  const instant = instantMode(motion);
  if (instant) {
    activeTransition?.skipTransition();
    attempt?.committed(instant.mode, instant.reason);
    apply();
    if (instant.mode === 'fallback_enter') markFallbackEnter(motion);
    return;
  }

  const root = document.documentElement;
  const id = ++transitionSeq;
  // Starting a new transition skips the running one; its cleanup sees a newer
  // id and leaves this one's class alone.
  activeTransition?.skipTransition();
  root.classList.remove(PAGE_TRANSITION_CLASS, SECTION_TRANSITION_CLASS);
  root.classList.add(motion === 'section' ? SECTION_TRANSITION_CLASS : PAGE_TRANSITION_CLASS);
  routeTransitionActive = true;
  attempt?.committed('animated', 'none');
  // flushSync commits the React route state inside the transition callback, so
  // the "new" snapshot is captured only after the next page has rendered
  // (mirrors the synchronous applyTheme commit in theme.ts).
  const transition = document.startViewTransition(() => flushSync(apply));
  activeTransition = transition;
  const finish = () => {
    if (id !== transitionSeq) return;
    routeTransitionActive = false;
    activeTransition = null;
    root.classList.remove(PAGE_TRANSITION_CLASS, SECTION_TRANSITION_CLASS);
    reportAnimatedTransition(attempt?.animationDone() ?? 0);
  };
  transition.finished.then(finish, finish);
  // `ready` and `updateCallbackDone` reject when the transition is skipped —
  // which a newer navigation does on purpose. Nothing awaits them, so each
  // rejection would surface as an uncaught `InvalidStateError`.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
}

/**
 * Freezes, at mount time, whether a page should play its own entrance
 * animation. Pages mounted by a route view transition skip `.page-enter` —
 * the transition already animates them in, and running both would double the
 * motion. Pages mounted outside a transition (first load, browsers without
 * the API, connection-state branch swaps) fade-rise in via `.page-enter`.
 */
export function usePageEntrance(): boolean {
  // A page mounted by an instant route change (reduced or lite motion, a
  // browser without the API) arrives as it is: fading it in from nothing put
  // the honeycomb on screen for the first frames (058, beta smoke).
  const [entering] = useState(
    () => !routeTransitionActive && now() - lastCommitAt > REDIRECT_WINDOW_MS
  );
  return entering;
}

export function currentRoute() {
  return `${location.pathname}${location.search}${location.hash}`;
}

/**
 * Whether two routes sit on either side of the team workspace boundary. The
 * boundary used to be crossed with a direct swap because the old page's
 * snapshot stayed opaque above the workspace; with the complementary
 * crossfade (058, R1/R2) it moves like any other page change.
 */
export function crossesTeamBoundary(from: string, to: string): boolean {
  const isTeamRoute = (route: string) => {
    const path = route.split(/[?#]/, 1)[0] ?? '';
    return path === '/team' || path.startsWith('/team/');
  };
  return isTeamRoute(from) !== isTeamRoute(to);
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /**
   * How the screen moves. Left out, it is read from the two routes
   * (`motionBetween`): another area is `page`, another section of the same
   * space is `section`, the same screen with a different query is `none`.
   */
  motion?: MotionKind;
  /**
   * Loads what the destination needs before the route changes — its code
   * chunk, usually. The current screen stays until it resolves or
   * `WAIT_BEFORE_SKELETON_MS` passes, whichever is first. Return nothing when
   * it is already loaded: the navigation then happens synchronously.
   */
  prepare?: () => Promise<unknown> | void;
}

interface NavigationDetail {
  motion: MotionKind;
  history: NavHistory;
  attempt: NavigationAttempt | null;
  /** Kept for listeners written before `motion`. */
  animate: boolean;
}

/**
 * Moves to `path`.
 *
 * The older positional form still works: `navigateTo(path, replace, animate)`,
 * where `animate: false` means `motion: 'none'` — for adjustments within a
 * screen (a folder, a view toggle, a selection written to the URL).
 */
export function navigateTo(
  path: string,
  replaceOrOptions: boolean | NavigateOptions = false,
  animate = true
) {
  const options: NavigateOptions =
    typeof replaceOrOptions === 'object'
      ? replaceOrOptions
      : { replace: replaceOrOptions, ...(animate ? {} : { motion: 'none' as const }) };
  const from = currentRoute();
  if (path === from) return;
  const replace = options.replace ?? false;
  const redirect = replace && (routeTransitionActive || now() - lastCommitAt < REDIRECT_WINDOW_MS);
  const motion: MotionKind = redirect ? 'none' : (options.motion ?? motionBetween(from, path));
  const historyKind: NavHistory = replace ? 'replace' : 'push';
  const start =
    motion === 'none'
      ? null
      : { from: screenOf(from), to: screenOf(path), motion, history: historyKind };

  if (!navigationAllowed(path, replace, motion !== 'none')) {
    if (start) beginNavigationAttempt(start, { standalone: true }).finish('cancelled');
    return;
  }

  const seq = ++navigationSeq;
  const attempt = start ? beginNavigationAttempt(start) : null;
  const go = () => {
    // A newer navigation was asked for while this one waited; it owns the
    // screen now, and this one never happens.
    if (seq !== navigationSeq) return;
    attempt?.prepared();
    rememberScroll();
    const state = { [ENTRY_KEY_FIELD]: newEntryKey() };
    if (replace) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
    const detail: NavigationDetail = {
      motion,
      history: historyKind,
      attempt,
      animate: motion !== 'none'
    };
    window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, { detail }));
  };

  let pending: Promise<unknown> | void;
  try {
    // A change within the screen needs no new code; only a move to another
    // screen asks the preparers.
    pending = options.prepare
      ? options.prepare()
      : motion === 'none'
        ? undefined
        : prepareRoute(path);
  } catch {
    pending = undefined;
  }
  if (!pending) {
    go();
    return;
  }
  const settled = pending.then(
    () => true,
    () => true
  );
  const timeout = new Promise<boolean>(resolve =>
    setTimeout(() => resolve(false), WAIT_BEFORE_SKELETON_MS)
  );
  void Promise.race([settled, timeout]).then(arrived => {
    if (!arrived && seq === navigationSeq) markNavigationWaited();
    go();
  });
}

function navigationAllowed(path: string, replace: boolean, animate: boolean): boolean {
  return window.dispatchEvent(
    new CustomEvent(BEFORE_NAVIGATION_EVENT, {
      cancelable: true,
      detail: { path, replace, animate }
    })
  );
}

let scrollTrackingInstalled = false;

function installScrollTracking() {
  if (scrollTrackingInstalled || typeof window === 'undefined') return;
  scrollTrackingInstalled = true;
  try {
    history.scrollRestoration = 'manual';
  } catch {
    // Not settable in some embedded views; the browser then restores alone.
  }
  currentEntryKey();
  let queued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scrollPositions.set(currentEntryKey(), window.scrollY);
      });
    },
    { passive: true }
  );
}

export function useBrowserRoute() {
  const [route, setRoute] = useState(currentRoute);
  const routeRef = useRef(route);

  // Runs after the new route's DOM is committed and before it is painted (and,
  // inside a view transition, before the new snapshot is taken).
  useLayoutEffect(() => {
    settleArrival();
  }, [route]);

  useEffect(() => {
    installScrollTracking();
    const apply = () => {
      const next = currentRoute();
      routeRef.current = next;
      setRoute(next);
    };
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<Partial<NavigationDetail>>).detail ?? {};
      const motion: MotionKind = detail.motion ?? (detail.animate === false ? 'none' : 'page');
      commitRouteChange(apply, motion, 0, detail.attempt ?? null);
    };
    const onPopState = () => {
      const next = currentRoute();
      if (next === routeRef.current) return;
      if (!navigationAllowed(next, false, true)) {
        // popstate arrives after the URL moves. Restore the visible route without
        // applying it, so a dirty editor remains mounted after a canceled Back.
        history.pushState({ [ENTRY_KEY_FIELD]: newEntryKey() }, '', routeRef.current);
        return;
      }
      // A navigation still waiting for its chunk loses to Back.
      navigationSeq += 1;
      const motion = motionBetween(routeRef.current, next);
      const attempt =
        motion === 'none'
          ? null
          : beginNavigationAttempt({
              from: screenOf(routeRef.current),
              to: screenOf(next),
              motion,
              history: 'pop'
            });
      attempt?.prepared();
      const scrollTop = scrollPositions.get(currentEntryKey()) ?? 0;
      commitRouteChange(apply, motion, scrollTop, attempt);
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener(NAVIGATION_EVENT, onNavigation);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener(NAVIGATION_EVENT, onNavigation);
    };
  }, []);
  return route;
}

export function internalLink(
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
  animateOrOptions: boolean | Omit<NavigateOptions, 'replace'> = true
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  if (typeof animateOrOptions === 'object') navigateTo(path, animateOrOptions);
  else navigateTo(path, false, animateOrOptions);
}

/** Tests only. */
export function resetNavigationForTests() {
  routeTransitionActive = false;
  activeTransition = null;
  transitionSeq = 0;
  navigationSeq = 0;
  lastCommitAt = Number.NEGATIVE_INFINITY;
  pendingArrival = null;
  scrollPositions.clear();
  if (fallbackEnterTimer) clearTimeout(fallbackEnterTimer);
  fallbackEnterTimer = null;
  if (navWaitedTimer) clearTimeout(navWaitedTimer);
  navWaitedTimer = null;
  if (navRecentTimer) clearTimeout(navRecentTimer);
  navRecentTimer = null;
  routePreparers.clear();
  if (typeof document !== 'undefined') {
    delete document.documentElement.dataset.navEnter;
    delete document.documentElement.dataset.navWaited;
    delete document.documentElement.dataset.navRecent;
  }
}

declare global {
  interface Window {
    /** Dev and beta only: lets the frame-by-frame smoke test drive the router (058). */
    __sotyNavigate?: typeof navigateTo;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') window.__sotyNavigate = navigateTo;
