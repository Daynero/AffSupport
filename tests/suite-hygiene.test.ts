import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_DIRECTORY = path.join(import.meta.dirname, '.');

function testFiles(): string[] {
  return readdirSync(TEST_DIRECTORY)
    .filter(name => name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
    .sort();
}

function read(name: string): string {
  return readFileSync(path.join(TEST_DIRECTORY, name), 'utf8');
}

/**
 * Sleeping is legitimate in exactly two shapes, and both are about the code
 * under test rather than about this suite waiting for it.
 *
 * A stub that stands in for real work has to take a measurable amount of time,
 * or "these two ran at once" is unobservable. And a `setTimeout(…, 0)` is a
 * macrotask yield, not a delay — it is how you let a queued microtask drain
 * before asserting nothing else happened.
 */
const SLEEP_IS_THE_POINT: Record<string, string> = {
  'compressor-activity.test.ts':
    'a stub encoder that has to hold the activity long enough to observe',
  'landing-preview-catalog.test.ts': 'a stub renderer whose overlap is the assertion',
  'landing-preview-concurrency.test.ts': 'a stub renderer whose overlap is the assertion',
  'media-actions.test.ts': 'a stub converter that measures peak concurrency',
  'power-shared-budget.test.ts': 'a real sampling interval — the test measures the sampler',
  'agent-http.test.ts': 'a grace period after aborting a stream, before asserting cleanup',
  'pairing-token-boot.test.ts': 'a zero-delay macrotask yield for a BroadcastChannel delivery',
  'session-handoff-screens.test.tsx': 'a zero-delay yield before asserting no navigation happened',
  'transcription-translation.test.ts': 'a zero-delay yield named `tick`',
  'team-ux-feedback.test.tsx': 'a delay before asserting a toast did not re-fire',
  'transcription-media.manual.test.ts': 'a manual test that drives a real recording'
};

/**
 * Seven near-identical polling helpers accumulated across this suite before
 * `support/wait.ts` existed, each with its own deadline and its own unhelpful
 * "Timed out" message. They are gone. This keeps them gone: the failure a
 * developer sees here is cheaper than the one they would otherwise get at 2am
 * from a CI log that says only that something, somewhere, did not happen.
 */
describe('the suite has one way to wait', () => {
  it('defines no polling helper outside support/wait.ts', () => {
    const offenders = testFiles().filter(name =>
      /(?:async )?function (?:until|waitFor|waitUntil)\s*\(/u.test(read(name))
    );

    expect(offenders, 'import { waitFor } from ./support/wait.js instead').toEqual([]);
  });

  it('sleeps only where the delay is the thing being tested', () => {
    const offenders = testFiles().filter(
      name => /setTimeout\(resolve/u.test(read(name)) && !(name in SLEEP_IS_THE_POINT)
    );

    expect(
      offenders,
      'poll with waitFor, or add the file to SLEEP_IS_THE_POINT with the reason'
    ).toEqual([]);
  });

  it('keeps the allowlist honest about what is still in the tree', () => {
    // An entry that no longer describes anything is a claim nobody checked.
    const stale = Object.keys(SLEEP_IS_THE_POINT).filter(
      name => !testFiles().includes(name) || !/setTimeout\(resolve/u.test(read(name))
    );

    expect(stale, 'these files no longer sleep — drop them from the allowlist').toEqual([]);
  });
});
