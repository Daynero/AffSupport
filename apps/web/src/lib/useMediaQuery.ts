import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches now, and again whenever that changes.
 *
 * For the few places where the width decides what is *rendered*, not only how
 * it looks — the explorer's folder tree is a column on a laptop and a drawer on
 * a tablet, and a drawer is a dialog, not a style. Everything that is only a
 * look stays in CSS.
 *
 * An engine without `matchMedia` (a test's DOM, a server render) answers
 * `fallback`, so the wide layout is what renders there unless a test asks.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const media = window.matchMedia(query);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    [query]
  );
  const read = () =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? fallback
      : window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, read, () => fallback);
}

/**
 * Up to the `lg` step (1024 px, `--breakpoint-lg`): the layout where side panes
 * become drawers. Written the way the stylesheets write the narrow side of a
 * step since 070 T003 — `max-width: N` narrow, `width > N` wide — so a window
 * of exactly 1024 px is narrow here and in every `@media` rule that answers the
 * same width. A media query cannot read a custom property, so the number is
 * spelled here, as `check-design-tokens.mjs` allows for the five steps.
 */
export const NARROW_LG_QUERY = '(max-width: 1024px)';

/**
 * Up to the `sm` step (640 px, `--breakpoint-sm`): a phone. The bars that
 * swap a worded control for its icon (070, T077, T078) render the other
 * control here, not only hide one — two buttons with one name would be two
 * buttons to a reader.
 */
export const NARROW_SM_QUERY = '(max-width: 640px)';
