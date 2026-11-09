import { CalendarDateTime, toZoned } from '@internationalized/date';
import {
  CatalogPublicationValidationError,
  parseCatalogVideoPublication,
  type CatalogVideoPublicationRequest
} from '@video-compressor/shared';
import { isLaunchDate, isLaunchTimezone } from '@video-compressor/shared';

export interface CatalogPublicationDraft {
  localDateTime: string;
  timeZone: string;
  choice?: 'earlier' | 'later';
}
export interface CatalogPublicationTimeChoice {
  readonly choice: 'earlier' | 'later';
  readonly resolvedOffset: string;
  readonly dueAt: string;
  readonly inPast: boolean;
}
export type CatalogPublicationDraftResult =
  | {
      kind: 'resolved';
      publication: Extract<CatalogVideoPublicationRequest, { mode: 'scheduled' }>;
    }
  | { kind: 'ambiguous'; choices: readonly CatalogPublicationTimeChoice[] };

/** Reuse the calendar preview's timezone seam. Fold choices remain explicit,
 * including when the earlier occurrence has passed but the later one has not. */
export function resolveCatalogPublicationDraft(
  input: CatalogPublicationDraft,
  serverNow: number
): CatalogPublicationDraftResult {
  parseCatalogVideoPublication({ mode: 'immediate' }, serverNow);
  if (
    typeof input.localDateTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.localDateTime) ||
    !isLaunchDate(input.localDateTime.slice(0, 10))
  )
    throw new CatalogPublicationValidationError('invalid_datetime');
  if (!isLaunchTimezone(input.timeZone))
    throw new CatalogPublicationValidationError('invalid_timezone');
  if (input.choice !== undefined && input.choice !== 'earlier' && input.choice !== 'later')
    throw new CatalogPublicationValidationError('invalid_publication');
  const [year, month, day, hour, minute] = input.localDateTime.split(/[-T:]/u).map(Number);
  const local = new CalendarDateTime(year, month, day, hour, minute);
  const choices = (['earlier', 'later'] as const).map(choice => {
    const zoned = toZoned(local, input.timeZone, choice);
    if (
      zoned.year !== year ||
      zoned.month !== month ||
      zoned.day !== day ||
      zoned.hour !== hour ||
      zoned.minute !== minute
    )
      throw new CatalogPublicationValidationError('nonexistent_time');
    const offsetMinutes = zoned.offset / 60000;
    if (!Number.isInteger(offsetMinutes))
      throw new CatalogPublicationValidationError('invalid_offset');
    const absolute = Math.abs(offsetMinutes);
    return Object.freeze({
      choice,
      resolvedOffset: `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`,
      dueAt: zoned.toDate().toISOString(),
      inPast: zoned.toDate().getTime() <= serverNow
    });
  });
  if (choices[0].dueAt !== choices[1].dueAt && input.choice === undefined)
    return { kind: 'ambiguous', choices: Object.freeze(choices) };
  const chosen = choices[input.choice === 'later' ? 1 : 0];
  const publication = parseCatalogVideoPublication(
    {
      mode: 'scheduled',
      localDateTime: input.localDateTime,
      timeZone: input.timeZone,
      resolvedOffset: chosen.resolvedOffset,
      dueAt: chosen.dueAt
    },
    serverNow
  );
  if (publication.mode !== 'scheduled')
    throw new CatalogPublicationValidationError('invalid_publication');
  return { kind: 'resolved', publication };
}
