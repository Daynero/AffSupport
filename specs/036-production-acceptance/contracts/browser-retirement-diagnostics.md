# Browser retirement diagnostic contract — T167 work in progress

This implementation remains isolated in NEXT. ROOT/Beta still use T168, schema357. The complete disposable chain including migration358 passed919pgTAP checks across37files plus14native PostgreSQL tests across4files; the source stack and its rows were unchanged, and the disposable database was removed. The new receipt file contributes34pgTAP assertions, including conservative cleanup-consumer coverage. The initial chain failure exposed missing classification of the two identity-only tables; the correction exempts only their exact closed column/type inventory and retains fail-closed JSON/FK/unknown-column detection.

Typed actor-fenced browser telemetry, legacy-backend fallback, read-only investigation/inspection and actor-bound audit pairing have separate passing related runs. These overlapping runs are not a complete current suite. Browser-terminal correlation is being added and requires its own failing integration tests and current checks. No automatic beta analytics, physical-browser logout, complete diagnostic coverage, runtime cutover, current full static result or production readiness is claimed. T169 separately tracks a reproduced SDK logout/session replacement race; passing mocked provider tests does not close it.

## Authority and compatibility

A new `retire_team_recovery_installation_observed(p_installation uuid, p_attempt uuid)` RPC must wrap the existing actor-scoped retirement RPC in the same transaction. It must derive authority exclusively from `auth.uid()`, retain the existing installation lock against in-flight enrollment/delegation, and never accept an actor supplied by the caller. The original RPC and its integer return remain unchanged for existing clients. This wrapper must not implement a second revocation algorithm.

The new RPC returns `{ attemptId, state: 'server_confirmed', retiredCount }` only after the revocation and its immutable receipt commit together. An empty scope can be confirmed with count zero. A matching attempt retry returns the original receipt without revoking a subsequently created delegation. Reusing an attempt for a different installation is invalid. Concurrent identical attempts must serialize; another actor may use the same random attempt UUID without learning or affecting the first actor's receipt.

## Bounded evidence

Persist only opaque attempt, actor and installation UUIDs, a nonnegative retirement count and server confirmation time. No JWT, refresh credential, browser storage content, provider payload, path, email or user content may be collected. Table mutation remains inaccessible to anonymous/authenticated/service clients; the guarded RPC is the only write path. Read-only CLI access must use the canonical analytics role/projection and preserve ownership/redaction conventions.

Idempotency receipt lookup precedes rate charging. New distinct attempts need a real-time per-actor budget, bounded rate state, and bounded indexed retention (30-day receipt horizon, independently capped deletion batches). The rate state must not widen existing native claim/probe buckets or depend on the tariff clock seam. Exact limits and rate refusal/fallback behavior require failing tests before implementation. No claim of global storage/load SLO follows from a bounded cleanup batch. Receipt expiry limits replay guarantees; no unattended retry may silently outlive that horizon.

## Browser evidence

Each invocation gets one opaque attempt ID before its first await. The session/JWT is captured for the expected actor; an asynchronous account switch cannot redirect the request to the replacement actor. Confirmation requires the matching attempt ID, the closed server state and an integer nonnegative count. A legacy numeric response, wrong attempt, malformed response, network failure or expired/missing/mismatched session is unconfirmed.

Typed attempt/outcome telemetry must be fenced against the current analytics actor. Do not emit an old-actor outcome under a replacement session. Losing a response after the server commits is client-unconfirmed even though the authoritative receipt can later establish server confirmation. Server confirmation does not prove native protected-key deletion or result visibility. Missing session before any server request remains explicitly unobservable/unconfirmed; no fabricated receipt or false success is allowed.

## Agent-readable diagnosis and verification

Existing read-only CLI investigation/inspection must distinguish: intent observed without server receipt; authoritative server confirmation with browser receipt missing; browser confirmation matching server evidence; absence/legacy-version unsupported data; native local cleanup unknown. Capability inventory and code map must expose missing evidence and old-client coverage honestly.

Required regression scenarios include anonymous denial, cross-actor scope, table/view write refusal, matching receipt, empty scope, wrong attempt, numeric legacy response, auth timeout, late response, concurrent account switch, duplicate/concurrent attempts, replay after a fresh setup, installation mismatch, rate/retention boundaries and unchanged JWT/lease clocks. Local live proof must use synthetic scope with no Drive connection or work, actual product function and real Edge/RPC/SELECT-only CLI, including loss before write and after commit. Apply no migration to production; the local stack requires a separately guarded cutover after disposable PostgreSQL checks.


Current runtime checkpoint: guarded W beta now serves the mirrored T167/T169 source on schema358; no reset or Google reconnect. Actual observed receipt/capture/SELECT-only CLI proof accepted8events, native handoff and retained-journal replay passed on UUID14d284e2. These are explicit Node/native/local-server proofs; physical browser and old non-cooperating tab limits remain. Current full/release verification is pending. See the T170/T167 proof artifacts.
