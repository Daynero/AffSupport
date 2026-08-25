import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The set of routes the application answers, and the set the accessibility
 * sweep walks, have to be the same set.
 *
 * They are written down twice — once as comparisons in the router, once as a
 * list in the sweep — and nothing connected them. A route added to the router
 * was simply never swept, and the sweep stayed green by not looking. That is
 * the worst shape a check can have: it reports success for the part it forgot.
 *
 * This does not try to unify them, because the router's list is deliberately
 * fuller: it includes routes a signed-out visitor cannot reach and the sweep
 * therefore cannot render. It asserts the containment that matters — every
 * route the sweep walks must exist in the router — and names the ones the
 * sweep skips, so the gap is a decision rather than an oversight.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = readFileSync(path.join(root, 'apps/web/src/Root.tsx'), 'utf8');
const SWEEP = readFileSync(path.join(root, 'scripts/verify-a11y.mjs'), 'utf8');

/** Every literal path the router compares against. */
function routerPaths(): string[] {
  return [...ROUTER.matchAll(/path === '([^']+)'/gu)].map(match => match[1]).sort();
}

/** The routes the accessibility sweep walks. */
function sweptPaths(): string[] {
  const list = /const ROUTES = \[([^\]]+)\]/u.exec(SWEEP)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/gu)].map(match => match[1]).sort();
}

describe('the route matrix', () => {
  it('finds routes on both sides', () => {
    // A guard on the guard: an empty list either side would make the
    // containment below trivially true.
    expect(routerPaths().length).toBeGreaterThan(2);
    expect(sweptPaths().length).toBeGreaterThan(2);
  });

  it('sweeps only routes the router actually serves', () => {
    const router = new Set(routerPaths());
    const missing = sweptPaths().filter(route => !router.has(route));
    // A swept route the router does not answer renders the fallback, and the
    // sweep then reports a clean page that nobody can reach.
    expect(missing).toEqual([]);
  });

  it('records which router routes are not swept', () => {
    const swept = new Set(sweptPaths());
    const unswept = routerPaths().filter(route => !swept.has(route));
    // These need a signed-in session or an OAuth round trip, so a headless
    // sweep cannot render them. Listing them here means adding a public route
    // and forgetting to sweep it shows up as a change to this expectation
    // rather than as silence.
    expect(unswept).toEqual(['/auth/callback']);
  });
});
