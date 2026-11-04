import { useI18n } from '../../i18n';
import { Spinner } from '../../components/ui';

/** A pending request does not prove which provider stage is currently running. */
export function ProductCatalogProgress({
  active,
  compact = false
}: {
  active: boolean;
  productTotal: number;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!active) return null;
  return (
    <div className={`product-catalog-progress${compact ? ' is-compact' : ''}`} role="status">
      <Spinner />
      <p className="product-catalog-progress-step">{t('productCatalogCreating')}</p>
    </div>
  );
}
