# Implementation Plan: Каталог ніколи не висить мовчки (072)

**Spec**: [spec.md](spec.md) · **Audit**: [audit.md](audit.md) · **Tasks**: [tasks.md](tasks.md) · Знахідки — розділ «Знахідки» нижче

## Пакети й власники

| Пакет | Що                                                                                 | Де                                                                                          | Агент             |
| ----- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| П1    | Закриття раундів за кодом, пауза й межа, черга без голодування, реєстр, прибирання | `supabase/migrations/20261224200000_*`, `supabase/functions/drive-ops/updater-variants.ts`  | сервер            |
| П2    | Передперевірки запуску, межа чекання на комп'ютер, «ніхто не взявся»               | `supabase/migrations/20261224220000_*`                                                      | сервер            |
| П3    | Публікація: «Опублікувати ще раз», повернення після перепідключення Drive          | `supabase/migrations/20261224210000_*`, `product-catalog/*`                                 | веб публікації    |
| П4    | Агент: стан зупинки на сервер, preupload, Google storage, macOS-сховище            | `apps/agent`, `supabase/migrations/20261224190000_*`                                        | агент             |
| П5    | Рядок менеджера: помилка, кнопка за кодом, передперевірки в діалозі                | `apps/web/src/team/catalog-updater/*`, `packages/shared/src/team/catalog-video-progress.ts` | агент перезашивки |
| П6    | Створення каталогу і тексти кодів                                                  | `product-catalog/CreateProductCatalogDialog.tsx`, `apps/web/src/team/errors.ts`             | веб створення     |

## Сервер (П1 + П2)

### Класифікація (одне місце)

`private.catalog_round_failure_kind(code)`:

- `passing` — `DRIVE_UNAVAILABLE`, `RATE_LIMITED`, `PROCESS_RESULT_UNCERTAIN`, `INVALID_RESPONSE`, `RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN`;
- `agent` — `AGENT_REQUIRED`, `AGENT_ID_CONFLICT`;
- `final` — усе інше (`RESTITCH_*`, `SOURCE_CHANGED`, `PERMISSION_DENIED`, `SPACE_BLOCKED`, `SHARE_NOT_ALLOWED`, `NEEDS_REAUTH`, `ROOT_MISSING`, `DRIVE_STORAGE_FULL`, `AGENT_UPDATE_REQUIRED`, …).

`PERMISSION_DENIED` у просторі на паузі перетворюється на `SPACE_BLOCKED` (у паузі `can()` = false для всіх).

### Точки входу

| Хто                                                                                               | Що викликає                                      | Межі                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| drive-ops, catch прийняття                                                                        | `service_fail_catalog_updater_variant_admission` | final — одразу; passing — пауза 1→10 хв, межа 30 хв від першого збою; `RESTITCH_*` на старих налаштуваннях — одна спроба з ефективними                                                                                             |
| drive-ops, catch посилань готового набору                                                         | `service_fail_catalog_updater_variant_target`    | final — одразу; passing — пауза ≤30 хв, межа 2 год                                                                                                                                                                                 |
| adopt / `service_note_catalog_variant_round_failure`                                              | `note_catalog_variant_round_wait`                | final — одразу; agent — пауза 1→15 хв, межа 2 год; passing — межа 30 хв (від старту раунду)                                                                                                                                        |
| cron `soty-catalog-round-limits` (*/5)                                                            | `settle_catalog_round_limits`                    | (1) каталог у кошику / поза менеджером → cancel; (2) Drive непридатний → NEEDS_REAUTH/ROOT_MISSING/DRIVE_UNAVAILABLE; (3) набір ніхто не взяв 6 год → AGENT_REQUIRED/AGENT_STALLED, комп'ютер сказав «зупинився» ≥1 год → його код |
| `run_team_catalog_update_now`, `retry_team_catalog_update`, `request_team_catalog_update_command` | `catalog_run_preflight`                          | SPACE_BLOCKED (перед перевіркою дозволу), NEEDS_REAUTH/ROOT_MISSING/DRIVE_UNAVAILABLE, AGENT_REQUIRED для перезашивки                                                                                                              |

Завершення — `private.close_catalog_variant_round(attempt, code)`: блокує запит, потім attempt (порядок `cancel_catalog_updater_variant_round`), скасовує запит і набори, attempt `failed` з кодом, `last_update_error`, звільняє item, `sync_catalog_updater`, подія `sync_state`. Повертає `{outcome:'blocked', failureCode, requestId, closed:true}` — форма, яку drive-ops уже читає як «blocked».

### Черга

`service_list_catalog_variant_rounds` і `service_list_catalog_updater_variant_targets` пропускають запит з `retry_at` у майбутньому і сортують за часом, коли робота стала належною (`next_attempt_at` / `retry_at`), а не за `created_at`.

### Реєстр (`private.catalog_registry_video_generation`)

- запит у паузі → `waitReason` з відомого вебу списку (`AGENT_REQUIRED`, `AGENT_ID_CONFLICT`, `PERMISSION_DENIED`, `SOURCE_CHANGED`, `RESTITCH_INVALID`, інакше `PROCESS_RESULT_UNCERTAIN`) + сирий код у `waitCode`;
- делегування з `agent_block_code` (П4) → `backgroundStalled: true` + `waitCode` = код комп'ютера.

### Сумісність

Міграції потрапляють у прод-базу раніше за веб кандидата, тож випущений веб читає ті самі відповіді:

- нові відмови запуску — коди, які знає кожен випущений веб (`SPACE_BLOCKED`, `NEEDS_REAUTH`, `ROOT_MISSING`, `DRIVE_UNAVAILABLE`, `AGENT_REQUIRED`);
- `waitReason` лише з відомого списку (старий парсер відкидає весь `videoGeneration` на незнайомому);
- квитанція команди без нових `reason` (старий парсер її відкинув би);
- drive-ops без нової міграції падає назад на стару діагностичну нотатку.

## Веб (П5/П6) — що взяти з сервера

Коди й рекомендована дія — розділ «Коди й дії» нижче.

## Коди й дії

Що сервер (П1/П2) повертає — відмовою запуску (`run_team_catalog_update_now`, `retry_team_catalog_update`, `request_team_catalog_update_command`) або кодом завершеного раунду (`team_catalog_update_attempts.failure_code`, `team_product_catalogs.last_update_error`), а також у реєстрі рядка (`waitReason`, `waitCode`, `backgroundStalled`). Кнопки й тексти — П5 (рядок менеджера) і П6 (`errors.ts`, створення).

| Код                                                                                       | Де з'являється                                                                                                      | Рекомендована дія (кнопка)                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SPACE_BLOCKED`                                                                           | відмова запуску; кінець раунду                                                                                      | «Тарифи»                                                                                   |
| `AGENT_REQUIRED`                                                                          | відмова запуску (перезашивка без живої фонової роботи); кінець раунду після 2 год чекання або 6 год без делегування | «Налаштувати фонову роботу»                                                                |
| `AGENT_STALLED` **(новий)**                                                               | кінець раунду: фонова робота є, але 6 год не взялася за набір                                                       | «Перевірити фонову роботу» (той самий екран; текст: комп'ютер спав/вимкнений/Soty закрито) |
| `AGENT_ID_CONFLICT`                                                                       | `waitReason` раунду (кілька виконавців)                                                                             | «Налаштувати фонову роботу» (не текст про конфлікт назв)                                   |
| `AGENT_UPDATE_REQUIRED`, `RESTITCH_CLIENT_OUTDATED`                                       | кінець раунду                                                                                                       | «Оновити Soty»                                                                             |
| `NEEDS_REAUTH`                                                                            | відмова запуску; кінець раунду (з'єднання позначено `needs_reauth`)                                                 | «Підключити Drive знову»                                                                   |
| `ROOT_MISSING`                                                                            | відмова запуску; кінець раунду                                                                                      | «Обрати теку Drive»                                                                        |
| `DRIVE_UNAVAILABLE`, `RATE_LIMITED`                                                       | відмова запуску (`pending`); `waitCode` під час паузи; кінець після межі                                            | «Спробувати ще раз»                                                                        |
| `DRIVE_STORAGE_FULL`                                                                      | кінець раунду (прийняття або комп'ютер повідомив)                                                                   | «Звільнити місце в Google Drive»                                                           |
| `DISK_FULL`                                                                               | кінець раунду (комп'ютер повідомив, П4)                                                                             | «Звільніть місце на комп'ютері» + «Спробувати ще раз»                                      |
| `RESTITCH_INVALID` (лише «обидва екрани вимкнено» / биті налаштування), інші `RESTITCH_*` | кінець раунду (після однієї спроби з ефективними налаштуваннями)                                                    | «Перезашивка»                                                                              |
| `SOURCE_CHANGED`                                                                          | кінець раунду (відео каталогу змінено/видалено)                                                                     | «Відкрити каталог»                                                                         |
| `PERMISSION_DENIED`                                                                       | кінець раунду (людина втратила права)                                                                               | без кнопки                                                                                 |
| `SHARE_NOT_ALLOWED`                                                                       | кінець раунду                                                                                                       | без кнопки, текст про заборону ділитися                                                    |
| `PROCESS_RESULT_UNCERTAIN`                                                                | `waitReason` під час паузи (сирий код у `waitCode`); кінець після межі                                              | «Спробувати ще раз»                                                                        |

`waitCode` — новий необов'язковий ключ реєстру. Випущений веб його ігнорує; П5 читає його для точного тексту й кнопки.

## Знахідки

- **AGENT_STALLED і `TEAM_ERROR_CODES`.** `COPY` у `apps/web/src/team/errors.ts` — повний `Record<TeamErrorCode,…>`; додати код у shared без рядка в `COPY` — помилка tsc вебу. `errors.ts` — файл П6, і П6 тримає `AGENT_STALLED` у `SYNC_COPY`. Сервер пише `AGENT_STALLED` рядком (attempt/catalog мають лише regex-перевірку). П6 переносить його одним комітом (`TEAM_CATALOG_HANG_ERROR_CODES`, 20261224260000): `transport.ts` (новий масив у `TEAM_ERROR_CODES`), рядок у `COPY`, міграція `insert into public.team_error_codes`, `tests/team-contract.test.ts`, `scripts/generate-team-contract-sql.mjs`, `supabase/functions/_shared/errors.ts` (`STATUS_BY_CODE`).
- **Видалення item.** `team_catalog_updater_items_forget_unscheduled` видаляє item без розкладу, щойно `round_due_at` стає null; «каталог вільний» = немає item із `round_due_at`/`lease_owner`.
- **Порядок блокувань.** `cancel_catalog_updater_variant_round` бере запит, потім attempt; `close_catalog_variant_round` — у тому ж порядку.
- **Квитанція команди** (`parseCatalogCommandReceipt`) знає лише `accepted`/`already_pending`/`reconciliation_required`; нова причина окремого каталогу зламала б випущений веб — тому `AGENT_REQUIRED` відмовляє всю команду.
- **Повтор команди.** Команда й повтор перевіряють тільки простір (до своєї перевірки дозволу); Drive і фонову роботу — запуск, який вони викликають, уже після replay, тож повтор записаної команди відповідає квитанцією.
- **Налаштування до вбудованих картинок.** Знімки раундів до 20261224170000 без `builtin`; `RESTITCH_*` на них дістає одну спробу з ефективними налаштуваннями.
- **Не зроблено.** Перевірка версії виконавця при прийнятті (#12). Прод (`3f9ec287`, `e663ead2`, `4ff10503`, публікація `4d7d4b2d`) вручну не лікуємо — після викладки раунди закриє сам сервер.

## П4 — агент (3b275a81, 20261224190000)

- Probe `team-recovery` несе `localState`: `{stage:'blocked', reason, code}` або `{stage:'clear'}`; сервер тримає останній стан у `private.team_recovery_delegations.agent_block_reason/agent_block_code/agent_block_at` (`private.record_recovery_agent_state`), `clear` його знімає.
- Реєстр (П1) читає `agent_block_code`: `backgroundStalled: true` і `waitCode` = код комп'ютера; `waitReason` — лише коли код `AGENT_REQUIRED` (випущений веб відкидає весь `videoGeneration` на незнайомому `waitReason`). Cron П2 завершує раунд кодом комп'ютера через годину після звіту.
- Закриття варіанта приймає `DISK_FULL`, `NEEDS_REAUTH`, `DRIVE_STORAGE_FULL` (сервер теж); preupload розширено.
- Google 403 `storageQuotaExceeded` → `DRIVE_STORAGE_FULL`.
- Паузи агента: `NEEDS_REAUTH` — 15 хв, `DRIVE_STORAGE_FULL` — 1 год.
- Лікування сховища перезашивки на всіх платформах без перезапуску й без `APP_UPDATE_BUSY`.
- Звільнення записів: без виконання; `blocked` > 48 год; foreground > 24 год.
- ffmpeg зупиняється після 10 хв без виводу й без CPU.
- Порядок викладки: міграція раніше за edge. Лишилось: реліз агента.
