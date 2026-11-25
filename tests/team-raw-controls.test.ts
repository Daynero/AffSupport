import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Raw controls in the team workspace (070, FR-041; from 024 T137).
 *
 * Every `<button>`, `<input>`, `<select>` and `<textarea>` written by hand
 * under `apps/web/src/team/` is a control that draws its own focus ring, its
 * own height and its own disabled look — the reason two buttons side by side
 * did not line up. The inventory has one of each.
 *
 * **A gate since 070 T065.** It ran in report mode while the screens moved to
 * the inventory one phase at a time; from T065 one raw control outside
 * `ALLOWED` fails the suite.
 */

/**
 * Raw on purpose, each with its reason. An entry names the file and how many
 * raw controls it may hold — a fourth `<button>` in `TagDot` still fails.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  // The colour tag is a press-drag-release gesture (like a macOS pop-up menu):
  // `pointerdown` on the dot opens the swatches at once and drops `draggable`
  // from the row, and releasing over a swatch picks it through
  // `swatch.click()`/`swatch.disabled`. React Aria's press handling owns the
  // pointer and stops `pointerdown`/`mousedown`, and `DropdownMenu` has neither
  // a swatch grid nor pick-on-release; `tests/tag-dot-gestures` pins the
  // gesture. Moving it to the inventory is its own task, checked on touch.
  'apps/web/src/team/explorer/TagDot.tsx': {
    count: 3,
    reason: 'press-drag-release colour gesture (070 findings, phase 8b)'
  },
  // The schedule picker's cadence tiles, its custom tile, the weekday keys and the time
  // field's clock, as the owner drew them: `SegmentedControl` drew the tiles as a cramped
  // strip, and the owner asked for the tiles back (070, phase 9д).
  'apps/web/src/team/catalog-updater/UpdaterIntervalPicker.tsx': {
    count: 4,
    reason: "the owner's schedule tiles and weekday keys (070 findings, phase 9д)"
  }
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAM = path.join(ROOT, 'apps/web/src/team');
const RAW = /<(button|input|select|textarea)(?=[\s/>])/gu;

/** Comments go first: prose that names `<button>` is not a button. */
function withoutComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/gu, match => match.replace(/[^\n]/gu, ' '))
    .replace(/\/\*[\s\S]*?\*\//gu, match => match.replace(/[^\n]/gu, ' '))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/gu,
      (match, lead: string) => lead + ' '.repeat(match.length - lead.length)
    );
}

type RawControl = { file: string; line: number; element: string };

function rawControls(source: string, file = '<source>'): RawControl[] {
  const clean = withoutComments(source);
  const found: RawControl[] = [];
  for (const match of clean.matchAll(RAW)) {
    const line = clean.slice(0, match.index).split('\n').length;
    found.push({ file, line, element: match[1]! });
  }
  return found;
}

function sources(directory: string, pattern = /\.tsx$/u): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

describe('raw controls under team/', () => {
  it('finds each of the four, and not the inventory or prose', () => {
    const sample = [
      '<button type="button">a</button>',
      '<input value="" />',
      '<select>',
      '<textarea\n  rows={2}\n/>',
      '<Button>inventory</Button>',
      '<buttonish />',
      '/* a <button> in a comment */',
      '{/* <input> in JSX prose */}',
      '// <select> after a slash'
    ].join('\n');
    expect(rawControls(sample).map(control => control.element)).toEqual([
      'button',
      'input',
      'select',
      'textarea'
    ]);
  });

  it('has none outside the allowlist', () => {
    const found = sources(TEAM).flatMap(file =>
      rawControls(readFileSync(file, 'utf8'), path.relative(ROOT, file))
    );
    const byFile = new Map<string, RawControl[]>();
    for (const control of found) {
      byFile.set(control.file, [...(byFile.get(control.file) ?? []), control]);
    }
    const unexpected = [...byFile].filter(
      ([file, controls]) => controls.length > (ALLOWED[file]?.count ?? 0)
    );
    const report = unexpected
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([file, controls]) =>
          `  ${controls.length}  ${file}  ${controls.map(c => `${c.line}:${c.element}`).join(' ')}`
      )
      .join('\n');
    expect(unexpected, `raw controls under team/:\n${report}`).toEqual([]);
    // The scan has to be looking at something for its silence to mean anything.
    expect(sources(TEAM).length).toBeGreaterThan(50);
  });

  it('keeps the allowlist honest: every entry still has its raw controls', () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      const found = rawControls(readFileSync(path.join(ROOT, file), 'utf8'), file);
      expect(found.length, `${file} — drop or lower its allowlist entry`).toBe(count);
    }
  });
});

/**
 * The other two counts of SC-002 (070 T065): the pre-021 shim is gone, and so
 * is the `data-tip` attribute `HintLayer` replaced. Both stay gone.
 */
describe('the shim and data-tip under apps/web/src', () => {
  const WEB = path.join(ROOT, 'apps/web/src');
  const code = sources(WEB, /\.(ts|tsx)$/u).map(file => ({
    file: path.relative(ROOT, file),
    source: withoutComments(readFileSync(file, 'utf8'))
  }));

  it('has no components/ui.tsx: `components/ui` is the inventory', () => {
    // With the file back, `components/ui` would resolve to it before the
    // directory's index — the two generations side by side again.
    expect(existsSync(path.join(WEB, 'components/ui.tsx'))).toBe(false);
    expect(code.length).toBeGreaterThan(200);
  });

  it('writes no data-tip', () => {
    const found = code.filter(({ source }) => /data-tip\b/u.test(source)).map(({ file }) => file);
    expect(found).toEqual([]);
  });
});
