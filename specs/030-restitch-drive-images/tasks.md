# Tasks: Картинки ре-стітчу з простору замість сервера

**Feature**: `030-restitch-drive-images` | **Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)
**Status**: In progress — Phase 1–4 done (2026-10-08); the web delivery hook has no unit test of its own, its logic lives in tests/team-restitch-screens.test.ts; SQL for US1/US2/US4 landed with the one migration; T002 helper lives in tests/support/restitch-space.ts.

## Чинні обмеження

- Тести пишуться **перед** кодом у тому самому коміті (red → green); кожен контракт у `contracts/` має свій тестовий файл до реалізації.
- Машина слабка: перед будь-яким vitest/tsc — `uptime` (load < 6) і `pgrep -fl "vitest|tsc|vite"`; vitest лише `--pool=forks --poolOptions.forks.singleFork=true`, по одному файлу. `npm run verify` / `verify:release` — лише CI або раннер релізу.
- Міграції forward-only, timestamp після `20261022100000`; кожна завершується PGlite-тестом у `tests/`, інваріантами `supabase/tests/database/team-restitch.test.sql` і записом у `supabase/migrations/ROLLBACK.md` до застосування. На беті `db reset` заборонено.
- Усі нові SQL-функції: `security definer`, `set search_path = ''`, fully-qualified, `revoke all` → narrow `grant`; імена з `restitch`, `service_%` лише для `service_role`.
- `[P]` — незалежні файли після передумов фази. Правки одного SQL-файлу, `restitch.ts` у shared, `RestitchDefaultsSection.tsx`, `api/team.ts`, `updater-restitch.ts` — послідовно.
- **Порядок релізів** (plan.md): реліз A = Phase 2 (shared) + Phase 4 (агент, T020–T027) виходить агентом **до** деплою вебу; реліз B = Phase 2 (SQL) + Phase 3 + Phase 4 (веб) + Phase 5 + Phase 6; реліз C = Phase 7. `packages/shared/src/release.ts` змінюється лише в релізі A.
- Жоден таск не пише байти зображень у Supabase Storage. Будь-який новий `storage.from(...).upload` — дефект.

## Phase 1 — Setup

**Мета**: фікстури й заглушки, від яких залежать тести всіх історій.

- [x] T001 Додати у `tests/fixtures/restitch-images/` мінімальні бінарні фікстури: `plain.png`, `plain.jpg`, `plain.webp`, `exif-1.jpg`, `exif-3.jpg`, `exif-6.jpg`, `exif-8.jpg` (JPEG з тегом Orientation, 64×32 щоб напрямок було видно), `animated.gif`, `animated.webp`; і `tests/fixtures/restitch-images/index.ts` з їх md5 і очікуваними результатами. Генерувати детерміновано скриптом `tests/fixtures/restitch-images/make.mjs` (ffmpeg через `spawn`, без shell), фікстури комітити.
- [x] T002 [P] Додати у `tests/fixtures/team-sql.ts` (або наявний PGlite-helper для команд) `seedRestitchSpace(db, {...})`: команда з власником і двома учасниками (`view+download`, `process` без `download`), підключення, дерево матеріалів з папкою `restitch-fixtures` (png/jpg/webp, gif, heic, svg, jpg 60 МБ, два файли з однаковим `checksum`), вкладена підпапка, матеріали у станах `trashed`, `missing/removed`, `missing/out_of_root`.
- [x] T003 [P] Додати у `supabase/migrations/ROLLBACK.md` заголовки-заглушки для `20261029100000_restitch_sources` і `20261105100000_restitch_bucket_retirement` (зміст у T010 і T062).

## Phase 2 — Foundational

**Мета**: контракт у shared, можливість агента, схема й базовий resolve, коди помилок. Без цього жодна історія не збирається.

- [x] T004 Написати `tests/team-restitch-defaults.test.ts` (доповнити): `parseTeamRestitchDefaults` повертає `sourceMode: 'legacy'` для рядка без поля і `'drive'` для нового; `restitchDefaultsSaveable` для `sourceMode='drive'` не дивиться на uuid[]; нові `parseRestitchScreens`, `parseRestitchSourcesListing`, `parseRestitchDrawResult` відкидають невалідні записи цілком.
- [x] T005 У `packages/shared/src/team/restitch.ts` додати: `sourceMode: 'legacy' | 'drive'` у `TeamRestitchDefaults` (тотальний парс, дефолт `legacy`); типи `RestitchSlot`, `RestitchSourceKind`, `RestitchSourceAvailability`, `RestitchPoolState`, `RestitchSource`, `RestitchPoolSummary`, `RestitchSourcesListing`, `RestitchScreen`, `RestitchDrawResult`; парсери з T004; `RESTITCH_CONTRACT_VERSION = 2`; `RESTITCH_POOL_LIMIT = 500`; `RESTITCH_SCREEN_MAX_BYTES = 50 * 1024 * 1024`; `RESTITCH_SCREEN_MIME_TYPES`.
- [x] T006 У `packages/shared/src/release.ts` додати `teamRestitchSources: 1` до `AGENT_TOOL_CONTRACTS` з коментарем у стилі `teamPosterFrame` (не в `WEB_TOOL_REQUIREMENTS`), і `restitchSourcesSupported(contracts)` поряд із `teamPosterFrameSupported`; експортувати через `packages/shared/src/types.ts`. Перебудувати `npm run build -w @video-compressor/shared`.
- [x] T007 Написати `tests/team-restitch-sources-sql.test.ts` (PGlite, фікстура T002), частина «схема й resolve»: таблиця `team_restitch_sources` з RLS і грантами; `private.restitch_pool_images` розгортає папки рекурсивно, бере лише `category='image'`, `mime_type` ∈ png/jpeg/webp, `size_bytes` 1…52428800, розширення ∈ png/jpg/jpeg/webp, `lifecycle='active'`, `checksum not null`; `distinct on (checksum)`; стабільний порядок `(name, id)`; `limit 500`; `source_mode` на обох таблицях з дефолтом `legacy`; `effective_restitch_defaults_json` віддає `sourceMode`; check «рівно одне з `material_id`/`drive_file_id`»; видалення учасника каскадом прибирає його особисті пули, а видалення власника не чіпає пул простору (`added_by` → null).
- [x] T008 Створити `supabase/migrations/20261029100000_restitch_sources.sql`, частина DDL + resolve: таблиця за data-model.md (`material_id` null-able + `drive_file_id` null-able з check «рівно одне», унікальний індекс через `coalesce(material_id::text, drive_file_id)` і `coalesce(user_id, '00000000-0000-0000-0000-000000000000')`), RLS + `revoke all` + `grant select` під політикою учасника з `view`; `alter table public.team_restitch_defaults add column source_mode …`, те саме для `team_member_restitch_preferences`; `private.restitch_pool_images(p_team, p_user, p_slot)`; оновлений `private.effective_restitch_defaults_json` з `sourceMode`.
- [x] T009 У той самий файл: `insert into public.team_contract_seed` коди `RESTITCH_POOL_EMPTY`, `RESTITCH_SOURCE_FORBIDDEN`, `RESTITCH_SOURCES_INVALID`, `RESTITCH_SOURCES_TOO_MANY`, `RESTITCH_CLIENT_OUTDATED`; `drop policy if exists team_restitch_images_write on storage.objects` (FR-028); SELECT-політику не чіпати.
- [x] T010 [P] Записати зворотні кроки для `20261029100000_restitch_sources` у `supabase/migrations/ROLLBACK.md`, включно з відновленням INSERT-політики дослівно з `20261001010000_restitch_storage_policy_access.sql`.
- [x] T011 [P] У `apps/web/src/team/errors.ts` додати п'ять кодів з T009 у `TEAM_ERROR_CODES`-мапу і три агентні (`RESTITCH_SCREEN_UNAVAILABLE`, `RESTITCH_SCREEN_FETCH_FAILED`, `RESTITCH_SCREEN_UNSUPPORTED`) у `SYNC_COPY`; у `apps/web/src/i18n.ts` додати ключі `teamRestitchPoolEmpty`, `teamRestitchSourceForbidden`, `teamRestitchSourcesInvalid`, `teamRestitchSourcesTooMany`, `teamRestitchClientOutdated`, `teamRestitchScreenUnavailable`, `teamRestitchScreenFetchFailed`, `teamRestitchScreenUnsupported`, `teamRestitchSourceDisconnected` обома мовами; оновити `tests/team-edge-errors.test.ts`, щоб кожен код seed мав копію.
- [x] T012 Перевірити інваріанти `supabase/tests/database/team-restitch.test.sql` на новій міграції (нові функції додаються в Phase 3/4, але таблиця й `private.*` уже мають проходити `revoke`-перевірки); `tests/team-restitch-storage-sql.test.ts` оновити: INSERT у бакет від учасника тепер відхиляється, SELECT працює.

**Checkpoint**: shared збирається, міграція застосовується на PGlite, старі тести зелені (режим `legacy` без змін поведінки).

## Phase 3 — US1: Власник обирає картинки з простору (P1) 🎯 MVP

**Мета**: два пули з файлів і папок простору, збереження без агента, нуль байтів у Storage.
**Independent Test**: quickstart.md § US1.

- [x] T013 [US1] Дописати `tests/team-restitch-sources-sql.test.ts`, частина «list/set»: `set_restitch_sources` лише власник (інакше `RESTITCH_FORBIDDEN`), замінює пул слоту цілком, ≤ 500 (`RESTITCH_SOURCES_TOO_MANY`), відхиляє не-зображення і чужі матеріали (`RESTITCH_SOURCES_INVALID`), приймає `{driveFileId, kind:'folder'}` для ще не проіндексованої папки (пише `drive_file_id`, `availability:'pending'`; після появи матеріалу наступний `list` резолвить у `material_id`), ставить `source_mode='drive'`, очищає uuid[]; `set_member_restitch_sources` створює рядок з `use_owner=false`; `list_restitch_sources(team,'owner'|'self')` повертає форму з contracts/restitch-sources-sql.md: `eligibleCount`, `overLimit`, `skipped {format,size,animated}`, перекриття папки й файлу рахується один раз, стан `ready|empty`.
- [x] T014 [US1] У `20261029100000_restitch_sources.sql` додати `public.list_restitch_sources`, `public.set_restitch_sources`, `public.set_member_restitch_sources` за контрактом; `grant execute … to authenticated`; `set_restitch_defaults`/`set_member_restitch_defaults` приймають і зберігають `sourceMode`, у режимі `drive` ігнорують uuid[] і ставлять `configured=true`.
- [x] T015 [P] [US1] У `apps/web/src/api/team.ts` додати `listRestitchSources(teamId, scope)`, `setRestitchSources(teamId, slot, items)`, `setMemberRestitchSources(teamId, slot, items)` через `rpc` + парсери з shared; `getRestitchDefaults` і `setRestitchDefaults` прокидають `sourceMode`; тест у `tests/team-api-restitch.test.ts` (новий) на guard і мапу помилок.
- [x] T016 [P] [US1] Написати `tests/team-restitch-source-pools.test.tsx` (jsdom): компонент рендерить два пули зі списком джерел, лічильниками, відсіяними з причинами, позначкою перекриття; «Додати файли» відкриває `TaskAttachmentPicker` з `accept: category==='image'`; «Додати папку» відкриває `FolderPicker`; вилучення; стан `empty` каже «слот вимкнений»; `overLimit` попереджає; у режимі читання кнопок немає.
- [x] T017 [US1] Створити `apps/web/src/team/workspace/RestitchSourcePools.tsx`: пропси `{ teamId, client, listing: RestitchSourcesListing, editable, onChange(slot, items) }`; список джерел за зразком `ProductCatalogSettingsSection.tsx` (той самий `ul`/`IconButton`/`small` з кількістю), два пікери з інвентарю, без нових значень поза токенами; тексти в `i18n.ts` (`teamRestitchPoolStart`, `teamRestitchPoolEnd`, `teamRestitchPoolEligible`, `teamRestitchPoolSkipped*`, `teamRestitchPoolOverlap`, `teamRestitchPoolEmpty`, `teamRestitchPoolOverLimit`, `teamRestitchAddFiles`, `teamRestitchAddFolder`).
- [x] T018 [US1] Переписати `tests/team-restitch-section.test.tsx`: панель вантажить `getRestitchDefaults` + `listRestitchSources`, рендерить `RestitchSourcePools` і fit/тривалості/перемикачі/операцію зі **стану форми**; «Зберегти» активна без агента і без `fetchCompressorState`; save викликає `setRestitchSources` для змінених слотів і `setRestitchDefaults` з `sourceMode:'drive'`; `publishRestitchImages` не викликається ніколи; після save панель перечитує listing; analytics `setting_changed` з `file_count = eligibleCount(start)+eligibleCount(end)`.
- [x] T019 [US1] Переписати `apps/web/src/team/workspace/RestitchDefaultsSection.tsx`: прибрати `fetchCompressorState`/`uploadScreenImage`/`removeScreenImage`/`updateCompressorSettings`/`ImageEmbeddingSection`/`publishRestitchImages`; власний стан `{ operation, fitMode, finalDurationMode, customFinalDurationSeconds, startEnabled, endEnabled, startDurationMode, customStartDurationMs }` з контролів інвентарю; вмонтувати `RestitchSourcePools`; `connected` більше не впливає на `disabled` збереження; кнопку підготовки (`useRestitchPreparation`) лишити як є. У `apps/web/src/team/restitch/images.ts` видалити `publishRestitchImages` і `selected`; `ensureRestitchImages` лишити (legacy, Phase 7 видаляє). Оновити `tests/team-restitch-images.test.ts` (прибрати тести publish).

**Checkpoint**: власник налаштовує пули без агента; `storage.objects` не росте; старі простори в `legacy` працюють як раніше.

## Phase 4 — US2: Учасник перезшиває з картинками простору (P1)

**Мета**: вибір на сервері, байти через наявні гранти, окремий кеш агента, md5-ідентичність, EXIF.
**Independent Test**: quickstart.md § US2.
**Реліз A** = T020–T027 (агент), виходить до решти.

### Агент (реліз A)

- [x] T020 [P] [US2] Написати `tests/agent-screen-cache.test.ts` (mkdtemp + afterEach cleanup): hit без мережі повертає шлях і оновлює `lastUsedAt`; miss з `transfer` тягне через фейковий `TeamTransferClient`, звіряє `sourceChecksum`, `probeImage`, кладе `<materialId>-<md5>.<ext>` через temp+rename; mismatch → `RESTITCH_SCREEN_FETCH_FAILED`; збій мережі з наявним кешем → кеш + warning; ні кешу, ні `transfer` → `RESTITCH_SCREEN_UNAVAILABLE`; анімований webp/apng (кадрів > 1 за `probeImage`) → `RESTITCH_SCREEN_UNSUPPORTED` і файл не лишається в кеші; ENOSPC при записі → `RESTITCH_SCREEN_FETCH_FAILED`, temp-файл прибрано, `Images/` не чіпається; прибирання: старше 30 днів і не в наборі → видалено, > 500 на простір → LRU; `Images/` поряд не торкається.
- [x] T021 [US2] Створити `apps/agent/src/team-bridge/screen-cache.ts`: `class TeamScreenCache { constructor(root = join(applicationSupportRoot(), 'TeamScreens'), deps: { transfer, probeImage, now }) ; resolve(teamId, screens: RestitchScreen[], signal): Promise<ResolvedScreen[]> ; evict(teamId, keep: string[]) }`, `index.json` за data-model.md, помилки як `ImageAssetError`-подібний клас з кодом, лог через наявний `logError`/Pino; `probeImage` розширити полем `frames` (ffprobe `nb_frames`/`nb_read_frames`), щоб відсікати анімацію.
- [x] T022 [P] [US2] Написати `tests/stitch-exif.test.ts`: для фікстур T001 `imageOrientation(path)` повертає 1/3/6/8, для webp/png без тега 1; `orientationFilter(n)` дає `''`, `transpose=1,transpose=1` (або `hflip,vflip`), `transpose=1`, `transpose=2`; `imageAdaptationFilter(w,h,fit,orientation)` ставить префікс перед scale.
- [x] T023 [US2] Створити `apps/agent/src/stitcher/exif.ts`: спершу перевірити на бандленому ffmpeg 7.1.1 (`ffprobe -show_entries stream_tags=Orientation:stream_side_data` через наявний `probeJson`) чи тег експортується; реалізувати `imageOrientation` через ffprobe-тег з fallback на байтовий парсер APP1 для JPEG; `orientationFilter`. У `apps/agent/src/ffmpeg/presets.ts` розширити `imageAdaptationFilter` необов'язковим `orientation`. Зафіксувати в `research.md` R-03, який шлях спрацював.
- [x] T024 [P] [US2] Доповнити `tests/team-restitch-prepare.test.ts` або новий `tests/team-restitch-delegate.test.ts`: `parseRestitchOptions` приймає `screens` (валідні) і відкидає невалідні масивом цілком; делегат зі `screens` будує `StitchScreens` з шляхів кешу, не з `embedding()`; без `screens` поведінка legacy незмінна; `unstitch` ігнорує `screens`.
- [x] T025 [US2] У `apps/agent/src/team-bridge/restitch.ts` розширити `RestitchDelegateOptions` полем `screens: RestitchScreen[] | null`, `RestitchDelegateDeps` полем `screenCache: TeamScreenCache`; у `createRestitchDelegate` при `screens` → `screenCache.resolve` → `screensFromPaths(...)` (нова чиста функція поряд зі `spaceScreens`, що приймає шляхи + орієнтацію); після успішної доставки `screenCache.evict(teamId, keep)`.
- [x] T026 [US2] У `apps/agent/src/team-bridge/download.ts` пропустити `screens` з `process` у `options` делегата (`NormalizedProcess`), і в claim-шляху `apps/agent/src/team-bridge/process.ts` так само; у `apps/agent/src/index.ts` створити `TeamScreenCache` і передати в обидва `createRestitchDelegate` (рядки ~451 і ~503); перевірити `tests/agent-http.test.ts` на незмінність роуту `/api/team/restitch-images/:slot/:id`.
- [x] T027 [US2] Доповнити `tests/stitch-integration.test.ts` (skipIf без ffmpeg): доставка зі `screens` з попередньо наповненого кешу дає обидва екрани; фікстура `exif-6.jpg` у результаті має орієнтацію як `plain.jpg` (порівняння першого кадру за md5 після `scale`). Збірка `apps/agent` (`npm run build -w @video-compressor/agent`) зелена.

### Сервер і веб (реліз B)

- [x] T028 [P] [US2] Написати `tests/team-restitch-draw-sql.test.ts`: `draw_restitch_screens` вимагає `view`; повертає по одному на увімкнений слот з полями контракту; рівномірність по унікальних `checksum` (1000 викликів, кожен з 3 унікальних ≥ 25 %); два файли з однаковим `checksum` не подвоюють вагу; `unstitch` → `screens: []`; порожні увімкнені слоти → `RESTITCH_POOL_EMPTY`; `legacy` → `sourceMode:'legacy', screens:[]`; `service_draw_restitch_screens` завжди пул простору й налаштування власника; обидві функції приймають `p_exclude uuid[] default '{}'` і не повертають виключені матеріали; `list`/`draw` на пулі з 500 зображень укладаються в 300 мс на PGlite (м'який поріг, лог часу).
- [x] T029 [US2] У `20261029100000_restitch_sources.sql` додати `public.draw_restitch_screens(p_team)` і `public.service_draw_restitch_screens(p_team, p_actor)` за контрактом; гранти; інваріанти `team-restitch.test.sql` зелені.
- [x] T030 [P] [US2] Написати `tests/team-restitch-screens.test.ts` для `apps/web/src/team/restitch/screens.ts`: `prepareRestitchScreens(teamId, known)` → для `legacy` повертає `null` (старий шлях); перевіряє `restitchSourcesSupported` з `/api/health` → `'too-old'`; викликає `drawRestitchScreens`, потім `requestDownload(…, 'agent')` на кожен; `PERMISSION_DENIED` → `RESTITCH_SOURCE_FORBIDDEN`; повертає `RestitchScreen[]` з `transfer`.
- [x] T031 [US2] Створити `apps/web/src/team/restitch/screens.ts` і додати `teamApi.drawRestitchScreens(teamId)` у `apps/web/src/api/team.ts`; у `apps/web/src/api/client.ts` додати `agentCanRestitchFromSpace()` (health + `restitchSourcesSupported`); текст `teamRestitchAgentTooOldForSources` обома мовами в `i18n.ts`.
- [x] T032 [US2] Оновити `tests/team-restitch-delivery.test.ts`: для `sourceMode:'drive'` `deliver` викликає `prepareRestitchScreens` замість `ensureRestitchImages`, передає `process.screens`; `RESTITCH_POOL_EMPTY` → стан `{ kind:'failed', message: teamRestitchPoolEmpty }`; `legacy` → як раніше. Потім правка `apps/web/src/team/restitch/useRestitchDelivery.ts`.
- [x] T033 [P] [US2] Оновити `tests/product-catalog-dialog.test.tsx` і `apps/web/src/team/catalog/CreateProductCatalogDialog.tsx`: той самий `prepareRestitchScreens`; `toolContractVersion` брати з `RESTITCH_CONTRACT_VERSION` у shared замість літерала `1`.

**Checkpoint**: учасник на чистій машині отримує екрани з пулів власника; `Images/` не змінюється; повтор без переносів; md5-зміна тягне нове.

## Phase 5 — US3: Фон і особисті налаштування (P2)

**Мета**: claim v2 бере пул власника; інтерактив бере ефективний пул учасника; учасник на успадкованих бачить пул власника; `process` без `download` → названа помилка.
**Independent Test**: quickstart.md § US3.

- [ ] T034 [P] [US3] Оновити `tests/updater-restitch-routes.test.ts`: claim з `restitchContractVersion: 2` при `sourceMode:'drive'` → у відповіді `job.options.screens` з грантами, налаштування від **власника** (`service_get_effective_restitch_defaults(team, owner_id)`), `service_draw_restitch_screens(team, owner_id)`; без поля або `1` при `drive` → `RESTITCH_CLIENT_OUTDATED` **без** виклику `service_claim_restitch_job` (перевіряється порядок викликів); `legacy` → поведінка без змін; `RESTITCH_POOL_EMPTY` → `service_defer_restitch_job` (без інкременту `attempts`, `next_attempt_at` = +інтервал апдейтера, причина в `last_error_code`); грант на екран падає → одна повторна спроба `draw` з `p_exclude`, друга невдача → `fail(job,'RESTITCH_SOURCE_FORBIDDEN')`.
- [ ] T035 [US3] Реалізувати у `supabase/functions/drive-ops/updater-restitch.ts` за contracts/claim-and-delivery.md; `owner_id` брати з `teams` через наявний `deps.rpc`; гранти через `issue_team_transfer_grant` з `p_purpose='download_range'`: винести функцію видачі гранта з `supabase/functions/drive-transfer/index.ts` (рядки ~455–480, `issueGrant`) у `supabase/functions/_shared/transfer-grants.ts` і використати з обох функцій; додати в `20261029100000_restitch_sources.sql` RPC `public.service_defer_restitch_job(p_job, p_lease_token_hash, p_code, p_interval interval)` (`service_role`, тест у `tests/team-catalog-restitch-sql.test.ts`); у `supabase/functions/drive-ops/index.ts` прокинути `restitchContractVersion` з тіла.
- [ ] T036 [P] [US3] Оновити `tests/catalog-updater-restitch-preparer.test.ts` і `apps/web/src/team/catalog-updater/useRestitchPreparer.ts`: claim шле `restitchContractVersion: RESTITCH_CONTRACT_VERSION`; `ensureImages` викликається лише коли `claim.options.defaults.sourceMode !== 'drive'`; `options.screens` передається у `startProcess` без змін; `RESTITCH_CLIENT_OUTDATED` зупиняє подальші claim до перезавантаження і показує тост `teamRestitchClientOutdated`.
- [ ] T037 [P] [US3] У `apps/web/src/team/catalog-updater/CatalogUpdaterChip.tsx` (і `useCatalogUpdater.ts`, якщо код помилки там) показувати причину останньої невдачі ре-стітчу, коли вона `RESTITCH_POOL_EMPTY` або `RESTITCH_SOURCE_FORBIDDEN`, текстом з `errors.ts`; тест у `tests/catalog-updater-chip.test.tsx`.
- [ ] T038 [US3] У `RestitchDefaultsSection.tsx` для учасника на успадкованих (`!isOwner && useOwner`): завантажувати `listRestitchSources(team,'owner')` і рендерити `RestitchSourcePools` у режимі читання з позначкою `teamRestitchOwnerPoolsNote` над чекбоксом «використовувати мої»; для особистих — `listRestitchSources(team,'self')` і `setMemberRestitchSources`. Доповнити `tests/team-restitch-section.test.tsx` обома гілками.
- [ ] T039 [US3] Перевірити мапу `RESTITCH_SOURCE_FORBIDDEN` в інтерактиві (`useRestitchDelivery`) і в чипі: учасник D з `process` без `download` отримує саме цей текст; додати SQL-кейс у `tests/team-restitch-draw-sql.test.ts`, що `draw` для D проходить (потрібен лише `view`), а грант падає на `can_download` (мок у `tests/team-restitch-screens.test.ts`).

**Checkpoint**: 100 % фонових копій з пулу власника незалежно від виконавця; особисті пули лише в інтерактиві.

## Phase 6 — US4: Недоступний пул це видимий стан (P2)

**Мета**: `availability` на кожне джерело, стани `partial`/`empty`/`out_of_root`, ревалідація без полінгу, фон не зациклюється.
**Independent Test**: quickstart.md § US4.

- [x] T040 [P] [US4] Дописати `tests/team-restitch-sources-sql.test.ts`, частина «доступність»: `availability` = `available|trashed|missing|out_of_root|unsupported` для кожного `lifecycle`/`missing_reason`/формату; перейменування й переміщення всередині кореня не змінюють `eligibleCount`; стан `partial` коли є недоступні; `empty` коли всі; повернення з кошика → знов `ready` без запису; матеріали іншого `connection_id` → `out_of_root`; підключення не `connected` → усі джерела `disconnected`, обидва пули `empty`; джерело за `drive_file_id` без матеріалу → `pending`, після появи матеріалу → резолв у `material_id` і `available`.
- [x] T041 [US4] Реалізувати `availability` і стан пулу в `public.list_restitch_sources` (той самий SQL-файл), включно з `pending` для джерел за `drive_file_id` (з резолвом у `material_id` при кожному виклику) і `disconnected` за станом підключення.
- [ ] T042 [P] [US4] У `RestitchSourcePools.tsx` показати `availability` кожного джерела (бейдж з інвентарю, тексти `teamRestitchSourceTrashed|Missing|OutOfRoot|Unsupported|Pending`), підсумок `partial` («N з M джерел недоступні») і `empty`; тест у `tests/team-restitch-source-pools.test.tsx`.
- [ ] T043 [US4] У `RestitchDefaultsSection.tsx` перечитувати listing при монтуванні, після save і за сигналом каталогу з `apps/web/src/team/useTeamRealtime.ts` (той самий seam, що оновлює провідник; без нового таймера); тест у `tests/team-restitch-section.test.tsx` з `TeamContextOverride`.
- [ ] T044 [US4] Інтерактив: `RESTITCH_POOL_EMPTY` у `useRestitchDelivery` дає стан `pool-empty` з кнопкою «Відкрити налаштування» (як `unconfigured` сьогодні); фон: підтвердити в `tests/updater-restitch-routes.test.ts` і `tests/team-catalog-restitch-sql.test.ts`, що після `service_defer_restitch_job(…,'RESTITCH_POOL_EMPTY')` задача не доступна до `next_attempt_at`, `attempts` не змінився, а наступний claim після інтервалу переобчислює `draw` і віддає задачу, коли пул знову непорожній (без ручної дії).

**Checkpoint**: кожен крайній випадок зі spec.md § Edge Cases завершується станом із причиною; нуль задач у безкінечному повторі.

## Phase 7 — US5: Перехід і закриття сховища (P3) — реліз C

**Мета**: старі простори бачать «потребує перевибору» і мають шлях перенести картинки; старі клієнти отримують явну межу; бакет закривається.
**Independent Test**: quickstart.md § US5.

- [ ] T045 [P] [US5] Доповнити `tests/team-restitch-section.test.tsx`: для `sourceMode:'legacy'` з непорожніми uuid[] панель показує банер `teamRestitchLegacyBanner` з `legacyImageCount`, кнопки «Перевибрати» (скрол до пулів) і «Перенести старі картинки» (лише власник, лише з агентом, бо байти читаються з бакета браузером і це не потребує агента — кнопка активна і без агента); у `drive` банера немає.
- [ ] T046 [US5] Реалізувати банер у `RestitchDefaultsSection.tsx`; `list_restitch_sources` повертає `legacyImageCount = cardinality(start_image_ids)+cardinality(end_image_ids)` (T014 уже має поле, тут UI); коли агент підключений, назви старих картинок брати з `fetchCompressorState().settings.imageEmbedding` за uuid і показувати поряд із кількістю; без агента — лише кількість.
- [ ] T047 [P] [US5] Написати `tests/team-restitch-migrate-legacy.test.ts` для `apps/web/src/team/restitch/migrate-legacy.ts`: читає об'єкти `team-restitch-images/<team>/<sourceUserId>/<slot>/*` через SELECT-політику, вантажить кожен через наявний `uploadTeamFile` з `apps/web/src/team/catalog/material-actions-client.ts` (`drive-ops /uploads` relay) у папку з `teamApi.ensureWorkspaceFolder` з відносним шляхом `Re-stitch images/<slot>/<name>` тим самим механізмом, яким імпорт тек створює підпапки (перевірити, що `TeamFileUploadInput` несе відносний шлях; якщо ні, створити підпапку тим викликом `drive-ops`, яким це робить імпорт тек), після чого викликає `setRestitchSources(team, slot, [{driveFileId, kind:'folder'}])`; не падає на відсутніх об'єктах; звітує `{ moved, missing }`.
- [ ] T048 [US5] Створити `apps/web/src/team/restitch/migrate-legacy.ts` і підключити до кнопки банера з прогрес-тостом; після завершення панель перечитує listing (джерело `pending` до індексації).
- [ ] T049 [P] [US5] У `supabase/functions/delete-account/index.ts` видаляти об'єкти з префіксом `*/<userId>/` у `team-restitch-images` (admin `storage.from().list()` + `remove()` по команді з `owned`/`member` команд) до видалення користувача; тест у `tests/delete-account-team.test.ts` (доповнити наявний) на виклик `remove` з точними шляхами.
- [ ] T050 [P] [US5] Додати read-only звіт `scripts/restitch-bucket-inventory.mjs` (через analytics-роль або service key з `config/`, без запису): кількість і шляхи об'єктів у `team-restitch-images` і `team-thumbnail-cache`, згруповано по команді/користувачу; друкує JSON у stdout; документувати у `docs/ANALYTICS_CLI.md`.
- [ ] T051 [US5] Створити заглушку `supabase/migrations/20261105100000_restitch_bucket_retirement.sql` **лише** з коментарем-гейтом: «застосовувати після погодженого інвентаря T050; перелік об'єктів вставити явно; жодного `delete … where bucket_id = …` без списку»; `ROLLBACK.md` запис (T003). Міграція не застосовується в цій фічі.
- [ ] T052 [US5] Після релізу C і підтвердження, що жоден простір не в `legacy` (запит через T050 + `select count(*) … where source_mode='legacy' and cardinality(start_image_ids)+cardinality(end_image_ids)>0`): видалити `ensureRestitchImages`/`downloadImage` з `apps/web/src/team/restitch/images.ts`, роут `POST /api/team/restitch-images/:slot/:id` з `apps/agent/src/compressor/routes.ts`, `importTeamRestitchImage` з `apps/web/src/api/client.ts`; оновити `tests/agent-http.test.ts`, `tests/team-restitch-images.test.ts` (видалити файл, якщо порожній). **Свідомо лишається відкритим до підтвердження.**

**Checkpoint**: нуль нових записів у Storage з релізу B; усі простори мають шлях у `drive`.

## Phase 8 — Polish і наскрізне

- [ ] T053 [P] Оновити `docs/NO_SERVER_MEDIA_PLAN.md`: рядок «Space re-stitching settings» → Drive references; R1–R11 позначити «виконано у 030»; дата й SHA.
- [ ] T054 [P] Оновити `docs/TEAM_RESTITCH.md`: розділ «Картинки з простору» (пули, вибір на сервері, кеш агента `TeamScreens`, межа клієнтів, перехід).
- [ ] T055 [P] У `apps/web/src/pages/legal-content.ts` виправити фразу про перезшиті копії «коли Soty ні в кого не відкритий» на правду (вкладка учасника з правом обробки і запущений застосунок), обома мовами; після релізу C підтвердити фразу «не завантажуються на сервер» без застережень.
- [ ] T056 [P] Додати аналітику без ідентифікаторів: `setting_changed` з `setting_name:'team_restitch_sources'`, `file_count`; `tool_used`/наявна подія доставки з `cacheState: 'hit'|'miss'` для екранів (типізовано в `apps/web/src/analytics.ts`).
- [ ] T057 Пройти quickstart.md на беті для US1–US4 (реліз B) з `uptime` load < 6: зафіксувати результати у `specs/030-restitch-drive-images/findings.md` (що відхилилось від плану і чому), включно з інвентарем бакета до/після (SC-001).
- [ ] T058 Пройти quickstart.md § US5 на беті після релізу C; оновити `findings.md`.
- [x] T059 Оновити `specs/030-restitch-drive-images/research.md` R-03 результатом перевірки EXIF на ffmpeg 7.1.1 (який шлях увімкнено).

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 → Phase 2 → {Phase 3, Phase 4-агент} → Phase 4-веб → Phase 5 → Phase 6 → Phase 7 → Phase 8.
- Phase 4-агент (T020–T027) не залежить від Phase 3 і виходить релізом A раніше.
- Phase 4-веб (T028–T033) залежить від Phase 3 (панель з `drive`-пулами) і від опублікованого релізу A (інакше `too-old`).
- Phase 6 розширює SQL з Phase 3 і UI з Phase 3/5.
- Phase 7 залежить від усіх попередніх і від погодженого інвентаря (T050) для T051/T052.

### User Story Dependencies

- US1 незалежна після Phase 2.
- US2 потребує US1 лише для того, щоб було звідки брати пули (на беті можна сідити SQL-ом).
- US3 потребує US2 (screens у claim).
- US4 потребує US1 (listing) і US3 (фоновий `RESTITCH_POOL_EMPTY`).
- US5 потребує US1–US4.

### Parallel Opportunities

- Phase 1: T001 ∥ T002 ∥ T003.
- Phase 2: після T005/T006 — T007/T008 ∥ T011; T010 ∥ T012.
- Phase 3: T015 ∥ T016 ∥ T013; T017 після T016; T018/T019 після T014, T015, T017.
- Phase 4: агент T020 ∥ T022 ∥ T024 (тести), потім T021 → T023 → T025 → T026 → T027; веб T028 ∥ T030 ∥ T033 (тести), потім T029, T031, T032.
- Phase 5: T034 ∥ T036 ∥ T037, потім T035, T038, T039.
- Phase 7: T045 ∥ T047 ∥ T049 ∥ T050.
- Phase 8: T053 ∥ T054 ∥ T055 ∥ T056.

## Parallel Example: User Story 1

```
# Тести й API одночасно (різні файли):
T013 tests/team-restitch-sources-sql.test.ts
T015 apps/web/src/api/team.ts + tests/team-api-restitch.test.ts
T016 tests/team-restitch-source-pools.test.tsx
# Потім послідовно:
T014 → T017 → T018 → T019
```

## Implementation Strategy

1. **MVP = Phase 1–3**: власник обирає пули з простору й зберігає без агента; старі простори працюють у `legacy`. Уже закриває «нуль нових байтів у Storage» для нових налаштувань і знімає INSERT-політику.
2. **Реліз A** (агент, T020–T027) можна готувати паралельно з MVP і випустити першим; він нікому нічого не змінює.
3. **Реліз B** = MVP + Phase 4-веб + Phase 5 + Phase 6: повний новий шлях для всіх, хто перевибрав джерела.
4. **Реліз C** = Phase 7: перехід, чистка, закриття; T051/T052 лишаються відкритими до погодження інвентаря.
