import { expect, it, vi } from 'vitest';
import { today, toZoned } from '@internationalized/date';
import {
  catalogPublicationFirstDay,
  catalogPublicationTimeRepeats
} from '../apps/web/src/team/product-catalog/catalogPublicationDraft';

vi.mock('@internationalized/date', async importOriginal => {
  const actual = await importOriginal<typeof import('@internationalized/date')>();
  return { ...actual, today: vi.fn(actual.today), toZoned: vi.fn(actual.toZoned) };
});

it('keeps the publication calendar usable when browser timezone conversion is unavailable', () => {
  vi.mocked(toZoned).mockImplementationOnce(() => {
    throw new RangeError('timezone data unavailable');
  });
  expect(catalogPublicationTimeRepeats('2026-10-25T03:30', 'Europe/Kyiv')).toBe(false);
  vi.mocked(today).mockImplementationOnce(() => {
    throw new RangeError('timezone data unavailable');
  });
  const firstDay = catalogPublicationFirstDay('Europe/Kyiv');
  expect(vi.mocked(today).mock.calls.slice(-2)).toEqual([['Europe/Kyiv'], ['UTC']]);
  expect(firstDay.toString()).toBe(today('UTC').toString());
});
