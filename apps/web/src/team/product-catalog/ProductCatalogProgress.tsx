import { useI18n, type TranslationKey } from '../../i18n';
import { useStagedStatus, type StatusStage } from './useStagedStatus';

/** The same estimated server-side stages used while creating and updating a catalog. */
export function ProductCatalogProgress({
  active,
  productTotal,
  compact = false
}: {
  active: boolean;
  productTotal: number;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const stages: ReadonlyArray<StatusStage<TranslationKey>> = [
    { key: 'productCatalogStageVideo', ms: 1600 },
    { key: 'productCatalogStageDraw', ms: 1400 },
    { key: 'productCatalogStagePictures', ms: Math.max(2000, productTotal * 260) },
    { key: 'productCatalogStageRows', ms: 1600 },
    { key: 'productCatalogStageUpload', ms: 9000 },
    { key: 'productCatalogStageSlow', ms: 0 }
  ];
  const stageIndex = useStagedStatus(active, stages);
  const stage = stages[stageIndex];
  const stepTotal = stages.length - 1;
  const stepNow = Math.min(stageIndex, stepTotal - 1);

  if (!active || !stage) return null;

  return (
    <div className={`product-catalog-progress${compact ? ' is-compact' : ''}`} role="status">
      <p className="product-catalog-progress-step">{t(stage.key, { count: productTotal })}</p>
      <p className="product-catalog-progress-count" aria-hidden="true">
        {t('productCatalogStageOf', { step: stepNow + 1, total: stepTotal })}
      </p>
      <div className="product-catalog-progress-track" aria-hidden="true">
        {stages.slice(0, stepTotal).map((entry, position) => (
          <span
            key={entry.key}
            className={position < stepNow ? 'is-done' : position === stepNow ? 'is-now' : ''}
          />
        ))}
      </div>
    </div>
  );
}
