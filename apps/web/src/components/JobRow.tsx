import { useEffect, useState } from 'react';
import {
  estimatedFinalImageDurationSeconds,
  expectedDimensions,
  expectedFrameRate,
  jobConfigurationKey,
  type CompressionJob
} from '@video-compressor/shared';
import { estimatePriorityAction } from '../estimate-priority';
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
import { elapsedMilliseconds, timerState } from '../queue-ui';
import {
  Button,
  Checkbox,
  ProgressBar,
  Spinner,
  StatusBadge,
  Tooltip,
  WishlyDots,
  type Translate
} from './ui';

export function JobRow({
  job,
  selected,
  disabled,
  compressionRunning,
  language,
  onSelected,
  action,
  t
}: {
  job: CompressionJob;
  selected: boolean;
  disabled: boolean;
  compressionRunning: boolean;
  language: Language;
  onSelected: (checked: boolean, shiftKey: boolean) => void;
  action: (url: string, method?: string) => void;
  t: Translate;
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
          <JobTimer job={job} t={t} />
        </div>
        <JobActions
          job={job}
          disabled={disabled}
          compressionRunning={compressionRunning}
          action={action}
          t={t}
        />
      </div>

      {(job.status === 'processing' || job.status === 'queued') && (
        <div className="job-progress">
          <ProgressBar
            value={job.status === 'queued' ? 0 : job.progress}
            label={t('compressionProgress', { name: job.fileName })}
            active={job.status === 'processing'}
          />
          <div className="job-progress-meta">
            {job.processingStage && <span>{processingStage(job, t)}</span>}
            <strong>{job.status === 'queued' ? '0%' : `${Math.round(job.progress ?? 0)}%`}</strong>
          </div>
        </div>
      )}

      <div className={`job-comparison ${job.status === 'completed' ? 'has-result' : ''}`}>
        <OriginalPanel job={job} language={language} t={t} />
        {job.status !== 'completed' &&
          job.status !== 'analyzing' &&
          job.sourceWidth !== null &&
          job.sourceHeight !== null && <EstimatePanel job={job} language={language} t={t} />}
        {job.status === 'completed' && <ResultPanel job={job} language={language} t={t} />}
      </div>

      {job.error && (
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
      )}
    </article>
  );
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
      className={`media-panel estimate-panel ${saving !== null && saving < 0 ? 'has-warning' : ''}`}
      aria-label={t('expectedVideoInfo')}
    >
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
            <WishlyDots />
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
  t
}: {
  job: CompressionJob;
  language: Language;
  t: Translate;
}) {
  const saving =
    job.finalSize === null || !job.originalSize
      ? null
      : Math.round((1 - job.finalSize / job.originalSize) * 100);
  return (
    <section className="media-panel result-panel" aria-label={t('finalVideoInfo')}>
      <h4>{t('readyFile')}</h4>
      <div className="result-size">
        <strong>{formatSize(job.finalSize, language)}</strong>
        {saving !== null && saving >= 0 && <span>{t('actualSaving', { value: saving })}</span>}
        {saving !== null && saving < 0 && (
          <span className="warning-text">{t('largerActual', { value: Math.abs(saving) })}</span>
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
      {['failed', 'cancelled', 'interrupted'].includes(job.status) && (
        <Button disabled={disabled} onClick={() => action(`/api/jobs/${job.id}/retry`)}>
          {t('retry')}
        </Button>
      )}
      {job.status === 'completed' && (
        <>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => action(`/api/jobs/${job.id}/reveal`)}
          >
            {t('showInFolder')}
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => action(`/api/jobs/${job.id}/open`)}
          >
            {t('openFile')}
          </Button>
        </>
      )}
      {!['processing', 'queued', 'analyzing'].includes(job.status) && (
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => action(`/api/jobs/${job.id}`, 'DELETE')}
        >
          {t('remove')}
        </Button>
      )}
    </div>
  );
}

function JobTimer({ job, t }: { job: CompressionJob; t: Translate }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (job.status !== 'processing' || !job.startedAt) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [job.status, job.startedAt]);
  if (!job.startedAt) return null;
  const state = timerState(job);
  if (!state) return null;
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
  const endDuration = estimatedFinalImageDurationSeconds(embedding);
  const totalDuration =
    (job.durationSeconds ?? 0) + (embedding.startImage ? 1 / fps : 0) + endDuration;
  const fitKeys = {
    cover: 'fitCover',
    contain: 'fitContain',
    stretch: 'fitStretch'
  } as const;
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
        {embedding.startImage && <span>{t('embeddingStartOneFrame')}</span>}
        {embedding.endImage && <span>{t('embeddingFinalImage', { duration: endLabel })}</span>}
        <span>{t('embeddingFitMode', { mode: t(fitKeys[embedding.fitMode]) })}</span>
        <span>{t('expectedTotalDuration', { duration: formatDuration(totalDuration) })}</span>
      </div>
    </div>
  );
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
  if (/analysis engine is unavailable/i.test(raw)) return t('engineUnavailable');
  return raw;
}
