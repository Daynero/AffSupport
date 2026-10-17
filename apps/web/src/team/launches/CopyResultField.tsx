import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Pencil } from 'lucide-react';
import { Button, Input, Textarea } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useOptionalToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
export function CopyResultField({
  label,
  displayLabel,
  baseline,
  value,
  onChange,
  editable = false,
  disabled = false,
  compact = false,
  campaignOrdinal,
  campaignBudget,
  hideLabel = false,
  openExternal = false,
  validate,
  onCopyOutcome
}: {
  label: string;
  displayLabel?: string;
  baseline: string;
  value: string;
  onChange?: (value: string) => void;
  editable?: boolean;
  disabled?: boolean;
  compact?: boolean;
  campaignOrdinal?: string;
  campaignBudget?: string;
  hideLabel?: boolean;
  openExternal?: boolean;
  validate?: (value: string) => boolean;
  onCopyOutcome?: (outcome: 'success' | 'failure') => void;
}) {
  const { t } = useI18n();
  const toasts = useOptionalToasts();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const changed = value !== baseline;
  const mounted = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const invalid =
    !value.length ||
    value.length > 8192 ||
    /\p{Cc}/u.test(value) ||
    (validate ? !validate(value) : false);
  const inlineEdit = compact && !campaignOrdinal;
  useEffect(() => {
    setCopied(false);
    setFailed(false);
  }, [value]);
  useEffect(() => {
    if (editing) editor.current?.focus();
    else if (wasEditing.current) copyButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = async (keyboardActivation: boolean) => {
    if (invalid || disabled) return;
    const selection = window.getSelection();
    if (
      !keyboardActivation &&
      selection &&
      !selection.isCollapsed &&
      (copyButton.current?.contains(selection.anchorNode) ||
        copyButton.current?.contains(selection.focusNode))
    )
      return;
    setFailed(false);
    const copiedValue = value;
    try {
      await navigator.clipboard.writeText(copiedValue);
      if (!mounted.current || valueRef.current !== copiedValue) return;
      try {
        onCopyOutcome?.('success');
      } catch {
        // Reporting failure cannot undo a successful clipboard write.
      }
      toasts?.push({ tone: 'success', text: t('launchesCopied') });
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      if (mounted.current && valueRef.current === copiedValue) {
        setFailed(true);
        try {
          onCopyOutcome?.('failure');
        } catch {
          // Keep the actual clipboard error visible.
        }
      }
    }
  };
  return (
    <div
      className={`${compact ? `launch-result-row${campaignOrdinal ? ' launch-result-campaign-row' : ''}${hideLabel ? ' launch-result-hide-label' : ''}` : 'flex min-w-0 flex-col gap-1 rounded-control border p-2'} ${compact ? (copied ? 'launch-result-copied' : changed ? 'launch-result-changed' : '') : copied ? 'border-success-border bg-success-soft' : changed ? 'border-warning-border bg-warning-soft' : 'border-neutral-border bg-surface'}`}
    >
      <div className="flex items-center justify-between gap-2">
        {!campaignOrdinal && <span className="min-w-0 font-medium">{displayLabel ?? label}</span>}
        <div className="flex shrink-0 items-center gap-1">
          {changed && <span className="text-label text-warning-text">{t('launchesManual')}</span>}
          {editable && !inlineEdit && (
            <Button
              variant="ghost"
              size="sm"
              className={compact ? 'launch-result-edit' : undefined}
              disabled={disabled}
              aria-label={editing ? t('launchesDone') : t('launchesEditField', { field: label })}
              onClick={() => setEditing(v => !v)}
            >
              {compact ? (
                editing ? (
                  <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                ) : (
                  <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                )
              ) : editing ? (
                t('launchesDone')
              ) : (
                t('launchesEdit')
              )}
            </Button>
          )}
          {editable && changed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange?.(baseline)}
            >
              {t('launchesReset')}
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div
          className={`launch-result-value-actions${inlineEdit ? ' launch-result-inline-actions' : ''}`}
        >
          <Input
            className={compact ? 'launch-result-editor' : undefined}
            ref={editor}
            aria-label={label}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            onChange={e => onChange?.(e.target.value)}
            onPaste={e => {
              if (disabled || !onChange) return;
              const text = e.clipboardData.getData('text');
              if (!text) return;
              e.preventDefault();
              const start = e.currentTarget.selectionStart ?? value.length;
              const end = e.currentTarget.selectionEnd ?? start;
              onChange(value.slice(0, start) + text + value.slice(end));
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') setEditing(false);
            }}
          />
          {inlineEdit && editable && (
            <Button
              variant="ghost"
              size="sm"
              className="launch-result-edit"
              disabled={disabled}
              aria-label={t('launchesDone')}
              onClick={() => setEditing(false)}
            >
              <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </Button>
          )}
          {inlineEdit && openExternal && !invalid && (
            <a
              className="launch-result-external"
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('launchesOpenLink')}
              onClick={event => event.stopPropagation()}
            >
              <ExternalLink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </a>
          )}
        </div>
      ) : (
        <div
          className={`launch-result-value-actions${inlineEdit ? ' launch-result-inline-actions' : ''}`}
        >
          <Button
            ref={copyButton}
            variant="ghost"
            color="neutral"
            className="launch-result-value w-full justify-start text-left"
            aria-label={t('launchesCopyField', { field: label })}
            disabled={disabled || invalid}
            onClick={event => void copy(event.detail === 0)}
          >
            {campaignOrdinal && (
              <span className="launch-result-campaign-ordinal">{campaignOrdinal}</span>
            )}
            {campaignBudget && (
              <span className="launch-result-campaign-budget">{campaignBudget}</span>
            )}
            <span className="launch-result-text text-left">{value}</span>
          </Button>
          {inlineEdit && editable && (
            <Button
              variant="ghost"
              size="sm"
              className="launch-result-edit"
              disabled={disabled}
              aria-label={editing ? t('launchesDone') : t('launchesEditField', { field: label })}
              onClick={() => setEditing(v => !v)}
            >
              {editing ? (
                <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
            </Button>
          )}
          {openExternal && !invalid && (
            <a
              className="launch-result-external"
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('launchesOpenLink')}
              onClick={event => event.stopPropagation()}
            >
              <ExternalLink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {invalid && (
        <p role="alert" className="text-error-text">
          {t('launchesInvalid')}
        </p>
      )}
      {copied && (
        <span role="status" className="visually-hidden">
          {t('launchesCopied')}
        </span>
      )}
      {failed && (
        <div>
          <p role="alert" className="text-error-text">
            {t('launchesCopyFailed')}
          </p>
          <Textarea
            aria-label={label}
            value={value}
            readOnly
            onFocus={e => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
