import { useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { IconButton, Input, Popover, TimeWheel, type InputProps } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/**
 * `930` → `09:30`, `9:5` stays as typed, `14:30` stays. Only a time that can be read without
 * guessing is rewritten; anything else is left for the form's own check to name.
 */
export function normalizeCatalogTime(raw: string): string {
  const text = raw.trim();
  const separated = /^(\d{1,2}):(\d{2})$/u.exec(text);
  if (separated) return `${separated[1]!.padStart(2, '0')}:${separated[2]}`;
  const digits = /^\d{3,4}$/u.exec(text);
  if (digits) {
    const padded = text.padStart(4, '0');
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return text;
}

/**
 * A time of day as `HH:MM`, always on a 24-hour clock (1.4.3).
 *
 * The native `type="time"` field follows the browser's locale, not the app's: a Ukrainian team on
 * an English browser was asked for "02:00 PM". The value on the wire is the same `HH:MM` string.
 */
export function CatalogTimeInput({
  value,
  onChange,
  ...props
}: Omit<InputProps, 'type' | 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="catalog-time-input">
      <Input
        {...props}
        trailing={
          <IconButton
            ref={anchor}
            variant="ghost"
            size="sm"
            title=""
            label={t('catalogTimeChoose')}
            disabled={props.disabled}
            aria-haspopup="dialog"
            aria-expanded={open && !props.disabled}
            onClick={() => setOpen(previous => !previous)}
          >
            <Clock3 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        }
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder="18:00"
        value={value}
        onChange={event => onChange(event.target.value.replace(/[^\d:]/gu, ''))}
        onBlur={event => {
          const normalized = normalizeCatalogTime(event.target.value);
          if (normalized !== event.target.value) onChange(normalized);
          props.onBlur?.(event);
        }}
      />
      <Popover
        open={open && !props.disabled}
        onClose={() => {
          setOpen(false);
          anchor.current?.focus();
        }}
        anchor={anchor}
        placement="bottom-start"
        label={t('catalogTimeChoose')}
        initialFocus='[role="listbox"]'
        frequent
      >
        <TimeWheel
          value={normalizeCatalogTime(value)}
          onChange={onChange}
          hoursLabel={t('catalogTimeHours')}
          minutesLabel={t('catalogTimeMinutes')}
        />
      </Popover>
    </div>
  );
}
