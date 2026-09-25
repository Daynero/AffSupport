import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

type ScrollTarget = HTMLElement | Window;

function scrollTarget(element: HTMLElement): ScrollTarget {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = window.getComputedStyle(parent).overflowY;
    if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return window;
}

function viewportTop(target: ScrollTarget): number {
  return target === window ? 0 : (target as HTMLElement).getBoundingClientRect().top;
}

function shiftScroll(target: ScrollTarget, delta: number): void {
  if (target === window) window.scrollBy(0, delta);
  else (target as HTMLElement).scrollTop += delta;
}

/** Keep the first visible material in place when an invalidated window is replaced. */
export function useVisibleRowAnchor(
  contentRef: RefObject<HTMLElement | null>,
  rowIds: readonly string[],
  scope: string
): () => void {
  const pending = useRef<{
    id: string;
    top: number;
    oldIds: readonly string[];
    scope: string;
  } | null>(null);
  const rowIdsRef = useRef(rowIds);
  rowIdsRef.current = rowIds;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const capture = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const top = viewportTop(scrollTarget(content));
    const anchor = Array.from(content.querySelectorAll<HTMLElement>('[data-material-id]')).find(
      row => row.getBoundingClientRect().bottom > top
    );
    if (anchor?.dataset.materialId)
      pending.current = {
        id: anchor.dataset.materialId,
        top: anchor.getBoundingClientRect().top,
        oldIds: rowIdsRef.current,
        scope: scopeRef.current
      };
  }, [contentRef]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const target = scrollTarget(content);
    const visible = new Map(
      Array.from(content.querySelectorAll<HTMLElement>('[data-material-id]')).map(row => [
        row.dataset.materialId,
        row
      ])
    );
    const saved = pending.current;
    if (saved?.scope === scope) {
      const previous = saved.oldIds.indexOf(saved.id);
      const fallback = [
        ...saved.oldIds.slice(previous + 1),
        ...saved.oldIds.slice(0, previous).reverse()
      ].find(id => visible.has(id));
      const row = visible.get(saved.id) ?? (fallback ? visible.get(fallback) : undefined);
      if (row) shiftScroll(target, row.getBoundingClientRect().top - saved.top);
    }
    pending.current = null;
  }, [contentRef, rowIds, scope]);
  return capture;
}
