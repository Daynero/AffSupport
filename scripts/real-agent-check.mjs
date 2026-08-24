#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A shim over the end-to-end suites, and deliberately nothing more.
 *
 * This script used to boot its own agent, pair with it, and carry five hundred
 * lines of assertions that existed nowhere else — which meant two boot
 * sequences for the same job, two places to get process cleanup wrong, and a
 * body of checks with no runner, no report and no way to skip with a reason
 * when a binary was missing (B10). The assertions moved into
 * `tests/real-media-e2e.test.ts` and `tests/interleaving-e2e.test.ts` verbatim;
 * what is left is the entry point that release automation already calls.
 *
 * One boot path now: `tests/support/agent-process.ts`. If it is wrong, it is
 * wrong once.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The release profile makes an absent requirement **throw** rather than skip.
 *
 * On a release runner a missing binary must fail loudly and name itself: a run
 * that quietly reports zero skips because nothing ran looks exactly like a
 * clean one.
 */
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'vitest',
    'run',
    'tests/real-media-e2e.test.ts',
    'tests/interleaving-e2e.test.ts',
    '--reporter=dot'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, SOTY_REQUIRE_ALL: '1' }
  }
);

process.exit(result.status ?? 1);
