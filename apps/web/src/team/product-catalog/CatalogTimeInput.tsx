import { Input, type InputProps } from '../../components/ui/index';

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
  return (
    <Input
      {...props}
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
  );
}
