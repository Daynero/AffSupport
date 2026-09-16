import { useMemo, useRef, useState } from 'react';
import type { TeamTaskStatus } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { TaskStatusIcon, taskStatusLabel } from './TaskStatusControl';
import {
  activeQuickRange,
  quickRangeValue,
  type QuickRange,
  type TaskDateFilter,
  type TaskStatusFilter
} from './useTasks';
import {
  Popover,
  RangeCalendar,
  fromCalendarDate,
  toCalendarDate
} from '../../components/ui/index';

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

const statuses: readonly TaskStatusFilter[] = ['todo', 'in_progress', 'done', 'all'];

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
  const selectedLabel = useMemo(() => formatSelectedDate(language, value), [language, value]);

  /**
   * The range, as the calendar holds it.
   *
   * `all` has no range, and React Aria wants null rather than a pair of
   * nothings.
   */
  const range = useMemo(() => {
    if (value.kind !== 'range') return null;
    const start = toCalendarDate(value.from <= value.to ? value.from : value.to);
    const end = toCalendarDate(value.from <= value.to ? value.to : value.from);
    return start && end ? { start, end } : null;
  }, [value]);

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
            onClick={() => onChange({ kind: 'all' })}
          >
            ×
          </button>
        )}
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchor={root}
          placement="bottom-start"
          frequent
          label={t('teamTasksCalendar')}
          className="task-date-filter-popover"
        >
          {/*
            * The inventory's range calendar (024). The 42 buttons it replaces
            * were written twice, here and on the task's own date field, and
            * neither copy knew the locale's first day of week, had a year jump
            * or answered PageUp.
            *
            * A half-made range is kept, not abandoned (021 finding B4, closed):
            * React Aria commits only a finished range, and the popover no
            * longer throws away the first day when it closes — the person who
            * picked it meant to.
            */}
          <RangeCalendar
            label={t('teamTasksCalendar')}
            value={range}
            onChange={next =>
              onChange({
                kind: 'range',
                from: fromCalendarDate(next.start) ?? '',
                to: fromCalendarDate(next.end) ?? ''
              })
            }
            footer={
              <p className="task-calendar-hint">{t('teamTasksCalendarChooseStart')}</p>
            }
          />
        </Popover>
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
