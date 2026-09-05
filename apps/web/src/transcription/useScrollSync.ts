import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Segment positions inside one column, for scroll mirroring. */
interface SegmentOffsets {
  ids: string[];
  tops: number[];
  bottoms: number[];
  byId: Map<string, number>;
}

/**
 * Keeps two transcript columns scrolled to the same segment, and centres the karaoke word.
 *
 * Positions are measured once per document (and again after a resize) and looked up by
 * binary search: mirroring a scroll used to query every segment element and read its
 * offset on every scroll event of either column — thousands of forced layouts per wheel
 * tick on an hour-long transcript, on the CPU-only laptops this ships to.
 */
export function useScrollSync(options: {
  /** Changes whenever segments may have moved: a new document or translation. */
  layoutKey: string;
  reducedMotion: boolean;
}): {
  sourceScrollRef: RefObject<HTMLDivElement | null>;
  targetScrollRef: RefObject<HTMLDivElement | null>;
  synchronizeScroll: (from: HTMLDivElement, to: HTMLDivElement) => void;
  centerActiveWord: (segmentId: string, wordId: string) => void;
} {
  const sourceScrollRef = useRef<HTMLDivElement>(null);
  const targetScrollRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const manualScrollUntil = useRef(0);
  // While a karaoke auto-scroll animation is in flight, its own scroll events must not read
  // as a manual scroll (which would pause following) nor bounce back through the mirror
  // sync. This timestamp marks that suppression window.
  const programmaticScrollUntil = useRef(0);
  const scrollIndex = useRef(new Map<HTMLDivElement, SegmentOffsets>());
  const pendingSync = useRef<number | null>(null);
  const { reducedMotion } = options;

  const measureScroller = useCallback((scroller: HTMLDivElement): SegmentOffsets => {
    const ids: string[] = [];
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-segment-id]')) {
      ids.push(element.dataset.segmentId ?? '');
      tops.push(element.offsetTop);
      bottoms.push(element.offsetTop + element.offsetHeight);
    }
    const offsets = { ids, tops, bottoms, byId: new Map(ids.map((id, index) => [id, index])) };
    scrollIndex.current.set(scroller, offsets);
    return offsets;
  }, []);

  useEffect(() => {
    scrollIndex.current.clear();
    if (typeof ResizeObserver === 'undefined') return;
    const invalidate = () => scrollIndex.current.clear();
    const observer = new ResizeObserver(invalidate);
    const scrollers = [sourceScrollRef.current, targetScrollRef.current].filter(
      (scroller): scroller is HTMLDivElement => scroller !== null
    );
    for (const scroller of scrollers) {
      observer.observe(scroller);
      // Segments off screen are laid out as placeholders (`content-visibility: auto`) and
      // take their real height on first paint; an index measured before that mirrored the
      // wrong segment on a long transcript.
      scroller.addEventListener('contentvisibilityautostatechange', invalidate, true);
    }
    return () => {
      observer.disconnect();
      for (const scroller of scrollers) {
        scroller.removeEventListener('contentvisibilityautostatechange', invalidate, true);
      }
      // A mirror frame still pending at unmount would write to a scroller that is gone.
      if (pendingSync.current !== null) {
        cancelAnimationFrame(pendingSync.current);
        pendingSync.current = null;
      }
    };
  }, [options.layoutKey]);

  const synchronizeScroll = useCallback(
    (from: HTMLDivElement, to: HTMLDivElement) => {
      if (syncingScroll.current) return;
      if (Date.now() < programmaticScrollUntil.current) return;
      manualScrollUntil.current = Date.now() + 2500;
      // Once per frame, whatever the wheel's event rate.
      if (pendingSync.current !== null) return;
      pendingSync.current = requestAnimationFrame(() => {
        pendingSync.current = null;
        const maxScroll = Math.max(0, to.scrollHeight - to.clientHeight);
        const settle = () => {
          requestAnimationFrame(() => {
            syncingScroll.current = false;
          });
        };
        if (from.scrollTop <= 1) {
          syncingScroll.current = true;
          to.scrollTop = 0;
          settle();
          return;
        }
        if (from.scrollTop + from.clientHeight >= from.scrollHeight - 1) {
          syncingScroll.current = true;
          to.scrollTop = maxScroll;
          settle();
          return;
        }
        const source = scrollIndex.current.get(from) ?? measureScroller(from);
        const target = scrollIndex.current.get(to) ?? measureScroller(to);
        if (!source.ids.length) return;
        // The first segment whose bottom edge crosses the line a quarter of the way down.
        const line = from.scrollTop + from.clientHeight * 0.25;
        let low = 0;
        let high = source.bottoms.length - 1;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (source.bottoms[middle] >= line) high = middle;
          else low = middle + 1;
        }
        const index = target.byId.get(source.ids[low]);
        if (index === undefined) return;
        syncingScroll.current = true;
        to.scrollTop = Math.min(
          maxScroll,
          Math.max(0, target.tops[index] - to.clientHeight * 0.25)
        );
        settle();
      });
    },
    [measureScroller]
  );

  // Keep the karaoke word vertically centered in both columns. Called on every word change
  // so following stays smooth even inside a long segment. Position is measured with
  // getBoundingClientRect relative to the scroller — offsetTop is relative to the
  // offsetParent (neither scroller is positioned), so it does not map to scrollTop.
  const centerActiveWord = useCallback(
    (segmentId: string, wordId: string) => {
      // Never fight a scroll the user just made by hand.
      if (Date.now() < manualScrollUntil.current) return;
      let scrolled = false;
      for (const scroller of [sourceScrollRef.current, targetScrollRef.current]) {
        if (!scroller) continue;
        // Center the exact word on the source side; the target has no matching word
        // element, so fall back to keeping its mirrored segment centered.
        const element =
          (wordId
            ? scroller.querySelector<HTMLElement>(`[data-word-id="${CSS.escape(wordId)}"]`)
            : null) ??
          scroller.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(segmentId)}"]`);
        if (!element) continue;
        const scRect = scroller.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        const elTopInContent = elRect.top - scRect.top + scroller.scrollTop;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const next = Math.max(
          0,
          Math.min(maxScroll, elTopInContent - scroller.clientHeight / 2 + elRect.height / 2)
        );
        // Words on the same visual line share a top, so this is a no-op until the line
        // changes — the view glides line-by-line instead of jittering.
        if (Math.abs(next - scroller.scrollTop) < 4) continue;
        scroller.scrollTo({ top: next, behavior: reducedMotion ? 'auto' : 'smooth' });
        scrolled = true;
      }
      // Cover the smooth animation so its scroll events don't read as manual.
      if (scrolled) programmaticScrollUntil.current = Date.now() + (reducedMotion ? 60 : 650);
    },
    [reducedMotion]
  );

  return { sourceScrollRef, targetScrollRef, synchronizeScroll, centerActiveWord };
}
