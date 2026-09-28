import type { CatalogUpdateStage } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';

const STAGES: ReadonlyArray<{ stage: CatalogUpdateStage; key: TranslationKey }> = [
  { stage: 'preparing', key: 'catalogUpdaterStagePreparing' },
  { stage: 'refreshing', key: 'catalogUpdaterStageRefreshing' },
  { stage: 'building', key: 'catalogUpdaterStageBuilding' },
  { stage: 'uploading', key: 'catalogUpdaterStageUploading' },
  { stage: 'finalizing', key: 'catalogUpdaterStageFinalizing' }
];

const RESTITCH_STAGES = {
  downloading: 'catalogUpdaterVideoDownloading',
  processing: 'catalogUpdaterVideoProcessing',
  uploading: 'catalogUpdaterVideoUploading',
  finalizing: 'catalogUpdaterVideoFinalizing'
} as const satisfies Record<string, TranslationKey>;

/** Progress confirmed by the background worker, rather than estimated in this browser. */
export function CatalogUpdateProgress({
  stage,
  restitchProgress,
  restitchStage
}: {
  stage: CatalogUpdateStage | null;
  restitchProgress?: number | null;
  restitchStage?: keyof typeof RESTITCH_STAGES | null;
}) {
  const { t } = useI18n();
  if (stage === 'waiting_video' || stage === 'restitching') {
    const waiting = stage === 'waiting_video';
    const percent = Math.max(0, Math.min(100, restitchProgress ?? 0));
    return (
      <div className="product-catalog-progress is-compact" role="status">
        <p className="product-catalog-progress-step">
          {t(
            waiting ? 'catalogUpdaterVideoWaiting' : RESTITCH_STAGES[restitchStage ?? 'downloading']
          )}
        </p>
        {!waiting && (
          <p className="product-catalog-progress-count" aria-hidden="true">
            {percent}%
          </p>
        )}
        <div
          className="product-catalog-restitch-track"
          role={waiting ? undefined : 'progressbar'}
          aria-label={waiting ? undefined : t('catalogUpdaterVideoProgress')}
          aria-valuemin={waiting ? undefined : 0}
          aria-valuemax={waiting ? undefined : 100}
          aria-valuenow={waiting ? undefined : percent}
        >
          <span
            className={waiting ? 'is-waiting' : undefined}
            style={{ transform: `scaleX(${waiting ? 0.2 : percent / 100})` }}
          />
        </div>
      </div>
    );
  }
  const index = Math.max(
    0,
    STAGES.findIndex(entry => entry.stage === stage)
  );
  const current = STAGES[index]!;

  return (
    <div className="product-catalog-progress is-compact" role="status">
      <p className="product-catalog-progress-step">{t(current.key)}</p>
      <p className="product-catalog-progress-count" aria-hidden="true">
        {t('productCatalogStageOf', { step: index + 1, total: STAGES.length })}
      </p>
      <div className="product-catalog-progress-track" aria-hidden="true">
        {STAGES.map(entry => {
          const position = STAGES.indexOf(entry);
          return (
            <span
              key={entry.stage}
              className={position < index ? 'is-done' : position === index ? 'is-now' : ''}
            />
          );
        })}
      </div>
    </div>
  );
}
