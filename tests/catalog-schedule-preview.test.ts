import { expect, it } from 'vitest';
import { catalogNextRunPreview } from '../apps/web/src/team/catalog-updater/catalogSchedulePreview';

it('uses the later DST occurrence and advances missing local times like the server', () => {
  expect(
    catalogNextRunPreview(
      '1w',
      { timeZone: 'Europe/Kyiv', weekday: 7, time: '03:30' },
      new Date('2026-10-24T10:00:00Z')
    )
  ).toBe('2026-10-25T01:30:00.000Z');
  expect(
    catalogNextRunPreview(
      '1d',
      { timeZone: 'Europe/Berlin', weekday: 1, time: '02:30' },
      new Date('2026-03-28T23:30:00Z')
    )
  ).toBe('2026-03-29T01:30:00.000Z');
});
it('forecasts interval-only changes from the supplied clock and clears disabled schedules', () => {
  const now = new Date('2026-10-20T10:02:03Z');
  expect(catalogNextRunPreview('6h', null, now)).toBe('2026-10-20T16:02:03.000Z');
  expect(catalogNextRunPreview(null, null, now)).toBeNull();
  expect(
    catalogNextRunPreview('1d', { timeZone: 'invalid', weekday: 1, time: '09:00' }, now)
  ).toBeNull();
});
