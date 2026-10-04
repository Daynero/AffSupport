# Research: щоденний фінансовий облік

## Implementation baseline (2026-10-03)

Початкове дерево: змінений `.specify/feature.json`, незатрекані `specs/027-agent-daily-spend/`, `-m.json`, `-m.txt`; ці користувацькі артефакти збережено. Робота ведеться в `fix/drive-unverified-pilot`, без commit/push/release/deploy. Прочитано AGENTS.md, constitution та дизайн-документи. Timestamp 20261003100000–20261003103000 не мали колізій. USD і групування за історичним соцом лишаються узгодженими припущеннями.

Чинний harness `tests/support/team-db.ts` встановлює JWT claim, але не перемикає SQL role: його RPC-тести не є доказом RLS. Прямий доступ додатково перевірено під `authenticated` і реальною PostgreSQL pgTAP перевіркою. Двосесійна конкуренція перевіряється окремим release/e2e тестом через loopback PostgreSQL; відсутня БД або міграція дає failure, не silent skip.

Локальні міграції застосовано через `supabase migration up --local`, без reset. CLI виконує LOCK TABLE лише в явній транзакції: foundation має BEGIN/COMMIT. Після локального застосування виправлення оформлено новими forward migrations 20261003104000 (draft anti-enumeration) і 20261003105000 (спільна пагінація transfers/money, десяткові суми журналу), застосовані файли не переписуються.

## 1. Поточна модель та ідентичність

**Evidence**: `packages/shared/src/team/accounts.ts`, migrations `20260905100000_team_accounts.sql`, `20260905120000_team_task_agents.sql`, `20260905140000_team_agent_runs.sql`. Агент має сталий UUID, поточний account_id та видимий agent_id; останній унікальний лише всередині соцу. Завдання, запуски й теги прив'язані до UUID.

**Decision**: переносити той самий запис агента; додати календарні періоди його розміщення. Суми прив'язані до періоду, а не визначають соц через поточний account_id.

**Rationale**: зберігаються ідентичність і зв'язки; старий місяць не змінюється після перенесення.

**Alternatives considered**: delete/create втрачає зв'язки; копія створює дві ідентичності; лише поточний account_id переписує історичне групування.

## 2. Гроші та одночасні зміни

**Evidence**: migrations `20260906220000_agents_carry_money_and_tags.sql` і `20260906230000_the_balances_can_be_cleared_too.sql` мають integer balance/topup та недатовані глобальні clears. Специфікація вимагає центів, окремих показників і журналу.

**Decision**: один рядок на agent/date/metric, bigint cents, версія та null tombstone після очищення; спільний CAS Undo одиночного clear всіх metrics та batch clear balance/topup; journal і idempotency receipt записуються атомарно. RPC спочатку блокує agent row, потім перевіряє версію конкретного поля.

**Rationale**: різні поля не конфліктують семантично; повтор запиту не додає гроші, очищене поле зберігає версію. Агентний lock серіалізує запис із перенесенням.

**Alternatives considered**: float непридатний для точної арифметики; agent-wide CAS конфліктує при зміні іншого поля; event sourcing як єдине джерело стану ускладнює прості денні reads.

## 3. Перехід зі старого обліку

**Decision**: атомарний legacy snapshot; старі три money write/clear RPC повертають `FINANCE_CLIENT_UPGRADE_REQUIRED`. Колонки тимчасово зберігаються замороженими. Нове поле «Поповнено» означає факт, старе «Додати» — лише запит.

**Rationale**: старий клієнт не може обійти журнал, а недатовані кошти не перетворюються на фальшиву виписку.

**Alternatives considered**: записати все на день міграції — вигадати дату; відображати старе значення як поточне — порушити порожні поля нового дня; dual write — два джерела правди.

## 4. Видалення

**Evidence**: account → agent і team → account мають каскади; `delete_draft_team` у `20260823120000_team_ux_lifecycle.sql` визначає чернетку за відсутністю Drive.

**Decision**: забороняти видалення агента/соцу з ledger, journal або legacy history; placement без фінансів не блокує видалення. Deferred NO ACTION references захищають від каскаду account delete; team_id cascade дозволяє окреме явне видалення всього простору. `delete_draft_team` має відмовляти, якщо є фінансова історія: фінансовий простір уже не порожня чернетка. Штатне явне видалення простору лишається окремим підтвердженим сценарієм зі spec.

**Alternatives considered**: лише UI confirmation не захищає backend; RESTRICT без продуманого team deletion може заблокувати видалення всього простору; cascade від агента знищує історію.

## 5. Календар і live state

**Evidence**: `useAccounts.ts` має один канал `team-accounts`, 300 ms coalescing, generation/writes guards; у UI inventory вже є Calendar, DateField, Table, Drawer, ConfirmDialog.

**Decision**: розширити цього власника підписки подіями finance/placements; відокремити draft state від server snapshot. Reconnect/foreground/online робить authoritative reread. Подія під час read ставить один dirty follow-up; не запускати polling. Midnight — одноразовий локальний таймер із перевіркою при foreground, не мережеве опитування.

**Alternatives considered**: новий фінансовий канал поряд з accounts дублює власника; повний архів в useAccounts збільшує кожен reread; автозміна дати чернетки відправляє гроші не в той день.

## 6. XLSX

**Evidence**: `_shared/xlsx.ts` уже формує ZIP/XML workbook без формул, розрізняє string/number і зберігає довгі ID; зараз лише один аркуш, без merges/freeze panes. `tests/product-catalog-xlsx.test.ts` перевіряє чинного споживача.

**Decision**: backward-compatible `buildWorkbook` поряд із wrapper `buildXlsx`; додати styles, merged headers, freeze panes й кілька аркушів. Edge exporter під JWT користувача бере один snapshot RPC, генерує файл і повторно перевіряє доступ перед відповіддю. Ім'я файла очищене; приватний no-store response; файл не зберігається у публічному storage.

**Rationale**: колонки об'єднані за account UUID + agent UUID незалежно від числа повторних placements; повторне використання чинного writer без нової бібліотеки; один snapshot для всіх п'яти аркушів.

**Alternatives considered**: CSV не підтримує групи заголовків/аркуші; п'ять незалежних reads дають різні стани; browser export потребує перенесення наявного server writer та дублює бюджет/контроль формування.

## 7. Закриті технічні питання

Технічних невизначеностей, що блокують tasks, не залишилось. Валюта USD та історичне групування — явно прийняті робочі припущення специфікації, не нові підтверджені побажання. Контракти дат, precision, old-client behavior і snapshot описані в супровідних документах. Це локальне дослідження репозиторію; залежності не оновлювались, production не опитувалась.
