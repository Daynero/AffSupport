/**
 * What each kind of run is allowed to do next.
 *
 * A contract between two processes, which is why it lives here rather than in the agent.
 * The interface currently re-derives which actions are legal from around thirty hand-written
 * status literals scattered across components; the agent decides the same question from its
 * own `if` chains. Two independent derivations of one rule do not drift *if* someone
 * remembers — and the audit found several places where nobody had. One table, imported by
 * both, makes drift impossible rather than merely unlikely.
 *
 * Deliberately not in `release.ts`. That module is the origin of version and protocol
 * identity, and release identity stays decoupled from contract versions. A lifecycle is
 * neither of those things.
 *
 * **Two guarantees, and they fire at different times.**
 *
 * At compile time, `Readonly<Record<S, readonly S[]>>` keyed on the whole status union means
 * adding a state is a type error *at the table*, before any test runs. At run time, every
 * declared edge has a named driver and `tests/lifecycle-transitions.test.ts` asserts the
 * driver map covers the table in both directions. A new state therefore fails twice.
 *
 * The compile-time half only fires under a type check, which is why the type-check gate is a
 * hard prerequisite of this rather than a peer of it.
 */

import type {
  JobStatus,
  LandingAssetStatus,
  LandingJobStatus,
  LandingPreviewItemStatus,
  MediaActionStatus,
  TranscriptionJobStatus,
  TranslationStatus
} from './types.js';
import type { StitchStatus } from './stitcher.js';

/**
 * Every state maps to the states it may move to.
 *
 * Keyed on the entire union, not `Partial`: a state with no legal move declares an empty
 * list, and the difference between "terminal" and "someone forgot" is the whole point.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface Lifecycle<S extends string> {
  /** Unique across the registry. Appears in error payloads and test names. */
  readonly id: string;
  /** Must be a key of `transitions`. */
  readonly initial: S;
  readonly transitions: TransitionTable<S>;
  /**
   * The states in which the run is over: nothing further happens unless the user asks.
   *
   * **Declared, not derived, and that is a deliberate limitation of the transition table.**
   * A finished compression is not terminal — every finished state has an edge back into the
   * queue, which is re-running working as specified — so "has this finished?" cannot be read
   * off the edges. Nor is "no outgoing edge" the answer: `interrupted → completed` is the
   * recovery re-probing an output whose encode had already succeeded, and that is the
   * application acting on its own from a state the user considers finished.
   *
   * It is the question roughly fifteen sites across the two processes were answering with a
   * hand-written list of status names, and the lists had already drifted from each other.
   * One declaration, two consumers.
   */
  readonly settled: readonly S[];
}

/**
 * The shape the four helper implementations read through.
 *
 * Deliberately unexported. The contract exposes no `Lifecycle<string>` — a consumer holding
 * one could ask whether a transcription may move to a landing status and get a straight
 * answer instead of a compile error. This is only how one function body serves both the
 * precise signature and the registry-walking one.
 */
interface OpaqueView {
  readonly transitions: Readonly<Record<string, readonly string[] | undefined>>;
}

interface SettledView {
  readonly settled: readonly string[];
}

/**
 * Identity, but one that pins `S` to the table's own keys.
 *
 * Without it, a table written inline would have `S` inferred as the wider declared union
 * of whatever it was assigned to, and a missing key would go unnoticed.
 */
export function defineLifecycle<S extends string>(lifecycle: Lifecycle<S>): Lifecycle<S> {
  return lifecycle;
}

/**
 * Is this move declared? Pure and total; an unknown state answers false rather than throwing.
 *
 * The second signature is what lets the well-formedness and enumeration tests iterate
 * `LIFECYCLES`. A union of `Lifecycle<A> | Lifecycle<B>` cannot satisfy the generic form:
 * inference would have to pick the union of every state as `S`, and each table is keyed only
 * on its own. Overloading keeps the precise signature for real callers — where passing a
 * status from the wrong tool is a compile error — while giving the registry-walking tests a
 * way in that does not require widening the tables themselves.
 */
export function canTransition<S extends string>(lifecycle: Lifecycle<S>, from: S, to: S): boolean;
export function canTransition(lifecycle: AnyLifecycle, from: string, to: string): boolean;
export function canTransition(lifecycle: OpaqueView, from: string, to: string): boolean {
  return (lifecycle.transitions[from] ?? []).includes(to);
}

/**
 * A state with nowhere to go.
 *
 * False everywhere in the compression and transcription tables, on purpose: every finished
 * state there can be re-entered by re-running, which is FR-008 working as specified. Terminal
 * states belong to the sub-run lifecycles, whose outcomes really are final.
 */
export function isTerminal<S extends string>(lifecycle: Lifecycle<S>, state: S): boolean;
export function isTerminal(lifecycle: AnyLifecycle, state: string): boolean;
export function isTerminal(lifecycle: OpaqueView, state: string): boolean {
  return (lifecycle.transitions[state] ?? []).length === 0;
}

/**
 * Is the run over?
 *
 * Not the same question as `isTerminal`. A finished compression can be run again, so it is
 * never terminal — but it has finished, and that is what an interface needs to know before
 * it offers to run it again or lets the row be cleared.
 */
export function isSettled<S extends string>(lifecycle: Lifecycle<S>, state: S): boolean;
export function isSettled(lifecycle: AnyLifecycle, state: string): boolean;
export function isSettled(lifecycle: SettledView, state: string): boolean {
  return lifecycle.settled.includes(state);
}

export function statesOf<S extends string>(lifecycle: Lifecycle<S>): readonly S[];
export function statesOf(lifecycle: AnyLifecycle): readonly string[];
export function statesOf(lifecycle: OpaqueView): readonly string[] {
  return Object.keys(lifecycle.transitions);
}

/** Every declared edge, as `[from, to]`. The enumeration the driver test iterates. */
export function edgesOf<S extends string>(lifecycle: Lifecycle<S>): readonly (readonly [S, S])[];
export function edgesOf(lifecycle: AnyLifecycle): readonly (readonly [string, string])[];
export function edgesOf(lifecycle: OpaqueView): readonly (readonly [string, string])[] {
  const edges: (readonly [string, string])[] = [];
  for (const from of Object.keys(lifecycle.transitions))
    for (const to of lifecycle.transitions[from] ?? []) edges.push([from, to]);
  return edges;
}

/**
 * The reference implementation.
 *
 * No state is terminal here. Every finished state can be re-entered through a re-run, and
 * `processing → analyzing` is the re-probe a recovered run performs before it can be queued
 * again. Re-running is a transition, not a resurrection.
 *
 * **A re-run goes back to `ready`, not straight to `queued`.** Reconciling this table against
 * a full suite run showed the finished states moving to `ready` and never to `queued`:
 * `start()` routes every re-runnable job through `resetForRerun`, which clears the previous
 * result before anything is queued. Declaring the shortcut as well would be declaring an edge
 * no code can take — exactly the table rot the enumeration test exists to catch.
 *
 * `interrupted → completed` is not a mistake either. A run interrupted during output
 * validation had already finished encoding; when the media engine returns, the recovery
 * re-probes the output and completes the job rather than making the user encode it twice.
 * The same recovery has a third outcome — `interrupted → failed`, when the re-probe finds
 * the source is not usable after all. That edge is here because a characterisation test
 * reached a branch the suite had never covered, which is the reconciliation continuing to
 * do its job rather than a one-off exercise that finished.
 */
export const COMPRESSION_LIFECYCLE: Lifecycle<JobStatus> = defineLifecycle({
  id: 'compression',
  initial: 'analyzing',
  transitions: {
    analyzing: ['ready', 'failed'],
    ready: ['queued'],
    // 'ready' is the batch being abandoned before this job started.
    queued: ['processing', 'cancelled', 'ready'],
    processing: ['completed', 'failed', 'cancelled', 'interrupted', 'analyzing'],
    completed: ['ready'],
    failed: ['ready'],
    cancelled: ['ready'],
    interrupted: ['ready', 'completed', 'failed']
  },
  settled: ['completed', 'failed', 'cancelled', 'interrupted']
});

/**
 * The same shape as compression, which is the point.
 *
 * Transcription mapped a run interrupted by a restart to `failed` while the compressor
 * mapped the identical situation to `interrupted` (A12) — so one tool told the user their
 * work had broken and the other told them it had been interrupted. FR-006 requires the two
 * to be distinguishable, and they cannot be if only one tool can express the difference.
 *
 * `processing → interrupted` is a transition that happens **across a restart**: the run was
 * still `processing` when the agent stopped, and the store resolves it on the next launch.
 * It is declared, and taken, exactly like any other — reconstructing that state silently
 * would leave the one status the interface most needs to explain outside the declaration
 * everything else is checked against.
 */
export const TRANSCRIPTION_LIFECYCLE: Lifecycle<TranscriptionJobStatus> = defineLifecycle({
  id: 'transcription',
  initial: 'analyzing',
  transitions: {
    // Not `failed`. Analysis here only probes a duration, and a probe that fails is not
    // fatal — whisper can still run and the progress bar simply stays indeterminate. A file
    // this tool cannot use is refused before a job exists at all.
    analyzing: ['ready'],
    ready: ['queued'],
    // Not `ready` either. Stopping a queued transcription cancels it; nothing demotes it
    // back into the list the way abandoning a compression batch does.
    queued: ['processing', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled', 'interrupted'],
    completed: ['queued'],
    failed: ['queued'],
    cancelled: ['queued'],
    interrupted: ['queued']
  },
  settled: ['completed', 'failed', 'cancelled', 'interrupted']
});

/**
 * A sub-run of a transcription. Its outcomes really are final.
 *
 * `processing → queued` is preemption, not failure: a translation yields its turn when the
 * transcription it belongs to needs the machine, and resumes from the segments it had
 * already produced. Recording that as a failure would have shown the user an error for
 * something the application did on purpose.
 *
 * `failed → queued` is a retry. It looks like an edit but is a replacement: a re-request
 * builds a fresh document and drops it in, so the move is decided against the one it
 * replaces. Completion has no such edge — re-asking for a language that already has a
 * finished translation returns that translation instead of running it again, which the
 * driver for the edge discovered by never being able to reach it.
 */
export const TRANSLATION_LIFECYCLE: Lifecycle<TranslationStatus> = defineLifecycle({
  id: 'translation',
  initial: 'queued',
  transitions: {
    queued: ['processing'],
    processing: ['completed', 'failed', 'queued'],
    // A translation that finished is done: asking for the same language again returns the
    // one that exists rather than re-running it, so `completed` really has nowhere to go.
    // A translation that broke can be asked for again, and that re-request replaces the
    // document rather than editing it — which is why it is a transition at all.
    completed: [],
    failed: ['queued']
  },
  settled: ['completed', 'failed']
});

/**
 * One landing optimisation, and unlike a compression it is **not** re-runnable.
 *
 * `queue()` accepts only a `ready` job, and a finished one is never returned to `ready` —
 * running the same landing again means uploading it again, which builds a new job. So the
 * three finished states really are terminal here, and the re-run edges the first draft of
 * this table carried were edges no code path could reach.
 */
export const LANDING_JOB_LIFECYCLE: Lifecycle<LandingJobStatus> = defineLifecycle({
  id: 'landing-job',
  initial: 'preparing',
  transitions: {
    // Not `preparing → failed`. Preparation either produces a scanned, ready job or throws
    // before a job exists at all — there is no landing to mark as broken.
    preparing: ['ready'],
    ready: ['queued'],
    queued: ['processing', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: []
  },
  settled: ['completed', 'failed', 'cancelled']
});

/** A sub-run of a landing job. `skipped` is a real outcome, not an absence of one. */
export const LANDING_ASSET_LIFECYCLE: Lifecycle<LandingAssetStatus> = defineLifecycle({
  id: 'landing-asset',
  initial: 'pending',
  transitions: {
    // Not `pending → skipped`. Every skip decision — no gain, name collision — is made
    // inside the loop that has already moved the asset to `processing`, and a file that is
    // preserved rather than optimised is *created* skipped instead of transitioning there.
    pending: ['processing'],
    processing: ['optimized', 'skipped', 'failed'],
    optimized: [],
    skipped: [],
    failed: []
  },
  settled: ['optimized', 'skipped', 'failed']
});

/**
 * One page inside a preview catalog.
 *
 * `ready → queued` is a re-render: a page whose source changed, or a catalog re-scanned
 * against new settings, goes round again. Declaring `ready` terminal would have made the
 * enforcement refuse the second render of any page.
 */
export const LANDING_PREVIEW_ITEM_LIFECYCLE: Lifecycle<LandingPreviewItemStatus> = defineLifecycle({
  id: 'landing-preview-item',
  initial: 'queued',
  transitions: {
    queued: ['rendering'],
    rendering: ['ready', 'failed'],
    ready: ['queued'],
    failed: ['queued']
  },
  settled: ['ready', 'failed']
});

/**
 * `skipped` and `cancelled` are different outcomes.
 *
 * `skipped` means the output already existed; `cancelled` means the user stopped it. Sharing
 * one state made a stop indistinguishable from a no-op in the list, which is A3.
 */
export const MEDIA_ACTION_LIFECYCLE: Lifecycle<MediaActionStatus> = defineLifecycle({
  id: 'media-action',
  initial: 'queued',
  transitions: {
    queued: ['processing', 'skipped', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    skipped: [],
    cancelled: []
  },
  settled: ['completed', 'failed', 'skipped', 'cancelled']
});

/**
 * One stitch, re-stitch, or removal.
 *
 * The compressor's table with one state fewer: a source is probed before its row exists, so
 * there is nothing to analyse. Everything else is the same shape, because the queue is the
 * same queue — files wait as `ready`, a selection is started, and a finished row can be run
 * again.
 */
export const STITCH_LIFECYCLE: Lifecycle<StitchStatus> = defineLifecycle({
  id: 'stitch',
  initial: 'ready',
  transitions: {
    // A file waits in the list until someone starts it, exactly as in the compressor.
    ready: ['queued'],
    queued: ['running', 'cancelled'],
    running: ['done', 'failed', 'cancelled'],
    // Every finished state can be run again; re-running returns the row to `ready` first,
    // which is where the previous result is cleared.
    done: ['ready'],
    failed: ['ready'],
    cancelled: ['ready']
  },
  settled: ['done', 'failed', 'cancelled']
});

/**
 * Every lifecycle, so tests iterate rather than enumerate.
 *
 * `as const` on purpose. A plain `readonly Lifecycle<string>[]` would widen each status union
 * to `string` and lose exactly the exhaustiveness this module exists to provide — the
 * registry would become the one place in the contract where a typo is not a compile error.
 * The tuple form keeps each member's own type.
 */
export const LIFECYCLES = [
  COMPRESSION_LIFECYCLE,
  TRANSCRIPTION_LIFECYCLE,
  TRANSLATION_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  LANDING_ASSET_LIFECYCLE,
  LANDING_PREVIEW_ITEM_LIFECYCLE,
  MEDIA_ACTION_LIFECYCLE,
  STITCH_LIFECYCLE
] as const;

/**
 * The union of the seven concrete lifecycle types — never a widened one.
 *
 * Consumers that genuinely need to treat a lifecycle opaquely, such as the well-formedness
 * test, take this. Nothing in the contract exposes `Lifecycle<string>`.
 */
export type AnyLifecycle = (typeof LIFECYCLES)[number];

/** `from->to`, the key the driver map is written in. */
export type EdgeKey = `${string}->${string}`;
