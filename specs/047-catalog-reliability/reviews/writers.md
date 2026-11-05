# Catalog entry points, writers and state owners

## Current journeys

| Entry point                               | API / authoritative execution                                                                                         | Native/provider result                                                                                                                          | UI / diagnosis                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explorer/search/task/updater file actions | MaterialActionHost → api/team.ts → drive-transfer grant/range or library-ops share                                    | Live ancestry/capability checks; bounded native-Sheet XLSX export pinned to source version; optional native download; Drive permission readback | Shared action host, stable URL; share/file-attempt producers, browser_handoff versus agent_saved; inspect/journal and remaining full-surface acceptance |
| Standalone create/settings                | product-catalog/catalog-orchestration.ts → process start/finalize → drive-ops/catalog-durable.ts + product-catalog.ts | Existing team operations, restitch delegate/cache, registered material and catalog intent                                                       | Creation progress/settings; catalog-generation diagnosis and operation IDs                                                                              |
| Launch generation/retry                   | launches/restitch-runner.ts → launch prepare/bind/settle → drive-ops/launch-catalog.ts                                | Immutable generation config; existing restitch receipt/reuse and catalog intent                                                                 | Launch result hooks; launch/canonical operation diagnosis                                                                                               |
| Scheduled/manual updater                  | catalog-updater worker + profile/attempt RPCs → updater-restitch.ts claims → common Drive writer                      | Spare/in-use restitch singleton, native process/recovery; metadata readback currently differs from actual-cell proof                            | Catalog registry/history; catalog CLI, native terminal joined to inspect                                                                                |
| Native background recovery                | recovery-worker.ts → team-recovery claim/execute → updater-restitch.ts                                                | Protected execution credential/lease, native journal and output/finalize fences                                                                 | Browser-independent preparation; explicit journal source and missing delivery                                                                           |
| Bulk settings                             | CatalogBulkEditor → profile patch CAS + bounded readCatalogSnapshot                                                   | Profile version/field readback; unknown result rechecks without another mutation                                                                | Per-item results, immutable draft baseline, typed calendar tuple; catalog UI flow                                                                       |
| Bulk trash                                | CatalogUpdaterDialog → existing WorkspaceOperationsProvider bulkTrash owner                                           | Existing hosted batch/item receipts and operation keys                                                                                          | Shared BulkTrashPanel; only confirmed rows removed from selection                                                                                       |

## Current ownership and invariants

- useScopedRefresh owns catalog/updater visible snapshots and existing Realtime-driven
  invalidation. CatalogStatusDetails owns one bounded history reader; hidden/unmounted
  reads abort. No second recurring workspace receipt subscription was introduced.
- useCatalogInlineChanges owns row/detail drafts and CAS/undo. Bulk preserves its draft's
  expected versions and uses the shared saveCatalogProfile controller and bounded
  authoritative read primitive. Unknown results are read-only rechecks. Manager and
  history state are keyed by private actor/access epoch and catalog identity; late
  old-scope command results and analytics are suppressed.
- WorkspaceOperationsProvider owns bulk-trash receipts/retries. Catalog manager consumes
  that owner instead of introducing another receipt reader. The standalone fallback
  retains exact keys, refreshes after partial failure, and does not claim unconfirmed trash.
- TeamScreenCache owns bounded local rejection persistence. Web/Launch draw checks exact
  candidate checksum; updater/browser and native recovery claims forward scoped history
  to authorized server draws. Another machine's unknown history is not fabricated.
- catalog-durable/Launch/updater must preserve their current operation/intent IDs after
  an unknown outcome. Native terminal proves execution, not provider registration or
  visible browser delivery.

## Planned writers not yet implemented

N-variant aggregates are children of current intents/update attempts, with distinct
indexed child operations and stable internal recipe-row identity. They must not reuse
catalog variant or singleton spare cardinality. Delayed publication will use a single
catalog-wide reservation shared by every writer above, with source/video-set targets,
separate active/pending assignments and verified-only pointer swap. All planned writers
must pass exact provider conditional-content-write acceptance before replacing data.
The data model and contracts describe these obligations; this map does not claim that
those new entities/jobs, provider proof or UI controls already exist.

## Reviewed follow-up boundaries

- Stop on a modern snapshot uses `cancel_team_catalog_update_attempt`: it locks the
  observed round, rejects replacement attempts and reconciliation holds, and retains
  the existing active provider-worker lease refusal. A new-route error never falls
  back to an unfenced legacy cancellation. Schedule off is separate.
- The atomic manager snapshot carries a statement observation time. Settings versions
  and runtime observations merge independently; an older same-version response or
  acknowledgement cannot replace newer confirmed state. Missing legacy timing is unknown.
- Screen downloads use a 50 MiB consumer ceiling before provider body reads and at most
  two transient retries. The shared video intake ceiling is unchanged. Closed network,
  permission, expiry and disk causes do not poison image refusal memory. Central refusal
  memory, durable shared selection budgets and automatic same-click redraw in every
  executor remain open.
- Real provider export/public-link fixtures passed. Conditional content replacement
  failed actual-cell readback despite HTTP 412; `provider-acceptance.md` retains the
  evidence. New variation/publication writer semantics await the owner's choice.
