import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from 'react';
import { ChevronDown, FolderDown, Play, X } from 'lucide-react';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionModelInfo,
  TranscriptSegment,
  TranscriptWord,
  TranslatedSegment
} from '@video-compressor/shared';
import { TRANSLATEGEMMA_LANGUAGE_CODES } from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { Button, ProgressBar, Tooltip, type Translate } from '../components/ui';
import { transcriptionMediaPath, transcriptionSaveWithTranslation } from '../api/client';
import { isRtlLanguage, languageDisplayName } from './language';
import { useTranslationFollow } from './useTranslationFollow';
import type { Language } from '../i18n';
import {
  confidenceColor,
  confidenceGrade,
  resolveMirroredSelection,
  type CharRange
} from './alignment';
import { selectedPart, useSemanticSelection, type SemanticSelection } from './useSemanticSelection';
import { joinRanges, splitTextByRanges } from './selection-dom';
import { useSubresourceUrl } from '../api/useSubresourceUrl';
import { loadTranscriptDocument } from './document-cache';
import { useMediaPreview } from './useMediaPreview';
import { TranscriptPlayer } from './TranscriptPlayer';
import { TranslationElapsed } from './TranslationElapsed';
import { LanguageCombobox } from './LanguageCombobox';
import { TranslationCaveat, TranslatorNotice } from './TranslatorNotice';
import { ExportMenu } from './ExportMenu';
import { type KaraokeStore, useActiveWordInSegment } from './karaoke-store';
import { useScrollSync } from './useScrollSync';
import { useKaraoke } from './useKaraoke';
import { hasTimings, type TranscriptExportContent, type TranscriptExportFormat } from './export';

const TARGET_LANGUAGES = [...TRANSLATEGEMMA_LANGUAGE_CODES];

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

function emptyDocument(job: TranscriptionJob): TranscriptionDocument {
  return {
    jobId: job.id,
    sourceLanguage: job.detectedLanguage ?? job.requestedLanguage ?? 'auto',
    modelVersion: '',
    segments: [],
    translations: {}
  };
}

/** Shared empty-range constant so memoized segments skip re-render when idle. */
const NO_RANGES: CharRange[] = [];

/**
 * One rendered segment with its selection + karaoke highlight layers.
 *
 * Memoized, and the word lookup is a map rather than a scan: a dense segment has eighty
 * words and twice as many pieces, and finding each piece's word by walking the list was
 * quadratic on every render of every segment.
 */
const SegmentText = memo(function SegmentText({
  text,
  segmentId,
  selectedRanges,
  activeRanges,
  words = NO_WORDS,
  focusable = false,
  tabStop = true,
  activeWordId = null
}: {
  text: string;
  segmentId: string;
  selectedRanges: CharRange[];
  activeRanges: CharRange[];
  words?: TranscriptWord[];
  /** A keyboard stop, so Enter can seek the player to this segment. */
  focusable?: boolean;
  /** One segment is the column's Tab stop; the arrows reach the rest. */
  tabStop?: boolean;
  /** The karaoke word, so a re-render of this segment keeps its highlight. */
  activeWordId?: string | null;
}) {
  const wordBoundaries = useMemo(
    () => words.flatMap(word => [word.sourceStart, word.sourceEnd]),
    [words]
  );
  const wordAtOffset = useMemo(() => {
    const map = new Map<number, TranscriptWord>();
    for (const word of words) map.set(word.sourceStart, word);
    return map;
  }, [words]);
  const pieces = useMemo(
    () => splitTextByRanges(text, selectedRanges, activeRanges, wordBoundaries),
    [text, selectedRanges, activeRanges, wordBoundaries]
  );
  const focus = focusable ? { tabIndex: tabStop ? 0 : -1 } : {};
  if (pieces.length === 0) {
    return (
      <p className="ts-segment" data-segment-id={segmentId} {...focus}>
        {text}
      </p>
    );
  }
  // Pieces arrive in order, so the word that contains a piece is the last word that
  // started at or before it — tracked with a cursor instead of searched.
  let current: TranscriptWord | undefined;
  return (
    <p className="ts-segment" data-segment-id={segmentId} {...focus}>
      {pieces.map((piece, index) => {
        const started = wordAtOffset.get(piece.start);
        if (started) current = started;
        const word =
          current && piece.end <= current.sourceEnd && piece.start >= current.sourceStart
            ? current
            : undefined;
        return (
          <span
            key={index}
            className={`${piece.selected ? 'ts-selected' : ''} ${piece.active || (word !== undefined && word.id === activeWordId) ? 'ts-active' : ''}`.trim()}
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

const NO_WORDS: TranscriptWord[] = [];

/**
 * A source segment that knows the karaoke word.
 *
 * The playhead marks words on the DOM directly, for speed; but React rewrites a span's class
 * whenever a selection re-splits the segment, and the mark vanished until the next word.
 * Subscribed to its own segment only, the segment renders the mark itself, so a rewrite
 * keeps it.
 */
const SourceSegment = memo(function SourceSegment({
  segment,
  selectedRanges,
  store,
  focusable,
  tabStop
}: {
  segment: TranscriptSegment;
  selectedRanges: CharRange[];
  store: KaraokeStore;
  focusable: boolean;
  tabStop: boolean;
}) {
  const active = useActiveWordInSegment(store, segment.id);
  return (
    <SegmentText
      text={segment.sourceText}
      segmentId={segment.id}
      words={segment.words}
      selectedRanges={selectedRanges}
      activeRanges={NO_RANGES}
      focusable={focusable}
      tabStop={tabStop}
      activeWordId={active?.wordId ?? null}
    />
  );
});

/**
 * A translated segment that follows the karaoke word on its own.
 *
 * Subscribes to the store for its own segment only, so the playhead moving through the
 * rest of the document never reaches it.
 */
const TargetSegment = memo(function TargetSegment({
  segmentId,
  translated,
  selectedRanges,
  store,
  focusable,
  tabStop
}: {
  segmentId: string;
  translated: TranslatedSegment;
  selectedRanges: CharRange[];
  store: KaraokeStore;
  focusable: boolean;
  tabStop: boolean;
}) {
  const active = useActiveWordInSegment(store, segmentId);
  const activeRanges = useMemo(
    () =>
      active
        ? resolveMirroredSelection(
            active.range,
            translated.alignments,
            'source',
            translated.translatedText.length
          ).ranges
        : NO_RANGES,
    [active, translated]
  );
  return (
    <SegmentText
      text={translated.translatedText}
      segmentId={segmentId}
      selectedRanges={selectedRanges}
      activeRanges={activeRanges}
      focusable={focusable}
      tabStop={tabStop}
    />
  );
});

export const TranscriptTextModal = memo(function TranscriptTextModal({
  job,
  language,
  returnFocus,
  translatorModel,
  onInstallTranslator,
  onCancelTranslator,
  onExport,
  onToast,
  onClose,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  returnFocus: HTMLElement | null;
  translatorModel: TranscriptionModelInfo;
  onInstallTranslator: () => void;
  onCancelTranslator: () => void;
  onExport?: (format: TranscriptExportFormat, content: TranscriptExportContent) => void;
  /** The page's toasts; the viewer has no second notification system of its own. */
  onToast?: (text: string, tone?: 'neutral' | 'success' | 'warning' | 'error') => void;
  onClose: () => void;
  t: Translate;
}) {
  // Ticketed rather than token-carrying: the player seeks, so this URL is used repeatedly
  // and sits in the element for as long as the modal is open — the worst possible place
  // for a session token to live.
  const mediaUrl = useSubresourceUrl(job ? transcriptionMediaPath(job.id) : null);
  const titleId = useId();
  const previewId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);

  const [document_, setDocument] = useState<TranscriptionDocument | null>(null);
  const [copied, setCopied] = useState<{
    side: 'source' | 'target';
    scope: 'selection' | 'all';
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // How the columns answer the keyboard, said once for screen readers.
  const hintId = useId();
  const [previewActivated, setPreviewActivated] = useState(false);
  const {
    preview: mediaPreview,
    prepare: prepareMedia,
    cancel: cancelMedia,
    fail: failPreview
  } = useMediaPreview(job.id);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionRef = useRef<SemanticSelection | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const reducedMotion = useReducedMotion();

  // A load that failed is said to have failed. It used to fall back to an empty document,
  // and the viewer then announced that the file had no speech — over a transcript of a
  // thousand characters that was on disk the whole time.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDocument(null);
    setLoadFailed(false);
    loadTranscriptDocument(job)
      .then(doc => {
        if (active) setDocument(doc);
      })
      .catch(() => {
        if (!active) return;
        setLoadFailed(true);
        setDocument(emptyDocument(job));
      });
    return () => {
      active = false;
    };
  }, [job.id, job.finishedAt, loadAttempt]);

  const {
    target,
    chooseTarget,
    translation,
    summary,
    translating,
    requesting,
    error: translationError,
    retry: retryTranslation,
    cancel: cancelTranslation
  } = useTranslationFollow({
    job,
    document: document_,
    language,
    translatorPresent: translatorModel.present
  });

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !previewOpen || mediaPreview?.state !== 'ready') return;
    void media.play().catch(() => {});
  }, [previewOpen, mediaPreview?.state]);

  const translatedBySegment = useMemo(() => {
    const map = new Map<string, TranslatedSegment>();
    for (const segment of translation?.segments ?? []) map.set(segment.sourceSegmentId, segment);
    return map;
  }, [translation]);
  const segments = document_?.segments ?? NO_SEGMENTS;
  // Once per document, not once per render: an O(n) scan of every word on every frame.
  const timed = useMemo(() => hasTimings(segments), [segments]);
  const segmentById = useMemo(
    () => new Map(segments.map(segment => [segment.id, segment])),
    [segments]
  );

  const { selection, clearSelection, pointerSelecting, onSelectionEnd, onColumnPointerDown } =
    useSemanticSelection({ dialog, segmentById, translatedBySegment, translation });
  selectionRef.current = selection;

  // Escape/backdrop clear a semantic selection first, then close the modal.
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
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  const sourceLanguage = document_?.sourceLanguage ?? job.detectedLanguage ?? 'auto';
  const hasWordTimings = useMemo(
    () => segments.some(segment => segment.words.some(word => word.endMs > word.startMs)),
    [segments]
  );
  const firstTranslatedSegmentId = useMemo(
    () => segments.find(segment => translatedBySegment.get(segment.id)?.translatedText)?.id ?? null,
    [segments, translatedBySegment]
  );
  const hasTargetText = useMemo(
    () => segments.some(segment => translatedBySegment.get(segment.id)?.translatedText),
    [segments, translatedBySegment]
  );

  const { sourceScrollRef, targetScrollRef, synchronizeScroll, centerActiveWord } = useScrollSync({
    layoutKey: `${job.id}@${job.finishedAt ?? 0}|${translation?.targetLanguage ?? ''}:${translation?.segments.length ?? 0}|${hasTargetText}`,
    reducedMotion
  });

  // Below this height the player shows its controls and no picture (see the stylesheet),
  // and the button that opens it says so.
  const pictureFolded = useMediaQueryMatch('(max-height: 820px)');
  const { store: karaoke, clear: clearKaraoke } = useKaraoke({
    mediaRef,
    sourceScrollRef,
    segments,
    enabled: previewOpen && hasWordTimings && mediaPreview?.state === 'ready',
    pointerSelecting,
    centerActiveWord
  });

  const seekTo = (startMs: number) => {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(startMs)) return;
    const wasPlaying = !media.paused;
    media.currentTime = startMs / 1000;
    if (wasPlaying) void media.play().catch(() => {});
  };
  // Click a source word to seek the player to its start time.
  const onSourceClick = (event: ReactMouseEvent) => {
    if (!mediaRef.current) return;
    const native = window.getSelection();
    if (native && !native.isCollapsed) return;
    const word = (event.target as Element).closest<HTMLElement>('[data-word-start-ms]');
    seekTo(Number(word?.dataset.wordStartMs));
  };
  // The keyboard's way to the same place: a segment takes focus, Enter seeks to its start.
  // Thousands of focusable words would be a Tab key nobody could get through; one stop per
  // segment is a list a person can move along.
  const saveWithTranslation = async () => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    try {
      await transcriptionSaveWithTranslation(job.id, {
        languageLabel: languageDisplayName(sourceLanguage, language),
        fileName: `${t('transcriptionExportFileName')}.txt`
      });
      setSaveState('saved');
      onToast?.(t('transcriptionSavedWithTranslation'), 'success');
    } catch {
      setSaveState('failed');
      onToast?.(t('transcriptionSaveWithTranslationFailed'), 'error');
    }
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaveState('idle'), 2500);
  };

  const columnText = (which: 'source' | 'target'): string =>
    which === 'source'
      ? segments.map(segment => segment.sourceText).join('\n')
      : segments
          .map(segment => translatedBySegment.get(segment.id)?.translatedText ?? '')
          .filter(Boolean)
          .join('\n');

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
      onToast?.(full ? t('transcriptionCopiedAll') : t('transcriptionCopiedSelection'), 'success');
    } catch {
      onToast?.(t('transcriptionFailedTitle'), 'error');
    }
  };

  const targetName = languageDisplayName(target, language);
  const displayedLanguage = translation?.targetLanguage ?? target;
  const sourceBaseLanguage = sourceLanguage.split('-')[0].toLowerCase();
  const targetLanguageOptions = useMemo(
    () => TARGET_LANGUAGES.filter(code => code.split('-')[0].toLowerCase() !== sourceBaseLanguage),
    [sourceBaseLanguage]
  );

  const preparePreview = async () => {
    setPreviewActivated(true);
    setPreviewOpen(true);
    if (mediaPreview?.state === 'ready') {
      await mediaRef.current?.play().catch(() => {});
      return;
    }
    await prepareMedia();
  };
  const togglePreview = async () => {
    if (!previewOpen) {
      await preparePreview();
      return;
    }
    mediaRef.current?.pause();
    clearKaraoke();
    setPreviewOpen(false);
  };
  const cancelPreviewPreparation = async () => {
    await cancelMedia();
    setPreviewOpen(false);
  };

  // Enter on a segment before the player is open: the player opens and seeks there once
  // it has its metadata, so the keyboard reaches the transcript without a detour through
  // the footer.
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
  useEffect(() => {
    if (pendingSeekMs === null || !previewOpen) return;
    const media = mediaRef.current;
    if (!media) return;
    const go = () => {
      seekTo(pendingSeekMs);
      setPendingSeekMs(null);
    };
    if (media.readyState >= 1) {
      go();
      return;
    }
    media.addEventListener('loadedmetadata', go, { once: true });
    return () => media.removeEventListener('loadedmetadata', go);
    // `seekTo` reads the media element through its ref, so the seek needs no dependency.
  }, [pendingSeekMs, previewOpen, mediaPreview?.state]);
  const onSegmentKeyDown = (event: ReactKeyboardEvent) => {
    const segment = (event.target as Element).closest<HTMLElement>('[data-segment-id]');
    if (!segment) return;
    // One Tab stop for the column; the arrows walk the segments. Every segment as a stop
    // was ninety presses to reach the footer of a six-minute file.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const all = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('[data-segment-id]')
      );
      const next = all[all.indexOf(segment) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    // The translation column shares the source's segment ids, so its Enter seeks to the
    // words of the source segment it mirrors.
    const id = segment.dataset.segmentId ?? '';
    const first = sourceScrollRef.current?.querySelector<HTMLElement>(
      `[data-segment-id="${CSS.escape(id)}"] [data-word-start-ms]`
    );
    if (!first) return;
    event.preventDefault();
    const startMs = Number(first.dataset.wordStartMs);
    if (mediaRef.current) {
      seekTo(startMs);
      return;
    }
    setPendingSeekMs(startMs);
    void togglePreview();
  };

  const audioOnly =
    mediaPreview?.hasVideo === false ||
    AUDIO_EXTENSIONS.has(job.fileName.split('.').at(-1)?.toLowerCase() ?? '');
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

  const translationPercent = translating ? (summary?.progress ?? null) : null;
  const translationQueued = summary?.status === 'queued' && !requesting;
  const translationCompleted = translation?.status === 'completed';
  const loading = document_ === null;

  const copyLabel = (side: 'source' | 'target', hasSelection: boolean) =>
    copied?.side === side
      ? copied.scope === 'selection'
        ? t('transcriptionCopiedSelection')
        : t('transcriptionCopiedAll')
      : hasSelection
        ? t('transcriptionCopySelection')
        : t('transcriptionCopyAll');

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
          '--ts-selection-color':
            selection && hasTargetText
              ? confidenceColor(selection.confidence)
              : 'var(--color-accent)'
        } as CSSProperties
      }
    >
      <header className="transcript-modal-header">
        <div className="transcript-modal-heading">
          <h2 id={titleId} title={job.fileName}>
            {job.fileName}
          </h2>
          <p>
            <span>
              {t('transcriptionDetected', {
                language: languageDisplayName(sourceLanguage, language)
              })}
            </span>
            {job.characters !== null && (
              <span>{t('transcriptionCharacters', { count: job.characters })}</span>
            )}
            {job.quality && (
              <span>
                {job.quality === 'fast'
                  ? t('transcriptionQualityFast')
                  : t('transcriptionQualityAccurate')}
              </span>
            )}
          </p>
        </div>
        {/* Nothing to match against until a translation exists: a row of inert dots above
            the text was the second thing in the dialog, and said nothing. */}
        {hasTargetText && (
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
                : selection
                  ? t('transcriptionMatchNoTranslation')
                  : t('transcriptionMatchEmpty')}
            </span>
            <Tooltip label={t('transcriptionMatchHint')}>{t('transcriptionMatchHint')}</Tooltip>
          </div>
        )}
        <button
          type="button"
          className="transcript-modal-close"
          aria-label={t('transcriptionModalClose')}
          onClick={onClose}
        >
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div className="transcript-split-body" onPointerUp={onSelectionEnd}>
        <section
          className="transcript-column"
          data-side="source"
          aria-describedby={hintId}
          aria-label={t('transcriptionSourceColumn')}
          aria-busy={loading}
        >
          <div className="transcript-column-head">
            <span className="transcript-column-title">
              {languageDisplayName(sourceLanguage, language)}
            </span>
            <Button variant="ghost" disabled={loading} onClick={() => void copyColumn('source')}>
              {copyLabel('source', hasSourceSelection)}
            </Button>
          </div>
          <div
            ref={sourceScrollRef}
            className="transcript-column-scroll"
            onClick={onSourceClick}
            onKeyDown={onSegmentKeyDown}
            onPointerDown={onColumnPointerDown}
            onScroll={event => {
              const other = targetScrollRef.current;
              if (other) synchronizeScroll(event.currentTarget, other);
            }}
          >
            {loading ? (
              <div className="transcript-modal-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>{t('transcriptionModalLoading')}</span>
              </div>
            ) : segments.length ? (
              /* The direction belongs to the transcript, not the column: on the column it
                 also flipped the interface's own loading and failure sentences for an
                 Arabic or Pashto file, period first. */
              <div
                className="transcript-column-text"
                dir={isRtlLanguage(sourceLanguage) ? 'rtl' : 'ltr'}
              >
                {segments.map((segment, index) => (
                  <SourceSegment
                    key={segment.id}
                    segment={segment}
                    selectedRanges={selectedPart(selection, segment.id)?.sourceRanges ?? NO_RANGES}
                    store={karaoke}
                    // Reachable whether or not the words are timed: Enter seeks only when
                    // they are, but reading by keyboard needs no timestamps.
                    focusable
                    tabStop={index === 0}
                  />
                ))}
              </div>
            ) : (
              <div className="transcript-modal-empty">
                {loadFailed ? (
                  <>
                    <span>{t('transcriptionModalLoadFailed')}</span>
                    <Button variant="secondary" onClick={() => setLoadAttempt(count => count + 1)}>
                      {t('tryAgain')}
                    </Button>
                  </>
                ) : (
                  t('transcriptionModalEmpty')
                )}
              </div>
            )}
          </div>
        </section>

        <section
          className="transcript-column"
          data-side="target"
          aria-describedby={hintId}
          aria-label={t('transcriptionTranslationColumn')}
          aria-busy={translating}
        >
          <div className="transcript-column-head">
            {/* The picker names the language; a title saying it again above was noise. */}
            <span className="transcript-column-title visually-hidden">
              {languageDisplayName(displayedLanguage, language)}
            </span>
            <div className="transcript-column-actions">
              <LanguageCombobox
                value={target}
                codes={targetLanguageOptions}
                language={language}
                label={t('transcriptionLanguageSearch')}
                onChange={chooseTarget}
              />
              <Button
                variant="ghost"
                disabled={!hasTargetText}
                onClick={() => void copyColumn('target')}
              >
                {copyLabel('target', hasTargetSelection)}
              </Button>
            </div>
          </div>

          <TranslationCaveat t={t} />

          {(translating || translationError) && (
            <div
              className={`transcript-translation-status${translationError === 'failed' ? ' is-error' : ''}`}
              role={translationError === 'failed' ? 'alert' : 'status'}
            >
              {translating && (
                <div className="transcript-translation-progress">
                  <span>
                    {displayedLanguage !== target
                      ? `${languageDisplayName(displayedLanguage, language)} → `
                      : ''}
                    {translationQueued
                      ? t('statusQueued')
                      : t('transcriptionTranslating', { language: targetName })}
                  </span>
                  <div className="transcript-translation-progress-row">
                    <ProgressBar
                      value={translationPercent}
                      active
                      label={t('transcriptionTranslating', { language: targetName })}
                    />
                    <TranslationElapsed
                      startedAt={summary?.startedAt ?? null}
                      percent={translationPercent}
                    />
                    <Button variant="ghost" onClick={() => void cancelTranslation()}>
                      {t('transcriptionCancel')}
                    </Button>
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
            onKeyDown={onSegmentKeyDown}
            onPointerDown={onColumnPointerDown}
            onScroll={event => {
              const other = sourceScrollRef.current;
              if (other) synchronizeScroll(event.currentTarget, other);
            }}
          >
            {translationError === 'unavailable' && (
              <TranslatorNotice
                translatorModel={translatorModel}
                language={language}
                onInstall={onInstallTranslator}
                onCancel={onCancelTranslator}
                t={t}
              />
            )}
            {translationError === 'failed' && (
              <div className="transcript-translation-notice" role="alert">
                <Button variant="secondary" onClick={retryTranslation}>
                  {t('transcriptionTranslationRetry')}
                </Button>
              </div>
            )}
            {hasTargetText ? (
              <div
                className="transcript-translation-content"
                dir={isRtlLanguage(displayedLanguage) ? 'rtl' : 'ltr'}
              >
                {segments.map(segment => {
                  const translated = translatedBySegment.get(segment.id);
                  if (!translated) return null;
                  return (
                    <TargetSegment
                      key={segment.id}
                      segmentId={segment.id}
                      translated={translated}
                      selectedRanges={
                        selectedPart(selection, segment.id)?.targetRanges ?? NO_RANGES
                      }
                      store={karaoke}
                      focusable
                      // The first segment that has a translation, not the first segment:
                      // during a streaming translation the two can differ.
                      tabStop={segment.id === firstTranslatedSegmentId}
                    />
                  );
                })}
              </div>
            ) : !translationError && !translating && !loading ? (
              <div className="transcript-modal-empty">{t('transcriptionTranslationEmpty')}</div>
            ) : null}
          </div>

          <p id={hintId} className="visually-hidden">
            {t('transcriptionSeekHint')}
          </p>
          <p className="visually-hidden" role="status" aria-live="polite">
            {translating
              ? t('transcriptionTranslating', { language: targetName })
              : translationCompleted
                ? t('transcriptionTranslationReady', { language: targetName })
                : ''}
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
              <TranscriptPlayer
                ref={mediaRef}
                src={mediaUrl ?? ''}
                audioOnly={audioOnly}
                onError={failPreview}
                note={
                  hasWordTimings ? t('transcriptionSeekHint') : t('transcriptionKaraokeUnavailable')
                }
                t={t}
              />
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
          {previewOpen ? (
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Play size={16} strokeWidth={1.75} aria-hidden="true" />
          )}
          {previewOpen
            ? t('transcriptionPreviewCollapse')
            : pictureFolded
              ? t('transcriptionPreviewSound')
              : t('transcriptionPreview')}
        </Button>
        {onExport && (
          <ExportMenu
            hasTimings={timed}
            hasTranslation={translationCompleted}
            disabled={loading || segments.length === 0}
            onExport={onExport}
            t={t}
          />
        )}
        {job.sourceKind === 'local' && (
          <Button
            variant="secondary"
            loading={saveState === 'saving'}
            disabled={job.translation?.status !== 'completed' || saveState === 'saving'}
            title={
              job.translation?.status !== 'completed'
                ? t('transcriptionErrorTranslationNotReady')
                : undefined
            }
            onClick={() => void saveWithTranslation()}
          >
            <FolderDown size={16} strokeWidth={1.75} aria-hidden="true" />
            {saveState === 'saved'
              ? t('transcriptionSavedWithTranslation')
              : t('transcriptionSaveWithTranslation')}
          </Button>
        )}
        <Button variant="ghost" className="transcript-modal-footer-close" onClick={onClose}>
          {t('transcriptionModalClose')}
        </Button>
      </footer>
    </Modal>
  );
});

const NO_SEGMENTS: TranscriptSegment[] = [];

function useMediaQueryMatch(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}
