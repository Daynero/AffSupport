import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No file of the explorer is longer than 800 lines (070, SC-004, FR-001).
 *
 * `ExplorerShell.tsx` was 2 794 lines with the whole screen in one function, and that is why
 * the toolbar (024 T104) and the search's detail pane (024 T088) kept being put off: every
 * change to one part was a risk to all of it. It is split now — toolbar, selection, drop zone,
 * dialogs, process stack, results and the body's hooks each in their own file — and this
 * keeps it that way. A file that grows past the line is split the same way: by what it is
 * about, without a change of behaviour.
 */
const LIMIT = 800;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPLORER = path.join(ROOT, 'apps/web/src/team/explorer');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [full] : [];
  });
}

function lineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

describe('the explorer’s files', () => {
  it('are each at most 800 lines', () => {
    const files = sources(EXPLORER);
    expect(files.length).toBeGreaterThan(20);
    const over = files
      .map(file => ({ file: path.relative(ROOT, file), lines: lineCount(file) }))
      .filter(entry => entry.lines > LIMIT)
      .map(entry => `${entry.file}: ${entry.lines}`);
    expect(over).toEqual([]);
  });
});
