# Data Model — Release Hardening Pass

**Created**: 2026-08-23 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

This feature introduces almost no new domain data. What it introduces is **declarations of things that already exist implicitly**: the transitions each run may make, the paths a user actually chose, what a verification run produced, and what the machine was actually doing. Each section below states the shape, where it lives, its validation rules, and which requirement it serves.

Existing types are shown only where this feature changes them.

---

## 1. Lifecycle

**Lives in**: `packages/shared/src/lifecycle.ts` (new), re-exported from the barrel.
**Serves**: FR-001, FR-005, FR-019, SC-003.

```ts
type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

interface Lifecycle<S extends string> {
  readonly id: string;      // stable, matches the ToolModule id where one exists
  readonly initial: S;
  readonly transitions: TransitionTable<S>;
}
```

| Field | Rule |
|---|---|
| `id` | Unique across the registry. Used in error payloads and test names. |
| `initial` | Must be a key of `transitions`. |
| `transitions` | Keyed on the **whole status union**, so a new state is a type error at the table. Every listed target must itself be a key. |

Derived helpers, all pure: `canTransition(l, from, to)`, `isTerminal(l, s)` (empty target list), `statesOf(l)`, `edgesOf(l)`.

**Well-formedness rules**, asserted once for every registered lifecycle:

- Every state is reachable from `initial`.
- Every state either is terminal or has at least one outgoing edge.
- No self-edges (a transition to the same state is a no-op, not a transition).
- At least one terminal state exists **unless re-running is itself a declared transition**, which is the case for the run-level lifecycles — see the note under §1.1. The sub-run lifecycles do have terminal states, and the rule applies to them unconditionally.

### 1.1 The registry

Seven lifecycles, all registered in one exported array so tests can iterate them.

| Id | States | Notes |
|---|---|---|
| `compression` | `analyzing, ready, queued, processing, completed, failed, cancelled, interrupted` | The reference implementation. |
| `transcription` | the same eight as `compression`, once `interrupted` is added | Has seven today; gains `interrupted` — see §1.3. |
| `translation` | `queued, processing, completed, failed` | Sub-run of a transcription. `processing → queued` is preemption. |
| `landing-job` | `preparing, ready, queued, processing, completed, failed, cancelled` | Phase becomes derived — see §1.2. Not re-runnable; its finished states are terminal. |
| `landing-asset` | `pending, processing, optimized, skipped, failed` | Sub-run of a landing job. `skipped` is a real outcome. |
| `landing-preview-item` | `queued, rendering, ready, failed` | `ready` re-enters `queued` on a re-render. |
| `media-action` | `queued, processing, completed, failed, skipped` **plus `cancelled`** | Gains `cancelled` — see §1.4. |

The registry is declared `as const` so it is a tuple of the seven concrete lifecycle types rather than an array of widened ones. Widening would lose per-lifecycle exhaustiveness at exactly the point the tables are iterated — see [contracts/lifecycle-api.md](./contracts/lifecycle-api.md).

The compression table, as the worked example — **as reconciled against a full suite run**, not as first drafted:

```ts
{
  analyzing:   ['ready', 'failed'],
  ready:       ['queued'],
  queued:      ['processing', 'cancelled', 'ready'],   // 'ready' = batch abandoned
  processing:  ['completed', 'failed', 'cancelled', 'interrupted', 'analyzing'],
  completed:   ['ready'],                               // repeat, via resetForRerun
  failed:      ['ready'],                               // retry
  cancelled:   ['ready'],                               // re-run
  interrupted: ['ready', 'completed']                   // 'completed' = validation recovered
}
```

Note that no state is terminal in the compression table: every finished state can be re-entered through a re-run. `isTerminal` is therefore false everywhere here, and the "terminal" concept applies to the sub-run lifecycles. This is deliberate and matches FR-008 — re-running is a transition, not a resurrection.

**What the reconciliation changed.** The first draft of this table sent every finished state straight to `queued`. The running code does not: `start()` routes every re-runnable job through `resetForRerun`, which returns it to `ready` before anything is queued, so `completed → queued` was an edge no code path could take. Two more corrections came out of the same run — `interrupted → completed`, which is the recovery re-probing an output whose encode had actually finished, and `translation: processing → queued`, which is a translation yielding its turn to the transcription it belongs to rather than failing. `landing-preview-item` gained `ready → queued`, a page being re-rendered.

The reverse correction applies to **`landing-job`**, whose three finished states are genuinely terminal: `queue()` accepts only a `ready` job and nothing returns a finished one to `ready`, so running the same landing again means uploading it again and building a new job. Its re-run edges were removed.

This is the rollout working as designed. The tables are the intent; a mismatch against a real run is a finding, and four of the seven tables carried one.

### 1.2 `LandingJobPhase` becomes derived

Today `LandingJobStatus` and `LandingJobPhase` are assigned in lockstep at six sites. The only phases that are not also a status are `optimizing`, `rewriting` and `packaging` — the three steps of `processing`.

```ts
type LandingStep = 'optimizing' | 'rewriting' | 'packaging';
function phaseOf(status: LandingJobStatus, step: LandingStep | null): LandingJobPhase;
```

`LandingJobPhase` **stays on the wire** — no contract reshaping — but stops being independently assignable. Nine states disappear from the set that FR-019 must cover.

### 1.3 `TranscriptionJobStatus` gains `interrupted`

Closes **A12**: transcription currently maps a restarted `processing` run to `failed`, while the compressor maps it to `interrupted`. FR-006 requires the two to be distinguishable.

Migration: a persisted job carrying `failed` with the existing interrupted-flavoured message is **not** rewritten — old records stay as they are. Only new interruptions use the new state.

### 1.4 `MediaActionStatus` gains `cancelled`

Closes **A3**. `skipped` (an output already existed) and `cancelled` (the user stopped it) are different outcomes and must not share a state.

---

## 2. `CompressorActivity`

**Lives in**: `apps/agent/src/queue/queue.ts`, private. Never crosses the wire.
**Serves**: FR-001, FR-002, FR-003. Closes A2(i), A5, A4.

```ts
type CompressorActivity =
  | { kind: 'idle' }
  | { kind: 'encoding';      jobId: string; abort: AbortController; child: ChildProcess | null }
  | { kind: 'encoding-held'; jobId: string; abort: AbortController; child: ChildProcess; release: () => void }
  | { kind: 'estimating' };
```

Replaces five independent fields. The mapping and the migration order are in [research.md §R2](./research.md).

**Invariants**, asserted in tests at every broadcast:

- `child` is non-null in `encoding-held` by construction — a hold cannot exist without a child.
- `release` exists **only** in `encoding-held`, which is what makes "a hold is always released by its taker" a type-level fact rather than a runtime guess.
- `kind !== 'idle'` implies the queue reports itself as running.
- Exactly one activity at a time. Concurrency is 1 by design and this makes that explicit rather than emergent.

---

## 3. State snapshot revision

**Lives in**: `packages/shared/src/types.ts`, added to `QueueState`, `TranscriptionState`, `LandingState`.
**Serves**: FR-037, SC-013.

```ts
revision: number;   // monotonic, per queue instance, starts at 0
```

| Rule | |
|---|---|
| Monotonic | Increments on every broadcast, never decreases within one local-app run. |
| Instance-scoped | Resets to 0 when the local app restarts. The interface must key its reset on the reported instance identity, **not** treat a lower revision as stale. |
| Absent means zero | An older local app omits the field; the client normalises to `0` and the guard degrades to today's behaviour. |

Client rule: `next.revision < current.revision → keep current`, applied in exactly one place (the state writer), with a single documented bypass for a fresh connect.

---

## 4. `PathGrant`

**Lives in**: `apps/agent/src/files/path-grants.ts` (new). In-memory only.
**Serves**: FR-026, FR-032b. Closes C3.

```ts
interface PathGrant {
  id: string;                 // opaque; what the interface echoes back
  path: string;               // realpath'd, absolute
  kind: 'file' | 'dir';
  access: 'read' | 'write';
  origin: 'picker' | 'drop' | 'finder' | 'restore';
  dev: number;                // captured at mint
  ino: number;                // captured at mint
  createdAt: number;
  expiresAt: number | null;   // null while referenced by durable state
  refs: number;
}
```

**Validation and lifetime rules:**

| Rule | Why |
|---|---|
| Minted only inside the selection code paths | So no caller can forget. |
| `path` is realpath'd at mint | Comparison is over resolved paths only. |
| `dev`+`ino` re-checked at use | Time-of-check defence: a job sits for minutes between grant and read, and a symlink swap in that window is the realistic attack. |
| A directory grant covers descendants; a file grant covers only itself | |
| Write scope for derived output is **pattern-bound**, not directory-bound | A read grant on one file must not imply write access across its folder. |
| Referenced grants never expire; unattached ones expire after 24 h idle | Refcounted against jobs, catalogs and the output-folder setting. |
| Outer bound applies even to a granted path | Never system directories, another user's home, or any path containing credential-store directories. Defence in depth: downgrades a ledger bug from "read anything" to "read something in the user's own documents". |
| Windows comparison is case-insensitive, separator-normalised, and resolves extended-length prefixes **and short (8.3) names** | Standard realpath resolves junctions but not short names. |

**Rebuilt on boot** from the durable tool state it authorises — the persisted queue, the transcription store, the preview catalog, the output-folder setting. **Not a separate file.** The persisted queue *is* the record of user-chosen paths, so restoration and authorisation cannot disagree. See [research.md §R22](./research.md) for why, and for the three prerequisites that must land first.

**Refusal**: `403 { error: 'PATH_NOT_GRANTED' }` — one code for every cause, so the route is not an existence oracle.

---

## 5. Capability ticket

**Lives in**: `apps/agent/src/server/tickets.ts` (new).
**Serves**: FR-024. Closes the subresource half of C4.

```ts
// base64url(HMAC(sessionSecret, `${method}|${path}|${exp}`))
```

| Rule | |
|---|---|
| Bound to one method and one path | A ticket for one image cannot fetch another. |
| TTL 5 minutes | A leak via a referrer or a log costs one resource for five minutes, not the machine. |
| Derived from, but not equal to, the session token | This is the whole point. |
| Issued only in an authenticated response describing that resource | |
| Range requests unaffected | Which is why blob conversion was rejected. |

---

## 6. Verification result

**Lives in**: `verification-result.json` (gitignored) and stdout.
**Serves**: FR-014, FR-015, SC-005, SC-007.

Extends the existing analytics envelope — `ok`, `command`, `generated_at`, `data`, and the `{ ok: false, command, error }` twin — verbatim. Adds `form`. **Drops `period`**, because this is not a time-window report and a null period would misrepresent a contract the constitution calls stable.

```ts
interface VerificationResult {
  ok: boolean;
  command: 'verify';
  generated_at: string;
  form: 'fast' | 'release';
  error?: string;                 // the failing gate id, when ok is false
  data: {
    duration_ms: number;
    totals: {
      gates: number; passed: number; failed: number;
      tests: number; skipped_tests: number;
      skip_reasons: Record<string, number>;
      coverage_lines: number | null;
    };
    gates: GateResult[];
    failure?: { gate: string; subject: string; excerpt: string[] };
  };
}

interface GateResult {
  id: string;                     // stable, appears in exactly one form's list
  ok: boolean;
  duration_ms: number;
  skipped_reason?: string;
  detail?: unknown;               // gate-specific, unbounded, never printed
}
```

**Rules:**

- Every gate id appears in exactly one form's list — asserted by a test.
- On failure, `error` is the gate id and `failure.subject` is one line naming what broke.
- Success output is capped at 20 lines; failure at 100, with the subject in the first 10.
- `skip_reasons` is histogrammed from suite-title markers. **A skipped test with no marker fails the run.**

---

## 7. Machine observation

**Lives in**: `tests/support/machine-probe.ts` (new). Test-only; imports nothing from the agent's platform or power modules, enforced by a lint restriction and a source-scanning guard.
**Serves**: FR-020, SC-001, SC-002, SC-004.

```ts
interface ProcessObservation {
  pid: number;
  ppid: number;
  createdAt: number;              // (pid, createdAt) defeats pid recycling
  name: string;
  cpuMillis: number;              // cumulative
  suspended: boolean | null;      // Windows only; null elsewhere
}

interface MachineSample {
  at: number;
  tree: ProcessObservation[];     // rooted at the agent the harness spawned
  totalCapacityCores: number;
  sotySharePercent: number;       // (Δtree cpu) / (Δt × cores) × 100
  machineIdlePercent: number;     // diagnostic only — NEVER subtracted
}
```

**Rules:**

- `suspended === true` on a survivor is reported as **"left suspended"**, a distinct named failure from "left running". They are different bugs and must not be conflated.
- `machineIdlePercent` is recorded and never subtracted. Subtraction is how a leaked process gets hidden by runner noise.
- Liveness is `process.kill(pid, 0)` — a syscall, not a parse — and is authoritative over the table.
- SC-002 is never skipped for noise. SC-004 may skip with the named reason `RUNNER_TOO_NOISY`, counted in the skip histogram.

---

## 8. Interleaving scenario

**Lives in**: `tests/support/interleaving-scenarios.ts` (new).
**Serves**: FR-020, SC-001.

```ts
type Step =
  | { do: 'add';     tool: ToolId; fixture: string }
  | { do: 'start';   tool: ToolId; jobRef: string }
  | { do: 'stop';    tool: ToolId; jobRef: string }
  | { do: 'stopAll'; tool: ToolId }
  | { do: 'rerun';   tool: ToolId; jobRef: string }
  | { do: 'restartAgent' }
  | { do: 'sleepWake' }
  | { do: 'setLimit'; percent: number }
  | { do: 'expect';  tool: ToolId; jobRef: string; status: string };

interface Scenario {
  id: string;
  steps: readonly Step[];
  checkpointEvery: boolean;       // observe the machine after every step
}
```

**Rules:**

- At least one scenario has ≥20 steps across ≥3 tools — asserted as a countable expression, which is why the sequence is data rather than imperative test code.
- After every step, the reported state and the machine observation must agree. Disagreement fails immediately, naming the step index.
- Steps may be **generated from the transition tables in §1**, which is how FR-019 and FR-020 reinforce each other instead of drifting.

---

## 9. Ratchet files

Four committed files, each the enforceable memory of a gate.

| File | Contents | Fails when | Serves |
|---|---|---|---|
| `coverage-baseline.json` | Global + per-file coverage, floored | Global falls, or a file falls beyond tolerance | FR-018 |
| `coverage-critical.json` | Run-state modules with absolute floors | A listed module drops below its floor — checked **before and independently of** the ratchet, so a falling global cannot excuse it. Membership is **derived** by walking the import graph from the run-state entry points; adding a state module without listing it fails. | FR-018a |
| `i18n-dynamic.json` | Prefix patterns for runtime-constructed keys | A constructed key exists whose file is not registered — enforced by a lint rule on the cast that marks one | FR-056 |
| `audit-exceptions.json` | `{ advisory_id, package, severity, rationale, expires }` | An exception is **expired** | FR-030 |

The dated expiry is the point of the last one: a deferral becomes a decision with a review date rather than a permanent hole.

---

## 10. Design tokens

**Lives in**: `apps/web/src/styles.css`.
**Serves**: FR-049, FR-050, SC-017.

Two scales **do not exist and must be created** — the spec says so explicitly, because a requirement to use a scale that does not exist is unmeetable:

| Scale | Status |
|---|---|
| `--space-*`, `--radius-*`, `--shadow-*`, `--dur-*`, `--ease-*` | Exist. Enforce use. |
| Text size | **Create.** Today: machine-generated fractional pixel literals, so browser font-size settings are ignored. |
| Stacking order (`--z-*`) | **Create.** Today: 58 raw values, no scale, no comments. View-transition pseudo-elements are excluded — they live in their own overlay context and are not comparable. |

Nine referenced-but-undefined properties must be defined or removed: `--color-danger`, `--border`, `--border-strong`, `--surface`, `--surface-raised`, `--text`, `--text-muted`, `--font-mono`, `--color-text-subtle`.

Twelve further undefined-in-CSS properties are **legitimate** — they are set from component inline styles — and the checker resolves them by cross-referencing the component tree. This is the single reason the checker is written rather than configured; see [research.md §R19](./research.md).
