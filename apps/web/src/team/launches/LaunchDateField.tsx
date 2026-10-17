import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { isLaunchTimezone, launchTomorrow } from '@video-compressor/shared';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import {
  Button,
  Calendar,
  FormField,
  IconButton,
  Popover,
  toCalendarDate
} from '../../components/ui/index';
import { useI18n } from '../../i18n';

export function launchShortcutDate(offset: 0 | 1, timezone: string, now = new Date()): string {
  // Calendar arithmetic, rather than 24 hours, also works across DST changes.
  return toCalendarDate(launchTomorrow(now, timezone))!
    .subtract({ days: 1 - offset })
    .toString();
}

export function LaunchDateField({
  value,
  timezone,
  disabled,
  error,
  onChange
}: {
  value?: string;
  timezone?: string;
  disabled?: boolean;
  error?: string;
  onChange: (date: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const zone = isLaunchTimezone(timezone)
    ? timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selected = toCalendarDate(value);
  const displayed = selected
    ? `${String(selected.day).padStart(2, '0')}.${String(selected.month).padStart(2, '0')}.${String(selected.year).slice(-2)}`
    : '—';
  const choose = (date: string) => {
    if (disabled) return;
    onChange(date);
    setOpen(false);
  };
  return (
    <FormField label={`${t('launchesDate')}: ${displayed}`} error={error}>
      <div className="launch-date-actions">
        <Button
          size="md"
          variant="outline"
          color={value === launchShortcutDate(0, zone) ? 'secondary' : 'neutral'}
          disabled={disabled}
          onClick={() => choose(launchShortcutDate(0, zone))}
        >
          {t('launchesToday')}
        </Button>
        <Button
          size="md"
          variant="outline"
          color={value === launchShortcutDate(1, zone) ? 'secondary' : 'neutral'}
          disabled={disabled}
          onClick={() => choose(launchShortcutDate(1, zone))}
        >
          {t('launchesTomorrow')}
        </Button>
        <IconButton
          ref={trigger}
          label={t('launchesChooseDate')}
          title=""
          size="md"
          variant="outline"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open && !disabled}
          onClick={() => setOpen(previous => !previous)}
        >
          <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        <Popover
          open={open && !disabled}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
          anchor={trigger}
          placement="bottom-end"
          className="launch-date-popover"
          label={t('launchesChooseDate')}
          frequent
        >
          <Calendar
            label={t('launchesChooseDate')}
            value={selected}
            onChange={date => {
              choose(date.toString());
              window.requestAnimationFrame(() => trigger.current?.focus());
            }}
          />
        </Popover>
      </div>
    </FormField>
  );
}
