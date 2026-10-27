import { analytics } from '../analytics/service';
import { analyticsRunId } from '../analytics/tools';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, Play, X } from 'lucide-react';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptSegment,
  TranscriptWord
} from '@video-compressor/shared';
import { Modal } from '../components/Modal';
import { type Translate } from '../components/ui';
import { transcriptionMediaPath } from '../api/client';
import { isRtlLanguage, languageDisplayName } from './language';
import type { Language } from '../i18n';
import { type CharRange } from './text-ranges';
import {
  selectedPart,
  useTranscriptSelection,
  type TranscriptSelection
} from './useTranscriptSelection';
import { joinRanges, splitTextByRanges } from './selection-dom';
import { useSubresourceUrl } from '../api/useSubresourceUrl';
import { loadTranscriptDocument, transcriptDocumentKey } from './document-cache';
import { useMediaPreview } from './useMediaPreview';
import { TranscriptPlayer } from './TranscriptPlayer';
import { ExportMenu } from './ExportMenu';
import { type KaraokeStore, useActiveWordInSegment } from './karaoke-store';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useKaraoke } from './useKaraoke';
import { hasTimings, type TranscriptExportContent, type TranscriptExportFormat } from './export';
import {
  Alert,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Progress
} from '../components/ui/index';

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
    segments: []
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

export const TranscriptTextModal = memo(function TranscriptTextModal({
  job,
  language,
  returnFocus,
  onExport,
  onToast,
  onClose,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  returnFocus: HTMLElement | null;
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
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const documentKey = transcriptDocumentKey(job);
  const [copied, setCopied] = useState<{
    side: 'source';
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
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionRef = useRef<TranscriptSelection | null>(null);
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
    setLoadedFor(null);
    setLoadFailed(false);
    if (job.status !== 'completed') return;
    loadTranscriptDocument(job)
      .then(doc => {
        if (active) {
          setDocument(doc);
          setLoadedFor(documentKey);
        }
      })
      .catch(() => {
        if (!active) return;
        setLoadFailed(true);
        setDocument(emptyDocument(job));
      });
    return () => {
      active = false;
    };
  }, [documentKey, job.status, loadAttempt]);

  const visibleDocument = useRef<string | null>(null);
  useEffect(() => {
    if (
      !document_ ||
      loadFailed ||
      job.status !== 'completed' ||
      loadedFor !== documentKey ||
      visibleDocument.current === documentKey
    )
      return;
    visibleDocument.current = documentKey;
    const runId = analyticsRunId(job.id);
    if (runId)
      analytics.track('result_opened', {
        tool_identifier: 'transcription',
        flow_step: 'transcription_result_visible',
        run_id: runId,
        flow_id: runId,
        ...(analyticsRunId(job.attemptId) ? { attempt_id: job.attemptId } : {})
      });
  }, [document_, loadFailed, loadedFor, documentKey, job.id, job.attemptId, job.status]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !previewOpen || mediaPreview?.state !== 'ready') return;
    void media.play().catch(() => {});
  }, [previewOpen, mediaPreview?.state]);
  const segments = document_?.segments ?? NO_SEGMENTS;
  // Once per document, not once per render: an O(n) scan of every word on every frame.
  const timed = useMemo(() => hasTimings(segments), [segments]);
  const segmentById = useMemo(
    () => new Map(segments.map(segment => [segment.id, segment])),
    [segments]
  );

  const { selection, clearSelection, pointerSelecting, onSelectionEnd, onColumnPointerDown } =
    useTranscriptSelection({ dialog, segmentById });
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
    },
    []
  );

  const sourceLanguage = document_?.sourceLanguage ?? job.detectedLanguage ?? 'auto';
  const hasWordTimings = useMemo(
    () => segments.some(segment => segment.words.some(word => word.endMs > word.startMs)),
    [segments]
  );

  const { sourceScrollRef, centerActiveWord } = useTranscriptScroll({
    layoutKey: `${job.id}@${job.finishedAt ?? 0}`,
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

  const columnText = (_which: 'source'): string =>
    segments.map(segment => segment.sourceText).join('\n');

  const copyColumn = async (which: 'source') => {
    let text: string;
    let full = true;
    if (selection) {
      const fragments = segments.flatMap(segment => {
        const part = selectedPart(selection, segment.id);
        if (!part) return [];
        const ranges = part.sourceRanges;
        const base = segment.sourceText;
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
  const hasSourceSelection = selection?.parts.some(part => part.sourceRanges.length > 0) === true;
  const loading = document_ === null;

  const copyLabel = (side: 'source', hasSelection: boolean) =>
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
        {}

        <IconButton
          className="transcript-modal-close"
          label={t('transcriptionModalClose')}
          onClick={onClose}
        >
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </IconButton>
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
            <Button
              color="neutral"
              variant="ghost"
              disabled={loading}
              onClick={() => void copyColumn('source')}
            >
              {copyLabel('source', hasSourceSelection)}
            </Button>
          </div>
          <div
            ref={sourceScrollRef}
            className="transcript-column-scroll"
            onClick={onSourceClick}
            onKeyDown={onSegmentKeyDown}
            onPointerDown={onColumnPointerDown}
          >
            {document_?.reliability?.warnings.some(
              warning =>
                warning.code === 'SEAM_UNCERTAIN' ||
                warning.code === 'COVERAGE_UNVERIFIED' ||
                warning.code === 'DECODE_UNCERTAIN'
            ) && <Alert color="warning">{t('transcriptionReviewNeeded')}</Alert>}

            {document_?.reliability &&
              document_.reliability.timedWords < document_.reliability.totalWords * 0.9 && (
                <Alert color="warning">{t('transcriptionTimingsPartial')}</Alert>
              )}
            {loading ? (
              <div className="transcript-modal-loading" role="status">
                <span className="soty-spinner" aria-hidden="true" />
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
            ) : loadFailed ? (
              <ErrorState
                className="transcript-modal-empty"
                message={t('transcriptionModalLoadFailed')}
                retryLabel={t('tryAgain')}
                onRetry={() => setLoadAttempt(count => count + 1)}
              />
            ) : (
              <EmptyState
                className="transcript-modal-empty"
                size="sm"
                title={t('transcriptionModalEmpty')}
              />
            )}
          </div>
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
                <Button color="neutral" variant="outline" onClick={() => void preparePreview()}>
                  {t('transcriptionRetry')}
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
                <Progress
                  value={mediaPreview?.progress ?? undefined}
                  label={t('transcriptionPreviewPreparing')}
                />
                <Button
                  color="neutral"
                  variant="ghost"
                  onClick={() => void cancelPreviewPreparation()}
                >
                  {t('transcriptionCancel')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="transcript-modal-footer">
        <Button
          color="neutral"
          variant="outline"
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
            disabled={loading || segments.length === 0}
            onExport={onExport}
            t={t}
          />
        )}

        <Button
          color="neutral"
          variant="ghost"
          className="transcript-modal-footer-close"
          onClick={onClose}
        >
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
