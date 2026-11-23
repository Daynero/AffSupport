import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * next QA 2026-11-17: a folder selected in the files list showed an empty grey box in the
 * detail pane. The fallback glyph is sized in cqmin, and the pane's frame was no size
 * container, so the glyph measured an ancestor, grew to 306×910 and fell below the frame.
 */
it('sizes a fallback glyph against the frame it is drawn in, on a tile and in the pane', () => {
  // The explorer's rules moved to their own sheet (070, FR-042); the pane's stayed.
  const css = ['apps/web/src/styles.css', 'apps/web/src/styles/explorer.css']
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');
  expect(css).toMatch(/\.team-explorer-tile-icon \.team-kind-icon\s*\{[^}]*\d+cqmin/u);
  for (const frame of ['.team-explorer-tile-visual', '.team-material-detail-visual']) {
    const blocks = [
      ...css.matchAll(new RegExp(`^${frame.replace(/\./gu, '\\.')}\\s*\\{([^}]*)\\}`, 'gmu'))
    ].map(match => match[1]);
    expect(blocks.join('\n'), frame).toMatch(/container-type:\s*size/u);
  }
});
