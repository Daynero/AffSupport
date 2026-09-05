import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { TranscriptSegment } from '@video-compressor/shared';
import { activeWordIndex, flattenWords } from './karaoke';
import { KaraokeStore } from './karaoke-store';

/**
 * Follows the playhead through the words.
 *
 * The source column is marked straight in the DOM — every word already has its own span —
 * and the one translated segment that mirrors the word hears about it through the store.
 * Nothing in the viewer re-renders for a word change.
 */
export function useKaraoke(options: {
  mediaRef: RefObject<HTMLVideoElement | null>;
  sourceScrollRef: RefObject<HTMLDivElement | null>;
  segments: readonly TranscriptSegment[];
  enabled: boolean;
  /** True while the user is dragging out a selection; the DOM is left alone meanwhile. */
  pointerSelecting: RefObject<boolean>;
  centerActiveWord: (segmentId: string, wordId: string) => void;
}): { store: KaraokeStore; clear: () => void } {
  const { mediaRef, sourceScrollRef, segments, enabled, pointerSelecting, centerActiveWord } =
    options;
  const store = useMemo(() => new KaraokeStore(), []);
  const rafRef = useRef<number | null>(null);
  const videoFrameRef = useRef<number | null>(null);
  const activeWordId = useRef('');
  /** The spans currently lit, so unlighting them is not a search of the whole transcript. */
  const litSpans = useRef<HTMLElement[]>([]);

  const markSourceWord = useCallback(
    (wordId: string) => {
      const scroller = sourceScrollRef.current;
      if (!scroller) return;
      for (const element of litSpans.current) element.classList.remove('ts-active');
      litSpans.current = [];
      if (!wordId) return;
      // One word is a handful of spans (a selection may split it); the query is scoped to
      // the id rather than the document.
      const spans = Array.from(
        scroller.querySelectorAll<HTMLElement>(`[data-word-id="${CSS.escape(wordId)}"]`)
      );
      for (const element of spans) element.classList.add('ts-active');
      litSpans.current = spans;
    },
    [sourceScrollRef]
  );
  const clear = useCallback(() => {
    activeWordId.current = '';
    markSourceWord('');
    store.set(null);
  }, [markSourceWord, store]);

  // Binary search over the flat word list on every frame; precomputed once per document.
  const flatWords = useMemo(() => flattenWords(segments), [segments]);
  const flatWordList = useMemo(() => flatWords.map(entry => entry.word), [flatWords]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !enabled) return;
    const video = media as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime: number }) => void
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const stop = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (videoFrameRef.current !== null) {
        video.cancelVideoFrameCallback?.(videoFrameRef.current);
        videoFrameRef.current = null;
      }
    };
    const reset = () => {
      stop();
      clear();
    };
    const update = (mediaTimeSeconds: number) => {
      const index = activeWordIndex(flatWordList, mediaTimeSeconds * 1000);
      if (index < 0) {
        if (activeWordId.current) clear();
        return;
      }
      const entry = flatWords[index];
      if (entry.word.id === activeWordId.current) return;
      // While the user is dragging a selection, leave the DOM untouched so the live
      // selection survives; pick up the current word next tick.
      if (pointerSelecting.current) return;
      activeWordId.current = entry.word.id;
      markSourceWord(entry.word.id);
      store.set({
        segmentId: entry.segmentId,
        wordId: entry.word.id,
        range: { start: entry.word.sourceStart, end: entry.word.sourceEnd }
      });
      centerActiveWord(entry.segmentId, entry.word.id);
    };
    const rafFrame = () => {
      update(media.currentTime);
      rafRef.current = requestAnimationFrame(rafFrame);
    };
    const videoFrame = (_now: number, metadata: { mediaTime: number }) => {
      update(metadata.mediaTime);
      videoFrameRef.current = video.requestVideoFrameCallback?.(videoFrame) ?? null;
    };
    const schedule = () => {
      // Video frame metadata tracks the frame actually presented on screen, avoiding
      // currentTime/render skew. Audio-only media has no presented frames, so it keeps
      // the high-frequency RAF clock.
      if (video.requestVideoFrameCallback && media.videoWidth > 0) {
        videoFrameRef.current = video.requestVideoFrameCallback(videoFrame);
      } else {
        rafRef.current = requestAnimationFrame(rafFrame);
      }
    };
    const onPlay = () => {
      stop();
      schedule();
    };
    const onSeeked = () => update(media.currentTime);
    // A pause keeps the word lit: it is the moment a person stops to read or copy, and
    // taking the highlight away then took away the place they stopped at. Only the clock
    // stops; the end of the media, or closing the player, clears it.
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', stop);
    media.addEventListener('ended', reset);
    media.addEventListener('seeked', onSeeked);
    if (!media.paused) onPlay();
    return () => {
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', stop);
      media.removeEventListener('ended', reset);
      media.removeEventListener('seeked', onSeeked);
      reset();
    };
  }, [
    mediaRef,
    enabled,
    flatWordList,
    flatWords,
    centerActiveWord,
    markSourceWord,
    store,
    clear,
    pointerSelecting
  ]);

  return { store, clear };
}
