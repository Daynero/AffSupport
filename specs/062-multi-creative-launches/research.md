# Research: 062 — кілька креативів і зображення в каталожних запусках

Джерело фактів — карта коду гілки `beta` (21def35a, 1.5.8), складена 2026-11-20. Посилання `файл:рядок` — на цей знімок.

## R1. Форма конфігурації: список креативів з дзеркалом першого

**Decision**: `LaunchConfig` отримує `creativeKind: 'video' | 'image'` і `creatives: LaunchCreative[]` (`materialId`, `alias`, `copies`, `pinned: number | null`). Поля `materialId` і `creativeAlias` лишаються й завжди дорівнюють першому креативу.

**Rationale**: близько 30 SQL-функцій читають `config->>'materialId'` (заморозка ресурсів `20261208100100:93`, резерв назви `20261215100000:73-79`, ранги `20261218200000:209,455`, список `20261207400700:46,49`, `copy_launch`). Дзеркало зберігає їх правильними для «основного» креативу без переписування кожної. Явно переписуються лише ті, яким потрібен увесь список (R5, R10, R13).

**Alternatives considered**: (а) замінити `materialId` списком — ламає всі старі читачі й відкат; (б) окрема таблиця креативів запуску — дублює чернетку, яка й так JSON, і вимагає синхронізації з `draft_config`.

Конфігурація без `creatives` (усі наявні) розбирається як `[{materialId, alias: creativeAlias, copies: productCount, pinned: null}]`, `creativeKind` — з `LaunchSources.materialType`. Записи не мігруються.

## R2. Розподіл копій — чиста функція в shared

**Decision**: `packages/shared/src/team/launches/creative-distribution.ts`:
- `evenCopies(n, k)` → `⌊n/k⌋` кожному, залишок першим.
- `dragCopies(list, index, value, n)` (повзунок) → різниця компенсується пропорційно **всіма** іншими (найбільший залишок, мінімум 1), усі `pinned = null` — буквально «збільшую один — усі інші зменшуються».
- `setCopies(list, index, value, n)` (поле) → змінений отримує `pinned = max+1`; різниця компенсується пропорційно серед незакріплених; якщо їх немає — від найменшого `pinned` (найдавніше введений). Значення обмежується `[1, n − (k−1)]` і досяжним максимумом.
- `rescaleCopies(list, n)` → рівний лишається рівним; інакше пропорційно з точною сумою.
- `removeCreative(list, index, n)` → копії видаленого розходяться за правилом `setCopies`.
- `balanceCopies(list, n)` → рівний поділ, `pinned=false`.

**Rationale**: одна функція для UI, валідації сервера й тестів властивостей (SC-006). Сервер не перераховує, лише перевіряє `sum = productCount`, `min 1`, `k ≤ 10`.

**Alternatives**: тримати розподіл у відсотках — ламає точну суму й інпути в штуках, яких просив власник.

## R3. Порядок рядків і сегменти

**Decision**: план каталогу зберігає один масив `recipeRowIds` довжиною N (як зараз) і новий масив `segments`: `{ordinal, materialId, alias, kind, rowStart, rowCount, variantCount, setId|null}`. Рядки `rowStart..rowStart+rowCount-1` належать креативу `ordinal`; блоки суцільні в порядку креативів.

**Rationale**: усі наявні перевірки `recipeRowIds.length === productCount` (`catalog-durable.ts:299-300,369-370`, `174000:119`) лишаються правдивими. `createCatalogVideoAssignment` уже сортує рядки перед перемішуванням (`catalog-video-set.ts:83-90`), тож підмножина рядків для набору — штатний вхід.

## R4. Варіації по колу

**Decision**: `distributeVariations(copies[], total)` у shared: по колу в порядку креативів, пропускаючи креатив, у якого `variants == copies`; межі `k ≤ total ≤ n`. Без перезашивки — 1 на відео.

**Rationale**: прямо описує правило власника; детерміноване, без зерна.

## R5. Набір перезашивки на кожне відео

**Decision**: кожне відео-креатив отримує власний `catalog_video_sets` з `product_count = rowCount`, `requested_count = variantCount` і своєю підмножиною `recipe_row_id`. Зміни схеми:
- `catalog_video_sets`: `unique(catalog_intent_id)` → `unique(catalog_intent_id, source_material_id)` (`20261207168000:16`).
- `catalog_video_recipe_references`: `unique(catalog_intent_id)` → `unique(catalog_intent_id, video_set_id)` (`168000:37`); тригер `initialize_catalog_video_recipe` — без змін (вставляє по одному на набір).
- `service_accept_catalog_video_set`: перевірка `intent.video_material_id = source` (`168000:126`) → «джерело є одним із сегментів інтенту»; пошук за `(intent, source)` замість лише intent (`:128-131`).
- Нова таблиця `private.launch_catalog_video_segments` (див. data-model). `launch_catalog_video_contexts.video_set_id` лишається = набір першого відео (сумісність читачів).
- Читачі, яким потрібні всі набори: `service_wait_launch_catalog_video` (`171000:114-127`); прогрес і `videoGeneration` у ланцюжку `get_launch` (живий `20261215100000:111` → `get_launch_before_started_at`, перейменований у `20261207399600:10`, тіло з `20261207177000:149-171`) — агрегат по наборах; `list_launches_pre_assignment` `videoGeneration` (`400700:84-86`) — агрегат; `resolveCatalogReadyLinks` (`catalog-initial-video-authority.ts:486-570`) викликає наявну `service_initial_catalog_video_outputs(p_team, p_actor, p_set, p_recipe)` (`169000:631`) **по разу на сегмент** і склеює посилання в порядку `recipeRowIds` — нова RPC не потрібна, перевірки команди/актора лишаються.
- Зерно призначення сегмента: `segmentSeed = hex(sha256(assignmentSeed || ':' || ordinal))` (64 hex, проходить наявну перевірку `^[a-f0-9]{64}$`), зберігається в `launch_catalog_video_segments.assignment_seed` і передається в accept набору; тест паритету edge↔SQL.
- Повтор одного невдалого набору: нова RPC `retry_launch_catalog_video_segment(p_generation, p_ordinal)` — перевідкриває лише цей набір; `retry_launch_restitch` (на всю генерацію) для k>1 не використовується.
- `launch_ready_video_reuse` (`174000:88`) — повторне використання готового набору лише для запуску з одним відео; для кількох — без reuse (у v1).

**Rationale**: фоновий агент уже бере набори по одному (`20261207401200:13-68`), payload — один набір з одним джерелом (`168000:264-277`). Отже **агент не змінюється**.

**Alternatives**: один набір на кілька джерел — вимагає зміни payload агента, кешу інспекцій і релізу агента.

## R6. Передній режим виконавця

**Decision**: для 2+ відео допуск не бере `foregroundExecutor` (викликає штатне `service_retire_unused_catalog_video_foreground`) і йде у фон. Для одного відео — як зараз.

**Rationale**: `catalog_video_foreground_authorities.video_set_id unique` і контролер агента ведуть один `setId` на реєстрацію (`20261207180000:3-15`, `catalog-video-foreground.ts:35`).

## R7. Публікація зображень-креативів

**Decision**: крок генерації `creativeImages` у `createDurableProductCatalog` з чекпойнтом на кожне зображення:
1. `service_reserve_launch_creative_image(team, material, drive_version, checksum)` → наявний `ready` запис (дедуп між запусками) або нова резервація з ключем `c1/<32hex>.(jpg|png)`.
2. Читання з Drive з тими самими доказами, що й `catalog-images/drive-sources.ts:45-106`. `readDrive` — метод фабрики, що тримає пошук рядка й облікових даних, тому в `_shared/catalog-drive-image-read.ts` переноситься фабрика цілком; `catalog-images` імпортує її звідти.
3. `optimizeCatalogImage` (`_shared/catalog-image-optimization.ts:587-636`): JPEG/PNG, мін. сторона 500, ≤ 8 МБ.
4. `CatalogImageR2.putFinal` (`If-None-Match:*`, immutable) у публічний бакет `soty-catalog-images-${env}-public`; ключ `c1/<uuid>` тієї самої форми, що `v1/`/`g1/` — регулярний вираз (`_shared/r2-catalog-images.ts:79`) лише отримує `c1` у альтернативу.
5. `verify(publicRead=true)` — повне анонімне читання, MIME, `nosniff`, рівність байтів (`r2-catalog-images.ts:176-221`).
6. `service_commit_launch_creative_image(..., url)`.

Каталог не стає «готовим», доки всі зображення не `ready` (FR-014, SC-004). Нових секретів не потрібно — drive-ops має ті самі змінні середовища R2, що й `catalog-images`.

**Rationale**: зображень ≤ 10, ≤ 50 МБ кожне; послідовна обробка з чекпойнтом на зображення вкладається в бюджет функції й переживає перезапуск. Окремий cron-воркер (як у відео R2) зайвий для невеликих синхронних файлів.

**Перевірка в реалізації (T-задача)**: що публічний origin бакета зображень після cutover 052 досі віддає об'єкти напряму (v1 так працював до `20261208100200`). Якщо ні — розширити маршрут Worker `apps/catalog-image-delivery` на `/c/*` без HMAC-аліасів.

**Alternatives**: (а) посилання Drive `uc?export=view` — не пряме, не перевірене, Facebook нестабільно читає; (б) імпорт у пул команди 045 — закрито cutover-ом 052 (`GLOBAL_IMAGE_SETTINGS_RETIRED`) і робило б картинку «білою» для інших каталогів.

**Серія URL 200 (052)** до креативів не застосовується: це правило для спільних білих картинок, а креатив — власна реклама команди. Один URL на версію файла.

**Утримання**: `private.launch_creative_image_uses(catalog_material_id, image_id)`; коли використань немає — `retire_after = now + 6 год`; прибирання в наявному циклі `catalog-images` sweep (видалити об'єкт, перевірити 404, purge CDN) — тим самим шляхом, що й для `v1/`.

## R8. Рядки каталогу для зображень

**Decision**: `planCatalogRows` отримує сегменти. Для `kind='image'`: `imageLink = url креативу`, `pictureImage = {kind:'creative', imageId, publicUrl}`, `pictureName = null` (без класифікації за назвою → нейтральний 055: «Catalog Item», 20–40), відео-колонки й `videoTag` (AA) порожні. Пул білих (`deps.drawImages`, `bindGlobalImageCatalog`, `finalizeImageUses`) не викликається для каталогу зображень. `catalogImagesInRows`/`validateImageUses` приймають `creative` лише якщо URL збігається з `ready` записом цієї команди.

## R9. Рядки для кількох відео

**Decision**: блок креативу бере посилання свого відео: без перезашивки — оригінал свого відео з `?v=`; з перезашивкою — виходи свого набору. `createProductCatalog` вимагає категорію кожного креативу = `creativeKind` (заміна `category==='video'` у `product-catalog.ts:506,521`).

`team_product_catalogs.video_material_id`/`video_link` = перше відео (сумісність). Повний список — у `settings_snapshot._catalogCreatives` і `_catalogRowCreatives` (індекс креативу на рядок).

## R10. Оновлювач каталогу

**Decision**:
- Каталоги з політикою публікації (усі нові з запусків) уже зберігають відео-клітинки (`nonvideo-writer.ts:85-118`) — блоки відео не змішуються.
- Префікс ID у `rebuildCatalogRows`/`_catalogPublicIds` береться з `_catalogRowCreatives` → alias; без цих ключів (старі каталоги) — без префікса.
- Каталог зображень: `prepareCatalogClaims` не примушує `refresh_images` (`claim-preparation.ts:33-56`); `parseClaimedCatalog` не відкидає порожній `video_link`, якщо `_catalogCreativeKind='image'` (`worker.ts:318,331`); `planAutomaticUpdateRows`/`refreshedRows`/`addedRows` беруть URL креативу рядка замість пулу.
- Ріст: `catalog_nonvideo_update_context`/ростова функція (`20261207178000:21-66`) обирає креатив з найбільшим відставанням частки, далі — найменш завантажену варіацію набору цього креативу.

## R11. Префікс ID

**Decision**: `catalogProductId(prefix, id)` і `catalogIdPrefix(name)` у `supabase/functions/_shared/product-details.ts` поруч із `contentId`; дзеркальна `launchCreativeIdPrefix(alias)` у shared для прев'ю. Формат: `${prefix.slice(0,40)}-${contentId()}`. Транслітерація кирилиці — лише для назви відео в каталозі з провідника (у запуску alias уже латиниця, `validation.ts:20-27`).

## R12. Назви

**Decision**: `launchCampaignName` використовує `creativeAlias + (k>1 ? '+'+(k-1) : '')`. Назва каталогу: `<stem першого>${k>1?'+'+(k-1):''}_v<n>_catalog`; лічильник варіанта — за першим відео як зараз (`20261215100000:33-60`). Те саме правило в SQL `pendingCatalogName` (`20261215100000:115-135`) — тест паритету.

## R13. Ранги

**Decision**: `team_creative_launch_events` унікальність `(team_id, source_kind, source_id)` → `(team_id, source_kind, source_id, material_id)`; `credit_launch_rank()` і `backfill_creative_ranks()` перебирають `config->'creatives'` (або `materialId`, якщо списку немає); поглинання каталогу (`absorb_launch_catalog`) порівнює матеріал каталогу з тим креативом, що йому відповідає (перше відео), інші креативи отримують кредит без поглинання.

## R14. Збереження, копіювання, пакет, профілі

- `parseLaunchDraft` whitelist (`persistence.ts:27-80`) + `creatives`, `creativeKind`.
- `save_launch_draft` (`20261201111000:47-53`) — перевірка UUID кожного креативу, тип, ≤ 10, без дублів.
- `service_launch_sources` → для кожного креативу повертає версію/контрольну суму/тип (масив `materials`), `materialType` = тип першого.
- `copy_launch` копіює JSON як є — змін не потребує.
- Профілі запуску не зберігають креативи (`20261206145300:29`) — змін не потребують.
- Пакет 053 (`launch-batch.ts:41-173`, `accept_launch_batch`) використовує ті самі `parseLaunchConfig`/`launchPreview`/допуск — змінюється автоматично; тест на пакет з кількома креативами обов'язковий.

## R15. Інтерфейс

**Decision**: поле креативу — список рядків (мініатюра 40 px, назва `Input`, `IconButton` «Прибрати»), кнопка «Додати» відкриває той самий `DropdownMenu` (комп'ютер/простір), `TaskAttachmentPicker` без `single` для каталогу. Розподіл — `Accordion` під «Товарів у каталозі», заголовок з приглушеним підсумком праворуч (той самий патерн, що SUB, FR-021 053). Рядок: мініатюра, назва, `Slider`, `Input type=number`. Кнопка «Порівну» — `Button` size sm variant ghost у заголовку панелі. Усе з `components/ui`, значення з токенів.

**Benchmark**: розподіл бюджету між групами оголошень у Meta Ads Manager (повзунок + число, сума фіксована) і «split» у Google Optimize — запозичено фіксовану суму й ручне закріплення; відкинуто відсотки (власник мислить штуками).

## R16. Реліз

Зміни в `packages/shared` → повний релізний раннер на next (не швидкий веб-шлях). Агент функціонально не змінюється. Міграції — нові файли з датою після `20261218210000`; кожна нова таблиця `launch_*`/`catalog_*` отримує тригер `task_cleanup_reference_fence` (`20261205122000:145-163`).

## R17. Аналітика

Наявні типізовані події допуску/генерації запуску отримують властивості `creativeKind`, `creativeCount`, `productCount`, `variationCount`, `customDistribution`. Нові коди відмов: `CREATIVES_MIXED`, `CREATIVES_LIMIT`, `CREATIVE_DUPLICATE`, `DISTRIBUTION_INVALID`, `VARIATIONS_RANGE`, `CREATIVE_IMAGE_FORMAT`, `CREATIVE_IMAGE_TOO_LARGE`, `PUBLIC_READ_UNVERIFIED`, `MULTI_CREATIVE_UNSUPPORTED`. Стадії публікації зображення: `creative_image.accepted/published/verified/failed` з `creativeOrdinal`; `failedOrdinal` для набору. Без назв, ID, URL.

Закриті списки, куди ключі й коди мають потрапити, інакше події тихо відкидаються: серверний whitelist `analytics_properties_are_safe_v2` (переозначено в `20261218100000_navigation_analytics_guard.sql`), `LAUNCH_ANALYTICS_CODES` (`packages/shared/src/team/launches/lifecycle.ts:58`), `TEAM_ERROR_CODES` (`packages/shared/src/team/transport.ts:77`), `scripts/analytics/code-map.ts` (+ `tests/analytics-code-map.test.ts`), `coverage-registry.ts` (обов'язкове оновлення за AGENTS.md).

## R18. Ціль публікації для кількох креативів і зображень

**Знахідка аналізу**: `catalog_video_publication_policies` має одну ціль на каталог, ціль — одне джерело (`kind='source'`) або один набір (`kind='video_set'`) (`20261207169000:3-19,165-171,573-577`). Від неї залежать nonvideo-writer, ріст (`178000:21-66`), лінія публікації (`catalog-updater/publication-lane.ts`), заміна відео (`20261208110000`, `CatalogVideoReplacementDialog.tsx`), перевірка поточних посилань (`20261207290000`), R2-перевипуск (`…195000`).

**Decision**: новий вид цілі `kind='creatives'` з дочірньою таблицею `private.catalog_publication_target_segments(target_id, ordinal, kind, source_material_id, video_set_id, image_id, row_start, row_count)`. Каталог з k>1 або із зображень реєструє ціль `creatives`; одиночне відео — як зараз (`source`/`video_set`). Споживачі:
- nonvideo-writer — працює без змін (зберігає відео-клітинки, порожні дозволені);
- ріст — за сегментами (T060);
- лінія публікації — не потрібна: розклад для `creatives` заборонено (FR-021);
- заміна відео, перевірка посилань, R2-перевипуск, перезашивка оновлювачем (`168000:16,126-127`, гілка update) — відхиляють `creatives` з `MULTI_CREATIVE_UNSUPPORTED`, менеджер каталогів ховає дії (FR-024).

**Захист від legacy-шляху** (`catalog-updater/worker.ts:868-885` пише один `videoLinkOverride` у всі рядки): якщо snapshot має `_catalogCreatives.length > 1` або `_catalogCreativeKind='image'`, legacy-запис відхиляється з `MULTI_CREATIVE_UNSUPPORTED` — змішування неможливе навіть за відсутності політики.

## R19. Обмеження «лише відео» для каталогу зображень

**Знахідка аналізу**: `team_product_catalogs.video_link text not null` з перевіркою `^https://` (`20260915010000:75,85`); `catalog_generation_intents.video_material_id not null`; `catalog_image_begin_intent_legacy` вимагає `category='video'` (`20261206155000:81`); `service_initial_catalog_video_context` вимагає відео (`169000:619`); `service_accept_launch_catalog_video_generation` приймає лише відео-план протоколу 1.

**Decision**: міграція `20261220115000_catalog_image_creatives_invariants.sql`:
- `video_link` nullable; перевірка `video_link is not null or settings_snapshot->>'_catalogCreativeKind' = 'image'`, `^https://` — коли не null;
- `catalog_generation_intents.video_material_id` лишається not null і означає «основний матеріал» = перший креатив будь-якої категорії (назва колонки не міняється, щоб не ламати читачів);
- `catalog_image_begin_intent_legacy`, `service_initial_catalog_video_context` — гілка для `creativeKind='image'` (без відео-контексту);
- accept: для зображень — план із сегментами без наборів через ту саму `service_accept_launch_catalog_video_generation` (гілка `kind='image'`), щоб пакет 053 і cancel-фенси лишились спільними.

## R20. Snapshot креативів переживає оновлення

**Знахідка аналізу**: оновлювач будує `became.snapshot` з нуля (`catalog-updater/worker.ts:893-917`), а `service_complete_catalog_update` повністю замінює `settings_snapshot` (`20261207177000:~126`) — ключі креативів зникли б після першого оновлення.

**Decision**: `became.snapshot` переносить `_catalogCreativeKind`, `_catalogCreatives`, `_catalogRowCreatives` з поточного snapshot; ріст дописує ordinal нового рядка в `_catalogRowCreatives`. Тест «два оновлення поспіль → префікс, тип і блоки збережені» для відео, зображень і каталогу з провідника.

## R21. Профілі запуску

Профілі зберігають перезашивку й варіації (`20261217150000_launch_profiles_keep_catalog_video.sql`). Застосування профілю нормалізується: для зображень перезашивка вимикається, для k відео `V = max(V, k)`.

## R22. Вибір з простору зі змішаними типами

`TaskAttachmentPicker` фіксує `accept` на відкритті (`TaskAttachmentPicker.tsx:120`), тож за порожнього списку одна сесія вибору може повернути і відео, і зображення. Набір перевіряється при підтвердженні й відхиляється цілком тим самим повідомленням.

## R23. Клавіатура повзунка

PageUp/PageDown ±10 не гарантовано `Slider` за замовчуванням — реалізується через `onKeyDown` у наявній обгортці (`apps/web/src/components/ui/Choice.tsx:392`) як опція, без локального контролу.

---

# Перегляд після рішень власника 2026-11-20 (друге повідомлення)

Розділи нижче **перекривають** попередні там, де суперечать.

## R24. Без ліміту креативів

Окремої межі немає; природна межа — `LAUNCH_CATALOG_PRODUCTS_MAX = 400`, бо кожен креатив має ≥ 1 товар. `LAUNCH_CREATIVES_MAX` не вводиться. `CREATIVES_LIMIT` означає лише: k > 400 або метод «Інше» з k > 1.

Поведінка кількості товарів: `addCreatives(list, added, n)` → якщо `k' > n`, то `n' = k'` (автопідняття); `rescaleCopies` викликається з новим `n'`. Поле кількості товарів має `min = k`; спроба ввести менше — значення лишається `k`, `FormField` показує попередження «Товарів не може бути менше, ніж креативів». Сервер відхиляє `productCount < k` кодом `DISTRIBUTION_INVALID`.

UI при великих k: список креативів і панель розподілу — обмежена висота з прокруткою (токен висоти, без літералів); підсумок у заголовку — перші 6 значень і `…`. `ordinal` у SQL — `int` 0..399.

## R25. Тексти зображень = тексти білих (замінює R8 щодо вмісту)

Каталог із зображень іде **тим самим шляхом, що каталог з білими**: `deps.drawImages` тягне білі картинки пулу, `planCatalogRows` будує рядки з їхніми текстами/цінами/кольорами, `bindGlobalImageCatalog`/`finalizeImageUses` працюють як зараз (використання білих рахуються — у розкладі вони справді стоять у каталозі до підстановки). Відрізняється лише клітинка H `image_link`:
- без розкладу — одразу посилання креативу свого блоку;
- з розкладом — біла картинка до часу публікації, потім посилання креативу (R26).

`pictureImage` рядка лишається білою картинкою (для паритету вмісту й обліку використань); перевірки `catalogImagesInRows`/`validateImageUses` (`catalog-image-rows.ts:65-76`) отримують дозволений виняток: `imageLink` може дорівнювати посиланню креативу сегмента рядка (`_catalogCreatives[ordinal].link`). AA `videoTag` і Z — порожні.

## R26. Розклад публікації для кількох креативів (замінює заборону FR-021)

Ціль `kind='creatives'` (R18) підтримує лінію публікації:
- відео-сегменти: як зараз для `source`/`video_set`, але по сегменту — клітинки Z блоку `rowStart..+rowCount` отримують посилання свого відео (або виходи свого набору); квитанції посилань уже ключовані `materialId` (`publication-io.ts` `receipts`), тож кілька джерел у межах однієї задачі — штатно;
- image-сегменти: нова колонка публікації — H; задача публікації пише в клітинки H блоку посилання креативу (R2 або Drive за преференцією), перевіряє записане (`verifyPublicationCells`) і лише тоді закривається. До цього в H — білі картинки.

`parseFrozenPublicationCells`/`applyPublicationCells` розширюються на колонку H для image-сегментів; відеоколонки для image-каталогу лишаються порожніми.

## R27. Менеджер каталогів для кількох креативів (замінює FR-024 першої редакції)

Іконки `CatalogIconControls.tsx:49-73` — `restitch`, `randomLinkVariation`, `refreshImages`, `refreshTexts`, `grow`; окремо R2-перемикач (`CatalogVideoR2Toggle`) і «Замінити відео» (`CatalogVideoReplacementDialog`).

| Каталог | Видно | Сховано (і сервер відхиляє `MULTI_CREATIVE_UNSUPPORTED`) |
|---|---|---|
| одне відео | усе, як зараз | — |
| кілька відео | `restitch`, R2, `refreshTexts` | `randomLinkVariation`, `refreshImages`, `grow`, заміна відео, перевірка посилань |
| зображення (1+) | R2, `refreshTexts` | `restitch`, `randomLinkVariation`, `refreshImages`, `grow`, заміна відео, перевірка посилань |

Ріст (`grow`) прихований → R10 «ріст за сегментами» і міграція `catalog_growth_by_creative` **скасовані**.

## R28. Перезашивка оновлювачем для кількох відео (замінює H1-відмову)

Гілка update `catalog_video_sets`: `unique(update_attempt_id)` → `unique(update_attempt_id, source_material_id)`; перевірка «джерело = `pc.video_material_id`» (`168000:126-127`) → «джерело є відео-сегментом цілі `creatives` каталогу». Оновлювач створює набір на кожен відео-сегмент; кількість варіацій профілю `videoVariantCount` роздається `distributeVariations(rowCounts, V)`, межі `k ≤ V ≤ N` (для профілю — нормалізація `max(V, k)`). Призначення — `createCatalogVideoAssignment` над рядками сегмента зі зерном сегмента. Агент без змін (фонові набори по одному). Nonvideo-writer зберігає відеоклітинки, публікація нових варіацій — тією самою лінією публікації, що й R26.

## R29. R2 для кількох відео і для зображень

- Кілька відео: R2-копія на кожне джерело (`catalog_video_r2_copies` уже унікальні за `(team_id, source_version)`); `resolveVideoLink` викликається на сегмент; `service_catalog_video_r2_confirm_use` — set-replace по каталогу — отримує **множину** копій каталогу (перевірити в реалізації, що функція приймає масив; якщо ні — розширити).
- Зображення: преференція R2 каталогу (`catalog_video_r2_preferences`, перейменовувати не треба — це «R2 каталогу») керує посиланням креативу: увімкнено → `launch_creative_images` (`c1/<uuid>`, R7), вимкнено → посилання Drive `driveImageLink` (`_shared/product-catalog.ts:125-132`) після `ensureAnyoneReader` (`_shared/catalog-image-sharing.ts:16-40`) з анонімною перевіркою читання. Перемикання в менеджері — з наступного оновлення (оновлювач переписує H блоків зображень посиланнями нового виду). У редакторі запуску перемикач R2 показується і для зображень (підпис без слова «відео»).
