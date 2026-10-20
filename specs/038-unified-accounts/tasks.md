# Tasks: Єдина таблиця «Аккаунтів»

**Input**: [spec](spec.md), [plan](plan.md), [research](research.md), [data model](data-model.md), [contracts](contracts/accounts.md), [diagnostics](contracts/diagnostics.md), [quickstart](quickstart.md).

**Tests**: Required by the spec for state/data-integrity/diagnostic behavior. Regression tests precede changed implementations; checkbox completion requires evidence, not merely code. Paths marked new are intentional additions. Migration suffixes receive a fresh timestamp after the actual head; never modify an applied migration.

**Scope**: Only 038. Preserve parallel 037 edits and its active pointer. No tasks below authorize production changes. `[P]` means independent files after stated phase prerequisites, not blanket permission to edit shared files concurrently.

## Phase 1 — Setup

**Goal**: Verify baseline and the library interaction before data/UI integration.

**Independent test / checkpoint**: Record a reproducible fixture, actual mutation inventory and successful hold/scroll prototype.

- [x] T001 Reconcile the handoff inventory with current code and enumerate latest account/run/task/launch/finance read/write RPC overrides, delete/undo/import guards and export consumers in `specs/038-unified-accounts/research.md`; reserve fresh migration filenames after the actual head. (FR-003,FR-017,FR-024)
- [ ] T002 Pin `@dnd-kit/react` and `@dnd-kit/dom` to 0.5.1 in `apps/web/package.json` and `package-lock.json`; prototype 500 ms hold, 5 px tolerance, name-button allowlist, interactive exclusion, keyboard, touch scroll and fold-stable overlay in new `apps/web/src/team/accounts/AccountReorderProvider.tsx`; record evidence before integration. (FR-009,FR-010,FR-012,FR-018)
- [x] T003 [P] Create isolated deterministic fixtures for dates/zones, 50 socials/500 RK, long runs and known sums in new `tests/support/team-unified-accounts.ts`; document isolated team/browser runner in `specs/038-unified-accounts/quickstart.md`. (SC-001,SC-004,SC-006,SC-008,SC-009)

## Phase 2 — Foundation

**Goal**: Establish consistent state, permissions, drafts and observability contracts.

**Independent test / checkpoint**: Boundary parsers, migration isolation, lifted drafts and one invalidation owner are verified before integrated UI.

- [x] T004 Define lifecycle/order/overview/preference parsers and closed outcomes in new `packages/shared/src/team/account-lifecycle.ts`, `account-order.ts`, `account-overview.ts`, existing `accounts.ts`, `agent-finance.ts`, `transport.ts` and shared exports; add parser regressions in `tests/team-accounts-contract.test.ts`. (FR-003,FR-007,FR-013,FR-017,FR-019,FR-020,FR-024)
- [x] T005 Add append-only migrations under `supabase/migrations/` with suffixes `unified_accounts_state.sql` and `unified_accounts_permissions.sql`: ranks/scope revisions, parent membership/lifecycle history, baseline provenance, private preferences, idempotent receipts, finance/membership revision counters and content-free signals; RLS/revoke/narrow grants, server timestamps and one lock protocol as data-model.md. (FR-007,FR-008,FR-013,FR-019,FR-024)
- [x] T006 Verify baseline free-first ranks, creation-vs-backdating, unknown historical parent provenance, role/team isolation, private preference denial and membership-revoked replay in new `supabase/tests/database/team_accounts_state.test.sql`; add upgrade fixtures from pre-038 schema proving value/event/placement counts and sums unchanged, v1 snapshot readability and old write overloads guarded. (FR-008,FR-016,FR-019,FR-024,SC-010)
- [x] T007 Implement reusable dated visibility/provenance projection in `packages/shared/src/team/account-lifecycle.ts` and new tests `tests/team-account-visibility.test.ts`; cover archive boundary, zero/null, parent state, restore gaps, same-day transitions, unknown provenance and backdated values. (FR-020,FR-024,SC-008,SC-010)
- [x] T008 Lift complete dated drafts and controller-owned save registration into new `apps/web/src/team/accounts/finance/useFinanceDrafts.ts`; adapt `DailyFinanceFields.tsx` and `FinanceWorkspace.tsx` to user/team/agent/date/metric/currency keys with pinned timezone/placement/version/request and explicit logout/scope cleanup; test collapse and two-date survival in `tests/team-agent-finance-fields.test.tsx`. (FR-003,FR-011,FR-022,FR-023,SC-003,SC-009)
- [x] T009 Consolidate accounts/finance/labels invalidation into `apps/web/src/team/useTeamRealtime.ts`; adapt `useAccounts.ts`, `finance/useAgentFinance.ts` and `TeamContext.tsx`, remove the old account channel/browser-event bridge, add scoped signals and user-private preference invalidation, generation/write protection, auth-keyed caches and reconnect/foreground follow-up; test in `tests/team-agent-finance-realtime.test.tsx`. (FR-003,FR-007,FR-013,FR-016,SC-002)
- [x] T010 Define diagnostic producer fields/events, operation codes and bounded collection in `packages/shared/src/team/analytics.ts`, `packages/shared/src/types.ts`, `apps/web/src/analytics/events.ts`, `guard-contract.ts`, new `apps/web/src/team/accounts/analytics.ts`, and `scripts/analytics/code-map.ts`; cover all retained action types without financial/2FA/content payload. (AD-001,AD-002,AD-003,AD-005,AD-006,AD-007,AD-008)
- [x] T011 Extend ingestion guard via new `supabase/migrations/` suffix `unified_accounts_analytics.sql`, web service sanitization and `scripts/analytics/sanitize.ts`; add allowlist parity/privacy failures in `tests/analytics-guard-contract.test.ts` and `tests/analytics-code-map.test.ts`; preserve concurrent 037 additions. (AD-004,AD-005,SC-007)

## Phase 3 — US1 Unified table (P1, MVP)

**Goal**: Deliver one editable table with every retained action.

**Independent test / checkpoint**: Complete handoff inventory; multiple runs never duplicate sums, partial sources never look complete.

- [x] T012 [US1] Add failing parity/partial-source scenarios in new `tests/team-unified-accounts.test.tsx` and extend `tests/team-accounts-live-finance.test.tsx` for retained UI actions, multiple runs, absent/zero values, history, source failure, stale period and complete export. (FR-001,FR-002,FR-003,FR-004,FR-005,SC-001)
- [x] T013 [US1] Add overview and additive finance-v2 read RPCs with ranked identity/lifecycle metadata in new `supabase/migrations/` suffix `unified_accounts_reads.sql`; extend `apps/web/src/api/team.ts`, `team-finance.ts` and shared parsers; retain v1 compatibility and separate active picker/history scopes. (FR-002,FR-003,FR-004,FR-005,FR-020)
- [x] T014 [US1] Implement stable-ID manual-run/035-launch summary projection, bounded all-page coverage and explicit unmatched/partial reasons in `packages/shared/src/team/account-overview.ts`, `apps/web/src/api/launches.ts` and `supabase/migrations/` read functions; test in new `tests/team-account-overview.test.ts`. (FR-002,FR-004,AD-001)
- [x] T015 [US1] Compose one table in `apps/web/src/team/accounts/AccountSpace.tsx`, `AccountGroup.tsx` and `AgentRow.tsx`, extract reusable finance cells/controllers from `finance/FinanceWorkspace.tsx`, remove tab branch only after parity; preserve all create/edit/delete/run/tag/marker/2FA/peek/history/legacy dialogs and copy fallback from handoff. (FR-001,FR-002,FR-003,SC-001)
- [x] T016 [US1] Integrate `finance/FinanceToolbar.tsx`, `MonthlyFinanceSummary.tsx` and `apps/web/src/styles/team-accounts.css` with one period/search/filter model, sticky accessible controls and horizontal table scrolling; retain source-scope indicators, report-day navigation and dirty guards. (FR-004,FR-005,FR-006,SC-006)
- [x] T017 [US1] Separate reportRange from editRange in `packages/shared/src/team/agent-finance-report.ts` and all UI consumers; update `supabase/functions/team-finance-export/handler.ts` and `_shared/finance-workbook.ts` for v2 visibility while preserving formats/rehome/permission recheck; regress zero/null/archived sums in `tests/team-agent-finance-report.test.ts` and `tests/team-agent-finance-export.test.ts`. (FR-003,FR-005,FR-020,FR-023,SC-001,SC-008)
- [x] T018 [US1] Instrument overview and retained create/edit/delete/run/label/marker/2FA/finance-clear/undo/history/legacy/export outcomes through `apps/web/src/team/accounts/analytics.ts` and existing callers, including clipboard denial, partial sources and missing applied proof; test typed payloads in new `tests/team-accounts-analytics.test.ts`. (AD-001,AD-003,AD-005,AD-006)
- [ ] T019 [US1] Run each handoff inventory scenario and complete per-action parity evidence in `specs/038-unified-accounts/quickstart.md`; extend existing `tests/team-accounts.test.tsx` and `tests/team-agent-finance-lifecycle.test.tsx` for any adapter regression found. (FR-003,SC-001)

## Phase 4 — US2 RK order (P1)

**Goal**: Persist same-social RK order and prevent automatic re-sorting.

**Independent test / checkpoint**: Filtered drag, busy/free changes, create/transfer and two-client conflicts preserve canonical order.

- [x] T020 [US2] Add reorder membership/permission/replay/conflict regressions in new `supabase/tests/database/team_accounts_order.test.sql` and `tests/team-accounts-order.test.tsx`. (FR-007,FR-008,FR-013,SC-002)
- [x] T021 [US2] Implement anchor-based atomic `reorder_team_accounts`, append-on-create and scope revisions in new `supabase/migrations/` suffix `unified_accounts_order.sql`; update latest move RPC preserving all-history rehome and destination append under consistent locks. (FR-007,FR-008,FR-010,FR-013)
- [x] T022 [US2] Replace natural/free-first resort paths in `packages/shared/src/team/accounts.ts`, `agent-finance-report.ts`, `apps/web/src/team/accounts/useAccounts.ts`, `AccountSpace.tsx`; expose typed reorder methods in `apps/web/src/api/team.ts` with canonical conflict/replay recovery. (FR-007,FR-008,FR-013,SC-002)
- [x] T023 [US2] Integrate library RK dragging in `AccountReorderProvider.tsx` and `AgentRow.tsx`: hold-only, allowed surface/name, filtered full-order anchors, same-parent target, edge scroll, keyboard command, cancel and click suppression, historical rows excluded. (FR-009,FR-010,FR-012,FR-013,FR-018)
- [ ] T024 [US2] Verify all exit paths and mutation races in `tests/team-accounts-order.test.tsx`, with marker/color/financial update not reordering; instrument capture/cancel/noop/request/confirmed/applied/conflict using `apps/web/src/team/accounts/analytics.ts`. (FR-007,FR-009,FR-013,AD-002,AD-003,SC-002,SC-003)

## Phase 5 — US3 Social order (P1)

**Goal**: Move compact social headings and restore exact prior UI state.

**Independent test / checkpoint**: Mixed-open groups restore by ID after drop, cancel, error, scope update and unmount.

- [x] T025 [US3] Add social overlay/collapse/draft/focus regressions in new `tests/team-account-social-order.test.tsx` using the full lifted draft fixture. (FR-011,FR-018,SC-003)
- [x] T026 [US3] Extend `AccountReorderProvider.tsx`, `AccountGroup.tsx` and `AccountSpace.tsx` with social scope dragging, temporary fold snapshot, viewport anchor and non-persisted fold override; reuse US2 server mutation without moving individual RK ownership. (FR-007,FR-011,FR-012,FR-018)
- [ ] T027 [US3] Handle incoming membership/order changes, deleted heading, loss of permission and save failures with canonical reread and unconditional fold/focus restoration in `AccountReorderProvider.tsx`; instrument outcomes in `analytics.ts` and test in `tests/team-account-social-order.test.tsx`. (FR-011,FR-013,AD-002,AD-003,SC-003)

## Phase 6 — US5 Archive and history (P1)

**Goal**: Archive socials or RK without losing dated money or enabling new work.

**Independent test / checkpoint**: Today/no-data/history/restore cases and archive-vs-write races follow temporal rules.

- [x] T028 [US5] Add lifecycle SQL regressions in new `supabase/tests/database/team_accounts_lifecycle.test.sql` for independent parent/child states, same-day/multi-cycle history, restore conflict, replay, permissions and preflight finance/membership token. (FR-017,FR-019,FR-020,FR-022,FR-024,SC-008,SC-010)
- [x] T029 [US5] Implement preflight, atomic archive/restore and bounded archive reader in new `supabase/migrations/` suffix `unified_accounts_archive.sql`; retain financial delete guards, append lifecycle/parent history and receipts/signals, compare transactional per-RK/social finance/membership preflight revisions; replay an authorized successful same-key receipt before new-write archive checks; no child flag rewriting or placement closing. (FR-017,FR-019,FR-021,FR-022,FR-024)
- [x] T030 [US5] Guard active-only create/run/task-assignment/transfer/launch-selection and new launch acceptance in latest SQL entry points using new `supabase/migrations/` suffix `unified_accounts_active_guards.sql`; default old finance write/clear/undo/import signatures to normal and add explicit historical-correction intent; bump content revisions for every set/clear/undo/import/rehome/create/delete/move path exactly once per committed request; accepted generation recovery must continue. (FR-003,FR-017,FR-019,FR-021,FR-024)
- [x] T031 [US5] Test stale clients and concurrent archive vs child creation, move, run/task assignment, finance and launch acceptance in new `tests/team-accounts-archive-concurrency.test.ts` plus `supabase/tests/database/team_accounts_lifecycle.test.sql`; include an already-accepted generation completing after archive, an authorized pre-archive finance receipt replayed after archive, and a new request correctly denied. (FR-013,FR-019,FR-022,FR-024,SC-010)
- [x] T032 [US5] Wire active picker and historical reference separation in `apps/web/src/team/tasks/TaskAccountPicker.tsx`, `TaskAccountFilter.tsx`, `apps/web/src/api/launches.ts` and launch source selectors; existing task tags/launch snapshots remain resolvable; add coverage in `tests/team-task-accounts.test.tsx`. (FR-004,FR-017,FR-021)
- [x] T033 [US5] Implement archive preflight/save-discard-cancel/Undo controller in `apps/web/src/team/accounts/useAccounts.ts` and `finance/useFinanceDrafts.ts`, new `AccountArchiveDrawer.tsx`, menus in `AccountGroup.tsx`/`AgentRow.tsx`; settle affected two-date drafts, freeze local input during final preflight/CAS, pin auth/team/draft generation, release on every exit and show canonical retained/hidden result only after confirmation. (FR-017,FR-019,FR-021,FR-022,SC-003)
- [x] T034 [US5] Add explicit dated correction entry in `finance/FinanceHistoryDrawer.tsx` and `DailyFinanceFields.tsx`, keep correction/read/write permissions and audit, show archive marker without new-work controls; verify history/copy/export visibility in new `tests/team-accounts-archive.test.tsx`. (FR-020,FR-021,FR-024,SC-008)
- [x] T035 [US5] Instrument lifecycle preflight/draft partial/confirmed/visible reasons and correction outcomes in `apps/web/src/team/accounts/analytics.ts`; extend `tests/team-accounts-analytics.test.ts` and `specs/038-unified-accounts/quickstart.md` for Q08–Q13. (AD-002,AD-003,AD-007,SC-008,SC-010)

## Phase 7 — US6 Daily entry (P1)

**Goal (owner correction)**: Enter three fields for the selected day, switch days without moving the working row or flashing, then copy complete confirmed topups.

**Independent test / checkpoint**: Five RK workflow preserves working position at both scroll boundaries across differing dated membership, with no mixed totals or lost drafts.

- [x] T036 [US6] Add failing two-date/midnight/partial-save scenarios in new `tests/team-accounts-daily-workflow.test.tsx`, plus report-range assertion in `tests/team-agent-finance-report.test.ts`. (FR-023,SC-009)
- [x] T037 [US6, superseded by owner correction] Render exactly selected-day balance/topup/spend in `finance/UnifiedFinance.tsx`. Prepare one-day scoped snapshots before an atomic switch, preserve keyed input nodes and viewport anchors, retain sufficient scroll canvas for shorter historical days, and keep date-isolated totals. `useAgentFinance.ts` bounds prepared snapshots and rejects stale team/user/permission generations. (FR-002,FR-005,FR-023)
- [x] T038 [US6] Implement Enter/Shift+Enter within current social, Tab behavior, validation focus retention and last-row boundary in `finance/DailyFinanceFields.tsx` and `useFinanceDrafts.ts`; extend `useFinancePeriod.ts` for explicit dirty-context midnight/zone rollover without new polling. (FR-023,SC-009)
- [x] T039 [US6] Make topup copying settle all relevant pending/dirty topups, reread complete selected-day report and include folded/archived entries with unchanged grouping in `finance/FinanceWorkspace.tsx` and `FinanceTopupStatement.tsx`; preserve clipboard rejection fallback and test `tests/team-agent-finance-statement.test.tsx`. (FR-003,FR-005,FR-020,FR-023,SC-008,SC-009)
- [x] T040 [US6] Instrument per-day save/partial/clipboard outcome through `apps/web/src/team/accounts/analytics.ts`; prove no amounts/text in diagnostics and run Q03/Q04/Q10/Q14/Q17 in `tests/team-accounts-daily-workflow.test.tsx` and `quickstart.md`. (AD-005,AD-006,AD-008,SC-009)

## Phase 8 — US4 Decoration (P2)

**Goal**: Persist private eight-state name decoration without business semantics.

**Independent test / checkpoint**: Eight activations, rapid edits, long press, viewer scope and two-user privacy verified.

- [x] T041 [US4] Add own-user RLS, member/viewer/revoked-member, CAS/replay and rapid-intent regressions in new `tests/team-account-preferences.test.tsx` and `supabase/tests/database/team_account_preferences.test.sql`. (FR-014,FR-015,FR-016,SC-005)
- [x] T042 [US4] Implement preference read/write RPCs in new `supabase/migrations/` suffix `unified_accounts_preferences.sql`, typed wrappers in `apps/web/src/api/team.ts` and new `useAccountPreferences.ts` with auth-scoped cache, serialized desired values and stale response protection. (FR-014,FR-016,SC-005)
- [x] T043 [US4] Add seven named data-palette tokens for both themes in `apps/web/src/styles/tokens.css`; integrate accessible cycle control in `AgentRow.tsx`/`AgentIdentity.tsx`, leave copy separate, coordinate pointer name activation with `AccountReorderProvider.tsx`; update inventory description in `docs/DESIGN.md`. (FR-014,FR-015,FR-016,FR-018)
- [ ] T044 [US4] Prove eight-click cycle, rename/move/restore persistence, no marker/filter/export changes, color contrast and keyboard-vs-hold behavior in `tests/team-account-preferences.test.tsx`; emit coalesced content-free outcomes via `analytics.ts`. (FR-014,FR-015,FR-016,AD-002,AD-005,SC-005)

## Phase 9 — Integration and quality

**Goal**: Close diagnostic and cross-story gaps; verify the complete feature.

**Independent test / checkpoint**: All acceptance cases and repository gates have recorded results; no unsupported critical capability claimed complete.

- [x] T045 Implement findings and capability inventory in `scripts/analytics/queries.ts`, `investigate.ts`, `coverage-registry.ts`, `code-map.ts`; correlate receipt vs visible proof and retain partial/unsupported classifications for old builds and unobservable clipboard delivery. (AD-001,AD-002,AD-003,AD-004,AD-006,AD-007,AD-008,SC-007)
- [x] T046 Prove typed producer→ingestion guard→stored fixture→inspect/investigate/audit results in `tests/analytics-investigate-command.test.ts`, `tests/analytics-guard-contract.test.ts` and new `tests/team-accounts-diagnostics-e2e.test.ts`; cover missing/delayed/out-of-order signals, privacy rejection, replay and fixed --as-of. (AD-001,AD-002,AD-003,AD-004,AD-005,AD-006,AD-007,AD-008,SC-007)
- [x] T047 Add/update Ukrainian and English keys in `apps/web/src/i18n.ts` for archive history reasons, dated headings, conflicts, color/keyboard announcements and partial sources; verify accessible names/focus in `tests/team-i18n-glossary.test.ts` and `tests/team-unified-accounts.test.tsx`. (FR-003,FR-012,FR-015,FR-021,FR-023,SC-006)
- [ ] T048 Extend `scripts/check-accounts-layout.mjs` for unified scroll/focus/variable-height rules and add `scripts/check-accounts-interactions.mjs` for hold/overlay/autoscroll/keyboard/real-browser timing; capture fixture/build/device metadata and perform light/dark/zoom/reduced-motion/touch checks from `quickstart.md`. (FR-006,FR-009,FR-010,FR-011,FR-012,FR-016,FR-018,SC-003,SC-004,SC-006)
- [ ] T049 Run role/cache/membership/reconnect, archive-vs-old-client compatibility and all Q01–Q22 scenarios; record exact pass/fail/blocked evidence plus per-inventory results in `specs/038-unified-accounts/quickstart.md`; fix any newly exposed feature regression before completion. (FR-003,FR-013,FR-020,FR-022,FR-024,SC-001,SC-002,SC-003,SC-005,SC-008,SC-009,SC-010)
- [x] T050 Rebuild shared, run focused single-worker suites, `npm run test:db`, `npm run verify` and `npm run verify:release` serially; inspect `verification-result.json`, record results in `specs/038-unified-accounts/quickstart.md`; no production release or migration push implied. (SC-001,SC-007,SC-008,SC-010)

## Dependencies and execution order

- Setup T001–T003 precedes foundation T004–T011. T002 must prove touch/hold behavior before drag integration; a failed spike blocks the selected interaction implementation rather than weakening UX requirements.
- Foundation order: T004 → T005 → T006/T007; T008 needs T004, T009 needs T005, T010 → T011. All foundation checkpoints precede US1 integration.
- US1 T012–T019 is the MVP. Tests first; read contracts T013/T014 before table composition T015 and shared reports T017. T018 instrumentation follows T010/T011 and changed call sites.
- US2 T020–T024 follows US1; server T021 and readers T022 precede drag T023. US3 T025–T027 follows US2.
- US5 T028–T035 follows unified read/draft foundation and US2 rank contract; SQL T029/T030 before UI T032/T033/T034; concurrency proof T031 is required before completion.
- US6 T036–T040 follows US1; may be developed before US5 UI, but final archive/copy acceptance requires US5 complete. US4 T041–T044 follows US2 name-hold integration and shared preference schema.
- T045–T050 closes the complete feature. Do not mark inventory/diagnostics/performance ready while any critical case is blocked. Shared API, migration, AccountSpace, draft and analytics edits are serialized.

## Parallel examples

- Setup: T003 fixture work can proceed while T002 develops the prototype after T001 baseline.
- US1: T012 UI regressions and read/report fixture design can proceed independently; T015/T016 both touch view composition and are serialized.
- US2: SQL test preparation T020 and interaction fixture design are independent; T021/T022/T023 execute in dependency order.
- US3: fold/focus regression design can proceed while RK verification runs; shared provider changes wait for US2.
- US5: SQL concurrency scenario preparation and archive drawer UI design use separate files; server contracts must land before integration.
- US6: dated navigation tests and statement-copy tests can be prepared separately; both use one draft controller.
- US4: palette contrast review can proceed alongside SQL preference tests; name-control integration waits for the drag provider contract.

## Requirement coverage

| Requirement | Tasks                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| FR-001      | T012, T015                                                                   |
| FR-002      | T012, T013, T014, T015, T037                                                 |
| FR-003      | T001, T004, T008, T009, T012, T013, T015, T017, T019, T030, T039, T047, T049 |
| FR-004      | T012, T013, T014, T016, T032                                                 |
| FR-005      | T012, T013, T016, T017, T037, T039                                           |
| FR-006      | T016, T048                                                                   |
| FR-007      | T004, T005, T009, T020, T021, T022, T024, T026                               |
| FR-008      | T005, T006, T020, T021, T022                                                 |
| FR-009      | T002, T023, T024, T048                                                       |
| FR-010      | T002, T021, T023, T048                                                       |
| FR-011      | T008, T025, T026, T027, T048                                                 |
| FR-012      | T002, T023, T026, T047, T048                                                 |
| FR-013      | T004, T005, T009, T020, T021, T022, T023, T024, T027, T031, T049             |
| FR-014      | T041, T042, T043, T044                                                       |
| FR-015      | T041, T043, T044, T047                                                       |
| FR-016      | T006, T009, T041, T042, T043, T044, T048                                     |
| FR-017      | T001, T004, T028, T029, T030, T032, T033                                     |
| FR-018      | T002, T023, T025, T026, T043, T048                                           |
| FR-019      | T004, T005, T006, T028, T029, T030, T031, T033                               |
| FR-020      | T004, T007, T013, T017, T028, T034, T039, T049                               |
| FR-021      | T029, T030, T032, T033, T034, T047                                           |
| FR-022      | T008, T028, T029, T031, T033, T049                                           |
| FR-023      | T008, T017, T036, T037, T038, T039, T047                                     |
| FR-024      | T001, T004, T005, T006, T007, T028, T029, T030, T031, T034, T049             |
| AD-001      | T010, T014, T018, T045, T046                                                 |
| AD-002      | T010, T024, T027, T035, T044, T045, T046                                     |
| AD-003      | T010, T018, T024, T027, T035, T045, T046                                     |
| AD-004      | T011, T045, T046                                                             |
| AD-005      | T010, T011, T018, T040, T044, T046                                           |
| AD-006      | T010, T018, T040, T045, T046                                                 |
| AD-007      | T010, T035, T045, T046                                                       |
| AD-008      | T010, T040, T045, T046                                                       |
| SC-001      | T003, T012, T015, T017, T019, T049, T050                                     |
| SC-002      | T009, T020, T022, T024, T049                                                 |
| SC-003      | T008, T024, T025, T027, T033, T048, T049                                     |
| SC-004      | T003, T048                                                                   |
| SC-005      | T041, T042, T044, T049                                                       |
| SC-006      | T003, T016, T047, T048                                                       |
| SC-007      | T011, T045, T046, T050                                                       |
| SC-008      | T003, T007, T017, T028, T034, T035, T039, T049, T050                         |
| SC-009      | T003, T008, T036, T038, T039, T040, T049                                     |
| SC-010      | T006, T007, T028, T031, T035, T049, T050                                     |

## Counts / strategy

50 tasks; shared: 17, US1: 8, US2: 5, US3: 3, US5: 8, US6: 5, US4: 4.

Deliver US1 as the first independently usable increment, then manual order, archive, daily workflow and decoration. Each increment retains the inventory and earns its own diagnostics/permission evidence; the full 038 acceptance requires every phase. Production deployment remains a separate authorized runbook.

## Implementation evidence

Implementation uses consolidated files listed in [quickstart](quickstart.md#implementation-evidence-2026-10-18) and [research reconciliation](research.md#implementation-reconciliation--2026-10-18), rather than one migration/test file per planned responsibility. Checked tasks have implementation and targeted regression evidence. Remaining unchecked items include integrated interaction, exhaustive parity/race scenarios, review closure and repository gates; they are not silently considered complete because code exists. Independent scores and corrections are tracked in [reviews/fix-log.md](reviews/fix-log.md).

### Evidence audit of T018 / T031 / T035 / T040 — 2026-10-18

- **T018 checked**: retained Accounts callers use the typed `retained` seam in `useAccounts.ts`; retained finance callers use `useRetainedFinanceDiagnostics.ts` and `UnifiedFinance.tsx`. Actual producer/guard/consumer tests are consolidated in `account-workspace-analytics.test.ts`, `account-overview-analytics.test.tsx`, `team-accounts-unified-finance.test.tsx`, and retained history/legacy/transfer UI tests. See [quickstart evidence](quickstart.md#diagnostic-and-concurrency-evidence-audit). This does not close the separate exhaustive handoff audit T019.
- **T031 checked after the native extension**: `scripts/check-accounts-concurrency.mjs` passes eight scenarios with seven real lock waits observed through `pg_blocking_pids`: same-version reorder, archive versus run/move/task assignment/new launch acceptance/new child/finance, plus authorized finance replay and new-request denial. Task attachment and launch generation/revision absence are asserted after rejection. `tests/team-account-accepted-launch.test.ts` separately passes canonical accepted-generation completion/history/replay after RK archive. Evidence: `scratchpad/038/concurrency.json`, `concurrency.log`, and `accepted-launch-final.log`; only disposable fixtures were created and cleaned. This closes the previously recorded task-assignment and acceptance-race gaps without treating ordered rejection as concurrency proof.
- **T035 checked after the actual-controller extension**: `tests/account-lifecycle-applied.test.tsx`6 passes include actual two-date save-and-archive with one confirmed cell and one conflict: archive/preflight are never submitted, accepted value and failed draft survive, freeze is released, and lifecycle emits partial/count1/exact closed code. `team-accounts-unified-finance.test.tsx`12 includes actual archived historical correction with canonical displayed-version proof. `account-workspace-analytics.test.ts` and inspect/investigate/audit regressions distinguish the parent partial outcome from visible/failed child attempts sharing its flow. See Q08–Q13 and the named evidence in quickstart. Unknown caller/OS visibility remains explicitly unknown.
- **T040 checked for automated diagnostic/workflow proof**: finance12 proves two-date save/partial summaries, stable private attempt identities, canonical displayed versions, scope-safe clipboard outcomes and an empty-subset no-op without changing boolean API behavior. Period5 proves clean/dirty midnight, local23/25-hour DST transitions and dirty timezone pinning; guard/storage/CLI privacy and correlation tests pass. These are unit/component proofs. The combined dirty two-day browser-zone walkthrough is still Q17 PARTIAL and remains required under T049; pointer/performance remains T048. No browser-zone or scale pass is inferred from this checkbox.
- **T019 remains open after the per-row audit**: all17 handoff inventory rows now have explicit PASS/PARTIAL evidence and named tests in quickstart. Accounts47 plus retained-finance15 do not cover every unified UI sub-action: some exhaustive identity/2FA/tag/task/error combinations and live unified export-permission revocation still need recorded parity evidence. Buyer5 supplies successful identity/2FA/tag/leave walkthroughs; period-parity6 plus buyer7/designer9 now close the previously missing matrix/summary/statement, exact report-day return and total-amount copy evidence. No defect is asserted merely because a direct test/manual pass is missing.

## Owner compact-layout correction — current acceptance

The prior two-reviewer97/100 acceptance was rejected by the owner and does not close this correction. Current acceptance requires three fresh independent buyer, designer and interaction reviews, each at least9.9/10, against the same application fingerprint. Reports live in `reviews/compact-*-round-*.md`.

- [x] C001 Compact selected-day three-column table; no repeated field labels or header dates; History/Archive in More menus.
- [x] C002 Preserve the original complete source row for library drag feedback, original dimensions and grab point.
- [x] C003 Prepare scoped day data before committing the UI and retain the working scroll anchor/canvas.
- [x] C004 Close findings through fresh actual Beta reviews by all three independent reviewers. Each earned9.9/10; see `reviews/compact-final.md` for exact capture provenance, scope and final-source applicability.
- [x] C005 Record final-source87/87 affected tests,13/13 static gates, fresh web build and4/4 actual-dist budget tests, plus fresh authenticated Beta screenshot/geometry. Full5939-test compact baseline is separately attributed to its earlier source; historical release results are not substituted. See `reviews/compact-final.md`.

## Owner hover / archive / drag-surface follow-up (2026-10-18)

C001–C005 are the previous compact-layout milestone. The owner subsequently reproduced hover defects; its old scores do not establish acceptance of this follow-up.

- [x] H001 Give SOC title and actions non-overlapping tracks; keep hover/focus dimensions stable on desktop, tablet and phone.
- [x] H002 Bound long run text and reserve edit/delete controls within its column without covering finances; preserve inline editing and full-name access.
- [x] H003 Add10 demo SOCs with10 RK each through guarded normal local-beta RPCs, idempotently preserving existing rows;120 short/long sample launches included. See `reviews/hover-fixture.md`.
- [x] H004 Archived RK has a red status dot, with archived status taking precedence over free/busy.
- [x] H005 Full original SOC/RK drag source and drop surface are opaque; amounts behind the captured item must not show through.
- [x] H006 Record actual hover/focus/responsive/drag checks and final-source validation; no old score is substituted for new evidence.

- [x] H007 Remove identity search highlights and suffix pills; use seven pure brighter rail/fill palettes with right-rounded identity bands.
- [x] H008 Remove visible SOC/RK grips; preserve whole-card hold and accessible More-menu ordering with permission guards.
- [x] H009 Show a pointer-centered ring during the real500ms sensor delay; clear on capture, release, tolerance abort and cancellation.
- [x] H010 Use full-row center collision for symmetric tall-RK sorting independent of grab offset; cover mirrored geometry and pointer independence.

- [x] H011 Keep SOCs transiently folded through actual Feedback drop cleanup; restore original canvas height and keep expanded heading below sticky captions. Verify upward drop and reverse restoration in beta, plus cleanup/removal/unmount regression cases.

- [x] B001 Persist effective creation day separately from audit time with backward-compatible RPC defaults, strict server validation and matching initial placement/parent history.
- [x] B002 Propagate selected day/timezone through UI and typed API; retain consistent local parent birth and refresh finance after creation.
- [x] B003 Align date visibility and copy/export with effective birth; preserve legacy finance and archive/restore semantics.
- [x] B004 Verify shared/API/UI/diagnostic contracts, isolated database lifecycle/security cases and actual beta creation across yesterday/day-before/today. Apply only the new local migration without reset.
