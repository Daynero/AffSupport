import type { CatalogUpdateStage } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';

const STAGES: ReadonlyArray<{ stage: CatalogUpdateStage; key: TranslationKey }> = [
  { stage: 'preparing', key: 'catalogUpdaterStagePreparing' },
  { stage: 'refreshing', key: 'catalogUpdaterStageRefreshing' },
  { stage: 'building', key: 'catalogUpdaterStageBuilding' },
  { stage: 'uploading', key: 'catalogUpdaterStageUploading' },
  { stage: 'finalizing', key: 'catalogUpdaterStageFinalizing' }
];

/** Progress confirmed by the background worker, rather than estimated in this browser. */
export function CatalogUpdateProgress({ stage }: { stage: CatalogUpdateStage | null }) {
  const { t } = useI18n();
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
