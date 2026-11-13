# Data model

Existing LaunchDraft, LaunchGeneration, LaunchRevision and owned native operations remain authoritative. New optional projection fields are additive and validated; absent progress/name is unknown.

LaunchSummary: createdAt + matching created cursor; optional generation object with confirmed parent state/stage/version and completed/total progress; video counts/state if present. hasResult remains distinct from generation state. Pending/partial video work prevents a blanket all-ready label.

LaunchDetail pendingCatalogName: optional validated string from this generation's durable name reservation, never guessed or used as a completed catalog URL.

Durable batch: opaque UUID request key, actor/team scope, immutable selected launch IDs/versions and child request keys, creation/cancellation timestamps. Membership stores accepted generation ID, pending preparation/setup with independently paced retry/lease, or bounded definitive refusal code. Protected reads join canonical generation state/progress and source identity; no copied competing progress state. Request replay checks the immutable identity before source lookups. Cancel is idempotent and only targets unfinished accepted children.

Background enrollment: native-held ticket scoped actor/team/installation/endpoint with expiry and coalesced setup/confirmation; cloud challenge reuses the same ticket digest, never revokes an already-live same setup on replay. Existing registration and secure-store credentials remain authority. Setup eligibility distinguishes absent/user-off/expired-renewable from security retirement or denied membership.

Native video set scheduling: bounded next-observation time/claim order; native instance/epoch can change only after actor/delegation/installation checks and proven quiescence. Registered outputs remain immutable. Unknown upload never grants retry authority.

Attempt clock: generation ID plus attempt number and server start, scoped actor/launch. Pending browser requests cannot reset a confirmed attempt. Optional local timing is a fallback, never proof of historical duration.

Prepared body ownership: cache target plus active-preparation pin; independently aborted waiters. Before releasing the pin, materialize a hard link/copy into each pipeline workspace. Its own directory entry survives eviction; the existing workspace finally removes it. Eviction excludes pinned cache targets and runs after materialization. Cache miss/failure cannot change authorization or produce success telemetry.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: A cache pin protects preparation until materialization. Each pipeline owns an immutable workspace entry through join/verification, independent of cache eviction. New pins wait for an already-started eviction; retries unlink their prior entry without overwriting a shared inode.
A3 (owner durability revision): Uncertain admission reconciles the durable batch key and fixed child keys through protected readback; no fresh request identity or generation is created. Original selected versions remain immutable. Legacy config normalization occurs only inside the selected-version CAS acceptance transaction; any concurrent edit refuses that member.
