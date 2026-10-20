import { useCallback, useLayoutEffect, useState, type CSSProperties } from 'react';
import { retainAccountFocusAnchor, scheduleAccountFocusReveal } from './accountFocusAnchor';

/** Keep headings available while bounding expensive offscreen row controls.
 * Drafts and canonical account data live above this rendering boundary.
 */
export function useDeferredAccountRows({
  enabled,
  initialVisible,
  force,
  estimatedUnits
}: {
  enabled: boolean;
  initialVisible: boolean;
  force: boolean;
  estimatedUnits: number;
}) {
  const supported = typeof IntersectionObserver !== 'undefined';
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [near, setNear] = useState(initialVisible);
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const renderRows = !enabled || !supported || near || focused || force;
  const ref = useCallback((element: HTMLDivElement | null) => setNode(element), []);

  useLayoutEffect(() => {
    const table = node?.closest<HTMLElement>('.team-accounts-table');
    return table ? retainAccountFocusAnchor(table) : undefined;
  }, [node]);

  useLayoutEffect(() => {
    if (!node || !enabled || !supported) return;
    const root = node.closest<HTMLElement>('.team-accounts-table');
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries.find(item => item.target === node);
        if (entry) setNear(entry.isIntersecting);
      },
      { root, rootMargin: '600px 0px' }
    );
    observer.observe(node);
    const section = node.closest('section');
    const focusIn = () => setFocused(true);
    const focusOut = () => {
      queueMicrotask(() => {
        if (!node.isConnected) return;
        // Menus/dialogs may be portaled outside their originating row.
        if (document.querySelector('[role="menu"], [role="dialog"]')) return;
        setFocused(Boolean(section?.contains(document.activeElement)));
      });
    };
    section?.addEventListener('focusin', focusIn);
    section?.addEventListener('focusout', focusOut);
    return () => {
      observer.disconnect();
      section?.removeEventListener('focusin', focusIn);
      section?.removeEventListener('focusout', focusOut);
    };
  }, [node, enabled, supported]);

  useLayoutEffect(() => {
    if (!node || !renderRows) return;
    const measure = () => {
      const next = node.getBoundingClientRect().height;
      if (next > 0) {
        setHeight(previous => (previous === next ? previous : next));
        const table = node.closest<HTMLElement>('.team-accounts-table');
        if (table) scheduleAccountFocusReveal(table);
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, renderRows]);

  return {
    ref,
    renderRows,
    placeholderStyle: {
      '--account-deferred-units': estimatedUnits,
      ...(height === null ? {} : { '--account-deferred-height': `${height}px` })
    } as CSSProperties
  };
}
