import {
  CalendarDate,
  parseDate,
  today,
  getLocalTimeZone,
  type DateValue
} from '@internationalized/date';
import { Calendar as HeroCalendar } from '@heroui/react/calendar';
import { RangeCalendar as HeroRangeCalendar } from '@heroui/react/range-calendar';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { uiClasses } from './types';

/**
 * Dates, on one calendar (024).
 *
 * The product had two, hand-written, in two files, with different behaviour: a
 * 42-cell grid built by hand for the board's filter and another for the task's
 * own day. Neither had a year jump, neither answered PageUp or Home, and only
 * one of them knew which day the week starts on.
 *
 * This is React Aria's calendar, which knows all of that and the locale's
 * calendar system besides, wearing this product's clothes.
 *
 * ## The date on the wire is still a string
 *
 * Everything outside this file speaks `YYYY-MM-DD`, because that is what the
 * API stores and what the URL carries. `CalendarDate` lives inside the UI layer
 * and is converted at the edge, so adopting a date library did not become a
 * migration of every shape that holds a day.
 */

/** `YYYY-MM-DD` → the calendar's own value, or null for an empty field. */
export function toCalendarDate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

/** The calendar's value → `YYYY-MM-DD`, which is what everything else speaks. */
export function fromCalendarDate(value: CalendarDate | null | undefined): string | null {
  return value ? value.toString() : null;
}

/** Today, in the reader's own zone rather than in UTC. */
export function todayHere(): CalendarDate {
  return today(getLocalTimeZone());
}

interface CalendarChrome {
  /**
   * Days that cannot be chosen — a range that has not opened yet, a holiday.
   *
   * Typed against the library's own `DateValue` rather than a plain day,
   * because the calendar may be asked about a value in another calendar system
   * and narrowing that away here would be a lie about what it is handed.
   */
  isDateUnavailable?: (date: DateValue) => boolean;
  minValue?: CalendarDate;
  maxValue?: CalendarDate;
  className?: string;
  /** Drawn under the grid: quick ranges, a hint, a clear. */
  footer?: ReactNode;
}

/** The month grid, its heading, its arrows and its year jump — written once. */
function grid() {
  return (
    <>
      <HeroCalendar.Header className="ui-calendar-header">
        <HeroCalendar.NavButton slot="previous" className="ui-calendar-nav">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </HeroCalendar.NavButton>
        <HeroCalendar.YearPickerTrigger className="ui-calendar-heading">
          <HeroCalendar.Heading />
        </HeroCalendar.YearPickerTrigger>
        <HeroCalendar.NavButton slot="next" className="ui-calendar-nav">
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </HeroCalendar.NavButton>
      </HeroCalendar.Header>
      <HeroCalendar.Grid className="ui-calendar-grid">
        <HeroCalendar.GridHeader className="ui-calendar-grid-header">
          {day => (
            <HeroCalendar.HeaderCell className="ui-calendar-weekday">{day}</HeroCalendar.HeaderCell>
          )}
        </HeroCalendar.GridHeader>
        <HeroCalendar.GridBody>
          {date => <HeroCalendar.Cell date={date} className="ui-calendar-day" />}
        </HeroCalendar.GridBody>
      </HeroCalendar.Grid>
    </>
  );
}

export interface CalendarProps extends CalendarChrome {
  value: CalendarDate | null;
  onChange: (value: CalendarDate) => void;
  /** Names the calendar for assistive technology. */
  label: string;
}

export function Calendar({
  value,
  onChange,
  label,
  isDateUnavailable,
  minValue,
  maxValue,
  className,
  footer
}: CalendarProps) {
  return (
    <HeroCalendar
      aria-label={label}
      value={value}
      onChange={onChange}
      isDateUnavailable={isDateUnavailable}
      minValue={minValue}
      maxValue={maxValue}
      className={uiClasses('calendar', { className })}
    >
      {grid()}
      {footer && <div className="ui-calendar-footer">{footer}</div>}
    </HeroCalendar>
  );
}

export interface DateRange {
  start: CalendarDate;
  end: CalendarDate;
}

export interface RangeCalendarProps extends CalendarChrome {
  value: DateRange | null;
  onChange: (value: DateRange) => void;
  label: string;
}

/**
 * A range, and what happens to a half-made one.
 *
 * The board's filter used to abandon a range whose second day had not been
 * picked when the popover closed — stated in three places and decided by
 * nobody (021, finding B4). It is kept now: closing a half-made range leaves
 * the first day chosen, because the reader who picked it meant to.
 */
export function RangeCalendar({
  value,
  onChange,
  label,
  isDateUnavailable,
  minValue,
  maxValue,
  className,
  footer
}: RangeCalendarProps) {
  return (
    <HeroRangeCalendar
      aria-label={label}
      value={value}
      onChange={onChange}
      isDateUnavailable={isDateUnavailable}
      minValue={minValue}
      maxValue={maxValue}
      className={uiClasses('calendar', { className })}
    >
      <HeroRangeCalendar.Header className="ui-calendar-header">
        <HeroRangeCalendar.NavButton slot="previous" className="ui-calendar-nav">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </HeroRangeCalendar.NavButton>
        <HeroRangeCalendar.Heading className="ui-calendar-heading" />
        <HeroRangeCalendar.NavButton slot="next" className="ui-calendar-nav">
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </HeroRangeCalendar.NavButton>
      </HeroRangeCalendar.Header>
      <HeroRangeCalendar.Grid className="ui-calendar-grid">
        <HeroRangeCalendar.GridHeader className="ui-calendar-grid-header">
          {day => (
            <HeroRangeCalendar.HeaderCell className="ui-calendar-weekday">
              {day}
            </HeroRangeCalendar.HeaderCell>
          )}
        </HeroRangeCalendar.GridHeader>
        <HeroRangeCalendar.GridBody>
          {date => <HeroRangeCalendar.Cell date={date} className="ui-calendar-day" />}
        </HeroRangeCalendar.GridBody>
      </HeroRangeCalendar.Grid>
      {footer && <div className="ui-calendar-footer">{footer}</div>}
    </HeroRangeCalendar>
  );
}
