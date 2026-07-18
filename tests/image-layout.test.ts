import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('responsive image embedding layout', () => {
  it('stacks the two image columns on narrow screens', () => {
    const css = readFileSync('apps/web/src/styles.css', 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.image-columns\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/
    );
  });
});
