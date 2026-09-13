import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An animation that names nothing (021).
 *
 * `animation: menu-pop 220ms ease` with no `@keyframes menu-pop` anywhere is
 * silent: the browser drops it, the surface appears without its entrance, and
 * it reads as a decision. One was live when this was written — the user menu
 * had named a keyframe set that never existed.
 *
 * The sibling failure — a `var()` naming a property nobody declared — is caught
 * by `scripts/verify-styles.mjs`; this is the same class of defect one layer
 * along.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const SHEET_DIR = path.join(ROOT, 'apps/web/src/styles');
const SHEETS = [
  path.join(ROOT, 'apps/web/src/styles.css'),
  ...readdirSync(SHEET_DIR)
    .filter(entry => entry.endsWith('.css'))
    .map(entry => path.join(SHEET_DIR, entry))
];

const css = SHEETS.map(sheet => readFileSync(sheet, 'utf8')).join('\n');
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Names CSS itself would never take for a keyframe set. */
const NOT_A_NAME = new Set([
  'none',
  'inherit',
  'initial',
  'unset',
  'revert',
  'infinite',
  'alternate',
  'alternate-reverse',
  'reverse',
  'normal',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end'
]);

describe('the stylesheets', () => {
  it('never names a keyframe set that does not exist', () => {
    const declared = new Set(
      [...withoutComments.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map(match => match[1])
    );
    const missing = new Set<string>();
    for (const match of withoutComments.matchAll(/animation(?:-name)?:\s*([^;}]+)/g)) {
      for (const part of match[1].split(',')) {
        for (const token of part.trim().split(/\s+/)) {
          if (!/^[A-Za-z_][\w-]*$/.test(token)) continue;
          if (NOT_A_NAME.has(token) || token.startsWith('var(')) continue;
          if (!declared.has(token)) missing.add(token);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('gives a registered property a value it can actually start from', () => {
    /*
     * `@property`'s `initial-value` has to be computationally independent, so a
     * `var()` there is invalid CSS. The browser drops the registration in
     * silence — and the production minifier refuses the whole stylesheet, which
     * is how this was found: `npm run build` stopped working.
     */
    for (const block of withoutComments.matchAll(/@property[^{]*\{([^}]*)\}/g)) {
      const initial = /initial-value:\s*([^;]+)/.exec(block[1]);
      expect(initial, 'a registered property needs an initial-value').not.toBeNull();
      expect(initial![1]).not.toContain('var(');
    }
  });

  it('opens an anchored surface from 0.95, not from nothing', () => {
    // docs/DESIGN-PRINCIPLES.md: animating from `scale(0)` looks like a glitch.
    for (const name of ['pop-in', 'ui-surface-in']) {
      const block = withoutComments.slice(withoutComments.indexOf(`@keyframes ${name}`));
      expect(block.slice(0, block.indexOf('}')), name).toContain('scale(0.95)');
    }
  });
});
