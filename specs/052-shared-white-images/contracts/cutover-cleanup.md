# Contract: T0, retired settings and30-day cleanup

## State and boundary

One environment record: prepared → draining → active → cleanup_due → cleanup_running → cleanup_complete, with child partial/unknown evidence. T0=activated_at from trusted server clock, immutable. delete_after=T0+30×24h. No per-user/team login timer, reset on deploy, rollback extension or automatic data rollback.

Before active: fence legacy deletion admissions and positively finish/reconcile already claimed purge/DELETE/CDN-purge leases; unknown deletion blocks T0. A new not_before cannot stop a worker already doing provider I/O. Then global pool/aliases/config proof ready, compatible hosted+installed build accepted, exact release evidence bound, legacy mutation admission closed, in-flight provider writes/import grants drained or positively reconciled. Unknown prevents T0. Bounded manifest is built/finalized while old admission is fenced; immutable digest proves all managed legacy targets. Activation CAS binds expected manifest/proof/release/config revisions and assigns T0 once. A failed/unknown activation is read-only reconciled before retry; never duplicate T0.

After T0: all new create/update output is global. Old unstarted checkpoints may replan once under the global epoch before side effects, preserving identity; started unknown writes must already have been reconciled before activation. Late worker/import commits fail epoch/fence. Returning an old web bundle never changes active policy.

## User-visible removal

Remove from workspace settings, Create/Launch setup, defaults/profile/bulk/undo and capability summaries: private image gallery/library/quota, imports/drop/picker/Drive source/fallback image URL/copy-prompt, source selection and refreshImages toggle. Preserve unrelated text/price fields, scheduling, video and restitch start/end images. Do not delete translation keys solely by `productCatalogImages` prefix: restitch reuses some.

`ProductCatalogSettingsSection`/`CatalogSummarySection` and `launches/preparation.ts` use global readiness, never private inventory. No new settings screen replaces the removed one. Existing Realtime/foreground revalidation invalidates old capability snapshots; no recurring browser polling.

Old client payloads containing retired image fields: stable retired/upgrade failure before any partial settings write. New clients send contract3 without obsolete fields. Compatible new text/price writes remain supported. Server denies private image reads/import/grants/pool remove/revoke for normal team callers after T0. Stale active bundle receives reload/upgrade barrier before settings/catalog work; offline bundle cannot be remotely altered, but must revalidate before network mutations or normal settings access when online.

## Every update moves to global

Manual, scheduled, retries, growth, non-video update and Launch child all use complete global image recipe even for legacy refreshImages=false. No customer source selection. Successful result requires actual full output/readback; unknown cannot mark catalog migrated. Failure keeps previous persisted result, but this does not extend its legacy image retention past delete_after. No background mass rewrite of paused catalogs is promised; owner-selected cleanup can make never-updated legacy URLs unavailable after grace.

## Retention manifest

Physical-delete targets are only proven Soty-owned old white-image R2 publications, key prefix v1/ and environment/bucket ownership match, not arbitrary URLs. Keep unique manifest identity, stable publication/charged-ledger identity (original owner is audit-only) and delete_after outside team/catalog cascade. Global g1 assets, aliases, videos, thumbnails/previews, restitch images and Drive/local originals excluded. Dedup physical legacy key once; if ownership/type uncertain, blocked/unknown target, never infer permission to delete.

Until delete_after, all retirement-target delete routes must respect hold, including existing before-team-delete, orphan sweeper, explicit legacy revoke and late worker callbacks. Previously issued grants must expire/drain before T0; no new staging/final write can escape the manifest. Retired private metadata is service-only for cleanup, never exposed as active settings.

## Due cleanup

At `now >= delete_after`, policy_retirement tombstones become eligible regardless of historical ready/use refs; do not label them orphan_candidate. Reuse existing claim/fence/deadline/semaphore and R2 `remove`: DELETE → origin readback → managed CDN purge → positive finish receipt. Keep object identity and unknown outcome across crash/retry. Claim ownership and ordered tombstone→publication lock are checked before finish; provider I/O outside locks.

One target/invocation, existing8attempts/15min backoff; exhausted outcome visible for operator recovery rather than endless loop or tombstone deletion. Quota credit once only after complete and not uncertain. Pending backlog beyond deadline is overdue, not false completion. Team deletion must preserve the30-day hold rather than default two-minute late-write hold.

For object_purge targets, after verified deletion clear old private pool/source/settings image values and references while retaining unrelated prices/texts. Tombstones and sanitized journals retained per031, direct personal associations removed when account/team is deleted. External original links get metadata-unlinked/external-untouched outcome; do not delete original files or alter provider permissions. Cannot prove destruction of downloaded/external cached copies.

## Release and rollback

This is runtime deletion of policy-owned data/objects, not schema DROP. Migrations additive; keep legacy columns/signatures harmless for history. `acceptedWorkspaceCutover` currently ratifies only the old1.3.0 cutover and must not be broadened by silently editing its acceptance. Future schema removal is a separate release with explicit evidence.

Full release with canonical beta/production gates and051 next→promote; Worker/source/config/target and readiness proof included. Neither deploy to next nor read-only planning activates T0. Only an explicitly authorized normal production workflow may prepare/publish/activate; these documents execute none. After T0 rollback preserves server fence/timer; after physical cleanup deleted bytes are not restored by old code.

## Read-only status and acceptance

Status: activated_at/delete_after, manifest target total, retained/due/pending/deleted/unknown/external_untouched, overdue backlog, remaining legacy catalog count (coverage-bound), last proven stage and normalized code. No raw object key/URL/private source in journal export.

Fake-clock T0±edge/day29/exact30days; concurrent team delete/late write, old API and mixed payloads, partial deletion, lost purge reply, restart/duplicate finish/quota credit, unchanged global/video/restitch/original files. Use isolated fixtures only; never backdate or run cleanup against customer data to test. Acceptance proves producer→receipt→sanitizer/projection→CLI, not just event emission.

## Metadata-only inventory and complete predicate

The T0 manifest also has typed metadata_unlink work items for old Drive/external-only settings/source/fallback refs with no R2 publication. At deadline they terminate metadata_unlinked + external_untouched, without provider DELETE, permission changes or waiting for a nonexistent delete receipt. Zero-object manifests still finalize these items. Cleanup_complete means ALL object targets verified_deleted AND all metadata targets metadata_unlinked AND no unknown/blocked-ownership receipt.

Quota credit follows the CURRENT authoritative charged ledger through existing purge_finish, not the original-owner snapshot. Test owner transfer during grace, transfer+team deletion and duplicate finish.

## Rollback compatibility prerequisite

Before T0 the archived previous promoted rollback build must already understand active global policy and hide retired controls. If absent, a separately validated compatibility-baseline release must land first; T0 stays blocked until evidence exists. Backend refusal cannot erase arbitrary cached UI. Current and prior accepted builds are both tested under active policy; older installed/offline bundles require upgrade/revalidation before managed work. No planning or test command performs that production release.
