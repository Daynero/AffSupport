import { appendFileSync } from 'node:fs';
import { canTransition, type AnyLifecycle } from '@video-compressor/shared';

/**
 * The one place a status change is decided, for every tool.
 *
 * Each queue owns a `transition(entity, next)` method; this is the shared body behind them.
 * Splitting it out is what makes the rollout possible: the mechanism can be permissive
 * everywhere at once, and strict everywhere at once, without four near-identical edits.
 *
 * **It was permissive first, and that mattered.** Enforcing a wrong table is the one real risk
 * in declaring these tables at all — a legal transition the table forgot becomes a 409 the
 * user cannot get past. So the mechanism shipped recording-only: it observed every edge the
 * running code actually takes and blocked nothing. The full suite run that followed found
 * four tables describing a machine the code does not implement, and each was fixed as a
 * **table** bug before enforcement was switched on.
 *
 * The recording half stays useful after the switch: `tests/lifecycle-transitions.test.ts`
 * reads it back to assert the code takes no edge the tables do not declare.
 */

export type TransitionMode = 'permissive' | 'strict';

/**
 * **Strict.** The tables have been reconciled against a full suite run.
 *
 * It shipped permissive, recording every edge the running code actually took and blocking
 * nothing, and that run found four tables describing a machine the code does not implement —
 * a compression re-run goes back to `ready` rather than straight to `queued`, an interrupted
 * run whose encode had finished completes rather than re-encoding, a preempted translation
 * returns to `queued` rather than failing, and a landing job is not re-runnable at all. Those
 * were table bugs, fixed in `packages/shared/src/lifecycle.ts`. Enforcing the first draft
 * would have turned each of them into a refusal a user could not get past.
 *
 * `tests/lifecycle-transitions.test.ts` re-checks the reconciliation from the recorded log,
 * so the switch cannot silently drift back out of agreement.
 *
 * Deliberately a module-level switch rather than a constructor argument: the point of the
 * rollout is that all four owners change together, and a per-owner setting would let one of
 * them be forgotten in exactly the way this feature exists to stop.
 */
let mode: TransitionMode = 'strict';

export function transitionMode(): TransitionMode {
  return mode;
}

export function setTransitionMode(next: TransitionMode): void {
  mode = next;
}

/** `lifecycleId:from->to`, the form the reconciliation reads. */
export type ObservedEdge = string;

const observed = new Set<ObservedEdge>();

/**
 * Where to write newly-seen edges, if anywhere.
 *
 * Read once. The suite runs in several forks with separate memory, so an in-memory set alone
 * could only ever report one fork's share; the file is how the reconciliation sees all of
 * them. Read once and only when set, so nothing is written on a normal run.
 */
const logPath = process.env.SOTY_TRANSITION_LOG?.trim() || null;

export function observedEdges(): ReadonlySet<ObservedEdge> {
  return observed;
}

export function resetObservedEdges(): void {
  observed.clear();
}

/**
 * Decides one status change and records it.
 *
 * Returns whether the caller may apply it. In permissive mode that is always true; in strict
 * mode it is what the table says, and a false answer means the caller **leaves the entity
 * exactly as it was** — never throws, never half-applies. Routes map false to
 * `409 TRANSITION_NOT_ALLOWED`.
 *
 * A move to the state the entity is already in is a no-op rather than a transition, and is
 * allowed without being recorded: the tables declare no self-edges, so recording one would
 * report a table violation for something that changes nothing.
 */
export function decideTransition<S extends string>(
  lifecycle: AnyLifecycle,
  from: S,
  to: S
): boolean {
  const allowed = wouldAllowTransition(lifecycle, from, to);
  // Recorded only when it was actually applied. The log answers "what does the running code
  // do", and an edge that was refused is an edge the code did not take — counting it would
  // make every strict-mode refusal look like a table violation.
  if (allowed && from !== to) record(lifecycle.id, from, to);
  return allowed;
}

/**
 * The rule alone, with nothing recorded.
 *
 * For a test that probes what the mechanism *would* say rather than performing a change.
 * The distinction is load-bearing: a sweep over every state pair calling `decideTransition`
 * would write the entire table into the reconciliation log, and the log would then confirm
 * that the code takes exactly the edges it declares no matter what the code actually does.
 */
export function wouldAllowTransition<S extends string>(
  lifecycle: AnyLifecycle,
  from: S,
  to: S
): boolean {
  // A move to the state already held changes nothing, so it is a no-op rather than a
  // transition. The tables declare no self-edges, and refusing one would break every caller
  // that re-asserts a status it already has.
  if (from === to) return true;
  return mode === 'permissive' || canTransition(lifecycle, from, to);
}

function record(lifecycleId: string, from: string, to: string): void {
  const edge = `${lifecycleId}:${from}->${to}`;
  if (observed.has(edge)) return;
  observed.add(edge);
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${edge}\n`);
  } catch {
    // Recording is an instrument, not a feature. A run must never fail because the
    // reconciliation log could not be written.
  }
}
