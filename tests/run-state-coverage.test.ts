import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FR-018a / SC-003. Membership of the critical set is *derived*, never typed by
 * hand.
 *
 * A hand-maintained list of modules that must be covered has one failure mode,
 * and it is the only one that matters: the module someone adds tomorrow is not
 * on it. So this walks the import graph from the modules that own run state and
 * asserts that everything it reaches is listed — which means adding a state
 * module without listing it fails here, rather than silently inheriting the
 * global ratchet and being excused by an average.
 *
 * The walk is deliberately crude — a regex over import specifiers, not a
 * TypeScript program. It needs to answer "which first-party modules does this
 * one pull in", it must not need a compiler to do it, and being wrong in the
 * direction of listing too much is harmless: an extra module with a floor is
 * simply a module that has to stay covered.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRITICAL_FILE = path.join(root, 'coverage-critical.json');

/**
 * Where run state is born, carried and shown.
 *
 * Each of these owns a status a user can see: the queues that run work, the
 * transition tables that constrain them, the lifecycle vocabulary they share,
 * and the governor whose budget decides what is running at all.
 */
const RUN_STATE_ENTRY_POINTS = [
  'apps/agent/src/queue/queue.ts',
  'apps/agent/src/queue/transitions.ts',
  'apps/agent/src/queue/transcription-queue.ts',
  'apps/agent/src/media-actions/queue.ts',
  'apps/agent/src/power/governor.ts',
  'packages/shared/src/lifecycle.ts'
];

/** Import and re-export specifiers, static and dynamic. */
const SPECIFIER = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/gu;

/** Resolves a relative specifier the way NodeNext does: `.js` on disk is `.ts`. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.js$/u, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts')
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function walkFrom(entryPoints: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entryPoints.map(entry => path.join(root, entry));
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (seen.has(relative)) continue;
    if (!existsSync(file)) continue;
    seen.add(relative);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

describe('the critical-module set is derived, not typed', () => {
  it('lists every module reachable from a run-state entry point', () => {
    const reachable = walkFrom(RUN_STATE_ENTRY_POINTS);
    const critical = JSON.parse(readFileSync(CRITICAL_FILE, 'utf8')) as {
      modules: Record<string, number>;
    };
    const listed = new Set(Object.keys(critical.modules));

    const missing = [...reachable].filter(module => !listed.has(module)).sort();
    // The failure message is the fix: each path here needs a floor in
    // coverage-critical.json, or the module does not belong in the run-state
    // graph and its import should be reconsidered.
    expect(missing).toEqual([]);
  });

  it('reaches every entry point it was given', () => {
    // A typo in the list above would silently shrink the critical set to
    // nothing while still passing the assertion below it.
    const reachable = walkFrom(RUN_STATE_ENTRY_POINTS);
    for (const entry of RUN_STATE_ENTRY_POINTS) expect(reachable.has(entry)).toBe(true);
  });

  it('gives every listed module a floor between 0 and 100', () => {
    const critical = JSON.parse(readFileSync(CRITICAL_FILE, 'utf8')) as {
      modules: Record<string, number>;
    };
    for (const [module, floor] of Object.entries(critical.modules)) {
      expect(typeof floor, module).toBe('number');
      expect(floor, module).toBeGreaterThanOrEqual(0);
      expect(floor, module).toBeLessThanOrEqual(100);
    }
  });
});
