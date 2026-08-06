import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { motionAllowed, preferredTheme } from '../apps/soty-review/src/review/theme.js';

describe('Soty motion and theme fallbacks', () => {
  it('disables motion when requested and chooses a deterministic theme', () => {
    expect(motionAllowed({ matches: true })).toBe(false);
    expect(preferredTheme('dark', false)).toBe('dark');
    expect(preferredTheme(undefined, true)).toBe('dark');
  });

  it('provides static reduced-motion CSS', () => {
    const css = readFileSync('apps/soty-review/src/styles.css', 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.soty-progress.is-indeterminate');
  });
});
