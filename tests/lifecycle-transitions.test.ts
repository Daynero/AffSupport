import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIFECYCLES,
  canTransition,
  edgesOf,
  statesOf,
  type AnyLifecycle
} from '../packages/shared/src/lifecycle.js';
import {
  setTransitionMode,
  transitionMode,
  wouldAllowTransition
} from '../apps/agent/src/queue/transitions.js';
import {
  DRIVERS,
  cleanUpDrivers,
  type Driver,
  type DriverMap
} from './support/lifecycle-drivers.js';

/**
 * The half that makes the tables mean something.
 *
 * `tests/lifecycle-wellformed.test.ts` proves the tables are coherent. Coherent is not the
 * same as true: a table can be perfectly well-formed and describe a machine the code does
 * not implement. These assertions connect the two — every declared edge is driven against a
 * real queue, every driver names a declared edge, and every **un**declared move is refused
 * without changing anything.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Edges with no driver yet, named rather than implied.
 *
 * This list may only shrink. Writing it down is the difference between "we know these are
 * uncovered and here they are" and a coverage assertion quietly scoped to whatever happens
 * to pass today. The remaining entries land with the rest of User Story 1.
 */
const UNDRIVEN: Readonly<Record<string, readonly string[]>> = {
  compression: [],
  transcription: [],
  translation: [],
  'landing-job': [],
  'landing-asset': [],
  'landing-preview-item': [],
  'media-action': []
};

const driversFor = (lifecycle: AnyLifecycle): DriverMap => DRIVERS[lifecycle.id] ?? {};
const edgeKeys = (lifecycle: AnyLifecycle) =>
  edgesOf(lifecycle).map(([from, to]) => `${from}->${to}`);

describe('driver coverage', () => {
  it.each(LIFECYCLES.map(lifecycle => [lifecycle.id, lifecycle] as const))(
    '%s: every driver names an edge the table declares',
    (_id, lifecycle) => {
      const declared = new Set(edgeKeys(lifecycle));
      const orphans = Object.keys(driversFor(lifecycle)).filter(key => !declared.has(key));

      // Table rot. A state removed from the table leaves its drivers behind, and they keep
      // passing against code nobody reaches any more.
      expect(orphans).toEqual([]);
    }
  );

  it.each(LIFECYCLES.map(lifecycle => [lifecycle.id, lifecycle] as const))(
    '%s: every declared edge is driven or named as undriven',
    (id, lifecycle) => {
      const driven = new Set(Object.keys(driversFor(lifecycle)));
      const excused = new Set(UNDRIVEN[id] ?? []);
      const uncovered = edgeKeys(lifecycle).filter(key => !driven.has(key) && !excused.has(key));

      // A new state added without a test fails here — this is the run-time half of SC-003,
      // and the reason a new state fails twice rather than once.
      expect(uncovered).toEqual([]);
    }
  );

  it.each(LIFECYCLES.map(lifecycle => [lifecycle.id, lifecycle] as const))(
    '%s: the undriven list names only real, undriven edges',
    (id, lifecycle) => {
      const declared = new Set(edgeKeys(lifecycle));
      const driven = new Set(Object.keys(driversFor(lifecycle)));
      const excuses = UNDRIVEN[id] ?? [];

      // The list may only shrink, and it may never excuse something that is either not an
      // edge at all or already covered — otherwise it stops describing the real gap.
      expect(excuses.filter(key => !declared.has(key))).toEqual([]);
      expect(excuses.filter(key => driven.has(key))).toEqual([]);
    }
  );
});

describe('drivers end where the table says', () => {
  afterAll(async () => {
    await cleanUpDrivers();
  });

  // `DriverMap` is `Partial`, so `Object.entries` types the value as possibly undefined.
  // Filtering rather than asserting: an entry explicitly set to `undefined` is not a driver,
  // and running it would be a crash rather than the failure the assertion is meant to give.
  const cases = LIFECYCLES.flatMap(lifecycle =>
    Object.entries(driversFor(lifecycle))
      .filter((entry): entry is [string, Driver] => typeof entry[1] === 'function')
      .map(([key, driver]) => [`${lifecycle.id} ${key}`, key, driver] as const)
  );

  it.each(cases)(
    '%s',
    async (_name, key, driver) => {
      const [from, to] = key.split('->');
      const observed = await driver();

      // Read from the queue, not asserted by the driver. A driver that quietly started in the
      // wrong state would otherwise pass while proving nothing about the edge it is named for.
      expect(observed.before).toBe(from);
      expect(observed.after).toBe(to);
      // Generous, because a driver boots a real queue and a real child process to perform one
      // transition. The alternative — faking the queue — would make the assertion meaningless.
    },
    40_000
  );
});

describe('undeclared moves are refused', () => {
  const original = transitionMode();

  beforeAll(() => {
    // The mechanism is permissive until the tables have been reconciled against a full suite
    // run, so refusal has to be asserted with it switched on. Doing it here rather than
    // waiting for the flip means FR-001 is covered by a test before it is relied on by users.
    setTransitionMode('strict');
  });

  afterAll(() => {
    setTransitionMode(original);
  });

  it.each(LIFECYCLES.map(lifecycle => [lifecycle.id, lifecycle] as const))(
    '%s refuses every move it does not declare',
    (_id, lifecycle) => {
      const refused: string[] = [];
      const wronglyAllowed: string[] = [];
      for (const from of statesOf(lifecycle)) {
        for (const to of statesOf(lifecycle)) {
          if (from === to) continue;
          // Asked, not taken. `decideTransition` would write every declared edge into the
          // reconciliation log, and the reconciliation would then agree with itself.
          const allowed = wouldAllowTransition(lifecycle, from, to);
          if (canTransition(lifecycle, from, to)) {
            if (!allowed) refused.push(`${from}->${to}`);
          } else if (allowed) {
            wronglyAllowed.push(`${from}->${to}`);
          }
        }
      }

      // Exhaustive over the whole state square, not a sample: the edge that matters is the
      // one nobody thought to write a case for.
      expect(wronglyAllowed).toEqual([]);
      expect(refused).toEqual([]);
    }
  );

  it('treats a move to the state already held as a no-op rather than a transition', () => {
    // The tables declare no self-edges, so a strict refusal here would break every caller
    // that re-asserts a status it already has — and recording it would report a table
    // violation for something that changes nothing.
    for (const lifecycle of LIFECYCLES)
      for (const state of statesOf(lifecycle))
        expect(wouldAllowTransition(lifecycle, state, state)).toBe(true);
  });
});

describe('the enforcement seam', () => {
  const OWNERS = [
    'apps/agent/src/queue/queue.ts',
    'apps/agent/src/queue/transcription-queue.ts',
    'apps/agent/src/landing/optimizer.ts',
    'apps/agent/src/landing-preview/catalog.ts'
  ];

  it.each(OWNERS)('%s writes a status only after the decision', async relative => {
    const source = await readFile(path.join(ROOT, relative), 'utf8');

    // "Leaves state unchanged and returns false" is a property of the shape, not of a test
    // case: the guard has to come before the assignment. Any direct `.status =` outside one
    // of these helpers is a write that escaped the decision entirely.
    const guards = [
      ...source.matchAll(
        /if \(!decideTransition\([^)]*\)\) return false;\n(\s*)(\w+)\.status = next;/g
      )
    ];
    expect(guards.length).toBeGreaterThan(0);

    const escaped = [...source.matchAll(/^\s*(?:this\.)?\w+\.status = (?!next;)[^;]+;$/gm)];
    expect(escaped.map(match => match[0].trim())).toEqual([]);
  });
});

/**
 * The reconciliation.
 *
 * The permissive mechanism appends every distinct edge the running code actually takes to
 * `SOTY_TRANSITION_LOG`. Running the whole suite with that set produces the real list, and
 * anything in it the tables do not declare is a **table** bug — the tables are the intent,
 * so a mismatch is a finding rather than something to paper over by widening them.
 *
 * Two passes, and they must be separate. The write variable is set for the run that
 * produces the log; the read variable is set for a later run that checks it. Doing both at
 * once would have this assertion read a file the other forks are still appending to, and it
 * would pass or fail on scheduling.
 *
 * Skipped with a named reason when no completed log has been handed to it: this is a claim
 * about a whole-suite run and a single file's worth of one cannot answer it.
 */
describe('observed edges match the declared tables', () => {
  const reportPath = process.env.SOTY_TRANSITION_REPORT?.trim() || '';
  const available = reportPath !== '' && existsSync(reportPath);

  it.skipIf(!available)(
    'records no edge the tables do not declare [needs: SOTY_TRANSITION_REPORT]',
    () => {
      const declared = new Set(
        LIFECYCLES.flatMap(lifecycle => edgeKeys(lifecycle).map(key => `${lifecycle.id}:${key}`))
      );
      const seen = new Set(
        readFileSync(reportPath, 'utf8')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
      );

      expect([...seen].filter(edge => !declared.has(edge)).sort()).toEqual([]);
    }
  );
});
