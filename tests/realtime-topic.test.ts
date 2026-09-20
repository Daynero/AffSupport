import { describe, expect, it } from 'vitest';
import { realtimeTopic } from '../apps/web/src/lib/realtimeTopic';

/**
 * Two subscribers to the same thing get two channels (024).
 *
 * `supabase.channel(name)` returns the channel already registered under a
 * name; the second subscriber then called `.on()` on a subscribed channel, and
 * the exception took the page down — Space settings → Tags with Tasks open.
 */
describe('realtimeTopic', () => {
  it('never hands the same name to two subscribers', () => {
    const names = Array.from({ length: 5 }, () => realtimeTopic('team-labels:task:space-1'));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith('team-labels:task:space-1#')).toBe(true);
  });
});
