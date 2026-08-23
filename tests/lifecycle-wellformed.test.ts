import { describe, expect, it } from 'vitest';
import {
  LIFECYCLES,
  edgesOf,
  isTerminal,
  statesOf,
  type AnyLifecycle
} from '../packages/shared/src/lifecycle.js';

/**
 * The tables have to be well-formed before enforcing them can mean anything.
 *
 * These are the cheapest assertions in the feature and they run against every registered
 * lifecycle, so a table added next year is covered without anyone adding a test. The
 * expensive half — that the running code actually takes the edges declared here — lives in
 * `tests/lifecycle-transitions.test.ts`.
 *
 * A note on what is *not* asserted: that every lifecycle has a terminal state. The
 * compression and transcription tables have none, because every finished state can be
 * re-entered by re-running. That is FR-008 working as specified, not an omission, so the
 * rule is stated below in the form that is actually true.
 */

/** Every registered lifecycle, named so a failure says which one. */
const CASES: readonly [string, AnyLifecycle][] = LIFECYCLES.map(lifecycle => [
  lifecycle.id,
  lifecycle
]);

describe.each(CASES)('%s lifecycle', (_id, lifecycle) => {
  it('starts in a state it declares', () => {
    expect(statesOf(lifecycle)).toContain(lifecycle.initial);
  });

  it('names only states it declares as targets', () => {
    const declared = new Set<string>(statesOf(lifecycle));
    const dangling = edgesOf(lifecycle)
      .filter(([, to]) => !declared.has(to))
      .map(([from, to]) => `${from}->${to}`);

    // A target that is not a key is a state the table can enter and never leave, and
    // `canTransition` would answer false for everything from there.
    expect(dangling).toEqual([]);
  });

  it('declares no self-edges', () => {
    // Moving to the state you are already in is a no-op, not a transition. Declaring it
    // would make the enforcement in the queue accept a write that changes nothing, and
    // every driver for such an edge would trivially pass.
    expect(edgesOf(lifecycle).filter(([from, to]) => from === to)).toEqual([]);
  });

  it('can reach every state from the initial one', () => {
    const reached = new Set<string>([lifecycle.initial]);
    const queue: string[] = [lifecycle.initial];
    while (queue.length > 0) {
      const from = queue.pop() as string;
      for (const [start, to] of edgesOf(lifecycle)) {
        if (start !== from || reached.has(to)) continue;
        reached.add(to);
        queue.push(to);
      }
    }

    // An unreachable state is either dead code or a missing edge, and both are worth
    // knowing. It is also unprovable by driver: no test could ever put a run into it.
    expect(statesOf(lifecycle).filter(state => !reached.has(state))).toEqual([]);
  });

  it('gives every non-terminal state somewhere to go', () => {
    // Vacuous as written — `isTerminal` is defined as having no outgoing edges — but it
    // states the intent, and it is the assertion that would fail first if `isTerminal` were
    // ever redefined in terms of a hand-listed set of statuses.
    const outgoing = new Map<string, number>();
    for (const state of statesOf(lifecycle)) outgoing.set(state, 0);
    for (const [from] of edgesOf(lifecycle)) outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    const stuck = statesOf(lifecycle).filter(
      state => !isTerminal(lifecycle, state) && (outgoing.get(state) ?? 0) === 0
    );
    expect(stuck).toEqual([]);
  });
});

describe('the registry', () => {
  it('gives every lifecycle a unique id', () => {
    const ids = LIFECYCLES.map(lifecycle => lifecycle.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes a run-level lifecycle re-runnable and a sub-run lifecycle final', () => {
    const terminals = (lifecycle: AnyLifecycle) =>
      statesOf(lifecycle).filter(state => isTerminal(lifecycle, state));

    // The distinction is the whole reason the terminal rule is not universal. A compression
    // that finished can be run again; a translation that finished is done, and offering to
    // resume one would be the interface lying.
    //
    // `landing-job` sits on the finished side, which reconciling the tables against a real
    // run is what established: `queue()` accepts only a `ready` job and nothing returns a
    // finished one to `ready`, so running the same landing again means uploading it again.
    for (const id of ['compression', 'transcription', 'landing-preview-item']) {
      const lifecycle = LIFECYCLES.find(candidate => candidate.id === id) as AnyLifecycle;
      expect(terminals(lifecycle), `${id} should have no terminal state`).toEqual([]);
    }
    for (const id of ['translation', 'landing-asset', 'media-action', 'landing-job']) {
      const lifecycle = LIFECYCLES.find(candidate => candidate.id === id) as AnyLifecycle;
      expect(terminals(lifecycle).length, `${id} should have a terminal state`).toBeGreaterThan(0);
    }
  });
});
