# Tasks: 071 Повний переїзд сховища на R2

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: так. Обов'язкові: pgTAP на квоту, стани об'єктів, tombstones і запобіжник; golden-тест фіда (SC-004); тест «DriveAdapter не змінив поведінку»; тест ідемпотентності переходу (SC-005); перевірка `verify` без Drive (SC-007).

**Стан**: не почато. Реалізація після релізу 1.6 і рішення власника про старт; спека без PR.

## Format: `[ID] [P?] [Story] Description`

- **[P]** можна паралельно (інші файли, немає залежності від незавершених задач).
- **[Story]** US1…US7 зі спеки.

## Phase 1: Setup

- [ ] T001 Почати від свіжого `main` після релізу 1.6; `npm ci`, `npm run build -w @video-compressor/shared`; `uptime` перед кожним важким прогоном (CLAUDE.md)
- [ ] T002 Cloudflare beta: бакет `soty-library-beta`, CORS (research R5), API-токен тільки на бакет, bucket lock 7 днів; записати фактичну поведінку lock з незавершеним multipart у research R10
- [ ] T003 [P] Записи `R2_LIBRARY_*`, `STORAGE_WORKER_SECRET` у config/environments.json з нотатками «Disabled by default»

## Phase 2: Foundational (етап A, блокує всі історії)

- [ ] T004 Винести спільне з supabase/functions/_shared/r2-catalog-images.ts і r2-catalog-video.ts у supabase/functions/_shared/r2/ (signer.ts, multipart.ts, readback.ts, purge.ts) без зміни поведінки; тести 045/050 зелені
- [ ] T005 supabase/functions/_shared/storage/: `StorageAdapter` (contracts/storage-adapter.md), `drive-adapter.ts` поверх `GoogleDriveClient`, `adapterFor(team)`
- [ ] T006 scripts/check-no-drive.mjs і підключення в scripts/verify-all.mjs: `GoogleDriveClient` і `googleapis.com/drive`/`sheets.googleapis.com` тільки у файлах allowlist; allowlist може тільки скорочуватись (тест у tests/check-no-drive.test.ts)
- [ ] T007 Runtime-конфіг `readLibraryR2Config` з `TARGET_CONFIRMATION`, відмова від `.r2.dev` і публічних origin, у supabase/functions/_shared/storage/r2-config.ts; тести
- [ ] T008 Міграція `…_storage_r2_foundation.sql`: `teams.storage_backend` + тригер незворотності, `storage_quota_bytes_override`, `soty_r2` у `team_drive_connections` (nullable `credential_id` + check), `lifecycle 'archived_drive'`, `team_materials.storage_object_id`
- [ ] T009 Міграція `…_storage_r2_objects.sql`: `team_storage_objects`, `team_storage_usage` + тригери, `team_storage_upload_sessions`, `private.storage_tombstones`, `private.storage_r2_config`, коди помилок у `team_error_codes`
- [ ] T010 [P] pgTAP supabase/tests/database/storage-r2-foundation.test.sql: RLS force, незворотність бекенду, ключ = `s/<team>/<id>`, переходи станів, тригер tombstones при видаленні простору
- [ ] T011 [P] Типи й функції квоти в packages/shared/src/team/storage.ts (`storageQuota`, `UploadPurpose`, коди); паритет shared ↔ SQL квоти у tests/storage-quota-parity.test.ts
- [ ] T012 Тест: `DriveAdapter` дає ті самі запити Drive, що й поточний код, на фікстурах drive-ops/drive-transfer (tests/storage-drive-adapter.test.ts)

**Checkpoint**: Drive-простори працюють побайтово як раніше; R2-шлях існує в схемі, але вимкнений.

## Phase 3: US1 — Завантажити й працювати (P1, етап B) 🎯 MVP

- [ ] T013 [US1] `R2Adapter`: `startUpload`, `partUrl`, `finalizeUpload` (HEAD + вибірковий readback + визначення типу), `abortUpload`, `readUrl` з вирівняним строком і `response-content-disposition` у supabase/functions/_shared/storage/r2-adapter.ts
- [ ] T014 [US1] Нова функція supabase/functions/storage-ops: маршрути `/uploads/*`, `/derived/start`, `/read-urls`, `/usage` (contracts/storage-routes.md); `verify_jwt` і named secret у supabase/config.toml
- [ ] T015 [US1] RPC резерву квоти й фіналізації (атомарно: перевірка членства й права, резерв, створення матеріалу) у міграції `…_storage_r2_upload_rpc.sql`; pgTAP на гонку двох завантажень біля межі квоти
- [ ] T016 [P] [US1] Web-завантажувач multipart: паралелізм 4, продовження після розриву, SHA-256 у Web Worker, у apps/web/src/team/storage/uploader.ts; підключити в бібліотеці й вкладеннях завдань замість `/uploads/:id/relay` для R2-просторів
- [ ] T017 [P] [US1] Мініатюри на клієнті (картинка → WebP 512, відео → кадр 1 с) у apps/web/src/team/storage/thumbnails.ts; завантаження як похідний об'єкт
- [ ] T018 [US1] Провідник і плеєр: URL мініатюр пачкою зі списку, поновлення presigned URL у плеєрі з тієї ж позиції; без зміни компонентів 070
- [ ] T019 [US1] `rename/move/trash/restore`/папки для R2 тільки через RPC; `copy` → `CopyObject`; `text-edit` → новий об'єкт у supabase/functions/drive-ops (гілки за `adapterFor`)
- [ ] T020 [US1] Транскрипт і класифікація на фіналізації (замість `catalog-sync` для R2), ZIP-перевірка лендингу через range-читання R2 у preview-warm
- [ ] T021 [US1] `share_copy` для R2: `team_share_links`, `/share-links`, `GET /s/:token` (research R9)
- [ ] T022 [P] [US1] Тести: e2e завантаження з розривом, `STORAGE_QUOTA_EXCEEDED` до передачі байтів, відмова без права, правильна назва при скачуванні, виключення з простору посеред завантаження → `NOT_A_MEMBER` і чистка частин, підміна MIME → виправлений тип або `STORAGE_CONTENT_REJECTED`

## Phase 4: US5 — Нічого не втратити (P1, етап B)

- [ ] T023 [US5] Робітник `/worker/tick` у storage-ops: прострочені сесії → abort; кошик > 30 днів → tombstones; tombstones після `not_before` → `DeleteObject` по одному ключу з перевіркою префікса; `pg_cron` у міграції
- [ ] T024 [US5] Запобіжник масового видалення (FR-021) і `/admin/tombstones/release-pause`, `/admin/tombstones/restore`
- [ ] T025 [P] [US5] pgTAP: жодного видалення раніше `not_before` (SC-006), видалення тільки списком, пауза при перевищенні порогів
- [ ] T026 [US5] Beta: bucket lock відмовляє ранньому `DeleteObject` (результат у quickstart)

## Phase 5: US7 — Витрати й стан (P2, етап B)

- [ ] T027 [P] [US7] Події AD-001…AD-003, AD-005 у web, агенті й storage-ops (без назв файлів)
- [ ] T028 [US7] Команда `npm run analytics -- storage` з формулою вартості research R14; події сховища в `investigate` і `journey` (AD-007); документ у docs/ANALYTICS_CLI.md і таблиця в AGENTS.md
- [ ] T029 [P] [US7] UI «зайнято X з Y ГБ» і найбільші матеріали в налаштуваннях простору; попередження 80/95; override квоти в адмінці тарифів (034)

## Phase 6: US2 — Агент на R2 (P1, етап C)

- [ ] T030 [US2] Типи `AgentStorageInput`, `UploadPurpose.process_output|overwrite` і підняття версії протоколу в packages/shared/src/team/transport.ts
- [ ] T031 [US2] Агент: вхід через URL з поновленням і `Range`-продовженням у apps/agent/src/team-bridge/storage.ts; підключити в process.ts, restitch*.ts, landing-gallery.ts, source-cache.ts
- [ ] T032 [US2] Агент: вихід multipart з локальним журналом, постер як похідний об'єкт (poster.ts)
- [ ] T033 [US2] Сервер: задачі R2-просторів видають `AgentStorageInput`; `AGENT_UPDATE_REQUIRED` для старих версій; overwrite атомарно + tombstone старого об'єкта
- [ ] T034 [P] [US2] Тести агента на macOS arm64, Intel і Windows (наявні набори team-bridge + нові на storage.ts)

## Phase 7: US3 — Каталог без Google Sheets (P1, етап D)

- [ ] T035 [US3] Beta: перевірити, що Meta приймає CSV-фід з URL за розкладом; результат у research R7 (якщо ні, XML-серіалізатор)
- [ ] T036 [US3] Рендер фіда з бази тим самим генератором у supabase/functions/_shared/catalog-feed.ts; golden-тест SC-004 у tests/catalog-feed-golden.test.ts (фікстури з поточного генератора до змін)
- [ ] T037 [US3] Міграція стовпців фіда в `team_product_catalogs`; запис фіда з `If-Match`, `feed_revision`, очищення CDN у catalog-updater для R2-каталогів
- [ ] T038 [US3] 050 для R2-просторів: джерело копії — об'єкт бібліотеки (CopyObject або потік), опція завжди ввімкнена й прихована, без Drive-запасу (research R8)
- [ ] T039 [US3] Створення каталогу (діалог, меню, запуски 035) повертає URL фіда; перегляд таблиці й XLSX `no-store` у застосунку; позначка «URL підключено в Meta»
- [ ] T040 [P] [US3] Тести: автооновлення й перезашивка не міняють URL фіда; видалення каталогу → tombstones фіда й медіа

## Phase 8: US4 — Перехід простору (P1, етап E)

- [ ] T041 [US4] `team_storage_cutover_runs`, `service_storage_cutover` з кроками FR-024 (крок 1 перевіряє версії агентів простору) у міграції `…_storage_cutover.sql`
- [ ] T042 [US4] Кроки в storage-ops: зупинка Drive-задач, перенесення каталогів на фіди (з копією відео з Drive, поки токен живий), `archived_drive`, відкликання токена, перемикання бекенду; події AD-004 на кожен крок
- [ ] T043 [US4] Адмінка: запланувати/запустити/стан переходу; банер учасникам з датою й перевагами (компоненти design system)
- [ ] T044 [US4] Посилання на `archived_drive` у завданнях, запусках, каталогах, рестітч-джерелах: «файл на Google Drive» без виклику Drive API
- [ ] T045 [US4] Нові простори на R2 при `new_spaces_on_r2`; онбординг без кроку Drive
- [ ] T046 [P] [US4] Тест ідемпотентності й часу переходу на фікстурі 1 000 матеріалів / 50 каталогів / 20 запусків (SC-005)
- [ ] T047 [US4] Політика приватності, умови, docs/NO_SERVER_MEDIA_PLAN.md, docs/STORAGE_R2.md; гейт `policy_confirmed_at` (FR-030)
- [ ] T048 [US4] Пілот: перевести один простір закритої команди, 7 днів, звірити SC-002 і SC-003; потім решту

## Phase 9: US6 — Імпорт з Drive (P3, етап E, можна не робити)

- [ ] T049 [US6] Google Picker (`drive.file`) → робітник копіює вибрані файли в R2 з продовженням; токен не зберігається після імпорту

## Phase 10: Прибрати Drive (етап F)

- [ ] T050 Видалити `DriveAdapter`, drive-transfer, drive-connect, drive-oauth-callback, Drive-частину catalog-sync і drive-ops, Drive-маршрути агента, apps/web/src/team/restitch/images.ts
- [ ] T051 Міграція 030 release C і видалення `team-thumbnail-cache` списком (інвентар скриптом, підтвердження власника)
- [ ] T052 Прибрати `drive.file` з OAuth-клієнта, оновити docs/GOOGLE_OAUTH_VERIFICATION.md
- [ ] T053 Allowlist у scripts/check-no-drive.mjs порожній; `npm run verify` зелений (SC-007)
- [ ] T054 [P] (опційно) Перейменування `drive_file_id` → `item_key`, `team_drive_connections` → `team_storage_roots` окремим PR

## Dependencies

- Phase 2 блокує все. US1 → US5 → US7 можна вести паралельно після T014.
- US2 залежить від T013–T015. US3 залежить від T013 і T004. US4 залежить від US1, US2, US3 і T047.
- Phase 10 тільки після переходу всіх просторів.

## MVP

Phase 1–4 (бібліотека на R2 з захистом від втрати) на тестовому просторі beta. Для переходу реального простору потрібні також US2, US3 і US4.
