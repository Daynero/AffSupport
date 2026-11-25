# Research: 071 Повний переїзд сховища на R2

Кожне рішення: що вибрано, чому, які альтернативи відкинуто. **Факт** означає перевірено в коді `main` `2dd6dab`.

## R1. Що саме залежить від Drive (інвентар)

Факт: Drive API згадується приблизно в 358 файлах коду поза `specs/`. `drive_file_id` або `driveFileId` згадуються в 124 з 538 міграцій. `drive-ops/index.ts` має 4 081 рядок, `drive-transfer/index.ts` — 1 865.

| Шлях | Сьогодні (Факт) | На R2 |
| --- | --- | --- |
| Бібліотека: файли й папки | `team_materials` (`kind in file/folder/shortcut`, `drive_file_id not null`, `connection_id not null`), корінь `team_drive_connections` | ті самі рядки, `storage_backend='r2'`, об'єкт у `team_storage_objects`, папки лише в базі (R2) |
| Відкриття змін з Drive | `catalog-sync` (фід змін Drive, класифікація, транскрипти) | для R2 не потрібне: зміни бувають тільки через Soty; класифікація й транскрипт на фіналізації |
| Завантаження з браузера й вкладення завдань | `drive-ops /uploads/start` → `/uploads/:id/relay` (байти через edge) | presigned multipart напряму в R2 |
| Прев'ю, скачування, вхід агента | `drive-transfer /range` (байти через edge, `no-store`) | presigned GET напряму з R2 |
| Мініатюри | Drive `Soty Cache/Thumbnails` через `drive-transfer /thumbnail` і `preview-warm`; legacy-бакет `team-thumbnail-cache` | похідний об'єкт у R2, створений на завантаженні (R6) |
| Постер відео з агента | `drive-transfer poster_frame` (base64 у JSON) | presigned PUT похідного об'єкта |
| Вихід компресора | `drive-ops /process/output/start|finalize` + resumable-сесія Google | presigned multipart + `/storage/agent/finalize` |
| Рестітч: джерела, екрани, копії | `team_restitch_sources` (Drive-посилання), `/restitch/source-range`, `/restitch/screen-range`, папка `Restitched` | матеріали R2, ті самі маршрути через presigned GET |
| Рендери лендингів | `/landing-artifacts` → `Soty Cache/Landing previews`, `/render-range` | похідні об'єкти R2 |
| Операції `copy/move/rename/trash/restore/text-edit` | Drive API в `drive-ops` | база (крім `copy` → `CopyObject`, `text-edit` → новий об'єкт) |
| `share_copy` | Drive-файл «будь-хто з посиланням» (`library-ops`) | `/s/<token>` → 302 на presigned GET (R9) |
| Таблиця каталогу | Google Sheet, Sheets API `values:batchGet`/`batchUpdate`, developerMetadata (`_shared/drive.ts`) | CSV-фід у публічному бакеті каталогу (R7) |
| Картинки каталогу | R2 за замовчуванням (045) | без змін, Drive-джерело імпорту прибирається |
| Відео каталогу | Drive або R2 за опцією (050) | завжди R2 (R8) |
| XLSX фінансів | у пам'яті, `no-store` | без змін |
| Транскрипт | `team_materials.transcript_text` | без змін, джерело — об'єкт R2 |
| Legacy-бакети Supabase | `team-thumbnail-cache` (7 904 об'єкти), `team-restitch-images` | видаляються на етапі F |

## R2. Як змінити модель матеріалів, не переписуючи 124 міграції

**Рішення:** «віртуальне підключення». Кожен R2-простір має один рядок у `team_drive_connections` з `drive_kind='soty_r2'`, `credential_id null` і `root_folder_id='r2root_<team_id>'`. R2-матеріали отримують синтетичний `drive_file_id = 'r2_' || <uuid>` і `parent_folder_id` у тому ж просторі імен. Новий стовпець `storage_object_id` посилається на `team_storage_objects`.

**Чому:** унікальність `(connection_id, drive_file_id)`, RLS, права, кошик, пошук, explorer (070), завдання, запуски, каталоги й рестітч-джерела вже ключуються цими полями. Синтетичний ідентифікатор дозволяє зберегти весь цей шар і змінити тільки місця, де йде виклик Drive API. Таких місць менше, і їх видно за `GoogleDriveClient`.

**Відкинуто:**
- Нова таблиця `team_library_items` і переписування всіх посилань. Це найчистіше рішення, але воно чіпає більшість із 124 міграцій і всі клієнти. Перейменування стовпців можна зробити окремо після етапу F (R13).
- Окремі стовпці `r2_*` поруч із Drive-стовпцями без синтетичного id. Тоді кожен запит з `drive_file_id` потрібно було б розгалужувати.

**Ризик:** код, який бачить `drive_file_id` і йде з ним у Drive API. Захист: `StorageAdapter` (R3) і перевірка `npm run verify`, яка забороняє імпорт `GoogleDriveClient` поза Drive-адаптером (етап A).

## R3. Абстракція сховища

**Рішення:** `supabase/functions/_shared/storage/` з інтерфейсом `StorageAdapter` (contracts/storage-adapter.md) і двома реалізаціями: `DriveAdapter` (обгортка над наявним `GoogleDriveClient`) і `R2Adapter` (новий, на підписувачі 045). Вибір адаптера за `teams.storage_backend`. Після етапу F `DriveAdapter` видаляється.

**Чому:** дає змогу переводити простори по одному, а код Drive видалити одним комітом в кінці.

## R4. Підпис і клієнт R2

**Рішення:** перевикористати SigV4-підпис і multipart-логіку з `_shared/r2-catalog-images.ts` і `_shared/r2-catalog-video.ts`, винісши спільне в `_shared/r2/` (signer, multipart, readback, purge). Окремі ключі доступу для бакета бібліотеки (`R2_LIBRARY_ACCESS_KEY_ID`, `R2_LIBRARY_SECRET_ACCESS_KEY`) з дозволом тільки на `soty-library-<env>`.

**Факт:** 050 з'ясував, що R2 відповідає 501 на SHA-256 у `UploadPart`, тому звірка частин тільки через `readback`. Для бібліотеки читати назад кожну частину кожного файлу дорого. **Рішення:** клієнт рахує SHA-256 кожної частини й усього файлу; сервер звіряє розмір через `HEAD` і читає назад вибіркові частини (перша, остання й одна випадкова), порівнюючи з SHA-256 цих частин від клієнта **[припущення]**. Повний SHA-256 файлу без повного читання сервер не перевіряє; він зберігається як заявлений. Повний `readback` лишається для публічних об'єктів каталогу (як у 045/050).

## R5. Presigned URL: TTL, кеш і домен

- **Факт R2:** presigned URL працюють тільки з S3-ендпоінтом `<account>.r2.cloudflarestorage.com`, не з власним доменом; максимальний строк 7 днів ([Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).
- **Рішення:** TTL читання 1 година, запису частини 15 хвилин. Час кінця дії округлюється вгору до межі години **[припущення]**, тож у межах години той самий об'єкт має той самий URL, і браузер кешує мініатюри (`cache-control: private, max-age=3600`, записаний як метадані об'єкта при завантаженні).
- Видача URL пачками: список провідника повертає підписані URL мініатюр сторінки разом з рядками (один запит, HMAC на сервері).
- **CORS** на бакеті бібліотеки: тільки origins web-застосунку середовища (`soty.pp.ua`, beta, dev), методи `GET, HEAD, PUT`, заголовки `Range, Content-Type`, експонує `ETag, Content-Length, Content-Range, Accept-Ranges`.
- **Відкинуто:** Cloudflare Worker перед приватним бакетом з перевіркою JWT Supabase. Дає CDN-кеш і стабільні URL, але це новий сервіс з окремим деплоєм і секретами. Можна додати пізніше, якщо AD-005 покаже, що без CDN прев'ю повільне.

## R6. Мініатюри без Drive

**Рішення:** мініатюра — похідний об'єкт (`class='derived'`, `role='thumbnail'|'poster'`).
- Браузер: для картинок `createImageBitmap` → canvas → WebP 512 px; для відео `<video>` на 1-й секунді → canvas → WebP. Завантажується тим самим шляхом після оригіналу.
- Агент: наявний генератор постерів (`apps/agent/src/team-bridge/poster.ts`) пише через presigned PUT.
- Сервер: для картинок без мініатюри (імпорт US6, вихід агента без постера) — `catalog-image-optimization.ts` / WebP-кодер, що вже є в edge.
- Нема мініатюри → у провіднику іконка типу, як сьогодні для `preview_state='failed'`.

## R7. Каталог як фід, а не Google Sheet

**Факт:** таблиця каталогу створюється й оновлюється через Sheets API (`_shared/drive.ts`, `catalog-updater`, `drive-ops/catalog-durable.ts`), а оновлювач 047 пише клітинки з compare-and-swap.

**Рішення:** для R2-просторів джерело правди — база (налаштування каталогу, рядки товарів, тексти 041, картинки 045, відео 050). Фід рендериться з бази тим самим генератором колонок (`_shared/product-catalog.ts`) у CSV (RFC 4180, UTF-8 без BOM **[припущення: перевірити на beta з Meta]**) і пишеться цілком у публічний бакет каталогу з `If-Match` на попередній ETag. Після запису — очищення CDN для URL фіда.

- URL фіда стабільний на весь час життя каталогу: `https://<catalog origin>/f/<32 hex>.csv`.
- `cache-control: public, max-age=300` — Meta тягне фід за розкладом (година чи доба), 5 хвилин кешу не заважають.
- Перегляд і XLSX у застосунку — з бази, `no-store` (той самий шлях, що фінанси).

**Відкинуто:**
- Лишити Google Sheets. Тоді Soty потребує Google-підключення з правом запису, а це суперечить цілі.
- XML-фід. CSV простіший і збігається з поточними колонками. XML є запасним варіантом (Assumption 6).

**Ризик:** рядків до 400 на каталог (022), тож фід до кількох сотень КБ, і переписувати його цілком дешево (1 Class A на оновлення).

## R8. Відео каталогу завжди в R2

**Факт:** 050 тримає копію відео в публічному бакеті й перемикає посилання через `private.catalog_video_r2_reconcile`. Джерело копії — Drive.

**Рішення:** для R2-просторів джерело копії — об'єкт бібліотеки. Копія робиться серверним `CopyObject` між бакетами **[припущення: перевірити, що R2 дозволяє CopyObject між бакетами одного акаунта з різними ключами; інакше — потоковий GET→multipart PUT у робітнику 050]**. Опція «Копіювати відео в R2» для R2-просторів не показується й вважається ввімкненою. Невдача копії лишає каталог на попередній опублікованій версії (не на Drive).

## R9. Поширення назовні (`share_copy`)

**Рішення:** таблиця `team_share_links` (токен 32 байти, матеріал, автор, строк, відкликано). Маршрут `GET /s/<token>` в edge-функції перевіряє токен і відповідає 302 на presigned GET з TTL 1 година і `response-content-disposition`. Байти через edge не йдуть.

## R10. Захист від втрати даних

- **Факт R2:** версіонування об'єктів немає; є bucket locks з правилами утримання ([Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)).
- **Рішення:** три шари: (1) кошик 30 днів у базі; (2) tombstone з `not_before = now() + 7 days`; (3) bucket lock на 7 днів від створення об'єкта як захист від помилки в коді чи скомпрометованого ключа. Видалення тільки списком (як у міграції `20261105100000_restitch_bucket_retirement.sql`: «a deletion is a list, never a predicate»).
- Запобіжник масового видалення (FR-021) у робітнику tombstones.
- **Відкинуто на зараз:** друга копія в іншому провайдері (B2 тощо). Подвоює витрати на зберігання. Повернутись, якщо обсяг перевищить 5 ТБ або власник попросить.

## R11. Перехід простору

**Рішення:** `service_storage_cutover(team_id)` — ідемпотентна послідовність кроків у таблиці `team_storage_cutover_runs`, кожен крок записує завершення. Порядок кроків — FR-024. Виконує робітник (edge-функція `storage-ops` з named secret через `pg_cron`), адміністратор запускає з адмінки.

- Drive-матеріали не видаляються з бази: `lifecycle='archived_drive'`, їх не показують, але посилання з завдань, запусків і каталогів лишаються валідними (FR-025).
- Каталоги на Google Sheets: крок рендерить фід R2 з даних бази. Медіа: картинки вже R2; відео — якщо є готова R2-копія 050, береться вона; інакше, поки токен Drive ще живий, робітник 050 робить копію з Drive. Це єдиний Drive-читач у переході, і він обмежений активними каталогами.
- Токен Drive відкликається (`https://oauth2.googleapis.com/revoke`) останнім кроком перед перемиканням бекенду.

## R12. Агент

**Факт:** агент знає Drive через `apps/agent/src/team-bridge/*` (transfer, process, poster, restitch, landing-gallery, preview, source-cache).

**Рішення:** агент працює з абстрактними «URL читання» і «сесією запису», які видає сервер; більшість агентного коду вже отримує URL від сервера, а не ходить у Drive сам. Нові маршрути в contracts/agent-storage.md. Версія протоколу в `packages/shared` піднімається; сервер для R2-просторів вимагає нову версію.

## R13. Етап F: прибрати Drive

Після переходу всіх просторів: видалити `DriveAdapter`, `drive-transfer`, `drive-connect`, `drive-oauth-callback`, Drive-частину `catalog-sync` і `drive-ops`, Drive-маршрути агента, scope `drive.file` з OAuth-клієнта, бакети `team-thumbnail-cache` і `team-restitch-images` (за наявною міграцією 030, release C), `restitch/images.ts`. Опційно перейменувати `drive_file_id` → `item_key`, `team_drive_connections` → `team_storage_roots` (окремий PR, тільки перейменування).

## R14. Вартість

Розрахунок у spec.md, розділ «Вартість». Формула для `analytics storage`: `max(0, ГБ-місяці − 10) × 0.015 + max(0, ClassA − 1e6) × 4.5e-6 + max(0, ClassB − 1e7) × 3.6e-7`, де Class A/B оцінюються з подій AD-001/AD-005 (з поправкою на вибірку).

## R15. Порядок відносно 1.6 і спек 067–070

Нічого не потрапляє в `integration/1.6-polish`. Робота починається від `main` після релізу 1.6. Перетини: 070 (провідник) показує мініатюри й операції — бере URL мініатюр зі списку (R5) і не залежить від бекенду; 069/067 (запуски, назви) сховища не торкаються, крім посилань на відео каталогу (R8).
