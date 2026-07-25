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

  // Drive the circular reveal from CSS keyframes that read these custom
  // properties, rather than the Web Animations `pseudoElement` option. Animating
  // a `::view-transition-*` pseudo through WAAPI is poorly supported outside
  // Chromium (Safari ignored it, giving an instant/janky swap); the CSS path is
  // the portable, standard approach.
  const root = document.documentElement;
  root.style.setProperty('--theme-reveal-x', `${x}px`);
  root.style.setProperty('--theme-reveal-y', `${y}px`);
  root.style.setProperty('--theme-reveal-r', `${endRadius}px`);
  root.classList.add('theme-transitioning');

  const transition = document.startViewTransition(() => applyTheme(next));

  transition.finished.finally(() => {
    root.classList.remove('theme-transitioning');
    root.style.removeProperty('--theme-reveal-x');
    root.style.removeProperty('--theme-reveal-y');
    root.style.removeProperty('--theme-reveal-r');
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
