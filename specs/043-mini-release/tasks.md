# Tasks: Web-only mini release MVP

**Scope**: explicitly narrowed by owner to 3–4 hours; [spec](spec.md), [plan](plan.md). Original IDs T001–T082 remain in [deferred backlog](tasks-full.md); T006 timing remains historical. Active IDs continue from T083 to preserve traceability. Check completion only against real code/test evidence, not production deployment.

## Setup and boundaries

- [x] T083 Synchronize narrowed scope and proposed governance/runbook instructions in `specs/043-mini-release/{spec,plan,tasks}.md`, `.specify/memory/constitution.md`, `AGENTS.md`, `docs/PRODUCTION.md`, `docs/BETA.md`.
- [x] T084 Implement conservative Git/input eligibility in `scripts/lib/web-only-policy.mjs` and prove it in `tests/web-only-policy.test.ts`.

## Candidate verification

- [x] T085 Implement historical beta-payload provenance in `scripts/beta-package-provenance.mjs`, `scripts/package-beta-mac.sh`, `scripts/verify-beta-package.sh`; reject missing/changed baseline in `scripts/lib/web-only-proof.mjs`.
- [x] T086 Implement exact web proof, real candidate beta browser/runtime and unchanged full promotion in `scripts/lib/web-only-{proof,runtime}.mjs`, `scripts/verify-beta-runtime.mjs`, `scripts/verify-beta-promotion.mjs` and central tests.
- [x] T087 Add operator commands and bounded sequential/resource/report behavior in `scripts/release-web-only.mjs`, `scripts/verify-web-only.mjs`, `scripts/lib/web-only-{lock,resources}.mjs`, opt-in `scripts/lib/{release/execute,gate}.mjs` supervision, `package.json`.

## Publish and recover

- [x] T088 Harden exact snapshot upload, signature/binding/channel-safe recovery and history in `scripts/deploy-web.mjs`, `scripts/rollback-web.mjs`, `scripts/release-web-meta.mjs`, `scripts/lib/web-rollback.mjs` with regression tests.

## Verify and hand off

- [x] T089 Run targeted regression, lint/type checks, then resource-appropriate serial `npm run verify`; distinguish unrelated parallel changes and unavailable beta/runtime prerequisites in `specs/043-mini-release/reviews/mvp-verification.json`.
- [x] T090 Independently review the MVP, fix findings, update `specs/043-mini-release/quickstart.md`, coverage notes and implementation verdict; no package/deploy/migrations during implementation.

## Dependencies and scope

T083 → T084 → T085/T086/T087 → T088 → T089 → T090. Different pure files/tests may be authored together; all heavy commands remain serial. Missing old package payload provenance requires one-time normal beta preparation outside web-only, never a bypass. Runtime execution requiring real beta fixtures/native/browser is not replaced with mocked PASS. Functions/shared edits and broad DB changes remain deferred; the following owner-approved slice extends the original MVP.

## Implementation evidence

T083–T090 are implemented and reviewed. Static verification: 13/13 gates passed using the canonical fast verifier's static group with managed cancellation enabled. All 854 current unit files were exercised: 7,570 assertions passed, 41 declared skips, zero remaining failures. All eight original canonical shards ran; failed hygiene/changed files and the new cancellation file were rerun. This is a per-file latest-result validation, not a fresh single full-run receipt. Details: [implementation verification](reviews/mvp-verification.json), [independent review](reviews/mvp-review.md).

Native beta/browser acceptance, production upload/live serving, native packaging and DB migration were not run. The current mixed workingtree is correctly refused before builds. The existing beta package lacks a historical payload seal and requires one-time normal beta preparation on a clean eligible base; the mini command never creates that baseline by relabelling old artifacts. These implementation checkmarks do not authorize deployment or claim unperformed acceptance.

## Additive DB phase — implementation

- [x] T091 Implement closed SQL/source-tuple policy and semantic before/after guards in `scripts/lib/mini-db-policy.mjs`; author focused fixtures in `tests/mini-db-policy.test.ts`.
- [x] T092 Implement bound target/snapshot validation and atomic whole-batch DDL plus official ledger writes in `scripts/lib/mini-db-transaction.mjs`; include PostgreSQL 17 server transaction deadlines and independent commit-loss reconciliation.
- [x] T093 Implement pinned CLI 2.117 schema-only isolated rehearsal in `scripts/lib/mini-db-rehearsal.mjs` and `scripts/test-mini-db-isolated.mjs`, with owned one-CPU/512-MiB container and vendor A → mini A → next full CLI B evidence.
- [x] T094 Integrate read-only draft, exact DB proof/real beta schema checks, activation-before-web-upload and shared unknown-outcome writer blocking in `scripts/lib/mini-db-{plan,release,writer-lock}.mjs`, web CLI and existing full/backend writer seams.
- [x] T095 Update active specification, plan, quickstart, AGENTS/constitution and production/beta runbooks with bounded diagnostics, dedicated release credentials, zero-pending follow-up flow and explicit no replay/down behavior.

## Additive DB phase — validation and acceptance

- [x] T096 Record passing focused policy/transaction/rehearsal/writer and release-contract checks, including source tampering, unsupported ledger/hooks, drift, mixed SQL, timeout and commit-loss cases. Evidence: [394 focused assertions plus 69 legacy regressions](reviews/db-verification.json).
- [x] T097 Record real owned PostgreSQL 17+ interoperability and failure-harness evidence: official A equals mini A; next full B succeeds; failed/timeout batches leave no partial DDL/history or row changes; ambiguous commit is reconciled without replay. No production writes. Evidence: [real isolated harness](reviews/db-verification.json).
- [x] T098 Run resource-appropriate canonical static/regression checks and record any unrelated concurrent failures separately. All 13 static gates have successful latest results; the affected scripts type gate was repeated after a JSDoc fix, then canceled remaining gates completed. This is not a fresh single green aggregate receipt. See [evidence](reviews/db-verification.json).
- [ ] T099 On a clean eligible candidate, verify exact resulting real beta schema plus browser/unchanged sealed packaged-agent journey and manual critical feature checks. Missing prerequisites remain blocked; production deployment is a separately authorized action.

T091/T092 → T093 → T094/T095 → T096/T097/T098 → T099. The earlier MVP receipts do not prove this DB extension. DB release diagnostics use bounded private CLI reports and plan/session fingerprints; central analytics coverage and manual critical beta gaps remain explicit.
