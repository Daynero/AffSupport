// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogDurationPreferenceKey as keyOf,
  readCatalogDurationPreference as read,
  saveCatalogDurationPreference as save
} from '../apps/web/src/team/product-catalog/duration-preference';
const exact = { finalDurationMode: 'custom' as const, customFinalDurationSeconds: 120 };
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe('personal catalog duration preference', () => {
  it('isolates users and spaces and does not persist anonymous choices', () => {
    save(keyOf('a', 'one'), exact);
    expect(read(keyOf('a', 'one'))).toEqual(exact);
    expect(read(keyOf('b', 'one'))).toBeNull();
    expect(read(keyOf('a', 'two'))).toBeNull();
    save(keyOf(null, 'one'), exact);
    expect(read(keyOf(null, 'one'))).toBeNull();
    expect(localStorage.length).toBe(1);
  });
  it.each([
    '{broken',
    '{}',
    '{"finalDurationMode":"custom","customFinalDurationSeconds":7200}',
    '{"finalDurationMode":"random-centered","customFinalDurationSeconds":2700,"finalDurationRangeSeconds":[3000,2400]}'
  ])('ignores corrupt or out-of-scale storage: %s', raw => {
    localStorage.setItem(keyOf('a', 'one')!, raw);
    expect(read(keyOf('a', 'one'))).toBeNull();
  });
  it('does not block editing when storage access is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(read(keyOf('a', 'one'))).toBeNull();
    expect(() => save(keyOf('a', 'one'), exact)).not.toThrow();
  });
});
