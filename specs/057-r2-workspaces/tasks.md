# Задачі: простори Soty на R2

**Вхід**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).
**Редакція**: 2026-11-27, замінює 72 задачі старої моделі переносу. Імплементацію не почато.

**Формат**: `- [ ] T### [P] [US#] опис зі шляхом`. `[P]` — можна паралельно (інший файл,
без незавершених залежностей). Мітка історії — лише у фазах історій.

## Правила виконання

- **Тести.** Їх вимагає специфікація (безпека, квоти, видалення, паралельність). Кожна
  задача імплементації має власну тестову задачу. Тест пишеться першим і спершу падає.
- **Одна важка річ за раз.** Перед запуском — `uptime` і `pgrep -fl "vitest|tsc|supabase"`.
- **Vitest — лише свої файли:**
  `npx vitest run tests/<file> --pool=forks --poolOptions.forks.singleFork=true`.
- **SQL — `npm run test:db`** з файлом задачі. Він бере ізольовану копію схеми.
- **Повний `npm run verify` локально не запускати.** Його проганяє CI або раннер релізу.
- **Міграції.**
  - Лише адитивні. Мітка часу — після найбільшої на гілці; на беті спершу перевірити
    `supabase_migrations.schema_migrations`, бо там є чужі версії.
  - Кожна нова таблиця з інвентаря огорожі (ім'я `team_*`/`launch_*`/`catalog_*`, FK на
    `team_materials`, json/jsonb) отримує тригер `task_cleanup_reference_fence` у тій самій
    міграції ([data-model.md](data-model.md)).
  - На беті — через `psql` і запис у `schema_migrations`. Ніколи `db reset`.
- **Мова.** Код і коміти англійською, тексти інтерфейсу — через `apps/web/src/locales`.
- **UI.** Лише компоненти `apps/web/src/components/ui/` і токени `apps/web/src/styles/tokens.css`.

## Етап M1 — пілот власника на next

### Фаза 1 — підготовка

- [x] T001 Кваліфікувати R2 і Cloudflare на beta-акаунті. Новий скрипт `scripts/space-storage-qualify.mjs` відмовляється від будь-якого не-beta bucket. Перевірити:
  - **відкрита перевірка (R3, редакція 2026-11-28):** R2 відхиляє `UploadPart` з невірним `Content-MD5` (`400 BadDigest`) і повертає ETag частини = MD5 її байтів в `UploadPart`, `ListParts` і `CompleteMultipartUpload` — на цьому стоїть `content_id`. `x-amz-checksum-sha256` R2 не підтримує (501 у кваліфікації 050), його не перевіряти;
  - ліміти multipart;
  - CORS для `https://next.soty.pp.ua`, прод- і beta-вебадрес;
  - readback юрисдикції EU для `soty-spaces-beta`;
  - межі безкоштовного плану Workers (запити на добу, CPU на запит) для `space-read`.

  Containers, Queues і платний план не використовуються (research.md R5). Результат — `specs/057-r2-workspaces/evidence/qualification.md`. Якщо R2 не перевіряє `Content-MD5` або ETag частини не є її MD5 — записати вимкнення дедуплікації за R3.

  **Зроблено 2026-11-28** (43/43, [evidence/qualification.md](evidence/qualification.md)). `BadDigest` на невірному MD5; ETag частини — `"<md5>"` в `UploadPart` і `ListParts`; об'єкта — `"<md5 від MD5>-N"`. Дедуплікація лишається. CORS віддає `ETag`, Range дає `206`. Наслідки — сервер звіряє розмір кожної частини (`InvalidPart` на неоднакових) і 4xx від R2 не повторює. **Юрисдикція: readback виконано, `soty-spaces-beta` стандартна, не EU** — рішення для проду перенесено в T062.

- [ ] T002 Описати інфраструктуру як код, застосувати лише до beta:
  - `apps/catalog-image-delivery/wrangler.toml`: маршрут `files-beta.soty.pp.ua/*` і біндінг `SPACE_BUCKET`;
  - `config/space-storage/r2-lifecycle.json`: multipart 1 доба, `t/*/u/*` 7 діб;
  - `config/space-storage/r2-cors.json`;
  - правило кешу зони для `/feeds/*` з TTL ≤60 с — описати в `docs/PRODUCTION.md`.

  Прод-ресурси створюються лише в T062.

  **Стан 2026-11-28.** Файли є: `config/space-storage/r2-{cors,lifecycle}.json` збігаються з bucket, `[env.beta]` у `wrangler.toml`, розділ «Space bucket and files host (057)» у `docs/PRODUCTION.md`; правило `/feeds/*` описане там же. CORS і lifecycle на `soty-spaces-beta` застосовано. Відкрито до дозволу власника: DNS `files-beta.soty.pp.ua`, деплой `--env beta` (маршрут), секрети Worker-а, публічна HTTPS-адреса beta-API для `SUPABASE_URL`, правило `/feeds/*` на `catalog-videos-beta`. Правило `t/*/u/*` 7 діб не потрібне й невиразне: оригінали йдуть одразу в `o/`, а умови lifecycle — лише префікси.

- [x] T003 [P] Контракт `packages/shared/src/team/space-storage.ts`:
  - стани завантаження, похідних і видалення;
  - категорії обліку й `ingress`;
  - можливість `storage-r2/1` і ліміти (частина, кількість частин, паралельність, 100 ГіБ, 100 000 матеріалів, байти й розміри кожного варіанта похідної);
  - обчислення `content_id` з розміру частини, довжини й ETag (MD5) частин (research.md R3, редакція 2026-11-28) — одна функція для вебу, агента й сервера;
  - розбір відповідей як `unknown` → дискримінований результат, байти — десятковим рядком.

  Коди з [contracts/storage-api.md](contracts/storage-api.md) додати в `packages/shared/src/types.ts`, експорт — у `packages/shared/src/index.ts`. Новий `packages/shared/src/team/space-read-grant.ts`: HMAC-грант на WebCrypto, спільний для Deno і Worker.

- [x] T004 [P] Тест для T003 — `tests/space-storage-contract.test.ts`. Розбір відкидає незнайоме. Байти не втрачають точності понад 2^53. Грант: підпис, строк, епоха, чужий простір. Кожен код має переклад і HTTP-статус.

### Фаза 2 — основа (блокує всі історії M1)

- [x] T005 Тест для T006 (пишеться першим) — `supabase/tests/database/space-storage-schema.test.sql`. Перевірити:
  - `teams.storage_backend` не змінюється після створення;
  - `CHECK`: Drive-рядок без `drive_file_id` відхилено, R2-рядок без об'єкта відхилено (крім папки й стрічки каталогу);
  - цикли папок відхилено, батько з іншого простору — теж;
  - RLS між просторами;
  - тригери огорожі на `team_space_storage_signals` і `space_uploads`, `private.task_cleanup_coverage_verified()` = true;
  - облік: інкременти точні, спільний об'єкт рахується раз, `shared_bytes` правильні.
- [x] T006 Міграція `supabase/migrations/<ts>_space_storage_foundation.sql` за [data-model.md](data-model.md) M1:
  - колонки `teams`;
  - `team_materials`: `DROP NOT NULL` на `connection_id`, `drive_file_id`, новий `CHECK`, `space_object_id`, `material_revision`;
  - таблиці `storage_r2_pilots` з `admin_list/add/remove_storage_r2_pilot` і `is_storage_r2_pilot()` за зразком `supabase/migrations/20261207399800_release_testers.sql`;
  - `space_objects`, `space_object_refs`, `space_storage_usage` з тригерами категорій, `space_storage_reservations`, `space_uploads`, `space_derivative_jobs`, `space_object_purges`, `space_storage_reconciliations`;
  - `team_space_storage_signals` у `supabase_realtime` з RLS, як у `team_catalog_video_r2_signals`;
  - `private.space_storage_journal`;
  - тригери огорожі.

  Нотатку відкату додати в `supabase/migrations/ROLLBACK.md`. Тест: T005.

- [x] T007 Тест для T008 (пишеться першим) — `supabase/tests/database/space-storage-access.test.sql`.
  - `list_my_teams()` не повертає R2-простір, `list_my_teams_v2()` повертає `storage_backend`.
  - `access_epoch` зростає при видаленні учасника й зміні ролі.
  - Кожна функція зі списку T008 працює з R2-рядком: `list_team_folder_page`, `list_team_folder_tree`, `list_team_folder_subtree`, `list_team_materials`, `list_team_trashed_materials_v2`. Для R2-рядка вона не повертає null-полів Drive як помилку.
- [x] T008 Міграція `supabase/migrations/<ts>_space_storage_access.sql`:
  - перевизначити `list_my_teams()` з `supabase/migrations/20261130100000_space_tariffs.sql:655` з фільтром `storage_backend='drive'`;
  - додати `list_my_teams_v2()`;
  - пілотний пункт у `private.team_workspace_allowed()` (там же, :252): пілотний простір відкритий учасникам із `is_storage_r2_pilot()` без тарифу 034;
  - тригери `access_epoch`;
  - R2-гілки (`parent_folder_id` = uuid, без з'єднання з `team_drive_connections`) у функціях списку з T007.

  Спершу зробити grep-інвентар функцій, що з'єднують `team_drive_connections` або читають `drive_file_id` на шляхах, які кличе R2-клієнт. Список записати в коментар міграції. Тест: T007.

- [x] T009 [P] Клієнт bucket простору `supabase/functions/_shared/r2-space.ts` поверх `npm:aws4fetch@1.0.20`. Конфігурація — як `readCatalogVideoR2Config` у `supabase/functions/_shared/r2-catalog-video.ts:40`:
  - змінні `R2_SPACE_ACCOUNT_ID`, `R2_SPACE_ACCESS_KEY_ID`, `R2_SPACE_SECRET_ACCESS_KEY`, `R2_SPACE_BUCKET`;
  - ім'я bucket мусить дорівнювати `soty-spaces-${CATALOG_IMAGES_ENVIRONMENT}`.

  Методи: `createMultipart`, `signPart` (з `Content-MD5`), `completeMultipart`, `abortMultipart`, `listParts`, `head`, `rangeGet`, `remove`, `listPrefix`. Помилки провайдера санітизувати, як у `CatalogVideoR2`.

- [x] T010 [P] Тест для T009 — `tests/space-storage-r2-client.test.ts`: підписи й заголовок `Content-MD5`, ETag частин з `ListParts`, захист імені bucket, санітизація помилок, сторінкування `listPrefix` (фейковий fetch).
- [x] T011 Журнал і реєстрація кодів:
  - `supabase/functions/_shared/space-storage-journal.ts` пише в `private.space_storage_journal` без імен, шляхів і ключів;
  - коди 057 — у `scripts/analytics/code-map.ts` за зразком `catalog:video_r2:${code}`;
  - можливість `team.space_storage` — у `scripts/analytics/coverage-registry.ts`.
- [x] T012 [P] Тест для T011 — `tests/space-storage-codes.test.ts`: кожен код із `packages/shared/src/team/space-storage.ts` є в `CODE_MAP`. Рядок журналу не містить полів `name`/`path`/`key`.

### Фаза 3 — US11: пілот власника, ізоляція (P1)

**Мета**: власник із дозволом створює R2-простір на next. Інші акаунти, прод-веб і прод-агент
нічого не помічають.
**Незалежна перевірка**: [quickstart.md](quickstart.md) M1 крок 1.

- [x] T013 [P] [US11] Тест для T015 — `tests/space-storage-create.test.ts`:
  - `/spaces/create` ідемпотентний за ключем і створює кореневу папку;
  - без пілоту → `R2_PILOT_REQUIRED`, без `x-soty-capabilities: storage-r2/1` → `CLIENT_UPDATE_REQUIRED`.

  Додати `supabase/tests/database/space-storage-pilot.test.sql`:
  - адмін-RPC лише для адміністратора й з аудитом;
  - зняття дозволу не видаляє простір;
  - запрошений без пілоту не відкриває простір.

- [x] T014 [P] [US11] Тест для T016 — `tests/storage-r2-pilots-card.test.tsx`: список, додавання за поштою з лімітом обсягу, зняття, помилки RPC.
- [x] T015 [US11] Edge-функція `supabase/functions/space-storage/`:
  - `index.ts`: маршрут за шляхом, лише POST, як `routePath()` у `supabase/functions/drive-ops/index.ts:3488`;
  - `handler.ts`: чисті валідатори;
  - `create.ts`: `/spaces/create` через RPC `service_create_r2_space` у міграції `supabase/migrations/<ts>_space_storage_create.sql`;
  - запис `[functions.space-storage]` у `supabase/config.toml`.

  Спільна перевірка запиту — п'ять умов з [contracts/storage-api.md](contracts/storage-api.md). Тест: T013.

- [x] T016 [P] [US11] Адмін-картка `apps/web/src/pages/admin/StorageR2PilotsCard.tsx` за зразком `ReleaseTestersCard.tsx`. Підключити в `apps/web/src/pages/AdminPage.tsx:385` поруч. Тест: T014.
- [x] T017 [P] [US11] Тест для T018 — `tests/space-r2-create-flow.test.tsx`:
  - вибір «На R2» з'являється лише коли `siteChannel()` = `next` і є пілот;
  - на прод-адресі вибору немає;
  - `spaceReadiness` вважає R2-простір готовим без Drive;
  - `listTeams` повертається до `list_my_teams` на `PGRST202`.
- [x] T018 [US11] Створення R2-простору у вебі:
  - `apps/web/src/team/create/CreateSpaceWizard.tsx` і новий `apps/web/src/team/storage/CreateR2SpaceStep.tsx` — без кроку папки Drive;
  - `spaceReadiness()` у `apps/web/src/team/lobby/SpaceCard.tsx:25`;
  - `teamApi.listTeams` (`apps/web/src/api/team.ts:2258`) → `list_my_teams_v2` з відступом, як у `apps/web/src/lib/release-tester.ts`;
  - `TeamContextSnapshot` (`team.ts:285`) отримує `storageBackend`;
  - `mapTeamContext` (`team.ts:1361`) його розбирає.

  Тест: T017.

  Рішення 2026-11-28 (імплементація): вибір «У сховищі Soty» — у кроці назви, а не окремим
  кроком, тож R2-простір створюється за один крок. Крім `next`, його бачить пілот і на
  непродакшн-стеку (`siteChannel()` = `other`, середовище не `production`, тобто бета), бо
  пілот спершу доводиться на беті; копія прод-сайту, яку віддає агент, вибору не має. На
  прод-адресі `listTeams` питає лише `list_my_teams`, тож R2-простір там прихований (FR-053),
  а `is_storage_r2_pilot` навіть не викликається.

- [x] T019 [P] [US11] Тест для T020 — `tests/space-storage-isolation.test.ts` і `supabase/tests/database/space-storage-isolation.test.sql`:
  - файлові маршрути `drive-ops` і `drive-transfer` на R2-простір → `STORAGE_BACKEND_MISMATCH`;
  - `outputUploadProtocolVersion: 2` на R2 → `AGENT_UPDATE_REQUIRED`;
  - claim фонової роботи для R2 агентом контракту 2 не видається;
  - `catalog-sync` не бере R2-простір.
- [x] T020 [US11] Ізоляція старих шляхів:
  - `drive-ops`: `loadContext` і `rootDestination` (`supabase/functions/drive-ops/index.ts:613`, `:538`) через `service_get_material_operation_context` і `service_get_root_operation_context` — для файлових маршрутів;
  - `drive-transfer`: `authorizeCaller` (`supabase/functions/drive-transfer/index.ts:1756`);
  - `requireProcessUploadProducer` (`supabase/functions/drive-ops/process-output-upload.ts:7`) — протокол 3 для R2;
  - claim-и делегованої фонової роботи (`team_recovery_*`) — вимагають контракт агента 3 для R2;
  - `private.claim_catalog_sync_jobs` — явна умова `storage_backend='drive'`.

  SQL — у міграції `supabase/migrations/<ts>_space_storage_isolation.sql`. Тест: T019.

### Фаза 4 — US1: робота в R2-просторі без Google (P1)

**Мета**: учасник завантажує, знаходить, перейменовує, переносить, скачує, видаляє й відновлює
файли. Вкладення, обробка й каталоги працюють без Drive і без агента власника для перегляду.
**Незалежна перевірка**: quickstart M1 кроки 2, 3, 7, 8.

- [x] T021 [P] [US1] Тест для T023 — `tests/space-storage-upload.test.ts`:
  - `admit` повертає `exists` для того самого вмісту в тій самій папці;
  - для іншої папки створює новий матеріал з посиланням на наявний об'єкт;
  - квота → `STORAGE_QUOTA_EXCEEDED` з `needBytes`;
  - `parts` знову перевіряє права;
  - `complete` ідемпотентний, повтор після втрати відповіді;
  - знята роль між `admit` і `complete` → відмова;
  - протермінована сесія → `UPLOAD_EXPIRED`.
- [x] T022 [P] [US1] Тест для T023 — `supabase/tests/database/space-storage-commit.test.sql`:
  - фіксація атомарна: об'єкт, матеріал, посилання, облік, сигнал, завдання похідних і `content_revision`;
  - 100 паралельних резервувань на межі квоти не перевищують її (SC-004 для простору);
  - `uncertain` не звільняється без звірки.
- [x] T023 [US1] Маршрути `/uploads/admit|{id}/parts|{id}/complete|{id}/abort` у `supabase/functions/space-storage/uploads.ts`. RPC `service_admit_space_upload`, `service_complete_space_upload`, `service_abort_space_upload` — у міграції `supabase/migrations/<ts>_space_storage_uploads.sql`. Порядок блокувань: team → material. Тести: T021, T022.
- [x] T024 [P] [US1] Тест для T025 — `tests/space-storage-mutate.test.ts` і `supabase/tests/database/space-storage-mutate.test.sql`:
  - rename, move, create_folder, copy (без копіювання байтів), trash і restore піддерева;
  - `REVISION_CONFLICT` з поточним станом;
  - цикли;
  - права за ролями з `private.can`;
  - `/trash/empty` одразу ставить об'єкти в чергу на видалення.
- [x] T025 [US1] Маршрути `/materials/mutate` і `/trash/empty` у `supabase/functions/space-storage/mutate.ts`. RPC `service_mutate_space_materials`, `service_empty_space_trash`; семантика `folder_trash_root` — як у `supabase/migrations/20260930120000_folder_trash.sql`. Тест: T024.
- [x] T026 [P] [US1] Тест для T027 — `tests/space-read-worker.test.ts`:
  - грант: підпис і строк;
  - відкликана епоха → 403 за ≤30 с кешу епохи;
  - простір у гранті ≠ простір у шляху → 403;
  - ключ кешу без `g`, Range → 206;
  - безпечне `Content-Disposition`;
  - `no-store` на помилках;
  - чужий хост не обслуговується.
- [x] T027 [US1] Worker читання й видача гранту:
  - `apps/catalog-image-delivery/src/space-read.ts`;
  - вибір обробника за хостом у `apps/catalog-image-delivery/src/index.ts`, біндінг `SPACE_BUCKET`;
  - маршрут `/read-grant` у `supabase/functions/space-storage/read.ts`;
  - RPC `service_space_read_epoch(p_team)` для Worker (лише сервісний ключ).

  Тест: T026.

  **Доповнення 2026-11-28 (рішення ведучого):** на беті API Supabase слухає лише
  `127.0.0.1:54321`, тож Worker `space-read` ніколи туди не дістанеться. Бета читає через
  `GET|HEAD /functions/v1/space-storage/files/t/{team}/…` (`supabase/functions/space-storage/files.ts`):
  той самий обробник, винесений у `packages/shared/src/team/space-read.ts` (Worker лише
  реекспортує), потік з R2 через S3, без кешу краю. Маршрут є лише коли `CATALOG_IMAGES_ENVIRONMENT`
  = `beta`/`dev` і `SPACE_FILES_ORIGIN` = сам маршрут; у проді — 404, а `/read-grant` відмовляє
  такій адресі. Клієнти йдуть за `filesOrigin` гранту; веб-збірка з `VITE_APP_ENVIRONMENT=beta`
  приймає маршрут, продова — ні. На next/проді шлях читання — Worker. Тест —
  `tests/space-read-local-route.test.ts` (увімкнено на беті, відсутній у проді, відповіді
  тотожні Worker-у). Опис — docs/PRODUCTION.md «Reads on beta».

- [x] T028 [P] [US1] Тест для T029 — `tests/space-explorer-adapter.test.ts`: R2-простір ніколи не кличе `drive-ops` чи `drive-transfer`. Drive-простір кличе те саме, що й до змін (знімок викликів).
- [x] T029 [US1] Клієнт `apps/web/src/api/space-storage.ts` і перемикач за `storageBackend` у `apps/web/src/api/team.ts`:
  - `startUpload`/`relayUploadChunk`/`finalizeUpload` (:4842–4917);
  - `renameMaterial`/`moveMaterial`/`copyMaterial`/`trashMaterial`/`restoreMaterial` (:4932–4985);
  - `requestDownload` (:5009), `previewMaterial` (:5176), `thumbnailUrl` (:4513).

  У `apps/web/src/team/explorer/useExplorerFileOps.ts` і `CreateFolderDialog.tsx` для R2 — `create_folder` замість `ensure*`. Тест: T028.

- [x] T030 [P] [US1] Тест для T031 — `supabase/tests/database/space-storage-attachments.test.sql` і `tests/space-task-attachments.test.tsx`:
  - вкладення в R2-просторі має посилання категорії `attachments`;
  - відкріплення не видаляє матеріал, що лишився в провіднику;
  - `CopyDriveLinkButton` для R2 не показується.
- [x] T031 [US1] Вкладення завдань у R2-просторі:
  - R2-гілка `begin_task_upload` і `attach_team_task_materials` (міграція `supabase/migrations/<ts>_space_storage_attachments.sql`) — папка вкладень є матеріалом простору;
  - `apps/web/src/team/tasks/TaskAttachmentPicker.tsx`, `TaskAttachmentTile.tsx`, `useAttachmentFolders.ts`;
  - приховати `apps/web/src/team/library/CopyDriveLinkButton.tsx` для R2, поки нема T069.

  Тест: T030.

  Рішення 2026-11-28 (імплементація T021–T031):
  - multipart оригіналу відкривається одразу на кінцевому ключі `t/{team}/o/{content_id}`: R2
    нічого там не показує, доки сервер не завершить його, а сервер завершує лише після того, як
    перерахував `content_id` з ETag частин від `ListParts`. Копія `u/ → o/` на сервері для 100 ГіБ
    не вклалась би в межі edge. `staging_key` (`t/{team}/u/{upload}`) лишається префіксом для
    похідних (T047) і правила життєвого циклу (T002);
  - повтор `complete` після втраченої відповіді: multipart уже зник (`NoSuchUpload` → `NOT_FOUND`
    у `r2-space.ts`), тоді HEAD ключа вмісту з заявленою довжиною — доказ, що байти там;
  - `derivatives[]` у `admit` перевіряється за формою, але слотів поки немає (`derivativeSlots: []`);
    фіксація ставить `space_derivative_jobs` з `client_skipped` для зображень і відео — T047 додає
    похідні клієнта;
  - «вже є» в іншій папці відповідає `{kind:'exists'}` з новим матеріалом на тому самому об'єкті;
    кожна відповідь `admit` — рядок `space_uploads` під ключем ідемпотентності, тож повтор дає
    ту саму відповідь;
  - видалення байтів: коли зникає останнє посилання, об'єкт іде в `space_object_purges`
    (`purge_pending`); той самий вміст, що повернувся до видалення, відроджується. Поки видалення
    в дорозі (`attempts > 0`), `admit`/`complete` того самого вмісту відповідають
    `STORAGE_UNAVAILABLE` (повторюване). Майбутній `space-storage-sweeper` мусить блокувати рядок
    об'єкта й не брати об'єкт, для якого є відкрите завантаження з тим самим `content_id`;
  - рядки R2 у `list_team_folder_page`/`list_team_folder_tree` мають `driveFileId` = власний id
    (ключ рядка й папки для вебу; ніколи не Drive-id), плюс `contentId` і `materialRevision`;
  - `parentMaterialId`/`targetFolderId` = null означає корінь простору;
  - новий маршрут `/materials/read` (до 100 id, право `view`) дає знімки матеріалів, яких клієнт
    ще не бачив у списку (вкладення, пошук), для адрес `files-*`;
  - кошик: `/trash/empty` видаляє глибші першими, кожен у своїй підтранзакції; матеріал, на який
    ще посилається завдання чи каталог, лишається в кошику;
  - папка вкладень R2 — звичайна папка «Task attachments» у корені (`create_folder ensure`);
    перейменування створить нову при наступному скиданні — прийнятно для M1;
  - грант читання: невалідний/підроблений → 401 (клієнт бере новий, це покриває й ротацію ключа),
    чужий простір чи відкликана епоха → 403. Worker читає епоху через
    `service_space_read_epoch` (текст, не число) сервісним ключем, кеш ≤30 с;
  - веб: «замінити» й «нова версія» для R2 відмовляють `INVALID_INPUT` (версій ще немає),
    скачування агентом — `AGENT_UPDATE_REQUIRED` до T033; превʼю транскриптів, архівів і лендингів
    — як непідтримувані. Меню дій вважають R2-простір підключеним.

- [x] T032 [P] [US1] Тест для T033 — `tests/agent-r2-transfer.test.ts`:
  - multipart з `Content-MD5` частин і ≤4 паралельними частинами;
  - продовження з журналу після обриву;
  - Range-скачування з `files-*`, оновлення гранту на 401;
  - розбіжність хешу → помилка без фіксації;
  - навантаження йде через PowerGovernor.
- [x] T033 [US1] Агент контракту 3:
  - новий `apps/agent/src/team-bridge/r2-transfer.ts`;
  - підключення в `TeamTransferClient` (`apps/agent/src/team-bridge/transfer.ts:124`, `downloadSource` :135, `uploadResult` :376 — `validateGoogleSession` :630 лишається для Drive), `download.ts` (`TeamDownloadBridge.download` :175), `process.ts` (`TeamProcessBridge` :171);
  - `AGENT_TOOL_CONTRACTS.teamWorkspace` 2 → 3 і `WEB_TOOL_REQUIREMENTS` для R2 у `packages/shared/src/release.ts:114`, `:187` (виконано інакше: `WEB_TOOL_REQUIREMENTS` не змінено, бо його звіряють зі stable.json; натомість `SPACE_STORAGE_AGENT_CONTRACT` і перевірка на запуск — див. contracts/storage-api.md);
  - маршрути `/agent/source` і `/process/output/start` (протокол 3) у `supabase/functions/space-storage/agent.ts`;
  - `apps/agent/src/team-bridge/source-cache.ts` (`TeamSourceCache` :53) — ключ за `content_id` об'єкта, тож повторна обробка того самого вмісту не скачує його вдруге (FR-037 для агента).

  Тест: T032.

- [x] T034 [P] [US1] Тест для T035 — `tests/space-storage-process.test.ts`:
  - стиснення, транскрипт і перезашивка на R2-простір: старт видає джерело R2;
  - результат фіксується як матеріал з `processed_from` і категорією `process`;
  - `quiesced` і повтор фіналізації ідемпотентні.
- [x] T035 [US1] Маршрути `/process/start`, `/process/output/finalize`, `/process/output/quiesced` у `supabase/functions/space-storage/process.ts`. Поведінка — як `handleProcessStart` (`supabase/functions/drive-ops/index.ts:2106`), `handleProcessOutputFinalize` (:2471), `handleProcessOutputQuiesced` (:2315). Чисті перевірки взяти з `supabase/functions/drive-ops/handler.ts`, не копіювати. Веб `apps/web/src/api/client.ts` (:704, :1044) передає агенту R2-гранти. Тест: T034.

  **Доповнення 2026-11-28 (відкладене з T035):** після фіналізації R2-запуску, як на Drive:
  текст транскрипту читається з bucket (≤1 МіБ + 4 Б) і зберігається для пошуку через
  `service_commit_space_transcript` — лише поки файл тримає той самий `content_id`
  (`transcript_source_version` лишається null через `team_materials_transcript_identity_check`);
  знахідка перезашивки (`restitchPrep`, агент шле її і в R2-фіналізацію) пишеться в
  `service_record_material_restitch_prep` проти `content_id` джерела (для Drive — `drive_version`,
  як було). Міграція `20261226220000_space_storage_run_results.sql`, тести
  `tests/space-storage-process.test.ts`, `tests/agent-r2-transfer.test.ts`,
  `supabase/tests/database/space-storage-run-results.test.sql`. Запуск поверх оригіналу
  (`versionOfMaterialId`) і далі відмовляє — тепер кодом `STORAGE_BACKEND_MISMATCH` з поясненням у
  вебі (текст без «Google»).

- [x] T036 [P] [US1] Тест для T037 — `tests/catalog-feed-writer.test.ts`:
  - CSV байт у байт: заголовок `PRODUCT_CATALOG_TEMPLATE`, рядки з `buildProductCatalogRows`;
  - `text/csv; charset=utf-8`;
  - перезапис того самого ключа `feeds/{feed_id}.csv` і очищення кешу адреси;
  - збій запису лишає попередню стрічку;
  - Google-шлях `CatalogDocumentWriter` дає ті самі виклики, що й до змін.
- [x] T037 [US1] Стрічка каталогу:
  - `supabase/functions/_shared/catalog-feed.ts`: запис у `soty-catalog-videos-{env}-public` через клієнт `CatalogVideoR2` і очищення кешу через `R2_CATALOG_PURGE_TOKEN`;
  - шов `CatalogDocumentWriter`, винесений з `supabase/functions/drive-ops/product-catalog.ts:966-1028`: Google-гілка без змін, R2-гілка пише стрічку й кладе її адресу в `sheet_url`;
  - колонки `feed_id`, `feed_revision`, `feed_written_at` у міграції `supabase/migrations/<ts>_space_storage_catalogs.sql`.

  Тест: T036.

- [x] T038 [P] [US1] Тест для T039 — `tests/catalog-updater-feed.test.ts`. Для каталогу зі стрічкою:
  - не кличе `takeSheetsReads` і `drive.getFile`;
  - пише стрічку після `rebuildCatalogRows`;
  - нетекстові оновлення йдуть у стрічку, а не в комірки Sheets.
- [x] T039 [US1] Оновлювач на R2:
  - `supabase/functions/catalog-updater/worker.ts` (`takeSheetsReads` :86, `drive.getFile` :1017, запис :1049);
  - `nonvideo-writer.ts` (:170) і `publication-cells.ts` (:145) — гілка стрічки через `supabase/functions/_shared/catalog-feed.ts`.

  Тест: T038.

- [ ] T040 [P] [US1] Тест для T041 — `tests/catalog-r2-sources.test.ts` і `supabase/tests/database/catalog-space-sources.test.sql`:
  - копія відео каталогу з R2-простору береться з bucket простору, без Drive;
  - гранти перезашивки й варіацій для агента — URL `files-*`;
  - імпорт картинок каталогу з матеріалів простору.
- [ ] T041 [US1] Джерела каталогів з R2:
  - `CatalogVideoSpaceReader` поруч із `CatalogVideoDriveReader` у `supabase/functions/catalog-video-r2/worker.ts:41`, копіювання між bucket на сервері;
  - R2-гілка в `supabase/functions/drive-ops/catalog-video-process-grants.ts:101-145`, `supabase/functions/drive-ops/updater-restitch.ts:406` і `drive-ops/index.ts:2257`;
  - джерело `space_object` в імпорті `supabase/functions/catalog-images/`.

  Тест: T040.

  **Стан (2026-11-28, друга сесія):** зроблено —
  - `CatalogVideoSpaceReader` (`supabase/functions/catalog-video-r2/space-reader.ts`) і вибір
    читача у `worker.ts` (`spaceFor`, біндінг `R2_SPACE_*` у `catalog-video-r2/index.ts`);
  - звірка multipart-об'єкта: `source_md5` = MD5 з ETag (`"<md5 від MD5>-N"`), перевірка йде
    частинами простору (16 МіБ, частини копії мусять збігатися) і на останній частині дає назад і
    ETag, і `content_id` (`spaceContentId`). Стан `space-1` (MD5 частин, base64) переживає
    перерву. Однокусковий об'єкт (ETag = MD5 файлу) звіряється, як Drive;
  - claim копії для R2-джерела (`fileId` = `content_id`, без Drive-полів, `sourceKind: 'space'`)
    і `space-1` у `verification_advance` лише для R2-джерела — міграція
    `20261226210000_space_storage_catalog_sources.sql`;
  - claim оновлювача для стрічки (`catalog_update_target_usable`, колонки `feed_id`/`feed_revision`);
  - видалення стрічки: остаточне видалення каталогу (рядок `team_product_catalogs`) ставить CSV у
    `private.catalog_feed_removals`, sweep `catalog-video-r2` видаляє його й чистить кеш адреси.
    Кошик стрічку лишає: відновлений каталог мусить оновлюватися далі;
  - тести: `tests/catalog-video-r2-worker.test.ts` (джерело з простору, видалення стрічки),
    `supabase/tests/database/catalog-space-sources.test.sql` (25).

  **Стан (2026-11-28, третя сесія):** зроблено —
  - створення каталогу в R2-просторі наскрізно: той самий durable-генератор над швом сховища
    `drive-ops/catalog-space-source.ts` (відео й папка з простору через
    `service_space_catalog_material`/`_names`; відео — R2-копія 050, спланована з
    `source_version` = `content_id` через `service_space_catalog_video_link`; стрічка під id,
    виведеним з операції, тож відновлене створення пише ту саму; компаньйон — R2-рядок без
    об'єкта через `service_commit_space_catalog_feed`; зв'язок, запис стрічки й R2-вподобання в
    одній транзакції `service_link_space_catalog_feed`). Drive-клієнт генератора відмовляє на
    будь-який виклик. Протокол 1 без перезашивки й з публікацією одразу виконується як простий
    запит. Оновлювач тепер отримує `feeds` (`catalog-updater/index.ts`), `resolve_current` знає
    `content_id`. Діалог у R2-просторі не пропонує перезашивку, відкладену публікацію й опцію R2.
    Міграція `20261226230000_space_storage_catalog_create.sql`, тести
    `tests/catalog-space-create.test.ts`, `supabase/tests/database/catalog-space-create.test.sql`
    (27), `tests/product-catalog-dialog.test.tsx`;
  - імпорт картинок пулу з файлів R2-простору (`sourceKind: 'space'`): перелік дерева в SQL
    (`service_catalog_image_space_enumerate`), читання з bucket простору за `content_id`
    (`catalog-images/space-sources.ts`, `service_catalog_image_space_source`); `drive` — лише для
    Drive-простору, `space` — лише для R2. Кнопка «Обрати папку простору» без «Google». Міграція
    `20261226240000_space_storage_catalog_images.sql`, тести
    `tests/catalog-image-space-sources.test.ts`, `tests/catalog-image-worker.test.ts`,
    `tests/catalog-image-import.test.ts`, `tests/catalog-image-import-ui.test.tsx`,
    `supabase/tests/database/catalog-space-images.test.sql` (19).

  Відкрито (тому T040/T041 не закриті):
  - гранти `files-*` для перезашивки й варіацій (`catalog-video-process-grants.ts`,
    `updater-restitch.ts`, `drive-ops/index.ts` `handleProcessStart`). Це не окремий шов: у
    R2-просторі ще немає конвеєра перезашивки каталогу — набори відео (`service_initial_catalog_video_context`
    вимагає Drive-поля), папка «перезашите» (`handleEnsureRestitchedFolder` — Drive), фіналізація
    виходів набору і `resolveCatalogReadyLinks` (доводить і шарить Drive-файли). Поки його нема,
    створення з перезашивкою в R2 відмовляє `STORAGE_BACKEND_MISMATCH` до будь-якого запису;
  - у R2-просторі також відмовляють (до запису): відкладена публікація, каталог картинок і
    кілька креативів (`MULTI_CREATIVE_UNSUPPORTED`), каталоги запусків (`launch:`, шлях запусків
    іде через Drive-контекст);
  - `/product-catalog/video/resume` для R2 не потрібен (R2-створення не повертає
    `preparing_video`), але якщо відповідь створення загубилась, діалог читає прогрес відео й
    не знайде його; каталог при цьому створений і видний у списку каталогів відео (не перевірено
    на беті).

- [x] T042 [P] [US1] Тест для T043 — `tests/catalog-feed-card.test.tsx`: картка каталогу R2-простору показує й копіює адресу стрічки. Слів «Google» чи «Таблиця Google» немає. Drive-каталог без змін.
- [x] T043 [US1] Картка каталогу у вебі: `apps/web/src/team/product-catalog/CatalogCreatedPublicationStatus.tsx`, `CatalogPublicationDialog.tsx` і місця з посиланням на таблицю показують стрічку для R2 (FR-050). Тест: T042.

### Фаза 5 — US7: відчутно швидше (ядро M1) (P1)

**Мета**: пряма передача, похідні при фіксації, кеш і Realtime.
**Незалежна перевірка**: quickstart M1 кроки 2–5. Повні заміри SC-011 — у M2 (T073).

- [ ] T044 [P] [US7] Тест для T045 — `tests/space-upload-client.test.ts`:
  - ≤8 паралельних частин;
  - продовження з журналу IndexedDB після обриву мережі й перезавантаження вкладки;
  - `content_id` (MD5 частин у Web Worker) збігається з еталоном і з тим, що сервер рахує з ETag частин від R2;
  - `exists` пропускає передачу;
  - дерево папок зберігає структуру;
  - скасування закриває multipart.
- [ ] T045 [US7] Рушій завантаження:
  - `apps/web/src/team/storage/spaceUpload.ts` і `spaceHash.worker.ts` (MD5 частин і `content_id`);
  - журнал за зразком `apps/web/src/team/explorer/workspaceOperationJournal.ts:214`;
  - підключення в `apps/web/src/team/explorer/useExplorerUploads.ts` і `ExplorerDropZone.tsx`.

  Тест: T044.

- [ ] T046 [P] [US7] Тест для T047 — `tests/space-derivatives.test.ts`, `tests/agent-r2-derivatives.test.ts` і `supabase/tests/database/space-derivatives.test.sql`.
  - Браузер робить 3 розміри WebP і для відео постер, кадри прев'ю, тривалість і роздільність. Робота йде у Web Worker, по файлу за раз. Похідні йдуть частинами того самого коміту.
  - Для `content_id`, у якого похідні вже є, браузер нічого не генерує й не вантажить.
  - Сервер відкидає похідну з чужим типом за першими байтами, з розміром понад ліміт варіанта чи з розмірами, що не збігаються із заявленими. Оригінал при цьому фіксується з `thumbnail_state='pending'` і завданням `pending_agent`.
  - Формат, який браузер не декодує (HEVC-фікстура, PDF), отримує `pending_agent`. Інтерфейс показує «прев'ю готується», а скачування працює.
  - Агент-ffmpeg бере завдання з орендою і пише похідні, кодек і fps. Протермінована оренда повертає завдання. Повтори обмежені, непідтримуване → `unsupported`.
  - Вихід ffprobe розбирається як `unknown`.
- [ ] T047 [US7] Похідні від клієнта (research.md R5, уточнення FR-038). Серверного рендерингу немає.
  - **Браузер.** Новий `apps/web/src/team/storage/spaceDerivatives.ts`: `createImageBitmap`/`OffscreenCanvas` для зображень, `<video>` з перемотуванням і canvas (за зразком `apps/web/src/team/explorer/usePosterFrames.ts`) і WebCodecs, де є. Підключити в рушій T045: похідні оголошуються в `/uploads/admit`.
  - **Сервер.** Перевірка похідних у `supabase/functions/space-storage/uploads.ts` при `complete`: перші байти через `rangeGet`, ліміти з `packages/shared/src/team/space-storage.ts`. RPC `service_claim_space_derivative_jobs` і `service_finish_space_derivative` у міграції `supabase/migrations/<ts>_space_storage_derivatives.sql`. Завершення ставить `thumbnail_state`/`preview_state` і медіафакти й шле сигнал.
  - **Агент.** Новий `apps/agent/src/team-bridge/r2-derivatives.ts` на основі `thumbnail.ts` і `poster.ts`:
    - похідні для власних завантажень («Вхідні», результати обробки — T033, T065);
    - добір `pending_agent` з фонового циклу `apps/agent/src/team-bridge/recovery-worker.ts` під PowerGovernor, якщо агент учасника має доступ до простору;
    - PDF — перша сторінка, коли браузер не впорався; непідтримуване → `unsupported` (FR-012).

  Тест: T046.

- [ ] T048 [P] [US7] Тест для T049 — `tests/space-realtime-cache.test.tsx`:
  - сигнал оновлює сторінку папки на місці без блимання;
  - тепле відкриття малює кеш до мережі;
  - LRU тримає обмеження;
  - вихід і відкликання очищують кеш;
  - для R2 немає таймерів опитування й «синхронізувати».
- [ ] T049 [US7] Realtime і кеш:
  - підписка на `team_space_storage_signals` у `apps/web/src/team/useTeamRealtime.ts:100`;
  - новий `apps/web/src/team/storage/spaceCache.ts` (IndexedDB) у `apps/web/src/team/explorer/useFolderPage.ts` і `FolderTree.tsx`;
  - очищення через `apps/web/src/team/private-cache-scope.ts`;
  - для R2 вимкнути `useWakeCatalogSync.ts` (`TeamContext.tsx:324`), `useExplorerResync.ts`, `useFolderResync.ts`, `SyncStatusPanel.tsx`.

  Тест: T048.

- [ ] T050 [P] [US7] Тест для T051 — `tests/space-media-urls.test.ts`:
  - незмінні адреси похідних і оригіналу;
  - оновлення гранту на 401 — рівно один повтор;
  - браузерне скачування >32 МіБ для R2 дозволене;
  - `<video>` отримує Range-адресу `files-*`.
- [ ] T051 [US7] Медіа у вебі:
  - `apps/web/src/team/preview/MaterialPreview.tsx` (:293, :350) — Range-адреса з `files-*`;
  - `apps/web/src/team/explorer/useThumbnailSession.ts` — грант замість сесії мініатюр;
  - `useSelectionDownload.ts` — пряме скачування будь-якого розміру з продовженням;
  - `usePosterFrames.ts` — постер похідної.

  Тест: T050.

### Фаза 6 — US9: пам'ять простору наочно (P1)

**Мета**: шкала з категоріями, список найбільшого, попередження завчасно.
**Незалежна перевірка**: quickstart M1 крок 6 (SC-013).

- [ ] T052 [P] [US9] Тест для T053 — `supabase/tests/database/space-storage-usage.test.sql`. Фікстура US9: матеріали, три каталоги по 10 варіацій, вкладення, версії, кошик. Перевірити:
  - сума сегментів = `usedBytes`;
  - спільне рахується раз;
  - `get_catalog_storage_breakdown` дає три числа;
  - тригери на `private.catalog_video_r2_copies` і `private.catalog_image_storage` правильно змінюють категорію `catalogs`;
  - картинка пулу позначена спільною.
- [ ] T053 [US9] Міграція `supabase/migrations/<ts>_space_storage_usage.sql`:
  - `get_space_storage_summary`, `list_space_storage_items`, `get_catalog_storage_breakdown`;
  - тригери на таблицях 050/045 лише для R2-просторів;
  - `private.space_capacity_bytes(team)` — ліміт пілоту.

  Тест: T052.

- [ ] T054 [P] [US9] Тест для T055 — `tests/storage-meter.test.tsx` і новий випадок у `tests/design-components.test.tsx`:
  - сегменти мають підпис і контраст, а не лише колір;
  - клавіатурна навігація й підказка (назва, обсяг, частка);
  - штрихування «Резервується»;
  - компактний вигляд на вузькому екрані;
  - світла й темна тема через токени.
- [ ] T055 [US9] Компонент `apps/web/src/components/ui/StorageMeter.tsx`:
  - експорт з `apps/web/src/components/ui/index.ts`;
  - токени `--color-storage-{materials,catalogs,process,attachments,versions,trash,reserved}` для обох тем у `apps/web/src/styles/tokens.css`;
  - приклад у `apps/web/src/dev/DesignSystemPage.tsx`;
  - рядок у `specs/021-design-system-redesign/contracts/components.md`.

  Тест: T054.

- [ ] T056 [P] [US9] Тест для T057 — `tests/storage-meter-panel.test.tsx`:
  - топ-10 і повний список із пошуком і сортуванням за вагою, датою, автором;
  - відкрити й видалити зі списку;
  - попередження 80/95/100% з оцінкою «займе ≈ …» у місцях дії;
  - оновлення за сигналом `usage` без перезавантаження.
- [ ] T057 [US9] Панель пам'яті:
  - `apps/web/src/team/storage/StorageMeterPanel.tsx` і `StorageItemsList.tsx` — у стані простору й у `apps/web/src/team/tariffs/SpaceTariffSection.tsx`;
  - попередження в `useExplorerUploads.ts`, діалогах створення каталогу й генерації варіацій (`apps/web/src/team/product-catalog/`), перезашивці (`apps/web/src/team/restitch/`);
  - тексти в `apps/web/src/locales`.

  Тест: T056.

### Фаза 7 — US10: видалив — і одразу зникло (P1)

**Мета**: каскадне видалення, кошик 30 днів, жодних сиріт.
**Незалежна перевірка**: quickstart M1 кроки 7, 9, 10 (SC-014, SC-016).

- [ ] T058 [P] [US10] Тест для T059 — `supabase/tests/database/space-storage-purge.test.sql`:
  - 0 посилань → черга з правильним `due_at` для кожної причини;
  - спільний об'єкт лишається;
  - видалення каталогу під час генерації варіації скасовує результат і не прикріплює його;
  - повтор видалення ідемпотентний;
  - відновлення з кошика повертає зв'язки і, якщо місця вже немає, відповідає `STORAGE_QUOTA_EXCEEDED`.
- [ ] T059 [US10] Прибирач `supabase/functions/space-storage-sweeper/index.ts`. pg_cron щохвилини — у міграції `supabase/migrations/<ts>_space_storage_sweeper.sql` за зразком `private.invoke_catalog_video_r2_worker`. Що робить:
  - видаляє з R2 за ≤15 хв;
  - відпрацьовує строк кошика 30 днів;
  - раз на добу звіряє `listPrefix('t/{team}/')` з обліком: сироти старші 24 год видаляються, відсутні об'єкти — це помилка;
  - видаляє весь простір, зокрема пілотний.

  При видаленні каталогу стрічка видаляється, а її кеш чиститься одразу. Те саме — для публічних адрес відео каталогу: шлях 050 (`private.catalog_video_r2_release_removed`, `supabase/migrations/20261207400200_catalog_r2_copy_deleted_on_trash.sql`) уже кличе sweep одразу, а T059 додає очищення кешу зони для цих адрес. Мета — 404 за ≤1 хв (SC-014). Тест: T058, T060.

- [ ] T060 [P] [US10] Тест для T059 — `tests/space-storage-sweeper.test.ts` з фейковим R2: пільга для сиріт, частковий збій і повтор, звіт про відсутні, нуль залишку після видалення простору. Видалення каталогу кличе очищення кешу зони для стрічки й кожної унікальної адреси відео.
- [ ] T061 [P] [US10] CLI `scripts/analytics/space-storage.ts`, `case 'space-storage'` у `scripts/analytics/cli.ts` і проєкція `public.analytics_space_storage` (міграція `supabase/migrations/<ts>_space_storage_analytics.sql`). Показує облік, звірку, сироти, затримку видалення, черги похідних, затримку фіксація → сигнал. Тест — `tests/analytics-space-storage.test.ts` у цій самій задачі: фікстура відповідей, `unsupported`, а не нуль, коли проєкції немає.

### Фаза 8 — приймання M1 і реліз на next

- [ ] T062 Приймання M1 на беті:
  - **Перед будь-яким деплоєм Worker-а з біндінгом:** створити `soty-spaces-production` і розкоментувати `[[r2_buckets]] SPACE_BUCKET` у `apps/catalog-image-delivery/wrangler.toml`. До того біндінг вимкнено, бо wrangler не деплоїть біндінг до неіснуючого кошика, а цей Worker віддає живі картинки каталогів.
  - міграції через `psql` + `schema_migrations`;
  - у env функцій беті `SPACE_FILES_ORIGIN=http://127.0.0.1:54321/functions/v1/space-storage/files`
    (читання через `space-storage`, не Worker; деплой Worker-а `--env beta` для приймання не потрібен);
  - кроки 1–10 [quickstart.md](quickstart.md) M1 через Playwright-драйвер беті;
  - результат — `specs/057-r2-workspaces/evidence/m1-beta-acceptance-<дата>.md`.

  Потім створити прод-ресурси з T002 (`soty-spaces-production`, маршрут `files.soty.pp.ua`, правило кешу `/feeds/*`; усе на безкоштовному плані) і повний реліз на next раннером: змінились агент і shared, тож швидкий веб-шлях не підходить. Promote не робиться. Видати пілот власнику.

- [ ] T063 Пілот на next:
  - власник проходить US7–US10 сам;
  - перевірка SC-016: прод-веб з акаунтом власника без помилок, 0 змін Drive-просторів, 0 записів T0;
  - результат — `specs/057-r2-workspaces/evidence/m1-next-pilot-<дата>.md`.

  Знахідки — фікс і перевипуск на next.

## Етап M2 — входи без Drive і доказ швидкості

### Фаза 9 — US8: файли потрапляють у простір без Google (P1)

**Мета**: «Вхідні», телефон, share target. Лише учасники за роллю.
**Незалежна перевірка**: quickstart M2 кроки 1–2 (SC-015).

- [ ] T064 [P] [US8] Тест для T065 — `tests/agent-inbox.test.ts`:
  - 1000 файлів з обривом і «сном» (пауза таймерів): кожен рівно раз;
  - `idempotency_key` = хеш + відносний шлях;
  - знята роль → нові файли відхилено ≤5 с, зафіксоване лишається;
  - локальні файли не видаляються без налаштування;
  - переповнення посередині зупиняє з поясненням.
- [ ] T065 [US8] «Вхідні» в агенті: новий `apps/agent/src/team-bridge/inbox.ts` (спостерігач, хешування, черга через `r2-transfer.ts`, журнал). Маршрути й стан для вебу — через наявний SSE в `apps/agent/src/team-bridge/routes.ts` і `events.ts`. Тест: T064.
- [ ] T066 [P] [US8] Тест для T067 — `tests/inbox-ui.test.tsx`: вибір папки простору, перемикач «видаляти після вивантаження» (типово вимкнено), стан кожного файлу в провіднику, агент офлайн — накопичене показано.
- [ ] T067 [US8] Інтерфейс «Вхідних» — `apps/web/src/team/storage/InboxSettings.tsx`, стан файлів у `apps/web/src/team/explorer/localProgress.ts`. Тест: T066.
- [ ] T068 [P] [US8] Тест для T069 — `tests/share-target.test.ts`:
  - `share_target` у маніфесті;
  - service worker передає файли в чергу завантаження;
  - великий файл переживає блокування екрана (продовження з журналу T045);
  - обмеження iOS показане словами.
- [ ] T069 [US8] Телефон:
  - `share_target` у `apps/web/public/manifest.webmanifest`;
  - service worker `apps/web/public/share-target-sw.js`;
  - сторінка прийому `apps/web/src/team/storage/ShareTargetPage.tsx`;
  - компактне завантаження в мобільному провіднику (`apps/web/src/team/explorer/ExplorerToolbar.tsx`);
  - тексти обмежень платформи.

  Тест: T068.

### Фаза 10 — US1: решта замінників Drive (P1)

- [ ] T070 [P] [US1] Тест для T071 — `tests/space-share-links.test.ts` і `supabase/tests/database/space-share-links.test.sql`:
  - посилання відкривається без акаунта;
  - строк і відкликання → 404;
  - ліміт трафіку зупиняє скачування;
  - власник бачить лічильники;
  - сторінка посилання не має жодного входу для завантаження (US8.3).
- [ ] T071 [US1] Посилання Soty (FR-043):
  - `space_share_links` з тригером огорожі в міграції `supabase/migrations/<ts>_space_share_links.sql`;
  - маршрути `/share-links` у `supabase/functions/space-storage/share.ts`;
  - сторінка `/s/{token}` у `apps/catalog-image-delivery/src/space-read.ts`;
  - замінник `CopyDriveLinkButton` для R2 у `apps/web/src/team/library/` і `TaskAttachmentTile.tsx`.

  Тест: T070.

- [ ] T072 [P] [US1] Тест для T073 — `tests/space-folder-download.test.ts`: «Скачати папку» через агента зберігає структуру й продовжує після обриву. Пояснення втрат з'являються там, де людина шукає можливість.
- [ ] T073 [US1] «Скачати папку» (FR-051) — режим папки в `apps/agent/src/team-bridge/download.ts` і дія в провіднику. Пояснення кожної «втрати» з [drive-losses.md](drive-losses.md) — `apps/web/src/team/storage/DriveLossNote.tsx` (FR-044). Тест: T072.

### Фаза 11 — US7: доказ швидкості (P1)

- [ ] T074 [US7] Заміри SC-011, скрипт `scripts/space-storage-speed.mjs` (Playwright-драйвер):
  - десять операцій ≥20 разів на парі Goor ↔ пілотний R2-простір, з тієї самої мережі;
  - медіана й p95 → `specs/057-r2-workspaces/evidence/speed-sc011-<дата>.md`;
  - якщо операція повільніша — фікс і повтор.

  Скрипт сам — тест: перевіряє цілі й падає на порушенні.

- [ ] T075 [US7] Звірка SC-012. Кожен рядок [drive-losses.md](drive-losses.md) отримує id тесту (T0xx) або посилання на видиме пояснення. Рядків «невідомо» — 0.

## Етап M3 — умови загального запуску

### Фаза 12 — US3 і US2: 60 днів як раніше, потім архів; чистий старт (P1)

**Незалежна перевірка**: quickstart M3 крок 1 (SC-017).

- [ ] T076 [P] [US3] Тест для T077 — `supabase/tests/database/space-archive.test.sql`. Віртуальний годинник D−1 мс, D, D+1 мс. Перевірити:
  - до D — 0 нових блокувань;
  - після D кожна записувальна можливість `private.can` → `SPACE_ARCHIVED`;
  - читання, пошук і експорт фінансів працюють;
  - вийти, прибрати учасника, відкликати доступ — дозволено;
  - claim-и `catalog-sync`, `catalog-updater` і фонових робіт для архіву — 0;
  - повторна активація T0 нічого не змінює, продовження D — лише вперед з аудитом.
- [ ] T077 [US3] Міграція `supabase/migrations/<ts>_storage_launch_policy.sql`:
  - `storage_launch_policy`, `storage_launch_events`, `storage_archive_notices`;
  - `admin_activate_storage_launch()`, `admin_extend_storage_archive_date()`;
  - `private.space_is_archived` у `private.can` (`supabase/migrations/20260809150000_team_workspace_access_gate.sql:59`);
  - виключення в `private.claim_catalog_sync_jobs`, `service_open_catalog_updater_rounds` і claim-ах фонових робіт;
  - після T0 `create_team` створює лише R2, новий Drive-корінь відхиляється в `supabase/functions/drive-connect/` (FR-001, FR-056).

  Тест: T076.

- [ ] T078 [P] [US3] Тест для T079 — `tests/space-archive.test.ts` і `tests/archive-banner.test.tsx`:
  - `drive-ops`, `drive-transfer`, `library-ops` і `catalog-updater` повертають `SPACE_ARCHIVED` з поясненням;
  - банер з датою D і переходом у новий простір;
  - картка каталогу «Soty більше не оновлює»;
  - нагадування 30/14/7/1 — без повторів.
- [ ] T079 [US3] Поверхні архіву:
  - відображення `SPACE_ARCHIVED` у `supabase/functions/drive-ops/index.ts`, `drive-transfer/index.ts`, `library-ops/`;
  - `apps/web/src/team/storage/ArchiveBanner.tsx` і примітка на картці каталогу в `apps/web/src/team/product-catalog/`;
  - нагадування в `supabase/functions/tariff-notices/` через `storage_archive_notices`.

  Тест: T078.

- [ ] T080 [P] [US2] Тест для T081 — `tests/space-create-after-t0.test.tsx`: власник старого простору після T0 створює R2-простір одразу, без вибору «перенести». Підказка пояснює дату D. `ConnectStorageFlow` для нового простору недоступний.
- [ ] T081 [US2] Створення після T0: `CreateSpaceWizard.tsx` бере політику з `list_my_teams_v2`/`storage_launch_policy`. Пілотна умова з T018 знімається для всіх після T0. Підказка про D — у `apps/web/src/locales`. Тест: T080.

### Фаза 13 — US4 (частково): місткість у видачі 034

- [ ] T082 [P] [US4] Тест для T083 — `supabase/tests/database/space-tariff-storage.test.sql` і `tests/tariff-storage-admin.test.tsx`:
  - місткість = `storage_bytes + extra_storage_bytes`, типово 15 ГБ;
  - розширення лише кратні 10 ГБ;
  - зменшення нижче зайнятого відхилено;
  - пілотний простір після T0 переходить на тариф без перестворення (FR-054);
  - після 3 днів грації R2-простір лише для читання й експорту, дані цілі (FR-021, частково).
- [ ] T083 [US4] Місткість у 034:
  - міграція `supabase/migrations/<ts>_space_tariff_storage.sql`: колонки `space_tariffs`, `admin_grant_space_tariff_once` і `admin_update_space_tariff` приймають місткість, `private.space_capacity_bytes` для тарифу;
  - типи в `packages/shared/src/team/tariffs.ts`;
  - адмінка: `apps/web/src/pages/admin/TariffGrantDialog.tsx`, `TariffEditDialog.tsx`, `tariffModel.ts`;
  - шкала в `SpaceTariffSection.tsx`.

  Організаційні пакети не робити — вони відкладені (plan.md). Тест: T082.

### Фаза 14 — US5: робота й відновлення при аварії (P1)

- [ ] T084 [P] [US5] Тест для T085 — `tests/space-replication.test.ts` і `supabase/tests/database/space-replicas.test.sql`:
  - копія в B2 перевірена довжиною й контрольними сумами частин;
  - копіювання продовжується з контрольної точки після обриву виклику;
  - стани «збережено, резерв готується» і «захищено» розрізняються;
  - відставання понад 15 хв видиме;
  - облікові дані основного записувача не видаляють резерв (фейк);
  - подовження блокування.
- [ ] T085 [US5] Реплікація:
  - edge-функція `supabase/functions/space-replicator/` (pg_cron) копіює зафіксовані оригінали в B2 з Object Lock частинами з контрольною точкою після кожної, ключі окремі (research.md R14). Перший крок — кваліфікація меж часу й CPU edge-функцій на файлі 5 ГБ;
  - `space_object_replicas` і `space_restore_points` у міграції `supabase/migrations/<ts>_space_replicas.sql`;
  - знімок метаданих за [contracts/recovery.md](contracts/recovery.md);
  - статус у `StorageMeterPanel.tsx`.

  Тест: T084.

- [ ] T086 [US5] Навчання відновлення:
  - скрипт `scripts/space-storage-drill.mjs` відмовляється від проду;
  - аварійна адреса лише для читання на незалежному хості;
  - п'ять навчань FR-028 → `specs/057-r2-workspaces/evidence/restore-drill-<дата>.md` (RPO, RTO, байти, хеші, актуальні права; SC-007, SC-010).

  Скрипт перевіряє цілі сам і падає на порушенні.

### Фаза 15 — US6: агент пояснює кожен збій (P1)

- [ ] T087 [P] [US6] Тест для T088 — `tests/analytics-space-storage-investigate.test.ts`. Фікстури: гонка квоти, втрачений грант, розбіжність хешу, відставання резерву, невидимий результат, загублений сигнал. Очікується правильна доведена стадія або конкретна сліпа зона (SC-009).
- [ ] T088 [US6] Розширити `scripts/analytics/investigate.ts`, `inspect`, `audit` у `scripts/analytics/cli.ts` і додати `storage-capacity` (`scripts/analytics/storage-capacity.ts`) за [contracts/diagnostics.md](contracts/diagnostics.md). Тест: T087.

### Фаза 16 — запуск

- [ ] T089 Перевірки запуску:
  - матриця паритету [architecture-inventory.md](architecture-inventory.md) для R2 на macOS arm64, x64 і Windows x64 (SC-006);
  - навантаження SC-005 на беті скриптом `scripts/space-storage-load.mjs`;
  - звіт фактичних витрат R2, B2 і запитів Workers проти безкоштовних меж для власника (FR-029, FR-034, окремий рядок для пілоту FR-053);
  - результат — `specs/057-r2-workspaces/evidence/launch-gates-<дата>.md`.
- [ ] T090 Повний реліз: beta → next → promote — лише на слово власника. Одразу після promote — `admin_activate_storage_launch()`, запис T0 і D у `evidence/launch-<дата>.md`, перевірка аудиту після релізу. Нагадування стартують від T0.

## Залежності

- **Фази M1.**
  - Фаза 1 → Фаза 2 → US11 (фаза 3).
  - US1 (фаза 4) залежить від US11: `space-storage` і створення простору.
  - US7 (фаза 5) залежить від T023, T027, T029. T047 — після T045 (рушій завантаження) і T033 (агент контракту 3).
  - US9 (фаза 6) залежить від T006 і T023.
  - US10 (фаза 7) залежить від T023, T025, T037.
  - Фаза 8 — після всіх фаз M1.
- **M2** починається після T063. T065 залежить від T033, T069 — від T045, T074 — від T063.
- **M3** починається після M2. Виняток: T084–T086 і T087–T088 можна вести паралельно з M2.
  T090 — останнє.
- **Огорожа прибирання** — у кожній міграції з новою таблицею з інвентаря. Перевіряють T005 і
  власні SQL-тести.

## Паралельні можливості

- **Фаза 1:** T003/T004 паралельно з T001/T002.
- **Фаза 2:** T009/T010 і T011/T012 паралельно з міграціями T006/T008.
- **US1:** гілка агента (T032–T035), гілка каталогів (T036–T043) і гілка вебу (T028–T031)
  незалежні після T023/T025.
- **US7:** похідні (T046/T047) — після T045; Realtime, кеш і медіа (T048–T051) — паралельно з ними.
- **US9:** компонент (T054/T055) паралельно з SQL (T052/T053).
- **M3:** резерв (T084–T086) і діагностика (T087/T088) незалежні від архіву (T076–T081).

Приклад для US1: «T032 тест агента» + «T036 тест стрічки» + «T028 тест адаптера» одночасно.
Потім T033, T037, T029.

## Стратегія

1. **MVP = M1.** Власник працює в R2 на next. Кожна фаза M1 перевіряється окремо за
   quickstart, а приймання — у T062/T063.
2. **M2** доводить, що нічого не загубилось і стало швидше. Без SC-011 запуску немає.
3. **M3** — лише після M2. Promote — на слово власника.

## Відповідність задач вимогам

| Вимога                                 | Задачі                                                |
| -------------------------------------- | ----------------------------------------------------- |
| FR-001, FR-056                         | T077, T080, T081                                      |
| FR-004, FR-006, FR-057, FR-058         | T076–T079, T090                                       |
| FR-011                                 | T021–T043, T070–T073, T089                            |
| FR-012, FR-038, FR-041                 | T046, T047                                            |
| FR-013, FR-014                         | T019, T020, T026, T027, T050                          |
| FR-016, FR-017, FR-045, FR-047, FR-050 | T005, T006, T021–T023, T052, T053                     |
| FR-021 (частково)                      | T082, T083                                            |
| FR-023–FR-028, FR-030                  | T084–T086                                             |
| FR-029, FR-034, FR-053                 | T089                                                  |
| FR-031, FR-052, FR-054                 | T013–T020, T062, T063                                 |
| FR-032, FR-033                         | T011, T012, T061, T087, T088                          |
| FR-035, SC-011                         | T074                                                  |
| FR-036, FR-037, FR-039, FR-040         | T026, T027, T044, T045, T048–T051                     |
| FR-042                                 | T064–T069                                             |
| FR-043, FR-044, FR-051, SC-012         | T070–T073, T075                                       |
| FR-046                                 | T054, T055                                            |
| FR-048, FR-049, SC-014                 | T058–T060                                             |
| FR-055                                 | задач немає (переносу немає)                          |
| SC-001                                 | T013, T015, T080, T081                                |
| SC-004                                 | T022, T082                                            |
| SC-005, SC-006                         | T089                                                  |
| SC-007, SC-010                         | T086                                                  |
| SC-009                                 | T087, T088                                            |
| SC-013                                 | T052, T056, T062                                      |
| SC-015                                 | T064, T065                                            |
| SC-016                                 | T019, T059, T063                                      |
| SC-017                                 | T076, T078                                            |
| Відкладено (plan.md)                   | FR-015, FR-018, FR-019, FR-020, FR-022, SC-008        |
| Втратило силу                          | FR-002, FR-003, FR-005, FR-007–FR-010, SC-002, SC-003 |
