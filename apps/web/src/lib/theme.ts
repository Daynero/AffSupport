import { useCallback, useEffect, useRef, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const CHANGE_EVENT = 'wishly-theme-changed';
const META_LIGHT = '#7557e8';
const META_DARK = '#120e1f';

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Reads the theme the FOUC-prevention inline script already committed to <html>. */
export function getInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.dataset.theme;
    if (attr === 'light' || attr === 'dark') return attr;
  }
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  }
  return systemPrefersDark() ? 'dark' : 'light';
}

/** Commits a theme to the DOM without any transition animation. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? META_DARK : META_LIGHT);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

type Origin = { x: number; y: number } | null;

/**
 * Circular "cosmic reveal": the incoming theme wipes in as a growing circle
 * from the click point using the View Transitions API. Falls back to an
 * instant swap when the API is unavailable or motion is reduced.
 */
export function transitionTheme(next: Theme, origin: Origin) {
  const supportsViewTransition =
    typeof document !== 'undefined' && 'startViewTransition' in document;

  if (!supportsViewTransition || prefersReducedMotion() || !origin) {
    applyTheme(next);
    return;
  }

  const { x, y } = origin;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );

  document.documentElement.classList.add('theme-transitioning');
  const transition = document.startViewTransition(() => applyTheme(next));

  transition.ready
    .then(() => {
      // Always grow the *incoming* theme as a circle from the click point,
      // in both directions. The new layer ends at a full circle, which equals
      // its natural (unclipped) state — so no `fill` is needed and there is no
      // one-frame snap-back. Persisting animations (fill: forwards) would linger
      // in getAnimations() and cause the next transition to be skipped.
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`]
        },
        {
          duration: 620,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    })
    .catch(() => {});

  transition.finished.finally(() => {
    document.documentElement.classList.remove('theme-transitioning');
  });
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const sync = (event: Event) => {
      const next =
        event instanceof CustomEvent
          ? event.detail
          : event instanceof StorageEvent && event.key === STORAGE_KEY
            ? event.newValue
            : null;
      if (next === 'light' || next === 'dark') setThemeState(next);
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setTheme = useCallback((next: Theme, origin?: Origin) => {
    if (themeRef.current === next) return;
    themeRef.current = next;
    setThemeState(next);
    localStorage.setItem(STORAGE_KEY, next);
    transitionTheme(next, origin ?? null);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  const toggleTheme = useCallback(
    (origin?: Origin) => {
      setTheme(themeRef.current === 'dark' ? 'light' : 'dark', origin);
    },
    [setTheme]
  );

  return { theme, setTheme, toggleTheme };
}
