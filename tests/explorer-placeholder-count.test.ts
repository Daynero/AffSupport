import { describe, expect, it } from 'vitest';
import { placeholderCount } from '../apps/web/src/team/explorer/placeholderCount';

describe('a folder on its way draws what the tree counts (owner, 25.11)', () => {
  it('draws as many placeholders as the folder holds', () => {
    expect(placeholderCount(3, 4)).toBe(3);
    expect(placeholderCount(1, 8)).toBe(1);
  });
  it('draws none for an empty folder, and no more than a screenful for a large one', () => {
    expect(placeholderCount(0, 4)).toBe(0);
    expect(placeholderCount(26, 4)).toBe(12);
  });
  it('falls back to the handful only when the folder is not counted yet', () => {
    expect(placeholderCount(null, 4)).toBe(4);
    expect(placeholderCount(undefined, 8)).toBe(8);
  });
});
