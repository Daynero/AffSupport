# 037 analysis and remediation — 2026-10-20

Scope: six active stories; US5–US8 and FR-010–015/SC-005 belong to 038. The initial analysis was read-only. The owner explicitly requested remediation and implementation after it, so the corrections below were applied without another approval step.

| ID | Severity | Location | Finding | Remediation |
|---|---|---|---|---|
| C1 | HIGH | tasks.md / current UI | Most unchecked tasks mixed missing implementation with already-shipped layout/menu/chip/glossary foundations. | Reconciled implementation flags against code and regression evidence; kept manual/release gates separate. |
| C2 | HIGH | spec FR-002 / TeamContextSnapshot | The spec required a workspace timezone that does not exist in the model. | Preserve and explicitly name the existing browser civil-day contract; verify midnight/month/DST behavior. No new setting was invented. |
| C3 | HIGH | TaskSpace / useTaskClipboard | Paste reset board filters and forced copied selection; an uncertain response could be retried with a new server copy. | Keep filters; clear selection on settlement; session-stable request key and actor/team/payload-bound SQL replay receipt. |
| C4 | CRITICAL | attachment cleanup | Last attachment count and a shared drop folder do not prove ownership or absence of other consumers. No worker/lease/Undo receipt existed. | Accepted upload intent + service success evidence; complete consumer inventory including JSON; conservative reference query/fence; atomic deadline-bound Undo; existing worker owner and exact provider readback. Unknown origin/outcome retains or waits. |
| C5 | HIGH | ExplorerShell | Bulk trash stopped on its first failure; its state was not recoverable across sessions. | Hosted group/items joined to immutable operation receipts; bounded execution; server descendant dedup; authoritative partial retry and urgent existing Realtime reread. |
| C6 | HIGH | image embedding | An explicit gallery image could not be pinned, validated or explained after settings changed. | Nullable slot IDs; boundary/config validation; frozen job selection; mode-only telemetry and existing failure code; no silent substitution. |
| C7 | HIGH | diagnostics | Declared events alone did not prove server outcomes or browser delivery. | Restricted SQL projection + read-only CLI query, typed flows, visible-surface acknowledgement, and explicit missing-view/as-of/delivery blind spots. |
| C8 | MEDIUM | plan/contracts | Illustrative migration dates and IndexedDB/group-state assumptions had drifted from available seams. | Use migrations after existing history, hosted intents instead of a second trash journal, actual RPC/receipt contracts and retained task IDs. |

## Coverage after remediation

| Requirement | Tasks / evidence |
|---|---|
| FR-001–002 | T007–008; shared calendar layout and civil-day regression |
| FR-003–004, SC-001 | T007/T009–011; clipboard replay, first-click/search and SQL copy tests |
| FR-005–006, SC-002/007 | T001/T012–018; real SQL ownership/Undo/reference/fence/recovery and worker postcondition tests |
| FR-007, SC-003 | T019–024; hosted receipts, 50-item continuation/reload/retry and Realtime regressions |
| FR-008–009, SC-004 | T025–027; existing anchored-layer/menu/chip tests and recorded browser acceptance |
| FR-016 | T039–043; shared parser, legacy settings, queued freeze, UI and telemetry guard |
| FR-017 | T049–050; shared glossary keys and existing dialog/navigation consumers |
| FR-018 | SQL permission boundaries, stale-team read rejection and failure-only retry |
| AD-001–004, SC-006 | T004–006/T018/T024/T043/T051; typed lifecycle, restricted projection, actual read-only query and privacy tests |

22 active FR/AD/SC requirements have task coverage. Historical transferred requirements are excluded from that denominator. There is no unmapped active story or constitutional exception. Implementation coverage is not a claim that every independent live/platform scenario has run: T052–053 and quickstart.md carry that evidence and any remaining blockers.

## Additional defects found while implementing

- All six private intent/provenance tables force RLS as well as revoke direct browser grants; service/RPC boundaries remain permission-checked.
- Reattachment during the grace window now makes a subsequent detach create a new receipt and remove the actual link.
- Undo rolls back if the original material is no longer attachable; it cannot return a cancelled cleanup with a missing link.
- A lost Drive mutation reply is reconciled by reading the exact object; its durable fence survives until that result is known.
- Undo of a superseded detach receipt verifies that the original task link actually exists; another task’s detach cannot make it return a false success.
- Reference fences include active operations and access grants; known authentication-only custody tables are excluded only when they contain no material FK or JSON.
- Optional image-choice capability is checked by the parent screens, keeping the shared image section independent of connection context and compatible with old agents.
- Urgent bulk invalidation arriving during an active read schedules an immediate follow-up read.
- An old team's delayed read cannot populate the current team's operation surface.
- A terminal failed trash receipt gets a new bounded attempt; an unknown response keeps its exact existing key.
- Confirmed trash clears transient request error text. UI feedback localizes stable codes and uses human file labels.
- Bulk visibility is acknowledged by the mounted visible panel, not by the background provider's receipt read.

## Current closure scope

Implementation remediation is complete. The owner explicitly deferred all release-form checks and packaged/live acceptance until the consolidated pre-release pass. Live Windows testing is excluded; automated platform contracts remain. T052 passed the normal `npm run verify`: 14/14 gates, 6240 tests passed, 17 explicit skips, zero failures. All current implementation tasks are complete. T053 is deferred and does not block implementation closure.

The earlier bundle and local pgTAP failures were fixed without changing the budget or weakening permissions: exact geometry reconstruction and inventory-scoped styles reduce the bundle; a disposable real PostgreSQL container isolates the database tests from existing data and roles. The canonical database command passed 834 checks. The earlier failure reports remain historical evidence in quickstart.md.

The final diagnostic review correlates detach to the exact cleanup receipt, preserves known rejection/provider codes, and leaves uncertain transport outcomes open for reconciliation. Receipt observation does not invent a new user request. No production deployment is part of this work.
