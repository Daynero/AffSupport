import { useEffect, useState } from 'react';
import { financeDecimalComma, formatFinanceAmount } from './formatFinanceAmount';
import { financeMoney, parseFinanceMoney } from '@video-compressor/shared';
import {
  Button,
  FormField,
  Input,
  Select,
  Modal,
  ErrorState,
  Calendar,
  toCalendarDate,
  fromCalendarDate,
  ConfirmDialog
} from '../../../components/ui/index';
import { teamFinanceApi } from '../../../api/team-finance';
import { useI18n } from '../../../i18n';

export function LegacyFinanceReview({
  teamId,
  agent,
  today,
  timezone,
  onClose,
  onImported
}: {
  teamId: string;
  agent: string;
  today: string;
  timezone: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const [legacy, setLegacy] = useState<Record<string, unknown>[]>([]);
  const [metric, setMetric] = useState<'balance' | 'topup'>('balance');
  const [date, setDate] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(() => crypto.randomUUID());
  const [confirmation, setConfirmation] = useState<{
    id: string;
    metric: 'balance' | 'topup';
    date: string;
    value: string;
    request: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void teamFinanceApi
      .legacy(teamId, agent)
      .then(rows => {
        if (active) setLegacy(rows);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [teamId, agent]);
  const row = legacy.find(l =>
    metric === 'balance'
      ? l.balance_units !== null && l.balance_imported_event_id === null
      : l.requested_topup_units !== null && l.topup_imported_event_id === null
  );
  return (
    <Modal
      title={t('financeLegacy')}
      onClose={onClose}
      busy={busy}
      footer={
        <Button
          disabled={!row || busy || !value || !date}
          onClick={() => {
            const cents = parseFinanceMoney(value);
            if (!date || cents === undefined || cents === null || typeof row?.id !== 'string') {
              setError(true);
              return;
            }
            setError(false);
            setConfirmation({ id: row.id, metric, date, value: financeMoney(cents), request });
          }}
        >
          {t('financeImport')}
        </Button>
      }
    >
      <p>{t('financeLegacyHelp')}</p>
      <Select
        aria-label={t('financeLegacy')}
        value={metric}
        onChange={v => {
          if (busy) return;
          if (v === 'balance' || v === 'topup') {
            setMetric(v);
            setRequest(crypto.randomUUID());
          }
        }}
        options={[
          { value: 'balance', label: t('financeBalance') },
          { value: 'topup', label: t('financeTopup') }
        ]}
      />
      <p>
        {formatFinanceAmount(
          row ? (metric === 'balance' ? row.balance_units : row.requested_topup_units) : null
        )}
      </p>
      <Calendar
        label={t('financeDate')}
        value={toCalendarDate(date)}
        maxValue={toCalendarDate(today) ?? undefined}
        onChange={v => {
          if (busy) return;
          const next = fromCalendarDate(v);
          if (next) {
            setDate(next);
            setRequest(crypto.randomUUID());
          }
        }}
      />
      <FormField label="USD">
        <Input
          aria-label="USD"
          inputMode="decimal"
          value={value}
          disabled={busy}
          onChange={e => {
            setValue(financeDecimalComma(e.target.value));
            setRequest(crypto.randomUUID());
          }}
        />
      </FormField>
      {error && <ErrorState message={t('financeError')} />}
      {confirmation && (
        <ConfirmDialog
          nested
          tone="neutral"
          title={t('financeImport')}
          body={
            <>
              {t('financeImportConfirm', {
                metric: t(confirmation.metric === 'balance' ? 'financeBalance' : 'financeTopup'),
                date: confirmation.date,
                value: formatFinanceAmount(confirmation.value)
              })}
              {error ? ` ${t('financeError')}` : ''}
            </>
          }
          confirmLabel={t('financeImport')}
          cancelLabel={t('financeCancel')}
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirmation(null);
          }}
          onConfirm={() => {
            if (busy) return;
            setBusy(true);
            setError(false);
            void teamFinanceApi
              .importLegacy(
                teamId,
                confirmation.id,
                confirmation.metric,
                confirmation.date,
                confirmation.value,
                timezone,
                confirmation.request
              )
              .then(() => {
                onImported();
                onClose();
              })
              .catch(() => setError(true))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </Modal>
  );
}
