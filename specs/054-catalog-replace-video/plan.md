# Plan: replace only a catalog's video

Branch: `work/next-release-improvements`. No release/deploy or production data work.
Release integration refreshed to `895fa7f7` (automatic catalog content and migration-owned
analytics reader); both diagnostic inspection paths are retained.

## Decision and analysis pass 1

Reuse the existing source-target publication job and its bounded native Sheets video-cell writer.
Do not call rebuildCatalogRows, product-catalog creation, ID generation, or the normal updater.
Keep the old catalog/video association until the new job's cells and requested placement are
verified; then commit the new association once. R2 continues through the existing link resolver.

A protected replacement request records the immutable old/new identities, placement option,
publication job and move dispatch/readback. Existing catalog/material rows serialize acceptance.
A pending request freezes the catalog updater item through its existing reconciliation gate,
and guards incompatible catalog profile, publication and material mutations. A job with unknown
provider outcome retains the fence. Recovery uses the existing worker and read-only status;
never replay an uncertain write or clear a lock by age alone.

Preflight refuses an active/unresolved updater, publication, launch mutation, video variation or
leased restitch. It does not cancel those operations. First version requires a verified immediate
publication baseline and one Drive connection; unsupported legacy/held/future-scheduled or
cross-connection transitions are explained before acceptance. Existing per-catalog options stay
unchanged. A queued restitch may resume against the new source after confirmation, but a spare
or unresolved variant cannot be silently reused. Both original source files remain untouched.

## Analysis pass 2

- Existing targeted publication writes only video cells, preserving all nonvideo values and IDs.
- Binding the new source before publication is unsafe: retain old binding until verified delivery.
- Moving a companion through the generic group mover would move the video too: use a conditional
  metadata-only move for the catalog document, after publication, under a persisted exact ETag.
- A lost move reply is read back; no blind retry. New requests remain blocked until settlement.
- Source publication identity is content-bound, not just a reusable Drive version string.
- Freeze pending new-target publications/R2 republishing and material cleanup/rename/trash races.
- Revalidate new source, current policy target, verified cells and parent immediately before commit.
- New private references require task-cleanup coverage and privacy-safe diagnostic projection.

## Delivery slices

1. Shared validated request/context/receipt contracts, SQL admission/fences/readback and regression.
2. Existing publication-lane integration plus conditional placement/recovery; provider fixture tests.
3. Lazy Change video dialog in the actual per-catalog settings (the old CatalogProfileEditor is
   unused), current/new selection, default move and clear pending/status/retry behavior.
4. Typed content-free diagnostics, SELECT-only inspect/investigate evidence and privacy tests.
5. Two review/fix passes, focused regressions, browser desktop/mobile, full verify; report any
   release-only infrastructure or provider acceptance limitation honestly.

## References

Google documents metadata-only parent changes through addParents/removeParents:
https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update
The existing canonical rename adapter already uses the Drive v2 strong-ETag/If-Match seam;
reuse the same source of conditional authority for placement, without renaming.

## Review and acceptance evidence

Review pass 1 added absence tombstones for delayed submissions, source/ancestor mutation
fences, original-actor reauthorization and exact-ETag move recovery. Review pass 2 added
direct catalog-data and updater-round fences, final source/placement rereads, receipt
scope checks and a fresh dialog after a completed replacement. No normal updater or
catalog regeneration is called.

The final adversarial pass prevents a Realtime-triggered status check from sealing
an absent command while its submit is still in flight. Move dispatch and blocked
recovery always advance the diagnostic observation timestamp; otherwise as-of reads
could backdate a later move/failure. Focused regressions cover both cases.
An identity appearing from another tab is checked rather than assigned to a new draft;
fresh acquisition refuses an existing identity. A sealed absent submission ends its
diagnostic attempt and offers a deliberate retry under a new identity.
The status route verifies a real catalog in the requested team before sealing an
absence; a composite material/team foreign key also prevents foreign-workspace
references. A regression first reproduced the missing scope check, then passed
for both a foreign catalog and an unrelated file after the fix.

Local provider fixtures use the real targeted cell writer and prove unchanged IDs and
nonvideo columns, placement enabled/disabled, a lost move reply without a second move,
changed video cells, and changed source content after placement. Real PostgreSQL tests
exercise concurrent command acceptance and an absence check on independent connections.
Producer/SQL privacy guard/stored-event/SELECT-only CLI tests distinguish server confirmation
from visible UI completion and retain an unknown historical as-of result.

An isolated Chrome harness with the actual picker/controls verified selection, accepted
state and confirmed result at 1280px and 390px. Both document and dialog scroll widths
equal their viewport/client widths, including a long video filename. The harness blocks
external requests and is removed after checking. This is synthetic browser/provider
acceptance, not proof of a live Google write or packaged beta qualification.

First-version admission also refuses a retained spare or uncanceled variant request,
even if its output is ready; those must settle through their normal controls first.
It does not silently retire or delete old media. Live provider/beta acceptance and any
production migration/deployment remain separate release gates.

The final reconciliation review replaced manual status checks with the existing visible
serial read coordinator, a bounded catch-up burst, registry heartbeat revisions and
focus/online/storage invalidation. Lost submission replies, a revision while the write is
locked, transient read errors and another tab's request settle automatically without write
replay. Scoped mutation epochs reject late reads. Publication SOURCE_CHANGED reasons remain
SOURCE_CHANGED through the replacement receipt, including manual row-ID edits.
