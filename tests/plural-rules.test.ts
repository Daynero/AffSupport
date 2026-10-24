import { expect, it } from 'vitest';
import { pluralRules } from '../apps/web/src/lib/plural-rules';

it('reuses each language formatter without sharing different languages', () => {
  expect(pluralRules('uk')).toBe(pluralRules('uk'));
  expect(pluralRules('en')).toBe(pluralRules('en'));
  expect(pluralRules('uk')).not.toBe(pluralRules('en'));
});

it.each([
  [0, 'many'],
  [1, 'one'],
  [2, 'few'],
  [5, 'many'],
  [11, 'many'],
  [21, 'one'],
  [22, 'few'],
  [1.5, 'other']
] as const)('keeps Ukrainian category for %s', (count, category) => {
  expect(pluralRules('uk').select(count)).toBe(category);
});

it.each([
  [0, 'other'],
  [1, 'one'],
  [2, 'other']
] as const)('keeps English category for %s', (count, category) => {
  expect(pluralRules('en').select(count)).toBe(category);
});
