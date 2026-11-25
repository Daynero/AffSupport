# 072 — Каталог не висить мовчки: знахідки

Зібрано координатором зі звітів агентів 25.11 (агентам заборонено створювати звітні файли).
Аудит — `audit.md`; рішення серверних пакетів — також у `plan.md`.

## П1 + П2 — сервер (6bebb3cf; міграції 20261224200000, 20261224220000)

- Одне завершення раунду: `private.close_catalog_variant_round` (спроба `failed` з кодом,
  `last_update_error`, запит і набори скасовано, каталог вільний).
- Класифікація кодів в одному місці, `private.catalog_round_failure_kind`: остаточні
  (`RESTITCH_*`, `SOURCE_CHANGED`, `PERMISSION_DENIED`, `SHARE_NOT_ALLOWED`, `NEEDS_REAUTH`,
  `ROOT_MISSING`, `DRIVE_STORAGE_FULL`, `AGENT_UPDATE_REQUIRED`) — закривають одразу; тимчасові
  (`DRIVE_UNAVAILABLE`, `RATE_LIMITED`, невизначений результат) — пауза 1→10 хв, межа 30 хв;
  чекання на комп'ютер (`AGENT_REQUIRED`, `AGENT_ID_CONFLICT`) — пауза 1→15 хв, межа 2 год.
- `RESTITCH_*` на налаштуваннях до вбудованих картинок дістає одну спробу з сьогоднішніми
  налаштуваннями; остаточний лише коли вимкнено обидва екрани або налаштування биті.
- Набір готовий, але посилання не підставити (#8) — межа 2 год.
- Черга без голодування (#2): раунди на паузі не беруться, першими — ті, що найдовше чекають.
- Передперевірка в `run_team_catalog_update_now`, `retry_team_catalog_update`,
  `request_team_catalog_update_command`: `SPACE_BLOCKED` (до дозволу) → Drive → `AGENT_REQUIRED`
  для каталогу з перезашивкою. Відмова нічого не записує.
- Cron `soty-catalog-round-limits` (5 хв): каталог у кошику / прибраний з менеджера → скасування
  (#7); Drive не працює → закриття (#5); набір 6 год без виконавця → `AGENT_REQUIRED` /
  `AGENT_STALLED`; комп'ютер повідомив про зупинку → закриття через 1 год його кодом.
- `agent_block_code` (П4) іде в `waitCode` + `backgroundStalled`, а не у `waitReason`: випущений
  веб (`catalog-video-progress.ts`) відкидає весь блок відео на незнайомому `waitReason`, а
  міграції доїжджають у прод раніше за веб.
- Не зроблено: перевірка версії виконавця при прийнятті (#12).
- Прод: завислі раунди 3f9ec287, e663ead2, 4ff10503 закриє сервер сам після викладки.

## П3 + П6 — публікація і створення каталогу (847731db; міграції 20261224210000, 20261224260000)

- `retry_team_catalog_publication` (RPC браузера, без редеплою edge): невідправлений запис →
  `retry_wait`; уже відправлений → `republish` через наявний `add_now`.
- Тригер `team_drive_connections_requeue_catalog_publications`: повернення з'єднання в `connected`
  ставить у чергу `target_unavailable` (тіло в exception-блоці). Одноразово — записи, що вже
  стоять на підключених з'єднаннях (має зачепити прод-випадок 4d7d4b2d).
- `team_catalog_creation_preflight(p_team)` (членство, не `can()`): «Створити» вимикається лише
  там, де сервер напевно відмовить; фонова робота на іншому комп'ютері — не блок.
- Спільна мапа «код → дія»: `apps/web/src/team/catalogFixActions.tsx`
  (`catalogFixActionFor`, `catalogCodeMessage`, `CatalogFixButton`).
- Нові коди в контракті: `DISK_FULL`, `AGENT_STALLED` (`TEAM_CATALOG_HANG_ERROR_CODES`).
- `AGENT_ID_CONFLICT` більше не говорить про конфлікт назв файлу.

## П4 — агент (3b275a81; міграція 20261224190000)

- Probe несе `localState` (`{stage:'blocked',reason,code}` | `{stage:'clear'}`) → колонки
  `team_recovery_delegations.agent_block_reason / agent_block_code / agent_block_at`,
  `private.record_recovery_agent_state`.
- `preupload` + `DISK_FULL`, `NEEDS_REAUTH`, `DRIVE_STORAGE_FULL` (сервер теж приймає).
- 403 `storageQuotaExceeded` / `teamDriveFileLimitExceeded` → `DRIVE_STORAGE_FULL`.
- `NEEDS_REAUTH` — пауза 15 хв, `DRIVE_STORAGE_FULL` — 1 год, замість 8 спроб на годину з
  новою перезашивкою щоразу.
- Лікування сховищ перезашивки на всіх платформах; стійкий збій не дає `APP_UPDATE_BUSY`.
  Звільнення записів: без виконання; `blocked` > 48 год; foreground > 24 год.
- ffmpeg: зупинка після 10 хв без виводу і без CPU.
- Порядок викладки бекенду: міграція раніше за edge. Потрібен реліз агента.

## Швидкість текстового оновлення (1c4cc85d; міграція 20261224250000)

- Тексти пишуться одним `batchUpdate`; час ішов на очікування хвилинного cron (claim по 3),
  ~15 послідовних звернень до Google на каталог і ~3 с службових задач перед роботою.
- `service_continue_catalog_updater()` — наступний тік одразу, якщо роботи є; незалежні
  читання Google паралельно, папки кешуються в межах запиту; службові задачі поряд з раундами.
- Бета: 9 каталогів — ~15 с замість до 97 с. Стеля квоти Sheets ≈ 12 каталогів/хв на власника.
- Відкрито: у режимі «лише тексти» пул заново розподіляє картинки; `rpcValue` ховає код помилки
  під `DRIVE_UNAVAILABLE`.
