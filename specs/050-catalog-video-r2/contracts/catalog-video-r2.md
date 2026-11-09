# Contract: catalog-video-r2

Типи й guards — `packages/shared/src/team/catalog-video-r2.ts` (єдине джерело для web і edge). Уся валідація на межі (Principle I): вхід `unknown` → discriminated-union результат. Оновлено після другого аналізу 2026-11-09.

## Edge function `catalog-video-r2`

Авторизація користувацьких маршрутів: `authorizeCaller` → RPC, що перевіряє `private.can(p_team, 'manage_metadata', auth.uid())` — той самий предикат, що в `public.set_team_product_catalog_settings`. Cron-маршрути приймають лише чинний секрет `wishly_catalog_sync_secret` у заголовку `x-catalog-sync-secret` (той самий, що `catalog-sync` і `catalog-images`); анонімні/browser-виклики воркера відхиляються. Нових секретів не створюється.

| Маршрут | Хто | Призначення |
|---|---|---|
| `GET /availability` | користувач | `{ available: boolean, reason?: 'DISABLED'\|'NOT_CONFIGURED'\|'POLICY_PENDING' }`; UI показує галочку лише при `available` |
| `GET /catalogs/:id/state` | користувач | `{ enabled, link: 'drive'\|'r2', lastSuccessfulUpdateAt: string\|null, copy?: { state, readyAt, fullHashVerified }, reason?: Code, usedBytes, quotaBytes }` |
| `PUT /catalogs/:id/preference` | користувач | `{ enabled: boolean }` → `{ revision, updatedAt }`; last-write-wins, без `expectedRevision`; не публікує байтів (FR-003); журнал `configured` із `actor_id` |
| `POST /worker` з `{"route":"claim"}` | cron-секрет | claim наступної копії (lease), обробка частин у межах дедлайну |
| `POST /worker` з `{"route":"sweep"}` | cron-секрет | retire-кандидати, `retire_orphans` (без uses), надгробки (видалення + purge), abort осиротілих multipart |

Створення каталогу не має окремого маршруту: `copyVideoToR2: boolean` — необов'язкове поле існуючого create-запиту (`drive-ops product-catalog` / `catalog-durable`) і необов'язкове поле `LaunchCatalogConfig.copyVideoToR2` для каталогів, що створюються запуском (`launch-catalog`). Відсутнє поле = `false`. Старі клієнти без поля працюють без змін.

## Резолвер (внутрішній контракт)

```
resolveCatalogVideoLink(input: {
  teamId, catalogMaterialId, source: { materialId, sourceVersion, driveFile }
}) -> { kind: 'drive', url } | { kind: 'r2', url, copyId }
```

Правила: немає опції → `drive` (з `ensureAnyoneReader` як сьогодні); опція + `copy.state='ready'` для `sourceVersion` → `r2` (Drive-файл не публікується); опція без готової копії → `drive` + enqueue (ідемпотентно). Резолвер ніколи не кидає через відсутність R2 — fallback обов'язковий (FR-006). `url` — **базовий**: суфікс-варіація `catalogVideoVariation(url, mark)` накладається викликачем після, і порівняння `old.url !== url` ведеться над базовим URL того самого `link_kind`.

## Внутрішні RPC (service role)

- `confirm_use(p_catalog, p_link_kind, p_uses jsonb[] of {source_material_id, copy_id})` — після підтвердженого запису каталогу **замінює весь набір** uses каталогу: зайві рядки видаляються, при `link_kind='drive'` — усі; копії без uses стають `retiring` у тій самій транзакції.
- `retire_orphans()` — у sweep: копії `ready` без жодного use і без незавершеної публікації → `retiring` з `retire_after = now + grace_interval`.
- `claim_retire` / `mark_deleted` / `claim_purge` / `mark_purged` — видалення об'єкта + purge; успіх = 404 на HEAD і прийнятий purge.

## Закриті коди причин

`DISABLED`, `POLICY_PENDING`, `NOT_CONFIGURED`, `PERMISSION_DENIED`, `SOURCE_UNAVAILABLE`, `SOURCE_CHANGED`, `UNSUPPORTED_FORMAT`, `TOO_LARGE`, `QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `TIMEOUT`, `UPLOAD_UNKNOWN`, `CHECKSUM_MISMATCH`, `PUBLIC_UNREACHABLE`, `CATALOG_WRITE_FAILED`, `CANCELED`, `INTERRUPTED`, `CLEANUP_PARTIAL`.

Кожен код: додається в `_shared/errors.ts`, exhaustive mapping у `apps/web/src/team/errors.ts`, uk/en локалі, `scripts/analytics/code-map.ts` + перевірка повноти.

## Перевірка частин

Перевага — `x-amz-checksum-sha256` на `UploadPart`, якщо пісочниця (T003) доведе, що R2 перевіряє заголовок і відхиляє невідповідність; інакше — Range-readback частини й власна звірка SHA-256. Застосований спосіб фіксується в `parts.verified_by` і в журналі (`part_verification`); FR-004 вважається виконаним будь-яким із двох.

## Публічний об'єкт

`https://<videoOrigin>/v/<hex32>.mp4`; `content-type: video/mp4`; підтримує `Range`; `cache-control: public, max-age=31536000, immutable`; `x-content-type-options: nosniff`. Ключ непрозорий; не містить тенанта, імені, шляху. Після `deleted` — 404 (кеші зовнішніх систем не обіцяються).

## UI-контракт

`CatalogVideoR2Toggle` (компонент інвентарю): підпис «Копіювати відео в R2», пояснення (що копіюється, що зберігається лише активна версія, що публічно за непрозорим посиланням), статус-чип `R2` / `Drive` / причина fallback, час останнього успішного оновлення; вимкнений за замовчуванням; приховано при `available=false`; disabled без права. Однаковий зміст у створенні каталогу, налаштуваннях автооновлення та конфігурації каталогу запуску. SC-005: увімкнення при створенні — один клік; для наявного каталогу — не більше двох.
