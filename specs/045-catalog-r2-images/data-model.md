# Data model — каталогові картинки R2

Статус: запропонована схема, не застосована міграція. Назви та поля — контракт для реалізації. Public-schema tables мають RLS + FORCE RLS, deny-by-default writes, narrow grants; private-schema storage недоступний browser. Усі tenant-bound FK — composite із team_id або еквівалентна перевірена умова, не лише UUID.

## 1. Import job — `public.team_catalog_image_imports`

- `id`, `team_id`, `actor_id` nullable після видалення акаунта, `source_kind: local|drive`, `contract_version:2`.
- `intent_key`, `request_digest` (операційний, private; у public projection не експортується); unique `(team_id,actor_scope,intent_key)` із збереженим стабільним actor_scope після anonymization. Повтор ключа з іншим payload → `IDEMPOTENCY_CONFLICT`.
- `state: collecting|enumerating|sealed|running|completed|partial|failed|cancelled|expired|awaiting_reconciliation`; timestamps created/last_user_activity/sealed/terminal, source_deadline.
- `enumeration_cursor` private, `enumeration_complete`, exact admitted/excluded/ready/reused/unclassified/failed counts, `has_more_sources`. Публічний snapshot не містить provider cursor, names, URLs або grants.
- `reserved_bytes`, `reserved_entries`; unique reservation ledger entries дають exactly-once release.
- `cancel_requested_at`, `authorization_epoch`, current capability version.

Local: collecting → sealed після перевірених manifest pages та явного seal. Drive: enumerating → sealed лише після завершення поточного bounded source snapshot; обмеження >1000 файлів/5GB повертає continuation та явний partial scope, а не вдавану повноту. Знімок не називається історично атомарним Drive snapshot: додавання файлів під час enumeration може потребувати наступного запуску.

Terminal derivation: усі admitted entries ready/reused → completed, включно з unclassified; змішані successes/failures → partial; немає successes і є failures → failed; cancel → cancelled із збереженими already-ready counts. Відсутність локальних bytes → waiting/reselection, не вигаданий completion.

Collecting або waiting-source без user activity 24h: manifest seal/bytes admission заборонено після CAS expiry; unfinished waiting entries expired, reservation release exactly once. Already delivered/staged entries зберігаються й допрацьовуються, ready не видаляються; з ready результатами job partial, без них expired. Read/heartbeat не подовжують source deadline. Write-unknown переходить в awaiting_reconciliation, не в expired failure; не займає active-upload slot, але лишає exposure accounting. Authorized paginated list/current jobs дає discovery після reload без збереженого job ID.

## 2. Import entry — `private.catalog_image_import_entries`

- `id`, composite `job_id/team_id`, `ordinal` unique в job, `manifest_page_key` і request digest для idempotent pages.
- `source`: `{kind:local, client_file_key}` або `{kind:drive, material_id?, credential_id, drive_file_id, root_id, frozen_version, frozen_md5?}`. Лише сервер розв'язує Drive identity; source URL у request заборонений. Source metadata перевіряється до/після читання; зміна byte version → `IMAGE_SOURCE_CHANGED`.
- `display_name` — tenant-authorized operational UI metadata з bounded length 255; не telemetry. Для classification зберігається snapshot назви на момент запуску, без повторного довільного тлумачення на retry.
- `classification`: `{mode:matched, garment, color, vocabulary_version}` або `{mode:unclassified, reason:missing|unknown|ambiguous, garment:null,color:null}`. Exact canonical token boundaries; два recognized garments/colors → ambiguous, не first-match. Unknown tokens самі по собі не відхиляють bytes.
- `declared_size`, `actual_size`, `mime`, `width`, `height`, `orientation`, server-only SHA-256; declared values не є доказами.
- `stage: waiting_source|staged|validating|deduplicating|publishing|verifying_origin|verifying_public|committing|ready|reused|failed|cancelled|expired|awaiting_reconciliation`.
- `lease_owner`, monotonically increasing `fence`, `lease_until`, `heartbeat_at`, `attempt_no<=3`, `next_attempt_at`, stable `error_code?`.
- `staging_key`, grant-issued/expires timestamps, generation, `candidate_publication_id`, operation evidence references — private only.

Немає одночасних live leases для entry. Claim/update/commit вимагають current fence+lease+job authorization epoch. Cancel/permission revoke підвищує epoch; stale worker не завершує DB commit. READY та REUSED ідентичні для draw, але різні для cost/reuse metrics.

## 3. Publication — `private.catalog_image_publications`

- `id`, `team_id`, random `public_object_key`, deployment-owned media origin identifier, immutable byte hash/size/MIME/dimensions, created/verified times.
- `state: candidate|put_unknown|origin_verified|public_verified|ready|purging|revoking|revoked|purge_unknown`; revision/CAS, owning entry/intent і окремий publication fence поряд із entry lease fence.
- Active dedup uniqueness `(team_id, sha256, size)` під advisory lock/unique reservation; hash не передається браузеру/analytics. Після explicit revoke нова публікація тих самих bytes має нову ідентичність, не оживляє старий URL.
- `source_material_id` optional `ON DELETE SET NULL`, uploader actor optional/anonymizable; tenant власник — team. Немає source cascade для final object retention.
- Classification immutable per publication mapping. Same bytes + same class → reuse; same bytes + conflicting class/mode → `IMAGE_CLASSIFICATION_CONFLICT`, без silent overwrite чи другого logical ready object. Людина може виправити ім'я/вилучити конфлікт до нового запуску; автоматичного remap виданих використань немає.
- Retention proof: issued-use counter/references, active pool membership, active worker/candidate ownership; остання невідома side effect не очищується за негативним HEAD.

Public URL утворюється з довіреного media domain і opaque key. Ключ не включає team/user/source names або digest. Final PUT — conditional create-only; browser не має write grant до public bucket. Verification publishes саме серверний перевірений buffer. Upload/publish не є доказом dictionary readiness.

### Shared exclusion protocol

Reserve/dedup/adopt/reuse/ready commit/use-reservation беруть `FOR UPDATE` на publication row та перевіряють чинний publication fence/state, team epoch і lease; ready transition та membership/use створюються під цим lock. Cleanup бере той самий lock, атомарно перевіряє відсутність active owner/lease/membership/use/pending commit/unknown write і CAS переводить eligible candidate у purging з новою fence. Після commit cleanup transaction adopters не можуть взяти цю identity; якщо adoption переміг раніше, cleanup відмовляється. External DELETE лише після fenced cleanup claim. Source hash unique reservation також посилається на locked publication, тому concurrent import не обходить протокол.

Explicit revoke/team-delete може видаляти used publication тільки з окремим авторизованим reason, переводить її у revoking і забороняє нові use commits тим самим lock/fence. Stale зовнішній PUT може завершитися після DB fence — його не adopt-ять; purge tombstone зберігає late-write reconciliation. Negative GET не робить такий pending write eligible orphan.

## 4. Pool membership — `public.team_catalog_image_pool_entries`

- `id`, composite `team_id/publication_id`, `active`, `added_at`, `removed_at`, `classification_mode`, safe garment/color, dictionary revision.
- Public authorized projections містять ready URL та class facts; приватні hashes/staging keys не grant-яться клієнту. RLS: current `view` для читання; manage_metadata RPC для зміни active; service-only ready transition.
- Pool removal тільки `active=false`; publication/issued uses залишаються. Відсутність source material не блокує вже ready copy.
- `(team_id,publication_id)` unique. Quota storage рахує retained ready publications, а не лише active memberships; повторне додавання не подвоює обсяг.

Draw v2 охоплює всі active ready memberships без віддання переваги matched. Per-team lock і безповторний shuffle round зберігаються. Новий history namespace `image_v2` використовує pool entry IDs; v1 image history не переосмислюється. Якщо пул менший за row count, наступний round повторює з новим shuffle. Retry одного catalog attempt використовує frozen selection, а не новий draw.

## 5. Issued uses — `private.catalog_image_uses`

- `team_id`, `publication_id`, `catalog_id`, `catalog_attempt_id`, `row_identity`, `catalog_revision`, `state:reserved|committed|superseded|unknown`.
- Idempotent key `(catalog_attempt_id,row_identity,publication_id)`; committed тільки після authoritative catalog readback. Reservation створюється до зовнішнього запису каталогу та захищає bytes при lost reply.
- Catalog/source row deletion не прибирає historical use proof. Заміна/видалення фіда не доводить, що URL ніхто не використає: жодного automatic final media GC за цим сигналом.
- Операційні receipts мають окрему retention від очищеної 30-day telemetry; team deletion замінює потрібні cleanup identities неприватними tombstones.

## 6. Cleanup — `private.catalog_image_purges`

- `id`, opaque scope reference, bucket/key, reason `expired_staging|orphan_candidate|explicit_revoke|team_deleted`, state `pending|deleting|origin_absent_observed|cache_purging|complete|unknown`, attempts/next_at, grant expiry, lease/fence evidence.
- Немає cascading FK до team/user/job: tombstone створюється до cascade і переживає її. Private key list не потрапляє в telemetry.
- Cleanup registry зберігає unknown writes і повторює перевірку late arrivals; ранній negative read не доводить відсутність in-flight PUT. Private staging lifecycle 1 day — додаткова страховка. Complete для explicit revoke містить origin deletion receipt + керований cache purge receipt; зовнішні кеші залишаються unknown.
- Ready used objects ніколи не видаляються звичайним staging/orphan cleanup. Permission revoke/cancel до commit створює tombstone для uncommitted candidate, а не залишає некерований public orphan.

## 7. Team rollout and permissions

- Server-owned `catalog_image_mode: legacy|v2`, `catalog_image_import_enabled`, quota configuration і revision. Звичайний random режим не є окремим rollout mode чи user toggle.
- manage_metadata + explicit publish action потрібні для local; для Drive також download capability, current root/live ancestry і дозволена політика копіювання/поширення. `canAddChildren` не потрібний, бо файл у Drive не створюється.
- Owner deletion зберігає існуючу вимогу transfer; uploader/member deletion revoke pending jobs/grants authority та anonymize actor, не знищує командні ready copies.
- `delete_draft_team` перевіряє R2 jobs/publications до cascade або атомарно створює purge tombstones; відсутність Drive connection більше не доказ відсутності медіа.

## 8. Transport projection

`CatalogImageV2` — discriminated union:

- `legacy_drive`: materialId, driveFileId, resourceKey, name; тільки для explicit legacy/in-flight compatibility.
- `r2`: publicationId, poolEntryId, publicUrl, `{mode:matched,garment,color}` або `{mode:unclassified,garment:null,color:null}`, immutable revision.

R2 UUID не підставляється у `driveFileId`. Нові rows/checkpoints зберігають projection version=2. Старі checkpoints без version parse-яться лише як legacy при валідній старій формі; malformed/unknown version — explicit rejection. Classification факти не відновлюються з URL.

## 9. Operational evidence

Private sanitized journal — append-only operation/attempt/stage/terminal/evidence refs, classification mode, bounded size/time buckets. Мінімальні projections для SELECT-only analytics role виключають display names, hashes, URLs, tokens та provider payloads. Material/source identities дозволені лише у вузькому tenant operational API, не у публічному diagnostic export. Telemetry detail 30 days, aggregates 90 days; missing/expired evidence — явна coverage gap.

### Expiry terminal and counters

`expired` є явним entry terminal із reason `local_source_deadline` або `manifest_deadline`, не provider failure. Public counts містять окремий expired; completed вимагає всі admitted ready/reused, partial — successes разом із failed/expired/cancelled entries, expired job — жодного success і лише source-deadline terminals. Коли є реальні provider failures без successes, job failed, а expired counts лишаються окремими. Awaiting-reconciliation не стає terminal absent/failed за negative HEAD.
