import {
  FormField,
  RestitchDurationControl,
  type RestitchDurationValue
} from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';

/**
 * The stitch duration, open, with the chosen value in its name.
 *
 * It used to sit behind a disclosure, squeezed under the re-stitch switch. The launch
 * editor now gives it the half of the catalog shelf the switches leave empty, so it is
 * shown open and wide enough to set by hand (next QA 2026-11-21).
 */
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
    <FormField
      className="launch-duration-open"
      label={`${t('launchSettingsDuration')} · ${summary} ${t('launchesMinutesShort')}`}
      error={error}
    >
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
    </FormField>
  );
}
