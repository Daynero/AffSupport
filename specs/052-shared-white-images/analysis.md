# Specification Analysis Report:052

**Date**:2026-11-12. **Scope**: spec,plan,tasks,research,data-model,4contracts,quickstart,quality checklist and constitution. Read-only analysis passes followed by separate edits explicitly authorized by the owner. This is documentation convergence, not runtime acceptance.

## Iteration log

- Round0: applied last owner scope:global-only atT0, hidden settings immediately,allupdatesglobal,30daymanagedretention; resolved200issuedvs5000confirmed to avoid waiting on unknown writes.
- Round1: three independent read-only domain reviews plus root mechanical/constitution pass. Findings below deduplicated. Each has a concrete remediation and regression task.
- Round2: all three domain reviewers re-read corrected documents and reported0remainingHIGH/MEDIUM findings.
- Round3: root semantic/constitution and mechanical closure check;0open material findings, full task/ID/dependency/link coverage.

## Findings and remediation

| ID  | Category              | Severity | Location                                     | Finding                                                                                  | Applied correction                                                                                                   |
| --- | --------------------- | -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F01 | Inconsistency         | HIGH     | spec.md US3/FR019                            | Confirmed5000 incorrectly selected next URL generation; status blurred issued/confirmed. | URL follows issued slot; all counters/denominators separate.                                                         |
| F02 | Consistency           | HIGH     | data-model.md; allocation/delivery contracts | Closed old alias lost24h proof while only current+2 prepared.                            | Immutable alias identity proof; fresh asset/config/health inheritance; old-pair tests.                               |
| F03 | Underspecification    | HIGH     | FR004; allocation contract                   | Bounded random sample could claim no pairing or unnecessarily repeat.                    | Indexed required buckets; exhaustion unavailable; checked-candidate distinct preference; pair recheck under lock.    |
| F04 | Data integrity        | HIGH     | cutover-cleanup contract; T042/T057          | Already claimed DELETE/purge could race30day hold.                                       | Drain positive provider deletion evidence before T0; unknown blocks activation.                                      |
| F05 | Coverage              | HIGH     | retirement model; T055-T062                  | Drive-only spaces lacked metadata cleanup/receipt without R2 object.                     | Typed metadata_unlink targets and zero-object finalizer; external_untouched terminal.                                |
| F06 | Data integrity        | MEDIUM   | retirement model; T058/T062                  | Quota attribution snapshot could credit old owner after transfer.                        | Stable ledger identity/current charged owner, once-only finish; transfer regressions.                                |
| F07 | Consistency           | MEDIUM   | diagnostics contract; data-model.md          | Paging revision undefined; conflicting snapshot models/unbounded restart.                | Read-only tuple fingerprint, deterministic sort,TTL60s and one restart then explicit partial.                        |
| F08 | Actionability         | MEDIUM   | tasks.md T048/T049/T059                      | Three tasks lacked explicit file paths.                                                  | Added precise planned migration/adapter paths; mechanical check.                                                     |
| F09 | Consistency           | LOW      | plan.md Technical Context                    | Status page100/500 conflicted with max100 contract.                                      | max100/default50 throughout.                                                                                         |
| F10 | Release compatibility | HIGH     | plan.md; cutover-cleanup; T044               | Backend fence alone cannot hide controls in arbitrary prior rollback bundle.             | Policy-aware prior baseline evidence required; absent baseline requires normal separate validated release before T0. |
| F11 | Underspecification    | MEDIUM   | retirement model/state contract              | Global cleanup_complete could coexist with unresolved children.                          | Complete only all object/metadata targets terminal, no ownership/receipt unknown.                                    |
| F12 | Privacy contract      | MEDIUM   | spec.md FR021; delivery contract             | Broad signed-URL ban conflicted with permanent authenticated public alias.               | Permit controlled permanent public alias only in owner status; forbid provider grants and all URL telemetry.         |

## Coverage summary

Every normative FR/AD and buildable SC has at least one explicit task. Task refs are verified mechanically; semantic review separately checks that the work actually covers the requirement. At the planning snapshot all69 tasks were unchecked; current implementation status is tracked in tasks.md.

| Requirement key | Has task? | Task IDs                                                                                       |
| --------------- | --------- | ---------------------------------------------------------------------------------------------- |
| FR-001          | yes       | T005, T011, T012, T014, T015, T069                                                             |
| FR-002          | yes       | T011, T014, T015, T016, T037, T038, T039, T040, T041, T059, T064                               |
| FR-003          | yes       | T002, T005, T009, T012, T013, T018, T019, T020, T021, T022, T023, T024, T050, T051             |
| FR-004          | yes       | T012, T013, T017, T048                                                                         |
| FR-005          | yes       | T012, T017, T048, T051, T054                                                                   |
| FR-006          | yes       | T006, T010, T019, T020, T025                                                                   |
| FR-007          | yes       | T019, T020, T021, T023, T025                                                                   |
| FR-008          | yes       | T003, T004, T005, T006, T010, T019, T020, T021, T025, T026, T027, T028, T030, T049             |
| FR-009          | yes       | T005, T008, T026, T027, T028, T029, T030, T049, T056                                           |
| FR-010          | yes       | T026, T028                                                                                     |
| FR-011          | yes       | T026, T030                                                                                     |
| FR-012          | yes       | T003, T004, T026, T027, T028, T047                                                             |
| FR-013          | yes       | T026, T028                                                                                     |
| FR-014          | yes       | T005, T008, T012, T014, T015, T018, T026, T027, T028, T029, T043, T047, T049, T051, T054       |
| FR-015          | yes       | T022, T029, T054                                                                               |
| FR-016          | yes       | T029, T030                                                                                     |
| FR-017          | yes       | T031, T032, T033, T064                                                                         |
| FR-018          | yes       | T031, T032, T033                                                                               |
| FR-019          | yes       | T031, T032, T033, T060                                                                         |
| FR-020          | yes       | T031, T032, T033, T060                                                                         |
| FR-021          | yes       | T006, T010, T030, T031, T032, T040                                                             |
| FR-022          | yes       | T011, T013, T014, T015, T016, T017, T018, T037, T038, T039, T040, T041, T043, T046, T064       |
| FR-023          | yes       | T016, T037, T038, T039, T045, T046, T067                                                       |
| FR-024          | yes       | T001, T010, T020, T023, T025, T048, T050, T052, T053, T058, T065, T066, T068                   |
| FR-025          | yes       | T003, T004, T005, T008, T012, T023, T047, T049                                                 |
| FR-026          | yes       | T008, T009, T012, T013, T018, T019, T021, T022, T024, T049                                     |
| FR-027          | yes       | T009, T019, T022, T023, T024, T044, T050, T053, T066, T067, T068                               |
| FR-028          | yes       | T047, T048, T049, T051, T052, T053, T054                                                       |
| FR-029          | yes       | T001, T023, T047, T048, T050, T051, T052, T053, T054, T068                                     |
| FR-030          | yes       | T002, T005, T037, T041, T042, T043, T044, T045, T046, T055, T056, T057, T062, T063, T067       |
| FR-031          | yes       | T003, T004, T006, T037, T038, T039, T040, T041, T042, T043, T045, T046, T057, T063, T064       |
| FR-032          | yes       | T002, T005, T010, T041, T042, T043, T046, T055, T056, T057, T058, T059, T061, T062             |
| FR-033          | yes       | T055, T056, T058, T059, T061, T062                                                             |
| FR-034          | yes       | T055, T056, T057, T058, T059, T061, T062, T064                                                 |
| FR-035          | yes       | T031, T032, T033, T055, T060, T062, T064                                                       |
| FR-036          | yes       | T001, T009, T024, T025, T042, T044, T046, T056, T059, T061, T063, T065, T066, T067, T068, T069 |
| AD-001          | yes       | T007, T008, T014, T020, T034, T035                                                             |
| AD-002          | yes       | T007, T014, T018, T020, T023, T034, T035                                                       |
| AD-003          | yes       | T003, T004, T007, T020, T029, T034, T035                                                       |
| AD-004          | yes       | T034, T036, T060                                                                               |
| AD-005          | yes       | T034, T036, T060, T068, T069                                                                   |
| AD-006          | yes       | T003, T004, T006, T007, T010, T022, T030, T032, T035, T036                                     |
| AD-007          | yes       | T007, T023, T029, T034, T035, T036, T050, T060                                                 |
| AD-008          | yes       | T024, T034, T036, T067                                                                         |
| AD-009          | yes       | T007, T018, T035, T036, T065, T067, T068, T069                                                 |
| AD-010          | yes       | T035, T036, T051, T052, T054, T068                                                             |
| AD-011          | yes       | T034, T035, T036, T042, T043, T046, T058, T060, T067, T068                                     |
| SC-001          | yes       | T011, T015, T018, T038                                                                         |
| SC-002          | yes       | T013, T017                                                                                     |
| SC-003          | yes       | T017, T019                                                                                     |
| SC-004          | yes       | T026, T027, T028, T030, T049                                                                   |
| SC-005          | yes       | T026, T027, T028                                                                               |
| SC-006          | yes       | T027, T028, T029, T054                                                                         |
| SC-007          | yes       | T031, T033                                                                                     |
| SC-008          | yes       | T029, T031, T033, T060                                                                         |
| SC-009          | yes       | T011, T015, T016, T018, T037, T043, T046                                                       |
| SC-010          | yes       | T036, T044, T065, T066, T067, T068, T069                                                       |
| SC-011          | yes       | T010, T019, T030, T031, T032, T036, T065                                                       |
| SC-012          | yes       | T048, T050, T051, T053, T066, T068                                                             |
| SC-013          | yes       | T047, T049, T054, T066                                                                         |
| SC-014          | yes       | T022, T024, T053, T061, T067, T068                                                             |
| SC-015          | yes       | T002, T047, T048, T050, T051, T052, T053, T054, T066, T068                                     |
| SC-016          | yes       | T037, T038, T039, T040, T041, T045, T046, T063, T067                                           |
| SC-017          | yes       | T042, T043, T044, T046, T055, T056, T057, T061, T062, T063, T066, T067                         |
| SC-018          | yes       | T002, T055, T056, T058, T059, T060, T061, T062, T063, T066, T067                               |

## Constitution alignment

No accepted exceptions. Typed boundary/closed reasons, RLS and service-only writes, SELECT-only CLI, bounded workers/locks, existing UI/state seams, additive release/schema and full exact-source acceptance are retained. No schema DROP, direct wrangler publication, production activation, arbitrary cleanup or analytics writes were executed.

## Unmapped tasks

None: every task has explicit FR/AD/SC refs. Setup/foundation/final acceptance tasks intentionally have no story label; all story tasks have US1..US7 labels. All dependencies point to earlier IDs; no cycles/forward prerequisites. Paths for planned new code are deliberate targets, not claims that implementation exists.

## Metrics and limits

- Normative requirements:36FR +11AD; buildable success criteria:18SC;65total coverage entries.
- Tasks:69; stories:7; explicit coverage100%; unmapped0.
- Round1 deduplicated findings:12 (6HIGH,5MEDIUM,1LOW), CRITICAL0. All12 corrected; independent Round2 verified closure; remainingHIGH/MEDIUM/CRITICAL0.
- Runtime/provider/performance/Meta/release results:unverified, not run. p95 targets are requirements; no measured success is claimed.
- External limits: offline old UI cannot be remotely rewritten; managed upgrade barrier required on return. Cleanup covers Soty-owned origin/CDN and metadata,not external originals/caches. Previous rollback compatibility evidence and actual accepted deployment are release prerequisites.

## Historical planning next actions

Document convergence is complete; all12 findings have fixes and regression tasks. Proceed to the unchecked implementation tasks only under a separate implementation request. Canonical production intent/gates remain necessary for release/T0. Never activate or delete customer objects to prove this document correct.

## Reviewed artifact hashes

Historical planning-snapshot SHA256 values, excluding this report. Implementation edits below are later evidence; these planning hashes are not current runtime or release proofs.

| Artifact                     | SHA256                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| checklists/requirements.md   | a4ce339072e6f16b7c1d87e944b573b6f26fdde7e86dafe94b36d8e4dc74abd5 |
| contracts/allocation.md      | 13dc8fcb46a5288e47633799012c2bff4bf735a397b23ad0f5aa1f953f5ffb25 |
| contracts/cutover-cleanup.md | a1eaf20b09a15f4b20589f3b1aa221a998b27f9f28e857c11a499e46e6f679fe |
| contracts/delivery.md        | 7043b2dc3bf9ec98338ad44fff123190fb26990888c63aa0a7c46522d295f626 |
| contracts/diagnostics.md     | 88bf6335a0eae8652bc18b7e6b66bdc7f9f86fd6ac440ef672bc4f5486674c32 |
| data-model.md                | d3b11364e0612f3631ab4b9f20bccc14b1f2451b7172037a5676244218ca1c09 |
| plan.md                      | 59848d7e7e4a58a387b732aca17f5ceecdabecb1bcdf4235244106f4b721e7f7 |
| quickstart.md                | 3994152b470267095da0b68ab05f5e8eed2ad35af08f748507bdd714aad48de6 |
| research.md                  | 411696711a1bfe68c473c35f8e873c559a37ac633a4e633dc176f3210a3221e3 |
| spec.md                      | 55bfb9970051fefa68ccbe799313063cba9439f7c6ee349bea8bac0861b40c1d |
| tasks.md                     | 7703e6674b7c7beaeb73592c72cdc76fef6a06d1fdff9d53529680ce1ec90e18 |

## Implementation review052

Local regression review has fixed incomplete recipe acceptance, operator predicate misuse, full unclassified union validation, current-owner catalog identity reuse, global full-row false-flag updates, frozen garment/color row ordering, exact720-hour timestamps, and platform task-reference coverage. The existing full-schema pgTAP suite exposed two pre-existing privilege assertions naming obsolete function arities; assertions now match the existing canonical functions with optional arguments, without changing production APIs.

Architectural refinement: retirement policy ownership is `policy_reason=policy_retirement` on the existing physical-purge transport; the legacy reason vocabulary remains unchanged. Exact counts and holds are owned by the new durable retirement manifest. This preserves045's current-ledger credit implementation and avoids weakening old purge semantics. Existing accepted/inconclusive legacy work must drain or be explicitly cancelled before T0; it is not silently relabeled or replayed with different accepted payload bytes. An operator cannot self-attest activation: a short-lived source/config/manifest-bound service-only acceptance permit from trusted release preparation is also required.

External acceptance remains unverified: provider cache fanout, browser/installed macOS+Windows, Meta ingestion and scoped real-provider retirement. No local test substitutes for those proofs; T0 is blocked in their absence. Fresh100/200-row allocation against2000images is now measured in validation/benchmark.json; real authenticated catalog end-to-end overhead remains unmeasured. No production activation or deletion has run.

Further concurrency review: settings writes and legacy image admissions now share the policy-row barrier, so T0 cannot overtake a previously admitted settings/grant transaction. Global text/price saves preserve the current row's legacy image field during ON CONFLICT rather than writing back a stale pre-read value; due cleanup cannot be undone by a concurrent unrelated save. Same operation intent serialization covers every image scope, preventing cross-scope identity races without a global allocation mutex.

### Runtime review follow-up

Closed high-impact implementation findings:

1. Concurrent200-row allocation exceeded250ms and sometimes exhausted candidates. Atomic set-based image locking/counter/assignment/JSON batches replace per-row SQL on unrestricted/single-bucket requests. The full100-sample/concurrency1+10 cohort now passes without failures; heterogeneous frozen-fact fallback remains bounded and is not included in that performance claim.
2. Frozen recipes could outlive serving health before an external write. All producers now call a v3 batch use validator, checking current asset/config/key/serving health before write; actual completion is still recordable after a later health expiry.
3. New v3 clients could change the payload digest of a trusted accepted v2 retry. Accepted-version normalization preserves the original request; SQL permits only already registered legacy receipts after T0, with no retired-image reconfirmation for cached success.
4. Large/failed imports could starve health maintenance, while one item per30seconds made seeding unnecessarily slow. Due ready probes precede import claims, unsuccessful probes back off, eligible imports chain through a service-only kick and idle work retains the bounded cron cadence.
5. Settings for hidden images could still invalidate text saves or show unknown readiness. Global text settings now omit the retired URL, ignore its validity/draft state/private inventory, and use text-only labels. Regression passes with an invalid stale hidden URL.
6. Managed purge tombstones from teams deleted before T0 could escape the hold. Prepare includes these managed identities; team-deletion-before/after-T0 regressions pass. Manifest digest binds complete immutable target identity.

7. Shared image/catalog IDs were incorrectly eligible for first-actor inference in investigate. Owner resolution now accepts only correlated flow/attempt receipts with one unambiguous actor, preserving operation scope; shared-image lookup stays explicit status evidence. Regression added.

8. A cancelled/expired unpublished import reservation could permanently block exact byte reimport. Background reserve now transfers only unissued immutable byte identity after the previous entry is terminal/expired and unleased; old worker fences remain revoked. It cannot relabel an issued image or publish without full readback. Regression added.

9. Byte dedup did not surface classification conflicts or reused state and still attempted a public PUT for an already ready image. It now rejects conflicting facts, verifies existing canonical/alias bytes without another public upload, preserves image identity/counters and records reused. Real-route regression extended.

No claim is made that local SQL/transport tests prove Meta ingestion, CDN fanout, installed-platform delivery or real provider deletion. These remain the explicit future T067 activation prerequisite. Source verification is tracked separately in validation/acceptance.md.

### Verification-driven refinements

- Edge runtime graph: both new self-typed shared modules now have declaration anchors; the new function has pinned Deno configuration/lock and passes Deno2.5.6 frozen check.
- Critical coverage inventory: both new reachable shared modules now have90% floors. Focused measured line coverage is95.2% (global contract) and97.91% (HMAC alias);50tests passed,2native tests remain scoped to disposable PostgreSQL.
- Real foreground policy race: a meaningful failing UI regression reproduced late prepared replies reopening settings after an active response. The provider now rejects older requests/epochs/observations and retains a global policy watermark across failed reads/space changes. Failure keeps controls hidden; foreground visibility and revision retries recover. Seven UI/inventory regressions pass.
- Earlier fast runs exposed and stopped on these issues rather than being called green. The final source is being checked by the stronger full release form, including coverage, builds and local database/browser gates. This does not run a release or supply external T067 evidence.

### Final convergence review

The source implements all seven stories; final gate results and remaining external
acceptance are recorded in validation/acceptance.md. Historical planning hashes
above are intentionally unchanged and are not final-source proofs.

- Historical key drift: bounded background verification now includes one issued
  old alias per retained key absent from current+2. Real-route failing/passing
  regression proves readiness removal/recovery while preserving URL and counts.
- Operator grant capacity: definite busy responses alone may retry within60s and
  30attempts using the same grant identity; unknown/canceled results propagate.
  Catalog allocation never enters this wait.
- Coverage review: added behavioral regressions for global readiness without
  private reads, canceled/stalled preflight, preserved video/publication settings,
  verified inspection reuse/eviction, history paging and audit recovery. All77
  focused assertions pass. Every numeric baseline/floor remains; only an already
  absent catalogVideoProtocol.ts entry is recorded as retired.
- Local test environment: modeled missing browser Element.scrollTo and extended
  old context fixtures with the policy hook. A scroll-reset regression verifies
  navigation. Production behavior was not altered to satisfy jsdom.
- Complete release checks run through the canonical supported phase groups; public
  build configuration is kept out of unit tests. Missing provider/platform proof
  remains unknown and blocks future T0 rather than being inferred from local green.

No new unaddressed local HIGH/CRITICAL implementation finding remains. T067 is
explicit future release acceptance, consistent with the owner's instruction to
keep052out of main and the nearest release. No deployment or activation ran.

### Inherited bundle gate — final disposition

The final canonical suite stopped after6/8shards on the existing Launch download
budget. A clean detached exact-base checkout with private dependencies and the
same public build configuration reproduces it:54,086B versus54,000B. The shared
growth metric also already exceeds its67,000B ceiling (base84,013B). Feature
Launch is54,079B; total asset delta is+1,152B. No budget was raised and no asset
was excluded. See validation/bundle-comparison.json. This is an inherited release
gate failure, not a closed green check. T065/T066 and final sign-off remain open.

Final focused verification:170passed,2explicit native prerequisites separately
covered in the green disposable DB phase. Supplemental measured coverage union
passes the unchanged numeric floors at84.09%; it is labeled separately from the
failed final canonical suite. All new code paths and the seven implemented stories
have local regression evidence. External T067 and complete canonical revalidation
remain necessary before any future release/T0; the current implementation does
not authorize publication.

The final UI review reproduced a keyboard regression during T0: removing the
image field left the roving toolbar index outside the remaining controls. The
index now clamps to the live control count; the failing then passing regression
preserves a tab stop and Home navigation. Final targeted run:170passed,2explicit
native prerequisites. Final browser accessibility:20route/theme combinations,
zero violations/page errors.
