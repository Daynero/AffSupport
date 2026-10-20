import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCatalogCreatedDateRangeValid,
  matchesCatalogCreatedAt
} from '../apps/web/src/team/catalog-updater/catalogCreatedDate';

let originalTimeZone: string | undefined;
beforeEach(() => {
  originalTimeZone = process.env.TZ;
  process.env.TZ = 'Europe/Kyiv';
});
afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe('catalog creation calendar range', () => {
  it('uses the browser local day rather than slicing the UTC timestamp', () => {
    const range = { from: '2026-10-19', to: '2026-10-19' };
    expect(matchesCatalogCreatedAt('2026-10-18T21:00:00Z', range)).toBe(true);
    expect(matchesCatalogCreatedAt('2026-10-18T20:59:59Z', range)).toBe(false);
    expect(matchesCatalogCreatedAt('2026-10-19T23:59:59+03:00', range)).toBe(true);
    expect(matchesCatalogCreatedAt('2026-10-20T00:00:00+03:00', range)).toBe(false);
  });
  it('also handles local dates west of UTC and explicit source offsets', () => {
    process.env.TZ = 'America/Los_Angeles';
    const range = { from: '2026-10-18', to: '2026-10-18' };
    expect(matchesCatalogCreatedAt('2026-10-19T06:59:59.999Z', range)).toBe(true);
    expect(matchesCatalogCreatedAt('2026-10-19T07:00:00Z', range)).toBe(false);
    expect(matchesCatalogCreatedAt('2026-10-19T08:00:00+03:00', range)).toBe(true);
  });
  it('supports either open end and includes the last millisecond of the end day', () => {
    expect(matchesCatalogCreatedAt('2026-10-19T23:59:59.999+03:00', { to: '2026-10-19' })).toBe(
      true
    );
    expect(matchesCatalogCreatedAt('2026-10-20T00:00:00+03:00', { to: '2026-10-19' })).toBe(false);
    expect(matchesCatalogCreatedAt('2026-10-19T00:00:00+03:00', { from: '2026-10-19' })).toBe(true);
    expect(matchesCatalogCreatedAt('2026-10-18T23:59:59+03:00', { from: '2026-10-19' })).toBe(
      false
    );
  });
  it('does not filter unknown creation dates when no bounds are selected', () => {
    for (const date of [undefined, null, '', 'invalid']) {
      expect(matchesCatalogCreatedAt(date, {})).toBe(true);
      expect(matchesCatalogCreatedAt(date, { from: '', to: '' })).toBe(true);
      expect(matchesCatalogCreatedAt(date, { from: '2026-10-19' })).toBe(false);
    }
  });
  it('rejects reversed or invalid bounds and malformed creation timestamps', () => {
    const date = '2026-10-19T12:00:00Z';
    for (const range of [
      { from: '2026-10-20', to: '2026-10-19' },
      { from: '2026-02-30' },
      { to: '2026-13-01' },
      { from: '2026-1-01' },
      { from: 'invalid' }
    ]) {
      expect(isCatalogCreatedDateRangeValid(range)).toBe(false);
      expect(matchesCatalogCreatedAt(date, range)).toBe(false);
    }
    expect(isCatalogCreatedDateRangeValid({ from: '2028-02-29' })).toBe(true);
    for (const invalid of ['2026-02-30T12:00:00Z', '2026-10-19T25:00:00Z', '2026-10-19']) {
      expect(matchesCatalogCreatedAt(invalid, { from: '2026-01-01' })).toBe(false);
    }
  });
});
