import { describe, expect, it } from 'vitest';
import {
  convertKeyboardLayout,
  countSearchLetters,
  filterBySearchQuery,
  matchesSearchQuery,
  searchHitRanges,
  searchTerms
} from '../packages/shared/src/team/text-search';
import { filterTeamAccounts, type TeamAccountSummary } from '../packages/shared/src/team/accounts';
import { splitHighlight } from '../apps/web/src/team/search/highlight';
import { effectiveSearchQuery } from '../apps/web/src/team/catalog/useCatalogSearch';

/** Search rework (2026-10): one way of matching typed text across the space. */

describe('keyboard layout conversion', () => {
  it('reads Latin letters as Ukrainian typed on an English layout', () => {
    expect(convertKeyboardLayout('ghbdsn')).toBe('привіт');
    expect(convertKeyboardLayout('rtnj')).toBe('кето');
    expect(convertKeyboardLayout('Ghbdsn')).toBe('привіт');
    // Punctuation keys carry letters too: б, ж, х, ї, є, ґ.
    expect(convertKeyboardLayout('z,kerj')).toBe('яблуко');
    expect(convertKeyboardLayout('kj;rf')).toBe('ложка');
    expect(convertKeyboardLayout("[kj] '")).toBe('хлої є');
    expect(convertKeyboardLayout(String.raw`\fyjr`)).toBe('ґанок');
  });

  it('reads Cyrillic letters as English typed on a Ukrainian (or Russian) layout', () => {
    expect(convertKeyboardLayout('руддщ')).toBe('hello');
    expect(convertKeyboardLayout('ифттук')).toBe('banner');
    expect(convertKeyboardLayout('ыуфкср')).toBe('search');
  });

  it('keeps what neither table knows, and says when nothing changes', () => {
    expect(convertKeyboardLayout('ghbdsn 2024')).toBe('привіт 2024');
    expect(convertKeyboardLayout('2024-10')).toBeNull();
    expect(convertKeyboardLayout('')).toBeNull();
  });

  it('decides the direction by the script most letters are in', () => {
    expect(convertKeyboardLayout('ghbdsn я')).toBe('привіт я');
  });

  it('counts letters of both scripts only', () => {
    expect(countSearchLetters('ab-12 вг')).toBe(4);
  });
});

describe('matching', () => {
  it('needs every word, in any order, anywhere', () => {
    expect(matchesSearchQuery('Укр банер весна', 'банер укр')).toBe(true);
    expect(matchesSearchQuery('Укр банер весна', 'банер літо')).toBe(false);
    expect(matchesSearchQuery('Urban banner', 'rba')).toBe(true);
  });

  it('compares NFC and case-folded text', () => {
    const decomposed = 'Йогурт'.normalize('NFD');
    expect(matchesSearchQuery(decomposed, 'йог')).toBe(true);
    expect(matchesSearchQuery('KETO promo', 'keto PROMO')).toBe(true);
  });

  it('lets each word be found in a different field', () => {
    expect(matchesSearchQuery(['Launch', null, 'keto note'], 'keto launch')).toBe(true);
    expect(matchesSearchQuery([null, undefined], 'keto')).toBe(false);
  });

  it('splits a query into distinct normalised words', () => {
    expect(searchTerms('  Keto   keto  UA ')).toEqual(['keto', 'ua']);
    expect(searchTerms('   ')).toEqual([]);
  });

  it('retries on the other layout only when the words as typed find nothing', () => {
    const tasks = [{ title: 'Привіт світ' }, { title: 'ghbdsn literal' }];
    expect(filterBySearchQuery(tasks, 'ghbdsn', task => [task.title])).toMatchObject({
      items: [{ title: 'ghbdsn literal' }],
      converted: false
    });
    expect(filterBySearchQuery(tasks.slice(0, 1), 'ghbdsn', task => [task.title])).toEqual({
      items: [{ title: 'Привіт світ' }],
      query: 'привіт',
      converted: true
    });
    // Two letters are too few to guess a layout from.
    expect(filterBySearchQuery(tasks.slice(0, 1), 'gh', task => [task.title]).items).toEqual([]);
  });
});

describe('highlighting', () => {
  it('marks a word where it starts a word, not inside one', () => {
    expect(searchHitRanges('Urban banner', 'ban')).toEqual([[6, 9]]);
    expect(splitHighlight('Urban banner', 'ban')).toEqual([
      { text: 'Urban ', hit: false },
      { text: 'ban', hit: true },
      { text: 'ner', hit: false }
    ]);
  });

  it('falls back to the first occurrence inside a word', () => {
    expect(splitHighlight('Db3_compressed.mp4', 'press')).toEqual([
      { text: 'Db3_com', hit: false },
      { text: 'press', hit: true },
      { text: 'ed.mp4', hit: false }
    ]);
  });

  it('marks every word of the query, case-insensitively, merging overlaps', () => {
    expect(splitHighlight('Keto UA keto', 'KETO ua')).toEqual([
      { text: 'Keto', hit: true },
      { text: ' ', hit: false },
      { text: 'UA', hit: true },
      { text: ' ', hit: false },
      { text: 'keto', hit: true }
    ]);
    expect(searchHitRanges('banner', 'ban banner')).toEqual([[0, 6]]);
  });

  it('leaves text alone when nothing matches or the query is blank', () => {
    expect(splitHighlight('launch.mp4', 'zzz')).toEqual([{ text: 'launch.mp4', hit: false }]);
    expect(splitHighlight('launch.mp4', '')).toEqual([{ text: 'launch.mp4', hit: false }]);
    expect(splitHighlight('', 'a')).toEqual([]);
  });

  it('treats regular-expression characters as text', () => {
    expect(splitHighlight('a+b (1).mp4', '(1)')).toEqual([
      { text: 'a+b ', hit: false },
      { text: '(1)', hit: true },
      { text: '.mp4', hit: false }
    ]);
  });

  it('works on the NFC form of a decomposed name', () => {
    const parts = splitHighlight('Йогурт'.normalize('NFD'), 'йо');
    expect(parts).toEqual([
      { text: 'Йо', hit: true },
      { text: 'гурт', hit: false }
    ]);
  });
});

describe('the explorer search asks the server for real queries only', () => {
  it('sends a blank or one-letter query as the unsearched list', () => {
    expect(effectiveSearchQuery('')).toBe('');
    expect(effectiveSearchQuery(' a ')).toBe('');
    expect(effectiveSearchQuery('ab')).toBe('ab');
  });
});

describe('account search', () => {
  const account = (name: string, agentId: string, note = ''): TeamAccountSummary =>
    ({
      id: `acc-${name}`,
      name,
      agents: [
        {
          rowId: `row-${agentId}`,
          agentId,
          runs: note ? [{ id: 'run', note, marker: null }] : []
        }
      ]
    }) as unknown as TeamAccountSummary;

  it('matches every word across the account and its agents', () => {
    const accounts = [account('Keto UA', '101'), account('Diet PL', '202')];
    expect(
      filterTeamAccounts(accounts, { occupancy: 'all', search: 'ua keto' }).map(a => a.name)
    ).toEqual(['Keto UA']);
    expect(
      filterTeamAccounts(accounts, { occupancy: 'all', search: 'keto 101' }).map(a => a.name)
    ).toEqual(['Keto UA']);
  });

  it('tries the other keyboard layout when nothing matches', () => {
    const accounts = [account('Кето', '101'), account('Diet', '202')];
    expect(
      filterTeamAccounts(accounts, { occupancy: 'all', search: 'rtnj' }).map(a => a.name)
    ).toEqual(['Кето']);
  });
});
