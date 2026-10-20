# Validation guide

## Prerequisites

- Use an isolated beta/local test space with two editor accounts, a viewer, task attachments, and a local agent with two image assets per slot.
- Follow `docs/BETA.md` for hosted workspace integration. Do not run destructive file scenarios in production.

## Scenarios

1. **Board and copy:** Filter tasks, select one, copy/paste, then select another on first click. Verify filters stay local, copied task follows established content rules, and repeated paste during a pending attempt creates one result. Check midnight and DST dates in the space timezone.
2. **Attachment cleanup:** Upload a file to one task, detach, use Undo within its advertised 14-second action; repeat without Undo. Verify the server's 30-second deadline, scheduled worker claim and confirmed move to the space's trash within five minutes after the deadline when worker is healthy. Check a shared task attachment, a catalog/launch-referenced file, and an external Drive file all remain. Force a new reference during cleanup and verify retention. Delay the detach response until fewer than 20 seconds remain and verify Undo is not falsely offered. Disable the worker and verify visible waiting/retry rather than success. Do not interpret trash as reclaimed storage quota.
3. **Bulk trash:** Select 50 files including a folder and its child. Inject one timeout/failure; inspect per-item progress, continue working elsewhere, reload and open a second member session, then retry only failed/reconciled unknown items. Confirm hosted receipts and `team_operations` postconditions are authoritative, the existing `useTeamRealtime` seam invalidates and rereads them after reconnect, no duplicate trash occurs, and the partial result is accurate. In a controlled browser test, timestamp receipt/Realtime delivery and visible state for all 50 items; each delay must be ≤1 second while the browser is connected. During disconnect, the UI must say it is awaiting reconciliation.
4. **Layout:** At desktop and narrow widths, at 200% zoom, and with keyboard only, inspect task controls, clipped file menu, local-operations chip after success/error.
5. **Transferred:** Order/archive acceptance belongs to [038](../038-unified-accounts/spec.md), not the 037 gate.
6. **Transferred:** Unified accounts/finance UI and sticky finance header acceptance belong to 038.
7. **Image embedding:** Choose one start and one end asset from galleries; queue several videos and confirm they all use the explicit images. Remove a selected asset before enqueue and verify a clear error; old settings still use random mode.
8. **Diagnostics:** For each state-changing journey inject success, failure, cancellation/interruption and missing receipt. Query the read-only CLI (`investigate`, `inspect`, `audit` as appropriate) and confirm it explains the last proven stage, cause, delivery, or explicit blind spot without private content.

## Gates

- Focused tests for the touched web, shared, agent, SQL and analytics paths.
- `npm run verify` before marking each slice complete; `npm run verify:release` plus database tests for slices with migrations or agent contract changes.
- Design token and Tailwind checks are included in verify; visually inspect the affected screens against `docs/DESIGN.md`.
- If a production release is later requested, follow `docs/PRODUCTION.md` and its beta promotion gate. This guide itself does not authorize deployment.
