# Data model: global images052

**Status**: proposed additive model; нічого не мігровано. Імена нижче є цільовими для implementation, guards/DDL мають однакові unions/limits. Усі таблиці private, RLS enabled/revoke all; mutations лише service RPC з actor/policy validation і empty search_path. Analytics — окремі allowlisted SELECT-only projections.

## Entities

| Entity                      | Keys and fields                                                                                                                                                                        | Invariants                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| catalog_global_policy       | environment PK; epoch; state; activated_at; delete_after; readiness_revision; source/config evidence refs                                                                              | T0 незмінний після active; deadline=T0+30days; never tenant-selected                                                                  |
| catalog_global_images       | UUID PK; environment; immutable g1 key/hash/MIME/facts; state; content_proof_revision/expires_at; issued_seq; confirmed_uses; observed_since                                           | scoped hash unique; no team FK; bigint counters>=0; content proof24h; no5000cap                                                       |
| catalog_global_aliases      | PK(image_id,generation); token/URL; key_version; identity_proof_revision; verified_at; state; confirmed_uses                                                                           | immutable mapping proof has no24hTTL; eligibility inherits fresh asset proof + compatible serving/key revision; URL never expires     |
| catalog_global_identities   | identity UUID PK; creation intent unique; material/catalog reference optional; environment; live actor/team association                                                                | allocated before draw/Launch freeze; register binds same identity, never creates another                                              |
| catalog_global_assignments  | PK(catalog_identity,image_id); issued_slot; generation; alias reference; issued_at; state; committed_at optional                                                                       | unique(image_id,issued_slot); generation=floor((slot-1)/200)+1; immutable URL; failure never decrements issued_seq                    |
| catalog_global_recipes      | PK(operation_intent,scope); catalog_identity; policy_epoch; attempt fence; bounded row→image/assignment recipe; status/provider proof ref                                              | up to400 rows; same-intent replay exact; no hidden replacement after freeze                                                           |
| catalog_global_use_receipts | pair key unique; trusted completion receipt; occurred_at; outcome; independent sanitized evidence seq                                                                                  | first proven inclusion increments image+alias confirmed exactly once in completion transaction                                        |
| catalog_global_jobs         | job UUID; operator; kind import/alias_prepare/probe; bounded cursor; claim/fence; attempts; last_code                                                                                  | max1000source files/5GB import; current+2 target;≤8global heavy claims,1/isolate                                                      |
| catalog_image_retirements   | retirement UUID; kind object_purge/metadata_unlink; epoch/deadline; managed publication/key/bucket only for object kind; metadata refs; stable charged-ledger identity; state/receipts | no team cascade; only managed legacy keys physically deleted; metadata-only targets need no DELETE receipt; original owner audit-only |
| catalog_global_journal      | immutable seq; flow/operation/attempt IDs; indirect subject/image/alias IDs; stage; code; occurred_at; received_at; counts/buckets                                                     | no URL/path/content/secret/provider payload;031retention; critical stages unsampled                                                   |

Реалізація може об’єднати облік confirmations з assignments за збереження pair uniqueness та immutable journal; точні таблиці/проєкції мають узгоджуватися з цим контрактом і tasks. Не читати current counters як historical as-of.

## Classification and selection

Канонічні garment/color tokens та parser з045. Matched image має фактичну пару; unclassified не отримує вигаданих фактів. Вибір random серед ready/suitable; committed total не впливає на probability. Якщо текст оновлюється — генерується під actual facts. Якщо refreshTexts=false — фактична сумісність перевіряється; impossible pairing дає closed conflict до provider write. Це не повернення private sources.

## State machines

**Policy**: prepared → draining → active → cleanup_due → cleanup_running → cleanup_complete. Partial/unknown позначає unresolved child evidence, не стирає active/T0. Activation має single CAS на expected revision після позитивного drain/readiness proof. Якщо draining не завершено — T0 не ставиться.

**Asset**: candidate → validating → publishing → verifying → ready; partial/failed/unknown. Незмінний ready hash не переписується. Disabling new import не вимикає serving/probes/cleanup.

**Alias**: planned -> verifying -> ready; failed/unknown -> bounded reconciliation. Initial positive GET proves immutable token-to-image/generation/MIME mapping and has no independent24hTTL. Eligibility for both new and old pairs inherits current asset content proof24h and serving-health120s with compatible route/protocol/key versions. Old closed-generation aliases require no daily per-alias GET. A routing/key change requires compatibility probes including old issued tokens; never re-sign an old URL. Public serving is independent of allocation eligibility.

**Assignment**: issued → pending_write → confirmed або failed/canceled/unknown. Усі terminal/unknown лишають consumed slot. Пізня позитивна звірка unknown переводить у confirmed один раз. Новий attempt тієї самої pair не змінює URL; новий provider creation має той самий durable catalog identity. Неуспішна SQL allocate transaction не залишає partial recipe/slots.

**Retirement object_purge**: retained -> due -> claimed -> deleting_origin -> purging_cache -> verified_deleted; unknown/backoff preserves identity/fence. Use policy_retirement, not orphan_candidate. Credit only after verified deletion through current authoritative charged ledger, once.

**Retirement metadata_unlink**: retained -> due -> metadata_unlinked, with external_untouched; no provider DELETE or nonexistent delete receipt. Cleanup_complete only after all objects verified_deleted and all metadata targets metadata_unlinked, with no blocked ownership or unknown receipt. Zero-object manifests still run metadata finalization.

## Transactions and lock order

1. Allocate перевіряє auth/epoch, коротко блокує один operation intent (NOWAIT), читає готовий candidate snapshot один раз. Той самий intent busy — fast pending receipt, не duplicate draw.
2. Existing pair assignments reuse. Нові image rows lock-яться в UUID order через SKIP LOCKED, issued_seq збільшується лише за ready потрібної generation. Унікальні constraints захищають pair/slot; duplicate conflict повертає persisted value.
3. After acquiring an image lock, recheck existing pair BEFORE incrementing issued_seq; concurrent different intents for the same pair consume only one slot. Assignment set і весь bounded recipe атомарно фіксуються. Не можна partial batch зі зміною count; або весь набір, або rollback. Після commit slots не re-used навіть якщо provider fail.
4. Provider write/readback поза transaction/locks. Actual result і completion receipt підтверджують pair set; completion RPC atomically marks first-use receipts and increments aggregates, locks ordered image UUID. Own confirmation timeout стає accounting_pending/unknown із durable reconciliation, не новим каталогом.
5. Fence and positively drain already claimed legacy purge/DELETE/CDN-purge as well as imports/writes before T0; unknown deletion blocks activation. Retirement manifest preparation bounded/resumable, до active очищені known in-flight writes/grants. На T0 CAS зафіксовано immutable full manifest digest; post-T0 legacy commit/revoke fence діє у всіх callers.
6. Quota credit follows stable publication/charged-ledger identity and its CURRENT owner after transfer, never the manifest original-owner snapshot. Purge lock order з045: tombstone → publication. Before-team-delete зберігає retirement identity/hold; foreign cascades не видаляють її. R2/CDN calls поза DB locks. finish перевіряє fence/result, credit once.

## Deletion and privacy

Global images не належать uploader/team; видалення team не видаляє canonical objects/aliases/aggregates. Live team/catalog joins очищуються/анонімізуються за031; opaque catalog identity й pair dedup tombstone не мають direct person fields. Якщо foreign material identity вже вилучена, повторний caller не може відродити її; authenticated scope/nonce не змінюється.

Retirement містить object keys тільки у приватному operational state, ніколи у telemetry/CLI raw evidence. До30днів user не бачить old settings, але retained bytes читаються. На дедлайні cleanup ignores historical use refs тільки для policy_retirement targets. Drive/local/external originals отримують лише unlink metadata outcome; source permissions не revoke-аються. Зовнішні кеші й downloaded copies unknown/uncontrolled.

## Analytics projections

`analytics_global_image_status`, `analytics_global_image_journal`, `analytics_global_image_cleanup`: narrow SELECT-only projections, preview URL only in owner status. Each invocation reads summary+page in one repeatable-read transaction. Sort image_id ASC by default or confirmed_uses DESC,image_id ASC.

Source_revision is a read-only SHA256 fingerprint of ordered status-visible tuples: image ID, confirmed/issued counters, alias generations/states, content proof fields, last use, policy/config revision and every field affecting filter/sort/output. No writable global revision row in allocation. Readiness uses cursor observation_at with cursor TTL60s. Changed fingerprint or expired cursor -> cursor_stale. Allow one bounded restart, then explicit partial/truncated result; never silently combine changed snapshots or loop indefinitely. Cleanup summary has its own observation and does not invalidate image paging. Mutable counters are never relabelled historical as-of.

## Numeric bounds

Batch1..400rows, status page1..100(default50), candidate scan≤2000 і≤max(4×count,256) з bounded second sample; URL slots200, informational threshold5000. Asset content proof24h, serving freshness120s/probe60s, ready-ahead current+2. API deadline1s, lock50ms, statement750ms. Import1000files/5GB; worker60s/global8; cleanup8attempts,15min backoff. Counters bigint у JSON decimal strings для точності; JavaScript number лише bounded counts/limits.
