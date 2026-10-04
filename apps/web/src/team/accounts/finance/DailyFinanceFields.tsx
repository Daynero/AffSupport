import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import {
  financeMoney,
  parseFinanceMoney,
  type FinanceField,
  type FinanceMetric
} from '@video-compressor/shared';
import { Button, Input, FormField, ConfirmDialog } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { formatFinanceAmount } from './formatFinanceAmount';

/** Drafts never follow server rereads; cancel is the only implicit discard. */
export function DailyFinanceField({
  metric,
  field,
  canEdit,
  save,
  draftKey,
  contextLabel,
  onStateChange,
  onRegisterSave,
  compact = false
}: {
  metric: FinanceMetric;
  field: FinanceField | undefined;
  canEdit: boolean;
  save: (value: string | null, version: string, request: string) => Promise<void>;
  draftKey?: string;
  contextLabel?: string;
  compact?: boolean;
  onStateChange?: (key: string, state: 'clean' | 'dirty' | 'pending') => void;
  onRegisterSave?: (key: string, save: (() => Promise<boolean>) | null) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [version, setVersion] = useState('0');
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (draftKey) onStateChange?.(draftKey, busy ? 'pending' : draft === null ? 'clean' : 'dirty');
  }, [draftKey, onStateChange, busy, draft]);
  useEffect(
    () => () => {
      if (draftKey) onStateChange?.(draftKey, 'clean');
    },
    [draftKey, onStateChange]
  );
  const label = t(
    metric === 'balance' ? 'financeBalance' : metric === 'topup' ? 'financeTopup' : 'financeSpend'
  );
  const commit = async () => {
    if (draft === null) return true;
    if (busy || !canEdit) return false;
    const cents = parseFinanceMoney(draft);
    if (cents === undefined) {
      setError(t('financeInvalid'));
      return false;
    }
    setBusy(true);
    try {
      await save(
        cents === null ? null : financeMoney(cents),
        conflicted ? (field?.version ?? '0') : version,
        request
      );
      setDraft(null);
      setError(null);
      setSaved(true);
      return true;
    } catch (cause) {
      const conflict = cause instanceof Error && cause.message.includes('FINANCE_CONFLICT');
      setError(t(conflict ? 'financeConflict' : 'financeError'));
      // A failed CAS has no effects. Review the refreshed authoritative row,
      // then a new request can be submitted; transport failures keep the ID.
      if (conflict) {
        setConflicted(true);
        setRequest(crypto.randomUUID());
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!draftKey || !onRegisterSave) return;
    onRegisterSave(draftKey, commit);
    return () => onRegisterSave(draftKey, null);
  });
  const submit = () => {
    if (parseFinanceMoney(draft) === null && field?.value != null) setConfirmClear(true);
    else void commit();
  };
  return (
    <div className="w-36 max-w-full">
      <FormField
        label={<span className={compact ? 'finance-field-label' : undefined}>{label} · USD</span>}
        error={error}
      >
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Input
              aria-label={`${contextLabel ? `${contextLabel} · ` : ''}${label} · USD`}
              inputMode="decimal"
              value={draft ?? formatFinanceAmount(field?.value, '')}
              readOnly={!canEdit}
              disabled={busy}
              invalid={Boolean(error)}
              width="full"
              onChange={event => {
                if (!canEdit) return;
                if (draft === null) {
                  setVersion(field?.version ?? '0');
                  setConflicted(false);
                }
                setRequest(crypto.randomUUID());
                setDraft(event.target.value);
                setError(null);
                setSaved(false);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                } else if (event.key === 'Tab' && draft !== null && !busy && canEdit) {
                  if (parseFinanceMoney(draft) === undefined) event.preventDefault();
                  submit();
                } else if (event.key === 'Escape' && !busy) {
                  setDraft(null);
                  setError(null);
                }
              }}
            />
          </div>
          <span
            className="flex w-5 shrink-0 items-center justify-center text-success-text"
            role={saved && draft === null ? 'status' : undefined}
            title={saved && draft === null ? t('financeSaved') : undefined}
          >
            {saved && draft === null && (
              <>
                <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span className="visually-hidden">{t('financeSaved')}</span>
              </>
            )}
          </span>
        </div>
      </FormField>
      {conflicted && draft !== null && (
        <p>{t('financeCurrentValue', { value: formatFinanceAmount(field?.value) })}</p>
      )}
      {draft !== null && canEdit && (
        <div className="flex gap-2">
          <Button size="sm" color="success" loading={busy} onClick={submit}>
            {t('financeSave')}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            {t('financeCancel')}
          </Button>
        </div>
      )}
      {confirmClear && (
        <ConfirmDialog
          title={label}
          body={t('financeClearBody')}
          confirmLabel={t('financeSave')}
          cancelLabel={t('financeCancel')}
          busy={busy}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void commit();
          }}
        />
      )}
    </div>
  );
}
