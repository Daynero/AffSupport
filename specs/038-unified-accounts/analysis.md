# Specification analysis and remediation report

**Feature**: 038 unified accounts  
**Reviewed / remediated**: 2026-10-18  
**Scope**: spec, plan, tasks, research, model, contracts, quickstart and handoff. Source evidence inspected against `4c392f63` and current workspace. This records document review, not completed implementation/testing.

The initial analysis was read-only. Follow-up edits were explicitly authorized by the user's “потім виправи все” and “ще раз проаналізуй і фіусани одразу”. No constitution changes or production operations were made.

## Findings and resolution

| ID | Category | Severity | Location | Finding | Applied remediation / coverage | Final state |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Inconsistency | HIGH | spec US5 / temporal rules vs research R2 | Workspace timezone was assumed, but current finance uses browser/view context | Spec now explicitly preserves view timezone, server timestamp projection and pinned drafts; T007/T037, Q17 | Closed |
| I2 | Inconsistency | HIGH | spec FR-008/024, handoff vs latest transfer migration | “Preserve historical placement” could reverse current all-history financial rehome | Preserve rehome, separate lifecycle parent-membership history and launch snapshots; T017/T021/T031, Q13 | Closed |
| U1 | Underspecification | MEDIUM | spec temporal rules vs data-model Temporal semantics | Same-day archive/restore/rearchive was not explicit | Timestamp ordering and final effective daily state; independent child archive remains; T007/T028, Q09/Q12 | Closed |
| U2 | Underspecification | HIGH | spec historical-presence rule vs existing backdating | Year-0001 placement could fabricate activity or hide valid pre-creation money | Creation and explicit values handled separately; unknown baseline provenance explicit; T006/T007, Q12/Q20 | Closed |
| U3 | Underspecification | HIGH | contracts archive preflight / model revisions | Finance revision token had no concrete authoritative producer | Per-RK/social content counters, every set/clear/undo/import/rehome/membership mutation increments atomically; T005/T029/T030, Q10/Q11/Q20 | Closed |
| C1 | Coverage | HIGH | tasks migration and diagnostics gates | General verification did not explicitly prove old-client upgrade/data preservation | Upgrade fixtures with counts/sums/events/placements, v1 read and old write overload guards; full typed-to-CLI fixture chain; T006/T030/T046/T049, Q19/Q20 | Closed |
| U4 | Concurrency | HIGH | archive UI orchestration between save and CAS | New local input could appear after draft-set validation | Freeze affected fields, pin draft generation/auth/team, cancel changed context and release freeze on all exits; T033/T049, Q21 | Closed |
| I3 | Recovery | HIGH | mutation replay vs archive write guard | A successful pre-archive write with lost response could be rejected on retry | Authorize first, replay original successful key/payload before new-write archive guard; new requests still denied; T029/T031, Q22 | Closed |
| P1 | Paths | MEDIUM | plan source tree / T004 / T047 | Proposed existing `team/errors.ts` and `i18n/` paths do not exist | Corrected to `packages/shared/src/team/transport.ts` and `apps/web/src/i18n.ts` | Closed |

## Recheck results

- No unresolved CRITICAL/HIGH/MEDIUM/LOW findings remain in the reviewed documents.
- 24 functional requirements, 8 diagnostic requirements and 10 success criteria: **42/42 mapped to tasks**. Full requirement→task table is in [tasks.md](tasks.md#requirement-coverage).
- 50 tasks with sequential IDs, checkbox format, story labels for every story phase and concrete existing/new file paths. 17 shared tasks, US1 8, US2 5, US3 3, US5 8, US6 5, US4 4.
- 22 acceptance scenarios Q01–Q22 plus explicit real-browser performance/accessibility methodology; all covered by integration tasks and relevant story tasks.
- No unmapped task, missing mandatory artifact, unresolved template marker, duplicated requirement ID or broken local Markdown target found.
- Constitution alignment: no waiver, new data uses RLS/narrow grants/typed parsers; one Realtime owner; no polling; no financial/secret analytics payload; code-map and ingestion parity gates included.
- Parallel editing boundaries stated: new shared source edits serialize; 037 tasks are not reintroduced and active feature pointer remains 037.

## Coverage summary

| Requirement group | Has tasks? | Main tasks | Scope checked |
| --- | --- | --- | --- |
| FR-001–006 | Yes | T012–T019, T036–T040, T048 | Unified UI, retained actions, correct period and layout |
| FR-007–013 | Yes | T004–T009, T020–T027, T031 | Durable full-membership order, gestures, atomicity, conflicts |
| FR-014–016 | Yes | T041–T044, T047–T048 | Private decoration, cycle, isolation, contrast, gestures |
| FR-017–024 | Yes | T005–T008, T028–T040 | Lifecycle, dated visibility, staged saves, correction, daily workflow |
| AD-001–008 | Yes | T010–T011, T018/T024/T027/T035/T040/T044, T045–T046 | Producers, ingestion, bounded privacy, receipts/visible proof, CLI |
| SC-001–010 | Yes | story regressions and T045–T050 | Parity, stability, perf/accessibility, diagnostic and money integrity |

## Remaining implementation gates (not document defects)

The dnd-kit prototype must prove whole-row hold/touch behavior before integration. Migration upgrade, concurrency, browser smoothness, financial parity and diagnostics tests have not been run because this task creates planning documents. All are explicit implementation tasks; a blocked runtime prerequisite cannot be marked passing. Exact version pins were checked against npm metadata; no package installation occurred.

Personal color remains the explicit default from spec, with shared order. No unanswered question blocks implementation under that default. A later owner change to preference scope would require a small spec/model amendment.

## Next action

The documents are ready for `speckit-implement` on 038 when requested. Preserve parallel 037's pointer: the current stock setup scripts persist an explicit feature override. During this planning run their temporary copies used the existing no-persist resolution behavior, leaving repository scripts untouched. For a later independent implementation session choose its feature context deliberately instead of switching the parallel session's pointer accidentally.
