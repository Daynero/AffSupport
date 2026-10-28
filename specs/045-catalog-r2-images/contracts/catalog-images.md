# Catalog images contract v2

Реалізований disabled-first contract; hosted provider acceptance ще не підтверджено. Використати існуючі `authorizeCaller`, CORS, `{error:STABLE_CODE}` та `getSupabaseClient()` seams; decoded request/RPC/provider values — unknown→validated union. Body metadata ≤1 MB, publication bytes не приймаються control routes. Усі наведені mutation routes reauthorize current membership/feature epoch, а не лише validate JWT signature.

## HTTP control plane — Supabase function `catalog-images`

| Метод / шлях                                 | Запит                                                                                        | Результат / правило                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| POST `/imports`                              | teamId, contractVersion:2, sourceKind, idempotencyKey; Drive source material/folder IDs only | 202 job snapshot; same key+same payload same job; 409 mismatch; local не потребує Drive connection                          |
| GET `/imports`                               | teamId, cursor; fixed page≤20, active/reconciliation first, newest history                   | current-authorized paginated discovery після reload без job ID; safe counts/status; manager може знайти покинуті jobs       |
| POST `/imports/:id/manifest`                 | pageKey, entries ≤100: clientFileKey, name, declaredSize, declaredMime                       | Idempotent append while collecting; server limits; duplicates do not reserve twice                                          |
| POST `/imports/:id/seal`                     | revision, exact manifest count                                                               | CAS collecting→sealed; no partial manifest presented as complete                                                            |
| POST `/imports/:id/entries/:entry/grant`     | generation, requestKey                                                                       | private staging PUT URL + exact key-bound required headers, expiresAt≤5min; no public write grant; pending current job only |
| POST `/imports/:id/entries/:entry/delivered` | grantGeneration, requestKey                                                                  | 202 status, not ready; received signal is hint; worker reads staging independently                                          |
| GET `/imports/:id`                           | optional cursor, limit≤100                                                                   | authorized job + paginated entry UI projection, stage/classification/outcome, counts, hasMore; no credential-bearing values |
| POST `/imports/:id/cancel`                   | revision, idempotencyKey                                                                     | CAS cancel/epoch increment; completed files retained; no false guarantee of instant staging URL invalidation                |
| POST `/imports/:id/retry`                    | optional eligible entry IDs≤100, idempotencyKey; absent IDs retries all eligible pages       | new attempts for same frozen versions, no re-upload ready copies; unknown writes reconciled first                           |
| GET `/dictionary`                            | teamId, cursor, limit≤100                                                                    | ready active entries, revision, exact total, hasMore; not legacy filename list truncated at 500                             |
| GET `/inventory`                             | teamId                                                                                       | exact matched pairs, unclassified, total and revision; no 25k-name payload                                                  |
| POST `/pool/:entry/remove`                   | revision, idempotencyKey                                                                     | active=false only; retained public object unchanged                                                                         |
| POST `/publications/:id/revoke`              | explicitRevocation:true, revision, idempotencyKey                                            | confirmed-impact action; queued durable purge and state; not instant all-cache deletion                                     |
| POST `/imports/:id/continue`                 | idempotencyKey                                                                               | explicit next bounded Drive source job, persisted cursor                                                                    |
| POST `/worker`                               | named worker secret                                                                          | internal dispatch only, no browser JWT/anonymous worker bypass; one file invocation                                         |

Route base is `/functions/v1/catalog-images`; prefix/table ownership must be consistent in tests. R2 credentials exist only in server runtime secrets; public browser config contains at most media origin and capability version. Exact origins for production/beta, isolated bucket credentials; dev/sandbox config cannot target production.

`supabase/config.toml`: `[functions.catalog-images] verify_jwt=false`, оскільки worker cron має named secret, а не user JWT. Це не anonymous permission: handler перевіряє user JWT через authorizeCaller на кожному user route і named secret тільки на `/worker`, без взаємозамінного fallback; OPTIONS відповідає лише CORS. Local/hosted deployment parity і справжній cron request без JWT мають acceptance test. Function configuration та секрет dispatch обов'язкові до enable.

GET discovery після reload повертає active/recent jobs у межах team permissions; не покладається на localStorage. Collecting/waiting-source expiry — 24h після останньої дієвої user mutation; read/worker heartbeat не продовжують. CAS expiry звільняє reservations exactly once для недоставлених entries; staged/delivered продовжують роботу, ready зберігаються, unknown не підміняється failure. Expired job не приймає новий grant/seal; reselect створює нову явну спробу. Два покинуті jobs не блокують active-job quota назавжди.

## Data plane and verification

Browser uses server-issued presigned **S3 staging** URL (not media domain); no permanent access key. URL is a bearer secret, never stored in analytics/browser persistent storage/logs. It may be reused until expiry; CORS is not an authorization/size guarantee. Actual size/format rejected before publication, quota reservations and outstanding grant limits bound admitted work, staging overage is separately observable.

New SDK dependencies must be pinned by T003 and real browser tests prove generated headers/CORS/method behavior. Do not claim signed Content-Length enforced unless the R2 sandbox proves it; no presign to final public key in either case.

Trusted worker reads exactly one source into bounded server-owned bytes, checks declared/actual length ≤50,000,000, dimensions 1..16M pixels, static supported container/MIME, orientation 1 or absent; unsupported rotation must be prepared externally. SHA-256 is server-computed. Structural integrity is not full codec decoding or semantic/brand detection.

Allocate one input buffer, bound chunks/offset, reject short/overflow before final write. Avoid multiple full copies/base64; hash/readback streamed or bounded within ≤192MB measured gate. Same verified bytes are sent to a random public candidate using `PutObject If-None-Match:*`. Prior candidate identity persisted before PUT; no re-read of a browser-mutable staging object after validation. On 412 inspect existing candidate; adopt only identical trusted digest+size+type. Other content is conflict, never overwrite. Head/ETag alone is not hash proof, and negative response is not proof that an ambiguous prior PUT failed.

Origin byte readback and anonymous custom-domain byte readback must match server digest before ready transaction. Public headers: verified image MIME, inline; nosniff встановлюється Cloudflare response-header transform на media domain, не довільним S3 metadata. Provisioning потребує environment-isolated zone-transform/CDN-purge permissions, response перевіряється anonymous GET. Immutable positive caching, negative cache disabled for missing candidates. Origin vs CDN receipts distinct; failed public verification leaves candidate/reconciliation state, no ready membership.

Isolate-local nonblocking permit: тільки одна byte-heavy invocation одночасно, до DB claim/byte allocation. Busy instance відповідає bounded requeue без утримання lease/черги; team/global DB permits додаткові. Q19 вимірює aggregate peak при кількох concurrent 50MB requests в одному isolate, не лише одну invocation.

Cleanup/adoption exclusion: одна publication row lock/CAS fence для reserve/adopt/reuse/commit-ready/issued-use та orphan cleanup. Orphan claim переводить candidate у purging лише при no owner/lease/use/membership/pending commit/unknown write; усі committers відхиляють purging або old fence. External DELETE тільки після цього claim. Explicit revoke/team deletion окремо авторизують destructive branch і late-write reconciliation. Тестувати обидва порядки гонки — cleanup-first та adoption-first.

## Classification and draw contract

- Vocabulary `catalog-clothing-v1`: 32 canonical garments /24 colors from image-guide, `tshirt` alias fixed. Parse exact tokens/boundaries, detect all matches, not arbitrary substring first-match.
- Recognized one garment+one color → matched. Missing/unknown/ambiguous → unclassified; valid media remains ready/random. Bad format, forbidden source or oversize → failure, never a random-mode exemption.
- Same SHA/size + different class/mode → classification conflict (explicit retry after correcting source metadata), not silent mutation. Same class → reuse. Unique filenames do not prove unique bytes.
- Draw v2: all active ready entries in one shuffled no-repeat stream under team lock. Freeze selected entry/publication/metadata revision per catalog attempt. Mixed pool includes random entries with no promise of semantic match; absence of matched entries does not block generic catalog generation.
- Matched rows use actual type/color pairs; no Cartesian product of independent lists. Common pairing helper in create/refresh/grow preserves selected image facts. `refreshTexts=false` still allows minimal type/color/category/tag correction if matched image changed; preserve unrelated text/price/details. Unclassified selection does not inject fake image facts or rewrite rows to guessed class.

## Compatibility

New catalog requests carry `catalogImageContractVersion:2` (in shared typed input). New worker uses v2 draw RPC. V1 draw RPC shape remains Drive-only. Legacy team can finish legacy requests/checkpoints; v2 team rejects missing/unknown new-request version before external mutations with `CATALOG_IMAGE_UPGRADE_REQUIRED`. Existing in-flight legacy attempt identified by persisted checkpoint may finish; a fresh legacy retry cannot masquerade as that attempt.

Producer coverage обов'язково включає `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx`, input/wrapper у `apps/web/src/api/team.ts` та серверний request builder `supabase/functions/drive-ops/launch-catalog.ts`. Fresh Launch використовує v2 після team admission; retry бере persisted contract version, legacy accepted checkpoint не мігрує мовчки. Team mode flip — CAS після ready pool/capability proof, imports не активують його від GET/drop.

Durable checkpoint `version:2` images use `kind:legacy_drive|r2`; v1 images parser accepts only old valid Drive fields. Unknown version, mismatched team, revoked publication → explicit stable failure. Ready URLs already issued remain usable after imports disabled; disabling selection for new work does not mutate historical snapshots or drop R2 adapters needed to read them.

New typed API module `apps/web/src/api/team-catalog-images.ts` uses existing auth/error request seam; `api/team.ts` delegates catalog-image calls, not another global API client. Public Realtime snapshot table contains safe counters/stage/revision only; single team subscriber invalidates hook. Initial GET + post-mutation reread + reconnect/foreground reread; events during read cause one bounded follow-up, no recurring polling or duplicate subscription.

## Error/status codes

Reuse existing common codes where semantics match: `PERMISSION_DENIED`, `INVALID_INPUT`, `NOT_FOUND`, `IDEMPOTENCY_CONFLICT` (add only if absent). New closed codes:

`CATALOG_IMAGE_UPGRADE_REQUIRED`, `CATALOG_IMAGE_IMPORT_DISABLED`, `IMAGE_QUOTA_EXCEEDED`, `IMAGE_MANIFEST_INCOMPLETE`, `IMAGE_SOURCE_UNAVAILABLE`, `IMAGE_SOURCE_CHANGED`, `IMAGE_LOCAL_SOURCE_REQUIRED`, `IMAGE_UNSUPPORTED_FORMAT`, `IMAGE_TOO_LARGE`, `IMAGE_DIMENSIONS_INVALID`, `IMAGE_ANIMATED_UNSUPPORTED`, `IMAGE_ORIENTATION_UNSUPPORTED`, `IMAGE_CONTENT_INVALID`, `IMAGE_CLASSIFICATION_CONFLICT`, `IMAGE_TEXT_PAIRING_CONFLICT`, `IMAGE_PROVIDER_UNAVAILABLE`, `IMAGE_PROVIDER_RATE_LIMITED`, `IMAGE_PUBLIC_VERIFICATION_FAILED`, `IMAGE_WRITE_UNCERTAIN`, `IMAGE_DICTIONARY_COMMIT_FAILED`, `IMAGE_PUBLICATION_REVOKED`.

Unknown name is **classification outcome**, not error code. Cancellation/interruption have terminal categories distinct from failure. HTTP 400 invalid, 403 permission, 404 unavailable ID, 409 revision/state/version/idempotency, 413 size, 429 quota/rate, 503 provider unavailability; admitted async work returns 202 snapshot. Consumer-facing localization maps closed codes; raw SDK/provider error text not returned/collected. Shared errors, Edge mapper, web guard/locales and analytics code-map change together.

Team transport codes належать `TEAM_ERROR_CODES` у `packages/shared/src/team/transport.ts`. Додати їх там, exhaustive mapping у `_shared/errors.ts` та `apps/web/src/team/errors.ts`, guards/locales/code-map parity. `packages/shared/src/types.ts` змінюється окремо для загального analytics failure registry, якщо ці причини передаються цим контрактом; це не заміна TeamErrorCode registry.

## SQL RPC contracts (proposed)

- User: `begin_catalog_image_import_v2`, `append_catalog_image_manifest_v2`, `seal_catalog_image_import_v2`, `get_catalog_image_import_v2`, `list_catalog_image_dictionary_v2`, `get_catalog_image_inventory_v2`, `remove_catalog_image_pool_entry_v2`, `cancel_catalog_image_import_v2`. These enforce auth.uid, current permissions, tenant and request quotas.
- Service only: claim/renew/file-progress/reserve-publication/commit-ready/reconcile/purge transitions, `service_draw_product_catalog_images_v2`, issued-use reserve/finalize. Named-secret HTTP worker authenticates to service role; authenticated/anon cannot call these RPCs.
- All security-definer functions `set search_path=''`, qualified objects; no broad direct client INSERT/UPDATE; no service secret or staging key in Realtime table/public RPC results. Triggering DB cron reuses established vault/named-secret dispatch conventions, not hard-coded credentials.
- Analytics SELECT-only allowlisted projection views: imports, safe entry stages/terminal, publication verification/dictionary joins, issued-use outcomes, purge outcomes, aggregate bytes/count buckets. No mutation grant or diagnostic path with service credentials.

## Diagnostics

Reuse typed 031 operation events with capability `team.catalog_images`, operation/flow/attempt/team IDs, source kind, safe stage and outcome, classification mode, bounded size/duration/count buckets. Critical stages/terminals and unknown-write receipts unsampled; progress may aggregate. Import entries correlate with parent job and catalog attempt uses. DB journal remains authoritative if event emit/delivery fails.

`catalog-images <team-id|import-id> --period ... --as-of ... --limit ... --json` adds bounded read-only command; `investigate`/`inspect`/`audit` and catalog diagnostics link relevant evidence. Response uses existing `{ok,command,generated_at,period,data}` with delivery lag/fresh-through, coverage versions, cursor/truncation and source unavailable/unsupported statuses. Exact observed bytes can remain in privileged operational totals; diagnostic export uses bounded buckets/approved aggregates, never source names, URLs, hashes or raw payloads.

Copy prompt telemetry: version, intent/success/failed/manual-fallback only; clipboard/text absent. External generation not observed, absence of import after copy is not a failure. Billing/cache provider data unavailable → estimate/unknown. 031 retention, account anonymization and environment isolation apply.

## Acceptance obligations

All APIs need same/different idempotency payload tests; tenant/current-membership/expired capability denial; local without Drive; source snapshot change; 768 names + unknown/ambiguous normal success; no-repeat concurrent draws and frozen retry; verified-buffer/staging overwrite; late accepted PUT/negative HEAD; public CDN readback; dictionary failure; partial/cancel/reload; grant expiration/overage; delete owner/uploader/draft team; safe telemetry/readonly diagnosis and missing evidence. Real R2/consumer acceptance complements mocks; it does not run against production in this task.

## Deterministic row-pairing policy

- Матчинг стосується canonical garment/color facts і токенів, не довільного семантичного чи візуального AI-аналізу. Full-token matching, longest phrases first, без substring замін усередині інших слів.
- Create/new growth rows або `refreshTexts=true`: використати текст для наявної matched пари; якщо такого тексту в пулі немає, сформувати нейтральний canonical текст із фактичної пари, без вигаданих тканин/крою як фактів фото. Наприклад title `Black Hoodie Essential Style`, description `This catalog item is a black hoodie. See the product image for its appearance.`. Unclassified — чинний generic random clothing text, без image facts.
- `refreshImages=false` і `refreshTexts=false`: готові historical rows не переписувати заради класифікації. `refreshImages=false`, `refreshTexts=true`: залишити image identity і згенерувати текст до його наявних matched facts; generic лишається без семантичної гарантії. Нові growth rows завжди використовують правило створення, не переписують старі rows.
- `refreshImages=true`, `refreshTexts=false`, нова matched картинка: дозволене тільки однозначне token-aware виправлення в row copy. Title повинен містити рівно один recognized garment; кожне поле має не більше одного distinct garment і одного distinct color, а всі recognized facts обох полів мають узгоджуватись між собою/з попереднім frozen row fact, якщо він наявний. Виправляються тільки recognized garment/color tokens на факти нової картинки; поля без color-token не отримують вигаданих вставок. Category/color/tags оновлюються з фактичної пари, price й інші випадкові поля не регенеруються.
- Якщо title не має garment token, є кілька конфліктних типів/кольорів, old facts суперечливі або результат перевищує чинні TITLE_MAX=200 /DESCRIPTION_MAX=9999, **не вгадувати, не обрізати, не регенерувати приховано**. Уся спроба оновлення завершується `IMAGE_TEXT_PAIRING_CONFLICT` до зовнішнього запису каталогу; старий каталог/URL/snapshot збережені. Recovery: увімкнути оновлення текстів або виправити назви/описи й явно повторити.
- Новий unclassified вибір не змінює текст заради вигаданої семантики; normal random mode збережений. Якщо matched identity/facts не змінювались і обидва прапори off, немає примусового переписування legacy custom text.
- Fixtures: unknown custom title, conflicting two garment/color tokens, valid unique token replacement, exact 200/9999 boundary та +1 overflow; усі чотири комбінації refresh flags і growth. У failure немає partial external catalog write або image-use committed receipt.

## Implemented recovery refinements

- Eight active upload/unverified slots are independent of retired unexpired bearer grants. Admission pressure returns retryable `IMAGE_UPLOAD_CAPACITY_BUSY`; true storage/job quota remains `IMAGE_QUOTA_EXCEEDED`. The browser retries only capacity with the same generation/request key at five-second intervals, at most 48 retries (four minutes), abortable on cancellation. It retains local input on timeout. Trusted verification or a terminal result frees capacity; a browser delivery hint does not.
- A failed incomplete Drive enumeration retains its cursor and already admitted/ready entries. Explicit retry fences the prior enumeration lease and resumes enumeration; a safe optional job `errorCode` explains a failure before the first file.
- Frozen image selection is scoped by create/growth/refresh within an attempt. Empty admitted v2 pools return bounded settings-missing instead of falling back to the legacy settings URL. A cached recipe still validates publication authority before provider I/O; authoritative finalization conflicts are surfaced. Delivered updater reconciliation validates and finalizes use receipts in the same database transaction as completion.
- Stage changes bump the public safe snapshot revision for the existing Realtime channel. Expiry does not fence a live service lease. Folder selection requires an actual material-backed folder; the unrepresented Drive root cannot be submitted.

Launch1550 integration:service_claim_launch_generation additionally returns server-owned catalogImageContractVersion1|2. The executor sends create version2 only for persisted2. A reserved future child UUID identifies the pre-restitch image selection, issued uses and actual catalog child. Both SQL planners support the R2 union; exact accepted-v1/no-child recovery remains valid after team cutover. A memoized checkpoint does not waive current Launch authority, and a ready R2-only pool does not require legacy Drive pictures.
