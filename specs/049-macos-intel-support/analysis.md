# Specification Analysis Report: Intel Mac support

> Current owner policy (2026-11-07): [intel-user-feedback-v1](release-policy.md). Physical/native Intel tests are post-release user feedback, not a publication prerequisite. Earlier hardware-blocking checkpoints below are historical; no unexecuted case is marked passed. ARM native beta, Windows hosted, static Intel seals/signatures and applicable Apple trust remain required.

Date: 2026-11-05. Scope: spec/plan/tasks plus supporting contracts/research, constitution 3.1.0 and repository evidence. No production data queried.

## Findings and remediation

The analysis pass was read-only. The subsequent remediation pass was explicitly authorised by the owner's request “аналіз фікси”; a repeat analysis checked the resulting artifacts. This saved report records both passes, not an automatic edit inside the read-only skill.

| ID  | Category           | Severity | Original location                               | Finding                                                                                                               | Remediation / final status                                                                                                                                                                                                        |
| --- | ------------------ | -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Inconsistency      | HIGH     | spec FR-009; plan Phase 1.5; initial T019       | Three macOS-style beta proofs were implied, but beta runtime launches a macOS `.app`; Windows has its hosted pipeline | Fixed FR-009, platform/data contracts, research R7 and quickstart; added T020 for source/installer-bound existing Windows proof. Separate ARM/Intel exact-source beta plus Windows hosted proof; no Windows beta product          |
| A2  | Coverage gap       | HIGH     | spec diagnostics preboot fallback; initial T024 | Server/web producers cannot record Node/launcher failure before server starts                                         | Added T025 Launcher/local-bundle evidence plus native fault cases and privacy limits; no boot still means insufficient                                                                                                            |
| A3  | Underspecification | MEDIUM   | initial T001/T025; plan diagnostics             | Ingestion path was not resolved and incorrectly pointed toward Edge Functions                                         | Resolved service RPC and SQL guard in research R8; T001 inventories exact chain; T027 names client guards, database RPC, forward migration and real DB regression. New safe keys require SQL guard extension even without columns |

No open findings remain from these passes. Hardware/input/trust availability is an explicit implementation prerequisite, not a completed check or a hidden scope decision.

## Coverage Summary Table

Every FR has implementation/verification work. This is task coverage, not proof that runtime behavior exists.

| Requirement Key | Has Task? | Task IDs                                                   |
| --------------- | --------- | ---------------------------------------------------------- |
| FR-001          | Yes       | T003, T004, T007                                           |
| FR-002          | Yes       | T001, T006, T008, T009                                     |
| FR-003          | Yes       | T010, T011, T012                                           |
| FR-004          | Yes       | T007, T010, T011, T012                                     |
| FR-005          | Yes       | T013, T014, T015                                           |
| FR-006          | Yes       | T013, T014, T015                                           |
| FR-007          | Yes       | T002, T013, T014, T016                                     |
| FR-008          | Yes       | T005, T006, T007, T009, T019, T032                         |
| FR-009          | Yes       | T003, T004, T018, T019, T020, T021, T022, T032             |
| FR-010          | Yes       | T001, T012, T018, T019, T031                               |
| FR-011          | Yes       | T002, T016, T031                                           |
| FR-012          | Yes       | T003, T015, T018, T020, T021, T022, T023, T031, T032, T033 |
| FR-013          | Yes       | T024, T025, T026, T027, T028, T030, T032, T033             |

| Success criterion | Buildable work / acceptance                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| SC-001            | T006–T012, T019, T031: target-consistent payload and physical minimum/newer-OS tests |
| SC-002            | T013–T017: explicit verified selection and unknown/mismatch matrix                   |
| SC-003            | T018–T023, T029, T031: negative/positive proof, historical channel and final bytes   |
| SC-004            | T024–T028, T030: real producer/guard/storage/query path and missing evidence         |
| SC-005            | T010–T017, T020–T023, T029, T031–T033: ARM/Windows/data/power/release controls       |

## Constitution alignment

No requested exceptions or conflicts. Typed validated target mapping, shared release origin, historical trusted channel, exact-source beta evidence, Windows gates, process/power seam, real beta auth/entitlement, UI inventory/tokens and read-only privacy-safe diagnosis are retained. No protocol/version bump, deployment, secret movement or migration execution occurs during document preparation.

Feature 048 owns Apple trust/native updater. Its architecture exclusion is scoped to its own MVP; 049 is a separate increment. Public Intel readiness waits for applicable 048 trust checks; manual installer choice does not falsely claim automatic update support. Mini remains unable to ship these agent/shared changes.

## Unmapped tasks

None. T001/T002 resolve required inventory/prerequisites; T003–T005 establish canonical boundaries; story tasks map to FR above; T031–T033 complete cross-platform acceptance, documentation and required checks. At that design checkpoint no task was marked implemented.

## Metrics after remediation

- Functional requirements: 13; measurable success criteria: 5; user stories: 3.
- Tasks: 33 open — setup 2, foundation 3, US1 7, US2 5, US3 13, final integration 3.
- Requirement task coverage: 13/13 (100%); success criteria coverage: 5/5.
- Open critical/high/medium findings: 0/0/0; unresolved ambiguity: 0; duplicate requirements: 0.
- Original findings: 2 high, 1 medium; all remediated and rechecked.

## Validation and next actions

Spec Kit prerequisites resolve this directory and all required design artifacts. Task IDs are unique/sequential T001–T033; story phases have matching labels and paths; requirement references are complete; placeholders absent. T010 and T018/T024 provide disjoint test-authoring opportunities, while heavy commands remain sequential. No agents are needed for task execution unless separately authorised by applicable workflow.

Document formatting and structural checks apply to this change. Runtime tests/full verify are implementation tasks, not evidence obtained by writing a plan. Next: execute tasks starting at T001, retain explicit blocked outcomes for missing Intel hardware/portable inputs/048 trust, and run the quickstart plus full release verification before claiming Intel support. No production action is authorised by these artifacts.

## Implementation status review — 2026-11-07

The earlier report evaluated documentation design. On 2026-11-07 the isolated source implementation includes actual Intel runtime inputs and an installable development DMG, authoritative target selection, required three-platform candidates, per-target source/config/build/agent/web seals, Windows source/run/installer evidence, complete mini baselines and bounded pre-server diagnosis. Historical manifests retain their original authenticated platform set.

Compiled native fault fixtures and local CLI diagnosis pass; producer→guard→storage→CLI cohort and privacy fixtures pass. Final canonical verification results are tracked in acceptance-matrix.md. Physical Intel macOS 13.0/newer acceptance, public Apple trust and packaged cross-platform controls remain explicit external blockers. The documentation checklist is not a hardware or trust attestation.

## Final implementation consistency review — 2026-11-07

Read-only rechecking maps all 13 functional requirements and 5 success criteria to the source plan and, at that checkpoint, 33 unique sequential task IDs. There are no unmapped requirements or tasks. Subsequent authorised implementation remediated the findings below; this report distinguishes the analysis from those edits.

| Finding                                                                                                              | Severity                | Evidence / disposition                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delayed health could attribute readiness to a new startup attempt                                                    | Medium, resolved        | Production-method Swift fixture first failed `STALE_STARTUP_RESPONSE_ACCEPTED`; captured attempt, health UUID and live-child checks now pass                                                                       |
| Unproven correlation bypassed the existing readiness timeout                                                         | Medium, resolved        | Native fixture first failed `UNPROVEN_STARTUP_TIMEOUT_IGNORED`; readiness predicate now retains the existing bounded timeout path                                                                                  |
| A known package target could switch architecture when runtime architecture was absent                                | Medium, resolved        | Resolver regression first returned an ARM link for recorded Intel metadata; known package binding now refuses the switch and permits the matching Intel artifact                                                   |
| New fixtures used direct recursive cleanup; older UI/analytics assertions described implicit ARM and absent identity | Medium, resolved        | Shared retrying cleanup, explicit unavailable/choice assertions, typed three-target positive onboarding and explicit native unknown assertions pass                                                                |
| Two cold database scenarios inherited the 5-second unit default                                                      | Low, resolved           | Commercial full replay uses its file's existing 120-second fixture budget; retention uses its shared grant fixture's existing 30-second budget. Assertions/global runner limits unchanged; real SQL scenarios pass |
| Intel native runtime is unverified; required automated/trust acceptance remains separate                             | Owner policy applied    | T012/T017/T030 are non-blocking post-release user-feedback follow-ups. T031 retains ARM native, Windows hosted, Intel static qualification and applicable Apple trust requirements.                                |
| Complete final canonical aggregate and environment acceptance are not green                                          | High, open verification | T033 remains open. Failed/partial aggregates, targeted reruns, isolated SQL pass and missing local Auth/deployment configuration are preserved separately in acceptance-matrix.md                                  |

Current task status after the owner-policy update: 29 completed of 34, with 5 open. T012/T017/T030 are post-release user-feedback follow-ups, not hardware prerequisites; T031/T033 retain the common required automated, trust and aggregate acceptance work. Intel hardware absence does not block release. Other outstanding acceptance and verification findings prevent a public-readiness claim. The latest artifact identity, SHA and actual command outcomes are recorded in acceptance-intel.md and acceptance-matrix.md. No production activation is authorised by completing source work.

A final medium-severity identity collision was reproduced and remediated: the installer click used the installed-package field. `installer_target` now records request intent, native identity is sourced only from health context, a forward-only enum guard migration preserves privacy, and CLI request projections remain separate. Seven focused files / 79 tests passed, including an actual producer→guard→storage→cohort path and real inspect query. Final PostgreSQL and artifact outcomes are recorded in the acceptance matrix.

## Owner-policy regression verification — 2026-11-07

The final focused run passed 10 files / 107 tests, including actual SDK-built x64 payload sealing without executing target binaries, schema-3 static proof validation, native-proof separation, and qualification-mode binding across mini releases. T034 records the implemented policy. Native Intel runtime and hardware remain explicitly unverified until real-user feedback.

Final canonical static verification: `npm run verify -- --gates=static` passed all 13 gates in 262 seconds, including formatting, lint, project/test/script types, design, localization, configuration, CSP and dependency audit. This result does not claim native Intel execution or a complete release aggregate.
