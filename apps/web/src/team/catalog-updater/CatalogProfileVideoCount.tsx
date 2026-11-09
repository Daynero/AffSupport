import { useEffect, useRef, useState } from 'react';
import { Button, FormField, Input } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
export function CatalogProfileVideoCount({
  value,
  productCount,
  disabled,
  onSave
}: {
  value: number;
  productCount: number;
  disabled: boolean;
  onSave(value: number): Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value)),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const base = useRef(value),
    mounted = useRef(true),
    locked = useRef(false);
  const dirty = draft !== String(base.current),
    conflict = dirty && value !== base.current;
  useEffect(() => {
    if (!dirty) {
      base.current = value;
      setDraft(String(value));
    }
  }, [value, dirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const n = Number(draft),
    invalid = draft !== '' && (!Number.isSafeInteger(n) || n < 1 || n > productCount);
  const reset = () => {
    base.current = value;
    setDraft(String(value));
    setError(null);
  };
  const save = async () => {
    if (locked.current || disabled || !dirty || conflict || !draft || invalid) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      await onSave(n);
      if (mounted.current) {
        base.current = n;
        setDraft(String(n));
      }
    } catch (cause) {
      if (mounted.current) setError(teamErrorMessageFor(cause, t));
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <div className="team-updater-filter-field">
      <FormField
        label={t('catalogVideoVariationCount')}
        error={
          conflict
            ? t('catalogUpdaterProfileConflict')
            : invalid
              ? t('catalogVideoVariationLimit', { count: productCount })
              : (error ?? undefined)
        }
      >
        <Input
          aria-label={t('catalogVideoVariationCount')}
          width="narrow"
          inputMode="numeric"
          value={draft}
          disabled={disabled || pending}
          onChange={event => {
            if (!dirty) base.current = value;
            setDraft(event.target.value.replace(/[^\d]/gu, '').slice(0, 3));
            setError(null);
          }}
        />
      </FormField>
      <p className="field-hint">{t('catalogVideoCountFuture')}</p>
      {dirty && (
        <>
          <Button
            size="sm"
            disabled={disabled || pending || conflict || invalid || draft === ''}
            onClick={() => void save()}
          >
            {t('catalogUpdaterSaveProfile')}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
            {t('catalogUpdaterBulkKeep')}
          </Button>
        </>
      )}
    </div>
  );
}
