import { useId, useRef, useState } from 'react';
import {
  LAUNCH_SUB_VARIABLES,
  type LaunchSubSlot,
  type LaunchSubVariable
} from '@video-compressor/shared';
import { Button, FormField, Popover } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
const labels: Record<LaunchSubVariable, TranslationKey> = {
  buyer: 'launchesBuyer',
  social: 'launchesSocial',
  adAccountSuffix: 'launchesSuffix',
  creative: 'launchesCreative'
};
const order = ['①', '②', '③', '④'];
export function SubBuilder({
  slot,
  selected,
  onChange,
  preview,
  submitted = false,
  disabled = false
}: {
  slot: LaunchSubSlot;
  selected: LaunchSubVariable[];
  onChange: (variables: LaunchSubVariable[]) => void;
  preview: string | null;
  submitted?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const changed = (variables: LaunchSubVariable[]) => {
    setTouched(true);
    onChange(variables);
  };
  const move = (index: number, delta: number) => {
    const next = [...selected];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    changed(next);
  };
  return (
    <FormField
      className="launch-sub-field"
      label={slot.toUpperCase()}
      htmlFor={id}
      error={
        selected.length && preview === null && (submitted || touched)
          ? t('launchesSubInvalid')
          : undefined
      }
    >
      <Button
        id={id}
        ref={anchor}
        variant="secondary"
        disabled={disabled}
        aria-label={slot.toUpperCase()}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        {selected.length
          ? selected.map((v, i) => `${order[i]} ${t(labels[v])}`).join(' · ')
          : t('launchesSelect')}
      </Button>
      <Popover
        open={open && !disabled}
        anchor={anchor}
        onClose={() => setOpen(false)}
        label={slot.toUpperCase()}
        frequent
      >
        <div className="flex flex-wrap gap-2">
          {LAUNCH_SUB_VARIABLES.map(variable => {
            const i = selected.indexOf(variable);
            return (
              <Button
                key={variable}
                color={i >= 0 ? 'primary' : 'neutral'}
                variant={i >= 0 ? 'soft' : 'ghost'}
                disabled={disabled}
                aria-pressed={i >= 0}
                onClick={() =>
                  changed(i >= 0 ? selected.filter(x => x !== variable) : [...selected, variable])
                }
              >
                {i >= 0 ? order[i] : ''} {t(labels[variable])}
              </Button>
            );
          })}
        </div>
        <div className="launch-sub-order-list flex flex-wrap gap-2">
          {selected.map((v, i) => (
            <div key={v} className="launch-sub-order-item inline-flex items-center gap-1">
              <span className="launch-sub-order-label">
                {order[i]} {t(labels[v])}
              </span>
              <div className="launch-sub-order-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || i === 0}
                  aria-label={t('launchesEarlier', { field: t(labels[v]) })}
                  onClick={() => move(i, -1)}
                >
                  ←
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || i === selected.length - 1}
                  aria-label={t('launchesLater', { field: t(labels[v]) })}
                  onClick={() => move(i, 1)}
                >
                  →
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Popover>
      <output aria-live="polite" className="launch-sub-preview text-label">
        {preview ??
          (selected.length && (submitted || touched)
            ? t('launchesRequired')
            : t('launchesPreserve'))}
      </output>
    </FormField>
  );
}
