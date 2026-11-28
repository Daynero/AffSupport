# Контракт сховища R2-простору (редакція 2026-11-27)

Замінює редакцію 2026-11-14: без організацій, квот-пакетів, міграції та епох авторитету.
Типи — у `packages/shared/src/team/space-storage.ts` (новий). Розбір невідомого входу —
дискримінованим результатом (конституція I). Помилки — наявний конверт `{ error: CODE }`
(конституція V): 202 — асинхронне, 403 — права, архів чи пілот, 409 — стан, ревізія чи квота,
413 — заявлений розмір понад ліміт, 503 — залежність.

Кожен виклик перевіряє на сервері:

1. Людина — учасник простору з роллю, що дозволяє дію (`private.can`).
2. Простір — R2, інакше `STORAGE_BACKEND_MISMATCH`.
3. Пілотний простір і немає T0 → у людини є запис у `storage_r2_pilots`, інакше `R2_PILOT_REQUIRED`.
4. Клієнт заявив `storage-r2/1` (заголовок `x-soty-capabilities`), інакше `CLIENT_UPDATE_REQUIRED`.
5. Простір не заблокований тарифом (034) і не архівний.

Клієнт ніколи не передає bucket, ключ чи URL сховища.

Маршрути агента (`/agent/source`, `/process/output/*`) не мають сесії людини: повноваження —
тикет операції, який база перевіряє при витраті (`consume_team_transfer_grant`). Людину і простір
називає тикет; перевірки 1–3 і 5 повторюються для неї. Агент заявляє `storage-r2/1` так само, як веб.
Контракт робочого простору агента 3 (`packages/shared/src/release.ts`) — перший, що говорить з R2.
Він навмисно не входить у `WEB_TOOL_REQUIREMENTS`: ту мапу побайтно звіряють із підписаним
stable.json, і новий ключ затримав би кожен реліз лише вебу до релізу агента. Веб питає контракт 3
для запуску чи збереження в R2-просторі, а сервер сам відмовляє протоколу 2.

## Edge-функція `space-storage` (POST, маршрут за шляхом, як у `drive-ops`)

| Шлях                       | Вхід                                                                                                                                                                                | Результат і інваріанти                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/spaces/create`           | `name`, `idempotencyKey`                                                                                                                                                            | Знімок простору. Створює `teams` з `storage_backend='r2'` і кореневу папку. Повтор із тим самим ключем повертає той самий простір                                                                                                                                                                                                                                                                                                                                                        |
| `/uploads/admit`           | `teamId`, `parentMaterialId`, `name`, `contentType`, `bytes`, `contentId`, `sha256` (довідково), `derivatives[]` (варіант, тип, байти, ширина, висота), `ingress`, `idempotencyKey` | `{ kind: 'exists', materialId }`, якщо такий вміст уже є в цій папці. Інакше `{ kind: 'session', uploadId, partBytes, partCount, derivativeSlots[], expiresAt }`. `derivativeSlots` порожні, якщо похідні для `contentId` уже є. Місце зарезервоване. `STORAGE_QUOTA_EXCEEDED` повертає `needBytes` і `freeBytes`                                                                                                                                                                        |
| `/uploads/{id}/parts`      | `parts[]` (номер, MD5 частини; ≤100 за раз)                                                                                                                                         | Підписані PUT-URL частин на ≤10 хв. `Content-MD5` входить у підпис, тож URL приймає лише заявлені байти, а R2 відхиляє пошкоджену частину. Права й квота перевіряються знову                                                                                                                                                                                                                                                                                                             |
| `/uploads/{id}/complete`   | `parts[]` (номер, ETag)                                                                                                                                                             | `CompleteMultipartUpload`. Сервер перераховує `contentId` з ETag (MD5) частин, які повернув R2 у `ListParts` (`CHECKSUM_MISMATCH`, якщо не збігся; R3). Похідні перевіряються: тип за першими байтами, розмір, розміри; невалідну відкинуто, оригінал фіксується з `thumbnail_state='pending'`. Потім одна транзакція: об'єкт, похідні, матеріал, посилання, облік, сигнал, завдання добору агентом для того, чого бракує. Повертає знімок матеріалу. Повтор повертає той самий матеріал |
| `/uploads/{id}/abort`      | —                                                                                                                                                                                   | Закриває multipart, звільняє резерв                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/materials/mutate`        | `action` (`rename`, `move`, `create_folder`, `trash`, `restore`, `copy`), `materialIds`, `expectedRevision`, цільові поля                                                           | Знімок. Порівнює ревізію (`REVISION_CONFLICT` з поточним станом). Перевіряє цикли й тенант. `copy` додає посилання на той самий об'єкт, байти не копіюються                                                                                                                                                                                                                                                                                                                              |
| `/trash/empty`             | `teamId`, необов'язково `materialIds`                                                                                                                                               | Видаляє з кошика остаточно, ставить об'єкти в чергу на видалення одразу. Шкала оновлюється в тій самій транзакції                                                                                                                                                                                                                                                                                                                                                                        |
| `/read-grant`              | `teamId`                                                                                                                                                                            | `{ grant, expiresAt, filesOrigin }`. Грант читання простору на ≤10 хв (HMAC над user, team, `access_epoch`)                                                                                                                                                                                                                                                                                                                                                                              |
| `/process/start`           | `teamId`, `materialId`, `destinationFolderId` (null — корінь), `toolId`, `outputName`, `conflictMode`, `idempotencyKey`, `agentContractVersion`, `toolContractVersion`              | Як `drive-ops/process/start`: рядок `team_operations` з зарезервованим іменем виходу (те саме чисте правило `buildUploadConflictPlan`), тикети агента `process_input` і `finalize` (у базу — лише їхні хеші), `agentContractVersion: 3`. Відмовляє: `versionOfMaterialId` (версій на R2 ще немає), ключ `catalog-variant:` (окремий маршрут, T041), `translation`                                                                                                                        |
| `/materials/agent-grant`   | `teamId`, `materialId`                                                                                                                                                              | Тикет `download_range` на один файл для збереження через агента; адресу агента будує веб                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/agent/source`            | `ticket`, `purpose` (`process_input` або `download_range`), `operationId` для запуску                                                                                               | URL читання з Range для агента (той самий Worker, грант читання ≤10 хв) і очікувані `bytes`/`contentId`. На 401 від Worker агент обмінює тикет ще раз                                                                                                                                                                                                                                                                                                                                    |
| `/process/output/start`    | тикет, `bytes`, `contentId`, `contentType`, `derivatives[]`, `outputUploadProtocolVersion: 3`                                                                                       | Сесія multipart, як у `/uploads/admit`, з `ingress='agent_output'` і ключем `process_output_<operation>`; ім'я і тип — з наміру запуску. Протокол 2 → `AGENT_UPDATE_REQUIRED` ще до витрати тикета                                                                                                                                                                                                                                                                                       |
| `/process/output/parts`    | тикет, `uploadId`, `parts[]` (номер, MD5; ≤100)                                                                                                                                     | Підписані PUT-URL частин, як `/uploads/{id}/parts`; лише для завантаження цього запуску                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/process/output/finalize` | тикет, `uploadId`, `audioFingerprint`                                                                                                                                               | `CompleteMultipartUpload` за частинами з `ListParts` (як `/uploads/{id}/complete`), потім одна транзакція: `processed_from`, операція `succeeded`, байти в категорії `process`. Повтор → той самий матеріал, `reused: true`. Невідповідність частин → операція `failed` з `CHECKSUM_MISMATCH`. Транскрипт — компаньйон відео                                                                                                                                                             |
| `/process/output/quiesced` | тикет                                                                                                                                                                               | Агент завершився без результату: відкрита сесія виходу закривається, резерв звільняється. Сесію `completing` не чіпає. Повторюваний                                                                                                                                                                                                                                                                                                                                                      |

## RPC (PostgREST)

| RPC                                                                                                                              | Що повертає                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_my_teams_v2()`                                                                                                             | Як `list_my_teams()`, плюс `storage_backend`, `storage_pilot`, `content_revision`. Старий `list_my_teams()` R2-простори не повертає           |
| `list_team_folder_page`, `list_team_folder_tree`, `list_team_folder_subtree`, `list_team_trashed_materials_v2`                   | Без зміни сигнатур. Для R2-простору працюють за `parent_folder_id` = uuid і без з'єднання з `team_drive_connections`                          |
| `get_space_storage_summary(p_team)`                                                                                              | `capacityBytes`, `usedBytes`, `reservedBytes`, сегменти `{ category, bytes, objects, sharedBytes }`, `revision`. Сума сегментів = `usedBytes` |
| `list_space_storage_items(p_team, p_category, p_sort, p_search, p_cursor)`                                                       | Сторінка речей категорії: тип, id, назва, байти, автор, дата. Сортування за вагою, датою, автором. Перші 10 — найбільші                       |
| `get_catalog_storage_breakdown(p_catalog)`                                                                                       | `totalBytes`, `sharedBytes`, `freedOnDeleteBytes` (US9.3)                                                                                     |
| `service_claim_space_derivative_jobs(p_device, p_limit)`, `service_finish_space_derivative(p_object, p_recipe, …)`               | Добір похідних агентом з доступом: claim з орендою, завершення перевіряє похідні так само, як `complete-upload`                               |
| `admin_list_storage_r2_pilots()`, `admin_add_storage_r2_pilot(p_email, p_max_bytes)`, `admin_remove_storage_r2_pilot(p_user_id)` | За зразком `admin_*_release_tester`. Лише адміністратор, з аудитом                                                                            |

## Worker `space-read` (`apps/catalog-image-delivery/src/space-read.ts`)

- **Маршрути.** `GET`/`HEAD` `https://files[-beta].soty.pp.ua/t/{team}/o/{content_id}` і
  `/t/{team}/d/{content_id}/{recipe}/{variant}` з `?g={grant}`. Для скачування додається
  `&dl={name}`: тоді `Content-Disposition: attachment` з безпечним іменем.
- **Порядок.** Перевірити підпис і строк гранту, потім `access_epoch` простору, потім що
  `team` у гранті збігається з `team` у шляху. Лише після цього `cache.match` за URL без
  `g`, або читання R2 з Range.
- **Заголовки.** `Cache-Control: private, max-age=31536000, immutable`, `Accept-Ranges: bytes`.
- **Помилки** — `no-store`. Протермінований грант → 401: клієнт бере новий і повторює раз.
  Чужий простір чи відкликана епоха → 403. Видалений об'єкт → 404.
- **Межі.** Без меж розміру відповіді для `o/*`: Range і потокова віддача. Сам Worker
  нічого не пише в R2.
- **Грант в адресі.** Хост файлів відповідає `Referrer-Policy: no-referrer`. Worker і
  журнал ніколи не записують `g` чи повну адресу з ним. Грант живе ≤10 хв і відкриває лише
  один простір. Тому витік з історії браузера обмежений строком і відкликається епохою.
- **Чого не можна відкликати.** Байти, які людина вже скачала, чи копію в її браузерному
  HTTP-кеші відкликати неможливо. Відкликання діє на кожне нове читання (FR-013). Вихід з
  акаунта шле `Clear-Site-Data: "cache"` з файлового хоста. Видалення учасника цього
  зробити за нього не може — це названо в поясненні відкликання.
- **Бета (2026-11-28).** API беті лише на `127.0.0.1:54321`, тож Worker туди не дістанеться.
  Ті самі читання з тими самими відповідями віддає `space-storage`:
  `GET`/`HEAD` `{API}/functions/v1/space-storage/files/t/{team}/…?g=` (`files.ts`, ядро
  `packages/shared/src/team/space-read.ts`). `filesOrigin` гранту тоді — ця адреса. Маршрут є
  лише за конфігом `beta`/`dev`; у проді його немає, і грант туди не вкаже.

## Стрічка каталогу

`GET https://catalog-videos[-beta].soty.pp.ua/feeds/{feed_id}.csv` віддає
`text/csv; charset=utf-8`. Колонки ті самі, що в Google-шаблоні Meta
(`PRODUCT_CATALOG_TEMPLATE`). Правило кешу зони — TTL ≤60 с для `/feeds/*`. Видалення
каталогу видаляє об'єкт і чистить кеш цієї адреси (`R2_CATALOG_PURGE_TOKEN`), тож адреса
віддає 404 за ≤1 хв (SC-014).

## Посилання Soty (M2)

- **Створення.** `POST /share-links` в `space-storage`: `materialId`, `mode`, `expiresAt` →
  `{ url, id }`. Відкликання — `POST /share-links/{id}/revoke`.
- **Сторінка.** `https://files.soty.pp.ua/s/{token}` показує перегляд без акаунта.
  Скачування рахує `bytes_served` і зупиняється на `bytes_limit` (FR-043).

## Коди

Нові коди — у `packages/shared/src/types.ts`, у мапі транспорту команди і в
`scripts/analytics/code-map.ts`:

- `STORAGE_BACKEND_MISMATCH`
- `R2_PILOT_REQUIRED`
- `CLIENT_UPDATE_REQUIRED`
- `STORAGE_QUOTA_EXCEEDED`
- `STORAGE_OBJECT_TOO_LARGE`
- `REVISION_CONFLICT`
- `UPLOAD_EXPIRED`
- `CHECKSUM_MISMATCH`
- `SPACE_ARCHIVED`
- `SHARE_LINK_EXPIRED`
- `SHARE_LINK_LIMIT`
- `STORAGE_UNAVAILABLE` (503, повторюваний: bucket не відповів або відмовив не з вини клієнта; T009)

Для кожного є тест відображення в HTTP і UI.

## Ліміти (оприлюднені, FR-017)

- Об'єкт — до 100 ГіБ.
- Частина — 16 МіБ типово. 64 МіБ, якщо файл більший за 50 ГіБ.
- Не більше 10 000 частин.
- Не більше 8 паралельних частин на файл у браузері й 4 в агенті.
- Не більше 100 000 матеріалів на простір.

Значення живуть у `packages/shared/src/team/space-storage.ts` як константи (конституція I).
