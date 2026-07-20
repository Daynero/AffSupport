import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LandingAsset, LandingJob, LandingState } from '@video-compressor/shared';
import { landingPreviewUrl } from '../api/client';
import { formatSize } from '../format';
import type { Language, TranslationKey } from '../i18n';
import { Button, Collapse, ProgressBar, WishlyLoader, type Translate } from '../components/ui';
import { ImageCompareModal } from './ImageCompareModal';

export function LandingJobCard({
  job,
  connected,
  running,
  language,
  onStart,
  onReset,
  onReveal,
  t
}: {
  job: NonNullable<LandingState['job']>;
  connected: boolean;
  running: boolean;
  language: Language;
  onStart: () => void;
  onReset: () => void;
  onReveal: (action: 'open' | 'reveal') => void;
  t: Translate;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [listMounted, setListMounted] = useState(false);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const comparisonTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setExpanded(false);
    setListMounted(false);
    setComparisonId(null);
  }, [job.id]);

  const openComparison = useCallback((assetId: string, trigger: HTMLElement) => {
    comparisonTrigger.current = trigger;
    setComparisonId(assetId);
  }, []);
  const closeComparison = useCallback(() => setComparisonId(null), []);
  const comparisonAsset = comparisonId
    ? (job.assets.find(asset => asset.id === comparisonId) ?? null)
    : null;
  const completed = job.status === 'completed';
  const failed = job.status === 'failed';
  const ready = job.status === 'ready';
  const queued = job.status === 'queued';
  const progress = landingJobProgress(job);
  const currentAsset = currentLandingAsset(job);
  const completedAssets = job.completedAssets ?? terminalCount(job.assets);
  const totalAssets = job.totalAssets || job.assets.length;
  const canExpand = job.assets.length > 0;
  const toggleList = () => {
    if (!canExpand) return;
    const next = !expanded;
    if (next) setListMounted(true);
    setExpanded(next);
  };

  return (
    <section
      className={`landing-batch-card is-${job.status} ${expanded ? 'is-expanded' : ''}`}
      aria-labelledby={`${listId}-title`}
    >
      <div className="landing-batch-header">
        <button
          type="button"
          className="landing-batch-toggle"
          disabled={!canExpand}
          aria-label={
            canExpand
              ? `${t(expanded ? 'landingCollapseAssets' : 'landingExpandAssets')}: ${job.name}`
              : undefined
          }
          aria-expanded={canExpand ? expanded : undefined}
          aria-controls={canExpand ? listId : undefined}
          onClick={toggleList}
        >
          <span className={`landing-source-icon is-${job.sourceKind}`} aria-hidden="true">
            <SourceIcon kind={job.sourceKind} />
          </span>
          <span className="landing-batch-identity">
            <span className="landing-batch-title-line">
              <strong id={`${listId}-title`} title={job.name}>
                {job.name || t('landingPreparing')}
              </strong>
              <LandingBatchStatus job={job} running={running} t={t} />
            </span>
            <span className="landing-batch-subtitle">
              <span>
                {t(job.sourceKind === 'zip' ? 'landingSourceZip' : 'landingSourceFolder')}
              </span>
              {totalAssets > 0 && <span aria-hidden="true">·</span>}
              {totalAssets > 0 && (
                <span>
                  {running || completed || failed
                    ? t('landingProcessedCount', {
                        done: completedAssets,
                        total: totalAssets
                      })
                    : t('landingFilesCount', { count: totalAssets })}
                </span>
              )}
            </span>
            {currentAsset && (
              <span className="landing-current-asset" title={currentAsset.relPath}>
                {currentAsset.relPath}
              </span>
            )}
          </span>
          {canExpand && (
            <span className="landing-batch-chevron" aria-hidden="true">
              <ChevronIcon />
            </span>
          )}
        </button>

        <div className="landing-batch-actions">
          {ready && (
            <Button
              variant="primary"
              disabled={!connected || job.assets.length === 0}
              onClick={onStart}
            >
              {t('landingOptimizeButton')}
            </Button>
          )}
          {(ready || queued) && (
            <Button variant="danger" disabled={!connected} onClick={onReset}>
              {t('landingReset')}
            </Button>
          )}
          {completed && job.outputPath && (
            <>
              <Button variant="primary" disabled={!connected} onClick={() => onReveal('open')}>
                {t('landingOpenResult')}
              </Button>
              <Button variant="ghost" disabled={!connected} onClick={() => onReveal('reveal')}>
                {t('landingShowResult')}
              </Button>
            </>
          )}
          {(completed || failed) && (
            <Button variant="ghost" disabled={!connected} onClick={onReset}>
              {t('landingRemove')}
            </Button>
          )}
        </div>
      </div>

      {(running || queued || job.status === 'preparing') && (
        <div className="landing-batch-progress" aria-live="polite">
          <div className="landing-progress-copy">
            <span>{landingPhaseLabel(job, t)}</span>
            {progress !== null && <strong>{Math.round(progress)}%</strong>}
          </div>
          <ProgressBar value={progress} label={t('landingOverallProgress')} active={running} />
        </div>
      )}

      {completed && <LandingSuccessSummary job={job} language={language} t={t} />}
      {failed && (
        <div className="landing-batch-error" role="alert">
          <strong>{t('landingResultFailedTitle')}</strong>
          {job.error && <span>{job.error}</span>}
        </div>
      )}

      {canExpand && (
        <Collapse open={expanded} className="landing-assets-collapse">
          {listMounted && (
            <div
              id={listId}
              className="landing-assets-list"
              role="region"
              aria-label={t('landingAssetsTitle')}
              aria-live="polite"
            >
              {job.assets.map(asset => (
                <LandingAssetRow
                  key={asset.id}
                  jobId={job.id}
                  asset={asset}
                  current={asset.id === currentAsset?.id}
                  language={language}
                  onCompare={openComparison}
                  t={t}
                />
              ))}
            </div>
          )}
        </Collapse>
      )}

      {comparisonAsset?.preview?.available && (
        <ImageCompareModal
          jobId={job.id}
          asset={comparisonAsset}
          language={language}
          returnFocus={comparisonTrigger.current}
          onClose={closeComparison}
          t={t}
        />
      )}
    </section>
  );
}

function LandingSuccessSummary({
  job,
  language,
  t
}: {
  job: LandingJob;
  language: Language;
  t: Translate;
}) {
  return (
    <div className="landing-success-summary" aria-live="polite">
      <div className="landing-size-result">
        <span>{formatSize(job.originalMediaSize, language)}</span>
        <span aria-hidden="true">→</span>
        <strong>{formatSize(job.optimizedMediaSize, language)}</strong>
        {job.savedBytes > 0 && (
          <span className="landing-total-saving">
            {t('landingSavedBytes', { size: formatSize(job.savedBytes, language) })} ·{' '}
            {job.savedPercent}%
          </span>
        )}
      </div>
      <dl className="landing-success-metrics">
        <div>
          <dt>{t('landingImagesOptimized')}</dt>
          <dd>{job.imagesOptimized}</dd>
        </div>
        <div>
          <dt>{t('landingVideosOptimized')}</dt>
          <dd>{job.videosOptimized}</dd>
        </div>
        <div>
          <dt>{t('landingFilesSkipped')}</dt>
          <dd>{job.filesSkipped}</dd>
        </div>
        {job.filesFailed > 0 && (
          <div className="is-warning">
            <dt>{t('landingFilesFailed')}</dt>
            <dd>{job.filesFailed}</dd>
          </div>
        )}
        <div>
          <dt>{t('landingReferencesUpdated')}</dt>
          <dd>{job.referencesUpdated}</dd>
        </div>
      </dl>
    </div>
  );
}

function LandingAssetRow({
  jobId,
  asset,
  current,
  language,
  onCompare,
  t
}: {
  jobId: string;
  asset: LandingAsset;
  current: boolean;
  language: Language;
  onCompare: (assetId: string, trigger: HTMLElement) => void;
  t: Translate;
}) {
  const displayPath = asset.newRelPath ?? asset.relPath;
  const pathParts = displayPath.split('/');
  const fileName = pathParts.pop() ?? asset.fileName;
  const parentPath = pathParts.join('/');
  return (
    <article
      className={`landing-asset-item is-${asset.status} ${current ? 'is-current' : ''}`.trim()}
    >
      <div className="landing-asset-visual">
        {asset.type === 'image' && asset.preview?.available ? (
          <ImagePreviewThumbnail
            jobId={jobId}
            asset={asset}
            onOpen={trigger => onCompare(asset.id, trigger)}
            t={t}
          />
        ) : (
          <span className={`landing-asset-glyph is-${asset.type}`} aria-hidden="true">
            <AssetIcon type={asset.type} />
          </span>
        )}
      </div>

      <div className="landing-asset-copy">
        <div className="landing-asset-name-line">
          <h3 title={displayPath}>{fileName}</h3>
          <span className="landing-type-tag">
            {t(asset.type === 'video' ? 'landingTypeVideo' : 'landingTypeImage')}
          </span>
        </div>
        {parentPath && (
          <span className="landing-asset-path" title={parentPath}>
            {parentPath}
          </span>
        )}
        <div className="landing-asset-sizes">
          <span>{formatSize(asset.originalSize, language)}</span>
          {asset.status === 'optimized' && asset.optimizedSize !== null && (
            <>
              <span aria-hidden="true">→</span>
              <strong>{formatSize(asset.optimizedSize, language)}</strong>
              {asset.savedPercent !== null && asset.savedPercent > 0 && (
                <span className="landing-saved">
                  {t('landingSaved', { value: asset.savedPercent })}
                </span>
              )}
            </>
          )}
          {asset.note && <span className="landing-note">{localizedNote(asset.note, t)}</span>}
        </div>
      </div>

      <div className="landing-asset-state">
        <span className={`status-badge ${landingStatusClass(asset.status)}`}>
          {asset.status === 'processing' && <WishlyLoader size={15} />}
          {asset.status === 'optimized' && <CheckIcon />}
          {t(landingStatusKey(asset.status))}
        </span>
      </div>

      {asset.status === 'processing' && (
        <div className="landing-asset-progress">
          <ProgressBar value={asset.progress} label={t('landingStatusProcessing')} active />
          {asset.progress !== null && <strong>{Math.round(asset.progress)}%</strong>}
        </div>
      )}
    </article>
  );
}

function ImagePreviewThumbnail({
  jobId,
  asset,
  onOpen,
  t
}: {
  jobId: string;
  asset: LandingAsset;
  onOpen: (trigger: HTMLElement) => void;
  t: Translate;
}) {
  const comparison = asset.preview?.comparison === true;
  const [beforeVariant, setBeforeVariant] = useState<'thumbnail' | 'full' | 'failed'>('thumbnail');
  const [afterVariant, setAfterVariant] = useState<'thumbnail' | 'full' | 'failed'>('thumbnail');
  const before = useMemo(
    () =>
      landingPreviewUrl(jobId, asset.id, 'before', beforeVariant === 'full' ? 'full' : 'thumbnail'),
    [jobId, asset.id, beforeVariant]
  );
  const after = useMemo(
    () =>
      landingPreviewUrl(jobId, asset.id, 'after', afterVariant === 'full' ? 'full' : 'thumbnail'),
    [jobId, asset.id, afterVariant]
  );
  const retryFull = (
    variant: 'thumbnail' | 'full' | 'failed',
    setVariant: (value: 'thumbnail' | 'full' | 'failed') => void
  ) => setVariant(variant === 'thumbnail' ? 'full' : 'failed');
  if (beforeVariant === 'failed' || (comparison && afterVariant === 'failed')) {
    return (
      <span className="landing-asset-glyph is-image" aria-hidden="true">
        <AssetIcon type="image" />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`landing-preview-thumbnail ${comparison ? 'is-comparison' : 'is-single'}`}
      aria-label={t(comparison ? 'landingPreviewOpen' : 'landingPreviewOpenSingle', {
        name: asset.fileName
      })}
      onClick={event => onOpen(event.currentTarget)}
    >
      {comparison ? (
        <>
          <img
            src={after}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => retryFull(afterVariant, setAfterVariant)}
          />
          <span aria-hidden="true">
            <img
              src={before}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() => retryFull(beforeVariant, setBeforeVariant)}
            />
          </span>
          <i aria-hidden="true" />
        </>
      ) : (
        <img
          src={before}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => retryFull(beforeVariant, setBeforeVariant)}
        />
      )}
    </button>
  );
}

function LandingBatchStatus({
  job,
  running,
  t
}: {
  job: LandingJob;
  running: boolean;
  t: Translate;
}) {
  const finalizing = job.phase === 'rewriting' || job.phase === 'packaging';
  const label =
    job.status === 'preparing'
      ? t('landingPreparing')
      : job.status === 'ready'
        ? t('landingReadyStatus')
        : job.status === 'queued'
          ? t('landingStatusQueued')
          : job.status === 'completed'
            ? t('landingResultTitle')
            : job.status === 'failed'
              ? t('landingStatusFailed')
              : finalizing
                ? t('landingStatusFinalizing')
                : t('landingStatusProcessing');
  const statusClass =
    job.status === 'completed'
      ? 'status-completed'
      : job.status === 'failed'
        ? 'status-failed'
        : job.status === 'ready'
          ? 'status-ready'
          : job.status === 'queued'
            ? 'status-queued'
            : 'status-processing';
  return (
    <span className={`status-badge ${statusClass}`}>
      {running && <WishlyLoader size={15} />}
      {job.status === 'completed' && <CheckIcon />}
      {label}
    </span>
  );
}

export function landingJobProgress(job: LandingJob): number | null {
  if (job.status === 'preparing') return null;
  if (job.status === 'completed') return 100;
  if (typeof job.progress === 'number') return Math.min(100, Math.max(0, job.progress));
  if (!job.assets.length) return 0;
  const completed = terminalCount(job.assets);
  const active = job.assets.find(asset => asset.status === 'processing');
  const fraction = active?.progress ? active.progress / 100 : 0;
  return Math.min(99, ((completed + fraction) / job.assets.length) * 88);
}

function currentLandingAsset(job: LandingJob) {
  return (
    job.assets.find(asset => asset.id === job.currentAssetId) ??
    job.assets.find(asset => asset.status === 'processing') ??
    null
  );
}

function terminalCount(assets: LandingAsset[]) {
  return assets.filter(asset => ['optimized', 'skipped', 'failed'].includes(asset.status)).length;
}

function landingPhaseLabel(job: LandingJob, t: Translate) {
  if (job.status === 'preparing') return t('landingPreparing');
  if (job.phase === 'queued') return t('landingPhaseQueued');
  if (job.phase === 'rewriting') return t('landingPhaseRewriting');
  if (job.phase === 'packaging') {
    return t(job.settings.archive ? 'landingPhasePackagingZip' : 'landingPhasePackagingFolder');
  }
  if (job.phase === 'failed') return t('landingPhaseFailed');
  return t('landingPhaseOptimizing');
}

function landingStatusKey(status: LandingAsset['status']): TranslationKey {
  const map: Record<LandingAsset['status'], TranslationKey> = {
    pending: 'landingStatusPending',
    processing: 'landingStatusProcessing',
    optimized: 'landingStatusOptimized',
    skipped: 'landingStatusSkipped',
    failed: 'landingStatusFailed'
  };
  return map[status];
}

function landingStatusClass(status: LandingAsset['status']): string {
  const map: Record<LandingAsset['status'], string> = {
    pending: 'status-queued',
    processing: 'status-processing',
    optimized: 'status-completed',
    skipped: 'status-cancelled',
    failed: 'status-failed'
  };
  return map[status];
}

function localizedNote(note: string, t: Translate): string {
  const map: Record<string, TranslationKey> = {
    'already-optimized': 'noteAlreadyOptimized',
    'no-gain': 'noteNoGain',
    'name-collision': 'noteNameCollision',
    'animated-safe': 'noteAnimatedSafe',
    'vector-safe': 'noteVectorSafe'
  };
  const key = map[note];
  return key ? t(key) : t('noteFailedGeneric');
}

function SourceIcon({ kind }: { kind: LandingJob['sourceKind'] }) {
  return kind === 'zip' ? (
    <svg viewBox="0 0 32 32" focusable="false">
      <path d="M8 4.5h10l6 6v17H8z" />
      <path d="M18 4.5v6h6M14.5 5v3M14.5 10v3M14.5 15v3" />
      <path d="M12.5 19.5h4v5h-4z" />
    </svg>
  ) : (
    <svg viewBox="0 0 32 32" focusable="false">
      <path d="M3.5 9.5h10l2.5 3h12.5v14h-25z" />
      <path d="M3.5 9.5v-3h9l2.5 3" />
    </svg>
  );
}

function AssetIcon({ type }: { type: LandingAsset['type'] }) {
  return type === 'image' ? (
    <svg viewBox="0 0 28 28" focusable="false">
      <rect x="4" y="5" width="20" height="18" rx="3" />
      <circle cx="10" cy="11" r="2" />
      <path d="m6.5 20 5-5 3.5 3 2.5-2.5 4 4.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 28 28" focusable="false">
      <rect x="4" y="6" width="15" height="16" rx="3" />
      <path d="m19 11 5-3v12l-5-3z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 20 20" focusable="false">
      <path d="m6 8 4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="status-check" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
