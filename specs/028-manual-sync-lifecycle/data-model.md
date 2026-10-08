# Data Model: Надійний життєвий цикл ручної синхронізації Drive-папки

Усі таблиці — у схемі `private`, недоступні браузерним ролям; клієнт отримує лише проєкції через `security definer` RPC. Нові колонки мають default і не ламають старий worker/web. Посилання на рішення — [research.md](research.md).

Терміни: у спеці «оренда» = `lease`, «фонове стеження за змінами» = canonical `incremental` job, «очікування підтвердження» = waiter (`replay_after is not null`), «покоління обходу» = `catalog_scan_generations`.

## 1. `private.catalog_sync_jobs` (зміни)

| Поле | Реліз | Зміст | Правила |
| ---- | ----- | ----- | ------- |
| `state` | — | `pending`, `leased`, `retry`, `succeeded`, `failed`, `canceled` | constraint уже містить `canceled` (20260924100000); нових значень у БД немає — `blocked`, `retry_wait`, `canceling`, `queued` існують лише в проєкції (R8) |
| `last_error_code` | — | стабільний код | нові значення: `CANONICAL_FAILED`, `REPLAY_TIMEOUT`, `LEASE_LOST_EXHAUSTED`, `NO_PROGRESS`, `CONNECTION_DETACHED`, `CANCELED_BY_USER` |
| `error_detail` | A | text | код первинної причини (наприклад, код canonical при `CANONICAL_FAILED`); без повідомлень Drive і назв |
| `scan_completed_at` | A | timestamptz | момент, коли finite scan завершив обхід і став waiter; база для `REPLAY_TIMEOUT` |
| `lease_lost_count` | A | bigint default 0 | інкремент при claim простроченого lease (R3) |
| `progress_at_last_claim` | D | timestamptz | копія `last_progress_at` на момент claim |
| `no_progress_runs` | D | integer default 0 | claim без зростання `last_progress_at` → +1; інакше 0; `>= 10` → `failed / NO_PROGRESS` |
| `cancel_requested_at`, `cancel_requested_by` | B | timestamptz, uuid | ставить `cancel_team_folder_sync`; `lock_catalog_sync_lease` відмовляє, коли не null |
| `files_listed`, `files_added`, `files_updated`, `files_removed`, `items_unavailable`, `folders_done` | B | bigint default 0 | атомарні інкременти в commit-RPC; ніколи не зменшуються (R10) |

Незмінні, але важливі: `replay_after` (waiter), `requested_folder_id` (null для root), `job_kind` (`incremental` = canonical), `attempts` (0..1000; terminal при `attempts + 1 >= 10` у retry або при claim простроченого lease), `run_count`, `lease_epoch`, `last_progress_at`.

### Переходи станів (БД)

```text
pending ──claim──────────────> leased ──checkpoint/yield──> pending
   │                              ├──retryable error──────> retry ──claim──> leased
   │                              ├──permanent / 10th────> failed
   │                              ├──finite scan done────> pending(replay_after, scan_completed_at)   [waiter]
   │                              ├──lease expired, reclaim (attempts+1, lease_lost_count+1)──> leased
   │                              └──cancel_requested_at set ──(lock refuses)──> claim/sweeper ──> canceled
   ├──cancel (pending/retry)────> canceled
   └──waiter:
        canonical confirms seq >= replay_after ────────────> succeeded
        canonical terminal non-retryable ──────────────────> failed(CANONICAL_FAILED)          [R1]
        canonical exhausted retryable ─────────────────────> (new canonical inserted; waiter stays)
        no live canonical > 2 min (sweeper) ───────────────> (canonical inserted; waiter stays)   [R4]
        scan_completed_at older than 60 min ──────────────> failed(REPLAY_TIMEOUT)             [R4]
        connection detached ───────────────────────────────> canceled(CONNECTION_DETACHED)
```

Інваріанти: не більше одного `incremental` у `pending/leased/retry` на connection (індекс `catalog_sync_one_canonical`); waiter ніколи не отримує lease (`replay_after is null` у claim); `succeeded` ставиться лише через підтвердження canonical; жоден перехід не видаляє рядки.

## 2. `private.catalog_sync_authority` (зміни, реліз A)

| Поле | Зміст | Правила |
| ---- | ----- | ------- |
| `recovery_count` | bigint default 0 | скільки разів автоматично створено новий canonical після вичерпання retryable-спроб (R1) |
| `last_recovery_at` | timestamptz | останнє таке створення; ≥ 6 за добу → наступна вичерпана спроба трактується як неповторювана |
| `confirmed_cursor`, `confirmed_sequence`, `confirmed_job_id`, `confirmed_at` | без змін | provenance не чіпається жодною новою функцією |

## 3. `private.catalog_sync_requests` (нова, реліз B)

| Поле | Зміст | Правила |
| ---- | ----- | ------- |
| `id` | uuid pk | повертається клієнту як `requestId` |
| `team_id`, `connection_id` | uuid | RLS-перевірка membership у RPC |
| `job_id` | uuid fk → jobs | робота, до якої приєднано або яку створено |
| `requested_by` | uuid | автор; лише він, owner або admin може cancel |
| `scope_folder_id` | text | `null` для root |
| `request_key` | text unique | з клієнта (uuid v4); повтор повертає той самий `job_id` (R9) |
| `created_at` | timestamptz | |
| `detached_at` | timestamptz | cancel спільної роботи від'єднує лише цей запит |
| `outcome` | text | `joined`, `created`, `followup`, `detached`, `canceled`; closed set |

Зв'язки: багато requests → один job. Діагностичний view показує requests поруч із jobs.

## 4. `private.catalog_scan_generations` (без структурних змін)

Лічильники переносяться на job (п. 1), бо generation і `catalog_scan_seen` підлягають retention раніше за завершення job. `coverage` (`complete`/`partial`/`permission_limited`) лишається джерелом для підсумку «частково».

## 5. Проєкція статусу для клієнта (`FolderSyncStatus` у `apps/web/src/team/syncStatus.ts`, реліз B; root уже з M1)

| Поле | Джерело | Примітка |
| ---- | ------- | -------- |
| `jobId`, `requestId` | jobs, requests | `requestId` null для старих запитів |
| `scopeFolderId` | `requested_folder_id` або `'__root__'` | єдине місце, де SQL віддає sentinel |
| `state` | мапа R8 | `queued` (`pending` без `replay_after`), `running` (`leased`, або waiter із живим canonical), `retry_wait`, `blocked`, `canceling`, `canceled`, `succeeded`, `failed` |
| `phase` | jobs.phase + generation state | `listing`, `reconciling`, `replaying_changes`, `done` |
| `blockedReason` | обчислюється | `canonical_failed`, `canonical_retrying`, `needs_reauth`, null |
| `errorCode`, `errorDetail` | jobs | closed set |
| `nextAttemptAt` | jobs | лише для `retry_wait` |
| `startedAt`, `lastProgressAt`, `completedAt`, `scanCompletedAt` | jobs | |
| `filesListed`, `filesAdded`, `filesUpdated`, `filesRemoved`, `itemsUnavailable`, `foldersDone`, `pendingFolders` | jobs, frontier | `pendingFolders` null, коли невідомо |
| `coverage` | generations | `complete`, `partial`, `permission_limited`, `unknown` |
| `progressRevision` | `filesAdded + filesUpdated + filesRemoved` | тригер debounced invalidation (R11) |
| `cancelable` | обчислюється | true для ручних finite jobs у `queued/running/retry_wait/blocked` |
| `sharedWith` | count(requests) − 1 | скільки інших запитів поділяють роботу |

Парсер у `apps/web/src/team/syncStatus.ts` відкидає невідомі `state`/`phase` і будь-які зайві поля; shared-парсер не змінюється.

## 6. Стан хука в браузері (реліз A)

```text
idle ──click──> accepting(≤15 s) ──accepted──> monitoring ──succeeded──> refreshing(≤30 s) ──> idle(toast success)
   │                 │                              ├──failed/canceled/blocked──> idle(toast with reason+action)
   │                 │                              ├──status read error (≤15 s each) ──> idle(outcome disconnected; pending key kept)
   │                 │                              └──no progress 10 min ──> idle(outcome stalled; pending key kept)
   │                 ├──accept timeout ──> idle(outcome unreachable; pending key = 'unknown')
   │                 └──scope changed before accept ──> idle (job stays bound to its scope)
   └──click with pending key ──> lookup(≤15 s) ──found──> monitoring ; ──none──> accepting
```

Pending key — localStorage `soty:folder-resync:<team>:<scope>` (спільний для вкладок; очищається за префіксом при logout). Локальні інваріанти: `accepting`/`active` завжди скидаються у `finally`; жоден callback не викликається, якщо `latest.current.teamId/scope` відрізняється від контексту job; абонент монітора — один на `(team, scope)` на вкладку.

## 7. Діагностичний view `public.analytics_catalog_sync_jobs` (реліз A)

Whitelist колонок у [contracts/diagnostics-cli.md](contracts/diagnostics-cli.md). Відсутні за побудовою: `cursor`, `folder_queue`, `confirmed_cursor`, `page_token`, будь-які назви файлів/папок, токени. `requested_folder_id` віддається як 12-символьний префікс sha256, достатній для зіставлення з логами, але не з Drive.
