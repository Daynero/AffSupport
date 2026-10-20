import { CalendarDate, CalendarDateTime, fromDate, toZoned } from '@internationalized/date';
import type { CatalogUpdateSchedule } from '@video-compressor/shared';
import { parseUpdaterInterval, UPDATER_INTERVALS, isUpdaterPreset } from './limits';

/** A provisional next occurrence, shared by the draft preview and acknowledged local settings. */
export function catalogNextRunPreview(
  interval: string | null,
  schedule: CatalogUpdateSchedule | null | undefined,
  now = new Date()
): string | null {
  if (interval === null || !parseUpdaterInterval(interval) || !Number.isFinite(now.getTime()))
    return null;
  if ((interval === '1d' || interval === '1w') && schedule) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(schedule.time)) return null;
    if (
      interval === '1w' &&
      (!Number.isInteger(schedule.weekday) || schedule.weekday < 1 || schedule.weekday > 7)
    )
      return null;
    try {
      const local = fromDate(now, schedule.timeZone);
      const localDay = new CalendarDate(local.year, local.month, local.day);
      const [hour, minute] = schedule.time.split(':').map(Number);
      for (let offset = 0; offset <= 7; offset += 1) {
        const day = localDay.add({ days: offset });
        if (
          interval === '1w' &&
          (new Date(day.year, day.month - 1, day.day, 12).getDay() || 7) !== schedule.weekday
        )
          continue;
        const candidate = toZoned(
          new CalendarDateTime(day.year, day.month, day.day, hour, minute),
          schedule.timeZone,
          'later'
        ).toDate();
        if (candidate.getTime() > now.getTime()) return candidate.toISOString();
      }
    } catch {
      /* An invalid legacy zone cannot produce a trustworthy forecast. */
    }
    return null;
  }
  const valid = parseUpdaterInterval(interval)!;
  const seconds = isUpdaterPreset(valid)
    ? UPDATER_INTERVALS[valid]
    : Number(valid.slice(0, -1)) * 3600;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
