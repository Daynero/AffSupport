import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LandingAsset, LandingJob, LandingState } from '@video-compressor/shared';
import { landingPreviewPath } from '../api/client';
import { useSubresourceUrl } from '../api/useSubresourceUrl';
import { formatSize } from '../format';
import type { Language, TranslationKey } from '../i18n';
import { Card } from '../components/Card';
/* The compressor's own set, at the compressor's own size: every action on a card wears
   the icon that action wears everywhere else in Soty. */
import { Ban, ExternalLink, FolderOpen, Pause, Play, Trash2 } from 'lucide-react';
import { Button, Collapse, ProgressBar, SotyLoader, type Translate } from '../components/ui';
import { ImageCompareModal } from './ImageCompareModal';

export function LandingJobCard({
  job,
  connected,
  running,
  language,
  onStart,
  onReset,
  onReveal,
  onPause,
  onStop,
  t
}: {
  job: NonNullable<LandingState['job']>;
  connected: boolean;
  running: boolean;
  language: Language;
  onStart: () => void;
  onReset: () => void;
  onReveal: (action: 'open' | 'reveal') => void;
  /** Hold the run where it is, or let it go again — absent when the tool cannot. */
  onPause?: (paused: boolean) => void;
  /** Abandon a run in flight. Not the same as removing the row, which a run refuses. */
  onStop?: () => void;
  t: Translate;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [listMounted, setListMounted] = useState(false);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'skipped'>('all');
  const [sort, setSort] = useState<'saving' | 'size'>('saving');
  /*
   * The order the disk was walked in is nobody's idea of useful.
   *
   * A landing of twenty-two files opens on whichever one happened to be first, and the rows
   * worth looking at — the biggest win, the one left untouched — are somewhere in the scroll.
   * Sorted by what was saved, the list answers "did this work" from the top; sorted by size,
   * it answers "where is the weight". While the run is going the order stays as it was, so
   * rows do not jump under the cursor as each file finishes.
   */
  /*
   * The folder every file is in, when there is only one.
   *
   * Most landings keep their media in a single `assets/`, and printing it beside twenty-two
   * file names says the same word twenty-two times. Said once above the list it is still
   * there, and the names have the row to themselves.
   */
  const sharedFolder = useMemo(() => {
    const folders = new Set(
      job.assets.map(asset => {
        const parts = (asset.newRelPath ?? asset.relPath).split('/');
        parts.pop();
        return parts.join('/');
      })
    );
    const only = folders.size === 1 ? [...folders][0] : null;
    return only ? only : null;
  }, [job.assets]);

  const listedAssets = useMemo(() => {
    const rows = job.assets.filter(item => filter === 'all' || item.status === 'skipped');
    if (job.status === 'processing' || job.status === 'queued') return rows;
    /* By the figure the row actually shows. Ordering by bytes saved is the more useful
       question — where the win came from — but the column the eye reads is the percentage,
       and a leading column that jumps 97, 94, 92, 94 looks broken however good the order
       behind it is. "By size" answers the other question, and answers it visibly. */
    return [...rows].sort((a, b) =>
      sort === 'size'
        ? (b.optimizedSize ?? b.originalSize) - (a.optimizedSize ?? a.originalSize)
        : (b.savedPercent ?? 0) - (a.savedPercent ?? 0)
    );
  }, [job.assets, job.status, filter, sort]);
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
  const cancelled = job.status === 'cancelled';
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
    <Card
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
                  {running || completed || failed || cancelled
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
          {/* Same button, same place, same words as a compression: a landing is the same kind
              of long local work, and a person who has learned to hold one has learned both. */}
          {running && onPause && (
            <Button
              variant="secondary"
              disabled={!connected}
              onClick={() => onPause(!job.paused)}
            >
              {job.paused ? (
                <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Pause size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
              {t(job.paused ? 'jobResume' : 'jobPause')}
            </Button>
          )}
          {running && onStop && (
            <Button variant="danger" disabled={!connected} onClick={onStop}>
              <Ban size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('teamQueueStopNow')}
            </Button>
          )}
          {ready && (
            <Button
              variant="primary"
              disabled={!connected || job.assets.length === 0}
              onClick={onStart}
            >
              <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('landingOptimizeButton')}
            </Button>
          )}
          {(ready || queued) && (
            <Button variant="danger" disabled={!connected} onClick={onReset}>
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('landingReset')}
            </Button>
          )}
          {completed && job.outputPath && (
            <>
              <Button variant="primary" disabled={!connected} onClick={() => onReveal('open')}>
                <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('landingOpenResult')}
              </Button>
              <Button variant="success" disabled={!connected} onClick={() => onReveal('reveal')}>
                <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('landingShowResult')}
              </Button>
            </>
          )}
          {(completed || failed || cancelled) && (
            <Button variant="danger" disabled={!connected} onClick={onReset}>
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('landingRemove')}
            </Button>
          )}
        </div>
      </div>

      {(running || queued || job.status === 'preparing') && (
        <div className="landing-batch-progress" aria-live="polite">
          <div className="landing-progress-copy">
            <span>{job.paused ? t('jobPaused') : landingPhaseLabel(job, t)}</span>
            {progress !== null && <strong>{Math.round(progress)}%</strong>}
          </div>
          <ProgressBar
            value={progress}
            label={t('landingOverallProgress')}
            active={running && !job.paused}
          />
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
              <LandingAssetControls
                total={job.assets.length}
                sharedFolder={sharedFolder}
                skipped={job.assets.filter(item => item.status === 'skipped').length}
                filter={filter}
                sort={sort}
                onFilter={setFilter}
                onSort={setSort}
                t={t}
              />
              {listedAssets.map(asset => (
                <LandingAssetRow
                  key={asset.id}
                  jobId={job.id}
                  asset={asset}
                  current={asset.id === currentAsset?.id}
                  hideFolder={sharedFolder !== null}
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
    </Card>
  );
}

/**
 * What the list is showing, and in what order.
 *
 * Two questions, two controls: "everything or only what was left alone", and "sorted by what
 * was saved or by what still weighs". The counters in the summary above are the same numbers;
 * these are where they become something to press.
 */
/**
 * The one file that decides how heavy the result is.
 *
 * A landing of twenty-two files came out at 2.58 MB, and 1.66 MB of that was a single image
 * the run had left alone — two thirds of the finished weight, sitting seventh in a list of
 * twenty-two, styled exactly like everything else. The summary counts what was done; this
 * says where what is left actually is, and only when one file dominates enough to be worth
 * saying: a third of the result is a fact, a twentieth is trivia.
 */
function LandingHeaviest({
  job,
  language,
  t
}: {
  job: LandingJob;
  language: Language;
  t: Translate;
}) {
  const heaviest = job.assets.reduce<LandingAsset | null>((worst, asset) => {
    const weight = asset.optimizedSize ?? asset.originalSize;
    const best = worst ? (worst.optimizedSize ?? worst.originalSize) : -1;
    return weight > best ? asset : worst;
  }, null);
  if (!heaviest || job.optimizedMediaSize <= 0) return null;
  const weight = heaviest.optimizedSize ?? heaviest.originalSize;
  const share = Math.round((weight / job.optimizedMediaSize) * 100);
  if (share < 33) return null;
  const untouched = heaviest.status === 'skipped';
  return (
    <p className={`landing-heaviest ${untouched ? 'is-untouched' : ''}`.trim()}>
      {t(untouched ? 'landingHeaviestUntouched' : 'landingHeaviest', {
        // The name it has now, not the one it arrived with: the line points at a file the
        // person can go and find.
        name: (heaviest.newRelPath ?? heaviest.relPath).split('/').pop() ?? heaviest.fileName,
        share,
        size: formatSize(weight, language)
      })}
    </p>
  );
}

function LandingAssetControls({
  total,
  sharedFolder,
  skipped,
  filter,
  sort,
  onFilter,
  onSort,
  t
}: {
  total: number;
  /** Printed once here when every file lives in it, instead of on every row. */
  sharedFolder: string | null;
  skipped: number;
  filter: 'all' | 'skipped';
  sort: 'saving' | 'size';
  onFilter: (value: 'all' | 'skipped') => void;
  onSort: (value: 'saving' | 'size') => void;
  t: Translate;
}) {
  // Under a dozen rows the whole list is on screen; controls for it are furniture.
  if (total < 8) return null;
  return (
    <div className="landing-asset-controls">
      {/* Where the files are and which of them are shown belong together on the left; the
          order they are shown in belongs on the right. */}
      <div className="landing-asset-scope">
        {sharedFolder && <span className="landing-shared-folder">{sharedFolder}/</span>}
        <div className="landing-asset-filters" role="group">
        <button
          type="button"
          className={filter === 'all' ? 'is-selected' : ''}
          aria-pressed={filter === 'all'}
          onClick={() => onFilter('all')}
        >
          {t('landingAssetFilterAll')} <b>{total}</b>
        </button>
        {skipped > 1 && (
          <button
            type="button"
            className={filter === 'skipped' ? 'is-selected' : ''}
            aria-pressed={filter === 'skipped'}
            onClick={() => onFilter('skipped')}
          >
            {t('landingAssetFilterSkipped')} <b>{skipped}</b>
          </button>
          )}
        </div>
      </div>
      <div className="landing-asset-filters" role="group">
        <button
          type="button"
          className={sort === 'saving' ? 'is-selected' : ''}
          aria-pressed={sort === 'saving'}
          onClick={() => onSort('saving')}
        >
          {t('landingAssetSortSaving')}
        </button>
        <button
          type="button"
          className={sort === 'size' ? 'is-selected' : ''}
          aria-pressed={sort === 'size'}
          onClick={() => onSort('size')}
        >
          {t('landingAssetSortSize')}
        </button>
      </div>
    </div>
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
      <LandingHeaviest job={job} language={language} t={t} />
      <dl className="landing-success-metrics">
        <div>
          <dt>{t('landingImagesOptimized')}</dt>
          <dd>{job.imagesOptimized}</dd>
        </div>
        {/* A zero where there were no videos at all reads as "it failed at videos". */}
        {job.assets.some(asset => asset.type === 'video') && (
          <div>
            <dt>{t('landingVideosOptimized')}</dt>
            <dd>{job.videosOptimized}</dd>
          </div>
        )}
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
  hideFolder,
  language,
  onCompare,
  t
}: {
  jobId: string;
  asset: LandingAsset;
  current: boolean;
  /** True when the list already says which folder every file is in. */
  hideFolder: boolean;
  language: Language;
  onCompare: (assetId: string, trigger: HTMLElement) => void;
  t: Translate;
}) {
  const displayPath = asset.newRelPath ?? asset.relPath;
  const pathParts = displayPath.split('/');
  const fileName = pathParts.pop() ?? asset.fileName;
  const parentPath = pathParts.join('/');
  const openable = asset.type === 'image' && asset.preview?.available === true;
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

      {/* The name and its numbers open the comparison too. The thumbnail alone was a 44px
          target on a row six hundred wide, and nothing about the name suggested it was one. */}
      {openable ? (
        <button
          type="button"
          className="landing-asset-copy is-openable"
          aria-label={t('landingAssetOpen', { name: fileName })}
          onClick={event => onCompare(asset.id, event.currentTarget)}
        >
        {/* No type tag: the thumbnail beside it has already said what kind of file this is,
            on every row, twenty-two times. */}
        <div className="landing-asset-name-line">
          <h3 title={displayPath}>{fileName}</h3>
          {parentPath && !hideFolder && (
            <span className="landing-asset-path" title={parentPath}>
              {parentPath}
            </span>
          )}
        </div>
        <div className="landing-asset-sizes">
          {/* The percentage leads and the two figures follow it quietly: on a list this long
              the third number is the one that is scanned, and it is the one derived from the
              other two. */}
          {asset.status === 'optimized' &&
            asset.optimizedSize !== null &&
            asset.savedPercent !== null &&
            asset.savedPercent > 0 && (
              <span className="landing-saved">
                {t('landingSaved', { value: asset.savedPercent })}
              </span>
            )}
          <span className="landing-asset-bytes">
            {formatSize(asset.originalSize, language)}
            {asset.status === 'optimized' && asset.optimizedSize !== null && (
              <>
                <i aria-hidden="true">→</i>
                {formatSize(asset.optimizedSize, language)}
              </>
            )}
          </span>
          {asset.note && <span className="landing-note">{localizedNote(asset.note, t)}</span>}
        </div>
        </button>
      ) : (
        <div className="landing-asset-copy">
        {/* No type tag: the thumbnail beside it has already said what kind of file this is,
            on every row, twenty-two times. */}
        <div className="landing-asset-name-line">
          <h3 title={displayPath}>{fileName}</h3>
          {parentPath && !hideFolder && (
            <span className="landing-asset-path" title={parentPath}>
              {parentPath}
            </span>
          )}
        </div>
        <div className="landing-asset-sizes">
          {/* The percentage leads and the two figures follow it quietly: on a list this long
              the third number is the one that is scanned, and it is the one derived from the
              other two. */}
          {asset.status === 'optimized' &&
            asset.optimizedSize !== null &&
            asset.savedPercent !== null &&
            asset.savedPercent > 0 && (
              <span className="landing-saved">
                {t('landingSaved', { value: asset.savedPercent })}
              </span>
            )}
          <span className="landing-asset-bytes">
            {formatSize(asset.originalSize, language)}
            {asset.status === 'optimized' && asset.optimizedSize !== null && (
              <>
                <i aria-hidden="true">→</i>
                {formatSize(asset.optimizedSize, language)}
              </>
            )}
          </span>
          {asset.note && <span className="landing-note">{localizedNote(asset.note, t)}</span>}
        </div>
        </div>
      )}

      {/* A badge on every row that says "optimized" is a badge that says nothing. It stays for
          the outcomes that are not the ordinary one — left alone, failed, still running. */}
      {asset.status !== 'optimized' && (
        <div className="landing-asset-state">
          <span className={`status-badge ${landingStatusClass(asset.status)}`}>
            {asset.status === 'processing' && <SotyLoader size={15} />}
            {t(landingStatusKey(asset.status))}
          </span>
        </div>
      )}

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
  // Ticketed rather than token-carrying: these end up in <img src>, which is
  // the one place a URL is guaranteed to be logged and referred.
  const before = useSubresourceUrl(landingPreviewPath(jobId, asset.id, 'before'), {
    variant: beforeVariant === 'full' ? 'full' : 'thumbnail'
  });
  const after = useSubresourceUrl(landingPreviewPath(jobId, asset.id, 'after'), {
    variant: afterVariant === 'full' ? 'full' : 'thumbnail'
  });
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
            src={after ?? ''}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => retryFull(afterVariant, setAfterVariant)}
          />
          <span aria-hidden="true">
            <img
              src={before ?? ''}
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
          src={before ?? ''}
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
              : job.status === 'cancelled'
                /* Its own word: the shared one reads "Not compressed", which is the
                   compressor talking about a video, not this tool about a landing. */
                ? t('landingStatusCancelled')
                : finalizing
                  ? t('landingStatusFinalizing')
                  : t('landingStatusProcessing');
  const statusClass =
    job.status === 'completed'
      ? 'status-completed'
      : job.status === 'failed'
        ? 'status-failed'
        : job.status === 'cancelled'
          ? 'status-cancelled'
          : job.status === 'ready'
            ? 'status-ready'
            : job.status === 'queued'
              ? 'status-queued'
              : 'status-processing';
  return (
    <span className={`status-badge ${statusClass}`}>
      {running && <SotyLoader size={15} />}
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
