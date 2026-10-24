import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import {
  Button,
  Calendar,
  Popover,
  fromCalendarDate,
  toCalendarDate
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { formatTariffDay } from '../../team/tariffs/format';
import { kyivToday } from './tariffModel';

/**
 * The last day of a term, picked on the product's one calendar (024).
 *
 * Days before today cannot be chosen — the server refuses them with
 * `TARIFF_DATE_INVALID` (US1.4), and a calendar that offers what will be
 * refused is a form that fails on submit for no visible reason.
 */
export function TariffDateField({
  value,
  onChange,
  tariffToday,
  label
}: {
  value: string | null;
  tariffToday?: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { t, language } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const minValue = toCalendarDate(tariffToday ?? kyivToday()) ?? undefined;

  return (
    <>
      <Button
        ref={anchor}
        color="neutral"
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${label}: ${formatTariffDay(value, language, tariffToday)}` : label}
        leading={<CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(current => !current)}
      >
        {value ? formatTariffDay(value, language, tariffToday) : t('adminTariffPickDate')}
      </Button>
      <Popover
        initialFocus='[role="grid"] [tabindex="0"]'
        open={open}
        onClose={() => {
          setOpen(false);
          anchor.current?.focus();
        }}
        anchor={anchor}
        placement="bottom-start"
        className="ui-calendar-popover"
        frequent
        label={label}
      >
        <Calendar
          label={label}
          value={toCalendarDate(value)}
          minValue={minValue}
          onChange={next => {
            const day = fromCalendarDate(next);
            if (day) onChange(day);
            setOpen(false);
            anchor.current?.focus();
          }}
        />
      </Popover>
    </>
  );
}
