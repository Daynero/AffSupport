# Workspace contracts

List RPC retains old date cursor for callers without the new `sort: created` filter. Created sort uses `created_at DESC, id DESC` and opaque `cursorCreatedAt` + ID. Server filters before pagination. Bounded progress projection never returns configuration, URLs or provider payloads. Existing assignment projection remains intact.

Batch accepts selected ID/version snapshots only; preflight reads protected detail, rejects activeRevision or any generation, parses complete config and confirms source snapshot. Existing generate hook owns save/admission idempotency and native preparation. At most two coordinators dispatch concurrently; source grouping is scheduling only, never proof for cache reuse. Errors do not erase successful siblings. Unknown outcomes retain the mounted item's original hook/keys until explicit reconciliation or opening authoritative detail. Stop/scope loss prevents new dispatch.

Keyboard commands are active only on launch list with no modal, editable target or native text selection. A selects loaded visible IDs, C captures config-source IDs/versions in actor/team RAM, V duplicates through protected API, Delete opens retention confirmation, Escape clears, Shift selects a visible range. Successful bulk paste stays on list and selects created drafts.

Progressive result uses deterministic names as preview; reserved catalog name appears when observed, unavailable URL remains placeholder. Real result-visible telemetry is emitted only for committed revision DOM. Clipboard mark requires successful clipboard write and current value/scope.

Diagnostics: batch flow references opaque child launch/generation IDs through existing team launch events; coordinator acceptance is not completion. Cache timing/hit journal retains existing ingestion and inspect seams. Browser exit, lost signal, stale projection and absent reservation stay explicit blind spots.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: Preparation stays pinned until each consumer owns an immutable workspace hardlink or exclusive copy. The pipeline owns its file through join/verification. Eviction and new pins coordinate; a reused workspace entry is unlinked before materialization.
A3: Uncertain admission retains original hook and exact request identity; no fresh automatic retry or new batch admits that item. Queued snapshots use exact version CAS.

## Analysis pass 2 resolutions
B1: Source grouping is a locality hint only, never cache proof.
B2: Pending result is labeled preview; older committed revision remains separately accessible.
B3: Created sort is opt-in and date cursors retain legacy semantics for old clients.
