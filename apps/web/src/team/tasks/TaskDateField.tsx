/**
 * The date a task is for, on the task.
 *
 * It reads as the date and nothing else — the day the task was created until
 * someone says otherwise — and a press opens the same calendar the board's
 * date filter uses. "Today" is one press for the commonest correction, and
 * "Day it was created" puts it back to the default rather than leaving an
 * unremovable value behind.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';
import { useI18n, type Language } from '../../i18n';
import { calendarWeekdays, dateFromValue, monthDays, monthStart } from './TaskDateFilter';
import { localDateValue } from './useTasks';

/** "5 вер. 2026" from a `YYYY-MM-DD` day, or the whole date written out. */
export function formatTaskDate(language: Language, value: string, full = false): string {
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  const date = dateFromValue(value);
  if (full) return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date);
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'm11.8 4.5-5 5.5 5 5.5' : 'm8.2 4.5 5 5.5-5 5.5'}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function TaskDateField({
  /** The day the task is for, resolved: its own date, or the day it was created. */
  value,
  /** True when that date is the task's own rather than the creation default. */
  isCustom,
  createdOn,
  disabled = false,
  onChange
}: {
  value: string;
  isCustom: boolean;
  createdOn: string;
  disabled?: boolean;
  /** A day, or null to fall back to the creation date. */
  onChange: (value: string | null) => void;
}) {
  const { t, language } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthStart(dateFromValue(value)));
  const days = useMemo(() => monthDays(month), [month]);
  const today = localDateValue(new Date());
  const weekdays = calendarWeekdays(language);

  // Reopening lands on the month of the date that is set, not where the last
  // browse left off.
  useEffect(() => {
    if (open) setMonth(monthStart(dateFromValue(value)));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Ours, not the dialog's: the calendar closes, the editor stays.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div className="team-task-date-field" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`team-task-date-trigger${isCustom ? ' is-custom' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('teamTaskDateLabel')}: ${formatTaskDate(language, value, true)}`}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
      >
        <CalendarDays size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {formatTaskDate(language, value)}
      </button>
      {open && (
        <div
          className="task-date-filter-popover team-task-date-popover"
          role="dialog"
          aria-label={t('teamTaskDateChoose')}
        >
          <div className="task-calendar-heading">
            <button
              type="button"
              aria-label={t('teamTasksCalendarPreviousMonth')}
              onClick={() =>
                setMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1, 12))
              }
            >
              <Chevron direction="left" />
            </button>
            <strong>
              {new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
                month: 'long',
                year: 'numeric'
              }).format(month)}
            </strong>
            <button
              type="button"
              aria-label={t('teamTasksCalendarNextMonth')}
              onClick={() =>
                setMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1, 12))
              }
            >
              <Chevron direction="right" />
            </button>
          </div>
          <div className="task-calendar-weekdays" aria-hidden="true">
            {weekdays.map((day, index) => (
              <span key={`${day}-${index}`}>{day}</span>
            ))}
          </div>
          <div className="task-calendar-days">
            {days.map(day => {
              const date = localDateValue(day);
              const inMonth = day.getMonth() === month.getMonth();
              const selected = date === value;
              return (
                <button
                  key={date}
                  type="button"
                  className={`${inMonth ? '' : 'is-outside'} ${selected ? 'is-selected' : ''} ${
                    date === today ? 'is-today' : ''
                  }`.trim()}
                  aria-label={date}
                  aria-pressed={selected}
                  onClick={() => choose(date)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <div className="team-task-date-actions">
            <button type="button" onClick={() => choose(today)}>
              {t('teamTasksToday')}
            </button>
            {isCustom && (
              <button type="button" onClick={() => choose(null)}>
                {t('teamTaskDateReset', { date: formatTaskDate(language, createdOn) })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
