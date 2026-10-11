// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_QUERY_LIMIT,
  clearRecentQueries,
  forgetQuery,
  readRecentQueries,
  recentQueryKey,
  rememberQuery
} from '../apps/web/src/team/palette/recent';

/** Search rework (2026-10): the searches used lately, one store per space. */

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('recent searches', () => {
  it('keeps the newest first and tells queries apart by case and spacing only', () => {
    rememberQuery('t1', { query: 'keto UA' }, 1);
    rememberQuery('t1', { query: 'banner' }, 2);
    const list = rememberQuery('t1', { query: '  KETO   ua ', scope: 'folder' }, 3);
    expect(list.map(entry => entry.query)).toEqual(['KETO ua', 'banner']);
    expect(list[0]).toMatchObject({ scope: 'folder', at: 3 });
    expect(readRecentQueries('t1')).toEqual(list);
    expect(localStorage.getItem('soty.search.recent.t1')).not.toBeNull();
  });

  it('never keeps a blank or one-letter query', () => {
    expect(rememberQuery('t1', { query: '' })).toEqual([]);
    expect(rememberQuery('t1', { query: ' a ' })).toEqual([]);
    expect(readRecentQueries('t1')).toEqual([]);
  });

  it('holds the last ten', () => {
    for (let index = 0; index < RECENT_QUERY_LIMIT + 3; index += 1) {
      rememberQuery('t1', { query: `query ${index}` }, index);
    }
    const list = readRecentQueries('t1');
    expect(list).toHaveLength(RECENT_QUERY_LIMIT);
    expect(list[0]!.query).toBe(`query ${RECENT_QUERY_LIMIT + 2}`);
  });

  it('keeps the kind filter only when one was set', () => {
    expect(rememberQuery('t1', { query: 'hook', kinds: ['video'] })[0]).toMatchObject({
      kinds: ['video']
    });
    expect(rememberQuery('t1', { query: 'hook', kinds: [] })[0]!.kinds).toBeUndefined();
  });

  it('forgets one, or all, and keeps spaces apart', () => {
    rememberQuery('t1', { query: 'keto' });
    rememberQuery('t1', { query: 'banner' });
    rememberQuery('t2', { query: 'other space' });
    expect(forgetQuery('t1', 'KETO').map(entry => entry.query)).toEqual(['banner']);
    clearRecentQueries('t1');
    expect(readRecentQueries('t1')).toEqual([]);
    expect(readRecentQueries('t2').map(entry => entry.query)).toEqual(['other space']);
  });

  it('survives storage that refuses or holds garbage', () => {
    localStorage.setItem('soty.search.recent.t1', '{not json');
    expect(readRecentQueries('t1')).toEqual([]);
    localStorage.setItem(
      'soty.search.recent.t1',
      JSON.stringify([{ query: 'ok query', scope: 'space', at: 1 }, { query: 1 }, 'x'])
    );
    expect(readRecentQueries('t1').map(entry => entry.query)).toEqual(['ok query']);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => rememberQuery('t1', { query: 'still fine' })).not.toThrow();
  });

  it('normalises the key a query is told apart by', () => {
    expect(recentQueryKey('  Кето   UA ')).toBe('кето ua');
  });
});
