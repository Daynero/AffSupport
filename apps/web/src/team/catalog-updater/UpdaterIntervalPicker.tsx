import { useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { CatalogUpdaterInterval } from '../../api/team';
import { Button, Popover } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import { customIntervalFromHours, isUpdaterPreset, type UpdaterPreset } from './limits';

const PRESETS: ReadonlyArray<[UpdaterPreset, TranslationKey]> = [
  ['1h', 'catalogUpdaterEveryHour'],
  ['1d', 'catalogUpdaterEveryDay'],
  ['1w', 'catalogUpdaterEveryWeek']
];

/** "Every hour", "Every 6 h", "Off": what a catalog's schedule reads as, in a word or two. */
export function intervalLabel(
  interval: CatalogUpdaterInterval | null,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (interval === null) return t('catalogUpdaterOff');
  const preset = PRESETS.find(([value]) => value === interval);
  return preset ? t(preset[1]) : t('catalogUpdaterEveryHours', { count: interval.slice(0, -1) });
}

/**
 * How often one catalog — or the selected ones — updates (024).
 *
 * A trigger that says the schedule, and behind it the three presets, hours of one's own, and off.
 * Choosing is saving: there is no Start or Save to find afterwards, which is what a schedule per
 * row needs — forty rows with a Save each would be forty chances to forget one.
 */
export function UpdaterIntervalPicker({
  value,
  label,
  disabled,
  onChange
}: {
  value: CatalogUpdaterInterval | null;
  /** The accessible name: "How often <catalog> updates". */
  label: string;
  disabled?: boolean;
  onChange: (next: CatalogUpdaterInterval | null) => void;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLDivElement>(null);
  const hoursId = useId();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(
    value !== null && !isUpdaterPreset(value) ? value.slice(0, -1) : ''
  );
  const custom = customIntervalFromHours(hours);

  const choose = (next: CatalogUpdaterInterval | null) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div ref={anchor} className="team-updater-interval-picker">
      <Button
        type="button"
        size="sm"
        variant={value === null ? 'ghost' : 'secondary'}
        disabled={disabled}
        aria-label={`${label}: ${intervalLabel(value, t)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={value === null ? 'is-off' : undefined}
        onClick={() => setOpen(current => !current)}
      >
        {intervalLabel(value, t)}
        <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-end"
        frequent
        label={label}
        className="team-updater-interval-menu"
      >
        {PRESETS.map(([preset, key]) => (
          <button
            key={preset}
            type="button"
            className="team-updater-interval-option"
            aria-pressed={value === preset}
            onClick={() => choose(preset)}
          >
            <span className="team-updater-interval-mark" aria-hidden="true">
              {value === preset && <Check size={14} strokeWidth={ICON_STROKE} />}
            </span>
            {t(key)}
          </button>
        ))}
        <form
          className="team-updater-interval-custom"
          onSubmit={event => {
            event.preventDefault();
            if (custom) choose(custom);
          }}
        >
          <label htmlFor={hoursId}>{t('catalogUpdaterEvery')}</label>
          <input
            id={hoursId}
            className="time-input"
            type="text"
            inputMode="numeric"
            placeholder="6"
            value={hours}
            aria-invalid={hours !== '' && custom === null}
            aria-label={t('catalogUpdaterIntervalHours')}
            onChange={event => setHours(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))}
          />
          <span>{t('catalogUpdaterHoursUnit')}</span>
          <Button type="submit" size="sm" variant="secondary" disabled={custom === null}>
            {t('catalogUpdaterApply')}
          </Button>
        </form>
        {hours !== '' && custom === null && (
          <small className="soty-field-error">{t('catalogUpdaterIntervalInvalid')}</small>
        )}
        <button
          type="button"
          className="team-updater-interval-option is-off"
          aria-pressed={value === null}
          onClick={() => choose(null)}
        >
          <span className="team-updater-interval-mark" aria-hidden="true">
            {value === null && <Check size={14} strokeWidth={ICON_STROKE} />}
          </span>
          {t('catalogUpdaterOffLong')}
        </button>
      </Popover>
    </div>
  );
}
