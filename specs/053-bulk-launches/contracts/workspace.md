# Workspace contracts

List RPC retains old date cursor for callers without the new `sort: created` filter. Created sort uses `created_at DESC, id DESC` and opaque `cursorCreatedAt` + ID. Server filters before pagination. Bounded progress projection never returns configuration, URLs or provider payloads. Existing assignment projection remains intact.

Batch submit takes team, UUID request key, selected {launchId, expectedVersion, childRequestKey} (1–100 unique rows), and optional explicit authorized installation identity. The authenticated Edge builds and validates plans; the browser cannot supply trusted preview/source payloads. Service acceptance checks actor access, CAS, normalization, plan freshness and delegation, persists one replayable receipt and isolated per-item accepted/pending/refused membership. Read/list/replay remain actor/team-authorized. Same key with different intent conflicts. Cancellation requests existing fenced generation cancellation and preserves completed outputs. An immediate worker wake is best effort; durable scheduled recovery is mandatory.

Protected batch projection supplies identity (offer/social/RK suffix), actual generation state/stage/counts and partial/cancellation results, not stale cached completion. Existing workspace Realtime/global reconciliation observes it after reload. Network loss retains the last confirmed projection and automatic reconnection, without manual Check status. The batch size/resource bounds remain enforced server-side.

Keyboard commands are active only on launch list with no modal, editable target or native text selection. A selects loaded visible IDs, C captures config-source IDs/versions in actor/team RAM, V duplicates through protected API, Delete opens retention confirmation, Escape clears, Shift selects a visible range. Successful bulk paste stays on list and selects created drafts.

Progressive result uses deterministic names as preview; reserved catalog name appears when observed, unavailable URL remains placeholder. Real result-visible telemetry is emitted only for committed revision DOM. Clipboard mark requires successful clipboard write and current value/scope.

Diagnostics: batch flow references opaque child launch/generation IDs through existing team launch events; coordinator acceptance is not completion. Cache timing/hit journal retains existing ingestion and inspect seams. Browser exit, lost signal, stale projection and absent reservation stay explicit blind spots.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: Preparation stays pinned until each consumer owns an immutable workspace hardlink or exclusive copy. The pipeline owns its file through join/verification. Eviction and new pins coordinate; a reused workspace entry is unlinked before materialization.
A3 (owner durability revision): Uncertain admission reconciles the durable batch key and fixed child keys through protected readback; no fresh request identity or generation is created. Original selected versions remain immutable. Legacy config normalization occurs only inside the selected-version CAS acceptance transaction; any concurrent edit refuses that member.

## Analysis pass 2 resolutions
B1: Source grouping is a locality hint only, never cache proof.
B2: Pending result is labeled preview; older committed revision remains separately accessible.
B3: Created sort is opt-in and date cursors retain legacy semantics for old clients.

## Canonical catalog rename (owner follow-up, T050)

- `drive-ops/catalogs/rename-context`: actor-authorized `{teamId, materialId}` returns `{teamId, materialId, currentName, materialVersion, impactVersion, boundNames, requiresAcknowledgement}`. Evidence covers all referencing immutable revisions/SUB bindings and exact or encoded saved URL name bindings, not just current draft config.
- `drive-ops/catalogs/rename`: stable `{teamId, materialId, requestKey, expectedActorId, newName, expectedMaterialVersion, impactVersion, acknowledgeBoundNames}`. Admission rechecks actor, material identity/version, name conflict, binding evidence and absence of in-progress launch/registration/mutation. Narrow explicit rename authority only; move/content/version guards remain.
- `drive-ops/catalogs/rename-status`: same opaque request key reconciles provider/DB receipt without blind repeated PATCH. Receipt `{teamId, materialId, requestKey, operationId, state: pending|confirmed|failed, currentName, errorCode}`; SOURCE_CHANGED is a conflict. Provider mutation uses conditional ETag; ambiguous applied reply or DB commit loss remains pending until readback proves result.
- Confirmed material name becomes canonical in results and manager. Additive `catalog.currentName` does not replace immutable `catalog.name` snapshot; historical generated URLs, SUB values and campaign names remain byte-for-byte. Legacy display overrides never impersonate canonical provider names.
- Prior confirmed names are append-only aliases, actor/team protected and searchable through existing material search and manager search. No silent alias truncation. Names/URLs never enter analytics.
- Shared UI captures scope/actor epoch, keeps an opaque pending request for re-entry, uses existing refresh owner, shows OK/Cancel only when server-proven bound names need acknowledgement and renders old bound names in small read-only text. Late replies cannot update another material or actor.

## Pending batch admission refinement

A transient per-child metadata/setup failure is persisted as `admission=pending` with its original immutable version/request key. Healthy siblings are accepted in the same batch transaction. Existing recovery claims bounded due pending rows with leases and exponential persisted retry (30s to 15min, no exhaustion cutoff). Source changes/deletion or permission loss settle only that child. A whole infrastructure outage before commit cannot be acknowledged as accepted. No provider write precedes durable acceptance.

Rename absence reconciliation: a protected status call may insert a metadata-only tombstone under the same actor/team/request-key admission lock when the command was never accepted. This returns terminal failed NOT_FOUND with no operation; a late original POST for that key is fenced. No provider write occurs during status. This avoids an indefinitely pending local outbox after a pre-admission transport loss.
