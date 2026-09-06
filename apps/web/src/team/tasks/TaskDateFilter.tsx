import { useEffect, useMemo, useRef, useState } from 'react';
import type { TeamTaskStatus } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { TaskStatusIcon, taskStatusLabel } from './TaskStatusControl';
import { localDateValue, type TaskDateFilter, type TaskStatusFilter } from './useTasks';

/**
 * The day-grid helpers, shared with the task editor's own date field: one
 * calendar in the product, not two that drift apart.
 *
 * Noon rather than midnight: `new Date('2026-09-05')` is UTC midnight, which
 * is the day before in every timezone west of Greenwich.
 */
export function dateFromValue(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

/** Six weeks from the Monday on or before the 1st: a stable grid. */
export function monthDays(month: Date): Date[] {
  const first = monthStart(month);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const value = new Date(start);
    value.setDate(start.getDate() + index);
    return value;
  });
}

function isInRange(value: string, filter: TaskDateFilter): boolean {
  if (filter.kind !== 'range') return false;
  const from = filter.from <= filter.to ? filter.from : filter.to;
  const to = filter.from <= filter.to ? filter.to : filter.from;
  return value >= from && value <= to;
}

function formatSelectedDate(language: 'en' | 'uk', filter: TaskDateFilter): string {
  if (filter.kind === 'all') return '';
  const formatter = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    day: 'numeric',
    month: 'short'
  });
  const from = formatter.format(dateFromValue(filter.from));
  const to = formatter.format(dateFromValue(filter.to));
  return filter.from === filter.to ? from : `${from} – ${to}`;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect
        x="3.2"
        y="4.5"
        width="13.6"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M6.5 2.9v3.3M13.5 2.9v3.3M3.5 8.3h13"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
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

/** Monday-first initials, as the calendar's header row. */
export function calendarWeekdays(language: 'en' | 'uk'): string[] {
  return language === 'uk'
    ? ['П', 'В', 'С', 'Ч', 'П', 'С', 'Н']
    : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
}

const statuses: readonly TaskStatusFilter[] = ['todo', 'in_progress', 'done', 'all'];

/**
 * The ranges people actually ask for, one press each. The calendar answers
 * everything else, but reaching it for "today" was four interactions for the
 * commonest question there is.
 */
type QuickRange = 'today' | 'yesterday' | 'month' | 'all';

function quickRangeValue(range: Exclude<QuickRange, 'all'>, now: Date): TaskDateFilter {
  if (range === 'today') {
    const today = localDateValue(now);
    return { kind: 'range', from: today, to: today };
  }
  if (range === 'yesterday') {
    const yesterday = localDateValue(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
    );
    return { kind: 'range', from: yesterday, to: yesterday };
  }
  // The whole month, first to last: a task can be dated ahead of today (017),
  // and "This month" that stopped at today would hide the half of the month a
  // person plans in.
  return {
    kind: 'range',
    from: localDateValue(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
    to: localDateValue(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12))
  };
}

function activeQuickRange(value: TaskDateFilter, now: Date): QuickRange | null {
  if (value.kind === 'all') return 'all';
  for (const range of ['today', 'yesterday', 'month'] as const) {
    const candidate = quickRangeValue(range, now);
    if (candidate.kind === 'range' && candidate.from === value.from && candidate.to === value.to) {
      return range;
    }
  }
  return null;
}

export function TaskDateFilterControl({
  value,
  onChange,
  status,
  onStatusChange,
  children
}: {
  value: TaskDateFilter;
  onChange: (value: TaskDateFilter) => void;
  status: TaskStatusFilter;
  onStatusChange: (value: TaskStatusFilter) => void;
  /** A further filter that shares the row — the account scope (017). */
  children?: React.ReactNode;
}) {
  const { language, t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const selectedLabel = useMemo(() => formatSelectedDate(language, value), [language, value]);
  const days = useMemo(() => monthDays(month), [month]);
  const weekdays = calendarWeekdays(language);
  const today = localDateValue(new Date());

  useEffect(() => {
    const selected = value.kind === 'range' ? value.to : null;
    if (selected) setMonth(monthStart(dateFromValue(selected)));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setPendingStart(null);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (date: string, single = false) => {
    if (single) {
      onChange({ kind: 'range', from: date, to: date });
      setPendingStart(null);
      setOpen(false);
      return;
    }
    if (!pendingStart) {
      setPendingStart(date);
      return;
    }
    onChange({ kind: 'range', from: pendingStart, to: date });
    setPendingStart(null);
    setOpen(false);
  };

  const now = new Date();
  const quick = activeQuickRange(value, now);
  const quickRanges: ReadonlyArray<{ range: QuickRange; label: string }> = [
    { range: 'today', label: t('teamTasksToday') },
    { range: 'yesterday', label: t('teamTasksYesterday') },
    { range: 'month', label: t('teamTasksThisMonth') },
    { range: 'all', label: t('teamTasksAllTime') }
  ];

  return (
    <div className="task-date-filter" aria-label={t('teamTasksDateFilter')}>
      <div className="task-quick-ranges">
        {quickRanges.map(option => (
          <button
            key={option.range}
            type="button"
            className={`task-quick-range ${quick === option.range ? 'is-active' : ''}`.trim()}
            aria-pressed={quick === option.range}
            onClick={() => {
              setPendingStart(null);
              setOpen(false);
              onChange(
                option.range === 'all' ? { kind: 'all' } : quickRangeValue(option.range, new Date())
              );
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div ref={root} className="task-date-filter-calendar">
        <button
          type="button"
          className={`task-date-filter-trigger ${value.kind !== 'all' ? 'is-active' : ''}`.trim()}
          aria-label={t('teamTasksCalendarOpen')}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          <CalendarIcon />
          {selectedLabel && <span>{selectedLabel}</span>}
        </button>
        {value.kind !== 'all' && (
          <button
            type="button"
            className="task-date-filter-clear"
            aria-label={t('teamTasksCalendarClear')}
            onClick={() => {
              onChange({ kind: 'all' });
              setPendingStart(null);
            }}
          >
            ×
          </button>
        )}
        {open && (
          <div
            className="task-date-filter-popover"
            role="dialog"
            aria-label={t('teamTasksCalendar')}
          >
            <div className="task-calendar-heading">
              <button
                type="button"
                aria-label={t('teamTasksCalendarPreviousMonth')}
                onClick={() =>
                  setMonth(
                    current => new Date(current.getFullYear(), current.getMonth() - 1, 1, 12)
                  )
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
                  setMonth(
                    current => new Date(current.getFullYear(), current.getMonth() + 1, 1, 12)
                  )
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
                const selected = isInRange(date, value);
                const pending = pendingStart === date;
                return (
                  <button
                    key={date}
                    type="button"
                    className={`${inMonth ? '' : 'is-outside'} ${selected ? 'is-selected' : ''} ${pending ? 'is-pending' : ''} ${date === today ? 'is-today' : ''}`.trim()}
                    aria-label={date}
                    aria-pressed={selected || pending}
                    onClick={event => {
                      if (event.detail !== 2) choose(date);
                    }}
                    onDoubleClick={() => choose(date, true)}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
            <p>
              {pendingStart ? t('teamTasksCalendarChooseEnd') : t('teamTasksCalendarChooseStart')}
            </p>
          </div>
        )}
      </div>
      {children}
      <div className="task-status-filter" aria-label={t('teamTaskStatus')}>
        {statuses.map(option => {
          const label = option === 'all' ? t('teamTaskStatusAll') : taskStatusLabel(option, t);
          return (
            <button
              key={option}
              type="button"
              className={`task-status-filter-option ${option === 'all' ? 'is-all' : `is-${option}`} ${status === option ? 'is-active' : ''}`.trim()}
              aria-pressed={status === option}
              onClick={() => onStatusChange(option)}
            >
              {option !== 'all' && <TaskStatusIcon status={option as TeamTaskStatus} />}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
