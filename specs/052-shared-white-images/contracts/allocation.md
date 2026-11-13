# Contract: global readiness, allocation and confirmation

**Version**: catalogImageContractVersion3, additive to retained v2 history. ВідT0 legacy client mutations повертають upgrade/retired до side effects. Власного джерела або refreshImages у новому user payload немає. Для локальних tools/restitch не змінювати contracts без необхідності.

## Public authenticated surface

Нова Edge function `catalog-global-images` використовує чинні CORS/JWT/error envelope seams. GET `/readiness` — authenticated actor, current membership за потреби; повертає policy epoch/state, usable boolean, reason і observed_at, без чужих матеріалів/персональних даних. Це internal readiness для Create/Launch, не налаштування користувача. Застарілий read не доводить готовність; trusted allocate повторно перевіряє policy/proof.

POST `/operator/imports`, `/operator/imports/:id/{manifest,seal,cancel,retry}` — лише real JWT+platform operator grant. Team owner права недостатні. Local files спочатку private staging за045; server byte validation/canonical publication/anonymous proof. Bounded manifests≤1000files/5GB, page≤100; grant limits і one-heavy-per-isolate з045. Operator tool має ідемпотентний intent і явний environment/target confirmation; не використовує analytics credentials. POST `/worker` — тільки existing named-worker secret, не user-JWT fallback. Імпорт не вмикає T0 автоматично.

## Service-only RPCs

| RPC                                         | Input                                                                                                                                                       | Output and guarantees                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| service_catalog_global_allocate             | actor/team ACL context; durable catalog_identity; operation_intent; attempt/fence; epoch; scope=create/refresh/growth; count1..400; permitted pairing facts | entire frozen recipe, indirect assignment/alias IDs, public URLs and facts; one transaction; exact replay; no customer filenames |
| service_catalog_global_confirm              | catalog_identity; frozen recipe ref; trusted provider completion/readback receipt                                                                           | first confirmed pair deltas exactly once; total/alias counters decimal strings; idempotent replay                                |
| service_catalog_global_reconcile            | existing intent/receipt ref and current fence                                                                                                               | proven committed/aborted/unknown, never duplicate provider write; own unknown recipe kept                                        |
| service_catalog_global_prepare_claim/finish | environment; worker revision; proof config; bounded claim/fence                                                                                             | current+2 aliases and content proof; expired lease does not permit late finish                                                   |

No direct browser RPC grant to these service functions. Edge verifies actor JWT; RPC revalidates team permissions/current operation authority. Allocate does not hold a lock across provider access. Completion adds confirmation to the canonical operation transaction; failure after actual output is accounting_pending/unknown with recovery, not justification to make another catalog.

## Stable identities and replay

Create establishes one durable catalog_identity before resource draw. Launch uses the persisted child intent from `freeze_launch_catalog_resources`, and registration binds that identity to the actual catalog/material. Updater uses the same identity across rounds. Unique pair(catalog_identity,image_id), unique(image_id,issued_slot), one recipe(intent,scope); count rows do not equal issued slots.

Repeated image in200 rows consumes one slot for that catalog. Existing pair always returns its previous alias even if that series is full. New pair increments issued_seq once and maps generation=floor((slot-1)/200)+1. Already durable failure/cancel slots never recycle; confirmed_total changes only after trusted proof. Thus issued may exceed confirmed, and5000 never caps selection.

Allocation starts from ready/suitable candidate metadata, randomly samples within bounded limits, takes short locks in image UUID order with SKIP LOCKED and ignores busy/not-ready candidates before recipe commit. No global draw lock, no sleep/poll or waiting for another catalog’s provider result. On insufficient distinct choices repeats of suitable images allowed; if no suitable ready full recipe can be formed, whole transaction rolls back and returns a closed refusal. It cannot partly freeze a different count.

## Fast path and readiness

- One allocate/freeze RPC for1..400 rows; one existing completion RPC extended with batch confirmation. No GET/RPC per row, no R2 bytes read, URL generation/upload or repair in create/update.
- Current+2 aliases are ready ahead. Asset content proof matches immutable image/config/environment and expires24h; alias identity proof is immutable and has no daily per-aliasTTL; serving-health≤120s. Probes every≤60s; all expired/missing proofs explicit. Already issued URLs keep serving even after proof expires.
- Candidate scan≤min(2000,max(4×count,256)); one additional bounded sample inside same1s deadline allowed, no wait between samples. Transaction all-or-nothing, lock_timeout50ms, statement_timeout750ms; caller timeout1s.
- Caller timeout after send is allocation_unknown. Check existing intent status read-only; do not allocate a new intent. Concurrent identical intent busy returns pending receipt promptly.
- Warm batch p95≤250ms and e2e overhead p95≤1s are acceptance goals; server outage/cold start remains reported separately. There is no claim of literal zero network latency.

## All producers after T0

Create standalone, Launch child, durable recovery, manual/scheduled updater, growth and non-video updates all use the same allocator/epoch validation and output validator. No private draw fallback, settings.imageLink fallback or branch bypassing `refreshImages=false`.

Every successful refresh updates the complete image set from global pool. Existing shared pairs may recur and preserve their aliases. With refreshTexts=false, choose compatible factual pairs; impossible mapping produces IMAGE_TEXT_PAIRING_CONFLICT before provider write, rather than inventing facts or keeping a private image. Growth handles existing+new rows under the same rule.

An unknown pre-T0 provider write blocks activation until reconciled/drained, not post-T0 global allocation. An unstarted legacy checkpoint may be rebuilt under new epoch before any provider write, preserving durable catalog identity; started unknown checkpoints never blindly replan.

## Closed reasons

New shared closed codes: `GLOBAL_IMAGE_POOL_UNAVAILABLE`, `GLOBAL_IMAGE_READINESS_UNKNOWN`, `GLOBAL_IMAGE_ALLOCATION_UNKNOWN`, `GLOBAL_IMAGE_SETTINGS_RETIRED`, `GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED`, `GLOBAL_IMAGE_POLICY_CONFLICT`, `GLOBAL_IMAGE_CLEANUP_UNKNOWN`. Reuse existing pairing/permission/format reasons where semantics match. New codes go through shared types/transport, Edge and web error maps, locales, fingerprints and code-map tests. Busy/insufficient ready allocation is fast unavailable with bounded retryability;5000 is an informational status, never an error.

## Reviewed invariants

Old pair after24h/several rotations inherits fresh asset proof and compatible serving-health/route/key versions; no per-alias re-fetch, no URL change. Current+2 is new-series preparation only. Compatibility proof includes old issued token generations after config changes.

Sample required indexed garment/color buckets with random cyclic starts. Prefer distinct unlocked candidates actually checked. An exhausted bounded scan is temporary pool unavailable, never proof of IMAGE_TEXT_PAIRING_CONFLICT; conflict requires authoritative zero/incompatible facts. Recheck existing assignment after image lock and BEFORE issued_seq increment, so different intents for one pair burn only one slot. Test rare matching pair outside first sample, old-pair reuse and exact issued delta.
