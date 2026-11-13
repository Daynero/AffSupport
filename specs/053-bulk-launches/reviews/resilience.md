# Unattended batch fault review

Historical evidence for `58172104`. The browser-local coordinator and unload
warning described here were subsequently replaced by durable server admission.
Current behavior and acceptance are recorded in
[owner-follow-up-validation.md](owner-follow-up-validation.md); this report keeps
the earlier failure reproductions and verification results without relabeling them.

Owner follow-up: ten requested launches should do all independently possible work even if one is deleted, canceled, loses its video, or Google/server stops responding. No production calls or real provider writes are used in fault injection.

## Reproduced defects

1. Two lost acceptance replies occupied both slots forever; the other eight never dispatched. Real batch plus real generation hook regression was red, then green.
2. Accepted launches removed from list/filter or inaccessible after archival had no reliable detail readback. Reconciliation now reads independently of list success/filter and parks unresolved items without fabricating a terminal outcome.
3. The workspace's observation cadence stopped in a hidden tab; completed first jobs could leave remaining drafts waiting indefinitely. The existing single cadence now drives batch recovery while hidden and when list reads fail.
4. Parent failure/partial/cancellation with a stale preparing-video projection could hold a slot. The card classifier is now also the batch terminal classifier.
5. Accepted POST followed by stale empty or replacement-generation detail previously cleared the local intent. Exact request identity is now required before handing off accepted work; stale reads keep the original intent for recovery.
6. Deleting a shared producer's local source propagated failure to consumers with surviving verified copies. The real cache/file lifecycle test failed before correction; the next consumer now rebuilds using its own source. Identical-content authority and cache keys are unchanged.

7. A finite admission replay limit abandoned unsubmitted work after a long outage. Preflight and retained-intent recovery now continue with capped exponential spacing; five-minute outage tests finish all ten automatically.
8. Stop did not fence the generation hook's internal Google backoff or a pending save continuation. Both regressions failed before adding an admission guard; Stop now prevents these subsequent writes too. The control remains available for a two-item dispatch and an entirely parked batch.

9. Confirmed cancellation awaiting cleanup still occupied both slots indefinitely. Both cancel-requested and cleanup-pending regressions reproduced starvation; they now release admission capacity, retain explicit cleanup status and reconcile to the eventual canceled receipt without replay.

## Fault matrix and evidence

| Fault / race | Required behavior | Regression |
|---|---|---|
| Two accepted POST replies lost | Exact receipt readback; all ten complete; ten unique admissions | launch-batch-resilience |
| Two receipts permanently unreadable / archived | Eight siblings complete; two remain unconfirmed; no blind replay | launch-batch-resilience |
| Save reply lost | Reuse identical saved payload/key and generation key | launch-batch-resilience |
| Deleted/changed source or edited selected draft | Refuse that item; nine siblings complete | launch-batch-resilience, native source authority |
| Two cancellations await cleanup indefinitely | Eight siblings finish; no admission replay; later cleanup receipt resolves the two | launch-batch-resilience |
| Parent failed/partial/canceled, video still preparing | Release slot, preserve correct outcome | launch-batch-resilience |
| Temporary Google 429/503/unavailable | Bounded same-key retries | launch-batch-resilience, drive-transient-retry |
| Persistent Google refusal | Bounded retries, explicit uncertainty, eight healthy siblings finish | launch-batch-resilience |
| Five-minute service outage before preflight | All ten resume automatically after service returns | launch-batch-resilience |
| Five-minute admission outage after draft save | Original keys retained; all ten resume without manual retry | launch-batch-resilience |
| Two parked replies race for one free slot | Reserve synchronously; one healthy encode plus one retry only | launch-batch-resilience |
| Stop during Google retry delay / late save reply | No subsequent admission writes; accepted work remains independent | launch-batch-resilience |
| All remaining items parked | Stop stays accessible and prevents later cooldown replays | launch-batch-resilience |
| Preflight never answers | Waiting deadline, no generation for that item, siblings continue | launch-batch-resilience |
| POST completes after local deadline/readback | Ignore obsolete completion; no duplicate | launch-batch-resilience, launch-generation-hook |
| Stop during preflight / unknown admission | No queued submissions or automatic mutation replays; keep accepted work | launch-batch-admission, launch-batch-resilience |
| Actor replacement / permission revoked | Stop queued dispatch; original actor owns in-flight work | launch-batch-admission, launch-generation-hook |
| Long legitimate encode, no count change | Keep active; do not timeout native work or over-admit healthy work | launch-batch-resilience |
| Hidden tab, list endpoint down, lost Realtime | Same global cadence, bounded detail reads, ten jobs complete | launch-workspace-ui |
| Detail modal closes | Accepted coordinator continues | launch-generation-hook |
| Browser exit/reload | Unload warning; abort unaccepted late callbacks, retain durable drafts/receipts | launch-batch-resilience |
| Shared leader source disappears | Leader fails safely; surviving verified copy builds once | restitch-multi-variation-reuse |
| Shared leader canceled | Remaining nineteen consumers succeed | restitch-multi-variation-reuse |
| Waiting consumer canceled / cache eviction | Producer continues; independently materialized outputs survive | restitch-multi-variation-reuse |
| Source bytes/size/MIME change or authority lost | Refuse before provider I/O; no cached authorization bypass | restitch-native-source-authority |
| Catalog registered but publication reply lost | Restore exact registered child; no new catalog | launch-catalog-execution |
| Provider delete reply lost / permission retained | Read exact resource; retain uncertain/shared output | launch-recovery |
| Native network outage before vs after upload | Converge safe pre-upload failure; retain uncertain output fences | restitch-outage-converge |

## Semantics and limits

Reconciliation uses the existing ten-second workspace cadence, not per-card timers. At most two detail reads run concurrently and round-robin selection prevents a bad read from starving every other item. Each wait is bounded. Failed-generation retries are never automatic: only the same retained admission/save intent may replay after a successful protected read, spaced by exponential backoff from 30 seconds to a five-minute cap. Existing Google admission retries remain at most three within one dispatch. Transient preflight failures use the same recovery lane. There is no lifetime cutoff that would abandon a temporary outage.

After three unresolved failures an item parks, retaining its request identity while healthy siblings advance. It stays excluded from the finished count. A parked replay must synchronously reserve an active slot; fresh queued drafts have priority. Stop, lost edit authority and actor replacement prevent new automatic admission writes, including internal provider retry and late save continuations. Protected detail recovery may attach already authorized native work; it is not permission for a fresh generation. Confirmed cancellation awaiting cleanup uses the parked lane with explicit cleanup text and never replays admission. Parked jobs can still be running remotely, so releasing their scheduling slot is neither cancellation nor a global native/provider concurrency guarantee. Exact terminal receipts can complete them later.

No amount of UI retry makes a deleted source, revoked permission, disconnected native executor or indefinitely unavailable provider succeed. The guarantee is isolation, retained identity/results, bounded retries and honest diagnosis. The batch is still session-local: browser termination or navigation away stops unsubmitted scheduling. Native/hosted accepted work retains existing durable recovery. Browser suspension/OS sleep may delay timers until execution resumes. No new cross-browser durable scheduler is claimed.

## Review / validation

Three review/remediation passes completed before the final gate:

- Pass 1 reproduced lost-reply starvation, hidden-list observation gaps, terminal-parent/video mismatch and shared-input deletion propagation. Added real-hook ten-item and filesystem regressions before correcting each seam.
- Pass 2 checked stale/replacement receipts, delayed callbacks, stop/scope fencing, bounded read cancellation, diagnostic volume and narrow layouts. Added exact post-admission identity checks, monotonic observation, telemetry deduplication, read abort deadlines and wrapping outcome buttons. Three older hook fixtures were corrected to return an actual accepted generation after their successful POST; pre-acceptance empty reads remain tested.
- Pass 3 exercised five-minute outages, simultaneous parked re-admission, fully parked Stop, provider backoff and late saves. Added indefinite same-key recovery with capped frequency, synchronous slot reservation and an admission guard. The two Stop races and both pending-cancellation states were reproduced as failing real-hook tests before correction.
- Focused run: **11 files / 261 tests passed**; after the final cancellation fix, **3 files / 95 tests passed**, including **31 real-hook batch fault cases**, generation hook, workspace, native cache/source authority, provider retry, hosted recovery, diagnostic ingestion/read-only inspection and download budgets. Canonical verification below is authoritative for the final complete source.
- `npm run build`: web/shared/agent passed. Complete Launch download graph adds 1,100 B beyond the initial feature, documented bounded allocation and exact evidence in performance.md. No dependency changes.
- Real Chromium, synthetic local service responses with non-local network blocked: dark/light at 1280 and 390 px, reduced motion; all ten items settled as eight complete/two unconfirmed, no page errors, overflow or clipped buttons. Screenshots and machine report: resilience-{dark,light}-{1280,390}.png and resilience-browser.json. First visual pass found clipping; the final pass verified the correction.
- No database schema change in this follow-up. Prior isolated database acceptance remains recorded in validation.md. Live Google, packaged beta and physical Windows behavior are not represented by these synthetic fault tests.

Initial canonical run before the third review: **15/15 gates passed**, 11,115 tests total (11,020 passed / 95 prerequisite/platform skips), 1,755 seconds. Preserved verbatim in resilience-verification-initial.json. **Final canonical verification after all fixes: 15/15 gates passed**, 11,124 tests total (**11,029 passed / 95 explicit prerequisite/platform skips**), 1,988 seconds, zero failures. All eight shards completed. Exact machine results and skip reasons are in [resilience-verification-final.json](resilience-verification-final.json). Coverage was not measured by the fast form. No test was excluded to obtain this result.
