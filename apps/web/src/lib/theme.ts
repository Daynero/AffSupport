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

type Origin = { x: number; y: number } | null;

// Duration of the theme cross-fade; kept in sync with the honeycomb veil in
// HoneycombField and the `.is-theming` transition in styles.css.
const THEME_FADE_MS = 775;
let themingTimer = 0;

/**
 * Commits the theme with a smooth cross-fade. `is-theming` is armed on the root
 * *before* the colour swap so every UI surface cross-fades from the same instant
 * as the honeycomb backdrop (HoneycombField), keeping them perfectly in step.
 */
export function transitionTheme(next: Theme, _origin: Origin) {
  const root = document.documentElement;
  root.classList.add('is-theming');
  // Flush styles so the `.is-theming` universal transition is committed *before*
  // the colour swap. Without this, the transition rule and the variable change
  // land in one restyle, so elements that gain their colour transition only from
  // `.is-theming` (e.g. header text) snap instead of cross-fading.
  void root.offsetWidth;
  applyTheme(next);
  clearTimeout(themingTimer);
  themingTimer = window.setTimeout(() => root.classList.remove('is-theming'), THEME_FADE_MS + 80);
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
