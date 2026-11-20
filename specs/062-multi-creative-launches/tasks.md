# Tasks: Кілька креативів і зображення в каталожних запусках

**Input**: Design documents from `/specs/062-multi-creative-launches/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R29; R24–R29 перекривають попередні), data-model.md, contracts/, quickstart.md

**Tests**: обов'язкові — властивісні тести розподілу (SC-006), pgTAP для SQL, vitest для edge/web. Vitest лише single-worker; перед запуском `uptime` і `pgrep` (слабка машина, паралельні сесії). `npm run verify` локально не запускати.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Встановити залежності воркдерева й перебудувати shared: `npm ci` і `npm run build -w @video-compressor/shared` у /Users/daynero/RiderProjects/AffSupport-062
- [ ] T002 Перевірити на беті, що публічний origin бакета `soty-catalog-images-${env}-public` віддає новий об'єкт `c1/<uuid>` напряму анонімно (`curl -sI` без cookies); результат і рішення (origin чи маршрут Worker `/c/*`) записати в research.md R7

## Phase 2: Foundational (блокує всі історії)

- [x] T003 [P] Типи `LaunchCreative` (`pinned: number | null`), `LaunchCreativeKind`, поля `creatives`/`creativeKind` у `LaunchConfig`, `materials[]` у `LaunchSources`, `creativeCount`/`creativeKind` у `LaunchSummary`, константа `CATALOG_ID_PREFIX_MAX` (межа товарів — наявна `CATALOG_PRODUCT_COUNT_MAX`) у packages/shared/src/team/launches.ts
- [x] T004 [P] Тест-властивості розподілу (10 000 послідовностей, k до 400, приклади з контракту, автопідняття N) у tests/launch-creative-distribution.test.ts
- [x] T005 `evenCopies`, `dragCopies`, `setCopies`, `rescaleCopies`, `addCreatives` (автопідняття N до k), `removeCreative`, `balanceCopies`, `distributeVariations`, `isValidDistribution` у packages/shared/src/team/launches/creative-distribution.ts, експорт з індексу shared
- [x] T006 [P] Тести розбору конфігурації: нормалізація старої, коди відмов data-model, дзеркало першого, `method='other'` ⇒ k=1, `productCount < k` відхилено у tests/launch-multi-creative-config.test.ts
- [x] T007 `parseLaunchConfig`/`catalogConfig` (коди `CREATIVES_LIMIT`, `CREATIVES_MIXED`, `CREATIVE_DUPLICATE`, `DISTRIBUTION_INVALID`, `VARIATIONS_RANGE`), `parseLaunchSources` (`materials[]`) у packages/shared/src/team/launches/validation.ts
- [x] T008 Межі варіацій `k ≤ V ≤ N` з перезашивкою (`VARIATIONS_RANGE` у `parseLaunchCreatives` packages/shared/src/team/launches/validation.ts; `V ≤ N` лишився в catalog-video.ts)
- [x] T009 [P] `creatives`, `creativeKind` у whitelist `parseLaunchDraft` packages/shared/src/team/launches/persistence.ts
- [x] T010 [P] Перевірка типу кожного креативу через `sources.materials` замість `materialType !== 'video'` у packages/shared/src/team/launches/preview.ts
- [x] T011 [P] `launchCampaignName` з `+N` (`launchCreativeLabel`) і `launchCreativeIdPrefix(alias)` у packages/shared/src/team/launches/naming.ts; тести в tests/launch-multi-creative-config.test.ts
- [ ] T012 Міграція 20261220100000_launch_multi_creative_config.sql: `save_launch_draft` (UUID кожного, ≤400, унікальні, тип, дзеркало), `service_launch_sources`/`get_launch_sources` з `materials[]` і перевіркою категорії, `list_launches_pre_assignment` + `creativeCount`/`creativeKind`, назва каталогу `<stem>+N_v<n>_catalog` у `pendingCatalogName`/резерві у supabase/migrations/
- [ ] T013 [P] `catalogIdPrefix(name)` і `catalogProductId(prefix, unique)` у supabase/functions/_shared/product-details.ts; тести в tests/catalog-product-id-prefix.test.ts
- [ ] T014 pgTAP-основа: чернетка з 4 креативами, змішані типи, дубль, `productCount < k`, метод «Інше» з k>1 у supabase/tests/database/launch-multi-creative.test.sql
- [ ] T015 Паритет shared↔SQL для валідації креативів у tests/launch-shared-parity.test.ts
- [ ] T016 Міграція 20261220116000_catalog_publication_creatives_target.sql: вид цілі `creatives`, `private.catalog_publication_target_segments` (RLS, fence), реєстрація цілі для k>1/image у живому `service_begin_initial_catalog_publication` (патч 20261207191000, через `pg_get_functiondef`) у supabase/migrations/; pgTAP у supabase/tests/database/launch-multi-creative.test.sql

- [ ] T085 Аудит читачів `t.kind` цілі публікації (R31): 20261207176000 (контекст клітинок), 20261207399500 (`waiting_for_videos`), 20261207390000, 20261207192000, 20261207172000, 20261207175000, 20261207177000, 20261207195000 — кожен або обробляє `creatives`, або явно відхиляє; pgTAP-кейс на кожен у supabase/tests/database/launch-multi-creative.test.sql

**Checkpoint**: конфігурація з кількома креативами зберігається й перевіряється однаково на клієнті й сервері; каталог може мати ціль `creatives`.

## Phase 3: User Story 1 — Кілька відео в одному каталожному запуску (P1) 🎯 MVP

**Independent Test**: quickstart §1 крок 7.

- [ ] T017 [P] [US1] Тест рядків за сегментами: блоки, порядок, посилання свого відео з `?v=`, префікс ID, одиночний креатив з префіксом у tests/catalog-multi-creative-rows.test.ts
- [ ] T018 [US1] `planCatalogRows`/`buildProductCatalogRows` приймають `segments` і префікс на рядок; відеопосилання з джерела свого сегмента у supabase/functions/_shared/product-catalog.ts
- [ ] T019 [US1] План каталогу V2 із `segments` у `createCatalogInitialVideoPlan` supabase/functions/drive-ops/catalog-video-generation.ts
- [ ] T020 [US1] `createProductCatalog`: категорія кожного креативу = `creativeKind`, доказ і шеринг кожного відео, `video_material_id` = перше, snapshot `_catalogCreativeKind`/`_catalogCreatives`/`_catalogRowCreatives` у supabase/functions/drive-ops/product-catalog.ts
- [ ] T021 [US1] `executeLaunchCatalog` з креативами й сегментами, чекпойнти `source_<id>` на кожне відео у supabase/functions/drive-ops/launch-catalog.ts і supabase/functions/drive-ops/catalog-durable.ts
- [ ] T022 [US1] Edge-вхід запуску: `materials[]`, `launchPreview` для кількох у supabase/functions/drive-ops/launches.ts
- [ ] T023 [US1] Каталог з провідника: префікс ID з назви відео (`catalogIdPrefix`) у supabase/functions/drive-ops/product-catalog.ts
- [ ] T024 [US1] Оновлювач переносить `_catalogCreativeKind`/`_catalogCreatives`/`_catalogRowCreatives` у `became.snapshot`; префікс ID за `_catalogRowCreatives` у `rebuildCatalogRows`/`_catalogPublicIds`; старі — без префікса у supabase/functions/_shared/catalog-updater.ts і supabase/functions/catalog-updater/worker.ts; тест «два оновлення поспіль» у tests/catalog-updater-multi-creative.test.ts і tests/catalog-updater-ids.test.ts
- [ ] T025 [US1] Захист legacy-запису: snapshot з k>1 або image без політики → `MULTI_CREATIVE_UNSUPPORTED` замість одного `videoLinkOverride` у supabase/functions/catalog-updater/worker.ts
- [ ] T026 [P] [US1] Тест поля креативу: кидок 4 відео, список, назви, прибирання, відмова змішаного кидка, 120 креативів → N=120 у tests/launch-creative-picker.test.tsx
- [ ] T027 [US1] `LaunchCreativeList` (рядки з `MaterialPreview`, `Input`, `IconButton`; «Додати» з меню; обмежена висота з прокруткою) у apps/web/src/team/launches/LaunchCreativeList.tsx
- [ ] T028 [US1] `LaunchCreativePicker`: кілька файлів для каталогу, `accept` за типом, `TaskAttachmentPicker` без `single`, перевірка набору при підтвердженні, дубль → «вже вибрано», запис `creatives` + дзеркало + `addCreatives` у apps/web/src/team/launches/LaunchCreativePicker.tsx
- [ ] T029 [US1] `useLaunchGeneration`/`LaunchSession`: передача креативів у apps/web/src/team/launches/useLaunchGeneration.ts і apps/web/src/team/launches/LaunchSession.tsx
- [ ] T030 [P] [US1] Ключі i18n у apps/web/src/i18n.ts

## Phase 4: User Story 2 — Розподіл копій (P1)

**Independent Test**: quickstart §1 кроки 3–6.

- [ ] T031 [P] [US2] Тест компонента: повзунок 40 → 20/20/20, поля 40/30/20/10, «Порівну», N 100→200, N < k → попередження й значення k, клавіатура ±1/±10 у tests/launch-creative-distribution.test.tsx
- [ ] T032 [US2] `LaunchCreativeDistribution` (`Accordion` з підсумком, `Slider` → `dragCopies`, `Input` → `setCopies`, «Порівну», прокрутка при великих k) у apps/web/src/team/launches/LaunchCreativeDistribution.tsx; PageUp/PageDown через `onKeyDown` у apps/web/src/components/ui/Choice.tsx з оновленням specs/021-design-system-redesign/contracts/components.md, `/design` і tests/design-components.test.tsx; авторозгортання при помилці всередині (FR-009)
- [ ] T033 [US2] Підключити під «Товарів у каталозі»: `min = k`, попередження «Товарів не може бути менше, ніж креативів», `rescaleCopies`, `removeCreative` у apps/web/src/team/launches/LaunchEditor.tsx
- [ ] T034 [P] [US2] Стилі списку й розподілу — лише утиліти від токенів у самих компонентах (без нових правил у apps/web/src/styles/launch-settings.css), `node scripts/check-tailwind-classes.mjs`
- [ ] T035 [P] [US2] Варіант на сторінці `/design` у apps/web/src/dev/DesignSystemPage.tsx
- [ ] T036 [US2] Ручний розподіл на сервері (блоки з `copies`) — тест у tests/catalog-multi-creative-rows.test.ts

## Phase 5: User Story 3 — Варіації по колу (P1)

**Independent Test**: quickstart §2.

- [ ] T037 [P] [US3] pgTAP: 4 набори на інтент, `(intent, source)`, чуже джерело відхилено, wait чекає всі, `assignment_seed`, retry сегмента у supabase/tests/database/launch-multi-creative.test.sql
- [ ] T038 [US3] Міграція 20261220110000_launch_catalog_video_segments.sql: `private.launch_catalog_video_segments` (RLS, імутабельність, fence, `assignment_seed`), унікальності `catalog_video_sets`/`catalog_video_recipe_references`, accept за `(intent, source)` у живому `service_accept_catalog_video_set_before_foreground` (20261207180000:286, патч 20261207199000:117) через `pg_get_functiondef`, `service_accept_launch_catalog_video_generation` з `plan.segments`, `service_wait_launch_catalog_video` (`failedOrdinal`), прогрес/`videoGeneration` у ланцюжку `get_launch` (`get_launch_before_started_at`), `list_launches_pre_assignment`, `retry_launch_catalog_video_segment`, reuse лише k=1 у supabase/migrations/
- [ ] T039 [US3] `prepareLaunchCatalogVideoAdmission`: сегменти, `distributeVariations`, зерно `hex(sha256(seed ‖ ':' ‖ ordinal))`, передній режим лише k=1 у supabase/functions/drive-ops/launch-catalog-video.ts
- [ ] T040 [US3] `resolveCatalogReadyLinks` — наявна per-set RPC по разу на сегмент у supabase/functions/drive-ops/catalog-initial-video-authority.ts; `prepareCatalogInitialVideo` у supabase/functions/drive-ops/catalog-video-generation.ts
- [ ] T041 [P] [US3] Тести 4 відео × 30 варіацій, збій одного набору, повтор без перерахунку готових у tests/launch-catalog-video-admission.test.ts і tests/launch-catalog-video-execution.test.ts
- [ ] T042 [US3] Поле варіацій min=k, max=N, підказка `8 · 8 · 7 · 7` у apps/web/src/team/launches/LaunchCatalogVideoFields.tsx і apps/web/src/team/product-catalog/CatalogCreationVideoFields.tsx; тест у tests/launch-catalog-video-fields.test.tsx
- [ ] T043 [US3] Повтор невдалого сегмента з результатів запуску у apps/web/src/team/launches/ і supabase/functions/drive-ops/launches.ts

## Phase 6: User Story 4 — Зображення як креативи (P1)

**Independent Test**: quickstart §3.

- [ ] T044 [P] [US4] pgTAP: резервація/дедуп/commit/fail, uses → retiring 6 год, sweep, RLS у supabase/tests/database/launch-creative-images.test.sql
- [ ] T045 [US4] Міграція 20261220115000_catalog_image_creatives_invariants.sql: `video_link` nullable для image, гілки image в `catalog_image_begin_intent_legacy`, `service_initial_catalog_video_context`, `service_accept_launch_catalog_video_generation` у supabase/migrations/
- [ ] T046 [US4] Міграція 20261220120000_launch_creative_images.sql: `private.launch_creative_images`, `private.launch_creative_image_uses` (RLS, fence), RPC з contracts/rpc.md, cron sweep у supabase/migrations/
- [ ] T047 [US4] Фабрика з `readDrive` у supabase/functions/_shared/catalog-drive-image-read.ts; supabase/functions/catalog-images/drive-sources.ts імпортує звідти
- [ ] T048 [US4] Ключі `c1/<uuid>` у supabase/functions/_shared/r2-catalog-images.ts (або маршрут Worker за T002)
- [ ] T049 [US4] Публікація посилання креативу: R2 (резерв → читання → `optimizeCatalogImage` → `putFinal` → `verify(publicRead)` → commit) або Drive (`ensureAnyoneReader` + `driveImageLink` + анонімна перевірка) за преференцією R2 у supabase/functions/drive-ops/creative-images.ts; тест у tests/launch-creative-images.test.ts
- [ ] T050 [US4] Крок `creativeImages` з чекпойнтом на зображення в supabase/functions/drive-ops/catalog-durable.ts; пул білих тягнеться як завжди (R25)
- [ ] T051 [US4] Рядки зображень: вміст від білої картинки (ідентично), `imageLink` = посилання креативу (без розкладу), Z порожня, AA `videoTag=''` (і при створенні, і в оновлювачі) у supabase/functions/_shared/product-catalog.ts; виняток для посилань креативів сегментів у `catalogImagesInRows` (мапа дозволених посилань) у supabase/functions/_shared/catalog-image-rows.ts (SQL `service_catalog_image_validate_uses_v3` без змін — `pictureImage` лишається білою)
- [ ] T052 [P] [US4] Тест рядків зображень: тексти = як для білих (той самий draw), H = креатив, Z/AA порожні у tests/catalog-multi-creative-rows.test.ts
- [ ] T053 [US4] Оновлювач для зображень: білі перетягуються для текстів як завжди, H — збережена колонка (`catalogPreservedColumnIndices`, R30) у nonvideo-writer і `rebuildCatalogRows`, порожній `video_link` дозволений у `parseClaimedCatalog` у supabase/functions/_shared/catalog-updater.ts, supabase/functions/catalog-updater/nonvideo-writer.ts і supabase/functions/catalog-updater/worker.ts; тест «H не змінюється після двох оновлень, тексти змінились» у tests/catalog-updater-multi-creative.test.ts
- [ ] T086 [US4] Підтвердження `launch_creative_image_uses` при реєстрації каталогу (не при записі H), щоб розклад не втратив `c1/` об'єкт (R33) у supabase/functions/drive-ops/catalog-durable.ts і міграції 20261220120000; pgTAP
- [ ] T087 [US4] `verifyAnonymousImage` (Drive: `GET` з `credentials:'omit'`, `image/*`, довжина) у supabase/functions/_shared/catalog-image-sharing.ts; тест у tests/launch-creative-images.test.ts
- [ ] T088 [US4] `set_catalog_creative_image_r2(p_catalog, p_enabled)` → негайна задача публікації H (R32) у міграції 20261220140000 і виклик з apps/web/src/team/product-catalog/CatalogVideoR2Toggle.tsx
- [ ] T054 [US4] Sweep `c1/` (видалити, 404, purge CDN) у supabase/functions/catalog-images/worker.ts
- [ ] T055 [US4] Редактор для зображень: без перезашивки/варіацій/тривалості; R2 лишається з підписом без «відео» (`CatalogVideoR2Toggle`, режим `image` з власною доступністю, R32); розклад доступний з підказкою `launchImagesScheduleHint`; формат на вході у apps/web/src/team/launches/LaunchEditor.tsx, apps/web/src/team/product-catalog/CatalogVideoR2Toggle.tsx і apps/web/src/team/launches/LaunchCreativePicker.tsx

## Phase 7: User Story 5 — Без змішування (P2)

- [ ] T056 [P] [US5] Тести: змішаний кидок, змішаний вибір з простору (при підтвердженні), `accept`, змішана вставка/чернетка → `CREATIVES_MIXED` у tests/launch-creative-picker.test.tsx і tests/launch-multi-creative-config.test.ts
- [ ] T057 [US5] Фільтр типу у виборі з простору у apps/web/src/team/launches/LaunchCreativePicker.tsx
- [ ] T058 [US5] «Каталог» → «Інше» при k>1: лишається перший, пояснення у apps/web/src/team/launches/LaunchEditor.tsx

## Phase 8: User Story 6 — Пакет, назви, ранги, менеджер, розклад, оновлювач (P2)

- [ ] T059 [P] [US6] Тест пакета: 3 копії запуску з 4 креативами й ручним розподілом у tests/launch-multi-creative-batch.test.ts
- [ ] T060 [US6] `prepareLaunchBatch` (сегменти, `materials[]`) у supabase/functions/drive-ops/launch-batch.ts
- [ ] T061 [US6] `productCatalogName` з `+N` у supabase/functions/_shared/product-catalog.ts; паритет із SQL у tests/launch-catalog.test.ts
- [ ] T062 [US6] Картка `alias +N` і значок типу, деталі/результати зі списком креативів у apps/web/src/team/launches/
- [ ] T063 [US6] Міграція 20261220130000_launch_multi_creative_ranks.sql (події з `material_id`, кредит кожному, поглинання для збіжного); pgTAP у supabase/tests/database/creative-ranks.test.sql
- [ ] T064 [US6] Розклад для кількох креативів: лінія публікації по сегментах цілі `creatives` — колонка як параметр за видом сегмента (Z для відео, H для зображень; старі заморожені payload лишаються розбірними), резолвер посилань зображень (`c1/` запис або `driveImageLink`), маркер публікації для H, повторне анонімне читання в `prepare` (R33), оновлення `_catalogCreatives[].link` при підтвердженому записі у supabase/functions/catalog-updater/publication-io.ts і supabase/functions/catalog-updater/publication-cells.ts; SQL-контекст задач у міграції 20261220140000_catalog_updater_multi_creative.sql; тест у tests/catalog-publication-multi-creative.test.ts
- [ ] T065 [US6] Перезашивка оновлювачем по сегментах (R28, R31): `catalog_video_sets` `unique(update_attempt_id, source_material_id)`, `catalog_updater_variant_requests.attempt_id`, PK `catalog_variant_round_snapshots`, `catalog_video_recipe_references unique(update_attempt_id)`, пошук accept і advisory lock — до `(attempt, source)`; нова ревізія цілі `creatives` з id нових наборів; `distributeVariations` профілю, нормалізація `max(V, k)` у міграції 20261220140000 і supabase/functions/catalog-updater/worker.ts; pgTAP + tests/catalog-updater-multi-creative.test.ts
- [ ] T066 [US6] R2 для кількох відео: `catalog_video_r2_cell_sources`/`catalog_video_r2_reconcile` по відео-сегментах цілі `creatives`, image-сегменти виключені (R32) — SQL у 20261220140000; `confirm_use` уже приймає масив (без змін); тест у tests/catalog-updater-multi-creative.test.ts
- [ ] T067 [US6] Відмови `MULTI_CREATIVE_UNSUPPORTED` для прихованих дій (R27, R34): заміна відео (20261208110000), перевірка посилань (20261207290000), `patch_team_catalog_update_profile` (20261207174000 + overlay 20261208100100:437) для `random_link_variation`/`refresh_images`/`grow_products` і `restitch` для зображень; ті самі прапорці примусово вимкнені при створенні профілю (дефолти 20261203110000:171-177) і ігноруються в claim (worker.ts:360-367) — у міграції 20261220140000; pgTAP
- [ ] T068 [US6] Менеджер каталогів: поля `creativeKind`/`creatives` у `list_team_catalog_update_profiles` (міграція 20261220140000); список креативів; іконки за таблицею R27/R35 у apps/web/src/team/catalog-updater/CatalogIconControls.tsx, CatalogProfileEditor.tsx, UpdaterRowActions.tsx (кількість варіацій прихована для зображень); «Замінити відео» не рендериться з apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx; CatalogBulkEditor.tsx/CatalogDefaultsEditor.tsx пропускають приховані поля для таких каталогів із лічильником; тест у tests/ (наявні тести іконок оновлювача)
- [ ] T069 [US6] Нормалізація профілю при застосуванні: зображення → перезашивка вимкнена; k відео → `V = max(V, k)` у packages/shared/src/team/launches/validation.ts і місці застосування профілю
- [ ] T070 [US6] Регресія старих запусків у tests/launch-persistence.test.ts і tests/launch-original-video.test.ts

## Phase 9: Polish & Cross-Cutting

- [ ] T071 [P] Міграція 20261220150000_launch_multi_creative_analytics.sql: нові ключі в `analytics_properties_are_safe_v2`
- [ ] T072 [P] Коди R17 у `LAUNCH_ANALYTICS_CODES` (packages/shared/src/team/launches/lifecycle.ts) і `TEAM_ERROR_CODES` (packages/shared/src/team/transport.ts)
- [ ] T073 [P] scripts/analytics/code-map.ts (+ tests/analytics-code-map.test.ts) і coverage-registry.ts
- [ ] T074 Типізовані події, стадії `creative_image.*`, санітайзер; тест у tests/catalog-generation-diagnostic-producer.test.ts
- [ ] T075 AN-005: inspect/investigate показує `creativeCount`, `creativeOrdinal`, `failedOrdinal` — scripts/analytics/ + фікстура в tests/
- [ ] T076 Статичні гейти: `node scripts/check-design-tokens.mjs`, `node scripts/check-tailwind-classes.mjs`, `node scripts/verify-styles.mjs`, lint і typecheck змінених воркспейсів
- [ ] T077 Пов'язані тести single-worker після `uptime`/`pgrep`
- [ ] T078 Накат міграцій 062 на бету через psql + `schema_migrations`, pgTAP у rolled-back транзакції
- [ ] T089 Перевірити Realtime: зміна стану сегмента, повтор сегмента й H-публікація торкаються таблиць, на які вже підписаний шов команди (менеджер і картка запуску оновлюються без перезавантаження); за потреби — тригер-«дотик» наявної підписаної таблиці
- [ ] T079 Приймання на беті за quickstart.md через Playwright-драйвер (обидві теми, desktop і вузька форма, клавіатура)
- [ ] T080 RELEASE_NOTES.md (розділ next)
- [ ] T081 Зворотні кроки кожної міграції 062 у supabase/migrations/ROLLBACK.md
- [ ] T082 `npm run types:supabase` після міграцій і перевірка типів веба

## Dependencies & Execution Order

- Setup → Foundational (T003–T016) → історії.
- US1 (T017–T030) — MVP; US2 залежить від T005, T027, T028.
- US3 залежить від US1 (сегменти в плані/рядках).
- US4 залежить від Foundational (T016) і T018/T020; T045 перед T046/T050; незалежна від US3.
- US6: T064–T068 — після US1 і US4 (сегменти цілі, рядки зображень); T065 — після US3.
- T024/T025 обов'язкові до будь-якого приймання оновлювача.
- Polish — після всіх історій.

## Parallel Execution Examples

- Foundational: T003, T004, T006, T009, T010, T011, T013.
- US1: T017, T026, T030; далі T018→T019→T020→T021.
- US4: T044, T047, T048; далі T045→T046→T049→T050→T051.

## Implementation Strategy

1. MVP = Phase 1–3.
2. US2 → US3 і US4 паралельно → US5 → US6 → Polish.
3. Реліз — повним раннером на next після приймання на беті; прод не чіпати.
