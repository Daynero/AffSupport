# Research: Надійний життєвий цикл ручної синхронізації Drive-папки

Факти про поточний код взяті з [docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md](../../docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md) і перевірені окремо 2026-10-07. Кожен пункт — рішення, обґрунтування, відкинуті альтернативи.

## R1. Що робити з waiters, коли canonical стає `failed`

**Decision**: у `service_retry_catalog_sync_job`, коли incremental job стає terminal:
- неповторювана помилка (`NEEDS_REAUTH`, `PERMISSION_DENIED`, `UNSUPPORTED_MEDIA` до виправлення R5, `RETRY_EXHAUSTED`) → усі jobs connection із `replay_after is not null and state = 'pending'` → `failed`, `last_error_code = 'CANONICAL_FAILED'`, `error_detail = <код canonical>`; `initial_sync_state = 'failed'` як і зараз;
- повторювана помилка, що вичерпала 10 спроб (`DRIVE_UNAVAILABLE`, `RATE_LIMITED`) → не чіпати waiters, одразу вставити новий incremental job із `catalog_sync_authority.confirmed_cursor` (той самий insert, що в тригері `ensure_catalog_sync_authority`), з `next_attempt_at = now + 5 min`; у `catalog_sync_authority` інкрементувати `recovery_count` і записати `last_recovery_at`; якщо `recovery_count` за останню добу ≥ 6 → поводитись як неповторювана.

**Rationale**: reauth і втрата прав потребують дії власника — маскувати їх нескінченним retry не можна (вимога документа-джерела). Тимчасова недоступність Drive не має назавжди ламати простір; bounded auto-recovery із лічильником у authority дає межу.

**Alternatives**: лишати waiters `pending` і покладатись на sweeper (R4) — повільніше на 5 хв і не дає причини; переводити waiters одразу в `succeeded` без replay — брехня про актуальність.

## R2. Canonical у `retry`: чому ручний запит чекає до 15 хв

**Decision**: у finite-гілці `service_complete_catalog_sync_job` і в обох request-RPC (`request_team_folder_resync`, `request_team_catalog_resync`) замінити `... where state = 'pending'` на `where state in ('pending','retry')` при `next_attempt_at = least(next_attempt_at, clock_timestamp())`. Backoff worker-а (`catalogRetryDelayMs`) не чіпати: nudge — це явний сигнал «є людина, яка чекає».

**Rationale**: один рядок SQL закриває другий механізм симптому. Ризик — частіші спроби під час реальної недоступності Drive — обмежений тим, що nudge відбувається лише від ручної дії.

**Alternatives**: окремий «manual priority» для canonical у fairness — надлишково; клієнтський retry — не допомагає, бо проблема серверна.

## R3. Облік спроб: прострочений lease і перезапуск без поступу

**Decision** (реліз A, мінімум): у `claim_catalog_sync_jobs` при перехопленні job із `state = 'leased' and lease_expires_at < now` робити `attempts = least(attempts + 1, 1000)` і `lease_lost_count = lease_lost_count + 1` (нова колонка). При `attempts + 1 >= 10` у claim — не брати, а переводити у `failed / LEASE_LOST_EXHAUSTED`.
**Decision** (реліз D, повна версія): нова колонка `no_progress_runs`; claim порівнює `last_progress_at` із `progress_at_last_claim` (нова колонка, копіюється при claim): якщо не зросло — `no_progress_runs + 1`, інакше 0. `no_progress_runs >= 10` → `failed / NO_PROGRESS`. Скидання `attempts = 0` у `commit_catalog_scan_page`, `resolve_catalog_candidate`, `finish_catalog_folder` зберігається, бо воно означає реальний коміт; реальний «без поступу» ловить саме `no_progress_runs`, а не `attempts`.

**Rationale**: `attempts` сьогодні семантично «поспіль невдалі спроби до коміту», і це корисно; потрібен другий, незалежний лічильник для «коміти є, а робота не рухається» (reconcile-restart loop, `.soty`-рядок) і третій для втрати lease.

**Alternatives**: прибрати скидання `attempts` у комітах — зламає довгі здорові сканування з рідкими тимчасовими помилками.

## R4. Sweeper для сиріт і gate worker-а

**Decision**: нова функція `private.sweep_catalog_sync_orphans(limit int default 200)` викликається з наявного cron `wishly-catalog-sync-retention` (той самий тік, перед cleanup) — без нового cron-рядка:
1. waiter (`replay_after is not null`, `state='pending'`) без incremental job у `pending/leased/retry` на цьому connection і старший за 2 хв → вставити canonical (як у тригері) з `next_attempt_at = now`;
2. waiter старший за 60 хв від `completed_at` сканування (нова колонка `scan_completed_at`) → `failed / REPLAY_TIMEOUT`;
3. jobs connection у стані `detached` у `pending/leased/retry` → `canceled / CONNECTION_DETACHED`;
4. `leased` з `lease_expires_at < now - 15 min` і `attempts >= 10` → `failed / LEASE_LOST_EXHAUSTED` (страховка, якщо claim їх не бере).
`invoke_catalog_sync_worker`: gate додає `and j.replay_after is null`.

**Rationale**: відновлення не має залежати від іншого користувача (FR-004). 2 хв — більше за один цикл claim (30 с + 8 с + lease) і менше за будь-яке людське очікування. 60 хв — верхня межа, після якої чесніше сказати «не вдалося», ніж тримати «виконується» (SC-002 вимагає ≤10 хв без поступу; waiter формально без поступу, тому статус (R8) показує його як `blocked` з причиною вже з 10-ї хвилини, а terminal — з 60-ї).

**Alternatives**: окремий cron щохвилини — зайве навантаження; робити sweep у claim — claim і так найважча функція.

## R5. Мапа помилок Drive: ярлик, rate-limit 403, page token

**Decision** у `_shared/drive.ts#request`:
- читати тіло помилки (`error.errors[0].reason`, `error.errors[0].location`), з try/catch на невалідний JSON;
- 403 з `reason in ('rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','sharingRateLimitExceeded')` → `RATE_LIMITED` retryable;
- 400 з `location = 'pageToken'` або `reason = 'invalid'` і повідомлення містить `pageToken` → `INVALID_INPUT` з `detail: 'PAGE_TOKEN_REJECTED'` (оживляє наявну гілку в `engine.ts:612-622`, яка починає нове generation);
- інші 400 → як зараз.
У `proveLiveAncestry`: ярлик (`shortcutTargetId`) → не `throw UNSUPPORTED_MEDIA`, а повернути `{ live: false, reason: 'shortcut' }`; виклик у `isWithinRoot` трактує це як `unavailable` з причиною `shortcut`, запис обліковується в `items_unavailable` і пропускається. Для change replay — зміна з ярликом пропускається (не upsert, не tombstone).

**Rationale**: усі три зараз роблять canonical `failed` назавжди; жоден не є справжньою втратою прав.

**Alternatives**: обробляти ярлики як файли-посилання — окрема фіча (каталог не має типу «ярлик»); глобально зробити 403 retryable — приховає справжню втрату доступу.

## R6. Deadline і abort у вебі

**Decision**: `team.ts` функції `resyncFolder`, `resyncDrive`, `getFolderResyncStatus`, `getFolderSyncStatus` отримують необов'язковий `options?: { signal?: AbortSignal }` і передають його в `.abortSignal(signal)` rpc-builder-а supabase-js; `withFreshSession` приймає й прокидає signal у повтор. Хук: `ACCEPT_TIMEOUT_MS = 15_000`, `STATUS_TIMEOUT_MS = 15_000`, `FINAL_REFRESH_TIMEOUT_MS = 30_000`; кожен запит обгорнутий `AbortSignal.any([monitor.signal, AbortSignal.timeout(ms)])`. Загальний 5-хвилинний таймер замінюється на «10 хв без зміни `lastProgressAt`» з детального `get_team_folder_sync_status` → outcome `stalled` (кнопка активна, pending key лишається). Для цього включення root у детальний RPC переноситься з M3 у M1. Pending key переїжджає з sessionStorage (ізольований на вкладку, тому FR-018 не виконувався) у localStorage з ключем team/scope; префікс чиститься при logout. У `finally` `start()` — завжди `accepting.current = false`, бо `await` тепер гарантовано завершується.

**Rationale**: supabase-js `^2.110.7` підтримує `abortSignal()` на `PostgrestBuilder`; `AbortSignal.any`/`timeout` є в усіх цільових браузерах (Chromium-based desktop). Усуває F2 повністю без переписування хука.

**Alternatives**: `Promise.race` з таймером без abort — запит висить далі і тримає сокет; глобальний fetch-timeout у клієнті Supabase — зачепить довгі upload/listing запити.

## R7. Втрата відповіді на accept і «disconnected»

**Decision**: після таймауту accept хук пише `pendingKey → 'unknown'`; наступний клік спершу викликає `get_team_folder_sync_status`-lookup за `(team, scope_folder, requested_by, since)` — у релізі A це `find_team_folder_sync_request(team, folder)` (нова read-RPC: останній активний job цього scope за останні 30 хв) — і якщо знайдено, продовжує монітор, інакше створює запит. У релізі B lookup іде за `request_key` (R9). Перехідна помилка status-read (`AbortError`, мережа, 5xx) → outcome `disconnected`, лок звільнено, pending key лишається; `NOT_FOUND` (детальний RPC) або `INVALID_RESPONSE` → key чиститься.

**Rationale**: FR-013 забороняє дубль навмання; FR-014 вимагає окремий стан.

## R8. Контракт станів і root у детальному status RPC

**Decision**: розширити `get_team_folder_sync_status` (а не додавати v2). Включення root (прибрати `requested_folder_id is not null`, додати `or job_kind in ('initial','reconcile')`, `scopeFolderId = '__root__'` — єдине місце, де SQL знає цей sentinel, і лише як вихідне значення) робиться вже в M1, бо на ньому стоїть stall-детектор релізу A. Решта — в M3. `state` мапиться: `pending` без `replay_after` → `queued`; `leased` → `running`; `pending` з `replay_after` і живим canonical → `running` (phase `replaying_changes`); `pending` з `replay_after` і без живого canonical або з canonical у `retry` довше 10 хв → `blocked` (`blockedReason: 'canonical_failed' | 'canonical_retrying' | 'needs_reauth'`); `retry` → `retry_wait` з `nextAttemptAt`; `cancel_requested_at not null` і `leased` → `canceling`; `canceled` → `canceled`. Робочий UI 1.2.5 цей RPC не викликає, тому зміна сумісна. Типи й парсер — у web-локальному `apps/web/src/team/syncStatus.ts`: `FolderSyncState` = `'queued'|'running'|'retry_wait'|'blocked'|'canceling'|'canceled'|'succeeded'|'failed'`; парсер відкидає невідомі значення. `packages/shared/src/team/transport.ts` не змінюється: інакше web-only deploy порушив би принцип II (shared-зміна без релізу агента). 3-value RPC не змінюється.

**Rationale**: FR-019 вимагає один контракт для папки й root; розширення в місці, яке ніхто старий не читає, дешевше за v2.

## R9. Запити, ідемпотентність і cancel

**Decision** (реліз B): таблиця `private.catalog_sync_requests` (`id`, `team_id`, `connection_id`, `job_id`, `requested_by`, `scope_folder_id`, `request_key text unique`, `created_at`, `detached_at`, `outcome`). `request_key` = `sha256(team|connection|scope|requested_by|minute-bucket)` обчислюється в SQL, клієнт передає `p_request_key` (uuid v4, згенерований перед першим викликом і збережений у localStorage поруч із pending key до відповіді, щоб друга вкладка теж могла знайти запит). Повторний виклик із тим самим ключем повертає той самий `sync_job_id`. Cancel: `cancel_team_folder_sync(p_team, p_request_id)` — owner/admin або автор запиту; якщо у job є інші недетачені запити або job — incremental → лише `detached_at`; інакше `cancel_requested_at/by` на job; `pending/retry` → одразу `canceled`; `leased` → worker побачить через `lock_catalog_sync_lease` (додається умова `cancel_requested_at is null`), отримає `lease_lost`, claim/sweeper переведе в `canceled`. Уже закомічені сторінки лишаються. Окремо: `join_catalog_subtree` перестає приєднувати запит до waiter-а (`replay_after is not null`) — така гілка вже пройдена, тому створюється один follow-up (FR-007).

**Rationale**: FR-007, FR-013, FR-023, FR-032 одним механізмом; `lock_catalog_sync_lease` уже є фенсом для всіх durable-scan RPC, тож cancel «між bounded units» дається безкоштовно.

**Alternatives**: cancel-прапорець, який worker читає окремим RPC між юнітами — ще один round-trip на юніт; видаляти job — втрата історії й діагностики.

## R10. Довговічні лічильники

**Decision**: на `catalog_sync_jobs` колонки `files_listed`, `files_added`, `files_updated`, `files_removed`, `items_unavailable`, `folders_done` (bigint default 0), інкрементуються атомарно в `commit_catalog_scan_page`, `resolve_catalog_candidate`, `finish_catalog_folder`, `upsert_catalog_page`, `tombstone_catalog_files` (повертають кількість вставлених/оновлених через `xmax = 0` розрізнення в `on conflict`). Retention їх не чіпає. `discoveredFiles` у status RPC = `files_listed`, не `count(catalog_scan_seen)`.

**Rationale**: FR-020/021; `catalog_scan_seen` видаляється retention ще під час роботи.

## R11. Доставка без Realtime під час активної ручної роботи

**Decision**: status RPC повертає `progressRevision` (= `files_added + files_updated + files_removed`); хук при зміні викликає `onProgress()`, який у `ExplorerShell` бампає `revision` через наявний `catalogFreshness.invalidate(scope)` не частіше ніж раз на 5 с. Поза активним монітором нічого нового не опитується. `TeamContext.handleRealtimeRefetch`: `setRevision` робити до `await refreshTeams(true)`, помилку membership логувати окремо; `useStorageHealth` повертає `{ health, refresh, staleSince }`, `StorageChip` показує вік понад 2 хв.

**Rationale**: конституція VI дозволяє bounded request-status checks і забороняє новий recurring polling; тут polling уже є й обмежений кліком.

## R12. Діагностика: view + команда CLI

**Decision** (реліз A): міграція M2 створює `public.analytics_catalog_sync_jobs` (view з `security_invoker = false`, власник `postgres`), колонки: `job_id, team_id, connection_id, connection_state, job_kind, phase, state, requested_folder_id_hash` (sha256 перші 12 символів), `requested_by, created_at, updated_at, completed_at, scan_completed_at, lease_expires_at, lease_epoch, attempts, lease_lost_count, no_progress_runs, run_count, next_attempt_at, replay_after, canonical_state, canonical_error_code, confirmed_sequence, last_error_code, error_detail, last_progress_at, files_*`. Без `cursor`, `folder_queue`, `confirmed_cursor`, назв. `grant select ... to wishly_analytics_ro`. CLI: `npm run analytics -- sync <team-id | owner-email> [--limit N] [--json]`; email резолвиться через наявний `analytics_users`; SQL — лише через `assertReadOnlySql`. Worker: `catalog_sync_job_result` отримує `teamId`, `connectionId`, `workerId`; `rpcValue` логує `{ rpc, code, message }` (без `parameters`).

**Rationale**: FR-029…031; роль не має доступу до `private.*`, view — єдиний штатний шлях без розширення ролі.

**Alternatives**: `grant select on private.catalog_sync_jobs` — віддасть cursor; окремий secret-driven скрипт — порушує «три шари».

## R13. Приведення вже застряглих jobs під час міграції M1

**Decision**: у M1 одноразово: (a) всі waiters без живого canonical → вставити canonical (як sweeper п.1); (b) `leased` з простроченим lease → `pending`, `attempts + 1`; (c) jobs detached connections → `canceled / CONNECTION_DETACHED`. Нічого не видаляти, `confirmed_cursor` не чіпати, `succeeded` не ставити.

**Rationale**: FR-010; sweeper зробив би (a) сам через 5 хв, але краще одразу в тому ж транзакційному apply.

## R14. Огородження replay-записів (реліз D)

**Decision**: нові overloads із `p_lease_epoch` для `upsert_catalog_page`, `tombstone_catalog_files`, `invalidate_landing_renders`, `mark_folder_indexed`, `mark_root_state`, `touch_catalog_reconciled`, `enqueue_catalog_reconciliation`, кожен починає з `perform private.lock_catalog_sync_lease(...)`; старі сигнатури лишаються на один реліз і логують `UNFENCED_RPC` (warning). Worker: перед кожним Drive trash у `invalidateLandingRenders` і перед transcript commit — `assertLease()` (виклик `lock_catalog_sync_lease` read-only). Replay-сторінка: checkpoint після ancestry-walk і до transcript ingestion; transcript ingestion виноситься в окрему bounded одиницю після checkpoint.

**Rationale**: FR-008/009; без цього cancel (R9) не захищає дані у фазі replay.

## R15. Тестова стратегія

**Decision**: PGlite-тести в `tests/` для кожної SQL-гілки (швидкі, в CI на всіх ОС), pgTAP у `supabase/tests/database/` для RLS/grants/view, React-тести хука з фейковим клієнтом і фейковими таймерами (`vi.useFakeTimers` + `AbortSignal.timeout` через `vi.setSystemTime`), один інтеграційний прогін на беті з Playwright-драйвером (див. quickstart). Шість втрачених probes переписуються як регресії з очікуванням правильної поведінки до коду (red → green). Тести web-локального парсера статусу живуть у `tests/team-sync-status.test.ts`; `tests/team-sync-contracts.test.ts` (shared) не змінюється.

## R16. Нарізка релізів

**Decision**: A (Крок 0 + діагностика) → B (стан, cancel, лічильники, requests) → C (доставка, health) → D (worker fencing/бюджети). A і D можуть іти паралельно різними гілками, бо не перетинаються по файлах SQL (A — lifecycle-функції, D — data-RPC), але D випускається після A, щоб не змішувати діагностику інциденту з новими фенсами.
