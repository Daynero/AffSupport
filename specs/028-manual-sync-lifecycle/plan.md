# Implementation Plan: Надійний життєвий цикл ручної синхронізації Drive-папки

**Feature**: `028-manual-sync-lifecycle` | **Git branch**: робота від `c4ee7eb5` (Soty 1.2.5); поточна гілка `fix/drive-unverified-pilot`, окрема гілка цим викликом не створюється
**Spec**: [spec.md](spec.md) | **Date**: 2026-10-07
**Джерело фактів**: [docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md](../../docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md), розділи «Незалежний аудит» і «Крок 0»

## Summary

Ручна синхронізація папки зависає, бо завершене сканування чекає на фонову
incremental-роботу (canonical), яка або впала назавжди (ярлик Drive, 400, 403 за
ліміт), або мовчки стоїть у `retry`, і ніхто не добиває сиріт. Браузер зверху
додає свої зависання (немає deadline на прийняття, abort не доходить до HTTP,
superseded strict read дає фальшиве «не вдалося»). План: чотири незалежні
релізи, перший з яких (реліз A, «Крок 0») закриває обидва серверні механізми й
три клієнтські дефекти однією additive-міграцією, патчем worker-а і патчем хука,
і вже сам знімає повідомлений симптом. Далі: єдиний контракт станів із cancel
і довговічними лічильниками (B), доставка без Realtime і діагностика (C),
огородження replay-записів і облік без поступу в worker-і (D).

## Delivery order

| Реліз | User stories | Що входить | Залежить від |
| ----- | ------------ | ---------- | ------------ |
| **A — Крок 0** | US1; US2 (FR-011…016, FR-018, FR-033); US5 (FR-031 лог worker-а, FR-029/030 view + CLI) | Міграція M1 (сироти, nudge retry, облік lease, sweeper, data-fix), патч `_shared/drive.ts`, патч `index.ts` (лог), патч `useFolderResync.ts` + `ExplorerProvider.tsx`, міграція M2 (діагностичний view + grant), команда CLI `sync` | нічого |
| **B — Стан і cancel** | US3; US2 (T035–T036: request key, реєстр операцій); FR-007, FR-013, FR-032 | Міграція M3 (`catalog_sync_requests`, `cancel_requested_*`, лічильники на job, лічильники), web-локальний модуль `apps/web/src/team/syncStatus.ts` (новий `FolderSyncState` і парсер; `packages/shared` не чіпається), UI статусу/підсумку/«Зупинити», реєстр операцій поза lifecycle сторінки | A |
| **C — Доставка** | US4; FR-026…028 | `progress_revision` у status RPC, debounced invalidation під час монітора, membership/catalog split у `TeamContext`, вік health-snapshot | A, B (revision поле) |
| **D — Worker** | US6; FR-005 (повна версія), FR-008, FR-009 | Міграція M4 (огороджені wrappers для replay RPC), бюджет до/після кожного provider call, checkpoint усередині replay-сторінки, облік `no_progress_runs` для generation restart | A |

Реліз A виходить окремо і першим. Він додає лише нові `error_code`, новий view і
нові колонки з default; старий web трактує нові коди як звичайний `failed`, а
`blocked`-сироти бачить як `running`, поки sweeper не переведе їх у terminal.

## Technical Context

- **Мова/рантайм**: TypeScript strict / ESM NodeNext; React 19 + Vite (web); Deno edge function `catalog-sync`; Postgres 15 (Supabase) з pg_cron і pg_net; `tsx` для analytics CLI.
- **Сервер**: forward-only міграції `YYYYMMDDHHMMSS_<slug>.sql` поверх `20261006120000_manual_root_resync_status.sql`; усі функції `security definer`, `set search_path = ''`, fully-qualified. Остання версія claim — `20260924160000`, complete/retry — `20260924100000` (+ epoch-wrapper `20260924110000`), request folder — `20260924140000`, request root і 3-value status — `20261006120000`, retention cron — `20260924170000` (`*/5 * * * *`), worker cron — `20260921180000` (30 с).
- **Worker**: `supabase/functions/catalog-sync/index.ts` → `engine.ts`; Drive-клієнт `supabase/functions/_shared/drive.ts` (`#request` мапить статуси), помилки `_shared/errors.ts`. Бюджет 8 с (`CATALOG_SYNC_BUDGET_MS`), lease 180 с, один job за виклик, 3 глобальні lease, 1 на connection.
- **Web**: `apps/web/src/team/explorer/useFolderResync.ts` (164 рядки; pending key зараз у sessionStorage, який не ділиться між вкладками — переходить у localStorage), `ExplorerShell.tsx` (кнопка під `permissions.upload`, тоді як RPC дозволяє лише owner/admin — вирівнюється за роллю; `scopeFolderIds` без `__root__` для нащадків — додається; `onOutcome`), `ExplorerProvider.tsx` (`read`/`refreshStrict`, `readSequence`), `useFolderPage.ts` (`generation`, 12 с на сторінку), `apps/web/src/api/team.ts` (`resyncFolder` → `request_team_folder_resync`, `resyncDrive` → `request_team_catalog_resync`, `getFolderResyncStatus` → `get_team_folder_resync_status`, `getFolderSyncStatus` → `get_team_folder_sync_status`), `lib/supabase.ts` (`withFreshSession`), `team/useTeamRealtime.ts`, `team/TeamContext.tsx` (`handleRealtimeRefetch`), `storage/useStorageHealth.ts`. supabase-js `^2.110.7` підтримує `.abortSignal()` на rpc-builder.
- **Shared**: `packages/shared/src/team/transport.ts` містить чинний `FolderSyncStatus`/`parseFolderSyncStatus`, і ця фіча його **не змінює**: будь-яка зміна shared робить web-only deploy неможливим (принцип II). Розширений контракт статусу живе у web-локальному `apps/web/src/team/syncStatus.ts`; агент цих типів не споживає.
- **Діагностика**: `scripts/analytics/{index,queries,db,format,types}.ts`; роль `wishly_analytics_ro` має SELECT лише на `analytics_events`, `analytics_users`, `analytics_team_workspace`; три шари read-only (роль, `default_transaction_read_only`, `assertReadOnlySql`).
- **Тести**: Vitest у `tests/` (PGlite: `catalog-sync-ownership.test.ts`, `catalog-sync-scheduler.test.ts`, `catalog-sync-scope-join.test.ts`, `team-sync-claim-sql.test.ts`; React: `team-folder-resync.test.tsx`, `team-explorer-folder-upload.test.tsx`); pgTAP у `supabase/tests/database/`. Машина слабка: `uptime` перед запуском, vitest `--pool=forks --poolOptions.forks.singleFork=true`, `npm run verify` лише в CI або раннері релізу.
- **Масштаб**: 50 000 файлів / 10 100 папок / глибина 20 (успадковано з 026); декілька просторів із одночасними ручними запитами.
- **Обмеження**: нічого не скидати на беті (`db reset` заборонено); секрети не писати; дані простору під час міграції зберігаються; права owner/admin не змінюються.

## Constitution Check

| Principle | Рішення | Gate |
| --------- | ------- | ---- |
| I. Contracts | Нові стани — literal unions у `apps/web/src/team/syncStatus.ts` з boundary-парсером (`unknown` → narrow); `error_code` — closed set; worker не кастить payload RPC. | PASS |
| II. Release | Жодних змін `release.ts`/протоколу агента. Реліз A — backend-apply + web deploy за чинним runbook; усі чотири релізи не чіпають `apps/agent` і `packages/shared` (контракт статусу — web-локальний), тож кожен web deploy лишається web-only після відповідного backend-apply. | PASS |
| III. Least privilege | Усі нові функції `security definer`, `search_path = ''`; cancel і status RPC перевіряють membership/role; діагностичний view — whitelist колонок без cursor/token/назв, `grant select` лише `wishly_analytics_ro`; CLI лишається read-only усіма трьома шарами. | PASS |
| IV. Resources | Worker: бюджет до/після кожного provider call, bounded concurrency (наявні 6/4), checkpoint у replay; sweeper обмежений `limit`. | PASS |
| V. API | RPC повертають стабільні machine codes (`CANONICAL_FAILED`, `REPLAY_TIMEOUT`, `NO_PROGRESS`, `PAGE_TOKEN_REJECTED`); envelope CLI `{ ok, command, generated_at, period, data }` не змінюється, лише нова команда. | PASS |
| VI. State/transport | Без нового постійного polling: монітор після кліку вже дозволений як bounded request-status check; доставка без Realtime — debounced invalidation з цього ж монітора, не окремий таймер. Один власник reconnect (`useTeamRealtime`) не дублюється. UI — з інвентарю `components/ui` і токенів. | PASS |
| Migrations | Кожна міграція має запис у `supabase/migrations/ROLLBACK.md`, pgTAP-тест у `supabase/tests/database/` і PGlite-тест у `tests/`; `npm run types:supabase` після M2, M3 і M4 (кожна змінює public-поверхню). | PASS |

Повторна перевірка після Phase 1: порушень немає; Complexity Tracking порожній.

## Project Structure

### Documentation (this feature)

```text
specs/028-manual-sync-lifecycle/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── sync-lifecycle-sql.md      # міграції M1–M4, RPC, стани, коди помилок, sweeper
│   ├── web-status-contract.md     # FolderSyncStatus, outcomes хука, таймаути, тексти
│   └── diagnostics-cli.md         # view, команда CLI, envelope, редагування
├── checklists/requirements.md
└── tasks.md                       # /speckit-tasks
```

### Source Code (repository root)

```text
supabase/migrations/
├── 20261008100000_sync_orphan_recovery.sql        # M1 (реліз A)
├── 20261008110000_sync_diagnostics_view.sql       # M2 (реліз A)
├── 20261015100000_sync_requests_and_cancel.sql    # M3 (реліз B)
└── 20261022100000_sync_replay_fencing.sql         # M4 (реліз D)
supabase/migrations/ROLLBACK.md
supabase/tests/database/
├── sync-orphan-recovery.test.sql
├── sync-diagnostics-view.test.sql
├── sync-requests-cancel.test.sql
└── sync-replay-fencing.test.sql
supabase/functions/catalog-sync/{index.ts,engine.ts}
supabase/functions/_shared/{drive.ts,errors.ts}
apps/web/src/team/syncStatus.ts                                # реліз B: FolderSyncState/Status + парсер (замість shared)
apps/web/src/team/explorer/syncOperations.ts                   # реліз B: реєстр моніторів поза сторінкою
apps/web/src/api/team.ts
apps/web/src/lib/supabase.ts
apps/web/src/team/explorer/{useFolderResync.ts,ExplorerProvider.tsx,ExplorerShell.tsx,useFolderPage.ts}
apps/web/src/team/{useTeamRealtime.ts,TeamContext.tsx}
apps/web/src/team/storage/{useStorageHealth.ts,StorageChip.tsx}
apps/web/src/team/explorer/SyncStatusPanel.tsx                 # реліз B, з інвентарю ui/
apps/web/src/i18n.ts                                           # нові ключі
scripts/analytics/{index.ts,queries.ts,types.ts,format.ts}
tests/
├── catalog-sync-ownership.test.ts        # + orphan/retry-nudge/lease-attempts
├── catalog-sync-scheduler.test.ts        # + sweeper, gate ignores replay_after
├── catalog-sync-cancel.test.ts           # реліз B
├── catalog-sync-replay-fencing.test.ts   # реліз D
├── catalog-sync-drive-errors.test.ts     # реліз A: мапа помилок Drive, ярлик
├── catalog-sync-worker-log.test.ts       # реліз A
├── catalog-sync-worker-budget.test.ts    # реліз D
├── team-folder-resync.test.tsx           # + deadlines, lock release, disconnected, localStorage між вкладками
├── team-explorer-refresh.test.tsx        # реліз A: superseded strict read
├── team-sync-status-panel.test.tsx       # реліз B
└── analytics-sync-command.test.ts        # реліз A
```

**Structure Decision**: усе лягає в наявні сідлини; нових пакетів і сервісів
немає. Єдиний новий файл UI — панель статусу в релізі B, зібрана з `components/ui`.

## Phase 0 — Research

Усі відкриті технічні питання вирішені в [research.md](research.md) (R1–R16).
Маркерів NEEDS CLARIFICATION у Technical Context немає.

## Phase 1 — Design

- [data-model.md](data-model.md): зміни `catalog_sync_jobs`, `catalog_sync_authority`, нова `catalog_sync_requests`, лічильники, переходи станів, проєкції.
- [contracts/](contracts/): SQL-контракт (M1–M4), web-контракт статусу, контракт діагностики.
- [quickstart.md](quickstart.md): як довести кожен реліз на беті й тестами, із цифрами з SC-001…SC-011.

## Rollout and rollback

- **A**: `release:backend-apply` (M1, M2, функція `catalog-sync`) → web deploy. Відкат M1: forward fix бажаний; аварійно — відновити `service_retry_catalog_sync_job`, `service_complete_catalog_sync_job`, `claim_catalog_sync_jobs`, `invoke_catalog_sync_worker` із попередніх файлів, cron-sweeper `unschedule`, нові колонки лишити. Відкат M2: `drop view`, `revoke`. Дані не втрачаються, cursor provenance не чіпається.
- **B**: M3 додає таблицю й колонки з default. Нові стани віддає лише детальний `get_team_folder_sync_status`, який робочий UI 1.2.5 не викликає (R8), тож старий web нічого нового не бачить; 3-value RPC не змінюється.
- **C/D**: лише функції й worker; відкат — відновлення попередніх визначень.
- Спостереження після кожного релізу: кількість jobs з `replay_after` старших за 10 хв, `error_code` розподіл за добу, `lease_lost`/`no_progress` у логах worker-а, p95 request→claim, частка `disconnected` outcome у web-аналітиці.

## Complexity Tracking

Порожньо: порушень конституції немає.
