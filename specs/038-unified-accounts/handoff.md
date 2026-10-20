# Передача scope з 037 до 038

**Дата**: 2026-10-17. Вимоги — [spec.md](spec.md). Документ є інвентарем і матеріалом для planning, не готовим планом реалізації.

## Межа паралельної роботи

| Колишній scope 037 | Новий власник / зміна |
| --- | --- |
| US5, FR-010, T028–T029 — шапка фінансів | 038 US1; шапка єдиної таблиці |
| US6, FR-011–012, T030–T034 — порядок | 038 US2–US3; додано 500 мс, згортання, стабільну вставку |
| US7, FR-013–014, T035–T038 — огляд | 038 US1; замінено на повний робочий UI без вкладок |
| US8, FR-015, T044–T048 — архів | 038 US5; архів соцiв/окремих РК через другорядний пункт меню, історія за датами |
| T003 — аудит зв'язків запусків/фінансів | Planning 038; сталі ID, історичні placement, без join за назвою |
| Нове побажання — фон назви | 038 US4; 7 кольорів + без кольору, без семантики маркерів |

037 не реалізує наведені задачі. Номери залишені як посилання на передачу, не як завершені задачі. Її загальні diagnostic/gate задачі стосуються тільки решти scope. Діагностичні файли спільні: інтегрувати зміни двох фіч без перезапису чужих capability/code-map записів.

Робоча гілка й `.specify/feature.json` не перемикаються: покажчик уже змінено паралельною роботою на 037. Для planning/tasks 038 явно вказати `SPECIFY_FEATURE_DIRECTORY=specs/038-unified-accounts`. Це навмисний виняток із автоматичного перемикання feature pointer, щоб не перенаправити чужу реалізацію.

## Інвентар збереження функціоналу

Перевірено за поточними компонентами 2026-10-17. Кожен рядок — обов'язковий регресійний сценарій перед готовністю 038; це не твердження про вже виконані тести.

| Можливість | Розміщення в новому UI / що зберегти | Поточне джерело |
| --- | --- | --- |
| Соци: створення, перейменування, видалення з підтвердженням | Заголовок групи й чинний інлайн-редактор; потік додавання РК після створення соца | `AccountSpace.tsx`, `AccountGroup.tsx` |
| РК: додавання, редагування ID, видалення, перенесення між соцами | Рядок і його меню; чинні валідації та підтвердження | `AccountGroup.tsx`, `AgentRow.tsx`, `finance/MoveAgentDialog.tsx` |
| Копіювання повного ID, fallback при відмові clipboard | Окрема іконка поряд із назвою, яка тепер перемикає колір | `AgentRow.tsx`, `AgentIdentity.tsx` |
| 2FA соца: встановлення/очищення, код, копіювання й таймер | Заголовок соца; drag не перехоплює контрол, секрети не потрапляють у telemetry | `AccountGroup.tsx` |
| Ручні запуски: створення, редагування, видалення, звільнення РК | Чинна клітинка запусків та редактори; кілька запусків не множать фінанси | `AgentRow.tsx`, `useAccounts.ts` |
| Маркери запусків, їх очищення й Undo | Збережені поряд із запусками; колір назви не маркер | `Marked.tsx`, `MarkerFilter.tsx`, `AccountSpace.tsx` |
| Теги РК, словник тегів, копіювання з групуванням | Чинні контролі та дії | `AgentLabels.tsx`, `AccountSpace.tsx` |
| Пошук, зайнятість, маркери, лічильники, згортання всіх/одного | Єдина панель; ручний порядок не скидається; редагований об'єкт не зникає без завершення редактора | `AccountSpace.tsx`, `AccountGroup.tsx` |
| Пов'язані завдання та переходи до них | Чинні лічильники/peek у групі та РК | `AgentTasksPeek.tsx`, `AccountGroup.tsx` |
| Дата, вчора/сьогодні, місяць/попередній, діапазон і перехід по періодах | Спільна доступна при прокрутці шапка; зберегти чинні межі діапазону та timezone | `finance/FinanceToolbar.tsx`, `useFinancePeriod.ts` |
| Денний баланс, поповнення, витрати | Фінансові колонки того самого рядка; чинні правила редагування й обчислення | `finance/DailyFinanceFields.tsx`, `FinanceWorkspace.tsx` |
| Чернетки, save/cancel, захист виходу/зміни періоду, конфлікт placement | Спільний стан чернеток, не прив'язаний до змонтованості рядка під час згортання | `finance/FinanceWorkspace.tsx` |
| Очищення значень/періоду, підтвердження, Undo | Меню поля/панелі з тими самими межами та наслідками | `finance/FinanceWorkspace.tsx`, `FinanceActions.tsx` |
| Місячний/діапазонний підсумок і перехід до дня/назад | Агрегати РК в єдиній таблиці; деталі за діями, без вкладки фінансів | `finance/MonthlyFinanceSummary.tsx` |
| Копіювання підсумків і поповнень за соцом/тегом, statement, експорт | Панель фінансів/контекстні дії; формати й scope не змінюються | `finance/FinanceTopupStatement.tsx`, `FinanceWorkspace.tsx` |
| Історія та перевірка/імпорт legacy-фінансів | Чинні drawer/діалог, доступні з рядка РК | `finance/FinanceHistoryDrawer.tsx`, `LegacyFinanceReview.tsx` |
| Права, loading/error/retry/empty, realtime, локалізації, фокус | Зберегти на всіх шляхах, у тому числі після об'єднання | `useAccounts.ts`, `finance/useAgentFinance.ts`, чинні shared contracts |

Шляхи компонентів у таблиці відносні до `apps/web/src/team/accounts/`. Planning має звірити цей інвентар із кодом на своїй стартовій ревізії: паралельна робота може додати можливості, які також треба зберегти.

## Референс взаємодії

Готова модель — sortable vertical list: затримка захоплення, плаваючий образ рядка, місце вставлення, зсув сусідів, підтвердження drop і скасування. Використати перевірену бібліотечну основу, не писати власний drag engine. Конкретний пакет/версія ще не обрані.

Перевірені офіційні джерела 2026-10-17 (сайт позначає ці сторінки як **Legacy**, тому це референс патерну, а не рекомендація встановити застарілу версію):

- [dnd-kit Sortable](https://dndkit.com/legacy/presets/sortable/overview/): впорядкований список, клавіатурна навігація, зсув сусідів. Беремо вставлення зі збереженням порядку інших елементів.
- [Delay constraint](https://dndkit.com/legacy/api-documentation/sensors/pointer/): утримання з допуском руху; для 038 обрано 500 мс / 5 CSS-пікселів. Документація окремо застерігає про touch-scroll; не блокувати прокрутку всієї таблиці заради drag.
- [Drag overlay](https://dndkit.com/legacy/api-documentation/draggable/drag-overlay/): образ перетягуваного елемента незалежний від перебудови списку. Це корисна основа для згортання соцiв без стрибка захопленого заголовка.

Згортання соцiв і відновлення знімка — продуктова поведінка поверх цього патерну. Короткий клік на назві змінює фон; довге утримання захоплює, після нього click поглинається. Фінансові поля та кнопки виключені із захоплення. Клавіатурний еквівалент і reduced motion обов'язкові.

[DESIGN.md](../../docs/DESIGN.md) має пріоритет над референсом: компоненти інвентарю, токени для руху та декоративна палітра даних для семи відтінків. 500 мс — поріг жесту, а не тривалість анімації; рух використовує чинні короткі тривалості. Нова палітра не вводить статусів.

## Вхідні рішення для planning

- Аудит поточного сортування: `packages/shared/src/team/accounts.ts`, `useAccounts.ts`, `AccountSpace.tsx`. Зараз natural/occupancy sorting може перевизначити результат користувача; стабільний ручний порядок має бути наскрізним.
- Окрема версія порядку для соцiв і для кожної групи РК; цілісне збереження з перевіркою membership/прав, conflict + authoritative reread. Не перезаписувати бізнес-поля через збереження порядку/кольору.
- Стале зіставлення запусків і фінансів. Поточні launch snapshots не можна з'єднувати за назвою; неоднозначне лишається непов'язаним. Денний/місячний placement має виключати подвійне врахування переміщеного РК. Уточнення після дослідження: чинна міграція rehome переносить усю фінансову історію до нового соца; це правило зберігається, без повернення старої моделі розподілу між соцами.
- Збереження порядку не має залежати від присутності рядка у фільтрованому результаті. Приклад: повний A,H,B,C, прихований H; C перед B → A,H,C,B.
- Перехід на ручний порядок має зафіксувати базову послідовність один раз; не обчислювати rank заново після зміни busy/free.
- Особиста декорація потребує збереження між сеансами користувача; спільний порядок і особистий fold-state — різні scopes. Для плану прийнято особистий scope кольорів, як записано в assumptions; користувач не задав іншого.
- Архів після уточнення власника: окремий стан соца та кожного РК, часові інтервали й історична видимість за spec US5. Наявна ручна нотатка запуску не блокує архівацію; зовнішня реклама/прийнята операція не зупиняється. Зберегти місце в загальному порядку. Відновлення соца не скидає власний архівний стан його РК.
- Успадкувати єдиний чинний канал оновлень командних даних, права, bounded діагностику й чинні формули; не додавати polling або паралельний фінансовий ledger.
- Planning має визначити вимірювану методику плавності, UX-перевірку touch/keyboard та повну acceptance matrix на основі spec. Наявність документа не означає перевірену плавність.
- Нові міграції отримують вільні актуальні імена під час реалізації; старі запропоновані у 037 timestamps не є зарезервованими чи виконаними.

## Уточнення робочого дня та архіву — 2026-10-17

Чинні вимоги — US5/US6, FR-019–024 та таблиця історичної видимості в spec. Вони замінюють старі припущення про архів тільки соца, постійний архівний фільтр і відмову за будь-якого активного запуску.

- План має відрізняти явно збережені фінансові значення від carry-forward/обчислених значень/порожніх записів. Без цього не можна правильно приховати архівний РК завтра. Явний нуль означає введені дані.
- Денний зріз потребує інтервалів активності, незалежного стану батька/РК та історичного placement. Одного поточного `archived_at` недостатньо для кількох archive/restore циклів. Перевірити сумісність з чинною історією, не вигадувати відсутні минулі lifecycle-події.
- Архівування соца обмежує використання всіх його РК, не переписуючи їхні власні архівні стани. Порожній архівний заголовок приховується, група з фінансовими записами потрібного дня залишається.
- Перевірити всі споживачі активних соцiв/РК: пошук, pickers, нові призначення, лічильники, копіювання й існуючі task/launch references. Архів виключений із нової роботи, але історичні посилання розв'язуються.
- Ранкові колонки працюють із двома датами одночасно: сьогоднішній залишок, учорашні витрати, сьогоднішні поповнення й витрати. Дата входить до ідентичності чернетки; сортування, згортання, опівніч і refresh не змінюють її.
- Копіювання поповнень враховує підтверджені записи обраного дня, у тому числі архівні та згорнуті. Учорашні витрати не змінюють сьогоднішніх підсумків. Clipboard evidence не доводить зовнішнє надсилання.
- Архівація з чернетками — save-and-archive / explicit discard / cancel. Помилка збереження одного з днів не дозволяє приховати рядок і загубити решту чернеток. Повтор після втраченої відповіді спершу звіряє результат.
- Додати регресії явний нуль / лише carry-forward / лише вчорашні дані / архів цілого соца зі змішаними днями / відновлення без каскаду / пізнє виправлення / північ / конкурентне збереження. Це вимоги майбутніх тестів, не звіт про виконані перевірки.

## Перенесені старі задачі — історична довідка

Це вхідний матеріал для нового плану, **не виконуваний tasks.md**. Зокрема стара T037 про read-only огляд зі старими редакторами більше не чинна; старі active-launch refusal та архів тільки соцiв також замінені уточненням власника. Чекбокси прибрано навмисно: перенесення не дорівнює виконанню.

- **Колишня 037** T003 [P] Trace stable РК identity through launches and finance placements, including moved/deleted РК and archived history; update `specs/037-workspace-ux-fixes/research.md` using `apps/web/src/team/launches/`, `apps/web/src/team/accounts/finance/` and `supabase/migrations/`.
- **Колишня 037** T028 [US5] Make `FinanceToolbar` sticky in the actual scroll owner with workspace-header offset and wrapped controls in `apps/web/src/team/accounts/finance/FinanceWorkspace.tsx`, `apps/web/src/team/accounts/finance/FinanceToolbar.tsx` and token-based styles in `apps/web/src/styles/components.css`.
- **Колишня 037** T029 [US5] Add a meaningful scroll/visibility regression in `tests/team-finance-workspace.test.tsx` (create if absent) and complete the narrow/zoom visual scenario from `specs/037-workspace-ux-fixes/quickstart.md`.
- **Колишня 037** T030 [US6] Add database regressions for initial rank backfill, same-parent membership, concurrent version conflict, permissions and destination rank on РК move in `supabase/tests/database/team-accounts-order.test.sql` (create if absent).
- **Колишня 037** T031 [US6] Add rank/version fields and deterministic natural-order backfill for `team_accounts` and `team_account_agents`, plus atomic permission-checked reorder functions, in `supabase/migrations/20261203102000_account_order.sql`.
- **Колишня 037** T032 [US6] Extend typed account readers/parsers and reorder client calls in `packages/shared/src/team/accounts.ts`, `apps/web/src/api/team.ts` and `apps/web/src/team/accounts/useAccounts.ts`; replace all natural re-sorting that would override persisted ranks.
- **Колишня 037** T033 [US6] Add pointer and keyboard reordering, insertion indicator, cancellation and conflict feedback in `apps/web/src/team/accounts/AccountSpace.tsx`, `apps/web/src/team/accounts/AccountGroup.tsx` and `apps/web/src/team/accounts/AgentRow.tsx` using existing design tokens.
- **Колишня 037** T034 [US6] Validate two-client realtime order and conflict/permission behavior in `tests/team-accounts-order.test.tsx` (create if absent); add correlated result/unknown diagnosis in `scripts/analytics/queries.ts` and `tests/analytics-investigate-command.test.ts`.
- **Колишня 037** T035 [US7] Define the stable launch-to-РК and finance-placement read projection with null-versus-zero and unmatched reasons in `packages/shared/src/team/account-overview.ts` and `apps/web/src/api/team.ts`; do not join on labels or suffixes.
- **Колишня 037** T036 [US7] Implement the read endpoint/query for ordered socials and РК, launch rows, finance period and unmatched records in `supabase/migrations/20261203103000_account_launch_finance_view.sql` and `apps/web/src/api/team.ts`; preserve stable identity so a later archive remains resolvable.
- **Колишня 037** T037 [US7] Build the combined table, explicit period and unmatched section in `apps/web/src/team/accounts/AccountSpace.tsx` and a new `apps/web/src/team/accounts/AccountLaunchFinanceTable.tsx`; keep editing in existing source screens.
- **Колишня 037** T038 [US7] Test multiple launches, moved РК, zero versus no data, permissions and page consistency for active socials in `tests/team-account-launch-finance.test.tsx` and `supabase/tests/database/`.
- **Колишня 037** T044 [US8] Add database regressions for archive/restore, active-launch refusal, history preservation and permissions in `supabase/tests/database/team-accounts-archive.test.sql` (create if absent).
- **Колишня 037** T045 [US8] Add reversible `archived_at` state, versioned mutation and active-launch guard in `supabase/migrations/20261203104000_account_archive.sql`; extend the combined read projection for archived history in `supabase/migrations/20261203105000_account_overview_archive.sql` without editing the earlier migration.
- **Колишня 037** T046 [US8] Extend active/archived/all readers and typed archive calls in `packages/shared/src/team/accounts.ts`, `apps/web/src/api/team.ts` and `apps/web/src/team/accounts/useAccounts.ts`; remove archived socials from active pickers without hiding history.
- **Колишня 037** T047 [US8] Add archive action, archived view/search and restore feedback in `apps/web/src/team/accounts/AccountSpace.tsx` and `apps/web/src/team/accounts/AccountGroup.tsx`; explain active-launch refusal and preserve manual order.
- **Колишня 037** T048 [US8] Add UI and diagnostic regression for restore, history in the combined table, and refusal in `tests/team-accounts-archive.test.tsx`, `scripts/analytics/queries.ts` and `tests/analytics-investigate-command.test.ts`.
