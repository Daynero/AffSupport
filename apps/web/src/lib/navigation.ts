import { useEffect, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';

const NAVIGATION_EVENT = 'wishly-navigation';

/**
 * While a route view transition runs, this class on <html> gives the page
 * viewport its `wishly-page` view-transition-name (styles.css). Gating by
 * class keeps route and theme motion independent.
 */
const PAGE_TRANSITION_CLASS = 'wishly-page-transition';

let routeTransitionActive = false;

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

/**
 * Applies a route state change, wrapped in a View Transition (a short
 * crossfade of the `wishly-page` group) when the browser supports it.
 *
 * Falls back to a plain synchronous swap when the API is missing, motion is
 * reduced, a theme transition is mid-flight (both would fight over the same
 * snapshots), or another route transition is already running.
 *
 * Lazy chunks: every in-app page (home, tools, account, admin) lives inside
 * the one lazily loaded ProtectedSoty chunk, so in-app route swaps are
 * synchronous and the transition never captures an empty fallback. The only
 * lazy boundary crossed by navigation is the rarely visited legal chunk; if
 * it suspends, the transition crossfades to a loading screen painted on the
 * legal surface itself, so the global honeycomb cannot flash through before
 * the page then renders.
 */
function commitRouteChange(apply: () => void) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (
    !root ||
    !('startViewTransition' in document) ||
    prefersReducedMotion() ||
    routeTransitionActive ||
    root.classList.contains('is-theming')
  ) {
    apply();
    return;
  }
  routeTransitionActive = true;
  root.classList.add(PAGE_TRANSITION_CLASS);
  const finish = () => {
    routeTransitionActive = false;
    root.classList.remove(PAGE_TRANSITION_CLASS);
  };
  // flushSync commits the React route state inside the transition callback, so
  // the "new" snapshot is captured only after the next page has rendered
  // (mirrors the synchronous applyTheme commit in theme.ts).
  const transition = document.startViewTransition(() => flushSync(apply));
  transition.finished.then(finish, finish);
}

/**
 * Freezes, at mount time, whether a page should play its own entrance
 * animation. Pages mounted by a route view transition skip `.page-enter` —
 * the transition already animates them in, and running both would double the
 * motion. Pages mounted outside a transition (first load, browsers without
 * the API, connection-state branch swaps) fade-rise in via `.page-enter`.
 */
export function usePageEntrance(): boolean {
  const [entering] = useState(() => !routeTransitionActive);
  return entering;
}

export function currentRoute() {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function navigateTo(path: string, replace = false) {
  if (path === currentRoute()) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function useBrowserRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => commitRouteChange(() => setRoute(currentRoute()));
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATION_EVENT, update);
    };
  }, []);
  return route;
}

export function internalLink(event: MouseEvent<HTMLAnchorElement>, path: string) {
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
  navigateTo(path);
}
