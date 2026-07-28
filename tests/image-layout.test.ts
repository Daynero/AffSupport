import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('responsive image embedding layout', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');

  it('stacks the two image columns on narrow screens', () => {
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.image-columns\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/
    );
  });

  it('keeps the controls in both image columns on the same row', () => {
    expect(css).toMatch(/\.image-column\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  });

  it('shows two complete image rows before enabling vertical scrolling', () => {
    const scrollBlock = css.match(/\.image-grid-scroll\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(scrollBlock).toMatch(/--image-grid-row-height:\s*124px/);
    expect(scrollBlock).toMatch(
      /max-height:\s*calc\(\s*var\(--image-grid-row-height\) \+ var\(--image-grid-row-height\) \+ var\(--image-grid-gap\) \+ 4px\s*\)/
    );
    expect(scrollBlock).toMatch(/overflow-y:\s*auto/);
    expect(scrollBlock).not.toMatch(/scrollbar-gutter:\s*stable/);
  });
});
