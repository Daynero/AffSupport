import { expect, it } from 'vitest';
import { isOlderRowVersion } from '../apps/web/src/team/useScopedRows';
it('orders valid server versions with microsecond precision and normalized offsets', () => {
  expect(
    isOlderRowVersion(
      { updatedAt: '2026-11-03T10:00:00.123001Z' },
      { updatedAt: '2026-11-03T10:00:00.123002Z' }
    )
  ).toBe(true);
  expect(
    isOlderRowVersion(
      { updatedAt: '2026-11-03T12:00:00.123002+02:00' },
      { updatedAt: '2026-11-03T10:00:00.123001Z' }
    )
  ).toBe(false);
  expect(
    isOlderRowVersion(
      { updatedAt: '2026-11-03T10:00:00.123Z' },
      { updatedAt: '2026-11-03T10:00:00.123000Z' }
    )
  ).toBe(false);
});
it('does not invent ordering for missing or invalid fixture versions', () => {
  expect(isOlderRowVersion({}, { updatedAt: '2026-11-03T10:00:00Z' })).toBe(false);
  expect(
    isOlderRowVersion({ updatedAt: 'not-a-date' }, { updatedAt: '2026-11-03T10:00:00Z' })
  ).toBe(false);
  expect(isOlderRowVersion({ updatedAt: '2026-11-03T10:00:00Z' }, {})).toBe(false);
});
