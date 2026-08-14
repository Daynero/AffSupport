import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject
} from 'react';
import { clamp } from './viewerPreferences';
import type { ZoomMode } from './types';

export interface UseLandingViewportInput {
  /** The scroll container: pan target, wheel target, and size source for fit calculations. */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** The fullscreen root. */
  viewerRef: RefObject<HTMLDivElement | null>;
  /** Selected item's rendered preview dimensions, used to derive fit-width / fit-page scale. */
  preview: { width: number | null; height: number | null } | null;
  /** ArrowLeft / ArrowRight delegate back to the selection owner (−1 / +1). */
  onStep?: (delta: -1 | 1) => void;
  /** Disable pointer-drag panning (e.g. while the grid overview is shown). */
  panningDisabled?: boolean;
  /** Seeds zoom mode + custom scale once, from persisted preferences. */
  initial: { zoomMode: ZoomMode; customScale: number };
  /** Re-attach the ResizeObserver / wheel listener when the canvas element (re)mounts. */
  remeasureKey?: unknown;
}

export interface UseLandingViewport {
  scale: number;
  zoomMode: ZoomMode;
  customScale: number;
  fullscreen: boolean;
  setZoom: (next: number) => void;
  setZoomMode: (mode: ZoomMode) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  toggleFullscreen: () => void;
  resetScroll: () => void;
  canvasHandlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
}

/**
 * Pure viewport mechanics for the landing viewer — zoom (fit-width / fit-page / custom), Ctrl/⌘
 * + wheel zoom, pointer-drag panning, keyboard nav, and fullscreen. Fully data-agnostic: it knows
 * only the refs and the selected preview's pixel dimensions, so it is reusable by any surface that
 * shows a scrollable rendered image.
 */
export function useLandingViewport({
  canvasRef,
  viewerRef,
  preview,
  onStep,
  panningDisabled = false,
  initial,
  remeasureKey
}: UseLandingViewportInput): UseLandingViewport {
  const [zoomMode, setZoomMode] = useState<ZoomMode>(initial.zoomMode);
  const [customScale, setCustomScale] = useState(initial.customScale);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  const scale = useMemo(() => {
    if (!preview?.width || !preview.height) return customScale;
    const availableWidth = Math.max(160, canvasSize.width - 80);
    const availableHeight = Math.max(160, canvasSize.height - 80);
    if (zoomMode === 'fit-width') return clamp(availableWidth / preview.width, 0.15, 3);
    if (zoomMode === 'fit-page')
      return clamp(
        Math.min(availableWidth / preview.width, availableHeight / preview.height),
        0.15,
        3
      );
    return customScale;
  }, [canvasSize, customScale, preview, zoomMode]);

  const setZoom = useCallback((next: number) => {
    setCustomScale(clamp(next, 0.25, 3));
    setZoomMode('custom');
  }, []);

  // Ctrl/⌘ + wheel zooms the preview. A native non-passive listener is required because React's
  // synthetic wheel handler cannot preventDefault the browser zoom. The handler closes over a ref,
  // not `scale`, so the listener never needs re-binding on zoom.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const zoomIn = useCallback(() => setZoom(scaleRef.current + 0.1), [setZoom]);
  const zoomOut = useCallback(() => setZoom(scaleRef.current - 0.1), [setZoom]);
  const resetZoom = useCallback(() => setZoom(1), [setZoom]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const measure = () =>
      setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasRef, remeasureKey]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom(scaleRef.current + (event.deltaY < 0 ? 0.1 : -0.1));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [canvasRef, setZoom, remeasureKey]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [viewerRef]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewerRef.current?.requestFullscreen();
  }, [viewerRef]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onStep?.(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onStep?.(1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom(scaleRef.current + 0.1);
      } else if (event.key === '-') {
        event.preventDefault();
        setZoom(scaleRef.current - 0.1);
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [onStep, setZoom]);

  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (panningDisabled) return;
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, select'))
      return;
    const element = canvasRef.current;
    if (!element) return;
    pan.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop
    };
    element.classList.add('is-panning');
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (panningDisabled) return;
    const element = canvasRef.current;
    const origin = pan.current;
    if (!element || !origin) return;
    element.scrollLeft = origin.left - (event.clientX - origin.x);
    element.scrollTop = origin.top - (event.clientY - origin.y);
  };
  const endPan = () => {
    pan.current = null;
    canvasRef.current?.classList.remove('is-panning');
  };

  const resetScroll = useCallback(() => {
    requestAnimationFrame(() => canvasRef.current?.scrollTo?.({ top: 0, left: 0 }));
  }, [canvasRef]);

  return {
    scale,
    zoomMode,
    customScale,
    fullscreen,
    setZoom,
    setZoomMode,
    zoomIn,
    zoomOut,
    resetZoom,
    toggleFullscreen,
    resetScroll,
    canvasHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan
    }
  };
}
