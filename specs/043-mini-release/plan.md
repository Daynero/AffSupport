# Implementation Plan: Web-only mini release MVP

**Date**: 2026-10-25. **Source**: [spec](spec.md). **Budget**: target 3–4 hours active implementation; unavailable external acceptance remains explicit.

## Summary

Extend the current deploy gates with a strict web-only admission. Preserve full release runner/state/schema and normal packaged-beta exact-SHA behavior. Default command is read-only check; verify-only creates a separate exact-input proof; deploy reuses a valid proof or performs verification, then uploads owned verified bytes and confirms actual serving.

## Technical Context

Node ESM mjs, existing Vite/Vitest/playwright-core/crypto/fs/pg and release contracts. No new product dependencies or agent product/version changes. The additive DB phase uses PostgreSQL 17+ and pinned Supabase CLI 2.117. Private files under existing ignored release/automation and release/web-only paths. Existing trusted local execution; the larger separate-user/PF/inspection design is deferred by explicit owner scope choice.

## Constitution Check

Single release identity/signing/published checks retained. Proposed explicit web-only proof exception is documented in constitution/AGENTS/runbooks; full packaging promotion unchanged. Existing production activation remains required and no production writes happen during implementation. Unknown compatibility and missing historical package provenance fail closed. Analytics SELECT-only seams unchanged; independent web identity uses the existing typed envelope.

## Source Structure

- scripts/release-web-only.mjs and verify-web-only.mjs: source/config guards, serialized stages, resource limits and structured outcome.
- scripts/lib/web-only-policy.mjs: Git-blob/tag/clean-source boundary, conservative path/package policy.
- scripts/lib/web-only-proof.mjs: historical package, signed live manifest, exact hashes, freshness and live readback.
- scripts/lib/web-only-runtime.mjs: exact beta candidate static broker, real sign-in, visible packaged operation.
- scripts/lib/web-only-lock.mjs and web-only-resources.mjs: single-writer and bounded host admission. Existing release/execute.mjs and gate.mjs add opt-in owned process supervision and hierarchical cancellation; normal full-runner behavior stays separate.
- scripts/beta-package-provenance.mjs plus existing beta packaging/verification scripts: record actual payload at package time, independently match after runtime.
- Existing deploy/rollback/metadata helpers: immutable upload snapshot, signed channel/target guard, correct recovery history.
- Central tests cover actual policy, filesystem/signature, provenance/proof, static-vs-real API, resource and recovery behavior. Full runner fixtures remain in scope for regression, not refactoring.

## Execution and validation

1. Check clean candidate against canonical released agent tag; reject mixed/protected changes.
2. Read host headroom, hold shared local web lock; seed shared before importing release dist.
3. Match historical package provenance, run serial normal verify and build beta/production web configurations with independent IDs.
4. Run existing environment/team/final/published gates and real packaged runtime plus candidate browser; rehash immutable inputs and write fresh web-only proof.
5. For deploy, preserve existing production activation, validate proof again, upload the exact prearchived snapshot. Live smoke and byte readback independently confirm result; errors retain partial/unknown state.
6. Explicit rollback refuses changed binding/channel/bytes and appends fresh history only after provider acceptance.

One heavy command at a time; nice 15; Node heap 1024 MiB (2048 MiB for the static/compiler gate with ≥25% memory headroom); GOMAXPROCS/UV pool two; test workers one; sequential live reads. No copying installer/runtime trees or rebuilding native agents for development validation. The DB phase installs only the pinned rehearsal CLI once under ignored release/automation/mini-db-tools, without application dependency changes. Recheck measured resources before any broad suite/build; existing unrelated work remains untouched.

## Deferred Work

[Full plan](plan-full.md) and [82-task backlog](tasks-full.md) are retained for broader DB/functions/shared exceptions/isolated execution/universal runner work. Their previous design review is historical; it does not attest this smaller implementation. MVP tests replace the deliberately RED schema-v2 fixtures because schema-v2 implementation is no longer in the selected scope.

## Additive DB phase

1. `release:web --plan-db` reads the dedicated target through `SOTY_MINI_DATABASE_URL`, freezes Git migration inventory and exact live before-state, and writes a private draft. The default web-only path still rejects migrations without this explicit plan.
2. `mini-db-policy.mjs` implements a closed SQL grammar plus actual catalog guards: nullable builtin columns and plain nonunique btree indexes only, ordinary public tables, safe builtin comparison/collation, pinned relevant event hook, supported vendor ledger. All unsupported forms fail closed.
3. `mini-db-rehearsal.mjs` runs pinned CLI 2.117 in an owned one-CPU/512-MiB local container. Schema/roles only, no rows/passwords. Reconstruct the baseline, compare official A with mini A using the exact official statement tuples, then require next full CLI migration B to succeed. Persist immutable before/after and interoperability evidence.
4. `mini-db-plan.mjs` and `mini-db-release.mjs` bind source/target/rehearsal into the web proof, verify real beta schema, and retain the real browser/unchanged packaged-agent acceptance. `beta:verify:web --backend-plan=<draft>` creates this combined proof without production writes.
5. `mini-db-transaction.mjs` validates actual pre/post snapshots around one transaction containing the entire DDL batch and official ledger inserts. PostgreSQL 17 server transaction timeout, shrinking statement/lock budgets and durable session evidence bound failure. Confirm commit independently before web upload.
6. Shared pending state/`mini-db-writer-lock.mjs` block every web/backend writer on uncertainty. `release:web --reconcile-db` only reads target/session state and resolves exact committed/aborted outcomes. No down migration, automatic replay or stale-marker deletion. A later web upload failure preserves the committed additive schema.

Until a full agent release absorbs the new DB baseline, later pure web fixes still create/use a DB draft because the unchanged agent tag predates migration paths. Zero pending migrations adopt the exact already-applied state read-only; no empty apply/history replay.

Implementation checkmarks are separate from evidence. Run focused unit/contract checks serially, then an owned real interoperability/failure harness and real beta schema/browser acceptance. Record missing prerequisites as blocked. Release outcomes are bounded CLI diagnostics; central analytics cannot prove DB commit, and critical feature journeys need explicit beta evidence.
