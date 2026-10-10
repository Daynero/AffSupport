# Tasks: Щоденний облік грошей агентів

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/finance.md](contracts/finance.md), [contracts/ui.md](contracts/ui.md), [quickstart.md](quickstart.md).

**Status**: Implementation in progress. Позначені задачі мають реалізацію й перевірки; непозначені залишаються незавершеними або мають лише часткові докази. Production не змінювався.

**Organization**: Setup → foundation → US1, US2, US3, US5 (P1) → US4, US6 (P2) → наскрізна перевірка. Номери US відповідають spec, а не порядку фаз. Шляхи — від кореня репозиторію. Нові migration filenames нижче резервуються для цієї функції; у разі колізії замінити timestamp узгоджено, не редагувати застосовану міграцію.

**Tests**: Включені за acceptance scenarios і SC-001–SC-009 специфікації та обов'язковими gates конституції. Тести фінансової цілісності пишуться перед відповідною реалізацією, фіксують очікуваний провал, потім мають пройти. Не замінювати перевірку конкурентності послідовними PGlite викликами.

**[P]** означає незалежні файли після виконання вказаних prerequisites; приклади нижче не дозволяють одночасно редагувати спільні файли. Важкі локальні gates виконувати послідовно. Задачі не містять production deployment.

## Phase 1: Setup

**Мета**: підготувати локальну перевірку та чіткі контракти без нових runtime dependencies.

- [x] T001 Зафіксувати стан робочого дерева, карту чинних account/money/delete RPC і test harness у `specs/027-agent-daily-spend/research.md`; перевірити актуальні AGENTS.md, USD/історичне групування як припущення та відсутність колізій нових migration timestamps.
- [x] T002 Додати `types:supabase:local` у `package.json` з генерацією через --local у `apps/web/src/lib/database.types.ts`; зберегти чинну --linked команду без змін і синхронізувати локальну інструкцію в `specs/027-agent-daily-spend/quickstart.md`.
- [x] T003 [P] Підготувати контрольні finance fixtures у `tests/support/team-agent-finance.ts`: два простори, editor/viewer, соци X/Y, агент із runs/labels/task links, legacy money та дати до звітного місяця; використати `tests/support/team-db.ts` без production credentials.

## Phase 2: Foundational

**Мета**: спільна точна модель, авторизація, захист історії та сумісність зі старими клієнтами. Уся фаза блокує user stories.

- [x] T004 Створити тести money/date/version/DTO guards у `tests/team-agent-finance-contract.test.ts`: кома/крапка, null/zero, межі, великі підсумки, високосні дати, invalid timezone та unknown payloads.
- [x] T005 Реалізувати типи й валідатори, bigint cents ↔ decimal strings та стабільні error codes у `packages/shared/src/team/agent-finance.ts`; експортувати через `packages/shared/src/team/index.ts` і `packages/shared/src/index.ts`; пройти T004.
- [x] T006 (закрито 2026-10-10: `tests/team-agent-finance-schema.test.ts` — відмова undated RPC (`FINANCE_CLIENT_UPGRADE_REQUIRED`), порожній новий день, IANA/invalid/UTC timezone, прямий доступ; `tests/team-agent-money-sql.test.ts` закріплено на схемі до 027 (`throughMigration: '20261003000000'`); видалення/каскади — `tests/team-agent-finance-transfer.test.ts` і pgTAP `supabase/tests/database/team-agent-finance.test.sql`) Написати migration/tenant/legacy/delete tests у `tests/team-agent-finance-schema.test.ts` та оновити очікування застарілих money RPC у `tests/team-agent-money-sql.test.ts`; перевірити замороження старих полів, null/null, прямий доступ і каскади; додати створення агента з IANA timezone біля UTC-півночі, omitted→UTC та invalid→атомарна відмова.
- [x] T007 Створити атомарну forward migration `supabase/migrations/20261003100000_team_agent_finance_foundation.sql`: placements, values, events, transfers, legacy, receipts, tenant FKs, індекси, FORCE RLS, вузькі grants, baseline дат, створення placement для нових агентів; замінити сигнатуру add_team_account_agent, додавши optional p_timezone default UTC без неоднозначних overloads та зі збереженням return shape/grants; snapshot старих money та fail-closed stubs трьох старих set/clear RPC виконати в тій самій транзакції.
- [x] T008 (закрито 2026-10-10: guards і frozen-money trigger у `20261003100000_team_agent_finance_foundation.sql` (`private.finance_delete_draft`), видалення після transfer без грошей — forward `20261003106000_team_agent_finance_delete_compatibility.sql` (T059); тести schema/transfer проходять) Доповнити `supabase/migrations/20261003100000_team_agent_finance_foundation.sql` guards видалення agent/account/draft-team, захистом frozen money від усіх чинних write paths і узгодженими deferred references; дозволити видалення сутності без фінансів та штатне явне видалення всього team; пройти T006.
- [x] T009 [P] Описати недеструктивний rollback і порядок local rollout у `supabase/migrations/ROLLBACK.md`: старі RPC не вмикати після появи нових записів, журнали не видаляти, UI rollback залишає фінанси read-only до forward fix.
- [x] T010 (закрито 2026-10-10: finance RPC у `apps/web/src/lib/database.types.ts`, адаптер `apps/web/src/api/team-finance.ts` на спільному `TeamApiError`; timezone йде з форми через `AccountGroup.tsx` → `useAccounts.ts` → `addAccountAgent` (`p_timezone`), перевірка в `tests/team-accounts.test.tsx`) Після T007–T008 оновити `apps/web/src/lib/database.types.ts` тільки з локальної схеми; підготувати спільний RPC/error adapter у `apps/web/src/api/team-finance.ts` та делегування через `apps/web/src/api/team.ts`, не дублюючи TeamApiError чи Supabase client. Передати timezone від форми створення через `apps/web/src/team/accounts/AccountGroup.tsx`, `useAccounts.ts` та addAccountAgent у `apps/web/src/api/team.ts`; додати browser-wrapper перевірку у `tests/team-accounts.test.tsx`.

**Checkpoint**: T004/T006 пройшли; старий клієнт не може непомітно перезаписати money, архів не видаляється через account cascade. Це локальна foundation, не готовий до випуску продукт.

## Phase 3: US1 — Записати спенд за день (P1)

**Independent Test**: Внести 125.50, виправити на 150.25, очистити/відновити, перевідкрити день; перевірити нуль, помилку, повтор запиту, журнал і viewer refusal.

- [x] T011 [P] [US1] (закрито 2026-10-10: `tests/team-agent-finance-values.test.ts` — CAS кожного metric, clear/restore, idempotency mismatch, viewer, Undo (повтор, newer write, чужий), пагінація журналу без дублів) Додати write/read/history SQL contract tests у `tests/team-agent-finance-values.test.ts`: CAS окремого metric, null tombstone, idempotency payload mismatch, permissions, дата/placement та стабільна пагінація журналу; одиночний clear/Undo кожного metric, newer-version conflict, no-op clear, повтор Undo та заборона Undo чужої операції.
- [ ] T012 [P] [US1] Додати UI acceptance tests у `tests/team-agent-finance-daily.test.tsx`: Enter/Escape/Tab, dirty navigation, error/conflict із збереженням draft, відсутність write controls для viewer; одиночний clear→Undo спенду, залишку й поповнення, conflict toast та відсутність Undo для no-op.
- [x] T013 [US1] Реалізувати get_team_agent_finance, set_team_agent_finance_value, undo_team_agent_finance_clear для одиночного очищення та list_team_agent_finance_history у `supabase/migrations/20261003101000_team_agent_finance_values.sql`: один snapshot statement, agent lock, CAS, journal+receipt атомарно, membership check навіть на retry; generic metric підтримує всі три поля; змістовний одиночний clear повертає undoReference, Undo перевіряє author/edit/version, атомарно позначає original receipt та не повторює відновлення.
- [x] T014 [US1] Додати типізовані read/write/single-clear-Undo/history wrappers у `apps/web/src/api/team-finance.ts`, оновити `apps/web/src/lib/database.types.ts` локально та реалізувати `apps/web/src/team/accounts/finance/useAgentFinance.ts` зі snapshot/draft розділенням і перевіркою покоління read.
- [x] T015 [US1] (закрито 2026-10-10: `FinanceToolbar.tsx`, `useFinancePeriod.ts`, `DailyFinanceFields.tsx`, `FinanceHistoryDrawer.tsx` у `apps/web/src/team/accounts/finance/`, Undo через `undoReference` у `FinanceWorkspace.tsx`, ключі `finance*` в обох локалях `i18n.ts`; тести toolbar/period/fields/history) Реалізувати `apps/web/src/team/accounts/finance/FinanceToolbar.tsx`, `useFinancePeriod.ts`, `DailyFinanceFields.tsx` та `FinanceHistoryDrawer.tsx` на UI inventory: день, календар, клавіатура, dirty guard, журнал та одиночний Undo через server undoReference; додати потрібні ключі в `apps/web/src/i18n.ts` у всіх чинних локалях.
- [x] T016 [US1] (закрито 2026-10-10: денний режим вбудовано в `AccountSpace.tsx` через `FinanceWorkspace`/`FinanceAccountGroup` (компактні рядки за T062 замість `AccountGroup`/`AgentRow`); T011 проходить, UI acceptance-тести лишаються відкритими під T012) Вбудувати денний фінансовий режим у `apps/web/src/team/accounts/AccountSpace.tsx`, `AccountGroup.tsx` та `AgentRow.tsx`; передавати одну дату всім рядкам, показувати історичне групування, під'єднати RPC й пройти T011–T012.
- [x] T017 [US1] Розширити єдиного власника realtime у `apps/web/src/team/accounts/useAccounts.ts` та дозволені publication entries у `supabase/migrations/20261003101000_team_agent_finance_values.sql`: finance/placement invalidation, reconnect/foreground/online reread, один bounded follow-up під час read, без polling; додати перевірки в `tests/team-agent-finance-realtime.test.tsx`.

**Checkpoint**: Денний спенд і його історія працюють незалежно від місячного огляду та Excel. До завершення US5 недатовані money fields не можна вважати повністю заміненими.

## Phase 4: US2 — Швидко побачити підсумок (P1)

**Independent Test**: Для вересневих 100.10+20.20 і жовтневих 30.00 місячні перемикачі дають 120.30/30.00; день показує лише себе, empty ≠ zero.

- [x] T018 [P] [US2] Додати report tests у `tests/team-agent-finance-report.test.ts`: повний місяць, грудень/січень, лютий 28/29, пропуски, нулі, незалежні spend/topup, колонки account UUID + agent UUID, повторне повернення X → Y → X (одна колонка X/A), періоди без сум і заборона підсумовувати balance між днями.
- [ ] T019 [P] [US2] Додати month/day navigation tests у `tests/team-agent-finance-monthly.test.tsx`: цей/минулий місяць, повернення до агента та scroll, явно повні totals при пошуку/фільтрах.
- [x] T020 [US2] Реалізувати точний report builder у `packages/shared/src/team/agent-finance-report.ts`, експортувати з `packages/shared/src/team/index.ts`: природне сортування з UUID tie-break, усі унікальні account/agent пари періоду з об'єднанням їхніх placements, null-aware totals і відсутність balance totals; пройти T018.
- [x] T021 [US2] (закрито 2026-10-10: `MonthlyFinanceSummary.tsx` інтегровано через `FinanceToolbar`/`useFinancePeriod`/`FinanceWorkspace` з одним snapshot і збереженим контекстом (T056); `tests/team-agent-finance-monthly.test.tsx`) Створити `apps/web/src/team/accounts/finance/MonthlyFinanceSummary.tsx`; інтегрувати місячний режим у `FinanceToolbar.tsx`, `useFinancePeriod.ts` і `AccountSpace.tsx`, використовуючи один snapshot та збережений контекст; локалізувати й пройти T019.

## Phase 5: US3 — Перенести агента на інший соц (P1)

**Independent Test**: Перенести A X→Y із 15 числа; 100.00 за 10 число лишаються в X, 40.00 за 16 — у Y; історія A=140.00, усі зв'язки збережені.

- [x] T022 [P] [US3] (закрито 2026-10-10: `tests/team-agent-finance-transfer.test.ts` — той самий UUID і вся історія, колізія ID, невалідні цілі, retry рівно один раз, X→Y→X з backdated сумою; часові обмеження свідомо прибрано в `20261009100000_team_agent_finance_backdating.sql` (тест «nothing blocking a transfer»)) Додати SQL transfer tests у `tests/team-agent-finance-transfer.test.ts`: same UUID, runs/tags/tasks, колізія ID, cross-team, same-target, temporal restrictions включно з cleared events, backdated entry та retry.
- [ ] T023 [P] [US3] Додати dialog tests у `tests/team-agent-finance-transfer-ui.test.tsx`: список цілей, дата/причина відмови, помилка без втрати вибору й focus return.
- [x] T024 [US3] (закрито 2026-10-10: `move_team_account_agent` у `20261003102000_team_agent_finance_transfer.sql` — впорядковані account locks, потім agent lock, expected placement/version, request replay; T022 проходить) Реалізувати move_team_account_agent у `supabase/migrations/20261003102000_team_agent_finance_transfer.sql`: впорядковані account locks потім agent lock, expected placement/version, атомарні close/open placement + account_id + event + receipt; звірити lock order з delete RPC і пройти T022.
- [x] T025 [US3] (закрито 2026-10-10: wrapper у `api/team-finance.ts`, типи в `database.types.ts`, `finance/MoveAgentDialog.tsx`, дія `financeMove` в `AgentRow.tsx`, локалізація; `tests/team-agent-finance-transfer-ui.test.tsx`) Додати wrapper і локальні DB types у `apps/web/src/api/team-finance.ts` та `apps/web/src/lib/database.types.ts`; реалізувати `apps/web/src/team/accounts/finance/MoveAgentDialog.tsx`, menu action в `AgentRow.tsx` і локалізацію в `apps/web/src/i18n.ts`.
- [ ] T026 [US3] Узгодити інвалідацію поточного accounts list, finance snapshots і task-agent labels у `apps/web/src/team/accounts/useAccounts.ts` та `apps/web/src/team/tasks/useTasks.ts`; перевірити актуальний новий соц у завданнях без зміни UUID й пройти T023.

## Phase 6: US5 — Єдиний денний облік усіх трьох показників (P1)

**Independent Test**: День 3 має balance=70/topup=200/spend=130, день 4 порожній; повернення відновлює всі значення. Topup 100→150 рахується як 150; clear/Undo стосуються лише вибраної дати.

- [x] T027 [P] [US5] (закрито 2026-10-10: `tests/team-agent-finance-operations.test.ts` — rollback усього batch на stale CAS, Undo після новішого запису, атомарний clear з одноразовим restore, незалежний імпорт metric, відмова на зайняті дати) Додати tests batch clear/Undo/legacy у `tests/team-agent-finance-operations.test.ts`: all-or-nothing CAS, збереження інших дат, Undo conflict, повтор запиту, незалежний імпорт metric та LEGACY_TARGET_OCCUPIED.
- [ ] T028 [P] [US5] Додати tests трьох полів і midnight у `tests/team-agent-finance-lifecycle.test.tsx`: clean/dirty/pending, foreground після сну, manual historical date, зміна timezone, незалежні drafts і новий день без перенесення значень.
- [x] T029 [US5] (закрито 2026-10-10: `clear_team_agent_finance_values`, `list_/import_team_agent_finance_legacy` у `20261003103000_team_agent_finance_operations.sql`, типи в `database.types.ts`; T027 проходить) Реалізувати batch-clear і розширити наявний з US1 undo_team_agent_finance_clear підтримкою batch receipts; додати legacy list/import RPC у `supabase/migrations/20261003103000_team_agent_finance_operations.sql`: ordered agent locks, explicit date/field versions, author-owned Undo, незмінні legacy originals, once-only import; пройти T027 і оновити локальні `apps/web/src/lib/database.types.ts`.
- [x] T030 [US5] Розширити `apps/web/src/api/team-finance.ts`, `finance/useAgentFinance.ts` і `finance/DailyFinanceFields.tsx` у `apps/web/src/team/accounts/` трьома незалежними полями, save states та одиницями; автоматично не перераховувати balance.
- [x] T031 [US5] Реалізувати clean/dirty/pending rollover та foreground перевірку в `apps/web/src/team/accounts/finance/useFinancePeriod.ts`; одноразовий локальний timer, зафіксована дата pending запиту, без мережевого polling; пройти T028.
- [x] T032 [US5] (закрито 2026-10-10: `finance/LegacyFinanceReview.tsx` з окремим підтвердженням дати/валюти/суми, підключено у `FinanceWorkspace.tsx`; `tests/team-agent-finance-lifecycle.test.tsx`) Створити `apps/web/src/team/accounts/finance/LegacyFinanceReview.tsx`, під'єднати до `FinanceHistoryDrawer.tsx`: окреме підтвердження date/currency/amount, old topup як запит, посилання на імпорт, жодних автоматичних дат або платежів.
- [ ] T033 [US5] Замінити старі `AgentMoney.tsx` та money footer handlers у `apps/web/src/team/accounts/AccountSpace.tsx` денним модулем і explicit clear confirmation/Undo; видалити використання недатованих write RPC з `useAccounts.ts`, не видаляючи потрібний legacy read contract.
- [ ] T034 [US5] Додати dated copy builders у `packages/shared/src/team/agent-finance-report.ts`, під'єднати до `AccountSpace.tsx`: фактично внесені ненульові суми, дата/USD, історичний соц або агентські теги, без clear після copy; оновити `tests/team-accounts-contract.test.ts` і `tests/team-accounts.test.tsx` на нову семантику.
- [ ] T035 [US5] Локалізувати нові clear/import/copy/conflict стани в `apps/web/src/i18n.ts` та додати інтеграційні перевірки `tests/team-agent-finance-lifecycle.test.tsx` для LegacyFinanceReview і clear/Undo UI; пройти US5 end-to-end із `specs/027-agent-daily-spend/quickstart.md`.

**Checkpoint / рекомендований MVP**: US1+US2+US3+US5 дають узгоджений денний облік усіх грошей із місячним оглядом і збереженням історії. Для повного запиту ще потрібні US4+US6.

## Phase 7: US4 — Завантажити Excel (P2)

**Independent Test**: Відкрити експорт контрольного місяця: усі дати, групи соц→агент, blank/zero, перенесення X → Y → X без повторної колонки X/A, full ID, правильні суми та перевірений доступ.

- [ ] T036 [P] [US4] Додати XLSX tests у `tests/team-agent-finance-xlsx.test.ts`: незалежне читання ZIP/XML, п'ять аркушів, merged headers, freeze panes, числові суми/текстові ID, no formulas, null/zero, X → Y → X без повторної колонки одного agent/account, precision/size errors та сумісність старого catalog workbook.
- [x] T037 [P] [US4] (закрито 2026-10-10: `tests/team-agent-finance-export.test.ts` (один user-scoped snapshot, повторна перевірка прав, revoked membership, invalid period, cross-team) і `tests/team-agent-finance-export-response.test.ts` (JSON-помилки без часткового файлу)) Додати handler tests у `tests/team-agent-finance-export.test.ts`: user JWT, cross-team, membership revocation перед response, один snapshot, приватні headers, invalid period, binary success і JSON error без часткового файлу.
- [x] T038 [US4] Розширити `supabase/functions/_shared/xlsx.ts` buildWorkbook зі styles/merges/freeze/multiple sheets, зберігши wrapper buildXlsx; пройти чинні `tests/product-catalog-xlsx.test.ts` без регресій.
- [x] T039 [US4] Створити `supabase/functions/_shared/finance-workbook.ts` на shared report DTO: матриці Spend/Topup/Balance, виписка, totals, сталі заголовки/сортування, exact decimal serialization та попередня перевірка precision/width; пройти T036.
- [x] T040 [US4] (закрито 2026-10-10: `supabase/functions/team-finance-export/index.ts` + `handler.ts`, `[functions.team-finance-export]` у `supabase/config.toml`; T037 проходить, browser download HTTP 200 у validation.md) Створити `supabase/functions/team-finance-export/index.ts` і `handler.ts`, зареєструвати в `supabase/config.toml`: чинні auth/CORS helpers, user-scoped snapshot RPC, повторний access check, private no-store attachment, без service-role bypass чи збереження в публічний storage; пройти T037.
- [x] T041 [US4] (закрито 2026-10-10: binary wrapper у `api/team-finance.ts`, дія експорту у `FinanceToolbar.tsx`; `tests/team-agent-finance-export-ui.test.tsx` (MIME/помилка, revoke object URL)) Додати binary export wrapper у `apps/web/src/api/team-finance.ts` та дію у `apps/web/src/team/accounts/finance/FinanceToolbar.tsx`: loading/error/retry, status/MIME validation, безпечний filename і cleanup object URL; локалізація в `apps/web/src/i18n.ts`, тести в `tests/team-agent-finance-export-ui.test.tsx`.

## Phase 8: US6 — Місячна виписка поповнень (P2)

**Independent Test**: Поповнення 100 і 50 у різні дні дають 150; залишки 30 і 20 не стають 50. Виписка містить правильні дати/соци, а виправлене поповнення враховане один раз.

- [ ] T042 [P] [US6] Додати statement tests у `tests/team-agent-finance-statement.test.tsx`: topup-only month, перенесення, explicit zero, очищення/виправлення, agent summary без дублювання, перехід рядка до відповідного дня.
- [x] T043 [US6] Створити `apps/web/src/team/accounts/finance/FinanceTopupStatement.tsx` і під'єднати до `MonthlyFinanceSummary.tsx`: дата→історичний соц→повний ID→сума, окремі totals, drill-down зі збереженням контексту; ключі в `apps/web/src/i18n.ts`.
- [ ] T044 [US6] Звірити UI statement та Excel на одному fixture в `tests/team-agent-finance-xlsx.test.ts` і `tests/team-agent-finance-statement.test.tsx`; виправити розбіжності в `packages/shared/src/team/agent-finance-report.ts` та `supabase/functions/_shared/finance-workbook.ts`, не вводячи другий алгоритм підсумків; пройти T042.

## Phase 9: Polish & Cross-Cutting Validation

**Мета**: довести всі user stories на справжній локальній системі, включно з безпекою, конкурентністю, layout та швидкістю.

- [ ] T045 Додати й виконати real-PostgreSQL RLS/delete/old-client тести в `supabase/tests/database/team-agent-finance.test.sql` та двосесійні гонки в `tests/team-agent-finance-concurrency.test.ts`: same/different metric, move/write, delete/write, batch/Undo, retry і legacy import; інтегрувати локальний concurrency запуск у `scripts/verify-all.mjs`/чинний gate registry без silent pass за відсутності DB.
- [ ] T046 [P] Розширити `scripts/check-accounts-layout.mjs` фінансовими сценаріями на 320–1600px, light/dark, довгі ID/суми, вузькі три поля, keyboard focus та окремий scroll таблиці; пройти чинні design-token/Tailwind gates без нових винятків.
- [ ] T047 Перевірити logout/member revocation/cache cleanup і зміни прав у `apps/web/src/team/accounts/finance/useAgentFinance.ts` та `useAccounts.ts`; доповнити `tests/team-agent-finance-realtime.test.tsx` доказами bounded rereads, offline draft recovery та відсутності витоку між team.
- [ ] T048 (2026-10-11: замір p95 на 500 агентах знято з обсягу — найбільший простір у десятки разів менший, зовнішніх користувачів немає; повернути, коли з'явиться простір на сотні агентів. Лишається прохід quickstart і перевірка файлу в Excel) Виконати всі сценарії `specs/027-agent-daily-spend/quickstart.md`, відкрити контрольний файл у Excel і виміряти SC-001–SC-009; записати результати, середовище, p95 для 500 агентів та невирішені обмеження в `specs/027-agent-daily-spend/validation.md`, додати контрольний workbook у `specs/027-agent-daily-spend/validation/` без реальних фінансових даних.
- [ ] T049 Оновити локальні `apps/web/src/lib/database.types.ts` і зібрані shared artifacts, виконати форматування, `npm run build:web`, `npm run verify` та `npm run verify:release` послідовно; виправити збої в межах функції, перевірити `verification-result.json` та записати фактичні результати в `specs/027-agent-daily-spend/validation.md`.
- [ ] T050 Оновити `specs/027-agent-daily-spend/spec.md`, `plan.md`, `quickstart.md` і `supabase/migrations/ROLLBACK.md` за фактичною реалізацією та перевірками; відмічати виконані задачі у `specs/027-agent-daily-spend/tasks.md` лише за наявності результату, не заявляти production deployment або release.

## Dependencies & Execution Order

```text
Setup T001–T003
  → Foundation T004–T010
    → US1 T011–T017
      → US2 T018–T021
      → US3 T022–T026
      → US5 T027–T035
        → US4 T036–T041 (також потребує US2 та US3)
          → US6 T042–T044 (також потребує US2 та US5)
            → Final T045–T050
```

US2/US3/US5 незалежно перевіряються на foundation+US1 fixtures; їх UI інтеграції у спільні AccountSpace/useAccounts/i18n виконувати послідовно. US4 перевіряється окремим snapshot fixture; US6 — fixture з готовими денними даними. Повна наскрізна прийомка потребує всіх історій.

Всередині фази test tasks перед implementation; локальні wrappers лише після відповідної RPC migration та type generation. T007–T008 — один атомарний foundation migration artifact, не два окремі deployment кроки. T009 можна виконувати разом із T010 після foundation SQL. T048 потребує T045–T047, T049 — T048, T050 — успішні gates або чесно зафіксований залишок роботи.

## Parallel Execution Examples

| Story | Незалежні задачі після prerequisites                                | Що серіалізувати                     |
| ----- | ------------------------------------------------------------------- | ------------------------------------ |
| US1   | T011 SQL tests + T012 DOM tests                                     | T013 → T014 → T015 → T016 → T017     |
| US2   | T018 report tests + T019 navigation tests                           | T020 → T021                          |
| US3   | T022 transfer SQL tests + T023 dialog tests                         | T024 → T025 → T026                   |
| US5   | T027 operations tests + T028 lifecycle tests                        | T029–T035: спільні RPC/UI files      |
| US4   | T036 workbook tests + T037 handler tests                            | T038 → T039 → T040 → T041            |
| US6   | T042 fixture/UI tests можна готувати паралельно з US4 після US2+US5 | T043 після T042; T044 після US4+T043 |

T002 і T003 після T001 працюють у різних файлах. У фінальній фазі T045 і T046 можна готувати окремо, але запуски важких DB/browser gates — послідовно. Позначки паралельності описують можливості виконання, а не вимогу запускати додаткових агентів.

## Requirement Coverage

| Вимоги        | Основні задачі                         |
| ------------- | -------------------------------------- |
| FR-001–FR-005 | T004–T005, T011–T016, T018–T021        |
| FR-006        | T018–T021, T042–T044                   |
| FR-007        | T006–T008, T030–T035                   |
| FR-008–FR-011 | T022–T026, T045                        |
| FR-012–FR-015 | T006–T014, T024, T027–T029, T045, T047 |
| FR-016–FR-020 | T036–T041, T044                        |
| FR-021–FR-022 | T015–T017, T028, T031, T046–T047       |
| FR-023–FR-027 | T011–T015, T027–T035                   |
| FR-028        | T036–T044                              |
| FR-029–FR-030 | T006–T010, T024, T029, T032, T045      |
| FR-031        | T033–T035                              |
| SC-001–SC-009 | Story checkpoints, T045–T049           |

## Implementation Strategy

Спочатку foundation і US1 як технічний інкремент; перевірити його локально. Рекомендований користувацький MVP — усі P1 (US1+US2+US3+US5), оскільки запуск лише спендів зі зламаними старими money controls не задовольняє узгоджену систему. Потім US4+US6 закривають Excel і місячну виписку. Публікація будь-якого інкременту є окремою дією за production runbook, не автоматичним наслідком checkpoint.

**Підсумок**: 50 задач; Setup 3, Foundation 7, US1 7, US2 4, US3 5, US5 9, US4 6, US6 3, Final 6. Усі задачі містять checkbox, послідовний ID та шляхи; усі story tasks мають US label.

## Додатковий браузерний UX інкремент

- [x] T051 Упорядкувати календар, пошук, agent actions та перемикання операційного/фінансового виду без втрати чернеток у `apps/web/src/team/accounts/finance/` і `AccountSpace.tsx`; додати regression tests.
- [x] T052 Перевірити реальні локальні write/clear/Undo/transfer/monthly workflow у браузері через `validation/check-finance-workflow.mjs`, включно з повтором batch receipt після втрати відповіді.
- [x] T053 Виправити Edge Authorization header і перевірити фактичне XLSX-завантаження браузером через loopback native Deno helper; зафіксувати відсутність Docker release evidence у `validation.md`.
- [x] T054 Зафіксувати мобільний світлий/темний QA та відкриті UX питання у `ux-review.md`; не позначати незавершені початкові задачі виконаними.
- [x] T055 Додати «Зберегти й продовжити / Відкинути / Залишитися» до навігації з фінансовими чернетками у `FinanceWorkspace.tsx`; поле реєструє точне save action, помилка не втрачає draft; перевірити tests-first у `team-agent-finance-fields.test.tsx` та real browser workflow.
- [x] T056 Розділити місячну таблицю, підсумки й виписку inventory Tabs у `MonthlyFinanceSummary.tsx`; зберігати метрику/вкладку/scroll та відновлювати фокус дати при поверненні з дня; перевірити unit tests і браузер.
- [x] T057 Додати пошук цільового соц, вихідний соц/ID і пояснення блокування сьогоднішньою історією до `MoveAgentDialog.tsx`; перевірити `team-agent-finance-transfer-ui.test.tsx`. Повне T023 ще потребує network/focus acceptance.
- [x] T058 Зберігати серверний код помилки Excel в binary wrapper, узгодити merged headers/freeze rows із контрактом; пройти `team-agent-finance-export-ui.test.tsx`, `team-agent-finance-xlsx.test.ts` та catalog regression.
- [x] T059 Виправити delete після transfer-only у forward `20261003106000_team_agent_finance_delete_compatibility.sql`, не редагуючи застосовану foundation; перевірити видалення former social без грошей і захист former social з фінансовою історією агента; transfer suite 4/4.

## Правки після користувацької перевірки бети

- [x] T060 Використати `TaskDateFilterControl` із завдань для проміжків; forward migration `20261003107000_team_agent_finance_ranges.sql` і shared DTO підтримують до 366 включних днів, dirty navigation зберігає обидві межі; перевірити SQL/toolbar regression.
- [x] T061 Зробити матрицю адаптивною до залишку висоти viewport, узгодити ширини колонок, непрозорі sticky header/date/footer та помаранчевий ID tail; перевірити monthly regression й responsive layout.
- [x] T062 Перевести денні фінанси на компактні agent rows із соц-заголовками та чинним `AgentLabels`; розширити місце тегів операційного виду й центрувати wrapping; перевірити accounts regression.
- [x] T063 Виправити фактичне завантаження Excel у source beta через явно увімкнений native Edge proxy, не змінюючи auth чи production endpoint; перевірити звичайною кнопкою Safari.
- [x] T064 Завершити повторний real browser workflow із новими identity selectors, sticky footer assertion і source beta export без route forwarding; зафіксувати перевірки та залишити бету відкритою. Повний static gate result зазначено окремо у validation.md.
- [x] T065 Переробити денні фінанси після порівняння screenshots: operational account/list/agent shells, hue rail, heading mark/collapse/count/tag summaries, shared identity typography, row-height/grid й одиничні captions; перевірити mounted drafts при collapse, responsive layout та real write/export workflow з style parity assertions.
