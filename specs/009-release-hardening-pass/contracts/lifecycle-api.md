# Contract — Shared Lifecycle API

**Module**: `@video-compressor/shared` → `packages/shared/src/lifecycle.ts`
**Consumers**: the local app (enforcement) and the interface (gating Stop and Retry).
**Serves**: FR-001, FR-005, FR-019, FR-041, SC-003.

This is a **contract between two processes**, which is why it lives in the shared package rather than in the agent. The interface today re-derives which actions are legal from roughly thirty hand-written status literals; this replaces them with the same table the agent enforces, so drift is impossible rather than merely unlikely.

It is deliberately **not** in `release.ts`. That module is the origin of version and protocol identity, and Principle II requires release identity and contract versions to stay decoupled. A lifecycle is neither.

---

## Exports

```ts
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface Lifecycle<S extends string> {
  readonly id: string;
  readonly initial: S;
  readonly transitions: TransitionTable<S>;
}

export function defineLifecycle<S extends string>(l: Lifecycle<S>): Lifecycle<S>;

export function canTransition<S extends string>(l: Lifecycle<S>, from: S, to: S): boolean;
export function isTerminal<S extends string>(l: Lifecycle<S>, s: S): boolean;
export function statesOf<S extends string>(l: Lifecycle<S>): readonly S[];
export function edgesOf<S extends string>(l: Lifecycle<S>): readonly (readonly [S, S])[];

export const COMPRESSION_LIFECYCLE: Lifecycle<JobStatus>;
export const TRANSCRIPTION_LIFECYCLE: Lifecycle<TranscriptionJobStatus>;
export const TRANSLATION_LIFECYCLE: Lifecycle<TranslationStatus>;
export const LANDING_JOB_LIFECYCLE: Lifecycle<LandingJobStatus>;
export const LANDING_ASSET_LIFECYCLE: Lifecycle<LandingAssetStatus>;
export const LANDING_PREVIEW_ITEM_LIFECYCLE: Lifecycle<LandingPreviewItemStatus>;
export const MEDIA_ACTION_LIFECYCLE: Lifecycle<MediaActionStatus>;

/**
 * Every lifecycle, so tests can iterate rather than enumerate.
 *
 * Declared `as const` on purpose. A plain `readonly Lifecycle<string>[]` would widen
 * each status union to `string` and lose exactly the exhaustiveness Principle I exists
 * to provide — the registry would become the one place in the contract where a typo is
 * not a compile error. The tuple form keeps each member's own type.
 */
export const LIFECYCLES = [
  COMPRESSION_LIFECYCLE,
  TRANSCRIPTION_LIFECYCLE,
  TRANSLATION_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  LANDING_ASSET_LIFECYCLE,
  LANDING_PREVIEW_ITEM_LIFECYCLE,
  MEDIA_ACTION_LIFECYCLE
] as const;

export type AnyLifecycle = (typeof LIFECYCLES)[number];
```

Consumers that genuinely need to treat a lifecycle opaquely — the well-formedness test, the
enumeration test — take `AnyLifecycle`, which is the **union** of the seven concrete types
rather than a widened one. Nothing in the contract exposes `Lifecycle<string>`.

All functions are pure and total. None throws.

---

## The two guarantees

**Compile time.** `Readonly<Record<S, readonly S[]>>` keyed on the whole status union means adding a state produces a type error **at the table**, before any test runs. This is not a novel pattern in this codebase — `apps/web/src/components/ui.tsx:256` is already `Record<JobStatus, TranslationKey>` and is complete.

That guarantee only fires under a type-check, and today the test tree and the scripts are in no tsconfig and there is no typecheck script at all. **The typecheck gate is a hard prerequisite of SC-003, not a peer of it.**

**Run time.** Every declared edge has a **named driver** that puts a real queue instance into the `from` state and performs the transition. The enumeration test asserts the driver map covers the table exactly, in both directions:

```ts
export type EdgeKey = `${string}->${string}`;
export type Driver = () => Promise<{ before: string; after: string }>;
export type DriverMap = Partial<Record<EdgeKey, Driver>>;
```

| Assertion | Catches |
|---|---|
| Every declared edge has a driver | A new state added without a test |
| Every driver names a declared edge | Table rot after a state is removed |
| Each driver ends where the table says | A wrong table |
| Every **undeclared** edge is refused without changing state | FR-001 |

A new state therefore fails **twice** — at type-check and at test. That is SC-003.

`Partial<Record<...>>` is deliberate: edges are a computed set, not a union, so exhaustiveness there must be a runtime assertion in both directions.

---

## Enforcement

The **table** is shared; the **enforcer** is one method per owner:

```ts
private transition(job: Job, next: Status): boolean;
```

Consults `canTransition`. On refusal it **leaves state unchanged and returns false** — never throws, never half-applies. Routes map `false` to `409 { error: 'TRANSITION_NOT_ALLOWED' }`.

**Rollout is permissive first.** `transition()` initially records the edge and never blocks. A full suite run then surfaces every edge the running code actually takes; anything not in the table is a **table** bug, not a code bug. Only after that is reconciled does it become strict. Enforcing a wrong table is the one real risk here, and this is the mitigation.

---

## Well-formedness

Asserted once for every member of `LIFECYCLES`:

- `initial` is a key of `transitions`.
- Every target is itself a key.
- Every state is reachable from `initial`.
- No self-edges.
- At least one terminal state, **except** where re-running is a declared transition — the compression table has no terminal state because every finished state can be re-entered through a re-run, which is FR-008 working as specified.

---

## Interface consumption

The interface imports the same tables to answer "is this action legal right now" instead of matching status literals. Concretely this replaces the hand-derived logic behind the Stop and Retry affordances and satisfies FR-041's "an action already in flight must not be re-triggerable" from the declaration rather than from a boolean assembled per component.
