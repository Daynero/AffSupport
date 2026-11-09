# Implementation Plan: Опційна публікація відео каталогу в R2

**Branch**: `050-catalog-video-r2` (гілку створює власник; специфікація від неї не залежить) | **Date**: 2026-11-09 (оновлено після аналізу того ж дня) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/050-catalog-video-r2/spec.md`

## Summary

Каталог отримує опцію «Копіювати відео в R2». Усе, що сьогодні вирішує «яке посилання на відео піде в таблицю каталогу», зводиться до одного місця — `videoShareLink(live.id, live.resourceKey)` після `ensureAnyoneReader` (чотири місця: `catalog-updater/publication-io.ts`, `drive-ops/updater-variants.ts`, `drive-ops/catalog-initial-video-authority.ts`, `drive-ops/catalog-durable.ts`). План вводить один спільний **резолвер посилання**: для каталогу без опції він повертає рівно те, що повертає сьогодні; для каталогу з опцією — R2-посилання, якщо для цієї версії джерела є готова перевірена R2-копія, інакше Drive-посилання (fallback) і постановку копіювання в чергу.

Копіювання — серверне, відновлюване (multipart, по частинах, стан у БД, lease/fence за зразком 045), Drive → edge function → R2, без участі агента й без відкритого Soty; запускається `pg_cron` через чинний секрет catalog-sync із vault, так само як воркер 045 (нових секретів не створюється). Після підтвердження каталогу на новій версії попередня R2-версія втрачає останнє посилання і після короткого вікна видаляється з purge; надгробки об'єктів переживають каскадне видалення каталогу чи простору. Усе — адитивно: нові таблиці, жодних змін у схемі гарячих таблиць, жодних змін протоколу агента. У `packages/shared` додаються типи й коди (спільні для web і edge), тому фіча **доставляється повним релізом після 1.4.0**, а не web-only деплоєм.

## Technical Context

**Language/Version**: TypeScript strict, ESM NodeNext (web, scripts, shared); Deno (Supabase edge functions); PL/pgSQL (міграції)

**Primary Dependencies**: чинні — Supabase (Postgres, pg_cron + pg_net, Realtime, edge functions), `aws4fetch`-сумісний підписувач з 045 (`CatalogImageSigner`), HeroUI v3 + токени дизайн-системи (`apps/web/src/components/ui/`, `styles/tokens.css`); нових залежностей не додається

**Storage**: Cloudflare R2 (новий окремий публічний bucket відео per-environment + staging для multipart); Postgres (`private.*` таблиці, як 045); Google Drive лишається джерелом

**Testing**: vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), SQL-тести `supabase/tests/database/*.test.sql`, провайдерна приймальна `provider-acceptance.ts` за зразком 045, бета-перевірка; `npm run verify` лише як фінальний гейт, коли машина вільна

**Target Platform**: web (Cloudflare Pages) + Supabase edge/DB; агенти macOS/Windows перепаковуються в повному релізі без змін протоколу

**Project Type**: monorepo web-service (apps/web, packages/shared, supabase/functions, supabase/migrations, scripts/analytics)

**Performance Goals**: копіювання відео ~100 МБ завершується за кілька хвилин у фоні без блокування оновлення каталогу; додаткове навантаження на гарячий шлях оновлення — одне індексоване читання на відео-джерело (резолвер)

**Constraints**: жодних змін поведінки для каталогів без опції (SC-001); один файл за invocation, bounded heavy-work за зразком 045; Drive-ліміти на завантаження; ліміти wall-clock edge function → копіювання по частинах із lease; машина слабка — одна важка задача одночасно

**Scale/Scope**: порядок 22 тис. каталогів на 1-й місяць у моделі 045 (≈2,25 ТБ «останніх відео» в найгіршому випадку, якщо всі ввімкнуть); реально — лише ті, хто поставить галочку; ліміт обсягу на простір обов'язковий

## Constitution Check

_GATE: пройдено до Phase 0; повторно перевірено після Phase 1 і після аналізу._

| Принцип | Оцінка |
|---|---|
| I. Type-safe contracts | Нові стани й коди — дискримінований union у `packages/shared/src/team/catalog-video-r2.ts` за зразком `catalog-images.ts`; edge і web імпортують одне джерело; жодних `as` на зовнішніх даних; `.js`-розширення. ✅ |
| II. Release/protocol identity | Не змінюються `release.ts`, `AGENT_API_VERSION`, tool contracts. `packages/shared` змінюється адитивно (типи/коди), тому `scripts/verify-release.mjs` (рядок 413) заборонить web-only деплой до релізу — фіча йде **повним релізом** через раннер (`run-release.sh`), агент перепаковується без зміни протоколу. ✅ (за умови дотримання Release Plan) |
| III. Security/least privilege | Лише service role пише R2-таблиці; право ввімкнення = `private.can(p_team, 'manage_metadata', auth.uid())` — той самий предикат, що в `public.set_team_product_catalog_settings` (`20260917170000_catalog_pools.sql:77`); непрозорі випадкові ключі; публічно читається лише активна версія; секрети — лише в environment/vault; воркер приймає лише чинний `wishly_catalog_sync_secret` у заголовку `x-catalog-sync-secret`, нових секретів не створюється. ✅ |
| IV. Child-process/resource orchestration | Дисципліна ресурсів: bounded concurrency, lease/fence, один файл за invocation, abort на таймаут, abort осиротілих multipart. ✅ |
| V. HTTP/API conventions | Нові маршрути й коди помилок узгоджені з `_shared/errors.ts`, exhaustive mapping у `apps/web/src/team/errors.ts`; analytics CLI лишається read-only. ✅ |
| VI. Frontend composition | Галочка — компонент з інвентарю `components/ui/`, токени, без сирих значень; стан через наявний Realtime-шов (без нового polling). ✅ |
| Workflow gates | `npm run verify` лише коли `uptime` дозволяє; ніколи `db reset` на беті; міграції через `psql` + запис у `schema_migrations` (migration up заблоковано); `ROLLBACK.md`; `npm run types:supabase`. ✅ |

Порушень немає; Complexity Tracking порожній.

## Project Structure

### Documentation (this feature)

```text
specs/050-catalog-video-r2/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── catalog-video-r2.md
├── checklists/requirements.md
└── tasks.md          # створює $speckit-tasks
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   └── 20261207191000_catalog_video_r2.sql        # адитивно: config, preferences, copies, parts, uses, purges, journal, RPC,
│                                                  # invoke_catalog_video_r2_worker() + cron.schedule (claim, sweep)
├── functions/
│   ├── _shared/
│   │   ├── r2-catalog-video.ts                    # S3-адаптер відео: multipart, verify, remove, purge (за зразком r2-catalog-images.ts)
│   │   └── catalog-video-link.ts                  # єдиний резолвер посилання (Drive | R2) + fallback; повертає базовий URL
│   ├── catalog-video-r2/                          # worker: claim → copy parts → verify → ready; sweep: retire/purge/abort
│   │   ├── deno.json
│   │   ├── index.ts
│   │   ├── handler.ts
│   │   └── worker.ts
│   ├── catalog-updater/publication-io.ts          # підключення резолвера (замість прямого videoShareLink)
│   └── drive-ops/
│       ├── updater-variants.ts                    # те саме
│       ├── catalog-initial-video-authority.ts     # те саме
│       ├── catalog-durable.ts                     # те саме + опція у create intent
│       ├── product-catalog.ts                     # приймання опції при створенні
│       └── launch-catalog.ts                      # читання опції з конфігурації каталогу Launch
└── tests/database/catalog-video-r2.test.sql

packages/shared/src/team/
├── catalog-video-r2.ts                             # типи, стани, коди, ліміти, guards
├── launches.ts, launches/validation.ts             # LaunchCatalogConfig.copyVideoToR2 (необов'язкове)
└── transport.ts                                    # нові TeamErrorCode

apps/web/src/
├── api/team-catalog-video-r2.ts                    # типізовані виклики
├── team/product-catalog/
│   ├── CatalogVideoR2Toggle.tsx                    # галочка + пояснення + статус (R2/Drive/причина)
│   ├── CreateProductCatalogDialog.tsx              # +галочка
│   ├── ProductCatalogMenuDialog.tsx                # +галочка в налаштуваннях автооновлення / менеджері
│   ├── ProductCatalogSettingsSection.tsx
│   └── useCatalogSettingsFlow.ts
├── team/launches/
│   ├── launchCatalogDefaults.ts                    # значення за замовчуванням: false
│   ├── LaunchSession.tsx                           # галочка в конфігурації каталогу запуску
│   ├── LaunchDefaultsReview.tsx, LaunchChangeReview.tsx  # відображення опції в оглядах
│   └── restitch-runner.ts                          # передає опцію при створенні через Launch
├── team/tariffs/SpaceTariffSection.tsx             # обсяг R2-відео простору й оцінка вартості
├── pages/legal-content.ts                          # політика/умови (uk/en)
└── locales/{uk,en}.ts

scripts/analytics/                                  # catalog-video-r2.ts + code-map/schema/queries/types
docs/NO_SERVER_MEDIA_PLAN.md, docs/CATALOG_VIDEO_R2.md, docs/ANALYTICS_CLI.md
tests/catalog-video-r2-*.test.ts(x)
```

**Structure Decision**: повторюємо вертикаль 045 (shared-типи → міграція → `_shared` адаптер → окрема edge function-воркер → web API/UI → analytics), а гарячий шлях каталогів чіпаємо мінімально — лише через один резолвер. Окремий воркер потрібен, бо копіювання 100 МБ має власні lease, ретраї й cleanup, які не повинні жити всередині `catalog-updater`.

## Key Design Decisions (деталі — у research.md)

1. **Один резолвер посилання.** Опцію вимкнено → поведінка байт-у-байт як сьогодні (і Drive-шлях `ensureAnyoneReader`). Опцію ввімкнено і копія `ready` → R2-URL, **без** публічного доступу Drive до файлу. Копії немає → Drive-посилання + enqueue копіювання. Резолвер повертає **базовий** URL; суфікс-варіація `catalogVideoVariation(link, '#mark')` накладається після, і порівняння `old.url` ведеться над базовим.
2. **Перехід Drive→R2 — лише на межі наступного оновлення.** Чинний механізм заморожує recipe «ID→URL» на публікацію й вважає зміну URL за ту саму версію помилкою `SOURCE_CHANGED`. Тому перехід — це новий **вид посилання** (`link_kind`) у квитанції на межі нового job, а не підміна всередині публікації.
3. **Детермінована ідемпотентність копії.** Унікальність `(team_id, source_version)` для живих копій; ключ об'єкта — випадковий непрозорий, виданий один раз при створенні запису копії. Повтор/паралельний запуск знаходить ту саму копію.
4. **Multipart, відновлюване.** Частини фіксованого розміру, на кожну — SHA-256 і ETag у БД; invocation обробляє обмежену кількість частин у межах дедлайну під lease; обрив → продовження з наступної частини; `abort` невикористаних upload при failure і sweep'ом.
5. **Перевірка.** Розмір = джерело (Drive `size`); per-part SHA-256 підтверджені сховищем через `x-amz-checksum-sha256`, якщо пісочниця (T003) доведе, що R2 перевіряє заголовок на `UploadPart`, інакше — Range-readback кожної частини й власна звірка (спосіб фіксується в `parts.verified_by`); публічний HEAD повертає очікувані `content-length`/`content-type`; Range-проби початку, кінця й випадкових меж частин збігаються з Drive; якщо файл уміщається в один invocation — додатково повний MD5 проти Drive `md5Checksum`. Коли повний MD5 неможливий, це явна межа доказу (AD-006), а не прихована.
6. **Активна версія та видалення.** `catalog_video_r2_uses(catalog_material_id, source_material_id) → copy_id` каже, на яку копію каталог підтверджено для кожного відео-джерела. `confirm_use` **замінює весь набір** uses каталогу в одній транзакції: джерела, яких більше немає в каталозі, і підтвердження з `link_kind=drive` прибирають старі uses, звільнені копії стають `retiring`. Копія без жодного use (і без незавершеної публікації, що тримає recipe) → `retiring` → через вікно (6 годин) повторна перевірка нульових посилань → видалення об'єкта + purge CDN → `deleted`. Спільна копія живе, поки є хоч один use.
7. **Кілька відео в каталозі.** Варіанти (`catalog_video_variants`) мають власні `output_material_id`; «активна версія» ведеться на відео-джерело, тож окремого поняття «слот» не потрібно.
8. **Надгробки.** `catalog_video_r2_purges` без FK-каскаду на `teams`: тригер `before delete` на `copies` (стан ≠ `deleted`) записує `object_key` у надгробок; sweep видаляє об'єкт і purge'ить. Видалення простору чи каталогу не лишає об'єктів у R2.
9. **Життєвий цикл каталогу.** У домені немає стану «скасований каталог»: є кошик (`team_materials.trashed_at`, відновлюваний), зняття з автооновлення (рядок `team_catalog_updater_items` зникає) і паузи (`paused_by_tariff_at`, stop hold). Усі вони **зберігають** копії, бо виданий каталог далі посилається на R2-URL. Лише остаточне видалення матеріалу каталогу каскадно прибирає `uses` → копії `retiring` одразу (далі — вікно 6 год).
10. **Опція.** Окрема таблиця `private.catalog_video_r2_preferences` за ключем каталогу (адитивно); булева, **last-write-wins**, `revision`/`configured_by` лише для атрибуції; при створенні — частина durable create intent і конфігурації каталогу Launch (`LaunchCatalogConfig.copyVideoToR2`), застосовується тією ж транзакцією, що прив'язує матеріал каталогу; відсутній запис = вимкнено.
11. **Доступність фічі.** Серверний конфіг (`enabled`, `policy_confirmed_at`) + environment-перевірка (як `readCatalogR2Config`); UI показує галочку лише коли сервер каже «доступно»; поки `policy_confirmed_at` порожній — `POLICY_PENDING`.
12. **Фоновий запуск.** `private.invoke_catalog_video_r2_worker(route)` читає чинні vault-записи `wishly_catalog_sync_url` і `wishly_catalog_sync_secret` (як `invoke_catalog_images_worker` у 045, рядки 619–624), формує endpoint через `regexp_replace(url, '/catalog-sync/?$', '/catalog-video-r2/worker')` і шле `net.http_post` із заголовком `x-catalog-sync-secret`; `cron.schedule` для `claim` (кожні 30 с) і `sweep` (кожні 5 хв). Нових секретів і провізіонування не потрібно.
13. **Квота.** Ліміт сумарних байтів `uploading|verifying|ready|retiring` копій на простір (конфіг; початково 50 ГіБ); перевищення → копія не створюється, причина `QUOTA_EXCEEDED`, fallback Drive. Обсяг і оцінка показуються в `SpaceTariffSection.tsx`.

## Release Plan

Через адитивні зміни в `packages/shared` фіча не може піти web-only деплоєм (`verify-release.mjs:413`). Доставка:

- **A** — міграція + edge-функції на бету й прод **темно** (конфіг `enabled=false`, `policy_confirmed_at=null`). Edge і міграції не підпадають під web-only гейт і можуть піти раніше.
- **B** — повний реліз (наступний після 1.4.0) через `run-release.sh`: shared + web + перепакований агент без зміни протоколу; галочка в web прихована гейтом доступності. Бета-доказ exact-SHA, `verify-release` проходить, бо shared-зміни входять у реліз.
- **C** — тексти політики приватності/умов (у тому ж або наступному web-коміті релізу) + `docs`.
- **D** — вмикання конфігом: `enabled=true`, `policy_confirmed_at=now()` спочатку для власного простору, потім для охочих. D лише після C (FR-018) і після US3 (лише активна версія), інакше витрати ростуть.

Бета: міграція через `psql` + `schema_migrations` (migration up заблоковано чужою версією); без `db reset`.

## Risks

| Ризик | Пом'якшення |
|---|---|
| Recipe-заморозка не пускає зміну URL | Окремий `link_kind`, перехід на межі job; SQL- і vitest-тести на «Drive→R2» і «R2→Drive» |
| Web-only деплой із shared-змінами відхилено | Release Plan B: повний реліз; жодних спроб обійти `verify-release` |
| Drive-ліміти завантаження / квоти на файл | Backoff за зразком 045, `PROVIDER_RATE_LIMITED`, fallback Drive, ліміт паралелізму |
| Видалення версії, на яку ще дивиться зовнішній читач | Вікно перед видаленням + повторна перевірка нуля посилань + purge; кеші зовнішніх систем не обіцяємо |
| Витік об'єктів при видаленні простору | Надгробки без FK-каскаду + sweep; SQL-тест «tombstone survives cascade» |
| Копіювання ніколи не стартує | `cron.schedule` + інвокатор на чинному vault-секреті в тій самій міграції (без нового провізіонування); бета-перевірка, що воркер реально викликається |
| R2 ігнорує `x-amz-checksum-sha256` на `UploadPart` | Доказ на пісочниці в T003; fallback — Range-readback частини й власна звірка; спосіб у `parts.verified_by` і в журналі |
| Витрати | Лише active-версія, квота на простір, відображення обсягу/оцінки власнику |
| Політика суперечить продукту | FR-018: `POLICY_PENDING` до підтвердження політики |

## Complexity Tracking

Порушень конституції немає.
