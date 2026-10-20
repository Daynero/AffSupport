import { useEffect, useRef, useState } from 'react';
import { financeDecimalComma, formatFinanceAmount } from './formatFinanceAmount';
import { financeMoney, parseFinanceMoney, type FinanceMutation } from '@video-compressor/shared';
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
import {
  useRetainedFinanceDiagnostics,
  type FinanceDiagnosticAttempt
} from './useRetainedFinanceDiagnostics';

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
  onImported: (receipt?: FinanceMutation, flowId?: string) => void;
}) {
  const { t } = useI18n();
  const diagnostics = useRetainedFinanceDiagnostics('financeLegacyImport', `${teamId}/${agent}`);
  const {
    start: readStart,
    current: readCurrent,
    accept: readAccept,
    applied: readApplied,
    fail: readFail
  } = useRetainedFinanceDiagnostics('financeHistory', `${teamId}/${agent}`);
  const [readProof, setReadProof] = useState<FinanceDiagnosticAttempt | null>(null);
  const readValue = useRef<HTMLParagraphElement>(null);
  const lastAttempt = useRef<FinanceDiagnosticAttempt | null>(null);
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
    const attempt = readStart();
    void teamFinanceApi
      .legacy(teamId, agent)
      .then(rows => {
        if (active && readCurrent(attempt)) {
          readAccept(attempt);
          setLegacy(rows);
          setReadProof(attempt);
        }
      })
      .catch(cause => {
        if (active && readCurrent(attempt)) {
          readFail(attempt, cause);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [teamId, agent, readStart, readCurrent, readAccept, readFail]);
  const row = legacy.find(l =>
    metric === 'balance'
      ? l.balance_units !== null && l.balance_imported_event_id === null
      : l.requested_topup_units !== null && l.topup_imported_event_id === null
  );
  useEffect(() => {
    if (readProof && !error && readValue.current) readApplied(readProof);
  }, [readProof, readApplied, legacy, metric, error]);
  return (
    <Modal
      title={t('financeLegacy')}
      onClose={() => {
        if (lastAttempt.current) diagnostics.cancel(lastAttempt.current);
        onClose();
      }}
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
      <p ref={readValue}>
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
            const attempt = diagnostics.start();
            lastAttempt.current = attempt;
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
              .then(result => {
                if (!diagnostics.current(attempt)) return;
                diagnostics.accept(attempt);
                // Closing this dialog proves no table delivery; parent may prove
                // canonical field versions in a later committed row render.
                diagnostics.partial(attempt);
                onImported(result, attempt.flowId);
                onClose();
              })
              .catch(cause => {
                if (diagnostics.current(attempt)) {
                  diagnostics.fail(attempt, cause);
                  setError(true);
                }
              })
              .finally(() => {
                if (diagnostics.current(attempt)) setBusy(false);
              });
          }}
        />
      )}
    </Modal>
  );
}
