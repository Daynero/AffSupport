# Tasks: R2 workspaces

**Status**: planning only; all implementation tasks intentionally unchecked. Tests explicitly required by spec due migration/security/concurrency risk.
**Input**: spec.md, plan.md, data-model.md, research.md, pricing.md, provider-research.md, architecture-inventory.md and contracts/.
**Format**: sequential task IDs, story labels in story phases, concrete paths. New paths are planned additions; migration filenames allocated canonically during implementation. `[P]` deliberately omitted for mutations of shared schemas/contracts until dependencies settled.

## Phase 1 — Setup and qualification

Establish reproducible safe inputs; no paid infrastructure or production mutation without later explicit activation.

- [ ] T001 Record available live capacity/provider/host constraints and missing inputs first, then finalize qualification after the new census task; create the measured qualification record in `specs/057-r2-workspaces/evidence/qualification.md`; select independent host SKU against quote and metadata export benchmark, disclose country/retention/terms and prices before launch. (FR-023 FR-029 FR-034 SC-010)
- [ ] T002 Define isolated synthetic source fixtures and provider environment allowlist in `tests/fixtures/workspace-storage.ts` and `config/workspace-storage-environments.json`; refuse production endpoints for load/destructive probes. (FR-031 FR-034 SC-007)
- [ ] T003 Extend bounded privacy-safe capacity projections via a new additive migration in `supabase/migrations/` and `scripts/analytics/storage-capacity.ts`; wire `scripts/analytics/cli.ts`, exact bytes/coverage/as-of and execute read-only production census after verification. (FR-007 FR-029 FR-032 FR-033 SC-010)
- [ ] T004 Add provider sandbox contract tests in `tests/workspace-storage-providers.test.ts` for R2 EU/B2 endpoint, full checksums, range/multipart limits, retention/version readback and scoped credentials; document actual supported APIs in feature evidence. (FR-013 FR-023 FR-024 SC-007)

## Phase 2 — Foundational identity, authorization and accounting

Foundation blocks all stories; existing Drive behavior remains compatible until explicitly changed.

- [ ] T005 Define provider-independent storage states, capabilities, decimal bytes, operation validators and closed error unions in `packages/shared/src/team/storage.ts`, `packages/shared/src/team/transport.ts` and `packages/shared/src/types.ts`; map codes in `scripts/analytics/code-map.ts`. (FR-014 FR-032 FR-033)
- [ ] T006 Write failing RLS/canonical-link/epoch tests in `supabase/tests/database/workspace-storage.test.sql` and `tests/workspace-storage-contract.test.ts`, including old Drive NOT NULL compatibility and forbidden fabricated provider IDs. (FR-003 FR-011 FR-013 FR-014 SC-002)
- [ ] T007 Add canonical materials/provider bindings/object versions/replicas/outbox/tombstones via new timestamped additive migrations in `supabase/migrations/`; preserve legacy UUID mappings, parallel canonical domain tables/RPCs for every mandatory-FK descendant (catalog policies/jobs/delivery/baselines/history and attachment links), dual readers and existing constraints; document forward recovery in `ROLLBACK.md`. (FR-003 FR-010 FR-011 FR-023 FR-024)
- [ ] T008 Add organization/immutable plan/grant/seat/space/reservation/logical-and-physical ledger tables with deterministic lock order in `supabase/migrations/` and regenerate existing Supabase types using repository command. (FR-015 FR-016 FR-017 FR-018 FR-020)
- [ ] T009 Implement one current-role/plan/policy/authority gate and provider dispatcher in `supabase/functions/_shared/workspace-storage.ts`; apply to compatibility `supabase/functions/drive-ops/mutation-preflight.ts`, old ticket finalization and claims. (FR-005 FR-013 FR-014 FR-017 SC-001)
- [ ] T010 Implement atomic reserve/commit/release/reconcile primitives and idempotent outbox claims in `supabase/functions/workspace-quotas/`; expiration never frees uncertain provider outcome, security actions bypass spend stops. (FR-008 FR-016 FR-017 FR-030 SC-004)
- [ ] T011 Scaffold bounded independent service and environment validation in `apps/workspace-storage-worker/` with typed lease/cancel/resource seams, isolated secret scopes and readiness; reuse existing job leases where appropriate. (FR-012 FR-023 FR-030 FR-033)
- [ ] T012 Create canonical backfill/adoption dry-run and FK/reference audit in `scripts/workspace-storage-adoption.mjs`; it defaults read-only, inventories every actual task/catalog/launch/account/material relation and reports incomplete/unknown coverage. (FR-003 FR-007 FR-011 SC-002)
- [ ] T013 Create isolated-only load/chaos harness `scripts/workspace-storage-drill.mjs` and fixtures for performance100k objects/50 users,100GB uploads and offered Scale envelope; bound compute, one heavy process and annotate skipped hardware proofs. (FR-011 FR-017 FR-027 FR-029 SC-004 SC-005 SC-006 SC-007)

## Phase 3 — US1: native managed spaces and full parity

Independent acceptance: a clean non-Google owner and invited user complete every R2 parity row; prior stories are not required, foundation and qualified fixture infrastructure are.

- [ ] T014 [US1] Write no-Google provisioning, repeated request, revoked member and private/public isolation regressions in `tests/workspace-storage-create.test.ts` and `tests/workspace-storage-access.test.ts`. (FR-001 FR-011 FR-013 SC-001)
- [ ] T015 [US1] Implement R2 provisioning/create/status/cleanup in `supabase/functions/workspace-storage/`; durable space origin, quota slot, canonical folders and no Drive picker or root connection. (FR-001 FR-003 FR-015)
- [ ] T016 [US1] Write multipart/resume/checksum/unknown-completion/quota regression fixtures in `tests/workspace-storage-upload.test.ts`; include declared100GB bound, folder tree, copy and full-file readback. (FR-008 FR-014 FR-017 SC-004)
- [ ] T017 [US1] Implement admit/part/complete/abort uploads, generation commit, reservation/outbox and bounded staging GC in `supabase/functions/workspace-storage/uploads.ts` and `apps/workspace-storage-worker/src/transfer.ts`. (FR-008 FR-014 FR-016 FR-017 FR-030)
- [ ] T018 [US1] Implement canonical list/search/folders/rename/move/copy/trash/restore/version/share/reference guards in `supabase/functions/workspace-storage/materials.ts`; metadata-only rename and tenant-safe graph cycles. (FR-011 FR-013 FR-016)
- [ ] T019 [US1] Implement the normal authenticated streaming Worker entry in `apps/catalog-image-delivery/src/workspace-read.ts` and independently hosted standby read gateway in `apps/workspace-storage-worker/src/read.ts` with shared typed authorization tests; implement export and `supabase/functions/workspace-storage/export.ts`; bounded15min stream reauth and no reusable raw private read links. (FR-011 FR-013 FR-014 SC-006)
- [ ] T020 [US1] Add typed wrappers and R2 explorer/progress/space controls in `apps/web/src/api/team-storage.ts` and `apps/web/src/team/storage/`; use existing UI tokens/i18n/Realtime reread and accessible error states. (FR-001 FR-011 FR-012 FR-013 SC-001)
- [ ] T021 [US1] Adapt agent transfer/download/source-cache contracts in `apps/agent/src/team-bridge/transfer.ts`, `download.ts` and `source-cache.ts`; keep platform seams and PowerGovernor, reject stale epochs and preserve local outputs. (FR-011 FR-014 SC-006)
- [ ] T022 [US1] Adapt process/restitch/landing/foreground catalog outputs in `apps/agent/src/team-bridge/` and `supabase/functions/drive-ops/process-finalize.ts` to canonical provider dispatch with no Google assumption. (FR-011 FR-014 SC-006)
- [ ] T023 [US1] Adapt task attachments/copy/cleanup, launch/bulk, creative-library, accounts/finance/notebook references in `supabase/functions/drive-ops/` and corresponding `apps/web/src/team/` consumers identified by inventory; prove canonical read/write linkage. (FR-003 FR-011 SC-002 SC-006)
- [ ] T024 [US1] Write hosted preview safety/failure/agent-offline/HEVC fixtures in `tests/workspace-storage-preview.test.ts`; assert MIME/resource/SSRF/zip-slip bounds and unchanged downloadable original. (FR-012 FR-013 FR-030 SC-005)
- [ ] T025 [US1] Implement isolated versioned image/video/PDF/landing recipes, bounded retry and preview delivery in `apps/workspace-storage-worker/src/preview/` and adapt `supabase/functions/_shared/preview-warm.ts`. (FR-012 FR-013 FR-030 SC-005)
- [ ] T026 [US1] Implement Soty-owned feed documents and published asset references in `supabase/functions/workspace-storage/catalog-feed.ts`, adapting `supabase/functions/drive-ops/product-catalog.ts` and existing R2 image/video publication seams without exposing originals. (FR-011 FR-013 FR-016)
- [ ] T027 [US1] Add feed semantic/content-type/external-consumer and immutable asset-link continuity regressions in `tests/workspace-storage-catalog-feed.test.ts`; preserve current schedules, variants, global images and automatic content within quotas. (FR-011 FR-013 FR-017 SC-006)
- [ ] T028 [US1] Complete browser/agent parity matrix record in `specs/057-r2-workspaces/evidence/parity.md` and tests in `tests/workspace-storage-parity.test.ts`; every source inventory row has positive and relevant blocked case. (FR-011 FR-012 FR-014 SC-005 SC-006)

## Phase 4 — US4: commercial plans and pooled quotas

Independent acceptance: seeded organization with several R2 spaces exercises exact bytes/people/slots under100-way concurrency, accepted old credit and term transition.

- [ ] T029 [US4] Write quota/seat/invite/space/credit/term/downgrade/transfer race tests plus Solo $5 and $1/$2 modular add-ons, consolidated vs separate/prorated payment fees, trial-to-Solo seats and cheaper-bundle dominance cases in `tests/workspace-storage-quota.test.ts` and `supabase/tests/database/organization-quotas.test.sql`. (FR-015 FR-016 FR-017 FR-018 FR-020 FR-021 FR-022 SC-004)
- [ ] T030 [US4] Define immutable accessible-v2 catalog (6 bundles, Solo $5/10GB), independent +10GB/$1, person/$2 and space/$1 add-ons, derived object limits without 2x-base restriction, consolidated quotes/term and14day/10GB trial without autocharge, prohibit add-ons beyond qualified envelope in `packages/shared/src/team/organization-tariffs.ts` and new `supabase/migrations/` seeds; require ratified pricing evidence, do not alter old sold grants. (FR-015 FR-019 FR-020 FR-021 FR-022)
- [ ] T031 [US4] Implement explicit organization adoption and old manual-grant credit/acceptance/transfer transactions in `supabase/functions/workspace-quotas/grants.ts`; email unknown value never becomes fabricated paid credit. (FR-015 FR-018 FR-020 FR-022)
- [ ] T032 [US4] Implement unique-person invite reservation/expiry/revoke/accept and atomic space/migration slot counting in `supabase/functions/workspace-quotas/membership.ts` with existing membership guards. (FR-015 FR-017 FR-018 SC-004)
- [ ] T033 [US4] Integrate canonical logical charges with old catalog image/video uses, variants/trash/versions and background output reservations in `supabase/functions/workspace-quotas/ledger.ts`; global pool/internal replica excluded from customer quota. (FR-016 FR-017 FR-029 SC-004)
- [ ] T034 [US4] Implement rolling ingestion/object/physical-history/compute budgets, warning and explicit manual override quotes in `supabase/functions/workspace-quotas/budgets.ts`; safe read/export/security controls never subject to destructive spend cap. (FR-017 FR-019 FR-029 FR-030)
- [ ] T035 [US4] Implement paid expiry/grace90day retention and separate trial30day retention/read-only/notice/purge/ref-count/retention-safe restoration in `supabase/functions/workspace-quotas/lifecycle.ts`; renewed jobs revalidate sources and coalesce missed schedules. (FR-021 FR-022 FR-024)
- [ ] T036 [US4] Build plan/usage/price/add-on/admin grant/credit and downgrade UI in `apps/web/src/team/storage/OrganizationPlan.tsx` and existing admin tariff surfaces; accessible storage/people/spaces remaining and pending bytes; show $5/$9/$15 entry choices, modular calculator and optional cheaper bundle covering every chosen resource, without silent upgrades. (FR-015 FR-016 FR-018 FR-019 FR-020 FR-021 FR-022)
- [ ] T037 [US4] Validate preliminary measured invoice/usage/request/churn/preview-cost model including normal Worker CPU/DB requests, independent host network quote, metadata snapshot/chunk/journal bytes and CPU; final commercial acceptance depends on completed recovery/load qualification and monthly/annual/low-account/stress scenarios with reproducible report in `specs/057-r2-workspaces/evidence/commercial-qualification.json`; gate proposed plan/add-on margins, Solo support/fee sensitivity, per-cohort CAC/payback/retention, equal-resource 6x$5 versus 1x$30 comparison and incident cash reserve; distinguish the new efficiency target from measured costs. (FR-019 FR-029 FR-030 FR-034 SC-008 SC-010)

## Phase 5 — US5: independent protection and recovery

Independent acceptance: synthetic committed workspace+metadata undergoes object-only/cloud-wide/DB/credential/delete faults with proved security and watermark. US2 real cutover depends on this phase.

- [ ] T038 [US5] Write replication exact-generation/hash/unknown-result/lock-renewal/delete-denial tests in `tests/workspace-storage-replication.test.ts` with isolated B2 fixtures. (FR-023 FR-024 FR-025 SC-007)
- [ ] T039 [US5] Implement outbox replica copy/readback/reconcile/retention extension and independent credentials in `apps/workspace-storage-worker/src/replication/`; stamp protected only with joint metadata proof. (FR-023 FR-024 FR-025 FR-030)
- [ ] T040 [US5] Implement bounded encrypted portable snapshot/journal/checkpoint closure in `apps/workspace-storage-worker/src/metadata/`; supported auth/schema export in one consistent snapshot, protected receipt-membership instead of max sequence, encrypted deduplicated chunks and manifest retention, ≤5min schedule/≤5min completion, separate operational backup role; test rollback/inverted commit order/multirow/auth mutation, builder-pin/GC fencing/manifest response loss/key retention, and refuse unproved replay. (FR-023 FR-024 FR-025 FR-033 SC-007)
- [ ] T041 [US5] Implement protection watermark/lag admission and degraded states in `supabase/functions/workspace-storage/protection.ts` and web storage state; unchanged old backups retain rolling30d protection. (FR-024 FR-025 FR-030)
- [ ] T042 [US5] Implement authorized exact-generation B2 fallback and primary circuit breaker in normal `apps/catalog-image-delivery/src/workspace-read.ts` and standby `apps/workspace-storage-worker/src/read.ts`; no fallback for tombstone/403/true404, missing replica explicit. (FR-013 FR-025 FR-026 FR-027)
- [ ] T043 [US5] Prepare independent recovery host/frontend/read API/DNS/TLS/config/secret/auth redirects deployment definition under `apps/workspace-storage-worker/` and documented fixture evidence; explicit procurement/deploy approval required later. (FR-023 FR-026 FR-027 FR-033 FR-034)
- [ ] T044 [US5] Implement fenced read-only incident/restore/auth-session-revocation/deny-journal validation/failback workflow in `apps/workspace-storage-worker/src/recovery/` and `scripts/workspace-storage-recovery.mjs`; default inspect/read-only, never automatic writer promotion. (FR-024 FR-026 FR-027 FR-028)
- [ ] T045 [US5] Write recovery security/revocation/stale-public-feed/no-split-brain/full-ref-restore tests in `tests/workspace-storage-recovery.test.ts`; test lost keys, unavailable auth and independent telemetry outage. (FR-013 FR-023 FR-024 FR-026 FR-028 SC-007)
- [ ] T046 [US5] Run measured1TB/100k and offered Scale aggregate recovery/load fixtures, incident transfer/cash model and return-to-primary validation; save manifests and RPO/RTO in `specs/057-r2-workspaces/evidence/recovery-qualification.json`. (FR-025 FR-026 FR-027 FR-028 FR-029 SC-005 SC-007 SC-010)

## Phase 6 — US2: migrate existing space safely

Independent fixture: existing Drive graph migrates preserving IDs/ACL/bytes; core R2 works with Drive revoked, while Google feed bridges have explicit retained/retired acceptance fixtures. Depends on US1 canonical paths and US5 protection before real cutover.

- [ ] T047 [US2] Write migration state/manifest/reference/permission/exclusion regressions in `tests/workspace-migration.test.ts` and `supabase/tests/database/workspace-migration.test.sql` before enabling mutators. (FR-003 FR-007 FR-008 FR-009 FR-010 SC-002)
- [ ] T048 [US2] Add migration/manifest/checkpoint/reserved-slot schemas via `supabase/migrations/` with one successful cutover per source, fresh-target rejection and owner-consented native/export exceptions. (FR-003 FR-007 FR-008)
- [ ] T049 [US2] Implement complete paginated Drive+canonical reference inventory and delta tokens in `apps/workspace-storage-worker/src/migration/inventory.ts`; shortcuts/native export, unknown bytes, changed root/permissions and catalog external links explicit. (FR-007 FR-009 FR-011 SC-002)
- [ ] T050 [US2] Implement bounded resumable source-revision copy/hash/readback/retry/pause/cancel in `apps/workspace-storage-worker/src/migration/copy.ts`; never delete originals or duplicate quota on replay. (FR-008 FR-009 FR-030 SC-002)
- [ ] T051 [US2] Implement freeze/drain/epoch fence/final delta/atomic cutover with post-cutover snapshot containing exact receipt before completion/unfencing, and reconciliation in `supabase/functions/workspace-migrate/`; late old-agent finalize denied and after-commit repair forward only. (FR-009 FR-010 FR-014 SC-002)
- [ ] T052 [US2] Implement migration cost/capacity/ETA/progress/exception/choice UI and wrappers in `apps/web/src/team/storage/MigrationFlow.tsx` and `apps/web/src/api/team-storage.ts`; fresh never becomes merge target. (FR-002 FR-003 FR-007 FR-008)
- [ ] T053 [US2] Implement legacy Google feed bridge and external replacement confirmation in `supabase/functions/workspace-migrate/catalog-links.ts` plus `apps/web/src/team/storage/`; mark remaining Google dependency and retain only scoped required tokens. (FR-006 FR-009 FR-011 FR-014)
- [ ] T054 [US2] Add crash-after-upload/after-commit, concurrent Drive mutation, backup lag, quota/grant change, protocol downgrade and cancel-before/after-cutover faults in `tests/workspace-migration-faults.test.ts`; attach safe CLI expected receipts. (FR-008 FR-009 FR-010 FR-014 SC-002)
- [ ] T055 [US2] Implement migration admission pacing, budget/backpressure and quota-aware staging reclamation in `apps/workspace-storage-worker/src/migration/admission.ts`; dry-run exact resource/ETA evidence in feature evidence. (FR-007 FR-017 FR-029 FR-030)

## Phase 7 — US3: choice gate and Drive maintenance

Independent acceptance: seeded legacy fixture at T0/T1±1ms through web, old agent and direct API; no need to migrate to test allowed maintenance.

- [ ] T056 [US3] Write transition clock, incomplete inventory, external new/revised source including same-size change during byte read, old-agent and fresh-choice tests in `tests/workspace-legacy-policy.test.ts` and `supabase/tests/database/workspace-legacy-policy.test.sql`. (FR-001 FR-002 FR-004 FR-005 FR-006 SC-003)
- [ ] T057 [US3] Add durable T0/T1 policy and precomputed legacy eligible-version/recipe inventories in `supabase/migrations/`; snapshot-incomplete blocks refresh rather than admitting future versions. (FR-004 FR-005 FR-006 SC-003)
- [ ] T058 [US3] Enforce revision-pinned or fully verified quarantined legacy byte reads plus maintenance allowlist on every existing mutation/claim/reauth and cutoff finalize in `supabase/functions/_shared/workspace-storage.ts`, `supabase/functions/drive-ops/` and `supabase/functions/catalog-sync/`. (FR-001 FR-005 FR-006 FR-014 SC-003)
- [ ] T059 [US3] Restrict existing catalog schedule/recipe refresh to frozen eligible sources and bounded technical outputs in `supabase/functions/drive-ops/product-catalog.ts` and catalog workers; preserve stop/revoke/export. (FR-005 FR-006 FR-017 FR-030 SC-003)
- [ ] T060 [US3] Add owner decision gate, irreversible fresh explanation, exact deadline/read-only labels and member access states in `apps/web/src/team/storage/LegacyTransition.tsx` with compiled uk/en i18n. (FR-002 FR-003 FR-004 FR-005 FR-006)
- [ ] T061 [US3] Add idempotent deadline notification intents via existing server notification seam in `supabase/functions/` and safe email/banner fixtures in `tests/workspace-legacy-notices.test.ts`; no actual sends without configured release workflow. (FR-004 FR-005 FR-006 FR-031)

## Phase 8 — US6: agent-readable diagnosis

Independent acceptance: fixture producers/authoritative receipts with missing, duplicate and delayed events are explained by the existing CLI without production writes.

- [ ] T062 [US6] Define typed analytics stage/property/privacy bounds in `packages/shared/src/types.ts`, server ingestion allowlist and `scripts/analytics/coverage-registry.ts` for every diagnostics contract journey. (FR-032 FR-033 SC-009)
- [ ] T063 [US6] Add privacy-limited authoritative migration/quota/protection/preview/incident projection migrations in `supabase/migrations/`; join operation/attempt/generation and declare unknown coverage/watermarks. (FR-032 FR-033 SC-009)
- [ ] T064 [US6] Wire bounded stage/terminal/visible-result signals and diagnostic receipts in hosted storage worker/functions, `apps/agent/src/team-bridge/` and `apps/web/src/team/storage/`; analytics outages must not block product. (FR-032 FR-033 SC-009)
- [ ] T065 [US6] Extend `scripts/analytics/investigate.ts`, `workspace.ts`, `code-map.ts`, `coverage-registry.ts`, `cli.ts` and capacity command to explain facts/hypotheses/blind spots and exact estimated-vs-actual costs. (FR-029 FR-032 FR-033 SC-009)
- [ ] T066 [US6] Add end-to-end collector/projection/CLI privacy and missing-evidence regressions in `tests/workspace-storage-analytics.test.ts` and existing analytics code-map tests; include every critical negative journey and unsupported cohort. (FR-032 FR-033 SC-009)

## Phase 9 — Cross-cutting acceptance and controlled release

No public activation until all story and release gates pass; implementation request and production authorization remain separate.

- [ ] T067 Run additive migration chain/RLS/provider and touched single-worker tests, formatting/lint/build checks via `npm run verify` and `npm run verify:release`; preserve verification results in feature qualification evidence and resolve failures. (FR-031 SC-001 SC-002 SC-003 SC-004 SC-005 SC-006 SC-007 SC-009)
- [ ] T068 Update full release capability/protocol/environment/canonical runbook in `packages/shared/src/release.ts`, `docs/PRODUCTION.md`, `docs/RELEASE-CHANNEL.md` and `docs/ANALYTICS_CLI.md`; no version bump/tag/production side effect without release intent. (FR-010 FR-014 FR-031 FR-032)
- [ ] T069 Execute exact-SHA packaged beta and required Mac ARM/Intel/Windows qualification using canonical runner, validate previous-version compatibility and rollback fencing; write evidence under `specs/057-r2-workspaces/evidence/`. (FR-010 FR-014 FR-031 SC-006 SC-010)
- [ ] T070 Prepare operator/user runbook `docs/WORKSPACE-STORAGE.md` for migration, fresh choice, maintenance, quota/retention, catalog link replacement, restore and costs; collect G0–G5 evidence with zero unresolved critical/high findings. (FR-002 FR-004 FR-005 FR-019 FR-021 FR-026 FR-034 SC-010)
- [ ] T071 After separate explicit production release intent only, follow canonical next/canary/promote workflow and record T0/policy plus before/after channel state in `specs/057-r2-workspaces/evidence/release-acceptance.md`; verify each canary and stop criteria, never reset cutoff on rollback. (FR-004 FR-010 FR-031 FR-034 SC-010)
- [ ] T072 After authorized release, run read-only `investigate`, `audit`, `storage-capacity` at pinned post-release instants, measure maintenance deadline and actual costs/replica lag; record cohort denominators and schedule quarterly restore qualification in `docs/WORKSPACE-STORAGE.md`. (FR-004 FR-005 FR-025 FR-028 FR-029 FR-032 SC-003 SC-008 SC-009 SC-010)

## Dependencies and execution strategy

T001 initial inventory → T002–T004 → T001 qualification completion; T005–T013 foundation → US1 → US4 → US5 → US2 → US3, then US6 final diagnosis and acceptance. US4 model follows foundation and can be exercised on fixtures. US5 protection follows committed-version schema and blocks real US2 cutover. US2 also needs US1 parity + US4 capacity; US3 policy can be tested on legacy fixtures independently, but public T0 requires all six stories. US6 instrumentation is developed with each story, not postponed until launch; its phase assembles cross-layer diagnosis. Cross-cutting acceptance follows all stories, including final commercial evidence after recovery/load measurements. Story tests may use protocol fixtures before integration; real cutover stays blocked until US5. No later-phase executable is required before its task creates it.

**Safe parallel examples after shared prerequisites**: US1 preview fixture and feed fixture files; US2 inventory reader and UI copy prototype against frozen contract; US3 cutoff tests and notification templates; US4 pricing math and UI after ledger API frozen; US5 isolated B2 contract test and recovery-host configuration readback; US6 code-map tests and privacy fixtures. Do not run concurrent edits of shared type/migration/CLI files or heavy local test/build jobs. These are scheduling opportunities, not permission to skip dependencies.

**MVP**: isolated US1 + atomic quotas + verified independent protection and diagnostics. This can demonstrate the new experience; it is not eligible for public T0 until migration/maintenance/catalog-link and full release gates pass. Active-active writes and payment processor are intentionally outside scope.

**Task-level refinement**: a task with many existing call sites requires an enumerated checklist in its evidence before changing code; inventory parity rows are not silently dropped to finish a phase. Unknown provider outcome uses read-only reconcile before retry.

**Total**: 72 tasks. No task is marked implemented by this planning work.

## Requirement coverage

| Requirement | Tasks                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| FR-001      | T014, T015, T020, T056, T058                                                                   |
| FR-002      | T052, T056, T060, T070                                                                         |
| FR-003      | T006, T007, T012, T015, T023, T047, T048, T052, T060                                           |
| FR-004      | T056, T057, T060, T061, T070, T071, T072                                                       |
| FR-005      | T009, T056, T057, T058, T059, T060, T061, T070, T072                                           |
| FR-006      | T053, T056, T057, T058, T059, T060, T061                                                       |
| FR-007      | T003, T012, T047, T048, T049, T052, T055                                                       |
| FR-008      | T010, T016, T017, T047, T048, T050, T052, T054                                                 |
| FR-009      | T047, T049, T050, T051, T053, T054                                                             |
| FR-010      | T007, T047, T051, T054, T068, T069, T071                                                       |
| FR-011      | T006, T007, T012, T013, T014, T018, T019, T020, T021, T022, T023, T026, T027, T028, T049, T053 |
| FR-012      | T011, T020, T024, T025, T028                                                                   |
| FR-013      | T004, T006, T009, T014, T018, T019, T020, T024, T025, T026, T027, T042, T045                   |
| FR-014      | T005, T006, T009, T016, T017, T019, T021, T022, T028, T051, T053, T054, T058, T068, T069       |
| FR-015      | T008, T015, T029, T030, T031, T032, T036                                                       |
| FR-016      | T008, T010, T017, T018, T026, T029, T033, T036                                                 |
| FR-017      | T008, T009, T010, T013, T016, T017, T027, T029, T032, T033, T034, T055, T059                   |
| FR-018      | T008, T029, T031, T032, T036                                                                   |
| FR-019      | T030, T034, T036, T037, T070                                                                   |
| FR-020      | T008, T029, T030, T031, T036                                                                   |
| FR-021      | T029, T030, T035, T036, T070                                                                   |
| FR-022      | T029, T030, T031, T035, T036                                                                   |
| FR-023      | T001, T004, T007, T011, T038, T039, T040, T043, T045                                           |
| FR-024      | T004, T007, T035, T038, T039, T040, T041, T044, T045                                           |
| FR-025      | T038, T039, T040, T041, T042, T046, T072                                                       |
| FR-026      | T042, T043, T044, T045, T046, T070                                                             |
| FR-027      | T013, T042, T043, T044, T046                                                                   |
| FR-028      | T044, T045, T046, T072                                                                         |
| FR-029      | T001, T003, T013, T033, T034, T037, T046, T055, T065, T072                                     |
| FR-030      | T010, T011, T017, T024, T025, T034, T037, T039, T041, T050, T055, T059                         |
| FR-031      | T002, T061, T067, T068, T069, T071                                                             |
| FR-032      | T003, T005, T062, T063, T064, T065, T066, T068, T072                                           |
| FR-033      | T003, T005, T011, T040, T043, T062, T063, T064, T065, T066                                     |
| FR-034      | T001, T002, T037, T043, T070, T071                                                             |
| SC-001      | T009, T014, T020, T067                                                                         |
| SC-002      | T006, T012, T023, T047, T049, T050, T051, T054, T067                                           |
| SC-003      | T056, T057, T058, T059, T067, T072                                                             |
| SC-004      | T010, T013, T016, T029, T032, T033, T067                                                       |
| SC-005      | T013, T024, T025, T028, T046, T067                                                             |
| SC-006      | T013, T019, T021, T022, T023, T027, T028, T067, T069                                           |
| SC-007      | T002, T004, T013, T038, T040, T045, T046, T067                                                 |
| SC-008      | T037, T072                                                                                     |
| SC-009      | T062, T063, T064, T065, T066, T067, T072                                                       |
| SC-010      | T001, T003, T037, T046, T069, T070, T071, T072                                                 |
