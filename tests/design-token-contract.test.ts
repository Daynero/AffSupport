import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The checker exists for a failure that is silent by construction.
 *
 * A `var()` naming a property nobody defined resolves to nothing, and CSS drops
 * the whole declaration — no warning, no error. An element renders without its
 * border, or without its background, and looks like somebody's design decision.
 * Eight of those were live when this was written, including a transition that
 * never ran.
 *
 * These assertions are about the checker rather than about today's stylesheet:
 * a checker that passes because it finds nothing is indistinguishable from one
 * that passes because it looks for nothing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLESHEET = path.join(root, 'apps/web/src/styles.css');
const CHECKER = path.join(root, 'scripts/verify-styles.mjs');

/** Runs the checker against a stylesheet of our own, never the committed one. */
function run(stylesheet: string) {
  try {
    execFileSync('node', [CHECKER, stylesheet], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, output: '' };
  } catch (error) {
    const thrown = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${thrown.stdout ?? ''}${thrown.stderr ?? ''}` };
  }
}

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A copy of the real stylesheet with a rule appended.
 *
 * A copy, emphatically. The first version of this test edited the committed
 * file and restored it afterwards — and the suite runs the same file in two
 * projects at once, so the restore of one raced the edit of the other and left
 * the stylesheet two lines long. A test that mutates the working tree is a test
 * that can destroy it.
 */
function stylesheetWith(rule: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wishly-tokens-'));
  scratchDirectories.push(directory);
  const copy = path.join(directory, 'styles.css');
  writeFileSync(copy, `${readFileSync(STYLESHEET, 'utf8')}\n${rule}\n`);
  return copy;
}

describe('the style checker', () => {
  it('passes on the stylesheet as committed', () => {
    expect(run(STYLESHEET).ok).toBe(true);
  });

  it('catches a property that is referenced and never defined', () => {
    const result = run(
      stylesheetWith('.token-contract-probe { color: var(--a-property-nobody-defined); }')
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('--a-property-nobody-defined');
  });

  it('accepts a reference that carries a fallback', () => {
    // A fallback makes the declaration render something, which is the whole
    // difference between a missing token and a broken rule.
    expect(run(stylesheetWith('.probe { color: var(--also-undefined, #000); }')).ok).toBe(true);
  });

  it('accepts a property a component sets at runtime', () => {
    // `--compare-position` is assigned by ImageCompareModal. It is not declared
    // in the stylesheet and is not a bug; a checker that flagged it would be
    // one people learn to ignore.
    expect(run(stylesheetWith('.probe { left: var(--compare-position); }')).ok).toBe(true);
  });
});
