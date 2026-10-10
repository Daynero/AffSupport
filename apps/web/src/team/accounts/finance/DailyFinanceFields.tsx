import { useEffect, useId, useState } from 'react';
import { Check, CircleDot } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import {
  financeMoney,
  parseFinanceMoney,
  type FinanceField,
  type FinanceMetric
} from '@video-compressor/shared';
import { Button, Input, FormField, ConfirmDialog } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { financeDecimalComma, formatFinanceAmount } from './formatFinanceAmount';

/** Drafts never follow server rereads; cancel is the only implicit discard. */
export function DailyFinanceField({
  metric,
  field,
  placementId,
  canEdit,
  save,
  draftKey,
  contextLabel,
  onStateChange,
  onRegisterSave,
  compact = false,
  disabled = false
}: {
  metric: FinanceMetric;
  field: FinanceField | undefined;
  placementId?: string;
  canEdit: boolean;
  save: (
    value: string | null,
    version: string,
    request: string,
    placementId?: string
  ) => Promise<void>;
  draftKey?: string;
  contextLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  onStateChange?: (key: string, state: 'clean' | 'dirty' | 'pending') => void;
  onRegisterSave?: (key: string, save: (() => Promise<boolean>) | null, clears?: boolean) => void;
}) {
  const { t } = useI18n();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftPlacement, setDraftPlacement] = useState<string | undefined>();
  const [placementConflict, setPlacementConflict] = useState(false);
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
    if (busy || !canEdit || placementConflict) return false;
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
        request,
        draftPlacement
      );
      setDraft(null);
      setError(null);
      setSaved(true);
      return true;
    } catch (cause) {
      const conflict = cause instanceof Error && cause.message.includes('FINANCE_CONFLICT');
      const moved = cause instanceof Error && cause.message.includes('PLACEMENT_CONFLICT');
      setPlacementConflict(moved);
      setError(
        t(moved ? 'financePlacementConflict' : conflict ? 'financeConflict' : 'financeError')
      );
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
    onRegisterSave(
      draftKey,
      commit,
      draft !== null && parseFinanceMoney(draft) === null && field?.value != null
    );
    return () => onRegisterSave(draftKey, null);
  });
  const submit = () => {
    if (parseFinanceMoney(draft) === null && field?.value != null) setConfirmClear(true);
    else void commit();
  };
  const isSaved = draft === null && (saved || field?.value != null);
  const statusLabel =
    draft !== null ? t('financeUnsaved') : isSaved ? t('financeSaved') : undefined;
  const currentValue =
    conflicted && draft !== null
      ? t('financeCurrentValue', { value: formatFinanceAmount(field?.value) })
      : null;
  const shortError = error
    ? t(
        error === t('financeInvalid')
          ? 'financeInvalidShort'
          : conflicted
            ? 'financeConflictShort'
            : 'financeErrorShort'
      )
    : null;
  return (
    <div
      className={compact ? 'finance-cell' : 'w-36 max-w-full'}
      data-finance-state={draft !== null ? 'dirty' : isSaved ? 'saved' : 'empty'}
    >
      <div className={compact ? 'w-36 max-w-full shrink-0' : undefined}>
        <FormField
          label={<span className={compact ? 'finance-field-label' : undefined}>{label} · USD</span>}
          error={compact ? undefined : error}
        >
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Input
                aria-label={`${contextLabel ? `${contextLabel} · ` : ''}${label} · USD`}
                aria-describedby={compact && (error || currentValue) ? errorId : undefined}
                inputMode="decimal"
                value={draft ?? formatFinanceAmount(field?.value, '')}
                readOnly={!canEdit}
                disabled={busy || disabled}
                invalid={Boolean(error)}
                width="full"
                onChange={event => {
                  if (!canEdit) return;
                  if (draft === null) {
                    setDraftPlacement(placementId ?? field?.placementId);
                    setPlacementConflict(false);
                    setVersion(field?.version ?? '0');
                    setConflicted(false);
                  }
                  setRequest(crypto.randomUUID());
                  setDraft(financeDecimalComma(event.target.value));
                  setError(
                    draft !== null && placementConflict ? t('financePlacementConflict') : null
                  );
                  setSaved(false);
                }}
                onKeyDown={event => {
                  if (onRegisterSave && (event.key === 'Enter' || event.key === 'Tab')) {
                    if (event.key === 'Enter') event.preventDefault();
                    return;
                  }
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
              className={`flex w-5 shrink-0 items-center justify-center ${draft !== null ? 'text-warning-text' : 'text-success-text'}`}
              role={statusLabel ? 'status' : undefined}
              title={statusLabel}
            >
              {statusLabel && (
                <>
                  {draft !== null ? (
                    <CircleDot size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  ) : (
                    <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  )}
                  <span className="visually-hidden">{statusLabel}</span>
                </>
              )}
            </span>
          </div>
        </FormField>
      </div>
      {compact && (error || currentValue) && (
        <span
          id={errorId}
          role="alert"
          className="finance-cell-message text-label text-error-text"
          title={[error, currentValue].filter(Boolean).join(' ')}
        >
          {placementConflict ? error : shortError}
          {currentValue && ` · ${formatFinanceAmount(field?.value)} USD`}
        </span>
      )}
      {!compact && currentValue && <p>{currentValue}</p>}
      {draft !== null && canEdit && !onRegisterSave && (
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
