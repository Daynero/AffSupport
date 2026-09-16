/**
 * The date a task is for, on the task.
 *
 * It reads as the date and nothing else — the day the task was created until
 * someone says otherwise — and a press opens the same calendar the board's
 * date filter uses. "Today" is one press for the commonest correction, and
 * "Day it was created" puts it back to the default rather than leaving an
 * unremovable value behind.
 */

import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { ICON_STROKE } from '../../components/icons';
import { useI18n, type Language } from '../../i18n';
import { dateFromValue } from './TaskDateFilter';
import { localDateValue } from './useTasks';
import { Calendar, Popover, fromCalendarDate, toCalendarDate } from '../../components/ui/index';

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
  const today = localDateValue(new Date());

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
      <Popover
        open={open}
        /* The calendar closes, the editor it sits in stays: the shared stack
           gives Escape to the innermost surface, which is this one. */
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        frequent
        label={t('teamTaskDateChoose')}
        className="task-date-filter-popover team-task-date-popover"
      >
        {/*
          * The inventory's calendar (024), which is React Aria's: it knows the
          * locale's first day of week, answers PageUp and Home, and has a year
          * jump. The 42 buttons this replaced were hand-built here and again in
          * the board's filter, and neither of them did any of that.
          */}
        <Calendar
          label={t('teamTaskDateChoose')}
          value={toCalendarDate(value)}
          onChange={next => choose(fromCalendarDate(next))}
        />
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
      </Popover>
    </div>
  );
}
