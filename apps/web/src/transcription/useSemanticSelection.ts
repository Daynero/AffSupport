import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  TranscriptSegment,
  TranslatedSegment,
  TranslationDocument
} from '@video-compressor/shared';
import { resolveMirroredSelection, type CharRange } from './alignment';
import { charOffsetWithin } from './selection-dom';

/** The resolved, persistent semantic selection spanning both columns. */
export interface SemanticSelectionPart {
  segmentId: string;
  sourceRanges: CharRange[];
  targetRanges: CharRange[];
  confidence: number;
  usedFallback: boolean;
}

export interface SemanticSelection {
  origin: 'source' | 'target';
  parts: SemanticSelectionPart[];
  confidence: number;
  usedFallback: boolean;
}

export function selectedPart(
  selection: SemanticSelection | null,
  segmentId: string
): SemanticSelectionPart | undefined {
  return selection?.parts.find(part => part.segmentId === segmentId);
}

/**
 * Turns a native text selection into a highlight that lives in both columns.
 *
 * A drag or a Shift+Arrow run is captured at its end, mapped to character offsets inside
 * segments, mirrored through the alignment links into the other column, and replaced with a
 * persistent highlight — so the selection survives scrolling, a language switch, and the
 * karaoke's own DOM edits.
 */
export function useSemanticSelection(options: {
  dialog: RefObject<HTMLDivElement | null>;
  segmentById: ReadonlyMap<string, TranscriptSegment>;
  translatedBySegment: ReadonlyMap<string, TranslatedSegment>;
  translation: TranslationDocument | null;
}): {
  selection: SemanticSelection | null;
  clearSelection: () => void;
  /** Whether the user is dragging right now; the karaoke leaves the DOM alone meanwhile. */
  pointerSelecting: RefObject<boolean>;
  onSelectionEnd: (event: ReactPointerEvent) => void;
  onColumnPointerDown: (event: ReactPointerEvent) => void;
} {
  const { dialog, segmentById, translatedBySegment, translation } = options;
  const [selection, setSelection] = useState<SemanticSelection | null>(null);
  const pointerSelecting = useRef(false);

  const clearSelection = useCallback(() => setSelection(null), []);

  // Re-align the target side of an existing selection when a new translation arrives (the
  // source selection is preserved across a language switch).
  useEffect(() => {
    if (!translation) return;
    setSelection(current => {
      if (!current) return current;
      const parts = current.parts.map(part => {
        const translated = translatedBySegment.get(part.segmentId);
        if (!translated || !part.sourceRanges.length) return part;
        const sourceText = segmentById.get(part.segmentId)?.sourceText;
        const mirrors = part.sourceRanges.map(range =>
          resolveMirroredSelection(
            range,
            translated.alignments,
            'source',
            translated.translatedText.length,
            sourceText !== undefined
              ? { origin: sourceText, opposite: translated.translatedText }
              : undefined
          )
        );
        return {
          ...part,
          targetRanges: mirrors.flatMap(mirror => mirror.ranges),
          confidence:
            mirrors.reduce((sum, mirror) => sum + mirror.confidence, 0) /
            Math.max(1, mirrors.length),
          usedFallback: mirrors.some(mirror => mirror.usedFallback)
        };
      });
      return {
        ...current,
        parts,
        confidence:
          parts.reduce((sum, part) => sum + part.confidence, 0) / Math.max(1, parts.length),
        usedFallback: parts.some(part => part.usedFallback)
      };
    });
  }, [translation, translatedBySegment, segmentById]);

  // Capture a native selection, map it to segment char offsets, resolve the mirror through
  // alignment links, then replace it with a persistent highlight.
  const resolveNativeSelection = useCallback(() => {
    const native = window.getSelection();
    if (!native || native.isCollapsed || native.rangeCount === 0) return false;
    const range = native.getRangeAt(0);
    const closest = <T extends Element>(node: Node, selector: string): T | null =>
      (node instanceof Element ? node : node.parentElement)?.closest<T>(selector) ?? null;
    const startEl = closest<HTMLElement>(range.startContainer, '[data-segment-id]');
    const endEl = closest<HTMLElement>(range.endContainer, '[data-segment-id]');
    const column = closest<HTMLElement>(range.startContainer, '[data-side]');
    const endColumn = closest<HTMLElement>(range.endContainer, '[data-side]');
    if (!startEl || !endEl || !column || column !== endColumn) return false;
    const origin = column.dataset.side === 'target' ? 'target' : 'source';
    const rendered = Array.from(
      column.querySelectorAll<HTMLElement>('.transcript-column-scroll [data-segment-id]')
    );
    const firstIndex = rendered.indexOf(startEl);
    const lastIndex = rendered.indexOf(endEl);
    if (firstIndex < 0 || lastIndex < firstIndex) return false;

    const parts: SemanticSelectionPart[] = [];
    for (const element of rendered.slice(firstIndex, lastIndex + 1)) {
      const segmentId = element.dataset.segmentId;
      const segment = segmentId ? segmentById.get(segmentId) : undefined;
      const translated = segmentId ? translatedBySegment.get(segmentId) : undefined;
      if (!segmentId || !segment || (origin === 'target' && !translated)) continue;
      const columnLength =
        origin === 'source' ? segment.sourceText.length : (translated?.translatedText.length ?? 0);
      const rawStart =
        element === startEl
          ? charOffsetWithin(element, range.startContainer, range.startOffset)
          : 0;
      const rawEnd =
        element === endEl
          ? charOffsetWithin(element, range.endContainer, range.endOffset)
          : columnLength;
      const chosen = {
        start: Math.max(0, Math.min(rawStart, columnLength)),
        end: Math.max(0, Math.min(rawEnd, columnLength))
      };
      if (chosen.end <= chosen.start) continue;
      if (!translated) {
        parts.push({
          segmentId,
          sourceRanges: [chosen],
          targetRanges: [],
          confidence: 0,
          usedFallback: false
        });
        continue;
      }
      const mirror = resolveMirroredSelection(
        chosen,
        translated.alignments,
        origin,
        origin === 'source' ? translated.translatedText.length : segment.sourceText.length,
        origin === 'source'
          ? { origin: segment.sourceText, opposite: translated.translatedText }
          : { origin: translated.translatedText, opposite: segment.sourceText }
      );
      parts.push({
        segmentId,
        sourceRanges: origin === 'source' ? [chosen] : mirror.ranges,
        targetRanges: origin === 'target' ? [chosen] : mirror.ranges,
        confidence: mirror.confidence,
        usedFallback: mirror.usedFallback
      });
    }
    if (!parts.length) return false;
    const weightOf = (part: SemanticSelectionPart) =>
      (origin === 'source' ? part.sourceRanges : part.targetRanges).reduce(
        (inner, selected) => inner + selected.end - selected.start,
        0
      );
    const totalWeight = parts.reduce((sum, part) => sum + weightOf(part), 0);
    setSelection({
      origin,
      parts,
      confidence:
        parts.reduce((sum, part) => sum + part.confidence * weightOf(part), 0) /
        Math.max(1, totalWeight),
      usedFallback: parts.some(part => part.usedFallback)
    });
    native.removeAllRanges();
    return true;
  }, [segmentById, translatedBySegment]);

  const onSelectionEnd = useCallback(
    (event: ReactPointerEvent) => {
      // Never react to pointer-ups on controls: Copy must preserve the resolved selection
      // and a picker click is not a text selection.
      if (
        (event.target as Element).closest(
          'button, select, input, .transcript-column-head, .transcript-player'
        )
      ) {
        return;
      }
      const native = window.getSelection();
      if (!native || native.isCollapsed) {
        const element = event.target as Element;
        // A word click seeks without disturbing a persistent selection. Only whitespace
        // outside rendered text is the "click outside".
        if (
          element.closest('.transcript-column-scroll') &&
          !element.closest('.ts-segment') &&
          !element.closest('[data-word-start-ms]')
        ) {
          clearSelection();
        }
        return;
      }
      resolveNativeSelection();
    },
    [clearSelection, resolveNativeSelection]
  );

  const onColumnPointerDown = useCallback((event: ReactPointerEvent) => {
    if ((event.target as Element).closest('.ts-segment')) pointerSelecting.current = true;
  }, []);

  // Keyboard selection has no pointer-up. Let the native highlight remain while Shift+Arrow
  // is active, then resolve it after a short quiet period.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      // A drag that pauses to read is still a drag; the pointer path resolves it on release.
      if (pointerSelecting.current) return;
      const native = window.getSelection();
      if (
        !native ||
        native.isCollapsed ||
        !dialog.current?.contains(native.anchorNode) ||
        !dialog.current?.contains(native.focusNode)
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => resolveNativeSelection(), 160);
    };
    window.document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      if (timer) clearTimeout(timer);
      window.document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [dialog, resolveNativeSelection]);

  // A drag can end anywhere (even outside the column), so clear the selecting flag on a
  // window-level pointer release rather than a per-column handler.
  useEffect(() => {
    const end = () => {
      pointerSelecting.current = false;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  return { selection, clearSelection, pointerSelecting, onSelectionEnd, onColumnPointerDown };
}
