# Quickstart: перевірка надійного життєвого циклу синхронізації

Сценарії доказу для кожного релізу. Не змінює production. Цифри — з SC-001…SC-011 у [spec.md](spec.md).

## Передумови

- `uptime` показує load < 6; жоден інший vitest/tsc/build не запущений (`pgrep -fl "vitest|tsc|vite"`).
- `packages/shared` ця фіча не змінює; якщо `dist` застарів через інші гілки — `npm run build -w @video-compressor/shared`.
- Бета піднята (`colima start` → `npm run beta:down` → `npm run beta:up` після ребуту); два beta-акаунти: owner і member; тестовий Drive із папкою, де є: 3 звичайні файли, 1 ярлик, 1 вкладена папка без доступу, 1 порожня папка.
- `npm run beta:reset` і будь-який `db reset` на беті **заборонені**: дані простору не відновлюються.

## 1. Автоматизовані перевірки (локально, по одному файлу)

```bash
V="npx vitest run --pool=forks --poolOptions.forks.singleFork=true"
# реліз A
$V tests/catalog-sync-ownership.test.ts       # canonical failed → waiters CANONICAL_FAILED; retry nudge; recovery_count
$V tests/catalog-sync-scheduler.test.ts       # sweeper; gate ignores replay_after; lease reclaim counts attempts
$V tests/team-sync-claim-sql.test.ts
$V tests/team-folder-resync.test.tsx          # accept 20 s; status 15 s; lock release; disconnected; superseded strict read
$V tests/analytics-sync-command.test.ts
$V tests/catalog-sync-worker-log.test.ts
$V tests/catalog-sync-drive-errors.test.ts
$V tests/team-explorer-refresh.test.tsx
$V tests/team-explorer-folder-upload.test.tsx     # кнопка лише owner/admin; root sync видна в нащадку
# реліз B
$V tests/catalog-sync-cancel.test.ts
$V tests/catalog-sync-scope-join.test.ts         # join не приєднує до завершеного waiter-а
$V tests/team-sync-status-panel.test.tsx
$V tests/team-sync-status.test.ts                # web-локальний парсер статусу
# реліз D
$V tests/catalog-sync-replay-fencing.test.ts
npx supabase test db --local tests/database/sync-orphan-recovery.test.sql
npx supabase test db --local tests/database/sync-diagnostics-view.test.sql
```

`npm run verify` і `npm run verify:release` — лише в CI або раннері релізу. Перед релізом A `team-batch-queue.test.tsx` має бути зеленим або карантинованим, інакше verify червоний незалежно від цієї фічі.

## 2. Реліз A на беті (US1, US2-мінімум, US5-лог)

1. **SC-001**: owner запускає синхронізацію папки 20 разів поспіль (чекаючи кінця кожної) і простору 5 разів; member нічого не робить. Очікування: кожен запуск → `succeeded`; member бачить результат; жодного `running` без кінця. Фіксувати `request→succeeded` час кожного запуску.
2. **SC-003a, canonical failed**: через SQL-editor беті (не прод) перевести incremental job connection у `failed` з `last_error_code = 'PERMISSION_DENIED'`; owner синхронізує папку. Очікування: ≤ 10 хв після завершення обходу job → `failed/CANONICAL_FAILED`, `error_detail = PERMISSION_DENIED`; у веб-тості — причина й дія. Повернути canonical: ще один клік створює новий canonical (або sweeper за ≤ 5 хв).
3. **SC-003b, canonical у retry**: перевести incremental у `retry` з `next_attempt_at = now + 14 min`; owner синхронізує папку. Очікування: результат за час здорового запуску + ≤ 1 хв (nudge), а не через 14 хв.
4. **SC-004**: папка з ярликом, папка без доступу, штучний 403 `rateLimitExceeded` і штучний 400 `pageToken` (через fake Drive у `tests/`, на беті — лише ярлик і без доступу). Очікування: job завершується, `items_unavailable` ≥ 1, canonical живий, connection не `failed`.
5. **SC-005**: у Chrome DevTools заблокувати `request_team_folder_resync` → клік. Очікування: ≤ 15 с тост «не вдалося зв'язатися» (SC-005 допускає 20), кнопка активна, повторний клік не створює другого job (перевірити view: один job для scope). Те саме для `get_team_folder_resync_status` → тост «зв'язок втрачено», кнопка активна, після зняття блокування клік продовжує монітор того ж job.
6. **SC-006**: 20 здорових запусків з увімкненим Realtime — нуль тостів «не вдалося» після `succeeded`. 20 переходів A → B → A і між просторами під час роботи — нуль чужих тостів/рядків (перевіряти консоль на `status` запити старого scope після переходу). Додатково: друга вкладка тієї ж папки показує ту саму роботу без нового запиту; member не бачить кнопки; синхронізація простору видна всередині дочірньої папки.
7. **SC-009**: `npm run analytics -- sync <owner-email> --json` ≤ 10 с, усі колонки з [contracts/diagnostics-cli.md](contracts/diagnostics-cli.md), `grep -ci "cursor\|token"` по виводу = 0.
8. **SC-011**: до apply M1 на беті штучно створити waiter без canonical і `leased` з простроченим lease; після apply — waiter має canonical, leased → pending з `attempts + 1`, кількість рядків каталогу не змінилась.

## 3. Реліз B на беті (US3)

1. **SC-008**: тестова папка зі змінами: +2 файли, 1 перейменований, 1 видалений, 1 без доступу. Після синхронізації підсумок: «додано 2, оновлено 1, прибрано 1; частково: 1 недоступний». 10 із 10 прогонів збігаються.
2. **Cancel у 4 станах**: `queued` (заблокувати worker), `running`, `retry_wait` (штучний 503), `blocked` (canonical failed). Очікування: рівно один кінцевий стан `canceled`, закомічені файли лишились, `cancel` одночасно з `complete` → один стан.
3. **Спільна робота**: owner і admin натискають ту саму папку; admin тисне «Зупинити». Очікування: запит admin `detached`, owner бачить, що робота триває, підказка про спільну роботу показана.
4. **Доступність**: панель статусу проходить клавіатурну навігацію; `aria-live` озвучує зміну стану, не файли; перевірити `/design` у dev-білді, що компоненти з інвентарю.

## 4. Реліз C на беті (US4)

1. **SC-007**: member із вимкненим Realtime (заблокувати websocket у DevTools); owner синхронізує папку з 50+ файлами. Очікування: member бачить проміжні файли ≤ 30 с після запису і кінцевий результат ≤ 30 с після завершення; у консолі не більше одного list-read на 5 с.
2. Вкладка member у фоні → повернення: надолуження без дублів. Заблокувати `listTeams` → нові файли все одно з'являються.
3. Заблокувати health RPC → чип сховища показує «застаріло N хв».

## 5. Реліз D (US6) — лише автоматизовано

- Fake worker, що падає на тій самій сторінці: ≤ 10 спроб → `failed/NO_PROGRESS` (**SC-010**).
- Lease loss посеред replay-сторінки з паралельним свіжим записом: старий worker отримує `LEASE_LOST`, свіжий запис не перезаписаний, Drive trash не викликаний (fake Drive рахує виклики).
- Папка з активним `.soty`-рядком: немає нескінченного restart, `no_progress_runs` спрацьовує.

## 6. Реліз і спостереження

- Реліз A: гілка від `beta-dev`, `release:backend-apply` (M1, M2, `catalog-sync`), packaged beta на точний SHA, web deploy за runbook. Після деплою 24 год дивитись через `analytics -- sync`: немає waiters старших за 10 хв без `blocked`-причини; розподіл `last_error_code`; `lease_lost` у логах worker-а.
- Відкат — за [contracts/sync-lifecycle-sql.md](contracts/sync-lifecycle-sql.md) і `ROLLBACK.md`; cursor provenance не чіпати.

## Evidence, реліз A

### Локально, 2026-10-07 (гілка `028-manual-sync-lifecycle`)

| Перевірка | Результат |
| --------- | --------- |
| `tests/catalog-sync-lifecycle.test.ts` (16) | зелено: сироти, nudge з retry, облік lease, sweep, data-fix на старій схемі, lookup, root у детальному статусі |
| `tests/catalog-sync-drive-errors.test.ts` (7) | зелено: rate-limit 403, page token 400, ярлик |
| `tests/team-folder-resync.test.tsx` (21) | зелено: 9 успадкованих сценаріїв + deadline/abort/unreachable/disconnected/stalled/localStorage/root-scope |
| `tests/team-explorer-refresh.test.tsx` (3) | зелено: superseded strict read у дереві та в сторінці |
| `tests/team-explorer-folder-upload.test.tsx` (14) | зелено, включно з гейтом за роллю і root-scan у дочірній папці |
| `tests/analytics-sync-command.test.ts` (5), `tests/catalog-sync-worker-log.test.ts` (4) | зелено, без секретів у виводі |
| Регресія: ownership, scheduler, scope-join, claim-sql, completeness, backfill, manual-resync, engine | зелено (61) |
| `tsc -b apps/web`, `tsc -p tsconfig.scripts.json` | без помилок |
| pgTAP `sync-orphan-recovery`, `sync-diagnostics-view` | написані; виконуються database gate у CI/беті (локального Supabase немає) |

### На беті (локальний стек, 2026-10-07, усі чотири міграції через `supabase migration up --local`)

Chrome-розширення не відповідало; прогін через Playwright-драйвер (`scratchpad/beta-driver.mjs`,
логін seeded-акаунтом через GoTrue). Drive у беті не підключений, тому підключення й три папки
засіяні в БД напряму; worker-ові сценарії з реальним Drive лишаються на production-беті.

| Сценарій | Результат |
| -------- | --------- |
| M1–M4 на справжньому Postgres | застосувались без помилок; cron `wishly-catalog-sync-retention` перепланований на `run_catalog_sync_maintenance` |
| «Sync now» у просторі | запит + job `initial` у черзі; панель «Queued · whole space · Stop · Details» |
| Друга вкладка того ж браузера | бачить ту саму роботу; у БД один рядок запиту |
| «Stop» | job `canceled / CANCELED_BY_USER`, запит `canceled`, тост «Sync stopped»; панель одразу «Stopped» (дефект знайдено й виправлено під час прогону) |
| «Sync this folder» у Docs → вхід у Doctors | панель лишається, кнопка «Syncing…» заблокована; назва scope — папка job-а (дефект знайдено й виправлено) |
| Фоновий job убитий у БД | ≤ 1 опитування → «Blocked · The change feed for this storage has stopped. Sync again…»; «Sync again» створює новий запит |
| Сирота без canonical | sweeper за 5 хв створив новий canonical сам (ще до увімкнення worker-а) |
| Edge runtime | був зупинений 21 годину (preview-warm isolates), піднятий `docker start`. Після цього справжній worker претендував на jobs (`claimed=1`), fake-credential → `NEEDS_REAUTH`; canonical впав, його waiter одразу отримав `CANONICAL_FAILED / NEEDS_REAUTH`; лог `catalog_sync_job_result` містить teamId/connectionId/workerId/leaseEpoch; панель показує «Failed · Google Drive asks the owner to reconnect…». Засіяні connection/jobs/materials видалено після прогону |
| 500 на завантаженні сторінки | три відповіді 500 на першому завантаженні простору — не з цієї фічі, зафіксувати окремо |

### У production

Не виконано в цій сесії: backend-apply, packaged beta, web deploy, знімок інциденту (T042) — зовнішні дії релізного раннера.

## Після релізу D

- Наступним релізом прибрати старі unfenced сигнатури replay-RPC (`service_upsert_catalog_page(uuid,text,jsonb)`,
  `service_tombstone_catalog_files(uuid,jsonb)`, `service_invalidate_landing_renders(uuid,text[])`,
  `service_mark_folder_indexed(uuid,text)`, `service_mark_root_state(uuid,text,text)`,
  `service_touch_catalog_reconciled(uuid)`, `service_enqueue_catalog_reconciliation(uuid)`) після того, як
  жоден worker старої версії не лишився; до того вони потрібні лише rollback-у.
- 24-годинні метрики після кожного релізу (через `analytics -- sync` і журнал worker-а):
  waiters старші за 10 хв без `blocked`-причини; розподіл `last_error_code`; `lease_lost`/`NO_PROGRESS`
  у логах; p95 request→claim; частка outcome `disconnected`/`unreachable` у web-аналітиці.
- `ACTIVE` функція та HTTP 200 без корисного поступу успіхом не вважаються.
