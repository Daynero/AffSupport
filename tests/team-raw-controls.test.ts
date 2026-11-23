import { readFileSync, readdirSync } from 'node:fs';
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
 * **Report mode until 070 T065.** The list is printed and the test passes: the
 * screens move to the inventory one phase at a time, and a gate that is red
 * for the whole migration teaches everyone to skip it. T065 sets `GATE` to
 * `true`, and from then on one raw control fails the suite.
 */
const GATE = false;

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

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
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

  it(GATE ? 'has none' : 'lists them (report only until T065)', () => {
    const found = sources(TEAM).flatMap(file =>
      rawControls(readFileSync(file, 'utf8'), path.relative(ROOT, file))
    );
    const byFile = new Map<string, RawControl[]>();
    for (const control of found) {
      byFile.set(control.file, [...(byFile.get(control.file) ?? []), control]);
    }
    const report = [...byFile]
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([file, controls]) =>
          `  ${controls.length}  ${file}  ${controls.map(c => `${c.line}:${c.element}`).join(' ')}`
      )
      .join('\n');
    if (GATE) {
      expect(found, `raw controls under team/:\n${report}`).toEqual([]);
      return;
    }
    console.info(
      `team-raw-controls (report only until 070 T065): ${found.length} raw control(s) in ` +
        `${byFile.size} file(s)\n${report}`
    );
    // The scan has to be looking at something for its silence to mean anything.
    expect(sources(TEAM).length).toBeGreaterThan(50);
  });
});
