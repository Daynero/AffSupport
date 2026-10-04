import type { buildFinanceReport } from '@video-compressor/shared';
import { Button } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { formatFinanceAmount } from './formatFinanceAmount';
export function FinanceTopupStatement({
  report,
  onDay
}: {
  report: ReturnType<typeof buildFinanceReport>;
  onDay: (day: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-label={t('financeStatement')} className="flex flex-col gap-2">
      <h4>{t('financeStatement')}</h4>
      {report.topups.length ? (
        report.topups.map(row => (
          <div key={`${row.date}/${row.accountId}/${row.agentRowId}`}>
            <Button size="sm" onClick={() => onDay(row.date)}>
              {row.date}
            </Button>{' '}
            {row.accountName} / {row.agentId} · {formatFinanceAmount(row.value)} USD
          </div>
        ))
      ) : (
        <p>{t('financeEmpty')}</p>
      )}
      <p>
        {t('financeTopup')}: {formatFinanceAmount(report.totals.topup)} USD
      </p>
    </section>
  );
}
