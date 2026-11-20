# Tasks: Кілька креативів і зображення в каталожних запусках

**Input**: Design documents from `/specs/062-multi-creative-launches/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: обов'язкові — властивісні тести розподілу (SC-006), pgTAP для SQL, vitest для edge/web. Запуск vitest лише single-worker; перед запуском `uptime` і `pgrep` (слабка машина, паралельні сесії). `npm run verify` локально не запускати.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Встановити залежності воркдерева й перебудувати shared: `npm ci` і `npm run build -w @video-compressor/shared` у /Users/daynero/RiderProjects/AffSupport-062
- [ ] T002 Перевірити, що публічний origin бакета `soty-catalog-images-${env}-public` віддає новий об'єкт напряму анонімно (тестовий `c1/` об'єкт на беті, `curl -sI` без cookies); результат і рішення (origin чи маршрут Worker `/c/*`) записати в specs/062-multi-creative-launches/research.md R7

## Phase 2: Foundational (блокує всі історії)

- [ ] T003 [P] Додати типи `LaunchCreative`, `LaunchCreativeKind`, поля `creatives`/`creativeKind` у `LaunchConfig`, `materials[]` у `LaunchSources`, `creativeCount`/`creativeKind` у `LaunchSummary`, константи `LAUNCH_CREATIVES_MAX`, `CATALOG_ID_PREFIX_MAX` у packages/shared/src/team/launches.ts
- [ ] T004 [P] Тест-властивості розподілу (10 000 послідовностей, приклади з контракту) у tests/launch-creative-distribution.test.ts
- [ ] T005 Реалізувати `evenCopies`, `dragCopies`, `setCopies`, `rescaleCopies`, `removeCreative`, `balanceCopies`, `distributeVariations`, `isValidDistribution` у packages/shared/src/team/launches/creative-distribution.ts і експортувати з індексу shared
- [ ] T006 [P] Тести розбору конфігурації: нормалізація старої (без `creatives`), усі коди відмов з data-model, дзеркало першого, `method='other'` ⇒ k=1 у tests/launch-multi-creative-config.test.ts
- [ ] T007 Розширити `parseLaunchConfig`/`catalogConfig` (коди `CREATIVES_LIMIT`, `CREATIVES_MIXED`, `CREATIVE_DUPLICATE`, `DISTRIBUTION_INVALID`, `VARIATIONS_RANGE`, `SCHEDULE_SINGLE_CREATIVE_ONLY`) і `parseLaunchSources` (`materials[]`) у packages/shared/src/team/launches/validation.ts
- [ ] T008 Межі варіацій `k ≤ V ≤ N` з перезашивкою у `parseLaunchCatalogVideoConfig` packages/shared/src/team/launches/catalog-video.ts
- [ ] T009 [P] Додати `creatives`, `creativeKind` у whitelist `parseLaunchDraft` packages/shared/src/team/launches/persistence.ts
- [ ] T010 [P] `preview.ts`: перевірка типу кожного креативу через `sources.materials` замість `materialType !== 'video'` (packages/shared/src/team/launches/preview.ts:30-31)
- [ ] T011 [P] `launchCampaignName` з суфіксом `+N` і `launchCreativeIdPrefix(alias)` у packages/shared/src/team/launches/naming.ts; оновити tests/launch-generators.test.ts
- [ ] T012 Міграція 20261220100000_launch_multi_creative_config.sql: `save_launch_draft` (UUID кожного, ≤10, унікальні, тип, дзеркало), `service_launch_sources`/`get_launch_sources` з `materials[]` і перевіркою категорії, `list_launches_pre_assignment` + `creativeCount`/`creativeKind` у supabase/migrations/
- [ ] T013 [P] `catalogIdPrefix(name)` (транслітерація укр. для назв відео) і `catalogProductId(prefix, unique)` у supabase/functions/_shared/product-details.ts; тести формату в tests/catalog-product-id-prefix.test.ts
- [ ] T014 pgTAP-основа: чернетка з 4 креативами, змішані типи, дубль, 11 креативів у supabase/tests/database/launch-multi-creative.test.sql
- [ ] T015 Тест паритету shared↔SQL для валідації креативів (додати кейси) у tests/launch-shared-parity.test.ts

**Checkpoint**: конфігурація з кількома креативами зберігається, розбирається й відхиляється однаково на клієнті й сервері.

## Phase 3: User Story 1 — Кілька відео в одному каталожному запуску (P1) 🎯 MVP

**Goal**: 4 відео → один каталог з суцільними блоками, кожен блок — своє відео, ID з префіксом.

**Independent Test**: quickstart §1 крок 7 (без перезашивки).

- [ ] T016 [P] [US1] Тест рядків за сегментами: блоки, порядок, посилання свого відео з `?v=`, префікс ID, одиночний креатив теж з префіксом у tests/catalog-multi-creative-rows.test.ts
- [ ] T017 [US1] `planCatalogRows`/`buildProductCatalogRows` приймають `segments` і `idPrefix` на рядок; відео-посилання з джерела свого сегмента у supabase/functions/_shared/product-catalog.ts
- [ ] T018 [US1] План каталогу V2 із `segments` (`createCatalogInitialVideoPlan`) у supabase/functions/drive-ops/catalog-video-generation.ts
- [ ] T019 [US1] `createProductCatalog`: перевірка категорії кожного креативу = `creativeKind`, доказ і шеринг кожного відео, `video_material_id` = перше, snapshot `_catalogCreativeKind`/`_catalogCreatives`/`_catalogRowCreatives` у supabase/functions/drive-ops/product-catalog.ts
- [ ] T020 [US1] `executeLaunchCatalog` передає креативи й сегменти; чекпойнти `source_<id>` на кожне відео у supabase/functions/drive-ops/launch-catalog.ts і supabase/functions/drive-ops/catalog-durable.ts
- [ ] T021 [US1] Edge-вхід запуску: `service_launch_sources` з `materials[]`, `launchPreview` для кількох у supabase/functions/drive-ops/launches.ts
- [ ] T022 [US1] Каталог з провідника: префікс ID з назви відео через `catalogIdPrefix` у supabase/functions/drive-ops/product-catalog.ts (шлях `CreateProductCatalogDialog`)
- [ ] T023 [US1] Оновлювач: префікс ID за `_catalogRowCreatives` у `rebuildCatalogRows` і `_catalogPublicIds`; старі каталоги — без префікса у supabase/functions/_shared/catalog-updater.ts і supabase/functions/catalog-updater/worker.ts; тест у tests/catalog-updater-ids.test.ts
- [ ] T024 [P] [US1] Тест поля креативу: кидок 4 відео, список, редагування назви, прибирання, відмова змішаного кидка у tests/launch-creative-picker.test.tsx
- [ ] T025 [US1] Компонент `LaunchCreativeList` (рядки: `MaterialPreview`, `Input` назви, `IconButton` прибрати, кнопка «Додати» з меню) у apps/web/src/team/launches/LaunchCreativeList.tsx
- [ ] T026 [US1] `LaunchCreativePicker`: кілька файлів для каталогу, `accept` за типом списку, `TaskAttachmentPicker` без `single`, запис `creatives` + дзеркало, дубль → «вже вибрано» у apps/web/src/team/launches/LaunchCreativePicker.tsx
- [ ] T027 [US1] `useLaunchGeneration`/`LaunchSession`: передача креативів, перший як `sourceMaterialId` у apps/web/src/team/launches/useLaunchGeneration.ts і apps/web/src/team/launches/LaunchSession.tsx
- [ ] T028 [P] [US1] Ключі i18n (поле креативу, помилки, дубль) у apps/web/src/i18n.ts

- [ ] T070 [US1] Перенести `_catalogCreativeKind`/`_catalogCreatives`/`_catalogRowCreatives` у `became.snapshot` оновлювача (повна заміна в `service_complete_catalog_update`), ріст дописує ordinal нового рядка у supabase/functions/catalog-updater/worker.ts; тест «два оновлення поспіль → префікс, тип, блоки» для запуску, зображень і каталогу з провідника у tests/catalog-updater-multi-creative.test.ts
- [ ] T071 [US1] Міграція 20261220116000_catalog_publication_creatives_target.sql: вид цілі `creatives`, таблиця `private.catalog_publication_target_segments` (RLS, fence), реєстрація цілі для k>1/image замість `source`/`video_set` (169000:571-577) у supabase/migrations/; pgTAP у supabase/tests/database/launch-multi-creative.test.sql
- [ ] T072 [US1] Захист legacy-запису оновлювача: snapshot з k>1 або image → `MULTI_CREATIVE_UNSUPPORTED` замість одного `videoLinkOverride` у supabase/functions/catalog-updater/worker.ts; тест у tests/catalog-updater-multi-creative.test.ts

**Checkpoint**: MVP — кілька відео без перезашивки з рівним поділом генеруються в один каталог.

## Phase 4: User Story 2 — Розподіл копій між креативами (P1)

**Goal**: згорнутий блок розподілу з повзунками, полями й «Порівну».

**Independent Test**: quickstart §1 кроки 3–6.

- [ ] T029 [P] [US2] Тест компонента: повзунок 40 → 20/20/20 (компенсують усі), послідовне введення в поля 40/30/20/10, «Порівну», N 100→200, N < k помилка й авторозгортання, клавіатура ±1/±10, aria-label у tests/launch-creative-distribution.test.tsx
- [ ] T030 [US2] Компонент `LaunchCreativeDistribution` (`Accordion` з підсумком, `Slider` → `dragCopies`, `Input` → `setCopies`, `Button` «Порівну») у apps/web/src/team/launches/LaunchCreativeDistribution.tsx; PageUp/PageDown ±10 через `onKeyDown` обгортки в apps/web/src/components/ui/Choice.tsx
- [ ] T031 [US2] Підключити під «Товарів у каталозі», `rescaleCopies` при зміні N, `removeCreative` при прибиранні, валідація N ≥ k у apps/web/src/team/launches/LaunchEditor.tsx
- [ ] T032 [P] [US2] Стилі розміщення лише утилітами від токенів (без літералів), вузька форма у apps/web/src/styles/launch-settings.css
- [ ] T033 [P] [US2] Варіант на сторінці `/design` (k=4, помилка) у apps/web/src/dev/DesignSystemPage.tsx
- [ ] T034 [US2] Сервер приймає ручний розподіл: рядки сегментів з `copies` (не рівний поділ) — тест у tests/catalog-multi-creative-rows.test.ts

**Checkpoint**: оператор задає довільний розподіл, сума завжди N, значення переживають перезавантаження.

## Phase 5: User Story 3 — Варіації по колу між відео (P1)

**Goal**: 30 варіацій на 4 відео → 8/8/7/7, набір перезашивки на кожне відео.

**Independent Test**: quickstart §2.

- [ ] T035 [P] [US3] pgTAP: 4 набори на один інтент, `(intent, source)` унікальність, accept з чужим джерелом відхилено, wait чекає всі, `assignment_seed` сегмента, retry лише невдалого сегмента у supabase/tests/database/launch-multi-creative.test.sql
- [ ] T036 [US3] Міграція 20261220110000_launch_catalog_video_segments.sql: таблиця `private.launch_catalog_video_segments` (RLS, імутабельність, `task_cleanup_reference_fence`), зміна унікальностей `catalog_video_sets`/`catalog_video_recipe_references`, `service_accept_catalog_video_set` за `(intent, source)`, `service_accept_launch_catalog_video_generation` з `plan.segments`, `service_wait_launch_catalog_video` (усі набори, `failedOrdinal`), прогрес і `videoGeneration` у ланцюжку `get_launch` (переозначити `get_launch_before_started_at`, тіло з 20261207177000), `list_launches_pre_assignment` `videoGeneration` агрегатом, колонка `assignment_seed`, RPC `retry_launch_catalog_video_segment`, `launch_ready_video_reuse` лише k=1 у supabase/migrations/
- [ ] T037 [US3] `prepareLaunchCatalogVideoAdmission`: сегменти, `distributeVariations`, призначення на сегмент із зерном `hex(sha256(seed ‖ ':' ‖ ordinal))` (тест паритету з SQL), передній режим лише k=1 (інакше `service_retire_unused_catalog_video_foreground`) у supabase/functions/drive-ops/launch-catalog-video.ts
- [ ] T038 [US3] `resolveCatalogReadyLinks` викликає наявну `service_initial_catalog_video_outputs` по разу на сегмент і склеює в порядку `recipeRowIds` у supabase/functions/drive-ops/catalog-initial-video-authority.ts; `prepareCatalogInitialVideo` у supabase/functions/drive-ops/catalog-video-generation.ts
- [ ] T039 [P] [US3] Тести допуску й виконання для 4 відео × 30 варіацій, збій одного набору → `failedOrdinal`, повтор без перерахунку готових у tests/launch-catalog-video-admission.test.ts і tests/launch-catalog-video-execution.test.ts
- [ ] T040 [US3] Поле варіацій: min=k, max=N, наживо підказка роздачі `8 · 8 · 7 · 7` у apps/web/src/team/launches/LaunchCatalogVideoFields.tsx і apps/web/src/team/product-catalog/CatalogCreationVideoFields.tsx; тест у tests/launch-catalog-video-fields.test.tsx

- [ ] T073 [US3] Повтор одного невдалого набору з результатів запуску (кнопка біля креативу з `failedOrdinal`) у apps/web/src/team/launches/ (результати) і виклик `retry_launch_catalog_video_segment` з edge supabase/functions/drive-ops/launches.ts

**Checkpoint**: перезашивка кількох відео через фоновий агент, без змін агента.

## Phase 6: User Story 4 — Зображення як креативи (P1)

**Goal**: зображення замість білих, без відео й перезашивки.

**Independent Test**: quickstart §3.

- [ ] T041 [P] [US4] pgTAP: резервація/дедуп/commit/fail, uses → retiring через 6 год, sweep, RLS у supabase/tests/database/launch-creative-images.test.sql
- [ ] T074 [US4] Міграція 20261220115000_catalog_image_creatives_invariants.sql: `team_product_catalogs.video_link` nullable для `_catalogCreativeKind='image'`, гілки image в `catalog_image_begin_intent_legacy` (20261206155000:81), `service_initial_catalog_video_context` (169000:619) і `service_accept_launch_catalog_video_generation` (план із сегментами без наборів); pgTAP у supabase/tests/database/launch-creative-images.test.sql
- [ ] T042 [US4] Міграція 20261220120000_launch_creative_images.sql: `private.launch_creative_images`, `private.launch_creative_image_uses` (RLS, fence-тригери), RPC з contracts/rpc.md у supabase/migrations/
- [ ] T043 [US4] Винести фабрику з `readDrive` (пошук рядка, облікові дані, докази) в supabase/functions/_shared/catalog-drive-image-read.ts; supabase/functions/catalog-images/drive-sources.ts імпортує звідти без зміни поведінки
- [ ] T044 [US4] Дозволити ключі `c1/<uuid>` (форма як `v1/`/`g1/`) у `CatalogImageR2` supabase/functions/_shared/r2-catalog-images.ts (або маршрут Worker за T002)
- [ ] T045 [US4] Публікація зображень креативу (резерв → читання → `optimizeCatalogImage` → `putFinal` → `verify(publicRead)` → commit; коди `CREATIVE_IMAGE_FORMAT`/`CREATIVE_IMAGE_TOO_LARGE`/`PUBLIC_READ_UNVERIFIED`) у supabase/functions/drive-ops/creative-images.ts; тест у tests/launch-creative-images.test.ts
- [ ] T046 [US4] Крок `creativeImages` з чекпойнтом на зображення, пропуск пулу білих (`drawImages`, `bindGlobalImageCatalog`, `finalizeImageUses`) для каталогу зображень, `service_confirm_launch_creative_image_uses` після запису у supabase/functions/drive-ops/catalog-durable.ts
- [ ] T047 [US4] Рядки зображень: `imageLink` креативу, `pictureImage {kind:'creative'}`, `pictureName=null`, порожні Z/AA у supabase/functions/_shared/product-catalog.ts; `catalogImagesInRows`/`validateImageUses` приймають `creative` у supabase/functions/_shared/catalog-image-rows.ts
- [ ] T048 [P] [US4] Тест рядків зображень (нейтральний 055, порожні відео-колонки, без лічильників пулу) у tests/catalog-multi-creative-rows.test.ts
- [ ] T049 [US4] Оновлювач для каталогу зображень: без `refresh_images` у supabase/functions/catalog-updater/claim-preparation.ts; порожній `video_link` дозволений і URL креативу в `planAutomaticUpdateRows`/`refreshedRows`/`addedRows` у supabase/functions/catalog-updater/worker.ts; тест у tests/catalog-updater-multi-creative.test.ts
- [ ] T050 [US4] Sweep `c1/` (видалити, 404, purge CDN) у supabase/functions/catalog-images/worker.ts і cron у міграції 20261220120000
- [ ] T051 [US4] Редактор: для зображень не рендерити перезашивку, варіації, тривалість, R2-копію відео; формат JPEG/PNG/WebP ≥ 500 px перевіряти на вході у apps/web/src/team/launches/LaunchEditor.tsx і apps/web/src/team/launches/LaunchCreativePicker.tsx

**Checkpoint**: каталог із зображень з анонімно читаними `c1/` посиланнями й без білих.

## Phase 7: User Story 5 — Відео й зображення не змішуються (P2)

**Independent Test**: quickstart §3 крок 3 + вставка змішаної конфігурації.

- [ ] T052 [P] [US5] Тести: змішаний кидок, `accept` за типом списку, вибір з простору фільтрує тип, змішана вставка/чернетка відхилена `CREATIVES_MIXED` у tests/launch-creative-picker.test.tsx і tests/launch-multi-creative-config.test.ts
- [ ] T053 [US5] Фільтр типу у виборі з простору (`TaskAttachmentPicker` props) у apps/web/src/team/launches/LaunchCreativePicker.tsx
- [ ] T075 [US5] Набір із вибору з простору перевіряється при підтвердженні: змішаний — відхиляється цілком із поясненням (accept `TaskAttachmentPicker` фіксується на відкритті) у apps/web/src/team/launches/LaunchCreativePicker.tsx
- [ ] T054 [US5] Перемикання методу «Каталог» → «Інше» при k>1: лишається перший, пояснення; назад — список не відновлюється мовчки у apps/web/src/team/launches/LaunchEditor.tsx

## Phase 8: User Story 6 — Пакет, копіювання, назви, ранги (P2)

**Independent Test**: quickstart §4.

- [ ] T055 [P] [US6] Тест пакета: 3 копії запуску з 4 креативами й ручним розподілом, недійсний сусід не блокує у tests/launch-multi-creative-batch.test.ts
- [ ] T056 [US6] Перевірити й за потреби доповнити `prepareLaunchBatch` (сегменти, `materials[]`) у supabase/functions/drive-ops/launch-batch.ts
- [ ] T057 [US6] Назва каталогу `<stem першого>+N_v<n>_catalog` у `productCatalogName` supabase/functions/_shared/product-catalog.ts і SQL `pendingCatalogName`/резерв у міграції 20261220100000; тест паритету в tests/launch-catalog.test.ts
- [ ] T058 [US6] Картка `alias +N` і значок типу, деталі/результати зі списком креативів (копії, варіації) у apps/web/src/team/launches/ (картка списку, LaunchPreview, результати)
- [ ] T059 [US6] Міграція 20261220130000_launch_multi_creative_ranks.sql: унікальність подій з `material_id`, `credit_launch_rank`/`backfill_creative_ranks` по `creatives`, поглинання лише для збіжного матеріалу; pgTAP-кейси в supabase/tests/database/creative-ranks.test.sql
- [ ] T060 [US6] Міграція 20261220140000_catalog_growth_by_creative.sql: ріст обирає креатив з найбільшим відставанням частки, далі найменш завантажену варіацію його набору; для зображень — URL креативу; тест у tests/catalog-updater-multi-creative.test.ts
- [ ] T061 [US6] Розклад публікації: прихований з поясненням для k>1 і зображень у apps/web/src/team/launches/LaunchEditor.tsx; сервер відхиляє `SCHEDULE_SINGLE_CREATIVE_ONLY` (shared T007 + edge supabase/functions/drive-ops/launches.ts)
- [ ] T076 [US6] Відмови `MULTI_CREATIVE_UNSUPPORTED` для цілі `creatives`: заміна відео (20261208110000), перевірка поточних посилань (20261207290000), R2-перевипуск (…195000), перезашивка оновлювачем (гілка update 20261207168000) — у міграції 20261220116000; pgTAP-кейси
- [ ] T077 [US6] Менеджер каталогів: список креативів у деталях каталогу, приховані «Замінити відео»/перевірка посилань/R2-перевипуск/перезашивка профілю з поясненням для k>1 і зображень у apps/web/src/team/product-catalog/ (CatalogVideoReplacementDialog.tsx і деталі каталогу)
- [ ] T078 [US6] Нормалізація профілю при застосуванні: зображення → перезашивка вимкнена; k відео → `V = max(V, k)` у packages/shared/src/team/launches/validation.ts і місці застосування профілю в apps/web/src/team/launches/
- [ ] T062 [US6] Регресія старих запусків: відкриття, копіювання, перегенерація конфігурації без `creatives` у tests/launch-persistence.test.ts і tests/launch-original-video.test.ts

## Phase 9: Polish & Cross-Cutting

- [ ] T063 [P] Міграція 20261220150000_launch_multi_creative_analytics.sql: ключі `creativeKind`/`creativeCount`/`productCount`/`variationCount`/`customDistribution`/`creativeOrdinal`/`failedOrdinal` у whitelist `analytics_properties_are_safe_v2` (на основі 20261218100000) у supabase/migrations/
- [ ] T079 [P] Коди відмов з research R17 у `LAUNCH_ANALYTICS_CODES` packages/shared/src/team/launches/lifecycle.ts і `TEAM_ERROR_CODES` packages/shared/src/team/transport.ts
- [ ] T080 [P] Мапа кодів і реєстр покриття: scripts/analytics/code-map.ts (+ tests/analytics-code-map.test.ts) і coverage-registry.ts (обов'язково за AGENTS.md)
- [ ] T081 Типізовані події й санітайзер (без назв/URL), стадії `creative_image.*`; тест у tests/catalog-generation-diagnostic-producer.test.ts
- [ ] T064 Сценарій AN-005: inspect/investigate запуску показує `creativeCount`, `creativeOrdinal`, `failedOrdinal` і код причини — запит у scripts/analytics/ і тест-фікстура в tests/ поряд з наявними тестами investigate запусків
- [ ] T065 Статичні гейти дизайну без повного verify: `node scripts/check-design-tokens.mjs`, `node scripts/check-tailwind-classes.mjs`, `node scripts/verify-styles.mjs`, lint і typecheck змінених воркспейсів
- [ ] T066 Пов'язані тести single-worker (усі файли з цього tasks.md + наявні launch*/catalog*), після `uptime`/`pgrep`
- [ ] T067 Накат міграцій 062 на бету через psql + `schema_migrations`, pgTAP у rolled-back транзакції
- [ ] T068 Приймання на беті за quickstart.md §1–7 через Playwright-драйвер (обидві теми, 390 px і desktop, клавіатура)
- [ ] T069 Оновити RELEASE_NOTES.md (розділ next) і docs, якщо змінено поведінку каталогу

## Dependencies & Execution Order

- Setup (T001–T002) → Foundational (T003–T015) → історії.
- US1 (T016–T028) — MVP; US2 залежить від T025/T026 (список креативів) і T005.
- US3 залежить від US1 (сегменти в плані/рядках).
- US4 залежить від Foundational, T017/T019 (рядки за сегментами) і T071 (ціль `creatives`); T074 — перед T042/T046; незалежна від US3.
- T070–T072 обов'язкові до будь-якого приймання оновлювача (US1, US4).
- US5 залежить від T026; US6 — від US1 (і US3 для варіацій у пакеті).
- Polish — після всіх історій.

## Parallel Execution Examples

- Foundational: T003, T004, T006, T009, T010, T011, T013 — різні файли.
- US1: T016, T024, T028 паралельно; далі T017→T018→T019→T020.
- US4: T041, T043, T044 паралельно; далі T042→T045→T046→T047.

## Implementation Strategy

1. MVP = Phase 1–3: кілька відео без перезашивки з рівним поділом.
2. Додати US2 (розподіл) — найпомітніша для оператора цінність.
3. US3 і US4 паралельно (різні шари: набори vs зображення).
4. US5, US6, Polish. Реліз — повним раннером на next після приймання на беті; прод не чіпати.
