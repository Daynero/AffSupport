import { useContext, useMemo, useRef, useState } from 'react';
import { RangeCalendarStateContext } from 'react-aria-components/RangeCalendar';
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

/**
 * The chip's label, as short as the range honestly allows.
 *
 * The locale's own range formatter knows what to leave out: a range inside one
 * month says the month once ("16–18 вер.", "Sep 16 – 18"), a range across two
 * months names both ("28 серп. – 3 вер."), and a single day is just the day.
 * Spelling both ends in full made every chip a sentence, and the × had nowhere
 * left to sit.
 */
function formatSelectedDate(language: 'en' | 'uk', filter: TaskDateFilter): string {
  if (filter.kind === 'all') return '';
  const formatter = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    day: 'numeric',
    month: 'short'
  });
  const from = dateFromValue(filter.from <= filter.to ? filter.from : filter.to);
  const to = dateFromValue(filter.from <= filter.to ? filter.to : filter.from);
  if (filter.from === filter.to) return formatter.format(from);
  return formatter.formatRange(from, to);
}

/**
 * What the calendar is waiting for, under its grid.
 *
 * React Aria's range calendar works click–click: after the first day the
 * highlight follows the pointer until the second, which reads as "the selection
 * is stuck to my mouse" unless the calendar says that it is now asking for the
 * end. The state is read from the calendar's own context, so the hint changes
 * the moment the anchor is set. With a finished range the hint repeats the
 * range, which is what the chip says as well.
 */
function RangeHint({ selectedLabel }: { selectedLabel: string }) {
  const { t } = useI18n();
  const state = useContext(RangeCalendarStateContext);
  const text = state?.anchorDate
    ? t('teamTasksCalendarChooseEnd')
    : selectedLabel || t('teamTasksCalendarChooseStart');
  return (
    <p className="task-calendar-hint" aria-live="polite">
      {text}
    </p>
  );
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
      {/*
       * One pill, two buttons (024): the wrapper draws the chip — outline,
       * fill, the selected accent — and the trigger and the × inside it draw
       * nothing of their own. They used to be two chrome-bearing buttons with
       * the × pulled back over the trigger by a negative margin, and the mark
       * landed on the last letters of the label.
       */}
      <div
        ref={root}
        className={`task-date-filter-calendar ${value.kind !== 'all' ? 'is-active' : ''}`.trim()}
      >
        <button
          type="button"
          className="task-date-filter-trigger"
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
           *
           * A finished range closes the popover, the way Linear's date filter
           * does: the second click is the answer, and a calendar that stays
           * open over a board re-rendering behind it reads as lag. The first
           * click keeps it open — the calendar is still asking.
           */}
          <RangeCalendar
            label={t('teamTasksCalendar')}
            value={range}
            onChange={next => {
              setOpen(false);
              onChange({
                kind: 'range',
                from: fromCalendarDate(next.start) ?? '',
                to: fromCalendarDate(next.end) ?? ''
              });
            }}
            footer={
              <>
                {/* The four ranges anybody actually asks for, as presets under
                    the grid rather than four more buttons in the row (024,
                    FR-077). A board is filtered by "today" far more often than
                    by a range somebody picks out by hand. */}
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
                          option.range === 'all'
                            ? { kind: 'all' }
                            : quickRangeValue(option.range, new Date())
                        );
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <RangeHint selectedLabel={selectedLabel} />
              </>
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
