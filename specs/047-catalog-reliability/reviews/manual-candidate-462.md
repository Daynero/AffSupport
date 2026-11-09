# Candidate462 — queued manual acceptance

**NOT EXECUTED.** The CUA native/browser host was unavailable after three attempts. No N test job or delegation was created. This checklist is a pending acceptance record, not a pass.

Backend prerequisites reported by the parent: native462 passed **1411 pgTAP assertions, 3 Auth checks and 76 concurrency checks**; the single179 local increment passed (`46031`), preserving all **235 pre-existing table projections**, the protected material and **110 related operations**. Manual staging is now **ready**: beta start `67487` completed, web returns200 and the unauthenticated native endpoint returns the expected401. Real local Auth and signed-entitlement inspection `66123` passed; the protected material and110 related operations remain unchanged after startup. Readiness details are retained privately in `scratchpad/047-manual-staging-readiness-462.json`. These results do not replace manual, packaged or performance acceptance. The full canonical fast suite remains pending after the two corrected contract failures.

## Open and sign in

- Web: <http://127.0.0.1:5175>. Native Beta connection: <http://127.0.0.1:43140>.
- Use the local beta login screen's **space owner** fixture action. If credentials are required, use the existing private local fixture setup; do not copy credentials, session links, tokens or grants into this report.
- Confirm the Beta indicator, real local authentication/entitlement and `VITE_LOCAL_DEV_AUTH=false`. Check the connected installed agent and capability state; a synthetic browser benchmark is not this login proof.
- Use fresh, explicitly authorized synthetic provider fixtures. Preserve the protected material, its110 related operations and existing catalogs. Do not reset the database or stop unrelated apps.

## Critical paths, in this order

| Pending check | Manual action | Required visible/provider outcome |
|---|---|---|
| Download and share | Download the same fresh catalog from Manager and Explorer; open the downloaded file. Get/share its link from both surfaces. Repeat with clipboard permission denied. | File opens with the intended catalog; a selectable full link remains available on copy failure. No false “copied” success, HTML error download or unexplained server message. |
| Broken image fallback | Re-stitch once with a known bad image plus a good image; repeat with only bad images. Retry the original setting. | Same-click fallback succeeds when a valid candidate exists. Known broken versions are excluded on later random choices. All-bad ends with an understandable bounded error, never repeatedly attacking the last image. |
| N5, cancel, reopen | With at least five products, request five physical variants. Observe K/N, cancel during processing/upload and reopen/restart. Then use a separate fresh N5 attempt. | Exact original request/set identities; no fresh jobs after cancel; ready outputs are not regenerated on recovery. Successful set has five physical receipts and all five occur in the assignment. Unknown upload stays unknown until readback. Referenced outputs survive cleanup. |
| Deferred same-file links | Create a catalog with a near-future calendar/time and N5. Inspect it immediately. Run image/text refresh before due. After preparation completes, close the browser and disconnect only the idle native agent, keeping the backend running. | Table exists before N finishes; video cells stay blank before first publication, or preserve the prior active URLs. Due updates only stored video URL cells in the **same spreadsheet/file**. IDs, text and images are not rebuilt by the due job. Record delayed/blocked outcomes honestly. Do not use `beta:down` for this offline-agent scenario. |
| Deferred combinations | Repeat with re-stitch off; hold/reschedule/add-now; published1→pending10; growth/reorder and provider denial/outage. | No fake video set for source-only mode; no early replacement; current URL/assignment survives until verified replacement. Frozen growth rebinds safely or explicitly waits. No stale job writes after reschedule/cancel. |
| Manager recovery | Lose a save reply; edit mixed N counts and Undo; partial trash/restore; switch actor/team or use a second tab. | Readback before retry, per-item truthful results, current-attempt progress, immutable active snapshot and no stale actor writes. A historical receipt is not current-generation success. |

For each path retain timestamps, app/source/capabilities, opaque catalog/request/attempt/set IDs, screenshots and actual file/cell readback, plus locally scoped SELECT-only CLI diagnosis. Keep credentials, provider URLs, user content and grant payloads out of committed evidence. Stop on an uncertain write and inspect its original receipt; do not blindly replay it.

All rows above remain **pending / CUA blocked**. Real browser input-to-paint p95, second-OS parity, exact packaged-beta proof and the complete fast suite are separate open gates. Production activation is not authorized by this checklist.

## Owner observations after staging (2026-11-08)

The owner did begin manual UI testing; the checklist's “NOT EXECUTED” refers to
agent-operated acceptance and the uncompleted end-to-end rows, not absence of
owner activity. Screenshots are observations, not provider-delivery proofs.

- 18:39: Launch update refused before admission. Server503 was incorrectly
  labelled transport unavailable when no native executor/delegation existed.
  Corrected to known nonretryable AGENT_REQUIRED and actionable copy; 89 focused
  cases passed. Normal API readback retained the previous succeeded generation.
- 18:48: after Cancel, settings appeared locked. A separate lost-cancel-ACK
  reconciliation defect was reproduced and corrected (46 hook cases passed).
  The exact screenshot cause is unconfirmed: local access logs contain no
  cancel RPC. T061 remains open for manual reproduction.
- 18:55: specific executor guidance is visible, but manual N remains blocked
  when the app is paired and general background work is disabled. T062 records
  the missing one-set session/native authorization path. This is an OPEN
  functional blocker, not a completed scenario or merely a copy issue.

The owner also requested and received a nonclearable city/GMT timezone list,
a Switch for deferred links, and a collapsible date panel whose summary stays
visible. Eleven focused UI/timezone cases passed; this does not prove N delivery.

### T062 foreground acceptance — additional required row

Keep general background work **disabled**. With the paired Beta agent, perform
a fresh synthetic N5 from Launch, creation and Manager. Capture the original
request, enrollment, set and each physical child receipt. Close the browser
after submitting, including before the first progress reply: metadata-only
waiting may continue, but provider work begins only after atomic set binding.
Check a quiescent agent restart after three registered children, an interrupted
unknown upload, logout and another actor. No global queue claim or old job may
run; completed outputs are reused and unknown ownership is reconciled before
any new execution. Due publication remains a separate same-file video-cell
proof. This row is **pending**, not implied by unit tests or a supported capability.
