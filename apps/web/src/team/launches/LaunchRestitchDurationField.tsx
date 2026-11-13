import { useEffect, useId, useState } from 'react';
import {
  Accordion,
  FormField,
  RestitchDurationControl,
  type RestitchDurationValue
} from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';

/** Keep the chosen duration visible; the full shared editor opens at its value. */
export function LaunchRestitchDurationField({
  value,
  onChange,
  disabled,
  error
}: {
  value: RestitchDurationValue;
  onChange: (value: RestitchDurationValue) => void;
  disabled: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (error && !disabled) setOpen(true);
  }, [error, disabled]);
  const minutes = Math.round((value.customFinalDurationSeconds ?? 1800) / 60);
  const range = value.finalDurationRangeSeconds;
  const summary =
    value.finalDurationMode === 'custom'
      ? String(minutes)
      : value.finalDurationMode === 'random-centered'
        ? `${range ? range[0] / 60 : Math.max(1, minutes - 5)}–${range ? range[1] / 60 : Math.min(60, minutes + 5)}`
        : value.finalDurationMode === 'random-50-60'
          ? '50–60'
          : value.finalDurationMode === 'random-40-50'
            ? '40–50'
            : '30–40';
  return (
    <FormField className="launch-duration-disclosure" error={error}>
      <Accordion
        openIds={open ? new Set([id]) : new Set()}
        onToggle={() => setOpen(current => !current)}
        items={[
          {
            id,
            title: `${t('launchSettingsDuration')} · ${summary} ${t('launchesMinutesShort')}`,
            content: (
              <RestitchDurationControl
                value={value}
                disabled={disabled}
                labels={{
                  duration: t('launchesDuration'),
                  range: t('launchesDurationRange'),
                  exact: t('launchesDurationExact'),
                  unit: t('launchesMinutesShort')
                }}
                onChange={onChange}
              />
            )
          }
        ]}
      />
    </FormField>
  );
}
