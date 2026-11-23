import { useLayoutEffect, type RefObject } from 'react';

/**
 * The header's and the list header's heights, as properties on the explorer's surface, kept
 * current as either changes — what the sticky parts of the list are offset by (070, FR-001,
 * out of `ExplorerShell`).
 */
export function useExplorerMeasure(
  explorerSurfaceRef: RefObject<HTMLDivElement | null>,
  explorerHeaderRef: RefObject<HTMLDivElement | null>,
  explorerListHeaderRef: RefObject<HTMLDivElement | null>
): void {
  useLayoutEffect(() => {
    const surface = explorerSurfaceRef.current;
    const header = explorerHeaderRef.current;
    const listHeader = explorerListHeaderRef.current;
    if (!surface || !header || !listHeader) return;
    const measure = () => {
      surface.style.setProperty(
        '--explorer-header-height',
        `${header.getBoundingClientRect().height}px`
      );
      surface.style.setProperty(
        '--explorer-list-header-height',
        `${listHeader.getBoundingClientRect().height}px`
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(listHeader);
    return () => observer.disconnect();
  }, []);
}
