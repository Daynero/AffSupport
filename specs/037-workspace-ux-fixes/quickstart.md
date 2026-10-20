# Validation guide

**Current follow-up:** live Windows acceptance was excluded by the owner. Bundle and local-database failures below were corrected; the unchanged performance tests and canonical 834-check pgTAP run now pass. Normal verification passed: 14/14 gates, 6240 tests passed, 17 explicit skips, zero failures. Release verification is deferred by the owner. Earlier FAIL records are retained as historical evidence.

## Prerequisites

- Use an isolated beta/local test space with two editor accounts, a viewer, task attachments, and a local agent with two image assets per slot.
- Follow `docs/BETA.md` for hosted workspace integration. Do not run destructive file scenarios in production.

## Scenarios

1. **Board and copy:** Filter tasks, select one, copy/paste, then select another on first click. Verify filters stay local, copied task follows established content rules, and repeated paste during a pending attempt creates one result. Check midnight and DST dates in the established browser timezone.
2. **Attachment cleanup:** Upload a file to one task, detach, use Undo within its advertised 14-second action; repeat without Undo. Verify the server's 30-second deadline, scheduled worker claim and confirmed move to the space's trash within five minutes after the deadline when worker is healthy. Check a shared task attachment, a catalog/launch-referenced file, and an external Drive file all remain. Force a new reference during cleanup and verify retention. Delay the detach response until fewer than 20 seconds remain and verify Undo is not falsely offered. Disable the worker and verify visible waiting/retry rather than success. Do not interpret trash as reclaimed storage quota.
3. **Bulk trash:** Select 50 files including a folder and its child. Inject one timeout/failure; inspect per-item progress, continue working elsewhere, reload and open a second member session, then retry only failed/reconciled unknown items. Confirm hosted receipts and `team_operations` postconditions are authoritative, the existing `useTeamRealtime` seam invalidates and rereads them after reconnect, no duplicate trash occurs, and the partial result is accurate. In a controlled browser test, timestamp receipt/Realtime delivery and visible state for all 50 items; each delay must be ≤1 second while the browser is connected. During disconnect, the UI must say it is awaiting reconciliation.
4. **Layout:** At desktop and narrow widths, at 200% zoom, and with keyboard only, inspect task controls, clipped file menu, local-operations chip after success/error.
5. **Transferred:** Order/archive acceptance belongs to [038](../038-unified-accounts/spec.md), not the 037 gate.
6. **Transferred:** Unified accounts/finance UI and sticky finance header acceptance belong to 038.
7. **Image embedding:** Choose one start and one end asset from galleries; queue several videos and confirm they all use the explicit images. Remove a selected asset before enqueue and verify a clear error; old settings still use random mode.
8. **Diagnostics:** For each state-changing journey inject success, failure, cancellation/interruption and missing receipt. Query the read-only CLI (`investigate`, `inspect`, `audit` as appropriate) and confirm it explains the last proven stage, cause, delivery, or explicit blind spot without private content.

## Gates

- Focused tests for the touched web, shared, agent, SQL and analytics paths.
- Current completion gate: focused regressions and `npm run verify`. The owner explicitly deferred `verify:release`, packaged beta and consolidated live/provider acceptance until the pre-release pass. Live Windows acceptance is excluded; automated platform contracts remain.
- Design token and Tailwind checks are included in verify; visually inspect the affected screens against `docs/DESIGN.md`.
- If a production release is later requested, follow `docs/PRODUCTION.md` and its beta promotion gate. This guide itself does not authorize deployment.

## Current evidence

| Check | Observed outcome |
|---|---|
| Copy, task filters/selection, civil dates | Focused regressions passed; stable copy retry key and SQL replay proof. |
| Detach and cleanup | 15 SQL scenarios plus worker/editor regressions cover provenance, grace/Undo, lost mutation reply, permission, references and forced RLS. Two real PostgreSQL held-lock sessions passed in disposable databases. |
| Bulk trash | 50-item continuation, hosted reread/another session, failed-only retry and stale-space rejection passed. Live provider/network timing remains release acceptance. |
| Diagnostics | Restricted view and actual read-only CLI query passed; missing projection/delivery/history remains explicit. |
| Explicit images | Shared/settings/UI/queue tests cover old random mode, invalid selection, frozen jobs and optional agent capability. |
| Chrome layout | Desktop, compact, keyboard End and actual 200% zoom passed. [Desktop](evidence/menu-desktop.png), [compact](evidence/menu-compact.png), [200%](evidence/menu-zoom-200.png). |
| Bundle remediation | The unchanged budget passed after exact geometry reconstruction and inventory-scoped library structures. The original backdrop checksum and transitive component-style inventory are tested in `tests/workspace-bundle-integrity.test.ts`; full default theme retained. |
| Database runner remediation | `npm run test:db` passed 834 checks in a disposable real Supabase PostgreSQL container. It copies no application rows or role passwords, disables scheduling, replays migrations and removes only its own container. Source stack/roles remain unchanged. This is prior evidence; the next full DB/release run is deferred by the owner. |
| Normal verification | PASS: 14/14 gates, 6240 passed, 17 explicit skips, zero failures. [Canonical result](evidence/verification-fast.json). Coverage was not measured by the fast form. |

## Deferred pre-release work

The owner requested that release checks run together later, before release. T053 and `verify:release` are therefore deferred, not reported as passed or as current implementation blockers. That later pass must include final builds/contracts/database/browser gates, exact-commit packaged beta and isolated live Drive/scheduler/two-session outcomes. Live Windows testing is excluded by the owner; automatic Windows contracts remain required.

The prior `beta:doctor` found ports 43140 and 5175 held by an existing beta run. No existing process was stopped. No production migration, version bump, tag, release or deployment was performed.

## Historical verification attempts

Earlier failed runs are retained in [release evidence](evidence/verification-release.json), [e2e evidence](evidence/verification-e2e.json) and [bundle comparison](evidence/bundle-comparison.json). The budget and local database failures in those reports were subsequently fixed; those old reports are not the current verdict. The previous full release process did not leave a completed aggregate report, so no aggregate release/coverage PASS is claimed.

The planning checklist passed 14/14. The audit and remediation are in [analysis.md](analysis.md).

The current implementation scope is complete. The duplicate verify was stopped and the existing shared run was adopted; its single worker used nice 15. No Docker or additional builds were started after the owner deferred release checks.
