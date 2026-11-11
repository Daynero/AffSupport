# Contract: catalog-video-r2

Типи й guards — `packages/shared/src/team/catalog-video-r2.ts` (єдине джерело для web і edge). Уся валідація на межі (Principle I): вхід `unknown` → discriminated-union результат. Оновлено після другого аналізу 2026-11-09 і третього проходу 2026-11-10.

## Edge function `catalog-video-r2`

Авторизація користувацьких маршрутів: `authorizeCaller` → RPC, що перевіряє `private.can(p_team, 'manage_metadata', auth.uid())` — той самий предикат, що в `public.set_team_product_catalog_settings`. Cron-маршрути приймають лише чинний секрет `wishly_catalog_sync_secret` у заголовку `x-catalog-sync-secret` (той самий, що `catalog-sync` і `catalog-images`); анонімні/browser-виклики воркера відхиляються. Нових секретів не створюється.

| Маршрут | Хто | Призначення |
|---|---|---|
| `GET /availability?teamId` | користувач | `{ available, reason?: 'VIDEO_R2_DISABLED'\|'VIDEO_R2_NOT_CONFIGURED'\|'VIDEO_R2_POLICY_PENDING', canManage, contractVersion: 1 }`; `NOT_CONFIGURED` — коли env не повний або origin env ≠ origin у БД; UI показує галочку лише при `available`, disabled при `!canManage` |
| `GET /catalogs/:id/state` | користувач | `{ catalogMaterialId, enabled, link: 'drive'\|'r2', lastSuccessfulUpdateAt, copy: { state, readyAt, fullHashVerified }\|null, reason: Code\|null, usedBytes, quotaBytes, canManage, revision }` |
| `POST /catalogs/:id/preference` | користувач | `{ enabled: boolean }` → `{ enabled, revision, updatedAt }`; last-write-wins; не публікує байтів (FR-003); журнал `configured` із `actor_id`. (`POST`, а не `PUT`: межа `invokeTeamFunction` знає лише GET/POST) |
| `GET /usage?teamId` | користувач | `{ usedBytes, quotaBytes, readyCopies, retiringCopies, enabledCatalogs }` для сторінки тарифу |
| `POST /worker` з `{"route":"claim"}` | cron-секрет | claim наступної копії (lease), обробка частин у межах дедлайну |
| `POST /worker` з `{"route":"sweep"}` | cron-секрет | retire-кандидати, `retire_orphans` (без uses), надгробки (видалення + purge), abort осиротілих multipart |

Створення каталогу не має окремого маршруту: `copyVideoToR2: boolean` — необов'язкове поле існуючого create-запиту (`drive-ops product-catalog` / `catalog-durable`) і необов'язкове поле `LaunchCatalogConfig.copyVideoToR2` для каталогів, що створюються запуском (`launch-catalog`). Відсутнє поле = `false`. Старі клієнти без поля працюють без змін. `true` сервер приймає лише коли актор (створення — актор create intent; запуск — актор виконання запуску, `p_actor`) має `manage_metadata`; інакше `PERMISSION_DENIED` і каталог не створюється — поле не скидається мовчки, бо саме створення вимагає лише `edit` на відео.

## Резолвер (внутрішній контракт)

```
createCatalogVideoLinkResolver({ service, kick? }).resolve({
  scope: { catalogMaterialId } | { publicationJobId } | { teamId, assumeEnabled },
  source: { materialId, sourceVersion, sizeBytes, mimeType, checksum },
  drive: () => Promise<string>   // the caller's unchanged Drive path, called only for a Drive answer
}) -> { kind: 'drive', url } | { kind: 'r2', url, copyId }
```

Scope `publicationJobId` — для `publication-io` (каталог виводиться з job); `teamId`+`assumeEnabled` — для каталогу, що створюється (рядка опції ще немає, її несе create-запит). Застарілий шлях оновлення без publication job використовує RPC `service_catalog_video_r2_resolve_current(p_catalog, p_source_material?)`, який рахує `source_version` із проіндексованого рядка матеріалу (той самий канонічний хеш, що `catalogPublicationSourceIdentity`).

Правила: немає опції → `drive` (з `ensureAnyoneReader` як сьогодні); опція + `copy.state='ready'` для `sourceVersion` → `r2` (резолвер Drive-файл не публікує); опція без готової копії → `drive` + enqueue (ідемпотентно). Резолвер ніколи не кидає через відсутність R2 — fallback обов'язковий (FR-006). `url` — **базовий**: суфікс-варіація `catalogVideoVariation(url, mark)` накладається викликачем після, і порівняння `old.url !== url` ведеться над базовим URL того самого `link_kind`.

Місця виклику (усі, де сьогодні `videoShareLink` формує посилання клітинки): `drive-ops/product-catalog.ts` (`createProductCatalog`: `videoLink`/`originalVideoLink`), `drive-ops/catalog-initial-video-authority.ts`, `catalog-updater/publication-io.ts`, `drive-ops/updater-variants.ts`, `catalog-updater/worker.ts` (override `item.spare?.link ?? item.currentVideoLink` перед `_shared/catalog-updater.ts`). Не викликається з `drive-ops/updater-restitch.ts` (`recordRestitchOutput` — `shared_link` запасної копії, лишається Drive). Результат `r2` іде лише в клітинку і квитанцію; `current_video_link`/`video_link`/`shared_link` завжди лишаються Drive-посиланнями.

## Квитанція публікації

`public.service_record_catalog_publication_link(p_job uuid, p_worker uuid, p_material uuid, p_source_version text, p_url text, p_link_kind text default 'drive') returns boolean` — заміна чинного RPC. `drive`: валідація дослівно як сьогодні. `r2`: `p_url = 'https://' || <videoOrigin> || '/' || copies.object_key` для копії `ready` з `(team_id job, source_material_id=p_material, source_version=p_source_version)` і `preferences.enabled=true` каталогу job; інакше `SOURCE_CHANGED`. Виклик із `publication-io.ts` передає `p_link_kind` із результату резолвера.

## Внутрішні RPC (service role)

- `confirm_use(p_catalog, p_link_kind, p_uses jsonb[] of {sourceMaterialId, sourceVersion | copyId}, p_job?)` — після підтвердженого запису каталогу **замінює весь набір** uses каталогу: зайві рядки видаляються, при `link_kind='drive'` — усі; копії без uses стають `retiring` у тій самій транзакції; каталог без рядка опції і без uses — no-op (SC-001). `p_job` замість `p_catalog` для publication jobs.
- `resolve(p_catalog, p_source_material, p_source_version, p_size_bytes, p_mime, p_md5, p_job?, p_team?, p_assume_enabled?)` — гарячий шлях; `resolve_current(p_catalog, p_source_material?)` — застарілий шлях; `yield(p_copy, p_worker, p_fence)` — віддати lease після вичерпання бюджету invocation.
- `retire_orphans()` — у sweep: копії `ready` без жодного use і без незавершеної публікації → `retiring` з `retire_after = now + grace_interval`.
- `claim_retire` / `mark_deleted` / `claim_purge` / `mark_purged` — видалення об'єкта + purge; успіх = 404 на HEAD і прийнятий purge.

## Закриті коди причин

На дроті — з префіксом, бо `TeamErrorCode` один на продукт: `VIDEO_R2_DISABLED`, `VIDEO_R2_POLICY_PENDING`, `VIDEO_R2_NOT_CONFIGURED`, `VIDEO_R2_SOURCE_UNAVAILABLE`, `VIDEO_R2_UNSUPPORTED_FORMAT`, `VIDEO_R2_QUOTA_EXCEEDED`, `VIDEO_R2_PROVIDER_UNAVAILABLE`, `VIDEO_R2_PROVIDER_RATE_LIMITED`, `VIDEO_R2_TIMEOUT`, `VIDEO_R2_UPLOAD_UNKNOWN`, `VIDEO_R2_CHECKSUM_MISMATCH`, `VIDEO_R2_PUBLIC_UNREACHABLE`, `VIDEO_R2_CATALOG_WRITE_FAILED`, `VIDEO_R2_CANCELED`, `VIDEO_R2_INTERRUPTED`, `VIDEO_R2_CLEANUP_PARTIAL`; плюс спільні `PERMISSION_DENIED`, `SOURCE_CHANGED`, `TOO_LARGE`. Разом — `CATALOG_VIDEO_R2_REASONS` у `packages/shared/src/team/catalog-video-r2.ts`.

Кожен код: додається в `_shared/errors.ts`, exhaustive mapping у `apps/web/src/team/errors.ts`, uk/en локалі, `scripts/analytics/code-map.ts` + перевірка повноти.

## Перевірка частин

Перевага — `x-amz-checksum-sha256` на `UploadPart`, якщо пісочниця (T003) доведе, що R2 перевіряє заголовок і відхиляє невідповідність; інакше — Range-readback частини й власна звірка SHA-256. Застосований спосіб фіксується в `parts.verified_by` і в журналі (`part_verification`); FR-004 вважається виконаним будь-яким із двох.

## Публічний об'єкт

`https://<videoOrigin>/v/<hex32>.mp4`; `content-type: video/mp4`; підтримує `Range`; `cache-control: public, max-age=31536000, immutable`; `x-content-type-options: nosniff`. Ключ непрозорий; не містить тенанта, імені, шляху. Після `deleted` — 404 (кеші зовнішніх систем не обіцяються).

## UI-контракт

`CatalogVideoR2Toggle` (компонент інвентарю): підпис «Копіювати відео в R2», пояснення (що копіюється, що зберігається лише активна версія, що відео відкривається за посиланням без входу, а в посиланні немає назви файлу чи папки), статус-чип `R2` / `Drive` / причина fallback, час останнього успішного оновлення; вимкнений за замовчуванням; приховано при `available=false`; disabled без права. Однаковий зміст у створенні каталогу, налаштуваннях автооновлення та конфігурації каталогу запуску. SC-005: увімкнення при створенні — один клік; для наявного каталогу — не більше двох. Оновлення стану без polling: `useTeamRealtime.ts` підписується на `public.team_catalog_video_r2_signals` (`team_id` фільтр) і інвалідує стан каталогу; `GET /catalogs/:id/state` — авторитетне перечитування.

## Environment

Нові: `CATALOG_VIDEOS_ENABLED`, `R2_CATALOG_VIDEO_STAGING_BUCKET`, `R2_CATALOG_VIDEO_PUBLIC_BUCKET`, `R2_CATALOG_VIDEO_PUBLIC_ORIGIN`, `R2_CATALOG_VIDEO_TARGET_CONFIRMATION`, `R2_CATALOG_VIDEO_ACCESS_KEY_ID`, `R2_CATALOG_VIDEO_SECRET_ACCESS_KEY`. Спільні з 045: `CATALOG_IMAGES_ENVIRONMENT`, `R2_CATALOG_ACCOUNT_ID`, `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN`. Без повного набору `availability` → `NOT_CONFIGURED`.
