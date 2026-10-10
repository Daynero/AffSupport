import type { AdminSpaceRequest, TariffPlan } from '@video-compressor/shared';
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  User
} from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatTariffMoment } from '../../team/tariffs/format';

/**
 * Requests (034, US3.7) — what used to be the waiting list, now with the plan
 * the person wanted and where they wrote from. «Видати тариф» opens the grant
 * with both filled in; «Опрацьовано» takes the row out of the count.
 */

const CHANNEL: Record<string, TranslationKey> = {
  telegram: 'tariffContactTelegram',
  email: 'tariffContactEmail',
  copy: 'adminTariffChannelCopy'
};

export function TariffRequests({
  requests,
  plans,
  busyId,
  onGrant,
  onMark
}: {
  requests: readonly AdminSpaceRequest[];
  plans: readonly TariffPlan[];
  busyId: string | null;
  onGrant: (request: AdminSpaceRequest) => void;
  onMark: (request: AdminSpaceRequest, handled: boolean) => void;
}) {
  const { t, language } = useI18n();
  if (requests.length === 0) {
    return <EmptyState size="sm" className="admin-empty" title={t('adminTariffRequestsEmpty')} />;
  }
  const planLabel = (code: string | null) => {
    if (!code) return '—';
    const plan = plans.find(item => item.code === code);
    return plan ? (language === 'uk' ? plan.nameUk : plan.nameEn) : code;
  };
  const sorted = [...requests].sort(
    (a, b) =>
      Number(Boolean(a.handledAt)) - Number(Boolean(b.handledAt)) ||
      (b.lastContactAt ?? b.createdAt).localeCompare(a.lastContactAt ?? a.createdAt)
  );

  return (
    <Table
      size="sm"
      className="admin-table admin-tariff-table"
      columns="minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 2fr)"
      label={t('adminTariffFilterRequests')}
    >
      <TableHeader>
        <TableHeaderCell>{t('email')}</TableHeaderCell>
        <TableHeaderCell>{t('adminTariffPlan')}</TableHeaderCell>
        <TableHeaderCell>{t('adminTariffChannel')}</TableHeaderCell>
        <TableHeaderCell>{t('adminTariffWhen')}</TableHeaderCell>
        <TableHeaderCell>
          <span className="visually-hidden">{t('adminTariffActions')}</span>
        </TableHeaderCell>
      </TableHeader>
      {sorted.map(request => (
        <TableRow key={request.userId} busy={busyId === request.userId}>
          <TableCell>
            <User name={request.email} meta={request.name ?? undefined} />
          </TableCell>
          <TableCell>{planLabel(request.planInterest)}</TableCell>
          <TableCell>
            {request.channel && CHANNEL[request.channel] ? t(CHANNEL[request.channel]!) : '—'}
          </TableCell>
          <TableCell>
            {formatTariffMoment(request.lastContactAt ?? request.createdAt, language)}
          </TableCell>
          <TableCell>
            <span className="flex flex-wrap items-center justify-end gap-2">
              {request.hasTariff && (
                <Badge size="xs" color="success">
                  {t('adminTariffHasTariff')}
                </Badge>
              )}
              {request.handledAt ? (
                <Button size="sm" variant="ghost" onClick={() => onMark(request, false)}>
                  {t('adminTariffReopen')}
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => onMark(request, true)}>
                    {t('adminTariffHandled')}
                  </Button>
                  {!request.hasTariff && (
                    <Button
                      size="sm"
                      color="neutral"
                      variant="outline"
                      onClick={() => onGrant(request)}
                    >
                      {t('adminTariffGrant')}
                    </Button>
                  )}
                </>
              )}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}
