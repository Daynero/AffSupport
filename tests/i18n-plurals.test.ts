import { describe, expect, it } from 'vitest';
import { selectedCountKey, translate, type Language } from '../apps/web/src/i18n';

/**
 * Ukrainian has three plural forms and the application knew two.
 *
 * One file, two files, five files — `один файл`, `два файли`, `п'ять файлів`.
 * The hand-written rule returned the "many" form for everything that was not
 * exactly one, so a user who ticked a second checkbox was shown "Вибрано 2
 * файлів": wrong in a way every Ukrainian speaker notices, on a string that
 * appears every time a selection changes.
 *
 * The counts below are chosen from the edges of the rules rather than from the
 * middle: 21 is "one" and 22 is "few" in Ukrainian, which is exactly the shape
 * a remainder-based rule written by hand gets wrong.
 */

const CASES: { count: number; uk: 'one' | 'few' | 'many'; en: 'one' | 'many' }[] = [
  { count: 1, uk: 'one', en: 'one' },
  { count: 2, uk: 'few', en: 'many' },
  { count: 3, uk: 'few', en: 'many' },
  { count: 4, uk: 'few', en: 'many' },
  { count: 5, uk: 'many', en: 'many' },
  { count: 11, uk: 'many', en: 'many' },
  { count: 12, uk: 'many', en: 'many' },
  { count: 21, uk: 'one', en: 'many' },
  { count: 22, uk: 'few', en: 'many' },
  { count: 25, uk: 'many', en: 'many' },
  { count: 101, uk: 'one', en: 'many' },
  { count: 102, uk: 'few', en: 'many' }
];

const KEY = { one: 'selectedOne', few: 'selectedFew', many: 'selectedMany' } as const;

describe('the selection count', () => {
  it.each(CASES)('picks the Ukrainian form for $count', ({ count, uk }) => {
    expect(selectedCountKey('uk', count)).toBe(KEY[uk]);
  });

  it.each(CASES)('picks the English form for $count', ({ count, en }) => {
    expect(selectedCountKey('en', count)).toBe(KEY[en]);
  });

  it.each(['uk', 'en'] as Language[])('renders the count into the string in %s', language => {
    const rendered = translate(language, selectedCountKey(language, 3), { count: 3 });
    expect(rendered).toContain('3');
    // Not a leftover placeholder: a count string that renders `{count}` is a
    // string nobody looked at.
    expect(rendered).not.toContain('{count}');
  });

  it('uses a distinct Ukrainian wording for the few form', () => {
    // The whole point. If these two are the same string, the extra category is
    // decoration and the bug is still there.
    const few = translate('uk', 'selectedFew', { count: 2 });
    const many = translate('uk', 'selectedMany', { count: 5 });
    expect(few).not.toBe(many.replace('5', '2'));
  });
});
