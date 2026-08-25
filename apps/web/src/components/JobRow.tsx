import { useEffect, useState } from 'react';
import {
  COMPRESSION_LIFECYCLE,
  isSettled,
  estimatedFinalImageDurationSeconds,
  expectedDimensions,
  expectedFrameRate,
  jobConfigurationKey,
  startImageDurationSeconds,
  type CompressionJob
} from '@video-compressor/shared';
import { estimatePriorityAction } from '../estimate-priority';
import { prefersReducedMotion } from '../lib/navigation';
import {
  compactPath,
  formatBitrate,
  formatCodec,
  formatDuration,
  formatDurationWords,
  formatElapsed,
  formatFps,
  formatSize
} from '../format';
import type { Language } from '../i18n';
import { elapsedMilliseconds, stoppable, timerState } from '../queue-ui';
import {
  Button,
  Checkbox,
  Collapse,
  ProgressBar,
  Spinner,
  StatusBadge,
  Tooltip,
  SotyDots,
  type Translate
} from './ui';

/** Keep in sync with --dur-complete in styles.css: the estimate → result
 * morph (row-track transition + size count-up) runs on this clock. */
const MORPH_DURATION_MS = 450;

export function JobRow({
  job,
  selected,
  disabled,
  compressionRunning,
  language,
  onSelected,
  action,
  t,
  connected = true
}: {
  job: CompressionJob;
  selected: boolean;
  disabled: boolean;
  compressionRunning: boolean;
  language: Language;
  onSelected: (checked: boolean, shiftKey: boolean) => void;
  action: (url: string, method?: string) => void;
  t: Translate;
  /**
   * Whether the local app is answering right now.
   *
   * Passed in rather than read from the context so this component stays a
   * presentational one — it is rendered in tests without a provider — and
   * defaults to true so no existing caller changes behaviour by omission.
   */
  connected?: boolean;
}) {
  const [copiedDetails, setCopiedDetails] = useState(false);
  return (
    <article
      className={`job-row ${selected ? 'is-selected' : ''} ${
        job.status === 'processing' ? 'is-processing' : ''
      }`.trim()}
    >
      <div className="job-header">
        <Checkbox
          checked={selected}
          disabled={job.status === 'analyzing'}
          aria-label={t('fileSelection', { name: job.fileName })}
          label={<span className="sr-only">{t('fileSelection', { name: job.fileName })}</span>}
          onChange={() => {}}
          onClick={event => onSelected(!selected, event.shiftKey)}
        />
        <div className="job-title-block">
          <div className="job-title-line">
            <h3 title={job.fileName}>{job.fileName}</h3>
            <StatusBadge status={job.status} t={t} />
          </div>
          <JobTimer job={job} t={t} showRunning={false} live={connected} />
        </div>
        <JobActions
          job={job}
          disabled={disabled}
          compressionRunning={compressionRunning}
          action={action}
          t={t}
        />
      </div>

      {/* The progress row stays mounted inside a Collapse, so reaching a
          terminal state (completed/failed/cancelled) slides it away instead
          of snapping the row height. */}
      <Collapse open={job.status === 'processing' || job.status === 'queued'}>
        <div className="job-progress">
          <ProgressBar
            value={job.status === 'queued' ? 0 : job.progress}
            label={t('compressionProgress', { name: job.fileName })}
            /* The flowing animation says "work is happening right now". With
               no connection that claim cannot be checked, so the bar holds its
               last known value instead of continuing to flow. */
            active={job.status === 'processing' && connected}
          />
          <div className="job-progress-meta">
            {job.processingStage && <span>{processingStage(job, t)}</span>}
            <JobTimer job={job} t={t} live={connected} />
            <strong>{job.status === 'queued' ? '0%' : `${Math.round(job.progress ?? 0)}%`}</strong>
          </div>
        </div>
      </Collapse>

      <div className={`job-comparison ${job.status === 'completed' ? 'has-result' : ''}`}>
        <OriginalPanel job={job} language={language} t={t} />
        <OutcomePanel job={job} language={language} t={t} />
      </div>

      {/* Errors expand softly (fade-rise inside an animated row track), so
          failed/cancelled jobs never jump the layout. */}
      <Collapse open={Boolean(job.error)}>
        {job.error ? (
          <div className="job-error" role="alert">
            <span>{localizedJobError(job.error, t)}</span>
            {job.errorDetails && (
              <details>
                <summary>{t('showDetails')}</summary>
                <pre>{job.errorDetails}</pre>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(job.errorDetails ?? '');
                    setCopiedDetails(true);
                  }}
                >
                  {copiedDetails ? t('detailsCopied') : t('copyDetails')}
                </Button>
              </details>
            )}
          </div>
        ) : null}
      </Collapse>
    </article>
  );
}

/**
 * The single slot to the right of the original panel that hosts either the
 * estimate or the final result. When a job completes while mounted, both
 * phases render for one --dur-complete beat: the row tracks morph
 * (1fr 0fr → 0fr 1fr, the Collapse pattern) so the slot height flows from the
 * estimate panel to the result panel, the contents crossfade, and the size
 * figure counts from the ≈ estimate to the actual bytes. Static renders of a
 * completed job (SSR, fresh mounts) skip straight to the result panel.
 */
function OutcomePanel({
  job,
  language,
  t
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
}) {
  const completed = job.status === 'completed';
  const hasEstimate =
    job.status !== 'analyzing' && job.sourceWidth !== null && job.sourceHeight !== null;
  const [wasCompleted, setWasCompleted] = useState(completed);
  const [morph, setMorph] = useState<{ fromBytes: number | null } | null>(null);
  const [running, setRunning] = useState(false);

  // Derived-from-props state transition (no effect): the completed flag
  // flipping on while the estimate is visible arms the morph.
  if (completed !== wasCompleted) {
    setWasCompleted(completed);
    if (completed && hasEstimate) {
      setMorph({
        fromBytes: job.estimateStatus === 'estimated' ? job.estimatedOutputBytes : null
      });
      setRunning(false);
    } else {
      setMorph(null);
    }
  }

  useEffect(() => {
    if (!morph) return;
    if (prefersReducedMotion()) {
      setMorph(null);
      return;
    }
    // Double rAF: let the two-phase layout commit first, then flip the row
    // tracks so the grid-template-rows transition actually runs.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setRunning(true));
    });
    const timer = window.setTimeout(() => setMorph(null), MORPH_DURATION_MS + 80);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      window.clearTimeout(timer);
    };
  }, [morph]);

  const showEstimate = (!completed || morph !== null) && hasEstimate;
  const showResult = completed;
  if (!showEstimate && !showResult) return null;

  return (
    <div
      className={`outcome-slot ${morph ? 'is-morphing' : ''} ${running && morph ? 'is-run' : ''}`.trim()}
    >
      {showEstimate && (
        <div
          key="estimate"
          className="outcome-phase outcome-phase-estimate"
          aria-hidden={completed || undefined}
        >
          <EstimatePanel job={job} language={language} t={t} />
        </div>
      )}
      {showResult && (
        <div key="result" className="outcome-phase outcome-phase-result">
          <ResultPanel
            job={job}
            language={language}
            t={t}
            morphFromBytes={morph?.fromBytes ?? null}
          />
        </div>
      )}
    </div>
  );
}

/** Counts the displayed byte figure from the last shown estimate to the
 * actual output while the morph runs; renders the target directly otherwise
 * (static mounts, no estimate, reduced motion). */
function useMorphedBytes(target: number | null, from: number | null) {
  const [display, setDisplay] = useState(from ?? target);
  useEffect(() => {
    if (from === null || target === null || from === target || prefersReducedMotion()) {
      setDisplay(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / MORPH_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3); // matches --ease-enter's decelerate feel
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, from]);
  return from === null ? target : display;
}

function OriginalPanel({
  job,
  language,
  t
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
}) {
  return (
    <section className="media-panel original-panel" aria-label={t('originalVideoInfo')}>
      <h4>{t('original')}</h4>
      {job.status === 'analyzing' ? (
        <div className="panel-loading">
          <Spinner small /> {t('statusAnalyzing')}
        </div>
      ) : (
        <MediaGrid
          items={[
            [t('fileSize'), formatSize(job.originalSize, language)],
            [t('videoResolution'), dimensions(job.sourceWidth, job.sourceHeight)],
            [t('videoFps'), `${formatFps(job.sourceFrameRate, language)} FPS`],
            [t('videoBitrate'), formatBitrate(job.sourceBitrate, language)],
            [t('duration'), formatDuration(job.durationSeconds)],
            [t('codec'), formatCodec(job.sourceCodec)]
          ]}
        />
      )}
    </section>
  );
}

function EstimatePanel({
  job,
  language,
  t
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
}) {
  const output = expectedDimensions(
    job.sourceWidth,
    job.sourceHeight,
    job.encoding.resolutionLimit
  );
  const fps = expectedFrameRate(job.sourceFrameRate, job.encoding.frameRate);
  const current = job.estimateKey === jobConfigurationKey(job.encoding, job.imageEmbedding);
  const estimated =
    job.estimateStatus === 'estimated' && current && job.estimatedOutputBytes !== null;
  const saving = job.estimatedSavingPercent;
  const status = estimateStatus(job, current, t);

  return (
    <section
      className={`media-panel estimate-panel ${
        (saving !== null && saving < 0) || job.growthRisk ? 'has-warning' : ''
      }`}
      aria-label={t('expectedVideoInfo')}
    >
      {/* Shown from the probe, so it is on screen while the estimate is still
          running — which is when people press Compress. */}
      {job.growthRisk && !estimated ? (
        <p className="estimate-growth-warning">
          {t(job.growthRisk === 'codec' ? 'growthRiskCodec' : 'growthRiskBitrate')}
        </p>
      ) : null}
      <div className="panel-title-with-help">
        <h4>{t('expectedResult')}</h4>
        <span className="estimate-tag">≈ {t('estimateLabel')}</span>
        <Tooltip label={t('estimateTooltip')}>{t('estimateTooltip')}</Tooltip>
      </div>
      {estimated ? (
        <>
          <div className="estimate-size">
            <strong>≈ {formatSize(job.estimatedOutputBytes, language)}</strong>
            {saving !== null && saving >= 0 && (
              <span>{t('estimatedSaving', { value: saving })}</span>
            )}
          </div>
          {saving !== null && saving < 0 && <p className="inline-warning">{t('largerEstimate')}</p>}
        </>
      ) : (
        <div className="estimate-state">
          {job.estimateStatus === 'estimating' || !current ? (
            <SotyDots />
          ) : (
            <span className="skeleton skeleton-size" aria-hidden="true" />
          )}
          <span>{status}</span>
          {job.estimateProgress && (
            <small>
              {job.estimateProgress.completed}/{job.estimateProgress.total}
            </small>
          )}
        </div>
      )}
      <MediaGrid
        items={[
          [t('videoResolution'), output ? dimensions(output.width, output.height) : '—'],
          [t('videoFps'), `${formatFps(fps, language)} FPS`],
          [t('duration'), formatDuration(expectedOutputDurationSeconds(job))],
          [t('qualityMode'), qualityMode(job, t)],
          ...(job.encoding.rateControl === 'bitrate' && job.encoding.videoBitrateKbps
            ? [
                [t('videoBitrate'), `${job.encoding.videoBitrateKbps} ${t('bitrateUnit')}`] as [
                  string,
                  string
                ]
              ]
            : [])
        ]}
      />
      <EmbeddingDetails job={job} language={language} t={t} />
    </section>
  );
}

function ResultPanel({
  job,
  language,
  t,
  morphFromBytes = null
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
  /** Estimate figure to count up from while the estimate → result morph runs. */
  morphFromBytes?: number | null;
}) {
  const displayedSize = useMorphedBytes(job.finalSize, morphFromBytes);
  const saving =
    job.finalSize === null || !job.originalSize
      ? null
      : Math.round((1 - job.finalSize / job.originalSize) * 100);
  return (
    <section className="media-panel result-panel" aria-label={t('finalVideoInfo')}>
      <h4>{t('readyFile')}</h4>
      <div className="result-size">
        <strong>{formatSize(displayedSize, language)}</strong>
        {/* The never-larger ceiling fired: the encode finished bigger than the
            source, so the source is what the user still has. Saying "0% saved"
            here would be true and useless. */}
        {job.keptOriginalReason === 'larger-than-source' ? (
          <span className="warning-text">{t('keptOriginalLarger')}</span>
        ) : (
          <>
            {saving !== null && saving >= 0 && <span>{t('actualSaving', { value: saving })}</span>}
            {saving !== null && saving < 0 && (
              <span className="warning-text">{t('largerActual', { value: Math.abs(saving) })}</span>
            )}
          </>
        )}
      </div>
      <MediaGrid
        items={[
          [t('videoResolution'), dimensions(job.finalWidth, job.finalHeight)],
          [t('videoFps'), `${formatFps(job.finalFrameRate, language)} FPS`],
          [t('videoBitrate'), formatBitrate(job.finalBitrate, language)],
          [t('duration'), formatDuration(job.finalDurationSeconds)],
          [t('codec'), formatCodec(job.finalCodec)]
        ]}
      />
      <EmbeddingDetails job={job} language={language} t={t} />
      <div className="output-path" title={job.outputPath}>
        <span>{t('outputPath')}</span>
        <strong>{compactPath(job.outputPath)}</strong>
      </div>
    </section>
  );
}

function MediaGrid({ items }: { items: [string, string][] }) {
  return (
    <dl className="media-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JobActions({
  job,
  disabled,
  compressionRunning,
  action,
  t
}: {
  job: CompressionJob;
  disabled: boolean;
  compressionRunning: boolean;
  action: (url: string, method?: string) => void;
  t: Translate;
}) {
  const priority = estimatePriorityAction(job, compressionRunning);
  return (
    <div className="job-actions" aria-label={t('fileActions', { name: job.fileName })}>
      {job.status === 'processing' && (
        <Button
          variant="danger"
          disabled={disabled}
          onClick={() => action(`/api/jobs/${job.id}/cancel`)}
        >
          {t('cancel')}
        </Button>
      )}
      {priority && (
        <Button
          variant="ghost"
          disabled={disabled}
          title={t(priority === 'cancel' ? 'cancelPriorityEstimateHint' : 'prioritizeEstimateHint')}
          onClick={() =>
            action(
              `/api/jobs/${job.id}/estimate-priority`,
              priority === 'cancel' ? 'DELETE' : 'POST'
            )
          }
        >
          {t(priority === 'cancel' ? 'cancelPriorityEstimate' : 'prioritizeEstimate')}
        </Button>
      )}
      {isSettled(COMPRESSION_LIFECYCLE, job.status) && job.status !== 'completed' && (
        <Button
          disabled={disabled || compressionRunning}
          onClick={() => action(`/api/jobs/${job.id}/retry`)}
        >
          {t('retry')}
        </Button>
      )}
      {job.status === 'completed' && (
        <>
          <Button
            variant="primary"
            disabled={disabled || compressionRunning}
            onClick={() => action(`/api/jobs/${job.id}/repeat`)}
          >
            {t('repeatCompression')}
          </Button>
          <Button
            variant="success"
            disabled={disabled}
            onClick={() => action(`/api/jobs/${job.id}/reveal`)}
          >
            {t('showInFolder')}
          </Button>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => action(`/api/jobs/${job.id}/open`)}
          >
            {t('openFile')}
          </Button>
        </>
      )}
      {!stoppable(job) && job.status !== 'analyzing' && (
        <Button
          variant="danger"
          disabled={disabled}
          onClick={() => action(`/api/jobs/${job.id}`, 'DELETE')}
        >
          {t('remove')}
        </Button>
      )}
    </div>
  );
}

function JobTimer({
  job,
  t,
  showRunning = true,
  live = true
}: {
  job: CompressionJob;
  t: Translate;
  showRunning?: boolean;
  /** False while the local app is unreachable; see the effect below. */
  live?: boolean;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (job.status !== 'processing' || job.startedAt === null) return;
    // D6/FR-036. While the connection is down the interface has no idea whether
    // this job is still running, so a ticking elapsed timer is not a live
    // reading — it is an animation asserting something nobody knows. It stops
    // and resumes from the truth when the connection does.
    if (!live) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [job.status, job.startedAt, live]);
  if (job.startedAt === null) return null;
  const state = timerState(job);
  if (!state || (state === 'running' && !showRunning)) return null;
  const keys = {
    running: 'ongoingTimer',
    completed: 'completedTimer',
    failed: 'failedTimer',
    cancelled: 'cancelledTimer'
  } as const;
  return (
    <span className="job-timer">
      {t(keys[state], { time: formatElapsed(elapsedMilliseconds(job) ?? 0) })}
    </span>
  );
}

function estimateStatus(job: CompressionJob, current: boolean, t: Translate) {
  if (!current && job.estimateKey) return t('staleEstimate');
  if (job.estimateStatus === 'estimating') return t('estimatingResult');
  if (job.estimateStatus === 'cancelled') return t('estimatePaused');
  if (job.estimateStatus === 'unavailable') return t('estimateUnavailable');
  return t('waitingEstimate');
}

function qualityMode(job: CompressionJob, t: Translate) {
  return job.encoding.rateControl === 'bitrate' && job.encoding.videoBitrateKbps
    ? `${t('targetBitrate')} · ${job.encoding.videoBitrateKbps} ${t('bitrateUnit')}`
    : `CRF ${job.encoding.crf}`;
}

function dimensions(width: number | null | undefined, height: number | null | undefined) {
  return width && height ? `${width}×${height}` : '—';
}

function EmbeddingDetails({
  job,
  language,
  t
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
}) {
  const embedding = job.imageEmbedding;
  if (!embedding) return null;
  const fps = expectedFrameRate(job.sourceFrameRate, job.encoding.frameRate) ?? 30;
  const startDuration = embedding.startImage ? startImageDurationSeconds(embedding, fps) : 0;
  const fitKeys = {
    cover: 'fitCover',
    contain: 'fitContain',
    stretch: 'fitStretch'
  } as const;
  const startLabel =
    embedding.startDurationMode && embedding.startDurationMode !== 'one-frame'
      ? t('embeddingStartDuration', {
          duration: `${Math.round(startDuration * 1000)} ${t('millisecondsUnit')}`
        })
      : t('embeddingStartOneFrame');
  const endLabel =
    embedding.finalDurationSeconds !== null
      ? formatDurationWords(embedding.finalDurationSeconds, language)
      : t(
          embedding.finalDurationMode === 'random-30-40'
            ? 'randomDuration30To40'
            : embedding.finalDurationMode === 'random-50-60'
              ? 'randomDuration50To60'
              : 'randomDuration40To50'
        );
  return (
    <div className="embedding-summary">
      <strong>{t('embeddingLabel')}</strong>
      <div>
        {embedding.startImage && <span>{startLabel}</span>}
        {embedding.endImage && <span>{t('embeddingFinalImage', { duration: endLabel })}</span>}
        {embedding.replaceExisting && <span>{t('replaceExistingImages')}</span>}
        <span>{t('embeddingFitMode', { mode: t(fitKeys[embedding.fitMode]) })}</span>
        <span>
          {t('expectedTotalDuration', {
            duration: formatDuration(expectedOutputDurationSeconds(job))
          })}
        </span>
      </div>
    </div>
  );
}

/** Mirrors the agent's outputDurationSeconds calculation so the duration shown
 * while encoding is the duration that FFmpeg is actually asked to produce. */
function expectedOutputDurationSeconds(job: CompressionJob): number | null {
  if (job.durationSeconds === null) return null;
  const embedding = job.imageEmbedding;
  if (!embedding) return job.durationSeconds;
  const source = embedding.replaceExisting
    ? Math.max(
        0,
        job.durationSeconds - embedding.sourceTrimStartSeconds - embedding.sourceTrimEndSeconds
      )
    : job.durationSeconds;
  const fps = expectedFrameRate(job.sourceFrameRate, job.encoding.frameRate) ?? 30;
  const start = embedding.startImage ? 1 / fps : 0;
  return source + start + estimatedFinalImageDurationSeconds(embedding);
}

function processingStage(job: CompressionJob, t: Translate) {
  if (job.processingStage === 'preparing-images') return t('stagePreparingImages');
  if (job.processingStage === 'finalizing') return t('stageFinalizing');
  return t('stageCompressing');
}

function localizedJobError(raw: string, t: Translate) {
  if (/source file is no longer available/i.test(raw)) return t('sourceUnavailable');
  if (/file could not be processed/i.test(raw)) return t('fileProcessFailed');
  if (/compression was cancelled/i.test(raw)) return t('compressionCancelled');
  if (/format is not supported|file is damaged/i.test(raw)) return t('unsupportedOrDamaged');
  if (/ffmpeg could not compress/i.test(raw)) return t('compressionFailed');
  if (/image is no longer available|can no longer read this image/i.test(raw)) {
    return t('imageUnavailable');
  }
  if (/image is damaged|could not be decoded/i.test(raw)) return t('damagedImage');
  if (/images could not be adapted/i.test(raw)) return t('imageAdaptationFailed');
  if (/image filter graph|image processing pipeline/i.test(raw)) return t('imageFilterGraphFailed');
  if (/did not pass ffprobe validation/i.test(raw)) return t('outputValidationFailed');
  if (/analysis engine is unavailable|media tools became unavailable/i.test(raw)) {
    return t('engineUnavailable');
  }
  return raw;
}
