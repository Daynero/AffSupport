import { useContext, useMemo, useRef, useState } from 'react';
import { RangeCalendarStateContext } from 'react-aria-components/RangeCalendar';
import { CalendarDays, X } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
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
  Button,
  IconButton,
  Popover,
  RangeCalendar,
  SegmentedControl,
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
  return <CalendarDays size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />;
}

const statuses: readonly TaskStatusFilter[] = ['todo', 'in_progress', 'done', 'all'];

export function TaskDateFilterControl({
  value,
  onChange,
  status,
  onStatusChange,
  showStatus = true,
  allowAll = true,
  disabled = false,
  calendarLabel,
  inlineDays = false,
  inlineTomorrow = false,
  size = 'md',
  children
}: {
  value: TaskDateFilter;
  onChange: (value: TaskDateFilter) => void;
  status: TaskStatusFilter;
  onStatusChange: (value: TaskStatusFilter) => void;
  showStatus?: boolean;
  allowAll?: boolean;
  disabled?: boolean;
  calendarLabel?: string;
  /** "Yesterday" and "Today" beside the calendar, one press each — the board's two most asked ranges. */
  inlineDays?: boolean;
  /** Include tomorrow after today for planning upcoming launches. */
  inlineTomorrow?: boolean;
  /**
   * The row's controls at the statuses' step (070, phase 9ж): on the boards they sit beside the
   * small segmented statuses, and at `md` they were a step larger and bolder than their
   * neighbours. Accounts keeps `md`, beside its own `md` presets.
   */
  size?: 'sm' | 'md';
  /** A further filter that shares the row — the account scope (017). */
  children?: React.ReactNode;
}) {
  const { language, t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeCalendar = () => {
    setOpen(false);
    trigger.current?.focus();
  };
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
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowRange = quickRangeValue('today', tomorrow);
  const tomorrowActive =
    value.kind === 'range' &&
    tomorrowRange.kind === 'range' &&
    value.from === tomorrowRange.from &&
    value.to === tomorrowRange.to;

  const quickRanges: ReadonlyArray<{ range: QuickRange; label: string }> = [
    { range: 'today', label: t('teamTasksToday') },
    { range: 'yesterday', label: t('teamTasksYesterday') },
    { range: 'month', label: t('teamTasksThisMonth') },
    { range: 'all', label: t('teamTasksAllTime') }
  ];

  /** The popover's presets in the order a week is read: yesterday, today, tomorrow, then wider. */
  const presets: ReadonlyArray<{ range: QuickRange | 'tomorrow'; label: string; on: boolean }> = [
    { range: 'yesterday', label: t('teamTasksYesterday'), on: quick === 'yesterday' },
    { range: 'today', label: t('teamTasksToday'), on: quick === 'today' },
    ...(inlineTomorrow
      ? [{ range: 'tomorrow' as const, label: t('teamTasksTomorrow'), on: tomorrowActive }]
      : []),
    { range: 'month', label: t('teamTasksThisMonth'), on: quick === 'month' },
    ...(allowAll
      ? [{ range: 'all' as const, label: t('teamTasksAllTime'), on: quick === 'all' }]
      : [])
  ];
  /** A day that is on reads as pressed: the inventory's soft accent, the rest ghosts. */
  const toggleLook = (on: boolean) =>
    on ? ({ variant: 'soft', color: 'secondary' } as const) : ({ variant: 'ghost' } as const);
  const pickPreset = (range: QuickRange | 'tomorrow') => {
    closeCalendar();
    if (range === 'all') onChange({ kind: 'all' });
    else if (range === 'tomorrow') {
      const next = new Date();
      next.setDate(next.getDate() + 1);
      onChange(quickRangeValue('today', next));
    } else onChange(quickRangeValue(range, new Date()));
  };

  return (
    <div
      className={`task-date-filter${size === 'sm' ? ' is-sm' : ''}`}
      aria-label={t('teamTasksDateFilter')}
    >
      {/*
       * One chip (024), now two inventory controls (070, T079): the trigger says "Дата" until a
       * range is on and the range once it is — a calendar glyph alone read as decoration, and on
       * a phone it stood on a row of its own. With a range on, the × sits inside the chip.
       */}
      <div
        ref={root}
        className={`task-date-filter-calendar ${value.kind !== 'all' ? 'is-active' : ''}`.trim()}
      >
        <Button
          ref={trigger}
          size={size}
          variant="ghost"
          color={value.kind !== 'all' ? 'secondary' : 'neutral'}
          className="task-date-filter-trigger"
          aria-label={calendarLabel ?? t('teamTasksCalendarOpen')}
          title={selectedLabel || t('teamTasksCalendar')}
          disabled={disabled}
          aria-expanded={open}
          leading={<CalendarIcon />}
          onClick={() => setOpen(current => !current)}
        >
          <span className={selectedLabel ? undefined : 'task-date-filter-word'}>
            {selectedLabel || t('teamTasksCalendar')}
          </span>
        </Button>
        {allowAll && value.kind !== 'all' && (
          <IconButton
            size="xs"
            className="task-date-filter-clear"
            label={t('teamTasksCalendarClear')}
            onClick={() => onChange({ kind: 'all' })}
          >
            <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        )}
        <Popover
          initialFocus='[role="grid"] [tabindex="0"]'
          open={open}
          onClose={() => closeCalendar()}
          anchor={root}
          placement="bottom-start"
          frequent
          label={t('teamTasksCalendar')}
          className="task-date-filter-popover"
        >
          {/*
           * The inventory's range calendar (024). A half-made range is kept, not abandoned (021
           * finding B4): React Aria commits only a finished range, and the popover no longer
           * throws away the first day when it closes. A finished range closes the popover, the
           * way Linear's date filter does; the first click keeps it open.
           */}
          {/* The ranges anybody actually asks for, as presets (024, FR-077) — above the grid
              (070, T080): on a phone the row's own "Вчора / Сьогодні / Завтра" fold in here, and
              under a month that fills the screen they were out of sight. */}
          <div className="task-quick-ranges">
            {presets.map(preset => (
              <Button
                key={preset.range}
                size="sm"
                {...toggleLook(preset.on)}
                className="task-date-preset"
                aria-pressed={preset.on}
                onClick={() => pickPreset(preset.range)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <RangeCalendar
            label={t('teamTasksCalendar')}
            value={range}
            onChange={next => {
              closeCalendar();
              onChange({
                kind: 'range',
                from: fromCalendarDate(next.start) ?? '',
                to: fromCalendarDate(next.end) ?? ''
              });
            }}
            footer={<RangeHint selectedLabel={selectedLabel} />}
          />
        </Popover>
      </div>
      {/* After the calendar, the way the owner reads the row: the date first, then the two
          shortcuts. The chip's label is set in tabular figures and "Вчора"/"Сьогодні" only ever
          swap one day for its neighbour, so the buttons stay under the pointer between presses. */}
      {inlineDays && (
        <div className="task-date-filter-days">
          {quickRanges
            .filter(
              (option): option is typeof option & { range: 'yesterday' | 'today' } =>
                option.range === 'yesterday' || option.range === 'today'
            )
            .reverse()
            .map(option => (
              <Button
                key={option.range}
                size={size}
                {...toggleLook(quick === option.range)}
                className="task-date-day"
                aria-pressed={quick === option.range}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    quick === option.range && allowAll
                      ? { kind: 'all' }
                      : quickRangeValue(option.range, new Date())
                  )
                }
              >
                {option.label}
              </Button>
            ))}
          {inlineTomorrow && (
            <Button
              size={size}
              {...toggleLook(tomorrowActive)}
              className="task-date-day"
              aria-pressed={tomorrowActive}
              disabled={disabled}
              onClick={() => {
                const next = new Date();
                next.setDate(next.getDate() + 1);
                onChange(
                  tomorrowActive && allowAll ? { kind: 'all' } : quickRangeValue('today', next)
                );
              }}
            >
              {t('teamTasksTomorrow')}
            </Button>
          )}
        </div>
      )}
      {children}
      {showStatus && (
        /* One of four, so the inventory's segmented control (070, T079): the glyph always, the
           word where there is room — on a phone the three statuses are their glyphs, named by
           their hint, and "Всі" stays a word. */
        <SegmentedControl<TaskStatusFilter>
          className="task-status-filter"
          size="sm"
          label={t('teamTaskStatus')}
          value={status}
          onChange={onStatusChange}
          options={statuses.map(option => {
            if (option === 'all') return { value: option, label: t('teamTaskStatusAll') };
            const label = taskStatusLabel(option as TeamTaskStatus, t);
            return {
              value: option,
              title: label,
              label: (
                <span className={`task-status-segment is-${option}`}>
                  <TaskStatusIcon status={option as TeamTaskStatus} />
                  <span className="task-status-segment-word">{label}</span>
                </span>
              )
            };
          })}
        />
      )}
    </div>
  );
}
