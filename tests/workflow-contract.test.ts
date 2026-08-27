import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * B11. What CI runs has to stay the same thing a developer runs, and the two
 * ways it silently stopped being the same were both mechanical.
 *
 * A pinned Node version: three workflows each pinned a literal, two of them
 * disagreeing with `.nvmrc` and with each other, so "works locally" and "works
 * in CI" were claims about different runtimes. And a hand-maintained list of
 * test paths: it goes stale on the first rename, and a path that no longer
 * exists is not an error in a shell — it is a shorter test run that still
 * reports green.
 *
 * Neither is caught by review reliably, so neither is left to review.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = path.join(root, '.github/workflows');

function workflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => ({ name, source: readFileSync(path.join(WORKFLOW_DIR, name), 'utf8') }));
}

describe('every workflow', () => {
  it('exists at all', () => {
    // A guard on the guard: an empty directory would make every assertion below
    // pass while checking nothing.
    expect(workflows().length).toBeGreaterThan(0);
  });

  it.each(workflows())(
    'reads the Node version from a file rather than pinning it: $name',
    ({ source }) => {
      const pinned = [...source.matchAll(/node-version:\s*['"]?(\d+[^\s'"]*)/gu)].map(
        match => match[1]
      );
      expect(pinned).toEqual([]);
    }
  );

  it.each(workflows())('names no test path that does not exist: $name', ({ source }) => {
    const referenced = [...source.matchAll(/(tests\/[\w./-]+\.test\.tsx?)/gu)].map(
      match => match[1]
    );
    const missing = referenced.filter(candidate => !existsSync(path.join(root, candidate)));
    // A stale path in a workflow is worse than a failing test: the run stays
    // green and simply covers less than it says it does.
    expect(missing).toEqual([]);
  });
});

describe('the verification workflow', () => {
  const verify = readFileSync(path.join(WORKFLOW_DIR, 'verify.yml'), 'utf8');
  const aggregator = readFileSync(path.join(root, 'scripts/verify-all.mjs'), 'utf8');

  it('runs the four jobs that gate a merge', () => {
    for (const job of ['static:', 'test-macos:', 'test-windows:', 'build:']) {
      expect(verify).toContain(job);
    }
  });

  it('invokes the aggregator rather than spelling gates out again', () => {
    // The whole point: CI and a laptop run the same command. A job that listed
    // its own steps would drift the first time a gate was added.
    const invocations = [...verify.matchAll(/scripts\/verify-all\.mjs\s+--form=\S+/gu)];
    expect(invocations.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the expensive end-to-end job off ordinary pull requests', () => {
    expect(verify).toMatch(/if:.*github\.event_name == 'push'/u);
  });

  it('keeps the ordinary suite on the unit project', () => {
    // Real-media e2e tests become intentionally expensive when FFmpeg is
    // installed. They belong to the separately scheduled e2e job, not the
    // suite that every required macOS and Windows check runs.
    expect(aggregator).toContain("'--project=unit'");
  });

  it('cancels superseded runs', () => {
    expect(verify).toContain('cancel-in-progress: true');
  });
});
