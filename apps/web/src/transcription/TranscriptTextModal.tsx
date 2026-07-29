import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionMediaPreview,
  TranscriptionModelInfo,
  TranscriptSegment,
  TranscriptWord,
  TranslatedSegment,
  TranslationDocument
} from '@video-compressor/shared';
import { TRANSLATEGEMMA_LANGUAGE_CODES } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, ProgressBar, type Translate } from '../components/ui';
import { formatSize } from '../format';
import {
  transcriptionDocument,
  transcriptionMediaCancel,
  transcriptionMediaPrepare,
  transcriptionMediaStatus,
  transcriptionMediaUrl,
  transcriptionTranslate,
  transcriptionTranslation
} from '../api/client';
import { defaultTranslationTarget, isRtlLanguage, languageDisplayName } from './language';
import type { Language } from '../i18n';
import {
  confidenceColor,
  confidenceGrade,
  resolveMirroredSelection,
  type CharRange
} from './alignment';
import { charOffsetWithin, joinRanges, splitTextByRanges } from './selection-dom';
import { activeWordIndex, flattenWords } from './karaoke';

const TARGET_LANGUAGES = [...TRANSLATEGEMMA_LANGUAGE_CODES];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'aiff',
  'aif'
]);

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function fallbackDocument(job: TranscriptionJob): TranscriptionDocument {
  const segments: TranscriptSegment[] = (job.text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((sourceText, index) => ({
      id: `${job.id}-s${index}`,
      startMs: 0,
      endMs: 0,
      sourceText,
      words: []
    }));
  return {
    jobId: job.id,
    sourceLanguage: job.detectedLanguage ?? job.requestedLanguage ?? 'auto',
    modelVersion: '',
    segments,
    translations: {}
  };
}

/** The resolved, persistent semantic selection spanning both columns. */
interface SemanticSelectionPart {
  segmentId: string;
  sourceRanges: CharRange[];
  targetRanges: CharRange[];
  confidence: number;
  usedFallback: boolean;
}

interface SemanticSelection {
  origin: 'source' | 'target';
  parts: SemanticSelectionPart[];
  confidence: number;
  usedFallback: boolean;
}

function selectedPart(
  selection: SemanticSelection | null,
  segmentId: string
): SemanticSelectionPart | undefined {
  return selection?.parts.find(part => part.segmentId === segmentId);
}

/** The karaoke word currently under the playhead. */
interface ActiveWord {
  segmentId: string;
  range: CharRange;
}

/** Shared empty-range constant so memoized segments skip re-render when idle. */
const NO_RANGES: CharRange[] = [];

/**
 * One rendered segment with its selection + karaoke highlight layers. Memoized
 * so a karaoke tick only re-renders the segment gaining/losing the active word
 * (and the one it left) — not the whole transcript, which is what made the
 * highlight trail the audio on long documents.
 */
const SegmentText = memo(function SegmentText({
  text,
  segmentId,
  selectedRanges,
  activeRanges,
  words = []
}: {
  text: string;
  segmentId: string;
  selectedRanges: CharRange[];
  activeRanges: CharRange[];
  words?: TranscriptWord[];
}) {
  const wordBoundaries = words.flatMap(word => [word.sourceStart, word.sourceEnd]);
  const pieces = splitTextByRanges(text, selectedRanges, activeRanges, wordBoundaries);
  return (
    <p className="ts-segment" data-segment-id={segmentId}>
      {pieces.length === 0
        ? text
        : pieces.map((piece, index) => {
            const word = words.find(
              candidate => piece.start >= candidate.sourceStart && piece.end <= candidate.sourceEnd
            );
            return (
              <span
                key={index}
                className={`${piece.selected ? 'ts-selected' : ''} ${
                  piece.active ? 'ts-active' : ''
                }`.trim()}
                data-char-start={piece.start}
                data-char-end={piece.end}
                data-word-id={word?.id}
                data-word-start-ms={word?.startMs}
              >
                {piece.text}
              </span>
            );
          })}
    </p>
  );
});

function LanguageCombobox({
  value,
  codes,
  language,
  label,
  onChange
}: {
  value: string;
  codes: readonly string[];
  language: Language;
  label: string;
  onChange: (code: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(language);
    return codes
      .map(code => ({ code, name: languageDisplayName(code, language) }))
      .filter(item => !needle || item.name.toLocaleLowerCase(language).includes(needle))
      .sort((left, right) => left.name.localeCompare(right.name, language));
  }, [codes, language, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  return (
    <div
      className="transcript-language-combobox"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery('');
        }
      }}
    >
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && filtered[activeIndex]
            ? `${listId}-${filtered[activeIndex].code.replace(/[^A-Za-z0-9]/gu, '-')}`
            : undefined
        }
        value={open ? query : languageDisplayName(value, language)}
        onFocus={event => {
          setOpen(true);
          setQuery('');
          event.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onChange={event => {
          setOpen(true);
          setQuery(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(index => Math.min(filtered.length - 1, index + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index => Math.max(0, index - 1));
          } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
            event.preventDefault();
            choose(filtered[activeIndex].code);
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
            setQuery('');
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox">
          {filtered.length ? (
            filtered.map((item, index) => (
              <li
                id={`${listId}-${item.code.replace(/[^A-Za-z0-9]/gu, '-')}`}
                key={item.code}
                role="option"
                aria-selected={item.code === value}
                className={index === activeIndex ? 'is-active' : ''}
                onPointerDown={event => event.preventDefault()}
                onClick={() => choose(item.code)}
              >
                {item.name}
              </li>
            ))
          ) : (
            <li className="is-empty">{label}</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function TranscriptTextModal({
  job,
  language,
  returnFocus,
  translatorModel,
  onInstallTranslator,
  onCancelTranslator,
  onClose,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  returnFocus: HTMLElement | null;
  translatorModel: TranscriptionModelInfo;
  onInstallTranslator: () => void;
  onCancelTranslator: () => void;
  onClose: () => void;
  t: Translate;
}) {
  const titleId = useId();
  const matchHintId = useId();
  const previewId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sourceScrollRef = useRef<HTMLDivElement>(null);
  const targetScrollRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const manualScrollUntil = useRef(0);
  // While a karaoke auto-scroll animation is in flight, its own scroll events
  // must not read as a manual scroll (which would pause following) nor bounce
  // back through the mirror sync. This timestamp marks that suppression window.
  const programmaticScrollUntil = useRef(0);
  // True while the user is dragging out a text selection. Karaoke pauses its
  // per-word DOM rebuild during a drag so it never collapses the live selection.
  const pointerSelecting = useRef(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const videoFrameRef = useRef<number | null>(null);
  const activeWordId = useRef<string>('');

  const [document_, setDocument] = useState<TranscriptionDocument | null>(null);
  const [target, setTarget] = useState<string>(() => {
    const sourceLanguage = job.detectedLanguage ?? job.requestedLanguage ?? 'auto';
    const sourceBase = sourceLanguage.replaceAll('_', '-').split('-')[0].toLowerCase();
    const selected = job.translation?.targetLanguage;
    if (selected && selected.replaceAll('_', '-').split('-')[0].toLowerCase() !== sourceBase) {
      return selected;
    }
    return defaultTranslationTarget(sourceLanguage, language);
  });
  const [translation, setTranslation] = useState<TranslationDocument | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translationElapsedMs, setTranslationElapsedMs] = useState(0);
  const [translationProgress, setTranslationProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [translationError, setTranslationError] = useState<'failed' | 'unavailable' | null>(null);
  const [translatorTermsAccepted, setTranslatorTermsAccepted] = useState(false);
  const [copied, setCopied] = useState<{
    side: 'source' | 'target';
    scope: 'selection' | 'all';
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewActivated, setPreviewActivated] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<TranscriptionMediaPreview | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [selection, setSelection] = useState<SemanticSelection | null>(null);
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);
  const [playback, setPlayback] = useState({
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    rate: 1
  });
  const generation = useRef(0);
  const validatedTranslations = useRef(new Map<string, TranslationDocument>());
  const lastDistinctTarget = useRef<string | null>(null);
  const translatorWasPresent = useRef(translatorModel.present);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionRef = useRef<SemanticSelection | null>(null);
  const onCloseRef = useRef(onClose);
  selectionRef.current = selection;
  onCloseRef.current = onClose;

  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    validatedTranslations.current.clear();
    setTranslation(null);
    setSelection(null);
    transcriptionDocument(job.id, controller.signal)
      .then(doc => {
        if (active) setDocument(doc.segments.length ? doc : fallbackDocument(job));
      })
      .catch(() => {
        if (active) setDocument(fallbackDocument(job));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [job.id, job.text, job.detectedLanguage, job.requestedLanguage]);

  useEffect(() => {
    if (!document_) return;
    const source = document_.sourceLanguage.split('-')[0].toLowerCase();
    if (source === target.split('-')[0].toLowerCase()) {
      setTranslation(null);
      setTranslating(false);
      setTranslationError(null);
      return;
    }
    // Only reuse responses validated by the backend in this modal session.
    // A completed sidecar entry may belong to an older pinned model version;
    // POST performs the authoritative cache/version check.
    const validated = validatedTranslations.current.get(target);
    if (validated) {
      const gen = ++generation.current;
      const requestId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${job.id}-${gen}-${Date.now()}`;
      let active = true;
      setTranslation(validated);
      setTranslating(false);
      setTranslationError(null);
      // Keep the visual switch instantaneous, but still notify the backend of
      // the new generation so it can cancel obsolete queued/running work.
      void transcriptionTranslate(job.id, target, requestId)
        .then(result => {
          if (!active || generation.current !== gen || result.status !== 'completed') return;
          validatedTranslations.current.set(result.targetLanguage, result);
          setTranslation(result);
        })
        .catch(() => {
          // The already validated in-memory result remains usable. A fresh
          // non-cached selection still surfaces backend failures normally.
        });
      return () => {
        active = false;
      };
    }

    const gen = ++generation.current;
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${job.id}-${gen}-${Date.now()}`;
    let active = true;
    setTranslating(true);
    setTranslationProgress(null);
    setTranslationError(null);
    const captureProgress = (result: TranslationDocument) => {
      if (typeof result.totalSegments === 'number' && result.totalSegments > 0) {
        setTranslationProgress({
          completed: result.completedSegments ?? 0,
          total: result.totalSegments
        });
      }
    };
    (async () => {
      try {
        let result = await transcriptionTranslate(job.id, target, requestId);
        captureProgress(result);
        while (result.status === 'queued' || result.status === 'processing') {
          if (!active || generation.current !== gen) return;
          await sleep(500);
          if (!active || generation.current !== gen) return;
          result = await transcriptionTranslation(job.id, target);
          captureProgress(result);
        }
        if (!active || generation.current !== gen) return;
        if (result.status === 'completed') {
          validatedTranslations.current.set(result.targetLanguage, result);
          setTranslation(result);
        } else setTranslationError('failed');
      } catch (error) {
        if (!active || generation.current !== gen) return;
        const message = error instanceof Error ? error.message : '';
        setTranslationError(message.includes('TRANSLATOR_UNAVAILABLE') ? 'unavailable' : 'failed');
      } finally {
        if (active && generation.current === gen) setTranslating(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [document_, target, job.id, retryNonce]);

  // Tick an elapsed-time counter while a translation runs so the user sees the
  // process is alive and how long it is taking.
  useEffect(() => {
    if (!translating) return;
    const start = Date.now();
    setTranslationElapsedMs(0);
    const id = window.setInterval(() => setTranslationElapsedMs(Date.now() - start), 200);
    return () => window.clearInterval(id);
  }, [translating]);

  useEffect(() => {
    if (!document_) return;
    const source = document_.sourceLanguage.split('-')[0].toLowerCase();
    setTarget(current => {
      if (current.split('-')[0].toLowerCase() !== source) return current;
      return defaultTranslationTarget(
        document_.sourceLanguage,
        language,
        lastDistinctTarget.current
      );
    });
  }, [document_, language]);

  // Once the translation model finishes installing, resume translation
  // automatically — the user just waits for the animated download to finish.
  useEffect(() => {
    if (!translatorWasPresent.current && translatorModel.present) {
      setRetryNonce(nonce => nonce + 1);
    }
    translatorWasPresent.current = translatorModel.present;
  }, [translatorModel.present]);

  useEffect(() => {
    if (!previewActivated || mediaPreview?.state !== 'preparing') return;
    let active = true;
    const controller = new AbortController();
    const poll = async () => {
      while (active) {
        await sleep(350);
        if (!active) return;
        try {
          const status = await transcriptionMediaStatus(job.id, controller.signal);
          if (!active) return;
          setMediaPreview(status);
          if (status.state !== 'preparing') return;
        } catch {
          if (active) {
            setMediaPreview({
              state: 'failed',
              variant: null,
              progress: null,
              hasVideo: null,
              mimeType: null,
              error: 'PREVIEW_FAILED'
            });
          }
          return;
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewActivated, mediaPreview?.state, job.id]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !previewOpen || mediaPreview?.state !== 'ready') return;
    void media.play().catch(() => {});
  }, [previewOpen, mediaPreview?.state]);

  // Re-align the target side of an existing selection when a new translation
  // arrives (the source selection is preserved across a language switch).
  const translatedBySegment = useMemo(() => {
    const map = new Map<string, TranslatedSegment>();
    for (const segment of translation?.segments ?? []) map.set(segment.sourceSegmentId, segment);
    return map;
  }, [translation]);

  useEffect(() => {
    if (!translation) return;
    setSelection(current => {
      if (!current) return current;
      const parts = current.parts.map(part => {
        const translated = translatedBySegment.get(part.segmentId);
        if (!translated || !part.sourceRanges.length) return part;
        const sourceText = document_?.segments.find(
          segment => segment.id === part.segmentId
        )?.sourceText;
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
  }, [translation, translatedBySegment, document_]);

  const clearSelection = useCallback(() => setSelection(null), []);

  // Escape/backdrop clear a semantic selection first, then close the modal.
  // The Modal primitive owns scroll lock, focus trap and focus restore.
  const dismiss = useCallback(() => {
    if (selectionRef.current) {
      clearSelection();
      return;
    }
    onCloseRef.current();
  }, [clearSelection]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const sourceLanguage = document_?.sourceLanguage ?? job.detectedLanguage ?? 'auto';
  const segments = document_?.segments ?? [];
  const hasWordTimings = segments.some(segment =>
    segment.words.some(word => word.endMs > word.startMs)
  );
  const hasTargetText = useMemo(
    () => segments.some(segment => translatedBySegment.get(segment.id)?.translatedText),
    [segments, translatedBySegment]
  );

  const synchronizeScroll = useCallback((from: HTMLDivElement, to: HTMLDivElement) => {
    if (syncingScroll.current) return;
    // Ignore the echo of our own karaoke auto-scroll — otherwise it would both
    // register as a manual scroll and fight the counterpart's own centering.
    if (Date.now() < programmaticScrollUntil.current) return;
    manualScrollUntil.current = Date.now() + 2500;
    // Snap to the boundaries so the mirror reaches the very top/bottom instead of
    // stopping short — the 25%-line anchor below never resolves to the edges.
    const maxScroll = Math.max(0, to.scrollHeight - to.clientHeight);
    if (from.scrollTop <= 1) {
      syncingScroll.current = true;
      to.scrollTop = 0;
      requestAnimationFrame(() => {
        syncingScroll.current = false;
      });
      return;
    }
    if (from.scrollTop + from.clientHeight >= from.scrollHeight - 1) {
      syncingScroll.current = true;
      to.scrollTop = maxScroll;
      requestAnimationFrame(() => {
        syncingScroll.current = false;
      });
      return;
    }
    const candidates = Array.from(from.querySelectorAll<HTMLElement>('[data-segment-id]'));
    const anchor =
      candidates.find(
        element =>
          element.offsetTop + element.offsetHeight >= from.scrollTop + from.clientHeight * 0.25
      ) ?? candidates.at(-1);
    const id = anchor?.dataset.segmentId;
    const counterpart = id
      ? to.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(id)}"]`)
      : null;
    if (!counterpart) return;
    syncingScroll.current = true;
    to.scrollTop = Math.min(maxScroll, Math.max(0, counterpart.offsetTop - to.clientHeight * 0.25));
    requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  }, []);

  // Keep the karaoke word vertically centered in both columns. Called on every
  // word change so following stays smooth even inside a long segment. Position
  // is measured with getBoundingClientRect relative to the scroller — offsetTop
  // is relative to the offsetParent (neither scroller is positioned), so it does
  // not map to scrollTop and produced the miscentered scroll.
  const centerActiveWord = useCallback(
    (segmentId: string, wordId: string) => {
      // Never fight a scroll the user just made by hand.
      if (Date.now() < manualScrollUntil.current) return;
      let scrolled = false;
      for (const scroller of [sourceScrollRef.current, targetScrollRef.current]) {
        if (!scroller) continue;
        // Center the exact word on the source side; the target has no matching
        // word element, so fall back to keeping its mirrored segment centered.
        const element =
          (wordId
            ? scroller.querySelector<HTMLElement>(`[data-word-id="${CSS.escape(wordId)}"]`)
            : null) ??
          scroller.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(segmentId)}"]`);
        if (!element) continue;
        const scRect = scroller.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        // Where the element sits in the scroller's own scroll coordinate space.
        const elTopInContent = elRect.top - scRect.top + scroller.scrollTop;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const target = Math.max(
          0,
          Math.min(maxScroll, elTopInContent - scroller.clientHeight / 2 + elRect.height / 2)
        );
        // Words on the same visual line share a top, so this is a no-op until the
        // line changes — the view glides line-by-line instead of jittering.
        if (Math.abs(target - scroller.scrollTop) < 4) continue;
        scroller.scrollTo({ top: target, behavior: reducedMotion ? 'auto' : 'smooth' });
        scrolled = true;
      }
      // Cover the smooth animation so its scroll events don't read as manual.
      if (scrolled) programmaticScrollUntil.current = Date.now() + (reducedMotion ? 60 : 650);
    },
    [reducedMotion]
  );

  // Capture a native selection, map it to segment char offsets, resolve the
  // mirror through alignment links, then replace it with a persistent highlight.
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
      const segment = segments.find(item => item.id === segmentId);
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
    const totalWeight = parts.reduce(
      (sum, part) =>
        sum +
        (origin === 'source' ? part.sourceRanges : part.targetRanges).reduce(
          (inner, selected) => inner + selected.end - selected.start,
          0
        ),
      0
    );
    setSelection({
      origin,
      parts,
      confidence:
        parts.reduce((sum, part) => {
          const weight = (origin === 'source' ? part.sourceRanges : part.targetRanges).reduce(
            (inner, selected) => inner + selected.end - selected.start,
            0
          );
          return sum + part.confidence * weight;
        }, 0) / Math.max(1, totalWeight),
      usedFallback: parts.some(part => part.usedFallback)
    });
    native.removeAllRanges();
    return true;
  }, [segments, translatedBySegment]);

  const onSelectionEnd = (event: ReactPointerEvent) => {
    // Never react to pointer-ups on controls: Copy must preserve the resolved
    // selection and a combobox click is not a text selection.
    if (
      (event.target as Element).closest(
        'button, select, input, .transcript-column-head, .transcript-player'
      )
    ) {
      return;
    }
    const native = window.getSelection();
    if (!native || native.isCollapsed) {
      const target = event.target as Element;
      // A word click seeks without disturbing a persistent semantic selection.
      // Only whitespace outside rendered text is the specified "click outside".
      if (
        target.closest('.transcript-column-scroll') &&
        !target.closest('.ts-segment') &&
        !target.closest('[data-word-start-ms]')
      ) {
        clearSelection();
      }
      return;
    }
    resolveNativeSelection();
  };

  // Keyboard selection has no pointer-up. Let the native highlight remain
  // while Shift+Arrow is active, then resolve it after a short quiet period.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
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
  }, [resolveNativeSelection]);

  // A drag can end anywhere (even outside the column), so clear the selecting
  // flag on a window-level pointer release rather than a per-column handler.
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

  // Karaoke: follow the playhead with a binary search over the flat word list.
  const flatWords = useMemo(() => flattenWords(segments), [segments]);
  // Precompute the plain word array once so the animation frame doesn't
  // re-allocate it 60×/second.
  const flatWordList = useMemo(() => flatWords.map(entry => entry.word), [flatWords]);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !previewOpen || !hasWordTimings) return;
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
    const clear = () => {
      stop();
      activeWordId.current = '';
      setActiveWord(null);
    };
    const update = (mediaTimeSeconds: number) => {
      const index = activeWordIndex(flatWordList, mediaTimeSeconds * 1000);
      if (index < 0) {
        if (activeWordId.current) {
          activeWordId.current = '';
          setActiveWord(null);
        }
      } else {
        const entry = flatWords[index];
        if (entry.word.id !== activeWordId.current) {
          // While the user is dragging a selection, leave the DOM untouched so
          // the live selection survives; pick up the current word next tick.
          if (pointerSelecting.current) return;
          activeWordId.current = entry.word.id;
          setActiveWord({
            segmentId: entry.segmentId,
            range: { start: entry.word.sourceStart, end: entry.word.sourceEnd }
          });
          centerActiveWord(entry.segmentId, entry.word.id);
        }
      }
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
      // Video frame metadata tracks the frame actually presented on screen,
      // avoiding currentTime/render skew. Audio-only media has no presented
      // frames, so it keeps the high-frequency RAF clock.
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
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', clear);
    media.addEventListener('ended', clear);
    if (!media.paused) onPlay();
    return () => {
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', clear);
      media.removeEventListener('ended', clear);
      clear();
    };
  }, [previewOpen, hasWordTimings, flatWordList, mediaPreview?.state, centerActiveWord]);

  // Click a source word to seek the player to its start time.
  const onSourceClick = (event: ReactMouseEvent) => {
    const media = mediaRef.current;
    if (!media) return;
    const native = window.getSelection();
    if (native && !native.isCollapsed) return; // a drag-select, not a click
    const word = (event.target as Element).closest<HTMLElement>('[data-word-start-ms]');
    const startMs = Number(word?.dataset.wordStartMs);
    if (!Number.isFinite(startMs)) return;
    const wasPlaying = !media.paused;
    media.currentTime = startMs / 1000;
    if (wasPlaying) void media.play().catch(() => {});
  };

  const copyColumn = async (which: 'source' | 'target') => {
    let text: string;
    let full = true;
    if (selection) {
      const fragments = segments.flatMap(segment => {
        const part = selectedPart(selection, segment.id);
        if (!part) return [];
        const ranges = which === 'source' ? part.sourceRanges : part.targetRanges;
        const base =
          which === 'source'
            ? segment.sourceText
            : (translatedBySegment.get(segment.id)?.translatedText ?? '');
        const fragment = ranges.length && base ? joinRanges(base, ranges) : '';
        return fragment ? [fragment] : [];
      });
      if (fragments.length) {
        text = fragments.join('\n');
        full = false;
      } else {
        text = columnText(which);
      }
    } else {
      text = columnText(which);
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ side: which, scope: full ? 'all' : 'selection' });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1800);
      return full;
    } catch {
      return full;
    }
  };

  const columnText = (which: 'source' | 'target'): string =>
    which === 'source'
      ? segments.map(segment => segment.sourceText).join('\n')
      : segments
          .map(segment => translatedBySegment.get(segment.id)?.translatedText ?? '')
          .filter(Boolean)
          .join('\n');

  const syncPlayback = () => {
    const media = mediaRef.current;
    if (!media) return;
    setPlayback({
      playing: !media.paused && !media.ended,
      currentTime: media.currentTime,
      duration: Number.isFinite(media.duration) ? media.duration : 0,
      volume: media.volume,
      rate: media.playbackRate
    });
  };

  const togglePlayback = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  };

  const seekPlayback = (event: ChangeEvent<HTMLInputElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Number(event.target.value);
    syncPlayback();
  };

  const changeVolume = (event: ChangeEvent<HTMLInputElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.volume = Number(event.target.value);
    syncPlayback();
  };

  const changeRate = (event: ChangeEvent<HTMLSelectElement>) => {
    const media = mediaRef.current;
    if (!media) return;
    media.playbackRate = Number(event.target.value);
    syncPlayback();
  };

  const enterFullscreen = () => {
    const element = playerRef.current;
    if (element?.requestFullscreen) void element.requestFullscreen().catch(() => {});
  };

  const targetName = languageDisplayName(target, language);
  const displayedLanguage = translation?.targetLanguage ?? target;
  const sourceBaseLanguage = sourceLanguage.split('-')[0].toLowerCase();
  const targetLanguageOptions = TARGET_LANGUAGES.filter(
    code => code.split('-')[0].toLowerCase() !== sourceBaseLanguage
  );
  const preparePreview = async () => {
    setPreviewActivated(true);
    setPreviewOpen(true);
    if (mediaPreview?.state === 'ready') {
      await mediaRef.current?.play().catch(() => {});
      return;
    }
    try {
      setMediaPreview(await transcriptionMediaPrepare(job.id));
    } catch {
      setMediaPreview({
        state: 'failed',
        variant: null,
        progress: null,
        hasVideo: null,
        mimeType: null,
        error: 'PREVIEW_FAILED'
      });
    }
  };

  const togglePreview = async () => {
    if (!previewOpen) {
      await preparePreview();
      return;
    }
    mediaRef.current?.pause();
    activeWordId.current = '';
    setActiveWord(null);
    setPreviewOpen(false);
  };

  const cancelPreviewPreparation = async () => {
    await transcriptionMediaCancel(job.id).catch(() => {});
    setMediaPreview(current =>
      current ? { ...current, state: 'checking', progress: null, error: null } : current
    );
    setPreviewOpen(false);
  };

  const audioOnly =
    mediaPreview?.hasVideo === false ||
    AUDIO_EXTENSIONS.has(job.fileName.split('.').at(-1)?.toLowerCase() ?? '');
  // The match meter only means something when there is a translation to compare
  // against. With no translator/translation a source selection is just a plain
  // highlight — never show a fabricated percentage.
  const showMatch =
    !!selection && hasTargetText && selection.parts.some(part => part.targetRanges.length > 0);
  const hasSourceSelection = selection?.parts.some(part => part.sourceRanges.length > 0) === true;
  const hasTargetSelection = selection?.parts.some(part => part.targetRanges.length > 0) === true;
  const grade = showMatch && selection ? confidenceGrade(selection.confidence) : null;
  const gradeLabel =
    grade === 'exact'
      ? t('transcriptionMatchExact')
      : grade === 'high'
        ? t('transcriptionMatchHigh')
        : grade === 'approx'
          ? t('transcriptionMatchApprox')
          : '';

  // Determinate progress + a rough ETA once the backend reports segment counts.
  const translationPercent =
    translationProgress && translationProgress.total > 0
      ? Math.min(100, Math.round((100 * translationProgress.completed) / translationProgress.total))
      : null;
  const translationEtaMs =
    translationProgress &&
    translationProgress.completed > 0 &&
    translationProgress.completed < translationProgress.total &&
    translationElapsedMs > 0
      ? (translationElapsedMs * (translationProgress.total - translationProgress.completed)) /
        translationProgress.completed
      : null;

  return (
    <Modal
      bare
      backdropClassName="transcript-modal-backdrop"
      className={`transcript-modal transcript-split${previewOpen ? ' preview-open' : ''}`}
      labelledBy={titleId}
      onClose={dismiss}
      initialFocus=".transcript-modal-close"
      returnFocus={returnFocus}
      dialogRef={dialog}
      style={
        {
          '--ts-selection-color': selection
            ? confidenceColor(selection.confidence)
            : 'var(--color-success)'
        } as CSSProperties
      }
    >
      <header className="transcript-modal-header">
        <div>
          <h2 id={titleId}>{job.fileName}</h2>
          <p>
            <span>
              {t('transcriptionDetected', {
                language: languageDisplayName(sourceLanguage, language)
              })}
            </span>
            {job.characters !== null && (
              <span>{t('transcriptionCharacters', { count: job.characters })}</span>
            )}
          </p>
        </div>
        {/* Confidence meter */}
        <div
          className={`transcript-match${showMatch ? '' : ' is-empty'}`}
          role="group"
          aria-label={t('transcriptionMatchLabel')}
        >
          <span className="transcript-match-label">{t('transcriptionMatchLabel')}</span>
          <div className="transcript-match-bar" aria-hidden="true">
            {showMatch && (
              <span
                className="transcript-match-pointer"
                style={{ left: `${Math.round((1 - selection!.confidence) * 100)}%` }}
              />
            )}
          </div>
          <span className="transcript-match-value">
            {showMatch
              ? `${gradeLabel} · ${Math.round(selection!.confidence * 100)}%`
              : t('transcriptionMatchEmpty')}
          </span>
          <button
            type="button"
            className="transcript-match-help"
            aria-label={t('transcriptionMatchHint')}
            aria-describedby={matchHintId}
          >
            ?
          </button>
          <span id={matchHintId} className="transcript-match-tooltip" role="tooltip">
            {t('transcriptionMatchHint')}
          </span>
        </div>
        <button
          type="button"
          className="transcript-modal-close"
          aria-label={t('transcriptionModalClose')}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="transcript-split-body" ref={bodyRef} onPointerUp={onSelectionEnd}>
        <section
          className="transcript-column"
          data-side="source"
          aria-label={t('transcriptionSourceColumn')}
          dir={isRtlLanguage(sourceLanguage) ? 'rtl' : 'ltr'}
        >
          <div className="transcript-column-head">
            <span className="transcript-column-title">
              {languageDisplayName(sourceLanguage, language)}
            </span>
            <Button variant="ghost" onClick={() => void copyColumn('source')}>
              {copied?.side === 'source'
                ? copied.scope === 'selection'
                  ? t('transcriptionCopiedSelection')
                  : t('transcriptionCopiedAll')
                : hasSourceSelection
                  ? t('transcriptionCopySelection')
                  : t('transcriptionCopyAll')}
            </Button>
          </div>
          <div
            ref={sourceScrollRef}
            className="transcript-column-scroll"
            onClick={onSourceClick}
            onPointerDown={event => {
              if ((event.target as Element).closest('.ts-segment')) pointerSelecting.current = true;
            }}
            onScroll={event => {
              const other = targetScrollRef.current;
              if (other) synchronizeScroll(event.currentTarget, other);
            }}
          >
            {segments.length ? (
              segments.map(segment => (
                <SegmentText
                  key={segment.id}
                  text={segment.sourceText}
                  segmentId={segment.id}
                  words={segment.words}
                  selectedRanges={selectedPart(selection, segment.id)?.sourceRanges ?? NO_RANGES}
                  activeRanges={
                    activeWord?.segmentId === segment.id ? [activeWord.range] : NO_RANGES
                  }
                />
              ))
            ) : (
              <div className="transcript-modal-empty">{t('transcriptionModalEmpty')}</div>
            )}
          </div>
        </section>

        <section
          className="transcript-column"
          data-side="target"
          aria-label={t('transcriptionTranslationColumn')}
          dir={isRtlLanguage(displayedLanguage) ? 'rtl' : 'ltr'}
          aria-busy={translating}
        >
          <div className="transcript-column-head">
            <span className="transcript-column-title">
              {languageDisplayName(displayedLanguage, language)}
            </span>
            <div className="transcript-column-actions">
              <LanguageCombobox
                value={target}
                codes={targetLanguageOptions}
                language={language}
                label={t('transcriptionLanguageSearch')}
                onChange={code => {
                  lastDistinctTarget.current = code;
                  const cached = validatedTranslations.current.get(code);
                  if (cached) {
                    setTranslation(cached);
                    setTranslating(false);
                    setTranslationError(null);
                  }
                  setTarget(code);
                }}
              />
              <Button variant="ghost" onClick={() => void copyColumn('target')}>
                {copied?.side === 'target'
                  ? copied.scope === 'selection'
                    ? t('transcriptionCopiedSelection')
                    : t('transcriptionCopiedAll')
                  : hasTargetSelection
                    ? t('transcriptionCopySelection')
                    : t('transcriptionCopyAll')}
              </Button>
            </div>
          </div>

          {(translating || translationError) && (
            <div
              className={`transcript-translation-status${translationError ? ' is-error' : ''}`}
              role={translationError ? 'alert' : 'status'}
            >
              {translating && (
                <div className="transcript-translation-progress">
                  <span>
                    {displayedLanguage !== target
                      ? `${languageDisplayName(displayedLanguage, language)} → `
                      : ''}
                    {t('transcriptionTranslating', { language: targetName })}
                  </span>
                  <div className="transcript-translation-progress-row">
                    <ProgressBar
                      value={translationPercent}
                      active
                      label={t('transcriptionTranslating', { language: targetName })}
                    />
                    <span className="transcript-translation-elapsed">
                      {translationPercent !== null && `${translationPercent}% · `}
                      {formatMediaTime(translationElapsedMs / 1000)}
                      {translationEtaMs !== null &&
                        ` · ~${formatMediaTime(translationEtaMs / 1000)}`}
                    </span>
                  </div>
                </div>
              )}
              {translationError === 'unavailable' && (
                <span>
                  {displayedLanguage !== target
                    ? `${languageDisplayName(displayedLanguage, language)} → ${targetName}: `
                    : ''}
                  {t('transcriptionTranslationUnavailable')}
                </span>
              )}
              {translationError === 'failed' && (
                <span>
                  {displayedLanguage !== target
                    ? `${languageDisplayName(displayedLanguage, language)} → ${targetName}: `
                    : ''}
                  {t('transcriptionTranslationFailed')}
                </span>
              )}
            </div>
          )}

          <div
            ref={targetScrollRef}
            className="transcript-column-scroll"
            onPointerDown={event => {
              if ((event.target as Element).closest('.ts-segment')) pointerSelecting.current = true;
            }}
            onScroll={event => {
              const other = sourceScrollRef.current;
              if (other) synchronizeScroll(event.currentTarget, other);
            }}
          >
            {translationError === 'unavailable' && (
              <div className="transcript-translation-notice">
                {translatorModel.downloading ? (
                  <>
                    <span>
                      {t('transcriptionTranslatorInstalling', {
                        progress: translatorModel.progress ?? 0
                      })}
                    </span>
                    <ProgressBar
                      value={translatorModel.progress}
                      active
                      label={t('transcriptionTranslatorInstall')}
                    />
                    <Button variant="ghost" onClick={onCancelTranslator}>
                      {t('transcriptionModelCancelBtn')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span>
                      {t('transcriptionTranslatorIntro', {
                        size: formatSize(translatorModel.sizeBytes || 2_500_000_000, language)
                      })}
                    </span>
                    <label className="transcription-gemma-consent">
                      <input
                        type="checkbox"
                        checked={translatorTermsAccepted}
                        onChange={event => setTranslatorTermsAccepted(event.target.checked)}
                      />
                      <span>
                        {t('transcriptionGemmaConsent')}{' '}
                        <a
                          href="https://ai.google.dev/gemma/terms"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('transcriptionGemmaTerms')}
                        </a>{' '}
                        {t('transcriptionGemmaAnd')}{' '}
                        <a
                          href="https://ai.google.dev/gemma/prohibited_use_policy"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('transcriptionGemmaPolicy')}
                        </a>
                        .
                      </span>
                    </label>
                    {translatorModel.error && (
                      <span className="transcription-model-error">
                        {translatorModel.error === 'MODEL_SOURCE_NOT_CONFIGURED'
                          ? t('transcriptionTranslatorNotConfigured')
                          : t('transcriptionTranslationFailed')}
                      </span>
                    )}
                    <Button
                      variant="primary"
                      disabled={!translatorTermsAccepted}
                      onClick={onInstallTranslator}
                    >
                      {t('transcriptionTranslatorInstall')}
                    </Button>
                  </>
                )}
              </div>
            )}
            {translationError === 'failed' && (
              <div className="transcript-translation-notice" role="alert">
                <Button variant="secondary" onClick={() => setRetryNonce(nonce => nonce + 1)}>
                  {t('transcriptionTranslationRetry')}
                </Button>
              </div>
            )}
            {hasTargetText ? (
              <div
                className={`transcript-translation-content${
                  translating ? (reducedMotion ? ' is-translating-static' : ' is-translating') : ''
                }`}
              >
                {segments.map(segment => {
                  const translated = translatedBySegment.get(segment.id);
                  if (!translated) return null;
                  const activeRanges =
                    activeWord?.segmentId === segment.id
                      ? resolveMirroredSelection(
                          activeWord.range,
                          translated.alignments,
                          'source',
                          translated.translatedText.length
                        ).ranges
                      : NO_RANGES;
                  return (
                    <SegmentText
                      key={segment.id}
                      text={translated.translatedText}
                      segmentId={segment.id}
                      selectedRanges={
                        selectedPart(selection, segment.id)?.targetRanges ?? NO_RANGES
                      }
                      activeRanges={activeRanges}
                    />
                  );
                })}
              </div>
            ) : !translationError ? (
              <div className="transcript-modal-empty">{t('transcriptionTranslationEmpty')}</div>
            ) : null}
          </div>

          <p className="visually-hidden" role="status" aria-live="polite">
            {translating ? t('transcriptionTranslating', { language: targetName }) : ''}
          </p>
        </section>
      </div>

      <div id={previewId} className={`transcript-preview${previewOpen ? ' open' : ''}`}>
        {previewActivated && (
          <div
            className="transcript-preview-panel"
            aria-hidden={!previewOpen}
            {...(!previewOpen ? { inert: true } : {})}
          >
            {mediaPreview?.state === 'ready' ? (
              <div ref={playerRef} className={`transcript-player${audioOnly ? ' audio-only' : ''}`}>
                <video
                  ref={mediaRef}
                  className="transcript-preview-media"
                  src={transcriptionMediaUrl(job.id)}
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={syncPlayback}
                  onDurationChange={syncPlayback}
                  onTimeUpdate={syncPlayback}
                  onPlay={syncPlayback}
                  onPause={syncPlayback}
                  onEnded={syncPlayback}
                  onVolumeChange={syncPlayback}
                  onRateChange={syncPlayback}
                />
                {audioOnly && (
                  <div className="transcript-audio-poster" aria-hidden="true">
                    <span className="transcript-audio-mark">W</span>
                    <span className="transcript-audio-bars">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                )}
                <div className="transcript-player-controls">
                  <button
                    type="button"
                    className="transcript-player-icon"
                    onClick={togglePlayback}
                    aria-label={
                      playback.playing
                        ? t('transcriptionPlayerPause')
                        : t('transcriptionPlayerPlay')
                    }
                  >
                    <span aria-hidden="true">{playback.playing ? 'Ⅱ' : '▶'}</span>
                  </button>
                  <span className="transcript-player-time">
                    {formatMediaTime(playback.currentTime)} / {formatMediaTime(playback.duration)}
                  </span>
                  <input
                    className="transcript-player-seek"
                    type="range"
                    min="0"
                    max={Math.max(0, playback.duration)}
                    step="0.01"
                    value={Math.min(playback.currentTime, playback.duration || 0)}
                    onChange={seekPlayback}
                    aria-label={t('transcriptionPlayerSeek')}
                  />
                  <label className="transcript-player-volume">
                    <span aria-hidden="true">◕</span>
                    <span className="visually-hidden">{t('transcriptionPlayerVolume')}</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={playback.volume}
                      onChange={changeVolume}
                    />
                  </label>
                  <label className="transcript-player-rate">
                    <span className="visually-hidden">{t('transcriptionPlayerSpeed')}</span>
                    <select value={playback.rate} onChange={changeRate}>
                      {[0.75, 1, 1.25, 1.5, 2].map(rate => (
                        <option key={rate} value={rate}>
                          {rate}×
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="transcript-player-icon"
                    onClick={enterFullscreen}
                    aria-label={t('transcriptionPlayerFullscreen')}
                  >
                    <span aria-hidden="true">⛶</span>
                  </button>
                </div>
                {!hasWordTimings && (
                  <p className="transcript-preview-note">{t('transcriptionKaraokeUnavailable')}</p>
                )}
              </div>
            ) : mediaPreview?.state === 'failed' ? (
              <div className="transcript-preview-status" role="alert">
                <span>{t('transcriptionPreviewUnavailable')}</span>
                <Button variant="secondary" onClick={() => void preparePreview()}>
                  {t('transcriptionTranslationRetry')}
                </Button>
              </div>
            ) : (
              <div className="transcript-preview-status" role="status">
                <span>
                  {t('transcriptionPreviewPreparing')}
                  {mediaPreview?.progress !== null && mediaPreview?.progress !== undefined
                    ? ` ${Math.round(mediaPreview.progress)}%`
                    : ''}
                </span>
                <ProgressBar
                  value={mediaPreview?.progress ?? null}
                  active
                  label={t('transcriptionPreviewPreparing')}
                />
                <Button variant="ghost" onClick={() => void cancelPreviewPreparation()}>
                  {t('transcriptionCancel')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="transcript-modal-footer">
        <Button
          variant="secondary"
          onClick={() => void togglePreview()}
          aria-expanded={previewOpen}
          aria-controls={previewId}
        >
          <span aria-hidden="true">{previewOpen ? '⌄' : '▶'}</span>
          {previewOpen ? t('transcriptionPreviewCollapse') : t('transcriptionPreview')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('transcriptionModalClose')}
        </Button>
      </footer>
      <div
        className={`transcript-copy-toast${copied ? ' is-visible' : ''}`}
        role="status"
        aria-live="polite"
      >
        {copied
          ? copied.scope === 'selection'
            ? t('transcriptionCopiedSelection')
            : t('transcriptionCopiedAll')
          : ''}
      </div>
    </Modal>
  );
}
