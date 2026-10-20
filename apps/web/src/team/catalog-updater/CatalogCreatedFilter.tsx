import { useMemo, useRef, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  Popover,
  RangeCalendar,
  fromCalendarDate,
  toCalendarDate
} from '../../components/ui/index';
import { useI18n } from '../../i18n';

/** Inclusive local calendar dates; an empty bound leaves that end unrestricted. */
export interface CatalogCreatedRange {
  from: string;
  to: string;
}

export function CatalogCreatedFilter({
  value,
  onChange
}: {
  value: CatalogCreatedRange;
  onChange: (value: CatalogCreatedRange) => void;
}) {
  const { t, language } = useI18n();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = Boolean(value.from || value.to);
  const range = useMemo(() => {
    const start = toCalendarDate(value.from);
    const end = toCalendarDate(value.to);
    return start && end
      ? start.compare(end) <= 0
        ? { start, end }
        : { start: end, end: start }
      : null;
  }, [value.from, value.to]);
  const formatter = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  const format = (day: string) => formatter.format(new Date(`${day}T12:00:00`));
  const selectedLabel =
    value.from && value.to
      ? value.from === value.to
        ? format(value.from)
        : formatter.formatRange(
            new Date(`${value.from < value.to ? value.from : value.to}T12:00:00`),
            new Date(`${value.from < value.to ? value.to : value.from}T12:00:00`)
          )
      : value.from
        ? t('catalogCreatedAfter', { date: format(value.from) })
        : value.to
          ? t('catalogCreatedBefore', { date: format(value.to) })
          : '';

  return (
    <div ref={anchor} className={`task-date-filter-calendar ${active ? 'is-active' : ''}`.trim()}>
      <button
        type="button"
        className="task-date-filter-trigger"
        aria-label={`${t('catalogCreatedFilter')}${selectedLabel ? `: ${selectedLabel}` : ''}`}
        title={t('catalogCreatedFilter')}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {selectedLabel && <span>{selectedLabel}</span>}
      </button>
      {active && (
        <button
          type="button"
          className="task-date-filter-clear"
          aria-label={t('catalogCreatedClear')}
          onClick={() => onChange({ from: '', to: '' })}
        >
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      )}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        frequent
        label={t('catalogCreatedFilter')}
        className="task-date-filter-popover"
      >
        <RangeCalendar
          label={t('catalogCreatedChooseRange')}
          value={range}
          onChange={next => {
            onChange({
              from: fromCalendarDate(next.start) ?? '',
              to: fromCalendarDate(next.end) ?? ''
            });
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
}
