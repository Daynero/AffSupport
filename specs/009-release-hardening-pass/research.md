# Phase 0 Research — Release Hardening Pass

**Created**: 2026-08-23 | **Spec**: [spec.md](./spec.md) | **Audit**: [findings.md](./findings.md)

Four independent research passes were run against the codebase — live-state architecture, verification pipeline, run lifecycle and observation, and security. Each decision below was made against code that was read, and where a number appears it was measured at commit `78f1d88` on the maintainer's machine, not estimated.

Eight findings were discovered during this phase and appended to the audit as **A12–A18**. Two of them change the plan: **A17** (a test mutates `packages/shared/dist` and a tracked migration mid-suite) decides the verification pipeline's concurrency model, and **A13** (the end-to-end harness writes into the developer's real data directory) is a blocker that must be fixed before FR-020 work starts.

---

## Part 1 — Run lifecycle

### R1. Share the mechanism, not the state set

**Decision.** One typed transition-table primitive in a new `packages/shared/src/lifecycle.ts`, instantiated by **seven** explicit lifecycle definitions rather than merged into one: compression (8 states), transcription (7→8), translation (4), landing-job (7), landing-asset (5), landing-preview-run, landing-preview-item (4), media-action (5→6). `ToolModule` (`apps/agent/src/server/tools.ts:45-50`) gains `lifecycle`, `cancel(id)` and `cancelAll()`, which makes FR-005 and FR-007 structural rather than per-tool discipline.

**Rationale.** The state sets differ semantically, not accidentally. `interrupted` and `analyzing` exist only where jobs persist to disk; `skipped` is a real outcome no encoder has; transcription and landing carry genuine sub-run lifecycles that a single set cannot express. Merging forces either lies or permanently unreachable members — which FR-019 would then demand tests for — and reshapes four live-update contracts plus every status style and translation key. That is a rewrite, which the spec's Assumptions forbid. What is genuinely common is the mechanism, and it half-exists already: all five queues expose `workActive()` and `ToolModule.busy()` iterates them.

**Alternatives considered.** One merged `RunStatus` — rejected: unreachable states, four wire contracts reshaped, no way to express sub-runs. Five hand-rolled machines with tests but no declaration — rejected: SC-003 is unachievable without something enumerable. A shared `abstract class RunQueue<S>` — rejected: the five pump shapes differ too much; inheritance buys more coupling than five call sites into a pure function.

**Consequence worth taking for free.** `LandingJobPhase` stops being a state machine. In `apps/agent/src/landing/optimizer.ts` status and phase are assigned in lockstep at every site (`:88-89, :131-132, :238-239, :265-266, :288-289, :294-295`), and the only phases that are not also a status are `optimizing|rewriting|packaging` — the three steps of `processing`. Make it derived (`phaseOf(status, step)`), keep the wire field, delete nine states.

**Blast radius.** New shared module + committed `dist` rebuild; ~56 status-assignment sites across five agent files (16/17/10/8/5); ~30 hand-written status-array literals across agent and web collapse to `isTerminal`. `JobStatus` is named in only 7 files repo-wide.

**Risk.** Low-medium. The hazard is a *wrong* table being enforced. Mitigated by a **permissive → strict rollout**: `transition()` first only records the edge and never blocks, so a full suite run surfaces every edge the running code actually takes — those are table bugs, not code bugs. Only then flip to strict, where an illegal edge leaves state unchanged and returns `false`, mapped to `409 TRANSITION_NOT_ALLOWED` per the existing convention.

### R2. Collapse the compressor's five fields into one value

**Decision.**

```ts
type CompressorActivity =
  | { kind: 'idle' }
  | { kind: 'encoding';      jobId: string; abort: AbortController; child: ChildProcess | null }
  | { kind: 'encoding-held'; jobId: string; abort: AbortController; child: ChildProcess; release: () => void }
  | { kind: 'estimating' };
```

| Today (`apps/agent/src/queue/queue.ts`) | Maps to |
|---|---|
| `compressionInFlight` `:122` | `kind === 'encoding' \|\| 'encoding-held'` |
| `prioritizingEstimates` `:124` | `kind === 'estimating' \|\| 'encoding-held'` |
| `compressionPausedForEstimates` `:123` | `kind === 'encoding-held'` |
| `activeAbort` `:121` | `activity.abort` (encoding variants only) |
| `active` `:117` | `activity.child` (encoding variants only) |
| `estimateHoldRelease` `:142` | `activity.release` — **only** in `encoding-held` |

`running()` (`:250`) becomes `kind !== 'idle' || queuedInBatch()`; `compressionActive()` (`:262`) becomes `kind === 'encoding'`. Nothing crosses the wire — `QueueState.running` keeps its shape.

**Rationale.** Folding `release` into the variant makes "a hold is always released by its taker" a type-level fact, which closes **A5** as a side effect rather than adding another guard to the tangle that caused it. `activity.jobId` gives `shutdown()` (`:816-840`) the job identity it needs to unlink a partial output, which closes half of **A2**.

**Risk.** Medium — the highest in the lifecycle set. These five fields are load-bearing for the estimate-priority handoff, the subtlest concurrency in the agent, and the tests around them spawn real encoders.

**Migration order — shadow, then invert.** (1) Land R3's table first; there must be a transition net under this before touching internals. (2) Write characterisation tests against the *current* five-field code, using the A11 gap list as the specification. (3) Keep all five fields; add a derived `get activity()`; rewrite `running()`, `compressionActive()` and the four guards to read it; assert in tests that shadow and fields agree at every notify. Ship — behaviour-identical and provable. (4) Invert: `activity` stored, the five fields become getters; delete write sites in order `compressionInFlight → activeAbort → active → (prioritizingEstimates + compressionPausedForEstimates together — they are the pair with the real race, and splitting them is what created A5)`. (5) Delete the getters; **A5 closed**. (6) `shutdown()` unlinks via `activity.jobId`; **A2(i) closed**. (7) Fix `store.ts:83`'s `finishedAt`; **A8 closed** and the watchdog goes live.

### R3. Self-enforcing transition tables

**Decision.** The mechanism and all seven tables live in `packages/shared/src/lifecycle.ts`, re-exported from the barrel. Not per-tool, not in `release.ts`.

```ts
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;
export interface Lifecycle<S extends string> { readonly id: string; readonly initial: S; readonly transitions: TransitionTable<S>; }
export const canTransition = <S extends string>(l: Lifecycle<S>, from: S, to: S) => l.transitions[from].includes(to);
export const isTerminal    = <S extends string>(l: Lifecycle<S>, s: S) => l.transitions[s].length === 0;
export const edgesOf       = <S extends string>(l: Lifecycle<S>) => …;
```

**Rationale.** Principle I says domain types, constants and validators live in `@video-compressor/shared` and that state must be modelled as string-literal machines so branches are exhaustive. The seven status unions already live there and cross the live-update boundary into the web, which needs the same table to gate Stop and Retry (FR-005, FR-041) — today it re-derives that from ~30 hand-written literals. One table, two consumers, zero drift. Not `release.ts`, because Principle II is explicit that it is the origin of *version and protocol identity* and that release identity and contract versions stay decoupled; lifecycles are neither.

**The compile-error half.** `Readonly<Record<JobStatus, readonly JobStatus[]>>` keyed on the union means adding a state produces a type error *at the table*, before any test runs. This is not a novel pattern here — `apps/web/src/components/ui.tsx:256` is already `Record<JobStatus, TranslationKey>` and is complete.

**The runtime half, which is what makes SC-003 real.** A table that only tests itself proves nothing. Every declared edge needs a **named driver** that puts a real queue instance into the `from` state and performs the transition; the enumeration test asserts the driver map covers the table exactly, in both directions (a missing driver fails, and a driver for an undeclared edge fails, catching table rot). A new state therefore fails **twice**: at type-check and at test.

**Hard prerequisite.** The compile-error half only fires under a type-check, and today `tests/` and `scripts/` are in no tsconfig and there is no typecheck script at all (finding B2). **The typecheck gate is a prerequisite of SC-003, not a peer of it.** Sequence it first.

**Alternatives considered.** Tables per-tool in the agent — rejected: the web then re-derives them and drift is invisible. A `switch` with exhaustiveness assertions at each site — rejected: gives the compile error but produces nothing enumerable, so the test half is impossible. A table generated from source analysis — rejected: it would encode what the code does including its bugs; the declaration must be the intent so a mismatch is a finding.

### R4. Independent observation: independent code, same OS facts

**Decision.** A new `tests/support/machine-probe.ts` importing **nothing** from `apps/agent/src/platform/**` or `apps/agent/src/power/**`, enforced the way A10 is enforced — an ESLint restriction plus a source-scanning guard test — because otherwise the independence decays on the first convenient import.

Be precise about what independence buys: independence of the *OS query* is neither achievable nor valuable, because the process table is the operating system's fact, not Soty's opinion. What must be independent is **the code, the parsing, the tree walk, and the pid inputs.**

**"No process belonging to this job is running" — three layers.**

1. `process.kill(pid, 0)` — a syscall, no shell, no parsing, and a genuinely different mechanism from anything in production (there is no `kill(pid,0)`, no `ps`, no `pgrep` in the repo today). This is the authoritative liveness signal.
2. A `(pid, creationTime)` tuple, to defeat PID recycling — a real hazard here, not theoretical: **A9** records that the governor's only guard is a ≤3 s tree-recency window, and the harness must not inherit that weakness. macOS reads the **full unfiltered table** with different flags and columns than production uses; Windows uses the same CIM class but parses fields production never reads and walks the tree with its own code.
3. **A suspension check on any survivor, Windows only.** This must not be skipped: a suspended orphan is present in the table and alive to `kill(pid,0)`, and it is exactly the failure mode spec 008's own tasks call "the most consequential in the design" (its manual walkthrough T086, still unautomated). Report "left suspended" as a distinct, named failure — it is a different bug from "left running".

**"Consumption at or below 2% of total capacity."** Reimplement the differencing rather than importing it. Do **not** use `ps %cpu` — `apps/agent/src/platform/platform.ts:451-457` documents why (macOS's decaying lifetime average lags by tens of seconds), and an independent harness that re-introduces the rejected metric would produce a different number and blame the app.

**CI noise — solved by scope, not tolerance.** The quantity in SC-002 and SC-004 is *Soty's* share, computed over the tree rooted at the agent the harness itself spawned. Runner noise is outside that tree and never enters the number. Record a machine-wide idle baseline as a diagnostic and **never subtract it** — subtraction is how a leaked process gets hidden by noise. For SC-004 only — the one assertion where a saturated runner can steal cycles from Soty's own children and push the measured share *below* the limit for reasons unrelated to the governor — skip with a named dependency and count it. SC-002 is never skipped: "≤2%" cannot be produced by external noise, only by a real leak.

**Alternatives considered.** Reuse the production process-tree and sampler — rejected on the stated risk, and it is not hypothetical: **A14** shows the current best stop test asserts on Node's report of what Node did, so an escalation bug would leave it green. A compiled probe binary per platform — rejected: two more artefacts to sign and ship for a test-only dependency. Machine-wide CPU assertions — rejected: unattributable on a shared runner and produces flake that trains people to ignore red.

### R5. The interleaving harness

**Decision.** Three pieces and one retirement. `tests/support/agent-process.ts` boots a real built agent (lifted from `scripts/real-agent-check.mjs:58-108`); `tests/support/interleaving-scenarios.ts` holds the sequences as **typed declarative data**; `tests/interleaving-e2e.test.ts` walks them and calls into the machine probe at every checkpoint. `scripts/real-agent-check.mjs` is retired as a second implementation — its contract and encode-fidelity assertions move verbatim into `tests/real-media-e2e.test.ts`, and the script shrinks to a shim so `npm run test:agent:e2e` keeps working with exactly one boot path.

**Rationale for declarative.** SC-001 demands at least twenty actions across at least three tools with 100% checkpoint agreement. As data that is a countable assertion; as imperative test code it is a claim in a comment. It is also the same shape as R3's tables, so **the scenario steps can be generated from the transition tables** — which is how FR-019 and FR-020 reinforce each other instead of drifting.

**Alternatives considered.** Extend the `.mjs` script — rejected: not a vitest file, so real skips (FR-016) are impossible and it produces prose (FR-015). A pure in-process suite via `app.inject()` — rejected: it cannot prove US1 scenario 6 ("the application is quit, nothing survives") because there is no process to quit, and cannot exercise real connections for FR-009b/SC-020.

**Four defects in the existing boot to fix during extraction.** A13 (nine paths must be redirected, not five) is a blocker. A15 (racy port picker). A16 (a no-op env var). And the fork pool needs a single-fork project scope plus an explicit timeout for a suite that owns a listening server.

**Whisper in CI — three tiers, no multi-gigabyte download, ever.** The model descriptor at `apps/agent/src/whisper/tools.ts:31-37` is large-v3 at 3.09 GB and there is no smaller model anywhere in the codebase.

- **`lifecycle` profile** — the pull-request gate on both runners. Stub tools selected via the existing `*_PATH` env overrides, plus a dummy model file. Zero downloads, seconds per scenario, and it covers everything FR-020 is actually about. The stubs must be **real CPU-burning children that speak the encoder's progress dialect**, with switchable behaviour: ignore-SIGTERM (which proves the escalation, and which you *cannot* make real ffmpeg do on demand), hang, and exit-code. For FR-002 this is strictly better than the real binary, not a compromise. The pattern already exists inline at `tests/stop-leaves-nothing-running.test.ts:94-108`; promote it to a shared fixture per FR-021.
- **`real-media` profile** — the release gate, real encoder for fidelity assertions. Reuse the static build the Windows release workflow already compiles and caches (`release-windows.yml:151-232`) rather than installing one.
- **Do not add a small transcription model.** The runner has no transcription binary either, and output quality is not what FR-020 tests. Skip with a named reason and record the deferral against SC-007's release-runner clause as a known exception.

**Risk.** Medium-high, concentrated on Windows, which has never run this suite — the existing Windows job runs a hand-picked file list on Linux and only packages on Windows. Expect path-separator and process-startup surprises. Do not schedule Windows end-to-end as the last task.

### R6. Disposition of the remaining lifecycle findings

- **A1** (`throttlingSupported` lies on Windows) — **the seam already exists and is simply not wired.** `WindowsSuspendHelper` takes an `onError` callback (`apps/agent/src/platform/windows-suspend.ts:93`) and exposes `disabled()` (`:126-128`), but `platform.ts:282` constructs it with no options, so every failure hits a no-op default — the helper knows it has given up and nothing asks. Three hops: pass `onError` and export a listener; make `processPauseSupported()` a live read of `disabled()` instead of the static constant at `:44-65`; make the governor's flag mutable and read it live through the existing change→broadcast path. `queue.pauseSupported()` then self-heals, un-wedging the estimate-prioritisation early return — the half of A1 that silently kills estimates for the session. Land **after** R2 step 3: the early return sits inside the method R2 rewrites.
- **A2** — two distinct bugs sharing a symptom. Clean quit waits for R2 step 6. **Crash or forced quit (FR-003a) is independent and cheap**: `queue/store.ts:154-166` already maps `processing → interrupted` at load; unlink right there, where the code has already concluded the run died mid-flight. Ship that half immediately — it is the case the user actually hits.
- **A3** (media actions) — the biggest, and confirmed worse than the finding states: the route is guarded by the native token rather than the browser session, and the web app has **zero** references to it, so a Finder conversion is entirely invisible to the interface. US1 scenario 8 is unconditional. Give it a real lifecycle and a real cancel on browser-session routes, with a scaled deadline so a wedged conversion cannot recur even with no window open. **Refuse the sixth live connection** — FR-009b and SC-020 bound how many the interface may hold, and adding one for the shortest-lived queue in the product is the wrong direction; ride the compressor's already-open stream by extending its state object, which is "extend, don't reshape". **Refuse persistence**: adding a store to satisfy FR-006 is new capability, which the Assumptions rule out. The honest change is to mark abandoned jobs cancelled on shutdown, unlink their partials, and label the list session-scoped — then nothing claims to survive a restart, so nothing lies.
- **A5** — closed *by* R2, not separately. Fixing it in isolation means another guard on the same tangle, which is the class of defence this pass exists to remove.
- **A6** — fully independent, smallest fix in the set, and now anchored: `TERMINATION_PIN_CYCLES` (`power/governor.ts:83`) is decremented only from `suspendAll` (`:537-545`), so the pin ages on duty-cycler ticks rather than on a clock; when the cycler stops the pin freezes forever. Age it on wall clock and evaluate it in the retune and set-limit paths too, so the check survives a stopped cycler.
- **A7** — fully independent and a one-line pattern already in use: `activeThreadBudget()` exists at `power/spawn.ts:220-222` and is used exactly this way at `whisper/transcriber.ts:364`. Evaluate the render concurrency per run instead of at module import, and re-evaluate on the governor's change event so FR-012a and US2 scenario 3 both hold. The cheapest requirement in the pass.
- **A12** — transcription must map a restarted run to `interrupted`, not `failed`; folds into R1 step 7.

---

## Part 2 — Live state, interface and performance

### R7. Connection budget

**Measured facts.** The public site is served over HTTP/2, and **it does not matter**: the six-connection cap is per origin, and the origin the browser opens streams against is the local app, which serves plain HTTP. The arithmetic already fails today — two workspace tabs alone reach six, and the next start or stop queues forever. **D10 is not a hypothesis; it is arithmetic.** Worse case worth naming: when the local app serves the page itself, the bundle's own requests share that pool.

**Decision.** Two steps, both required.

1. **Replace the browser's built-in event-source client with a fetch-based reader.** This is the step that lets the token travel as a header, which C4 requires; the built-in client cannot send headers. The existing hook keeps its signature and its hand-rolled reconnect.
2. **Multiplex all channels onto one stream** with a channel field per frame, demultiplexed on the client.

**Compatibility.** Do not break older local apps: gate on a new capability flag and fall back to today's seven URLs when it is absent. Do not delete the old endpoints in this release.

**Alternatives considered.** **HTTP/2 on the local app — rejected as impossible, not merely hard.** The agent listens over plain HTTP with no TLS anywhere in the tree. Fastify supports HTTP/2, but without TLS that is cleartext h2, which **no browser implements** in either the upgrade or the prior-knowledge form; the only path is ALPN over TLS. TLS on loopback means either a self-signed certificate with a manual trust step — which destroys the onboarding the whole pairing module exists to make painless — or a publicly trusted certificate with its private key inside the application bundle. A SharedWorker — rejected for now: it solves cross-tab multiplication but not the seven streams inside one tab; after multiplexing, four tabs cost four connections, which is fine. Keep it as a fallback. Long polling — the same one connection with worse latency and twice the code.

**Risk.** Medium. Two real traps: a hijacked response bypasses the normal send hook, so the new branch must set its own cross-origin headers; and a streaming response needs buffering explicitly disabled and no compression on that route. The capability-gated fallback makes rollback free.

### R8. State desync

**Decision.** A monotonic `revision` on each tool's state snapshot, plus one guard function applied in a single place.

**The property that makes it correct**: every mutation broadcasts synchronously, so an HTTP response carries exactly the revision that was just broadcast. Identical snapshots are a no-op; a slow response carrying revision N that lands after N+3 is discarded.

**The implementation detail that keeps it cheap**: do not scatter the increment across the thirty-plus notify call sites — wrap the injected notify callback once in the constructor. Three lines per queue. And do not touch the ten mutation sites in the interface: put the guard in the provider so both the live-update writer and every mutation are protected by construction, without changing the context's public shape (which would break the five tests that use the test override).

**One exception that must be coded explicitly.** A fresh connect is not a stale write — after a local app restart the revision legitimately goes back to zero. The connect path resets in bypass of the guard, keyed on the instance identity the health endpoint already reports. Forgetting this is the one way to ship a UI frozen on stale state; it needs its own test.

**Alternatives considered.** Per-job timestamps — rejected: they do not cover settings, batch, running or warning, which are overwritten too, and they add clock comparison where none is needed. "Live updates are the only writer" — attractive, but the window between reconnects leaves state with no writer at all, and a mutation with no visible effect reads as a dead button.

### R9. Re-render cost

**Decision.** `useSyncExternalStore` with selectors, wrapped in the constitution's context idiom, split into two contexts. **No external store library.**

Principle VI states the idiom literally — a context, a hook that throws outside its provider, and a test override — and says to keep new code inside these seams. A hand-rolled store breaks both the idiom and the five tests that use the override. `useSyncExternalStore` is a React primitive, not a dependency, and lives inside the provider. The existing `useAgent()` stays as a shim, so nothing regresses; hot consumers migrate to selectors and stop reacting to progress.

**What `JobRow` needs to become memoizable — four conditions, all required, or the memo is a no-op.** (1) Wrap it. (2) **Stable job identity**: the agent clones every job on every broadcast, so shallow comparison always fails. Fix on the **client**, not the agent — reconcile incoming state against the previous one by id and return the *old* reference when nothing changed, and the old array when no job changed. Thirty lines, one file, zero agent changes — and it fixes E3 for free, because the memos keyed on the jobs array stop recomputing every tick and the per-render id-join key can be deleted. Agent-side clone caching was considered and rejected: invasive across thirty mutation sites for the same result. (3) **Stable callbacks**: four inline arrows, plus moving the selection arithmetic behind refs so the handler is created once. (4) The translation function is already memoized by language; no work needed, just do not wrap it in anything expensive.

**Risk.** Medium-high — the largest surface in the interface set. `useSyncExternalStore` requires a cached snapshot or it loops. Sequence it **after** R8, because the reconciliation naturally lives inside the writer R8 creates.

### R10. Disconnect handling

**Decision.** One behaviour: the tool page stays mounted and degrades in place. The gate lives in the page, not the router. **Revive the unreachable in-page degradation at `apps/web/src/App.tsx:392-425` rather than deleting it** — it is the correct UX, already written and already translated, and it is what makes the compressor behave like the landing pages.

Three changes: the setup screen stops reacting to transport and shows only when the app is connected but does not support the tool; the dialog is never un-closable (the modal renders no close control without both a label and a handler — the label is already passed, the handler is missing, so this is one line); and the transport waits a grace period before reporting a loss at all, so a short blip never reaches the interface.

Two derived fixes without which the download prompt still appears: give the disconnected state its own branch instead of letting it fall through to the generic onboarding panel, and make the home page distinguish "never connected" from "was connected".

For frozen-progress: pass connection state into the row so the flowing animation and the ticking timer both stop. Frozen data must not look live.

**Alternatives considered.** An overlay over the mounted page — the same blocking modal with different code. Delete the dead branch and show the dialog correctly — rejected: a download prompt is the wrong answer for a person whose local app is running.

**Under 60 lines total** — the best pain-to-diff ratio in the whole feature. **But**: the audit states plainly that this was never observed in a browser. **First task is to reproduce it**, not to fix it.

### R11. Re-pairing

**Decision.** An in-page handshake through a hidden frame and a posted message, with the existing full-page navigation kept **only** as a timeout fallback, so nothing is ever worse than today. The local app serves a minimal handshake document that posts the token to a **server-chosen** target origin — never a wildcard, never the requesting origin. The interface verifies origin, source and a one-time nonce before adopting.

**Why not a JSON endpoint returning the token.** That is precisely the jackpot C2 and C5 warn about: one cross-origin read and an attacker is paired. The frame form gives a hostile embedder nothing, because the target origin is fixed by the server. It is no weaker than today's redirect, which any page can already trigger.

**Cross-tab.** The broadcast channel already exists. Two changes: **move the auto-pair budget from per-tab to per-browser storage** — this is exactly why three tabs burn three budgets and the third falls to a manual screen — and add a short claim-election before the handshake so one tab performs it and the others wait for the broadcast.

**Alternatives considered.** A popup — rejected: it needs a user gesture, so automatic re-pairing, which *is* the problem, cannot use it. Reading the redirect programmatically — rejected: a cross-origin redirect is opaque. Serialising page state before navigating — rejected: it means serialising a 1,700-line editable transcript and every open dialog, which is more code than the handshake and still flashes the page.

**Risk.** Medium, concentrated in the message listener: a mistake in the origin or nonce check turns the fix into a vulnerability. Four tests are mandatory — wrong origin refused, wrong nonce refused, timeout falls back, two tabs produce exactly one handshake.

### R12. Interface execution order

**R10 → R8 → R7 → R11 → R9.** R10 is cheapest and most visible. R8 creates the writer that R9's reconciliation lives inside. R7 must precede R9 because it rewrites the hook R9 attaches the store to. R9 is last because it is the largest surface.

Note two couplings outward: R7 closes the live-stream half of C4, and the live-connection cap and heartbeat from the security work belong to whatever transport R7 lands.

---

## Part 3 — Verification pipeline

### R13. The single command

**Decision.** `scripts/verify-all.mjs` — `.mjs`, because it imports the shared contract and shells git, which is exactly the constitution's rule. Two npm scripts over one implementation and one flag, differing **only** in the gate list, so FR-014a's "never in how a result is reported" is structurally true rather than aspirational.

**Four phases: parallel within, strictly serial between.**

| Phase | Gates | Fast | Release |
|---|---|---|---|
| 0 — seed | build shared | ✓ | ✓ |
| A — static, read-only | format · lint · 6 typecheck projects · styles · i18n · audit — parallel | ✓ | ✓ |
| B — suite, **exclusive** | vitest (+ coverage in release) | ✓ | ✓ |
| C — builds & contract | build web · build agent · release/env/team contract checks — parallel | ✗ | ✓ |
| D — out-of-process, **exclusive** | end-to-end · database · accessibility sweep · review app | ✗ | ✓ |

**Phase B is exclusive because of A17**, not because of general caution: the suite rebuilds the shared package's committed output and rewrites a tracked migration while other phases would be reading both. It is also pointless to overlap — the suite already burns 183 s of CPU in 33 s of wall clock. The lasting fix is to give the generator an output-directory flag so the test generates into a temp directory; until then, exclusivity is enforced in the aggregator rather than by convention.

**Measured budgets.** Fast ≈ **41 s** against a 120 s ceiling. Release ≈ **7–8 min** against 10, with the accessibility sweep the only part at real risk of blowing it — cap it with a per-gate timeout that fails the gate rather than hanging the command.

**Output contract — extend the existing envelope, do not reshape it.** Keep `ok`, `command`, `generated_at`, `data` and the failure twin verbatim; add `form`; **drop `period`**, because this is not a time-window report and a null period would misrepresent a contract the constitution calls stable.

**Alternatives considered.** A zsh script — rejected: the constitution reserves shell for packaging, and gate orchestration needs structured assembly. `.ts` via tsx — rejected: reserved for the analytics CLI, and adding a transpile step to the thing that must be fastest is backwards. The already-installed process runner — rejected: it cannot express phase barriers, per-gate capture, or a structured result.

**Risk.** Medium — the aggregator becomes the single point of failure for every gate. It needs its own test asserting each gate appears in exactly one form's list, that a stubbed failing gate surfaces its own id, and that the line budget holds.

### R14. Output budget

**Measured**: `--silent=passed-only` with the dot reporter already fits the budget — 20 lines including a real failure with its full test name and error — and it removed **100%** of the known stderr noise with no filtering at all.

**Decision.** Dot reporter for humans plus the JSON reporter for structure; capture the rest into a bounded ring buffer that is **discarded on success and excerpted on failure**. Per-gate extractors pull the first few diagnostics in each tool's own words — the aggregator never re-formats what a gate said about itself, it truncates. Full untruncated output always lands in the result file and the CI artifact, so nothing is lost, only unread.

**Alternatives considered.** The dot reporter alone — rejected: 1403 dots is one unreadable line, which technically satisfies a line budget and helps nobody; the JSON reporter is what makes summarisation structural. A custom reporter — rejected: a maintained dependency on test-runner internals for data the JSON reporter already carries. **Filtering the two known-noisy files by name — rejected outright**: a named-file allowlist silently stops working on rename and can suppress a genuine error.

### R15. Type-checking tests and scripts

**Measured, and smaller than feared**: type-checking the test tree is a **115-error job**, and with the right library types plus a one-line shim **every error is in `tests/` except six — which are real errors in three backend function files that nothing type-checks today**. About 65 of the 115 share one systematic cause, so widening a single helper signature clears half.

**Decision.** Two new root configs, no project references. A check config for tests using **bundler-style resolution deliberately** — the test tree imports three incompatible worlds and no single Node-style config can span them — and this does **not** weaken the repo's mandatory explicit-extension rule, which is enforced on *source* by three existing configs that stay exactly as they are. A second config type-checks the scripts with implicit-any relaxed but null-strictness **on**.

**Yes, the `.mjs` scripts can be type-checked, and it finds real bugs.** Under the chosen profile: 82 errors that are overwhelmingly genuine — a fetch result used without narrowing, a role value passed into a parameter that excludes it — versus 250 under full strictness where 118 are untyped-parameter noise. Nearly a third are possibly-undefined, which is the class of bug that makes a release script crash halfway.

**Rollout as a ratchet, not a cliff.** Both configs land with an exclusion list naming today's failing files; the gate is green on day one; the list empties file by file, and a test asserts it never grows.

**Alternatives considered.** Project references — rejected: they force declaration emit on the web app for a seven-second job. A config inside the test tree — rejected: editors and build walks would pick it up, and it puts test-only shims where they read as production types. Converting the scripts to TypeScript — rejected: violates the script-language rule and adds a runtime to every release path. Type-aware lint instead — rejected: needs the same config anyway, is roughly four times slower, and reports a strict subset.

**One durable risk**: the two resolution styles could later be misread as "this repo doesn't need explicit extensions". Mitigate with a comment block at the head of the check config stating the rule and naming the three configs that enforce it.

### R16. Coverage

**Decision.** The V8 provider — the one genuinely new dependency in this design. Instrumentation-based coverage is rejected: it roughly doubles a 33-second suite and the web tree is already built by the bundler, whose source maps the V8 remapping consumes natively.

**`all: true` is non-negotiable.** Without it the ~50 modules no test imports simply do not appear and the baseline is a lie.

**Baseline as a committed file enforced by the aggregator, not by runner thresholds** — because the rule is not a single floor: global must not fall, **and** no file may fall by more than a small tolerance, **and** a named set has an absolute floor regardless of baseline. One place owns the verdict.

**FR-018a enforced structurally, not by a hand-maintained list.** A committed critical-modules file carries absolute floors for run-state modules and is checked *before* and *independently of* the ratchet, so a falling global can never excuse an uncovered state module. **Membership is derived**: a test walks the import graph from the run-state entry points and asserts every module reached is listed. Adding a state module without listing it fails the gate — which is the same mechanism SC-003 needs, so it is built once and used twice.

**Expect the first measured figure to be low** — plausibly 45–60% with all files counted. That is the correct baseline, and the spec's Assumptions already say so.

### R17. Skip semantics

**Decision.** A shared requirements helper with a **collection-time probe**, not skip-conditions sprinkled at each site.

The reason is mechanical: at all fourteen sites the availability flag is assigned inside a before-all hook, so a collection-time skip condition reads false and would skip everything. Top-level await in a module makes the probe run at collection, which is what the condition needs.

**Reasons are encoded in the suite title** (`[needs: ffmpeg,ffprobe]`) and read back from the JSON report — no ledger file, no global state, no reporter plugin. SC-007 then becomes checkable in one line: **a skipped test whose name carries no requirement marker fails the run**, on every runner. And a release-mode flag makes the probes **throw** instead of reporting missing, so a release runner without a required binary fails loudly naming it, rather than quietly reporting zero skips because nothing ran.

**Regression guard — a rule, not a review habit.** A local lint rule banning a bare early return as a conditional's consequent inside a test callback. The constitution has named this anti-pattern since ratification and it is still present in fourteen places; a rule is the only thing that ends that.

### R18. CI matrix

**Node skew first.** Add an engines range and a version file, and switch every workflow to read it. That kills the 22-versus-24 skew at its source instead of in three places, with a test asserting no workflow pins a literal version.

**New pull-request workflow** with cancel-in-progress, four required jobs: **static on Linux** (format, lint, all six type-check projects, styles, i18n, audit — ~2 min at the cheapest minute rate), **suite on macOS** with coverage, **suite on Windows**, and **build on both** — which closes the "the agent is never built by CI" gap.

**The end-to-end job runs on push to the default branch and on labelled pull requests, not on every pull request.** That is the single biggest minutes lever and the right trade: the harness needs a full build plus real binaries, and its failures are rarely local to a pull request. Steady-state cost lands around 78 billable minutes per pull request.

**B11 — delete the hand-maintained fifteen-file list, do not fix it.** Run the whole suite on Windows; the tests that genuinely cannot run there become named skips under R17, so they skip *with a reason and a count* instead of being excluded by a list that rots silently. The list is a workaround for the missing skip mechanism; once R17 exists its reason for being is gone. Interim safety while R17 lands: one assertion that every path named in a workflow's test invocation exists on disk.

**Risk — medium-high and concentrated in one place.** Running the full suite on Windows for the first time will surface real failures, starting with B8's hardcoded absolute temp path, which cannot work there at all. Land the Windows job as non-required for one cycle, then flip it.

### R19. Consistency gates

**Stylesheet checker: hand-written with a CSS parser, not a linter framework.** This is settled by one measurement: a two-line pipeline found 21 undefined custom properties, but **12 are legitimate** — set from inline styles in components. The obvious off-the-shelf rule resolves definitions only from CSS and would flag all twelve, so it would be switched off within a week. Cross-referencing the component tree *is* the job, and no existing rule does it. The other three rules each need a custom plugin anyway — at which point the checker is written, inside an API nobody controls, having added four dependencies. **The real defect set is nine undefined properties — exactly F1's list, independently confirmed.**

**Accessibility runner: generalise the harness that already exists.** The review app already drives headless Chromium with an accessibility engine and fails on serious findings; extract its core, hoist the two dependencies to the root (installed, not new), and add a second driver that serves the real built app and walks the route matrix — roughly 13 routes × 2 themes × 2 languages = 52 loads, release and end-to-end only.

**The route list must not become another B11.** The tool registry is already the declared source of truth for tool routes; extend it to cover the rest and assert that every literal path compared in the routers is a member. The matrix is then derived from a module the app itself uses, so a new route cannot be added without entering the sweep.

**The authenticated-route problem pays a dividend.** Most routes need a session and a paired local app, so the driver injects a stub session and intercepts calls. That interceptor **is** FR-021's "fake local app for interface tests" — build it once, consume it from both the browser driver and the 64 component tests that currently hand-mock their client. One artefact, two requirements.

Rejected here: a jsdom-based accessibility check — it computes no layout, so contrast and focus-order, which are the actual high-severity findings, are exactly what it cannot see. And the review app must not become a driver for the real app; it renders its own mock surfaces and has an isolation verifier enforcing that.

**Expect a large initial violation set** given F8–F11. Land the sweep in report-only mode with a committed baseline, same ratchet shape as coverage, then drive to zero.

**Unused-translation checker: scan every string literal, not every call site.** F12's warning about runtime-constructed keys is smaller than it looks: of ~50 non-literal call sites, nearly all pass a variable holding a literal declared elsewhere, and scanning all literals resolves every one. The helper F12 names returns literals that the scan finds. **There is exactly one genuinely constructed key in the whole app**, so the allowlist starts with one entry. Keep it honest with a lint rule forbidding the cast that marks a constructed key unless the file is registered — so a new dynamic key cannot silently start producing false positives.

**Dependency gate: parse the audit output in the aggregator**, never run it as a bare script (it exits non-zero and prints prose that blows the line budget). Block on production high or critical; count dev-only findings as informational. A **dated** exception file where an expired exception fails the gate, so a deferral is a decision with a review date rather than a permanent hole. **The gate must land in report-only mode and flip to blocking in the same change that clears today's three production highs** — never land a gate that is already red, or it gets bypassed.

**Two new dependencies in total** for the whole verification design: the coverage provider, and promoting a CSS parser already resolved in the lockfile to an explicit root dependency.

---

## Part 4 — Security

### R20. Signing and update integrity

**macOS.** Replace the ad-hoc signature with a full Developer ID chain: sign inside-out (every bundled binary and helper first, then the app), hardened runtime, notarize, staple. Determine entitlements from what the app actually does rather than copying a permissive set; it spawns child processes but does not need to relax library validation for that. **The chain is testable without real credentials** — build it against a self-signed identity in a throwaway keychain, which is what makes SC-010's "proven with test credentials" achievable before procurement.

**Windows.** Sign the tray host before the installer is compiled and the installer after, with an RFC-3161 timestamp and retries, then verify; fall back to a self-signed identity when the secret is absent so the workflow is exercised on every run. Assert the signature in the existing package verifier and smoke test.

**Artifact contents.** Be honest about the limit: the browser cannot verify bytes it did not fetch, and there is no in-app updater. So the signed manifest gets **host pinning and a hash-shape check at read time** — a stolen signing key then still cannot redirect users to another host — and the release verifier re-hashes the artifact it publishes. Operating-system publisher verification, not the recorded hash, is the mechanism that protects the downloaded bytes.

### R21. Browser origin

**Decision.** A hash-based policy over the two inline blocks, with the boot-recovery block rewritten to drop its inline handler and inline styles, plus the full protective header set. The theme bootstrap stays inline — it exists to prevent a flash before hydration and moving it to a file reintroduces exactly that.

Get the connect list right: it must cover the local app on a **variable port** and the backend, and nothing else.

**Rollout.** There is no violation collector here, so the report-only phase is replaced by something cheaper and permanently useful: a browser smoke test that walks pair → compress → open a preview → sign in and asserts **zero policy violations in the console**. That becomes the regression gate.

**Risk.** Medium-high *operationally*, low technically. A policy mistake is invisible to unit tests and total in production. The smoke test is not optional.

### R22. The path-grant ledger

**Decision.** An authoritative in-memory ledger of paths the user actually chose, minted only at user-driven selection points, consulted by every route that names a location, and **rebuilt on boot from the durable tool state it authorises.**

Long term the three routes stop accepting paths at all and take grant identifiers instead — the interface can only echo an identifier the local app handed it, so it cannot invent a location. Where a raw path must still be accepted, it must resolve to an existing grant or a descendant of a directory grant. **The Finder path is not an exception**: it arrives from a token-authenticated local process, so its handler *mints* a grant and then runs the same code as everyone else. One check, no bypass.

**The write-scope trap the audit under-weights.** The compressor writes its output next to the original, so a read grant on a file naively implies write access to its whole folder. Model it instead as "may write only a name matching the derived pattern in the input's own directory" — otherwise picking one file silently grants write across a directory.

**Surviving a restart without breaking FR-006 — the crux.** Deliberately **not** a separate grants file. The persisted queue *is* the record of user-chosen paths and is written only by the local app; on boot, mint a grant for every path the durable tool state references. That set is exactly what FR-006 must restore, so restoration and authorisation cannot disagree. Two files would drift, and both failure modes are bad: "queue restored but refuses to run", or a grant outliving the job that justified it.

**Three things must be true for the boot re-mint to be trustworthy, and none is true today** — which is why C18 and C19 stop being cosmetic: the state file must be written with owner-only permissions like the token file already is; the support-directory and state-path environment overrides must be validated and refused in a packaged production build; and the re-mint must resolve and stat each path, not merely check access.

**Time-of-check defence.** Capture device and inode at mint and re-check at use. A queue job sits for minutes between grant and read, and a symlink swap in that window is the realistic attack.

**The refusal must not become an oracle.** One stable code for every cause — not granted, expired, inode changed, out of bounds — because distinguishing them turns the route into an existence oracle for arbitrary paths. And **do not stat the requested path before deciding**: match against the ledger in memory first and touch the filesystem only for paths that matched, or timing leaks existence. Log a hash of the path, never the path.

**Windows specifics that are real bypasses if missed**: compare case-insensitively, normalise separators, resolve extended-length prefixes **and short (8.3) names** — the standard realpath resolves junctions but not short names — and reject network paths unless the grant is itself one.

**Risk. High** — the failure mode is "the user's queue empties itself after an upgrade", which is user-visible and trust-destroying. Three mitigations: ship in **observe mode** for one beta cycle so the false-refusal rate is a measurement rather than a hope; pair the adversarial suite with a **positive** suite (pick → restart → resume; drop → restart → resume; output folder still writable); and **no kill switch** — an environment flag to disable the check would be the first thing an attacker sets, and C19 already shows environment is too trusted here.

**Sequencing.** Must land **after** the queue-restoration semantics from Stories 1–3 are settled. Building the ledger against restoration behaviour that is still moving is precisely how you ship an empty queue.

### R23. Tokens, host validation and logs

**The token in URLs splits three ways and needs three answers.**

- **Streams** — owned by R7, not decided here. The contract R7 must satisfy: carry the token as a request header, or authenticate with a single-use, short-lived, stream-scoped ticket that is not the session token; re-authenticate on reconnect rather than replaying a long-lived URL; and produce a connection URL that is safe in a log and in a referrer. R7's fetch-based reader satisfies this trivially.
- **Subresources** (images, previews, media with range requests) — headers are impossible for an image element, and converting to blobs breaks range requests for large media. **Per-resource capability tickets**: opaque, path-bound, five-minute, derived from the session secret but *not* the session token, so a leak costs one image for five minutes rather than the machine. It reuses the ticket shape the team bridge already has.
- **Cookies are a dead end**, worth stating because it is the first thing anyone proposes: the local app is a different site from the hosted app, so a same-site cookie is never sent on these requests, and the cross-site form requires a secure context that loopback HTTP cannot reliably satisfy.

**Constant-time comparison** — the helper already exists twelve lines below the offending comparison in the same file. Add a type guard while there: a repeated query parameter yields an **array**, which reaches the raw comparison today.

**Host validation: one request hook, registered first, applying to every request with no path exemption**, ordered host → origin and fetch-metadata → token → failure counter. The early hook phase is the correct one because it runs before body parsing, so a hostile request never causes a byte of an upload to be read.

**The prize is not what the audit says it is.** The audit frames rebinding around a health endpoint leaking instance details. The real exposure is that **the pairing endpoint hands out the session token to anyone who asks** — a rebound page that follows that redirect and reads its own fragment is fully paired. Closing that is what this hook is for.

**The native carve-out is positive, not negative.** Rather than "no origin means trusted", reject the native routes whenever a browser fetch-metadata header is present at all: every modern browser sends them on every request, and native HTTP clients never do. That makes C6's permissive-missing-origin hole non-exploitable on the routes that matter without touching the launcher.

**Logs: configure the logger, do not disable it.** Emit the **route pattern** instead of the raw URL — one change kills the query string and every path-shaped identifier at once, and route patterns are more useful for diagnostics anyway. Redact the token headers and, critically, the **redirect location header**, which is what carries the token on the pairing response. Add a belt-and-braces formatter that scrubs any remaining 64-hex string. Redirect the local app's own output to an owner-only rotating file rather than system-wide logging. Note that the default error serializer logs full messages — so C17's map-to-codes fix is the same fix wearing a different hat; do them together.

### R24. Limits

**The single most valuable line in this section: invert the multipart default** from effectively unbounded to a modest ceiling, so a route that forgets to specify is safe rather than open, then opt in per route — following the pattern one route already gets right. Real media routes get a large but **bounded** ceiling; a video compressor genuinely handles tens of gigabytes, and pretending otherwise would break the product.

**Aggregate budget for the per-file folder-upload loop**: per-file limits do nothing against a hundred thousand files. The upload session carries a file count, a total byte budget and a wall-clock budget, and refuses by tearing the session down rather than leaving it half-written. Give the session an identifier the client must echo, so two tabs cannot interleave into one directory — today only an incidental throw prevents that. Bound path depth and segment length: a thousand-deep path is a filesystem denial of service regardless of traversal safety.

**Rate limiting — yes, but scoped, and it is not the important control.** Honest reasoning: on loopback the caller is either a page that got past host and origin checks — in which case this is the last line, and it matters for the two things worth brute-forcing — or a local process, which HTTP-layer controls cannot defend against at all. No global limit (it would throttle legitimate reconnect storms and the upload loop). The key generator returns a constant, because every request is loopback and a per-address limiter here is theatre — say so in a comment. **The actual anti-brute-force control lives in the auth hook, not the limiter**, because it must key on *failure* rather than request count. And state the arithmetic honestly: a 64-hex token at twenty guesses a minute is unbreakable by many orders of magnitude, so this exists to make the attempt visible, not the search infeasible.

**Live-connection cap: evict the oldest, not the newest** — refusing the newest makes the app look broken to the person who just opened a tab, while the oldest is overwhelmingly a dead one. Send a terminal frame first so the evicted client reconnects instead of hanging. **More valuable than the cap**: a heartbeat and a stalled-writer drop. Today a stalled reader makes the broadcast buffer unboundedly in memory for every event, inside the queue's drain loop. That is a live memory leak, not a hypothetical.

### R25. Security execution order

**Wave 0 — unblock and de-risk. All pure code, all independent.** Dependency upgrades then the audit gate (everything after ships on a clean tree); constant-time comparison and host validation in one unified hook (the two live-confirmed holes); logger configuration, which must land *before* anything else starts emitting new log lines; and the multipart default inversion — two lines that remove the largest single-request amplification in the product.

**Wave 1 — signing, code half.** macOS chain and Windows chain, both proven against test identities, plus manifest host pinning in the same change so the update story is coherent. **Then the credential gate** — substituting real credentials into a chain already proven end to end is the *only* part of this feature blocked on anything external.

**Wave 2 — the browser origin.** Parallelisable with Wave 1 by a second person.

**Wave 3 — tokens out of URLs.** Subresource tickets are unblocked; the stream half waits on R7 and takes whatever transport it lands.

**Wave 4 — the path ledger and its prerequisites.** Environment validation and file modes first, because they are what make the ledger trustworthy rather than decorative; then the ledger in observe mode; then open-target validation and temp cleanup, which touch the same lifecycle code.

**Wave 5 — genuinely parallel, unblocked, any time.** The unauthenticated backend path's grant tickets (a different runtime and repo area with zero coupling — it can start on day one), verify-before-adopt pairing, command-construction fixes, the error-code taxonomy paired with the log work, environment-gated backend origins, and the remaining budgets.

---

## Cross-cutting sequencing

The whole feature has one hard prerequisite and three coupling points:

1. **The typecheck gate (R15) gates SC-003.** Nothing in R3 is enforceable until tests and scripts are type-checked. It is the first task in the feature.
2. **R7 (one multiplexed stream) unblocks the stream half of R23** and owns the connection cap from R24.
3. **The queue-restoration semantics settled in R1/R2 gate R22.** The path ledger is rebuilt from persisted state, so that state's shape must stop moving first.
4. **R4's observation harness and R16's coverage-membership walk are the same structural idea used twice**, and R5's scenarios are generated from R3's tables — build each mechanism once.

Two things are true of every decision above and worth restating: prefer a rule that makes the wrong thing impossible over a test that notices it — the existing spawn-import ban is the model — and **reproduce before fixing** anything in the interface set, because the audit is explicit that none of it was observed in a browser.
