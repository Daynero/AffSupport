# Research: Опційна публікація відео каталогу в R2

Усі пункти Technical Context визначені; відкритих `NEEDS CLARIFICATION` немає. Нижче — рішення з обґрунтуванням і відкинутими альтернативами. Факти про код зафіксовані станом на 2026-11-09; R13–R16 додані після аналізу того ж дня.

## R1 — Де вставляти R2 у наявний потік

**Decision**: один спільний резолвер `catalog-video-link.ts`, який замінює пряме `videoShareLink(live.id, live.resourceKey)` у чотирьох місцях (`catalog-updater/publication-io.ts`, `drive-ops/updater-variants.ts`, `drive-ops/catalog-initial-video-authority.ts`, `drive-ops/catalog-durable.ts`).

**Rationale**: у всіх місцях послідовність однакова: довести живий родовід → довести `canDownload` → звірити `sourceVersion` → переконатися в «anyone» дозволі (`ensureAnyoneReader`) → `videoShareLink`. Єдине, що змінюється при R2, — останні два кроки. Один резолвер дає один тестовий шов і гарантує SC-001.

**Alternatives**: (а) підміняти URL у xlsx після публікації — ламає frozen recipe та перевірки cells; (б) окремий паралельний конвеєр публікації — подвоює складну логіку cancel/retry/verify.

## R2 — Заморожений recipe і зміна URL

**Decision**: перехід між видами посилання відбувається лише на межі нового publication job; квитанція посилання отримує `link_kind` (`drive` | `r2`) як частину ключа ідентичності.

**Rationale**: у `publication-io.ts` перевірка `if (old && old.url !== url) throw SOURCE_CHANGED` захищає від мовчазної підміни. `link_kind` робить зміну явною й перевірною. `publication-cells.ts` зберігає recipe «ID→URL» як заморожений; новий job заморожує новий recipe.

## R3 — Транспорт копіювання

**Decision**: серверний потік Drive (range read) → edge function → R2 multipart `UploadPart`, окремий воркер `catalog-video-r2`, claim/lease/fence за зразком `catalog-images/worker.ts`.

**Rationale**: каталог оновлюється на сервері без агента, тож копіювання не може залежати від комп'ютера користувача. Політика допускає транзитний relay Drive-байтів через edge; фіча додає *постійне* зберігання лише за явною згодою.

**Alternatives**: копіювання з агента; presigned-upload з браузера — обидва залежать від увімкненого пристрою/вкладки.

## R4 — Розмір частини та таймаути

**Decision**: частина 16 МіБ (≥5 МіБ — мінімум S3), ≤10 000 частин; invocation обробляє стільки частин, скільки вміщається в дедлайн за вирахуванням запасу, і віддає lease; наступний claim продовжує з першої недозавантаженої частини. Невикористані multipart upload скасовуються (`AbortMultipartUpload`) при термінальній невдачі й sweep'ом.

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

**Decision**: фіча доставляється **повним релізом** (наступним після 1.4.0) через раннер `run-release.sh`; агент перепаковується без зміни протоколу. Міграція й edge можуть піти на прод раніше темно.

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

## Відкриті для власника значення (не блокують план)

- Початковий ліміт на простір: 50 ГіБ (конфіг).
- Вікно перед видаленням: 6 год (конфіг).
