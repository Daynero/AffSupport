import { describe, expect, it } from 'vitest';
import { moveOrderedId } from '../apps/web/src/team/accounts/order';

describe('moving a saved account or ad account', () => {
  it('uses the target edge and leaves unrelated membership in place', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(moveOrderedId(ids, 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
    expect(moveOrderedId(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveOrderedId(ids, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores a canceled, unknown or no-op target', () => {
    expect(moveOrderedId(['a', 'b'], 'a', 'a', 'before')).toBeNull();
    expect(moveOrderedId(['a', 'b'], 'a', 'missing', 'before')).toBeNull();
    expect(moveOrderedId(['a', 'b'], 'a', 'b', 'before')).toBeNull();
  });
});
