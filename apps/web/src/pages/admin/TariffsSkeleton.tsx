import { Card } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/** The tariff tab while its first answer is on the way: a summary, a filter row, rows. */
export function TariffsSkeleton() {
  const { t } = useI18n();
  return (
    <div className="admin-skeleton" role="status" aria-label={t('loading')}>
      <Card as="div" className="admin-card" aria-hidden="true">
        <div className="admin-card-heading">
          <span className="soty-skeleton skeleton-line skeleton-line-lg" />
          <span className="soty-skeleton skeleton-button" />
        </div>
        <span className="soty-skeleton skeleton-field" />
        <div className="skeleton-list">
          {[0, 1, 2, 3, 4].map(row => (
            <div className="skeleton-list-row" key={row}>
              <span className="soty-skeleton skeleton-line skeleton-line-wide" />
              <span className="soty-skeleton skeleton-line skeleton-line-sm" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
