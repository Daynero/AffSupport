import { useCallback, useEffect, useRef } from 'react';
/** Follow the original word while respecting the reader's manual scrolling. */
export function useTranscriptScroll({
  layoutKey,
  reducedMotion
}: {
  layoutKey: string;
  reducedMotion: boolean;
}) {
  const sourceScrollRef = useRef<HTMLDivElement>(null),
    manualUntil = useRef(0),
    programmaticUntil = useRef(0);
  useEffect(() => {
    manualUntil.current = 0;
    programmaticUntil.current = 0;
    const el = sourceScrollRef.current;
    if (!el) return;
    const scroll = () => {
      if (Date.now() >= programmaticUntil.current) manualUntil.current = Date.now() + 2500;
    };
    el.addEventListener('scroll', scroll);
    return () => el.removeEventListener('scroll', scroll);
  }, [layoutKey]);
  const centerActiveWord = useCallback(
    (segmentId: string, wordId: string) => {
      if (Date.now() < manualUntil.current) return;
      const el = sourceScrollRef.current;
      if (!el) return;
      const word =
        (wordId
          ? el.querySelector<HTMLElement>('[data-word-id="' + CSS.escape(wordId) + '"]')
          : null) ??
        el.querySelector<HTMLElement>('[data-segment-id="' + CSS.escape(segmentId) + '"]');
      if (!word) return;
      const outer = el.getBoundingClientRect(),
        inner = word.getBoundingClientRect();
      const top = Math.max(
        0,
        Math.min(
          el.scrollHeight - el.clientHeight,
          inner.top - outer.top + el.scrollTop - el.clientHeight / 2 + inner.height / 2
        )
      );
      programmaticUntil.current = Date.now() + 500;
      el.scrollTo({ top, behavior: reducedMotion ? 'instant' : 'smooth' });
    },
    [reducedMotion]
  );
  return { sourceScrollRef, centerActiveWord };
}
