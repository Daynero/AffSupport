import { useCallback, useRef } from 'react';

/**
 * Pins a tool's batch bar right under its intake zone, by the zone's real height (070, the
 * tools pass).
 *
 * The transcription measured its zone; the compressor, the stitcher and the landing optimizer
 * guessed 108px, which left a strip under a one-line zone where the list scrolled past in
 * view. The ref goes on the intake section; the height is written as `--intake-h` on the
 * page (`.workspace`), which the bar's `top` reads.
 */
export function useIntakeHeight() {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((zone: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    if (!zone) return;
    const page = zone.closest<HTMLElement>('.workspace') ?? zone.parentElement;
    if (!page) return;
    const apply = () => page.style.setProperty('--intake-h', `${zone.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(zone);
    stop.current = () => observer.disconnect();
  }, []);
}
