import { afterEach, expect, it, vi } from 'vitest';
import {
  parseAdminTariffRow,
  parseAdminTariffSettings,
  parseSpaceAccess,
  parseTeamTariff
} from '../packages/shared/src/types';
import { formatTariffDay } from '../apps/web/src/team/tariffs/format';
afterEach(() => vi.useRealTimers());
it('formats the year relative to the server tariff calendar', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  expect(formatTariffDay('2030-10-14', 'en', '2030-10-11')).toBe('14 October');
  expect(formatTariffDay('2026-10-14', 'en', '2030-10-11')).toBe('14 October 2026');
});
it('preserves legacy real-time formatting without a server calendar', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  expect(formatTariffDay('2026-10-14', 'en')).toBe('14 October');
});
it('preserves the authoritative calendar on access and team snapshots', () => {
  expect(parseSpaceAccess({ mode: 'showcase', tariffToday: '2030-01-01' })).toMatchObject({
    tariffToday: '2030-01-01'
  });
  expect(parseTeamTariff({ state: 'active', tariffToday: '2030-01-01' })).toMatchObject({
    tariffToday: '2030-01-01'
  });
});
it.each(['2030-02-30', '2030-13-01', '2030-01-01T00:00:00Z', '', null, 123])(
  'rejects a malformed server calendar %s',
  tariffToday => {
    expect(parseSpaceAccess({ mode: 'showcase', tariffToday })).toBeNull();
    expect(parseTeamTariff({ state: 'active', tariffToday })).toBeNull();
  }
);
it('keeps legacy DTOs without an invented server date', () => {
  expect(parseSpaceAccess({ mode: 'showcase' })).not.toHaveProperty('tariffToday');
  expect(parseTeamTariff({ state: 'active' })).not.toHaveProperty('tariffToday');
});
it('uses the server calendar to restart a blocked or revoked tariff term', async () => {
  const { extendBase } = await import('../apps/web/src/pages/admin/tariffModel');
  expect(
    extendBase({
      state: 'blocked',
      revokedAt: null,
      endsOn: '2026-01-01',
      tariffToday: '2030-10-11'
    })
  ).toBe('2030-10-11');
  expect(
    extendBase({
      state: 'active',
      revokedAt: '2026-01-01T00:00:00Z',
      endsOn: '2026-01-01',
      tariffToday: '2030-10-11'
    })
  ).toBe('2030-10-11');
  expect(
    extendBase({
      state: 'active',
      revokedAt: null,
      endsOn: '2030-12-01',
      tariffToday: '2030-10-11'
    })
  ).toBe('2030-12-01');
});

it('preserves the server calendar on admin rows and settings', () => {
  expect(
    parseAdminTariffRow({
      id: 'fixture',
      ownerEmail: 'fixture@soty.invalid',
      planCode: 'lead',
      endsOn: '2030-10-14',
      tariffToday: '2030-10-11'
    })
  ).toMatchObject({ tariffToday: '2030-10-11' });
  expect(
    parseAdminTariffSettings({ legacyRuleEnabled: false, tariffToday: '2030-10-11' })
  ).toMatchObject({ tariffToday: '2030-10-11' });
});
it.each(['2030-02-30', null, 123])('rejects malformed admin server calendar %s', tariffToday => {
  expect(
    parseAdminTariffRow({
      id: 'fixture',
      ownerEmail: 'fixture@soty.invalid',
      planCode: 'lead',
      endsOn: '2030-10-14',
      tariffToday
    })
  ).toBeNull();
  expect(parseAdminTariffSettings({ legacyRuleEnabled: false, tariffToday })).toBeNull();
});
