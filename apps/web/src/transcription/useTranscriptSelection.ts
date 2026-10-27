import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent } from 'react';
import type { TranscriptSegment } from '@video-compressor/shared';
import type { CharRange } from './text-ranges';
import { charOffsetWithin } from './selection-dom';
export interface TranscriptSelectionPart {
  segmentId: string;
  sourceRanges: CharRange[];
}
export interface TranscriptSelection {
  parts: TranscriptSelectionPart[];
}
export function selectedPart(selection: TranscriptSelection | null, segmentId: string) {
  return selection?.parts.find(p => p.segmentId === segmentId);
}
export function useTranscriptSelection({
  dialog,
  segmentById
}: {
  dialog: RefObject<HTMLDivElement | null>;
  segmentById: ReadonlyMap<string, TranscriptSegment>;
}) {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const pointerSelecting = useRef(false);
  const clearSelection = useCallback(() => setSelection(null), []);
  const resolve = useCallback(() => {
    const native = window.getSelection();
    if (
      !native ||
      native.isCollapsed ||
      !native.rangeCount ||
      !dialog.current?.contains(native.anchorNode) ||
      !dialog.current?.contains(native.focusNode)
    )
      return;
    const range = native.getRangeAt(0);
    const closest = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        '[data-segment-id]'
      );
    const start = closest(range.startContainer),
      end = closest(range.endContainer);
    const column = start?.closest('[data-side="source"]');
    if (!start || !end || !column || !column.contains(end)) return;
    const rendered = Array.from(
      column.querySelectorAll<HTMLElement>('.transcript-column-scroll [data-segment-id]')
    );
    const first = rendered.indexOf(start),
      last = rendered.indexOf(end);
    if (first < 0 || last < first) return;
    const parts: TranscriptSelectionPart[] = [];
    for (const element of rendered.slice(first, last + 1)) {
      const id = element.dataset.segmentId,
        segment = id ? segmentById.get(id) : undefined;
      if (!id || !segment) continue;
      const length = segment.sourceText.length;
      const from =
        element === start ? charOffsetWithin(element, range.startContainer, range.startOffset) : 0;
      const to =
        element === end ? charOffsetWithin(element, range.endContainer, range.endOffset) : length;
      const chosen = {
        start: Math.max(0, Math.min(from, length)),
        end: Math.max(0, Math.min(to, length))
      };
      if (chosen.end > chosen.start) parts.push({ segmentId: id, sourceRanges: [chosen] });
    }
    if (parts.length) {
      setSelection({ parts });
      native.removeAllRanges();
    }
  }, [dialog, segmentById]);
  const onSelectionEnd = useCallback(
    (event: PointerEvent) => {
      const element = event.target as Element;
      if (element.closest('button,select,input,.transcript-column-head,.transcript-player')) return;
      const native = window.getSelection();
      if (!native || native.isCollapsed) {
        if (element.closest('.transcript-column-scroll') && !element.closest('.ts-segment'))
          clearSelection();
        return;
      }
      resolve();
    },
    [resolve, clearSelection]
  );
  const onColumnPointerDown = useCallback((event: PointerEvent) => {
    if ((event.target as Element).closest('.ts-segment')) pointerSelecting.current = true;
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const change = () => {
      if (pointerSelecting.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(resolve, 160);
    };
    const end = () => {
      pointerSelecting.current = false;
    };
    document.addEventListener('selectionchange', change);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('selectionchange', change);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [resolve]);
  return { selection, clearSelection, pointerSelecting, onSelectionEnd, onColumnPointerDown };
}
