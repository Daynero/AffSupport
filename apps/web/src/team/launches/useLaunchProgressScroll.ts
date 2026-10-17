import { useCallback, useEffect, useRef, useState } from 'react';

/** Scroll once for a deliberate action, never again for arriving progress updates. */
export function useLaunchProgressScroll() {
  const anchor = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState(0);
  const reveal = useCallback(() => setRequest(value => value + 1), []);
  useEffect(() => {
    if (!request) return;
    const frame = requestAnimationFrame(() => {
      anchor.current?.scrollIntoView?.({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start'
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);
  return { anchor, reveal };
}
