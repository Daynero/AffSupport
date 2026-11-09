import { isRecord } from './contract.js';
import { isLaunchDate, isLaunchTimezone } from './launches/naming.js';

export type CatalogVideoPublicationRequest =
  | Readonly<{ mode: 'immediate' }>
  | Readonly<{
      mode: 'scheduled';
      localDateTime: string;
      timeZone: string;
      resolvedOffset: string;
      dueAt: string;
    }>;
export class CatalogPublicationValidationError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(
    readonly reason:
      | 'invalid_publication'
      | 'invalid_datetime'
      | 'invalid_timezone'
      | 'invalid_offset'
      | 'invalid_due_at'
      | 'local_time_unresolved'
      | 'nonexistent_time'
      | 'time_in_past'
      | 'clock_unavailable'
  ) {
    super('INVALID_INPUT');
  }
}
const invalid = (reason: CatalogPublicationValidationError['reason']): never => {
  throw new CatalogPublicationValidationError(reason);
};

/** Validate against a trusted database/server clock, not a browser's wall clock.
 * A repeated DST time requires an explicit offset. A gap cannot pass the round trip.
 * This validates a requested instant; it neither schedules a job nor authorizes a write. */
export function parseCatalogVideoPublication(
  raw: unknown,
  serverNow: number
): CatalogVideoPublicationRequest {
  if (!Number.isSafeInteger(serverNow) || !Number.isFinite(new Date(serverNow).getTime()))
    return invalid('clock_unavailable');
  if (raw === undefined || (isRecord(raw) && raw.mode === 'immediate'))
    return Object.freeze({ mode: 'immediate' });
  if (!isRecord(raw) || raw.mode !== 'scheduled') return invalid('invalid_publication');
  if (
    typeof raw.localDateTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(raw.localDateTime) ||
    !isLaunchDate(raw.localDateTime.slice(0, 10))
  )
    return invalid('invalid_datetime');
  if (!isLaunchTimezone(raw.timeZone)) return invalid('invalid_timezone');
  const offset =
    typeof raw.resolvedOffset === 'string'
      ? /^([+-])(0\d|1[0-4]):([0-5]\d)$/u.exec(raw.resolvedOffset)
      : null;
  if (!offset) return invalid('invalid_offset');
  const offsetMinutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
  if (Math.abs(offsetMinutes) > 14 * 60) return invalid('invalid_offset');
  const instant = Date.parse(raw.localDateTime + ':00.000Z') - offsetMinutes * 60000;
  if (
    typeof raw.dueAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw.dueAt) ||
    !Number.isFinite(instant) ||
    Date.parse(raw.dueAt) !== instant
  )
    return invalid('invalid_due_at');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: raw.timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map(part => [part.type, part.value])
  );
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  if (local !== raw.localDateTime) return invalid('local_time_unresolved');
  if (instant <= serverNow) return invalid('time_in_past');
  return Object.freeze({
    mode: 'scheduled',
    localDateTime: raw.localDateTime,
    timeZone: formatter.resolvedOptions().timeZone,
    resolvedOffset: offsetMinutes === 0 ? '+00:00' : (raw.resolvedOffset as string),
    dueAt: new Date(instant).toISOString()
  });
}
