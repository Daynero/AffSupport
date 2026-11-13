import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { parseCatalogVideoPublication } from '../packages/shared/src/team/catalog-publication';
import {
  catalogPublicationFirstDay,
  catalogPublicationTimeRepeats,
  resolveCatalogPublicationDraft
} from '../apps/web/src/team/product-catalog/catalogPublicationDraft';
const now = Date.parse('2026-01-01T00:00:00Z');
const scheduled = (
  localDateTime = '2026-11-08T15:00',
  timeZone = 'Europe/Kyiv',
  resolvedOffset = '+02:00',
  dueAt = '2026-11-08T13:00:00.000Z'
) => ({ mode: 'scheduled', localDateTime, timeZone, resolvedOffset, dueAt });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec('set default_transaction_read_only=on');
}, 30000);
afterAll(async () => {
  await db?.close();
});
it('defaults unchecked creation to immediate and validates a scheduled server instant', () => {
  expect(parseCatalogVideoPublication(undefined, now)).toEqual({ mode: 'immediate' });
  expect(parseCatalogVideoPublication(scheduled(), now)).toMatchObject({
    mode: 'scheduled',
    dueAt: '2026-11-08T13:00:00.000Z'
  });
});
it.each([
  null,
  {},
  { mode: 'held' },
  { ...scheduled(), localDateTime: '2026-02-30T15:00' },
  { ...scheduled(), localDateTime: '2026-11-08' },
  { ...scheduled(), timeZone: 'Missing/Zone' },
  { ...scheduled(), resolvedOffset: undefined },
  { ...scheduled(), resolvedOffset: '+14:30' },
  { ...scheduled(), dueAt: '2026-11-08T13:01:00Z' }
])('refuses incomplete or inconsistent scheduling', input => {
  expect(() => parseCatalogVideoPublication(input, now)).toThrow('INVALID_INPUT');
});
it('uses the trusted server clock regardless of the browser clock', () => {
  const instant = Date.parse(scheduled().dueAt);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(instant + 86400000);
  try {
    expect(parseCatalogVideoPublication(scheduled(), instant - 1).mode).toBe('scheduled');
    clock.mockReturnValue(instant - 86400000);
    expect(() => parseCatalogVideoPublication(scheduled(), instant)).toThrow('INVALID_INPUT');
    expect(() => parseCatalogVideoPublication(scheduled(), NaN)).toThrow('INVALID_INPUT');
  } finally {
    clock.mockRestore();
  }
});
it.each([
  ['2026-03-29T03:30', 'Europe/Kyiv', '+02:00', '2026-03-29T01:30:00Z'],
  ['2026-03-08T02:30', 'America/New_York', '-05:00', '2026-03-08T07:30:00Z']
])('rejects a nonexistent DST wall time in %s %s', (local, zone, offset, due) => {
  expect(() => parseCatalogVideoPublication(scheduled(local, zone, offset, due), now)).toThrow(
    'INVALID_INPUT'
  );
  expect(() =>
    resolveCatalogPublicationDraft({ localDateTime: local, timeZone: zone }, now)
  ).toThrow('INVALID_INPUT');
});
it('asks for an explicit offset for a repeated wall time rather than choosing silently', () => {
  const input = { localDateTime: '2026-10-25T03:30', timeZone: 'Europe/Kyiv' };
  const result = resolveCatalogPublicationDraft(input, now);
  expect(result.kind).toBe('ambiguous');
  if (result.kind !== 'ambiguous') throw Error('expected repeated time');
  expect(result.choices.map(choice => choice.resolvedOffset)).toEqual(['+03:00', '+02:00']);
  expect(result.choices.map(choice => choice.dueAt)).toEqual([
    '2026-10-25T00:30:00.000Z',
    '2026-10-25T01:30:00.000Z'
  ]);
  expect(resolveCatalogPublicationDraft({ ...input, choice: 'later' }, now)).toMatchObject({
    kind: 'resolved',
    publication: { resolvedOffset: '+02:00', dueAt: '2026-10-25T01:30:00.000Z' }
  });
});
it('names only the repeated hour as needing a choice, so the picker hides otherwise', () => {
  expect(catalogPublicationTimeRepeats('2026-10-25T03:30', 'Europe/Kyiv')).toBe(true);
  expect(catalogPublicationTimeRepeats('2026-10-25T05:30', 'Europe/Kyiv')).toBe(false);
  expect(catalogPublicationTimeRepeats('2026-11-11T19:42', 'Europe/Kyiv')).toBe(false);
  // The skipped spring hour is the other irregular one: it is shown too, so the person
  // sees the time is special (the save then names it as a time that does not exist).
  expect(catalogPublicationTimeRepeats('2026-03-29T03:30', 'Europe/Kyiv')).toBe(true);
  expect(catalogPublicationTimeRepeats('', 'Europe/Kyiv')).toBe(false);
  expect(catalogPublicationTimeRepeats('2026-10-25T03:30', 'Not/AZone')).toBe(false);
});
it('starts the publication calendar today in the publication zone', () => {
  expect(catalogPublicationFirstDay('Europe/Kyiv').toString()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  expect(catalogPublicationFirstDay('Not/AZone').toString()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
});
it('handles a browser timezone formatter failure without breaking the date controls', () => {
  const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
  try {
    parts.mockImplementationOnce(() => {
      throw new Error('timezone data unavailable');
    });
    expect(catalogPublicationTimeRepeats('2026-10-25T01:30', 'America/New_York')).toBe(false);
    expect(parts).toHaveBeenCalled();
    parts.mockImplementationOnce(() => {
      throw new Error('timezone data unavailable');
    });
    expect(catalogPublicationFirstDay('Pacific/Kiritimati').toString()).toBe(
      new Date().toISOString().slice(0, 10)
    );
  } finally {
    parts.mockRestore();
  }
});
it('keeps an elapsed fold choice distinct from the still available later occurrence', () => {
  const result = resolveCatalogPublicationDraft(
    { localDateTime: '2026-10-25T03:30', timeZone: 'Europe/Kyiv' },
    Date.parse('2026-10-25T01:00:00Z')
  );
  expect(result.kind).toBe('ambiguous');
  expect(() =>
    resolveCatalogPublicationDraft(
      { localDateTime: '2026-10-25T03:30', timeZone: 'Europe/Kyiv', choice: 'earlier' },
      Date.parse('2026-10-25T01:00:00Z')
    )
  ).toThrow('INVALID_INPUT');
  expect(
    resolveCatalogPublicationDraft(
      { localDateTime: '2026-10-25T03:30', timeZone: 'Europe/Kyiv', choice: 'later' },
      Date.parse('2026-10-25T01:00:00Z')
    )
  ).toMatchObject({ kind: 'resolved' });
  if (result.kind === 'ambiguous')
    expect(result.choices.map(choice => choice.inPast)).toEqual([true, false]);
});
it.each([
  scheduled('2026-11-08T00:00', 'UTC', '+00:00', '2026-11-08T00:00:00.000Z'),
  scheduled('2026-11-08T00:00', 'Pacific/Kiritimati', '+14:00', '2026-11-07T10:00:00.000Z'),
  scheduled('2026-04-05T01:45', 'Australia/Lord_Howe', '+11:00', '2026-04-04T14:45:00.000Z'),
  scheduled('2026-04-05T01:45', 'Australia/Lord_Howe', '+10:30', '2026-04-04T15:15:00.000Z'),
  scheduled('2026-11-08T15:00', 'UTC', '+00:00', '2026-11-08T15:00:00.000Z'),
  scheduled('2026-11-08T15:00', 'Asia/Kathmandu', '+05:45', '2026-11-08T09:15:00.000Z'),
  scheduled('2026-10-25T03:30', 'Europe/Kyiv', '+03:00', '2026-10-25T00:30:00.000Z'),
  scheduled('2026-10-25T03:30', 'Europe/Kyiv', '+02:00', '2026-10-25T01:30:00.000Z'),
  scheduled('2026-11-01T01:30', 'America/New_York', '-04:00', '2026-11-01T05:30:00.000Z'),
  scheduled('2026-11-01T01:30', 'America/New_York', '-05:00', '2026-11-01T06:30:00.000Z')
])('matches PostgreSQL local time and offset for $timeZone $resolvedOffset', async input => {
  const value = parseCatalogVideoPublication(input, now);
  if (value.mode !== 'scheduled') throw Error('expected scheduled');
  const rows = await db.query<{ local_datetime: string; offset_minutes: number }>(
    `select to_char($1::timestamptz at time zone $2,'YYYY-MM-DD"T"HH24:MI') local_datetime, extract(epoch from (($1::timestamptz at time zone $2)-($1::timestamptz at time zone 'UTC')))/60 offset_minutes`,
    [value.dueAt, value.timeZone]
  );
  expect(rows.rows[0]?.local_datetime).toBe(value.localDateTime);
  const sign = value.resolvedOffset[0] === '-' ? -1 : 1;
  const [hours, minutes] = value.resolvedOffset.slice(1).split(':').map(Number);
  expect(Number(rows.rows[0]?.offset_minutes)).toBe(sign * (hours * 60 + minutes));
});

it('handles a half-hour DST gap without normalizing to a different chosen time', () => {
  expect(() =>
    resolveCatalogPublicationDraft(
      { localDateTime: '2026-10-04T02:15', timeZone: 'Australia/Lord_Howe' },
      now
    )
  ).toThrow('INVALID_INPUT');
});
