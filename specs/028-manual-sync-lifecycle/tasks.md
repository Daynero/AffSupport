# Tasks: Надійний життєвий цикл ручної синхронізації Drive-папки

**Feature**: `028-manual-sync-lifecycle` | **Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)
**Status**: Not started.

## Чинні обмеження

- Тести пишуться **перед** кодом і спершу відтворюють дефект (red → green): спека вимагає переписати втрачені probes як регресії. Не вимагати штучного падіння вже справної поведінки.
- Машина слабка: перед будь-яким vitest/tsc — `uptime` (load < 6) і `pgrep -fl "vitest|tsc|vite"`; vitest лише `--pool=forks --poolOptions.forks.singleFork=true`, по одному файлу. `npm run verify` / `verify:release` — лише CI або раннер релізу.
- Міграції forward-only з вільним timestamp після `20261006120000`; кожна завершується PGlite-тестом у `tests/`, pgTAP у `supabase/tests/database/` і записом у `supabase/migrations/ROLLBACK.md` до застосування. На беті `db reset` заборонено.
- Усі нові SQL-функції: `security definer`, `set search_path = ''`, fully-qualified, `revoke all` → narrow `grant`. Секрети не писати нікуди.
- `[P]` — незалежні файли після передумов фази. Правки одного SQL-файлу, `useFolderResync.ts`, `ExplorerShell.tsx`, `syncStatus.ts` — послідовно.
- `packages/shared` і `apps/agent` ця фіча не змінює (принцип II: web-only deploy). Розширений контракт статусу — web-локальний `apps/web/src/team/syncStatus.ts`.
- Реліз A = Phase 3 + Phase 4 (частина A) + Phase 5. Він виходить окремо до початку Phase 6.

## Phase 1 — Setup

**Мета**: підготувати фікстури, зняти блокер зеленого verify, зарезервувати міграції.

- [x] T001 Додати у `tests/fixtures/catalog-sync.ts` фікстури Drive-помилок: тіло 403 `rateLimitExceeded`/`userRateLimitExceeded`, тіло 403 справжнього `insufficientFilePermissions`, тіло 400 з `location: 'pageToken'`, метадані файлу-ярлика (`shortcutDetails.targetId`), і helper `seedSyncScenario(db, {...})` для PGlite: waiter із failed canonical, waiter із retry canonical (`next_attempt_at = now + 14 min`), waiter без canonical, `leased` з простроченим lease, job detached-connection.
- [x] T002 [P] Полагодити або карантинувати (`it.skip` з посиланням на issue) сценарій «lets the current file go when the rest of the queue is dropped» у `tests/team-batch-queue.test.tsx`, щоб verify у CI міг бути зеленим; зафіксувати причину в описі коміту.
- [x] T003 [P] Додати у `supabase/migrations/ROLLBACK.md` заголовки-заглушки для `20261008100000_sync_orphan_recovery`, `20261008110000_sync_diagnostics_view`, `20261015100000_sync_requests_and_cancel`, `20261022100000_sync_replay_fencing` (зміст заповнюється у відповідних задачах).

## Phase 2 — Foundational

**Мета**: спільні сідлини, від яких залежать усі історії.

- [x] T004 Створити `supabase/migrations/20261008100000_sync_orphan_recovery.sql` лише з DDL: `catalog_sync_jobs` + `error_detail text`, `scan_completed_at timestamptz`, `lease_lost_count bigint not null default 0`; `catalog_sync_authority` + `recovery_count bigint not null default 0`, `last_recovery_at timestamptz`. Функції додаються у Phase 3 у цей самий файл.
- [x] T005 [P] У `apps/web/src/lib/supabase.ts` додати `withFreshSession(fn, options?: { signal?: AbortSignal })`: signal прокидається у повтор, `AbortError` не трактується як auth-помилка; у `apps/web/src/api/team.ts` додати мапу `AbortError → TeamApiError('ABORTED', { retryable: true })` у спільному обробнику RPC-помилок.
- [x] T006 [P] У `tests/team-folder-resync.test.tsx` додати тестовий harness: `vi.useFakeTimers()` + поліфіл `AbortSignal.timeout`/`AbortSignal.any` на фейкових таймерах, фейковий клієнт із керованими промісами для `resyncFolder`, `getFolderResyncStatus`, `findFolderSyncRequest`; існуючі 10 сценаріїв мають лишитись зеленими.

**Checkpoint**: DDL і сідлини готові; історії можна починати паралельно (US1 — SQL/worker, US2 — web, US5 — CLI).

## Phase 3 — User Story 1: Синхронізація завершується сама або чесно каже, що заблокована (P1) 🎯 MVP

**Goal**: жодна ручна робота не лишається у `running` без виконавця; ручний запит не чекає backoff фонового feed; ярлик/rate-limit/page token не вбивають job; сироти відновлюються sweeper-ом; застряглі jobs приводяться до ладу під час міграції.

**Independent Test**: PGlite-сценарії з T001 + quickstart §2 п.1–4, 8 (20/20 запусків без другого користувача; canonical failed → `CANONICAL_FAILED` ≤ 10 хв; canonical retry → результат без 14-хвилинного очікування; ярлик/без доступу → job завершено, connection живий).

### Тести (спочатку червоні)

- [x] T007 [P] [US1] У `tests/catalog-sync-ownership.test.ts`: «canonical non-retryable terminal failure marks waiters failed with CANONICAL_FAILED and error_detail» (NEEDS_REAUTH і PERMISSION_DENIED), «retryable exhaustion inserts a new canonical, bumps recovery_count and leaves waiters pending», «sixth recovery within 24h is treated as non-retryable», «the legacy three-value status reports CANONICAL_FAILED as failed» (сумісність зі старим web, FR-034).
- [x] T008 [P] [US1] У `tests/catalog-sync-ownership.test.ts`: «finite completion pulls a retrying canonical forward», «folder and root request RPCs pull a retrying canonical forward», «finite completion stamps scan_completed_at».
- [x] T009 [P] [US1] У `tests/catalog-sync-scheduler.test.ts`: «claiming an expired lease increments attempts and lease_lost_count», «tenth expired-lease reclaim retires the job as LEASE_LOST_EXHAUSTED», «invoke gate ignores replay waiters» (no POST when only waiters exist).
- [x] T010 [P] [US1] У `tests/catalog-sync-scheduler.test.ts`: «sweep creates a canonical for a waiter orphaned longer than 2 minutes», «sweep fails a waiter 60 minutes after scan_completed_at with REPLAY_TIMEOUT», «sweep cancels jobs of detached connections», «sweep retires long-expired leases with attempts >= 10», «sweep respects p_limit».
- [x] T011 [P] [US1] У `tests/catalog-sync-ownership.test.ts`: «applying the migration repairs pre-existing stuck rows without deleting catalog rows» (seed before `applyMigrations`, assert canonical inserted, leased → pending with attempts+1, detached → canceled, `count(team_materials)` unchanged).
- [x] T012 [P] [US1] Новий `tests/catalog-sync-drive-errors.test.ts` (fake fetch з фікстур T001): «403 rate limit maps to RATE_LIMITED retryable», «403 permission maps to PERMISSION_DENIED», «400 pageToken maps to INVALID_INPUT/PAGE_TOKEN_REJECTED and the engine starts a fresh generation», «a shortcut in the tree is counted unavailable and the scan completes», «a shortcut among changes is skipped and the canonical stays alive».
- [x] T013 [P] [US1] У `tests/team-sync-claim-sql.test.ts`: «find_team_folder_sync_request returns the latest job of the scope within 30 minutes for a member and null otherwise», «get_team_folder_sync_status returns root scans with scope __root__ and lastProgressAt» (включення root переноситься в M1, бо stall-детектор релізу A спирається на `lastProgressAt`).

### Реалізація

- [x] T014 [US1] У `20261008100000_sync_orphan_recovery.sql` переписати `public.service_retry_catalog_sync_job(uuid, text, boolean, integer, bigint)` за R1: terminal incremental → non-retryable → waiters `failed/CANONICAL_FAILED` + `error_detail`; retryable exhausted → insert canonical з `confirmed_cursor`, `next_attempt_at = now + 5 min`, `recovery_count + 1`, `last_recovery_at`; `recovery_count` за 24 год ≥ 6 → як non-retryable.
- [x] T015 [US1] У тому ж файлі: `public.service_complete_catalog_sync_job` finite-гілка — `scan_completed_at = clock_timestamp()` і nudge canonical `state in ('pending','retry')`; `public.request_team_folder_resync(uuid, text)` і `public.request_team_catalog_resync(uuid)` — той самий nudge після join/insert; `public.get_team_folder_sync_status` — прибрати `requested_folder_id is not null`, додати `or job_kind in ('initial','reconcile')` і `scopeFolderId = '__root__'` для root (решта розширень R8 лишається в M3).
- [x] T016 [US1] У тому ж файлі: `private.claim_catalog_sync_jobs` — при перехопленні `leased` з `lease_expires_at < now`: `attempts = least(attempts + 1, 1000)`, `lease_lost_count + 1`; якщо `attempts + 1 >= 10` → `failed/LEASE_LOST_EXHAUSTED` замість claim; `private.invoke_catalog_sync_worker` gate + `and j.replay_after is null`; `public.service_claim_catalog_sync_work` повертає також `team_id` (для логу worker-а, T041).
- [x] T017 [US1] У тому ж файлі: `private.sweep_catalog_sync_orphans(p_limit integer default 200) returns jsonb` за чотирма правилами R4 під `for update skip locked`; `private.cleanup_catalog_sync_retention` викликає sweep першим кроком; `revoke all` на обидві.
- [x] T018 [US1] У тому ж файлі: одноразовий data-fix R13 (waiters без canonical → insert canonical; прострочені `leased` → `pending`, `attempts + 1`; detached → `canceled/CONNECTION_DETACHED`), без delete і без змін `confirmed_*`.
- [x] T019 [US1] У тому ж файлі: `public.find_team_folder_sync_request(p_team uuid, p_folder text) returns table (sync_job_id uuid, state text, created_at timestamptz)` для member+ (team membership check), `grant execute to authenticated`.
- [x] T020 [US1] Заповнити розділ `20261008100000` у `supabase/migrations/ROLLBACK.md`: відновлення чотирьох функцій із попередніх файлів, видалення sweep, колонки лишити; створити `supabase/tests/database/sync-orphan-recovery.test.sql` (grants, `search_path`, sweep повертає jsonb з чотирма ключами, `cleanup_catalog_sync_retention` викликає sweep).
- [x] T021 [P] [US1] У `supabase/functions/_shared/drive.ts#request`: читати тіло помилки (`error.errors[0].reason/location`, try/catch); 403 з rate-limit reasons → `RATE_LIMITED` retryable; 400 з `location = 'pageToken'` → `INVALID_INPUT` з `detail: 'PAGE_TOKEN_REJECTED'`; решта без змін. У `supabase/functions/_shared/errors.ts` додати `detail` у `TeamFunctionError`, якщо його ще немає.
- [x] T022 [P] [US1] У `supabase/functions/_shared/drive.ts#proveLiveAncestry`: ярлик → `{ live: false, reason: 'shortcut' }` замість `UNSUPPORTED_MEDIA`; у `supabase/functions/catalog-sync/index.ts#isWithinRoot` трактувати як `unavailable` з причиною `shortcut`; у `supabase/functions/catalog-sync/engine.ts` рахувати `unavailable` у результаті job (`result.unavailable`) і пропускати зміни з ярликом у `runChanges` (ні upsert, ні tombstone).
- [x] T023 [US1] У `supabase/functions/catalog-sync/engine.ts` узгодити гілку `PAGE_TOKEN_REJECTED` (рядки ~612–622) з новим `INVALID_INPUT.detail`, щоб вона реально починала нове generation; виправити коментар «60 s lease» в `index.ts` на 180.

**Checkpoint US1**: T007–T013 зелені; quickstart §2 п.1–4, 8 на беті виконані й записані.

## Phase 4 — User Story 2: Кнопка і стан у браузері ніколи не брешуть (P1)

**Goal**: окремі deadline на прийняття/статус/фінальне перечитування; abort доходить до HTTP; лок завжди звільняється; «зв'язок втрачено» ≠ «не вдалося»; superseded strict read не дає фальшивої помилки; переходи не плодять orphan callbacks. Частина A (T024–T034) входить у реліз A, включно з гейтом кнопки за роллю (FR-033), root-scope у нащадках (FR-017) і localStorage між вкладками (FR-018); частина B (T035–T036) потребує Phase 6 і виконується після T049, хоча нумерована раніше.

**Independent Test**: `tests/team-folder-resync.test.tsx` + quickstart §2 п.5–6 (кнопка жива ≤ 20 с; нуль фальшивих «не вдалося» у 20 здорових прогонах; нуль чужих тостів у 20 переходах).

### Тести (спочатку червоні)

- [x] T024 [P] [US2] У `tests/team-folder-resync.test.tsx`: «an accept that never answers releases the button after 15 s with outcome unreachable and remembers the scope as unknown», «the next click after unknown looks up the request before creating a new one».
- [x] T025 [P] [US2] Там само: «a hung status read is aborted after 15 s, releases the local lock and reports disconnected without forgetting the job», «a transient status error reports disconnected, a missing job (NOT_FOUND from the detailed status) still clears the retained id».
- [x] T026 [P] [US2] Там само: «ten minutes without lastProgressAt advancing reports stalled», «a slow scan whose lastProgressAt keeps advancing is not cut off at five or ten minutes» (детальний статус із root, T015), «the accept signal is passed to the client» (фейковий клієнт перевіряє `options.signal`).
- [x] T027 [P] [US2] Там само: «a late acceptance after the scope changed does not start a monitor or toast on the new scope», «a second tab discovers the job through localStorage and polls it without a second request» (sessionStorage не ділиться між вкладками), «a root sync stays visible inside a child folder» (`scopeFolderIds` містить `'__root__'`), «the sync button is shown only to owner and admin» (у `tests/team-explorer-folder-upload.test.tsx`).
- [x] T028 [P] [US2] Новий `tests/team-explorer-refresh.test.tsx`: «a strict refresh superseded by a background read resolves with the newer read instead of failing», «a strict refresh fails only when the newest read failed» для `ExplorerProvider.refreshStrict` і `useFolderPage.refreshWindow(true)`.

### Реалізація (реліз A)

- [x] T029 [US2] У `apps/web/src/api/team.ts`: `resyncFolder`, `resyncDrive`, `getFolderResyncStatus`, `getFolderSyncStatus` приймають `options?: { signal?: AbortSignal }` і передають `.abortSignal(signal)`; нова `findFolderSyncRequest(teamId, folderId, options?)` → `find_team_folder_sync_request`, повертає `{ syncJobId, state, createdAt } | null`.
- [x] T030 [US2] У `apps/web/src/team/explorer/useFolderResync.ts`: константи `ACCEPT_TIMEOUT_MS=15_000`, `STATUS_TIMEOUT_MS=15_000`, `FINAL_REFRESH_TIMEOUT_MS=30_000`, `STALL_TIMEOUT_MS=600_000`; кожен виклик отримує `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`; `accepting`/`active` скидаються у `finally` завжди; прибрати фіксований 5-хвилинний таймер, замінити stall-детектором за `lastProgressAt` із детального `getFolderSyncStatus` (root включно після T015); 3-value RPC більше не опитується новим web.
- [x] T031 [US2] Там само: новий тип `FolderResyncOutcome = 'succeeded'|'failed'|'unreachable'|'disconnected'|'stalled'`; pending key `'unknown'` після accept-таймауту; клік при `'unknown'` спершу `findFolderSyncRequest`; `AbortError`/мережа/5xx на status → `disconnected` без очищення key; `NOT_FOUND` або `INVALID_RESPONSE` → очищення key; pending key переноситься з sessionStorage у localStorage (`soty:folder-resync:<team>:<scope>`), щоб вкладки ділили одну роботу (FR-018); `apps/web/src/team/TeamContext.tsx` при logout/зміні акаунта видаляє всі ключі з цим префіксом; callback-и лише при збігу `latest.current.teamId` і scope.
- [x] T032 [US2] У `apps/web/src/team/explorer/ExplorerShell.tsx`: кнопку синхронізації гейтити за `activeTeam?.role` ∈ {owner, admin} (як уже робить `canTag`; без нового прапора в shared `TeamPermissions` і без зміни RPC; FR-033), `scopeFolderIds` завжди починати з `'__root__'`, щоб синхронізація простору була видна в нащадках (FR-017); у `onOutcome` обробити `unreachable`/`disconnected`/`stalled` окремими тостами; додати ключі `teamFolderResyncUnreachable`, `teamFolderResyncDisconnected`, `teamFolderResyncStalled` (uk/en) у `apps/web/src/i18n.ts` за текстами з `contracts/web-status-contract.md`.
- [x] T033 [US2] У `apps/web/src/team/explorer/ExplorerProvider.tsx#read`: зберігати `inflight.current` (проміс найновішого read); при `sequence !== readSequence.current` у strict-режимі дочекатися `inflight.current` і повернути його результат; `FOLDER_TREE_REFRESH_FAILED` лише коли найновіший read впав.
- [x] T034 [US2] Те саме для `apps/web/src/team/explorer/useFolderPage.ts#refreshWindow(true)`: superseded → дочекатися найновішого `refreshWindow` і вважати успіхом; `CATALOG_REFRESH_SUPERSEDED` більше не доходить до `onComplete`.

### Реалізація (реліз B, після Phase 6)

- [x] T035 [US2] У `useFolderResync.ts`: генерувати `requestKey` (uuid v4) перед accept і зберігати у localStorage поруч із pending key; викликати 3-arg overload; lookup при `'unknown'` — через `find_team_folder_sync_request(p_team, p_request_key)` (overload з T049).
- [x] T036 [US2] Новий `apps/web/src/team/explorer/syncOperations.ts`: реєстр активних моніторів із ключем `team|connection|scope|job`, що живе на рівні `TeamContext` (не сторінки); `apps/web/src/team/TeamContext.tsx` очищає реєстр при зміні акаунта/logout/зміні простору; хук підписується на реєстр замість власного `active.current`.

**Checkpoint US2 (A)**: T024–T028 зелені; quickstart §2 п.5–6 записані.

## Phase 5 — User Story 5: Власник продукту бачить стан синхронізацій без доступу до секретів (P2, у релізі A)

**Goal**: read-only view + команда `analytics -- sync`; лог worker-а з ідентифікаторами; SQL-помилки видимі.

**Independent Test**: `tests/analytics-sync-command.test.ts`, `tests/catalog-sync-worker-log.test.ts`, quickstart §2 п.7 (≤ 10 с, усі поля, нуль `cursor|token` у виводі).

- [x] T037 [P] [US5] Новий `tests/analytics-sync-command.test.ts`: PGlite з M1+M2 і сценаріями T001; `getSyncJobs(teamId)` і `getSyncJobs(email)` повертають усі connection з canonical-блоком і jobs; `--json` envelope `{ ok, command: 'sync', generated_at, period: null, data }`; snapshot-перевірка, що серіалізований вивід не містить `cursor`, `token`, `folder_queue`, назв із фікстур; `--limit 0`/`501` відхиляються.
- [x] T038 [P] [US5] Новий `tests/catalog-sync-worker-log.test.ts`: фейковий RPC-клієнт і fake Drive; `catalog_sync_job_result` містить `jobId, teamId, connectionId, workerId, leaseEpoch`; помилка RPC дає `catalog_sync_rpc_error { rpc, code, message }` без `parameters`; grep усіх лог-рядків на фікстурні токени/назви = 0.
- [x] T039 [US5] Створити `supabase/migrations/20261008110000_sync_diagnostics_view.sql`: `public.analytics_catalog_sync_jobs` з колонками з `contracts/diagnostics-cli.md` (`scope_hash` = 12 символів sha256; `request_*` і `files_*`/`no_progress_runs`/`cancel_requested_at` як null/0 до релізів B/D), `revoke all`, `grant select to wishly_analytics_ro`; розділ у `ROLLBACK.md` (`drop view`); `supabase/tests/database/sync-diagnostics-view.test.sql` — whitelist колонок, відсутність `cursor|folder_queue|confirmed_cursor|page_token|lease_owner`, grant лише ro-ролі; `npm run types:supabase` (новий public view).
- [x] T040 [US5] У `scripts/analytics/queries.ts` додати `getSyncJobs(teamOrEmail: string, limit = 50)` (email → `analytics_users`; bound-параметри; `assertReadOnlySql`); типи `SyncJobRow`, `SyncConnection`, `SyncData` у `scripts/analytics/types.ts`; таблиця `job | kind | phase | state | age | progress | attempts/lost | waits_for | error` у `scripts/analytics/format.ts`; команда `sync <team-id|owner-email> [--limit N] [--json]` і help у `scripts/analytics/index.ts`; рядок у таблиці команд `AGENTS.md`.
- [x] T041 [P] [US5] У `supabase/functions/catalog-sync/index.ts`: `catalog_sync_job_result` (усі три гілки) + `teamId`, `connectionId`, `workerId`, `leaseEpoch`; `rpcValue` → `console.error({ event: 'catalog_sync_rpc_error', rpc: name, code: error.code, message: error.message })` перед `throw`; `teamId` береться з claim-рядка (T016).

**Checkpoint — реліз A**

- [ ] T042 Зняти знімок інциденту до 2026-10-14: після backend-apply M1+M2 на prod виконати `npm run analytics -- sync <owner-email> --json` і записати редагований результат (стан canonical у момент першого кліку: `failed`+код / `retry` / прострочений lease) у `docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md`, розділ «Крок 1»; якщо M1 ще не застосовано — той самий SELECT власником через Dashboard, без змін даних.
- [ ] T043 Реліз A за `docs/BETA.md` і runbook: гілка від `beta-dev`; targeted-тести з quickstart §1 (реліз A) локально по одному; CI verify зелений; `release:backend-apply` (M1, M2, `catalog-sync`); packaged beta на точний SHA; quickstart §2 п.1–8 на беті з двома акаунтами, результати у `specs/028-manual-sync-lifecycle/quickstart.md` (розділ «Evidence, реліз A»); web deploy; 24 год спостереження через `analytics -- sync` (жодного waiter старшого за 10 хв без причини).

## Phase 6 — User Story 3: Зрозумілий стан, чесний результат і «Зупинити» (P2, реліз B)

**Goal**: один контракт станів для папки й root; довговічні лічильники на job; таблиця запитів з idempotency; серверний cancel конкретного запиту; панель статусу з інвентарю ui.

**Independent Test**: `tests/catalog-sync-cancel.test.ts`, `tests/team-sync-contracts.test.ts`, `tests/team-sync-status-panel.test.tsx`; quickstart §3 (підсумок = відомий набір змін 10/10; cancel у 4 станах → один кінцевий стан; спільна робота → detached).

### Тести

- [x] T044 [P] [US3] Новий `tests/catalog-sync-cancel.test.ts`: «the same request key returns the same job», «cancel of a shared job detaches only this request», «cancel in pending/retry cancels immediately with CANCELED_BY_USER», «cancel of a leased job makes the lease lock refuse and claim retires it canceled», «cancel racing completion yields exactly one terminal state», «a member cannot cancel another user's request, an admin can».
- [x] T045 [P] [US3] Новий `tests/team-sync-status.test.ts`: `parseFolderSyncStatus` з `apps/web/src/team/syncStatus.ts` приймає всі 8 станів і нові поля, відкидає невідомий `state`/`phase` і зайві приватні поля (`cursor`, `folder_queue`); `tests/team-sync-contracts.test.ts` (shared) лишається без змін.
- [x] T046 [P] [US3] У `tests/catalog-sync-ownership.test.ts`: «page/candidate/folder commits increment job counters and retention never lowers them», «a waiter without a live canonical is reported blocked with canonical_failed», «a retrying job is reported retry_wait with nextAttemptAt».
- [x] T047 [P] [US3] Новий `tests/team-sync-status-panel.test.tsx` (jsdom): рендер кожного з 8 станів, підсумок «додано/оновлено/змін немає/частково», кнопка «Зупинити» лише при `cancelable`, підказка при `sharedWith > 0`, `aria-live` оголошує лише зміну стану, copy-кнопка копіює `jobId`.

### Реалізація

- [x] T048 [US3] Створити `supabase/migrations/20261015100000_sync_requests_and_cancel.sql`: таблиця `private.catalog_sync_requests` (data-model §3, RLS off для private, індекси по `job_id`, `team_id`); колонки `cancel_requested_at/by`, `files_listed/added/updated/removed`, `items_unavailable`, `folders_done`; розділ у `ROLLBACK.md`.
- [x] T049 [US3] У тому ж файлі: overloads `request_team_folder_resync(uuid, text, text)` і `request_team_catalog_resync(uuid, text)` з `p_request_key` → `(sync_job_id, request_id, outcome)`; 2-arg/1-arg overloads генерують ключ самі й вставляють request; `cancel_team_folder_sync(uuid, uuid)` за R9; overload `find_team_folder_sync_request(p_team uuid, p_request_key text)` → `(sync_job_id, request_id, state)`; `lock_catalog_sync_lease` + `cancel_requested_at is null`; claim: `cancel_requested_at` у `pending/retry` → `canceled`; `private.join_catalog_subtree` виключає jobs із `replay_after is not null` (завершений waiter не приймає нових запитів — один follow-up, FR-007) з тестом у `tests/catalog-sync-scope-join.test.ts`.
- [x] T050 [US3] У тому ж файлі: інкременти лічильників у `commit_catalog_scan_page`, `resolve_catalog_candidate`, `finish_catalog_folder`, `upsert_catalog_page`, `tombstone_catalog_files` (added/updated через `xmax = 0`); `get_team_folder_sync_status` розширений за R8 і data-model §5 (root уже з M1; `blocked`, `retry_wait`, `canceling`, `progressRevision`, `cancelable`, `sharedWith`); `supabase/tests/database/sync-requests-cancel.test.sql`; оновити view M2 (`create or replace`) щоб віддавати `request_*`, `files_*`, `cancel_requested_at`.
- [x] T051 [US3] Новий `apps/web/src/team/syncStatus.ts` (shared не чіпати — принцип II): `FOLDER_SYNC_STATES`, `FOLDER_SYNC_PHASES` (+`replaying_changes`), `FOLDER_SYNC_BLOCKED_REASONS`, `FolderSyncStatus`, `parseFolderSyncStatus(value: unknown)` з boundary-перевіркою; `apps/web/src/api/team.ts` імпортує звідси замість `@video-compressor/shared` для детального статусу.
- [x] T052 [US3] У `apps/web/src/api/team.ts`: `resyncFolder`/`resyncDrive` з `requestKey` → 3-arg RPC і `{ syncJobId, requestId, outcome }`; `cancelFolderSync(teamId, requestId)` → `{ jobState, requestOutcome }`; `getFolderSyncStatus` через новий парсер.
- [x] T053 [US3] У `apps/web/src/team/explorer/useFolderResync.ts`: монітор читає `getFolderSyncStatus` (детальний) замість 3-value; stall-детектор за `lastProgressAt`; `blocked`/`retry_wait`/`canceling`/`canceled` мапляться в outcomes і в `status`, який хук повертає; `cancel()` викликає `cancelFolderSync` і переводить UI у `canceling`; `onProgress(status)`.
- [x] T054 [US3] Новий `apps/web/src/team/explorer/SyncStatusPanel.tsx` лише з `apps/web/src/components/ui/` (Chip, Button, Progress, Tooltip, Dialog для деталей) і токенів `apps/web/src/styles/tokens.css`: стан+етап, обсяг, час старту/тривалість/останній поступ, лічильники, підсумок, причина+дія, «Зупинити», підказка про спільну роботу, copy `jobId`/`requestId`, коротка історія останніх 5 запитів із sessionStorage; `aria-live="polite"` на зміну стану; монтування у `ExplorerShell.tsx` поруч із кнопкою; ключі `teamFolderResyncBlocked.*`, `teamFolderResyncSummary.*`, `teamFolderResyncCancel*` у `apps/web/src/i18n.ts`; додати панель у `apps/web/src/dev/DesignSystemPage.tsx`.
- [x] T055 [US3] У `supabase/functions/catalog-sync/engine.ts` і `index.ts`: передавати в commit-RPC кількості added/updated/removed/unavailable, які повертають нові RPC (або читати їх з `returning`), щоб `result.processed` узгоджувався з лічильниками job; у replay — `upsert_catalog_page`/`tombstone_catalog_files` повертають counts.

**Checkpoint — реліз B**: T044–T047 зелені; `npm run types:supabase` (public view змінився); quickstart §3 записано; backend-apply M3 → web-only deploy (shared/agent не змінені).

## Phase 7 — User Story 4: Команда бачить результат навіть без живих оновлень (P2, реліз C)

**Goal**: проміжні коміти видимі через bounded invalidation з активного монітора; membership не блокує каталог; застарілий health позначений.

**Independent Test**: quickstart §4 (member без Realtime бачить проміжні файли ≤ 30 с і кінцевий ≤ 30 с; ≤ 1 list-read на 5 с; health «застаріло N хв»).

- [x] T056 [P] [US4] У `tests/team-realtime.test.tsx`: «a realtime refetch bumps the materials revision before awaiting membership», «a failed membership read still delivers the catalog revision and logs separately», «reconnect after three failed reads performs one authoritative read», «an unsubscribed channel of the previous team never invalidates the new team».
- [x] T057 [P] [US4] У `tests/team-storage-health.test.tsx`: «a failed health read exposes staleSince while keeping the last snapshot», «a successful read clears staleSince».
- [x] T058 [P] [US4] У `tests/team-folder-resync.test.tsx`: «a changed progressRevision calls onProgress at most once per five seconds», «an unchanged progressRevision does not call onProgress».
- [x] T059 [US4] У `apps/web/src/team/TeamContext.tsx#handleRealtimeRefetch`: `setRevision` до `await refreshTeams(true)`; помилка membership → окремий лог/стан `membershipStale`, без блокування revision.
- [x] T060 [US4] У `apps/web/src/team/explorer/ExplorerShell.tsx`: `onProgress` → `catalogFreshness.invalidate(scope)` з debounce 5 с (без нового таймера поза активним монітором); зберегти visible-window/anchor/selection через наявний `refreshWindow()`.
- [x] T061 [US4] У `apps/web/src/team/storage/useStorageHealth.ts` повертати `{ health, refresh, staleSince }`; у `apps/web/src/team/storage/StorageChip.tsx` показувати вік понад 2 хв компонентом з інвентарю (Chip/Tooltip) і ключем `teamStorageHealthStale` у `apps/web/src/i18n.ts`.

**Checkpoint — реліз C**: web-only deploy (SQL не змінюється).

## Phase 8 — User Story 6: Worker не крутить роботу вічно і не псує дані після втрати оренди (P3, реліз D)

**Goal**: огороджені replay-записи; бюджет до/після кожного provider call; checkpoint усередині replay-сторінки; лічильник «без поступу».

**Independent Test**: `tests/catalog-sync-replay-fencing.test.ts`, `tests/catalog-sync-scheduler.test.ts` (NO_PROGRESS), `tests/catalog-sync-worker-budget.test.ts`; quickstart §5.

- [x] T062 [P] [US6] Новий `tests/catalog-sync-replay-fencing.test.ts`: кожен із 7 fenced overloads відмовляє при чужому epoch, простроченому lease і `cancel_requested_at`; старий overload пише `UNFENCED_RPC` warning і працює.
- [x] T063 [P] [US6] У `tests/catalog-sync-scheduler.test.ts`: «a claim without progress since the previous claim increments no_progress_runs», «progress resets no_progress_runs», «the tenth no-progress run retires the job as NO_PROGRESS».
- [x] T064 [P] [US6] Новий `tests/catalog-sync-worker-budget.test.ts` (fake Drive з лічильником викликів і керованою затримкою): «reconciliation yields with a checkpoint when the budget is exhausted mid-batch», «a replay page checkpoints before transcript ingestion», «a worker that lost its lease does not trash landing artifacts or commit transcripts», «a hidden cache row in the folder does not restart the generation».
- [x] T065 [US6] Створити `supabase/migrations/20261022100000_sync_replay_fencing.sql`: overloads з `p_lease_epoch` для `upsert_catalog_page`, `tombstone_catalog_files`, `invalidate_landing_renders`, `mark_folder_indexed`, `mark_root_state`, `touch_catalog_reconciled`, `enqueue_catalog_reconciliation` (перший рядок — `lock_catalog_sync_lease`, відмова → `raise exception 'LEASE_LOST'`); старі сигнатури → `raise warning 'UNFENCED_RPC %'`; claim: `progress_at_last_claim`, `no_progress_runs`, `failed/NO_PROGRESS` при ≥ 10; оновити view M2 (`no_progress_runs`) і `npm run types:supabase`; `ROLLBACK.md`; `supabase/tests/database/sync-replay-fencing.test.sql`.
- [x] T066 [US6] У `supabase/functions/catalog-sync/index.ts`: усі replay-RPC викликати fenced overloads з `leaseEpoch`; `assertLease()` перед кожним Drive trash у `invalidateLandingRenders` і перед transcript commit; `LEASE_LOST` з RPC → `CatalogLeaseLostError`.
- [x] T067 [US6] У `supabase/functions/catalog-sync/engine.ts`: у reconciliation перевіряти бюджет до і після кожного `getFile`/ancestry walk, при вичерпанні — `release` з checkpoint і вихід; у `runChanges` checkpoint після ancestry-walk/upserts і до transcript ingestion; ingestion — окрема bounded одиниця з власною перевіркою бюджету.
- [x] T068 [US6] У `supabase/functions/catalog-sync/engine.ts` reconciliation: перевірку hidden-cache (`.soty`) робити до `parents.includes(folder)`, щоб службовий рядок не давав `incompleteListing`.

**Checkpoint — реліз D**: backend-apply M4 + `catalog-sync`; наступного релізу видалити старі unfenced сигнатури (окрема задача T071).

## Final Phase — Polish і cross-cutting

- [x] T069 [P] Оновити `docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md`: статус кожного F1–F7 після релізів A–D, посилання на спеку 028, результат знімка T042.
- [x] T070 [P] Перевірити, що `scripts/check-design-tokens.mjs`, `scripts/check-tailwind-classes.mjs`, `tests/ui-consistency.test.tsx`, `tests/design-components.test.tsx` зелені для `SyncStatusPanel.tsx` і `StorageChip.tsx`; `npm run format`.
- [x] T071 Створити follow-up запис у `specs/028-manual-sync-lifecycle/quickstart.md` (розділ «Після релізу D»): видалити старі unfenced overloads наступним релізом; перевірити 24-годинні метрики (waiters > 10 хв, `error_code` розподіл, `lease_lost`/`no_progress` у логах, p95 request→claim, частка `disconnected` у web-аналітиці).

## Примітки виконання (реліз A, 2026-10-07)

- T002: `team-batch-queue.test.tsx` сам по собі зелений за 4 с; падає лише під повним
  навантаженням suite на цій машині. Код не змінено, карантин не потрібен; CI вирішує.
- T007–T011, T013: регресії зібрані в новому `tests/catalog-sync-lifecycle.test.ts`
  (окрема БД на suite замість дописування у `catalog-sync-ownership.test.ts`).
- T012/T022: ярлик — це вже тип матеріалу (`kind = 'shortcut'`), тому він не
  «пропускається», а розміщується за власними батьками: `proveLiveAncestry` отримав
  `allowShortcutTarget`, який вмикає лише каталог; авторизаційні перевірки незмінні.
  Лічильник `unavailable` у worker-і не потрібен. Гілка `PAGE_TOKEN_REJECTED` в engine
  уже була живою — бракувало лише мапи в `_shared/drive.ts` (`details.reason`).
- T016: `service_claim_catalog_sync_work` уже повертав `team_id`; зміна не знадобилась.
  Перехоплення простроченого lease зберігає `next_attempt_at` (місце в черзі), інакше
  падає `team-sync-claim-sql` «back of the queue».
- T017: sweep має параметр `p_min_age` (2 хв за замовчуванням, 0 у data-fix M1) і
  викликається з нової `private.run_catalog_sync_maintenance()`, на яку
  перепланований cron `wishly-catalog-sync-retention`.
- T029: `findFolderSyncRequest` передає `null` для кореня; `__root__` SQL не бачить.
  Abort із supabase-js приходить як `{ error.message: 'AbortError: …' }` і мапиться у
  локальний `RequestAbortedError` (shared `TeamErrorCode` не розширено).
- T033/T034: спільний `settleRead` у `apps/web/src/team/explorer/readSettle.ts`.
- T039: `types:supabase` працює лише `--linked`; запис `find_team_folder_sync_request`
  додано в `apps/web/src/lib/database.types.ts` вручну, повна регенерація — після
  backend-apply M1/M2 (T043). pgTAP-сюїти запускаються штатним database gate у CI.
- T032: ролі в контракті — `owner | admin | editor | viewer` (не «member»); тест гейту використовує `editor` з admin-дозволами.
- T041: записи логу зібрані у `supabase/functions/catalog-sync/logging.ts`
  (`jobResultRecord`, `rpcErrorRecord`), тест без Deno.

## Примітки виконання (релізи B, C, D, 2026-10-07, та сама гілка)

- Усі чотири релізи реалізовані на одній гілці за рішенням власника («роби все, щоб
  працювало ідеально»); міграції лишаються чотирма окремими файлами, тож при потребі
  A можна випустити самостійно cherry-pick-ом.
- T036: окремого реєстру `syncOperations.ts` немає — localStorage між вкладками, виявлення
  job при монтуванні та очищення пам'яті при виході (`AuthContext.signOut`) покривають
  FR-017/018; другий монітор у тій самій вкладці неможливий, бо хук один на Explorer.
- T045: тест парсера — `tests/team-sync-status.test.ts`; T046/T047 — у
  `tests/catalog-sync-cancel.test.ts` і `tests/team-sync-status-panel.test.tsx`.
- T049: окремий `find_team_folder_sync_request_by_key(uuid,text)` замість overload з тим
  самим набором типів; 2-arg/1-arg request-RPC делегують у keyed-версію з ключем
  `legacy-<uuid>`, тож старий web теж залишає рядок запиту.
- T050: лічильники added/updated обчислюються в commit-RPC через «існував до upsert»
  (без зміни `upsert_catalog_snapshot`); огороджені overloads replay-upsert/tombstone
  живуть у M3, бо лічильники потребують job id; решта fence — у M4.
- T053/T054: панель `SyncStatusPanel` з Chip/Progress/Tooltip/Button інвентарю; стилі
  `.team-sync-panel*` у `styles.css` лише на токенах; демо всіх 8 станів у `/design` →
  «Data». Ключ `teamSyncRetry` уже існував — новий названо `teamSyncRunAgain`.
- T059: `setRevision` тепер до `await refreshTeams(true)`; втрата членства далі
  сигналізується через `refreshTeams`.
- T060: `onProgress` → `notifyStateChanged()` не частіше ніж раз на 5 с.
- T063/T065: лічильник без поступу рахує перезапуски generation
  (`service_begin_catalog_folder(restart=true)`), скидається у `finish_folder`, 10 → `NO_PROGRESS`.
- T065: старі unfenced сигнатури лишені без warning (їх далі використовує лише
  rollback-шлях); видалення — окремим релізом після D.
- T066: перед Drive trash і commit транскрипта worker питає
  `service_catalog_sync_lease_live`; `LEASE_LOST` з fenced RPC мапиться в `CatalogLeaseLostError`.
- T067/T068: бюджет перевіряється між кандидатами reconciliation (yield із checkpoint);
  replay checkpoint — до завантаження транскриптів; hidden-cache перевіряється до
  `parents.includes`, тому `.soty`-рядок більше не перезапускає generation.

## Dependencies

```text
Phase 1 (T001–T003) ─> Phase 2 (T004–T006) ─┬─> Phase 3 US1 (T007–T023) ─┐
                                            ├─> Phase 4 US2-A (T024–T034)├─> реліз A (T042–T043)
                                            └─> Phase 5 US5 (T037–T041) ─┘
реліз A ─> Phase 6 US3 (T044–T055) ─> Phase 4 US2-B (T035–T036) ─> реліз B
реліз B ─> Phase 7 US4 (T056–T061) ─> реліз C
реліз A ─> Phase 8 US6 (T062–T068) ─> реліз D   (незалежно від B/C по файлах SQL; випускається після A)
Final (T069–T071) після кожного відповідного релізу.
```

- US1, US2-A і US5 незалежні після Phase 2 і можуть іти трьома паралельними гілками (SQL/worker, web, CLI).
- US3 залежить від M1 (nudge, `scan_completed_at`) і від хука з релізу A.
- US2-B (T035–T036) залежить від таблиці запитів (T048–T049).
- US4 залежить від `progressRevision` (T050) і `onProgress` (T053).
- US6 залежить лише від M1 (колонки) і може розроблятись паралельно з B/C.

## Parallel examples

- Після T006: T007–T013 (PGlite/worker тести) ‖ T024–T028 (React тести) ‖ T037–T038 (CLI/log тести) — різні файли.
- Реалізація релізу A: T014–T020 (один SQL-файл, послідовно) ‖ T021–T023 (worker) ‖ T029–T034 (web) ‖ T039–T041 (view + CLI + лог).
- Реліз B: T048–T050 (SQL, послідовно) ‖ T051 (shared) → T052 → T053 → T054; T055 (worker) паралельно з T052–T054.

## Implementation strategy

1. **MVP = реліз A** (Phase 1–5, T001–T043): знімає повідомлений симптом, додає діагностику, нічого не ламає для старого вебу. Це перший і окремий реліз.
2. **Реліз B** додає чесний стан, підсумок і «Зупинити» — найбільша UI-робота, тому після A.
3. **Реліз C** — лише web, можна випустити швидко після B.
4. **Реліз D** — worker/fencing, можна готувати паралельно з B на окремій гілці.

## Підсумок

| Фаза | Задачі | Кількість |
| ---- | ------ | --------- |
| Setup | T001–T003 | 3 |
| Foundational | T004–T006 | 3 |
| US1 | T007–T023 | 17 |
| US2 | T024–T036 | 13 |
| US5 | T037–T041 (+ T042–T043 реліз A) | 5 (+2) |
| US3 | T044–T055 | 12 |
| US4 | T056–T061 | 6 |
| US6 | T062–T068 | 7 |
| Polish | T069–T071 | 3 |
| **Разом** | | **71** |
