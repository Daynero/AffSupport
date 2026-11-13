# Data model

Existing LaunchDraft, LaunchGeneration, LaunchRevision and owned native operations remain authoritative. New optional projection fields are additive and validated; absent progress/name is unknown.

LaunchSummary: createdAt + matching created cursor; optional generation object with confirmed parent state/stage/version and completed/total progress; video counts/state if present. hasResult remains distinct from generation state. Pending/partial video work prevents a blanket all-ready label.

LaunchDetail pendingCatalogName: optional validated string from this generation's durable name reservation, never guessed or used as a completed catalog URL.

Batch item: launch ID, selected version, request/flow ID, state queued/dispatching/accepted/completed/blocked/uncertain/stopped; bounded error code, latest generation identity. IDs are scoped to team and actor. Batch snapshot is immutable; admission rereads detail and requires exact selected version. Only proven never-generated drafts qualify. Concurrent click cannot allocate a second batch. Stop freezes queued items; accepted work uses existing cancellation/recovery in launch detail.

Prepared body ownership: cache target plus active-preparation pin; independently aborted waiters. Before releasing the pin, materialize a hard link/copy into each pipeline workspace. Its own directory entry survives eviction; the existing workspace finally removes it. Eviction excludes pinned cache targets and runs after materialization. Cache miss/failure cannot change authorization or produce success telemetry.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: A cache pin protects preparation until materialization. Each pipeline owns an immutable workspace entry through join/verification, independent of cache eviction. New pins wait for an already-started eviction; retries unlink their prior entry without overwriting a shared inode.
A3: Uncertain admission retains original hook and exact request identity; no fresh automatic retry or new batch admits that item. Queued snapshots use exact version CAS.
