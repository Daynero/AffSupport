# Research: Опційна публікація відео каталогу в R2

Усі пункти Technical Context визначені; відкритих `NEEDS CLARIFICATION` немає. Нижче — рішення з обґрунтуванням і відкинутими альтернативами. Факти про код зафіксовані станом на 2026-11-09; R13–R16 додані після аналізу того ж дня; R17–R20 і правки R1–R5, R13 — після третього проходу 2026-11-10 (перевірка проти коду).

## R1 — Де вставляти R2 у наявний потік

**Decision**: один спільний резолвер `catalog-video-link.ts`, який замінює пряме `videoShareLink(live.id, live.resourceKey)` у **п'яти** місцях, де формується посилання клітинки каталогу (grep `videoShareLink(` 2026-11-10): створення — `drive-ops/product-catalog.ts:549,563` (`createProductCatalog`; його викликає `catalog-durable.ts:832`, сам `catalog-durable.ts` посилань не формує) і `drive-ops/catalog-initial-video-authority.ts:449`; оновлення — `catalog-updater/publication-io.ts:174`, `drive-ops/updater-variants.ts:353` і застарілий шлях `catalog-updater/worker.ts:652` (`videoLinkOverride: item.spare?.link ?? item.currentVideoLink` → `_shared/catalog-updater.ts:82` → `_shared/product-catalog.ts:646`), де в клітинку йде збережене Drive-посилання — тут резолвер викликається перед передачею override. Шосте входження, `drive-ops/updater-restitch.ts:475` (`recordRestitchOutput`), формує `shared_link` запасної ре-стітч-копії для `service_record_restitch_output` — це не посилання клітинки, воно **не змінюється**.

**Rationale**: у всіх місцях клітинки послідовність однакова: довести живий родовід → довести `canDownload` → звірити `sourceVersion` → переконатися в «anyone» дозволі (`ensureAnyoneReader`) → `videoShareLink`. Єдине, що змінюється при R2, — останні два кроки. Один резолвер дає один тестовий шов і гарантує SC-001. Перші два проходи аналізу перелічували `catalog-durable.ts` замість `product-catalog.ts` і пропускали override-шлях `catalog-updater/worker.ts` — з таким переліком каталог, створений із галочкою, отримав би Drive-посилання.

**Alternatives**: (а) підміняти URL у xlsx після публікації — ламає frozen recipe та перевірки cells; (б) окремий паралельний конвеєр публікації — подвоює складну логіку cancel/retry/verify.

## R2 — Заморожений recipe і зміна URL

**Decision**: перехід між видами посилання відбувається лише на межі нового publication job; квитанція посилання отримує `link_kind` (`drive` | `r2`) як частину ключа ідентичності. Квитанцію пише `public.service_record_catalog_publication_link(p_job,p_worker,p_material,p_source_version,p_url)` (`20261207176000_catalog_video_cell_publication.sql:171–178`), і її чинна версія **відкидає будь-який не-Drive URL** (`p_url not like 'https://drive.google.com/file/d/%/view?usp=sharing%'` та звірка з `fileId` джерела → `SOURCE_CHANGED`). Тому міграція 050 **замінює** цей RPC (`create or replace`) з новим параметром `p_link_kind text default 'drive'`: `drive` — правило дослівно як сьогодні; `r2` — `p_url` має дорівнювати `https://<videoOrigin>/v/<object_key>` копії зі `state='ready'`, `source_material_id=p_material`, `source_version=p_source_version` при `preferences.enabled=true` для каталогу job, інакше `SOURCE_CHANGED`. Таблиця `private.catalog_publication_link_receipts` отримує nullable `link_kind` (`null` читається як `drive`). Старі виклики без шостого аргументу працюють без змін.

**Rationale**: у `publication-io.ts` перевірка `if (old && old.url !== url) throw SOURCE_CHANGED` захищає від мовчазної підміни. `link_kind` робить зміну явною й перевірною. `publication-cells.ts` зберігає recipe «ID→URL» як заморожений; новий job заморожує новий recipe. Перевірка prepare-RPC «кожен product має квитанцію з таким самим URL» (рядок 85) лишається чинною для обох видів. Заміна RPC — єдина не-«нова» зміна схеми; вона сумісна з релізнутим клієнтом (default-параметр), що і перевіряє план `release:backend-plan`.

## R3 — Транспорт копіювання

**Decision**: серверний потік Drive → edge function → R2 multipart `UploadPart`, окремий воркер `catalog-video-r2`, claim/lease/fence за зразком `catalog-images/worker.ts`. Читання з Drive — чинний `GoogleDriveClient.fetchFileRange({fileId, resourceKey, start, end, signal})` (`_shared/drive.ts:1387`, `alt=media` + `range: bytes=start-end`, повертає потоковий `Response`), а не `downloadFileRange` (буферизує й обмежений 32 МіБ). Частина читається потоком і одночасно хешується (WebCrypto, інкрементально) і передається в `UploadPart`.

**Rationale**: каталог оновлюється на сервері без агента, тож копіювання не може залежати від комп'ютера користувача. Політика допускає транзитний relay Drive-байтів через edge; фіча додає _постійне_ зберігання лише за явною згодою.

**Alternatives**: копіювання з агента; presigned-upload з браузера — обидва залежать від увімкненого пристрою/вкладки.

## R4 — Розмір частини та таймаути

**Decision**: частина 16 МіБ (≥5 МіБ — мінімум S3), ≤10 000 частин; invocation обробляє стільки частин, скільки вміщається в дедлайн за вирахуванням запасу, і віддає lease; наступний claim продовжує з першої недозавантаженої частини. Бюджет invocation — 60 с, як у 045 (`catalog-images/worker.ts:76` ставить abort на 60 000 мс, інвокатор шле `timeout_milliseconds:=65000`); при ~5–10 МБ/с це 3–6 частин, тобто відео 100 МБ — 1–3 invocation. Невикористані multipart upload скасовуються (`AbortMultipartUpload`) при термінальній невдачі й sweep'ом. Ризик CPU-ліміту edge на хешування частин: T003 вимірює CPU/wall на частину; якщо ліміт тисне — менший `part_bytes` (конфіг 5–64 МіБ).

## R5 — Перевірка цілісності

**Decision**: per-part SHA-256 (зберігається в БД; підтверджується `x-amz-checksum-sha256`, якщо пісочниця T003 доведе, що R2 перевіряє заголовок на `UploadPart`, інакше — Range-readback частини й власна звірка; адаптер 045 заголовків checksum не використовує і покладається на readback, тож підтримку треба довести, а не припускати) + повний розмір = `size` Drive + публічний HEAD (`content-length`, `content-type`) + Range-проби початку, кінця й кількох випадкових меж частин проти Drive. Додатково: `source_md5` фіксується при плануванні; якщо весь файл прочитано в межах одного invocation — рахується повний MD5 і звіряється з Drive (`full_hash_verified=true`). Якщо ні — межа доказу явна в діагностиці (AD-006) і у відповіді `state.copy.fullHashVerified`.

**Rationale**: MD5 Drive — на весь файл, його не можна накопичувати між invocation без збереження стану хешера. Per-part + розмір + проби меж дають практично повну довіру; повна звірка робиться, коли можлива, і ніколи не вдається.

## R6 — Публічне віддавання

**Decision**: окремий публічний bucket відео per-environment (`soty-catalog-videos-<env>-public`) + staging для multipart, власний домен, ключ `v/<32 hex>.mp4`, `cache-control: public, max-age=31536000, immutable`, `content-type: video/mp4`, `nosniff`; видалення → purge за URL через zone token (механіка 045).

## R7 — Життєвий цикл «лише активна»

**Decision**: стани копії `planned → uploading → verifying → ready → retiring → deleted` (+ `failed`); `uses(catalog_material_id, source_material_id) → copy_id` фіксує, на яку копію каталог підтверджено для кожного відео-джерела; `confirm_use` замінює весь набір uses каталогу (джерела, що зникли, і підтвердження з `link_kind=drive` прибирають старі uses — інакше копії прибраних джерел ніколи не стали б `retiring`); копія без uses і без незавершеної публікації → `retiring` з `retire_after = now + 6h`, повторна перевірка нуля посилань перед видаленням; при новому use до видалення — `retiring → ready`.

## R8 — Кілька відео в каталозі

**Decision**: ключ активної версії — відео-джерело (`source_material_id`), а не «слот». Варіанти (`catalog_video_variants`) мають власні `output_material_id`, тому каталог із набором варіантів — це просто кілька джерел з однією активною версією на кожне.

**Rationale**: у схемі немає поняття `variant_slot`; варіанти ідентифікуються `(video_set_id, video_variant_index)` і матеріалом виходу. Ключ по матеріалу уникає нової ідентичності й коректно працює для каталогу з одним відео.

## R9 — Опція і місця створення каталогу

**Decision**: адитивна таблиця `private.catalog_video_r2_preferences` за ключем каталогу; булева, last-write-wins (ревізія лише для атрибуції). Місця створення: `CreateProductCatalogDialog`, `ProductCatalogMenuDialog`, серверні `drive-ops/product-catalog.ts` / `catalog-durable.ts`, і **каталоги запуску**: поле `copyVideoToR2` у `LaunchCatalogConfig` (`packages/shared/src/team/launches.ts`, `launches/validation.ts`), значення за замовчуванням у `apps/web/src/team/launches/launchCatalogDefaults.ts`, UI у `LaunchSession.tsx`/`LaunchDefaultsReview.tsx`, збереження в `settings_snapshot` (`team_launch_revision_catalogs`), читання в `drive-ops/launch-catalog.ts`.

**Rationale**: запуск створює каталоги за збереженою конфігурацією без участі користувача в момент створення, тож опція має жити в цій конфігурації, інакше FR-002 «у кожному місці створення» не виконується.

## R9a — Право ввімкнення

**Decision**: `private.can(p_team, 'manage_metadata', auth.uid())` — той самий предикат, що в `public.set_team_product_catalog_settings` (`20260917170000_catalog_pools.sql:77`). У спеці формулюється як «право змінювати налаштування автооновлення каталогу».

## R10 — Політика та доступність

**Decision**: `catalog_video_r2_config.policy_confirmed_at` — поки `null`, `availability` повертає `POLICY_PENDING`, UI не показує галочку; власник ставить його явно після оновлення `legal-content.ts` (uk/en), `docs/NO_SERVER_MEDIA_PLAN.md` і тексту біля галочки.

## R11 — Витрати

**Decision**: сумарний обсяг на простір обмежується конфігом (50 ГіБ); оцінка вартості — з моделі 045 (`cost-model.py`) з розміром відео 100 МБ; показується в `apps/web/src/team/tariffs/SpaceTariffSection.tsx` як estimate, не рахунок. За публічними тарифами R2 Standard зберігання коштує порядку $0,015/ГБ·міс, егрес безкоштовний; «лише активна версія» тримає витрати лінійними від кількості ввімкнених каталогів.

## R12 — Діагностика

**Decision**: окремий `private.catalog_video_r2_journal`, нові закриті коди в `scripts/analytics/code-map.ts` + `packages/shared` реєстр, розширення read-only CLI модулем `scripts/analytics/catalog-video-r2.ts` за зразком `catalog-images.ts`.

## R13 — Шлях релізу (після аналізу, C1)

**Decision**: фіча доставляється **повним релізом** (наступним після 1.4.0) через раннер `run-release.sh`; агент перепаковується без зміни протоколу. Міграція й edge (нова функція та змінені `catalog-updater`/`drive-ops`) можуть піти на прод раніше темно — але **лише** серверним планом раннера: `npm run release:backend-plan -- --since=<deployed-sha> --out=<plan>` → `npm run release:backend-apply -- --plan=<plan>` → `--confirm` (`docs/PRODUCTION.md:277–282`; `scripts/apply-backend-plan.mjs` — «той самий крок `backend_apply`, ті самі гейти»). Ручний `supabase functions deploy` чи `psql` на прод — саме те, що раннер існує, щоб прибрати. Другий прохід аналізу цього не обумовив, і формулювання «можуть піти раніше» читалося як дозвіл на ручний деплой.

**Rationale**: edge-функції імпортують `packages/shared` у 56 файлах; shared — єдине джерело типів для web і edge (Принцип I). `scripts/verify-release.mjs:413` відхиляє web-деплой із нерелізнутими Agent/shared-змінами. Дублювати контракт web-локально, аби обійти гейт, означало б два джерела правди.

**Alternatives**: web-only з типами поза shared — відкинуто (дублювання контракту, ризик розбіжності між web і edge).

## R14 — Надгробки (після аналізу, H2)

**Decision**: `catalog_video_r2_purges` без FK на `teams`/`copies`; тригер `before delete` на `copies` записує `object_key`; sweep видаляє об'єкт і purge'ить, успіх = 404 на HEAD + прийнятий purge.

**Rationale**: FK-каскад від `teams` стирає рядки копій при видаленні простору; без надгробка об'єкти в R2 лишилися б назавжди. 045 вирішував це так само («tombstone survives cascade»).

## R15 — Фоновий запуск (після аналізу, H1)

**Decision**: `private.invoke_catalog_video_r2_worker(route)` читає чинні vault-записи `wishly_catalog_sync_url` / `wishly_catalog_sync_secret`, будує endpoint через `regexp_replace(url, '/catalog-sync/?$', '/catalog-video-r2/worker')` і шле `net.http_post` із заголовком `x-catalog-sync-secret`; `cron.schedule` для `claim` (30 с) і `sweep` (5 хв), у тій самій міграції, що й таблиці — дослівно за зразком `invoke_catalog_images_worker` (міграція 045, рядки 616–627).

**Rationale**: новий іменований секрет треба було б провізіонити у vault бети й проду, що в auto-mode заблоковано, а перейменування суперечило б рішенню «залишки Wishly не чіпати». Повторне використання секрета catalog-sync — усталений шаблон (045 уже так робить).

## R16 — Життєвий цикл каталогу (після аналізу, M4)

**Decision**: остаточне видалення матеріалу каталогу → uses зникають каскадом → копії `retiring` одразу (далі — вікно 6 год). Кошик (`team_materials.trashed_at`, відновлюваний), зняття з автооновлення (рядок `team_catalog_updater_items` зникає) і паузи (`paused_by_tariff_at`, stop hold) копій **не чіпають** — виданий каталог далі посилається на R2-URL. Причини в надгробках: `replaced`, `disabled`, `source_removed`, `catalog_deleted`, `team_deleted`, `failed_upload`.

**Rationale**: у домені немає стану «скасований каталог» — перша версія R16 посилалась на неіснуючі `cancelled`/`held` стани каталогу (`canceled_at` у схемі належить операціям, не каталогам). Утримання R2-копії для каталогу, що існує, але не оновлюється, — це свідома вартість: каталог досі роздає відео зовнішньому читачеві, і видалити копію означало б зламати його (FR-010).

## R17 — Сигнали для Realtime (третій прохід, M1)

**Decision**: публічна таблиця `public.team_catalog_video_r2_signals` (одна на каталог: `enabled`, `link_kind`, `copy_state`, `reason`, `last_successful_update_at`, `updated_at`) з RLS `private.can(team_id,'view',auth.uid())` і записом лише з RPC; `useTeamRealtime.ts` додає підписку `postgres_changes` з фільтром `team_id`, як для `team_catalog_image_storage_signals` (`useTeamRealtime.ts:141`).

**Rationale**: Supabase Realtime не публікує зміни `private.*`; план обіцяв «наявний Realtime-шов без polling», але всі таблиці фічі були приватні — UI не мав би як дізнатися про готову копію чи зміну опції іншим учасником. 045 розв'язав це так само.

## R18 — Environment відео-bucket (третій прохід, M2)

**Decision**: за зразком `docs/CATALOG_IMAGES.md`: нові `CATALOG_VIDEOS_ENABLED`, `R2_CATALOG_VIDEO_STAGING_BUCKET` (`soty-catalog-videos-<environment>-staging`), `R2_CATALOG_VIDEO_PUBLIC_BUCKET` (`…-public`), `R2_CATALOG_VIDEO_PUBLIC_ORIGIN`, `R2_CATALOG_VIDEO_TARGET_CONFIRMATION`, `R2_CATALOG_VIDEO_ACCESS_KEY_ID`/`R2_CATALOG_VIDEO_SECRET_ACCESS_KEY`; спільні з 045 — `CATALOG_IMAGES_ENVIRONMENT`, `R2_CATALOG_ACCOUNT_ID`, `R2_CATALOG_ZONE_ID`, `R2_CATALOG_PURGE_TOKEN`. `readCatalogVideoR2Config` відмовляє без точного збігу target-confirmation і для `.r2.dev`/`*.r2.cloudflarestorage.com`.

**Rationale**: S3-ключі 045 «обмежені двома bucket картинок» — нові bucket потребують власної пари (least privilege), а ім'я середовища й зона — спільні властивості деплою. Попередні артефакти називали змінні узагальнено (`CATALOG_VIDEO_R2_*`), що не дає власникові провізіонити середовище без вгадування.

## R19 — Право в кожній точці входу (третій прохід, M3)

**Decision**: `copyVideoToR2=true` перевіряється сервером проти `private.can(team,'manage_metadata',actor)` у трьох точках: `PUT /preference` (той, хто викликає), durable create intent (актор створення), виконання запуску (`launch-catalog.ts` передає `p_actor` — актор запуску, не автор конфігурації). Без права — `PERMISSION_DENIED`, каталог не створюється з опцією мовчки.

**Rationale**: створення каталогу сьогодні вимагає лише `edit` на відео (`product-catalog.ts`: `loadVideo({permission:'edit'})`, `SHARE_NOT_ALLOWED` без `canShare`), а не `manage_metadata`; без окремої перевірки поле в create-запиті обходило б FR-013.

## R20 — Drive-ідентичності ре-стітчу не змінюються (третій прохід, H1)

**Decision**: R2-URL ніколи не записується в `team_product_catalogs.current_video_link`/`video_link`, `team_catalog_restitch_copies.shared_link` чи `sourceLink` контексту job; ці поля лишаються Drive-посиланнями. Резолвер застосовується лише до посилання, що йде в клітинку (і в квитанцію з `link_kind='r2'`).

**Rationale**: `20261207169000_catalog_publication_jobs.sql:340` прив'язує job до каталогу умовою `copy.shared_link = c.current_video_link`; `catalog-updater/worker.ts:652` передає `current_video_link` як override у клітинки. Підміна цих полів R2-URL зламала б прив'язку (`SOURCE_CHANGED`) для всіх ре-стітчнутих каталогів.

## R21 — Перехід через задачі публікації (після беті, 2026-11-10)

- **Decision**: посилання каталогу з політикою публікації змінює лише наявний записувач відеоклітинок. Узгодження `private.catalog_video_r2_reconcile` порівнює квитанції посилань останньої опублікованої задачі з тим, чого вимагає опція, і за розбіжності ставить ще одну задачу на ту саму ціль (`catalog_publication_commands.payload.origin = video_r2`, ревізія політики +1). Викликається при зміні опції (вона ж планує копії), коли копія стала `ready`, після кожної опублікованої задачі цього каталогу і щохвилини з `pg_cron` як страховка. Міграція `20261207195000_catalog_video_r2_republish.sql`.
- **Rationale**: на беті каталог з увімкненою опцією пройшов оновлення й лишився на Drive: `updateOne` для каталогів із політикою йде шляхом `nonVideo` і зберігає відеоклітинки, а `resolveVideoLink` там не викликається. Другий записувач клітинок порушив би CAS і маркери 047; повторна задача на ту саму ціль їх зберігає.
- **Alternatives considered**: писати відеоклітинки у `nonVideo`-оновленні (другий записувач, конфлікт із `verify`, який вимагає незмінної відеоколонки); чекати наступної зміни відео (каталог без перезашивки не перейшов би ніколи); перевидавати з edge-воркера (зайвий HTTP-крок і гонки з settle; тригер у тій самій транзакції простіший).
- **Межі**: не чіпає каталоги без рядка опції, з політикою `held`, з неперевіреною legacy-доставкою, поки інша задача каталогу активна, і коли автор політики втратив право публікувати. Задача узгодження, яка не досягла свого напрямку, не повторюється 10 хвилин. Таймер копій не планує.

## R21a — Нічого не копіювати для створення, що не дійшло до публікації (2026-11-10)

- **Decision**: створення каталогу більше не планує копій (`resolveCatalogReadyLinks` знову лише Drive, як у `main`). Копії планує перша підтверджена публікація каталогу (тригер після публікації з `plan=true`). Воркер на кожному claim скасовує копії, яких ніхто не чекає (`VIDEO_R2_CANCELED` + надгробок).
- **Rationale**: питання власника: «каталог з 30 відео, на 25 падає, людина кидає і створює новий — відео лежать мертвим вантажем на R2». До цього рішення копії планувались ще до появи каталогу (pre-creation scope), тож збій посередині лишав заплановані копії, які воркер доливав, а прибирання наставало лише через 6 + 6 год.
- **Межі**: якщо створення впало на генерації відео, копій і раніше не було (посилання розв'язуються лише коли весь набір готовий). Копії, заплановані задачею публікації, яка потім не дійшла до кінця, при живому каталозі з опцією доливаються і прибираються як сироти (≤ 12 год).

## R22 — R2 не перевіряє SHA-256 частини (після беті, 2026-11-10)

- **Decision**: стратегія звірки частин — лише `readback`. `provider_checksum` лишається в адаптері вимкненою і на відповідь 501 завершується `VIDEO_R2_NOT_CONFIGURED` без повторів.
- **Rationale**: `provider-acceptance.ts` на ізольованих bucket-ах беті: `UploadPart` із `x-amz-checksum-sha256` → `501 NotImplemented`. Запит із хибним `X-Amz-Content-Sha256` R2 не відхиляє, а тримає до таймауту клієнта, тому його не можна вважати перевіркою.
- **Наслідок для бюджету**: 16 МіБ частина йде 1–4 с (хеш 10–20 мс), файл 48 МБ копіюється за одну-дві інвокації; повний MD5 звіряється лише коли файл вклався в одну (`full_hash_verified`).

## Відкриті для власника значення (не блокують план)

- Початковий ліміт на простір: 50 ГіБ (конфіг).
- Вікно перед видаленням: 6 год (конфіг).
