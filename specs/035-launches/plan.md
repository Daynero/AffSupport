# Implementation Plan: 035 — Запуски

**Дата:** 12.10.2026. **Специфікація:** [spec.md](spec.md).  
**Feature context:** `035-launches`; фактична Git-гілка під час планування — `beta`, нова гілка не створювалася.  
**Статус:** дизайн і послідовність реалізації підготовлені; production rollout залежить від перевірок нижче. Код і міграції цим планом не створюються.

## Summary

Додати окремий модуль Launches усередині чинного простору Soty. Launch містить один URL, N кампаній та optional посилання Google Drive на каталог. Використати наявні акаунти, матеріали, Drive upload, product-catalog/restitch pipeline, UI inventory, Supabase RPC/Realtime та agent SSE. Новими є чисті генератори, зберігання конфігурації/незмінних результатів, coordinator етапів і поверхні Launches.

Найризикованіша частина — узгодити Drive side effects із idempotency, cancel та публікацією результату. Її реалізовувати в спільному catalog pipeline до підключення каталогу до Launch. Перша повна вертикаль — метод «Інше»; її контракти вже передбачають каталог, прогрес і скасування.

## Technical Context

- **Language/Version:** TypeScript strict, ESM/NodeNext, ES2022; Node `>=22.12 <25` за root package.json; Supabase Edge runtime для hosted IO.
- **Dependencies:** чинні React/Vite, HeroUI/React Aria, Supabase client, Fastify agent; нова routing/state/UI/queue бібліотека не потрібна.
- **Storage:** PostgreSQL для Launch/config/revisions/operations, Google Drive для material/catalog; існуючі grants для agent. Без нового bucket.
- **Testing:** central `tests/*.test.ts(x)`, Vitest/PGlite, database contracts у `supabase/tests/database`; чинний verify runner.
- **Platforms:** hosted web, agent на macOS/Windows для restitch. Метод «Інше» й каталог без restitch не потребують локального FFmpeg.
- **Performance goals:** локальний preview для N<=100 — ціль <50 мс на підтриманому desktop, без network/storage IO; list page <=50, max 100; progress без періодичного client polling. Це цілі приймання, не виміряні поточні показники.
- **Constraints:** literal URL preservation; один result URL; one creative; workspace ACL; no telemetry content; bounded provider work; незмінні версії; доведений output перед ready; cancel не дорівнює видаленню вихідних файлів.
- **Scope:** один розділ, list/editor/result/history, dictionaries/defaults, copy/archive, manual overrides; інтеграція наявного каталогу. Meta/AIO API не додаються.

## Constitution Check

Джерела: `.specify/memory/constitution.md` v3.0.1, `AGENTS.md`, `docs/DESIGN.md`, `specs/031-platform-autoanalytics/spec.md`.

| Gate                                | До research    | Після design / реалізаційна вимога                                                                                           |
| ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| I: shared types/boundary validation | PASS           | Domain у shared; Edge імпортує з rebuilt shared/dist за наявним precedent; unknown payload guards                            |
| II: release/protocol                | PASS           | Не змінювати version зараз; shared/agent зміни не оголошувати web-only release; build shared до перевірки contracts          |
| III: least privilege                | PASS           | RLS/revoke/grants; detail RPC для URL; membership і тариф перевіряються на сервері; production visibility gate окремо        |
| IV: processes/resources             | PASS           | Існуючий team restitch + PowerGovernor; без нового FFmpeg spawn; resumeForTermination/scaleTimeout зберігаються              |
| V: API/errors                       | PASS           | Existing team envelopes, stable machine codes; нові Launch states не підміняють team_operations enum                         |
| VI: composition/transport           | PASS           | Inventory/tokens/i18n; hosted Realtime, local SSE; один subscription owner на scope; жодного нового recurring client polling |
| Analytics end-to-end                | PASS у дизайні | Signals → guard → storage → read-only CLI; code map, coverage registry, missing evidence scenarios обов'язкові               |

Архітектурних винятків не потрібно. PASS означає відповідність дизайну, не виконані тести. Немає неузгоджених технологічних виборів, які блокують створення design artifacts. Зовнішні припущення про tracking URL і доступ до таблиці позначені як release gates в research.md; не вважати їх перевіреними.

## Project Structure

Артефакти планування:

```text
specs/035-launches/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/launch-api.md
  contracts/generation.md
  contracts/ui-and-url.md
```

Майбутні зміни (файлів реалізації зараз немає):

```text
packages/shared/src/team/launches.ts
packages/shared/src/team/launches/     # pure url, naming, budgets, validation; export через launches.ts
apps/web/src/team/launches/           # list/editor/result, draft, generation presenter
apps/web/src/team/product-catalog/   # витягнути reuse orchestration із dialog
apps/web/src/api/team.ts             # thin typed Launch wrappers
apps/web/src/team/routes.ts
apps/web/src/team/TeamSpace.tsx
apps/web/src/team/workspace/WorkspaceShell.tsx
supabase/functions/drive-ops/launches.ts
supabase/functions/drive-ops/product-catalog.ts
supabase/functions/_shared/operations.ts
supabase/functions/_shared/drive.ts
supabase/migrations/                 # тільки на implementation phase
supabase/tests/database/
tests/launch-*.test.ts(x)
scripts/analytics/                  # queries, inspect/investigate, code map, coverage
```

Новий parent coordinator у drive-ops управляє станами Launch і використовує чинні catalog/process operations. UI не копіює тіло CreateProductCatalogDialog. Pure генератори спільні для браузера та Edge. Detail-sensitive outputs не зберігаються в metadata каналі Realtime.

## Phase 0 — Рішення перед реалізацією

Виконано read-only дослідження та звірку специфікації; результати в [research.md](research.md). Зафіксовано:

- `sheetUrl` є потрібним користувачеві Google Drive посиланням.
- SUB mapping v1 — буквальні case-sensitive sub1/sub2/sub3, як уточнив користувач; дублікати зберігаються, їхні values змінюються всі разом.
- Поля warning для незаповненості та manual override мають різні текстові позначки при спільній помаранчевій ролі.
- Cancel і progress у catalog handler потребують розширення, вони не готові до reuse без змін.
- Таймерні оцінки й hardcoded operation progress не є фактичним відсотком.
- Технічні defaults із spec прийняті як робочі design decisions; зовнішня сумісність не вигадується.

## Phase 1 — Контракти й модель

Виконано в документації: [data-model.md](data-model.md), [API](contracts/launch-api.md), [generation](contracts/generation.md), [UI/URL](contracts/ui-and-url.md), [quickstart.md](quickstart.md). Повторна перевірка constitution — таблиця вище.

## Послідовність реалізації

### M1. Чистий домен і локальний preview

**Залежності:** немає. **Файли:** shared Launch contracts, export seams.

- Parse/validate config із discriminated unions для method/budgetMode/result kind.
- Спільний SUB normalizer: spaces→underscore, allowed ASCII, без транслітерації.
- Lossless URL patcher змінює тільки raw values точних ключів; untouched substrings не проходять serializer.
- Budgets Math.round, overrides rules, ads ranges; naming v1 із `adv+`; local calendar tomorrow, date-only snapshot.
- Edge імпорт із `packages/shared/dist/team/launches.js`; rebuild shared та Deno bundle smoke.

**Вихід:** exact golden vectors і purity, acceptance AC-02/03/06–15/39/40/46. Валідація єдина на web/Edge; DB додатково має structural constraints.

### M2. Зберігання й доступ

**Залежності:** M1.

- Нові таблиці, relations, immutable revision content; separate progress tables.
- Source resolution/snapshotting в одному прийнятті intent; optimistic versions для draft/meta/defaults.
- Atomic request journal, generation lock, compare-and-swap active revision; safe list vs protected detail.
- Dictionaries/defaults; per-member delete warning preference; audit/invalidation payload allowlist.
- Future forward-only migrations + rollback notes + generated DB types; no destructive rollout.

**Вихід:** ACL/cross-team/concurrency invariants; AC-04/19/24/25/27. Stage signals і CLI schema вводяться тут, не відкладаються до UI.

### M3. Повний сценарій «Інше»

**Залежності:** M1–M2.

- Навігація Launches, list/card/search; date controls Calendar → Yesterday → Today за Tasks, server filter до pagination.
- Form: поля, матеріали single selection, upload/drop чинним pipeline, inline dictionary creation.
- Required warning accent, desktop preview поруч із form, компактний age +.
- Explicit save/generate; bounded parent step transitions, pending UI навіть для короткого виконання; input lock.
- Result rows copy/inline edit, manual badge/reset/save revision, history; copy Launch із завтра/todo.
- Archive warning і user preference, збереження матеріалів.

**Вихід:** користувач завершує сценарій без каталогу; AC-01/05/16/21/26/33–38/41/42/44/45. Повний smoke плюс producer→CLI diagnosis для цього зрізу.

### M4. Посилити існуючий catalog pipeline

**Залежності:** M2; можна розробляти після M2 незалежно від UI M3.

- Extract orchestration із dialog, зберегти public API для старих callers.
- Прийняти operation/idempotency перед вибором random rows, sharing, reservation чи Drive write.
- Atomic variant reservation keyed by video + logical operation; replay result за operation ID, не max+1.
- Provider intent marker, persist Drive output ID, reconcile lost create response до будь-якого повторного create.
- Real checkpoints/counts, cancel checks/fencing до side effects і на finalize/link/publication.
- Розрізнити child material finalized і catalog registered: лише друге дозволяє ready.
- Persist output ownership, cleanup jobs для unpublished resources; доступність/помилки cleanup видимі.
- Mutation guard для Launch-linked catalogs у recreate/updater/trash paths.

**Вихід:** AC-18–20/28/32/43, existing catalog handler/XLSX/parity regressions. Цей milestone не може пройти лише за happy-path double-click тестом.

### M5. Catalog + restitch у Launch

**Залежності:** M3–M4.

- Durable coordinator checkpoints, одна catalog variation на version незалежно від кількості кампаній.
- Current restitch defaults, Drive pools, grants, RESTITCH_CONTRACT_VERSION, finalize.
- Persist exact source version і selected resources; retry catalog reuse-ить готове відео.
- Stage UI через team Realtime; локальний progress через agent SSE. No recurring polling, reconnect authoritative refetch.
- Cancel parent і child, cleanup власних output, then draft/previous result restored; input lock до settlement.
- Сервісний recovery розширює існуючий hosted worker scheduling pattern для bounded reconcile/cleanup. Це новий scope handler, не cron у браузері. Local processing без доступного агента лишається waiting_dependency.

**Вихід:** AC-17/18/21/29/32/41–43. Критерій успіху — linked catalog і committed Launch result, не просто 100% FFmpeg.

### M6. Зміни та співпраця

**Залежності:** M3; catalog-specific cases після M5.

- Dependency signatures: names-only reuse catalog; URL change reuse відео і new catalog; source/restitch change rerun affected stages.
- Explicit diff confirmation, immutable history, source revalidation; ручні overrides не копіюються непомітно в нову генерацію.
- Active generation блокує config/meta/overrides/archive mutations на сервері; робота з іншими Launch не блокується.
- Втрата членства, reconnect, stale replies, defaults conflicts, resource deletion/move.

**Вихід:** AC-22–25/27/30–38/44–46; data ownership і history integrity.

### M7. Приймання та підготовка релізу

**Залежності:** усі milestones.

- Виконати quickstart scenarios і AC-01–46, cross-platform restitch, accessibility/clipboard.
- Analytics guard-contract, sanitization, CLI authoritative reconciliation, unsupported/delayed signals.
- `nice -n 15 npm run verify`; потім `nice -n 15 npm run verify:release` у належному середовищі; build/shared contracts, exact-SHA beta за runbook.
- Перевірити CAPI/source URL exposure у Google Sheet workflow на синтетичних даних; визначений доступ за посиланням має бути явно врахований у product contract.
- Deployment лише окремим дозволеним release workflow; цей план нічого не публікує.

## Порядок і критерії переходу

M1 → M2 → M3 → M4 → M5 → M6 → M7. M4 можна виконувати паралельно з M3 після готового M2, але обидва потрібні M5. M6 для методу «Інше» може початися після M3. Не ставити дату завершення без оцінки catalog recovery spike.

Пріоритетний технічний spike у M4: crash між Drive create/finalize/link, доказ можливості reconcile за marker. Якщо existing Drive client/Google endpoint не дозволяє надійно розрізнити «не створено» і «ще не знайдено», safe outcome — interrupted з explicit resume, без blind recreate. Це допускається контрактом; claim exactly-once для всіх зовнішніх side effects не робиться.

## Complexity Tracking

Винятків із constitution немає. Нові revision/generation/step records потрібні для різних життєвих циклів: незмінний результат, mutable operation status, незалежний retry child stage. Task inheritance, parallel file store, універсальний workflow engine та нова UI library відхилені як зайві.

## Уточнені залежності після аналізу tasks

- **M1–M2:** typed expectedSourceSnapshot і атомарне збереження з draft; server comparison до accepted intent. Version самого Launch не замінює source expectation. Copy API передає current IANA timezone, сервер зберігає одноразово обчислену дату та replay result.
- **M3/M6:** RAM-only draft/overrides і protected-detail no-cache; manual dependency mismatch hints; explicit restore-config з історії через existing draft/save/generate. Dirty input, ACL, source refresh і optimistic conflict обов’язкові.
- **M4–M5:** recovery handler потребує migration `20261201113500_launch_recovery_dispatch.sql`, `catalog-updater/index.ts` dependency wiring і `private.invoke_catalog_updater_worker` due predicate. Самого підключення worker.ts недостатньо: чинний SQL dispatcher перевіряє тільки catalog/retired-copy work. Довести автономне просування єдиного Launch intent без браузера; не starvation під catalog backlog.
- **M7:** прийомка включає додаткові сценарії §20 spec та quickstart; ідентифікатори AC не змінюються. T037 включає dispatch+handler contract test; T019 — source expectation; T062 — copy timezone; T045/T050 — mismatch hints; T046/T051 — restore; T065 — browser storage privacy.


## Погоджене доповнення: типові налаштування офера

План пройшов незалежний аналіз агентами в ролях медіабаєра та дизайнера.

1. Зберігати профілі за стабільним ID офера у межах простору; загальні налаштування залишаються незалежними. Пріоритет для нового запуску: профіль офера → загальні → початкові. Перейменування не губить профіль, архівований або чужий офер недоступний.
2. Внизу форми дві видимі дії «Зберегти для офера» / «Зберегти як загальні». Генерація залишається єдиною основною дією. Пояснити сферу збереження, показати джерело значень, завантаження, повторення після помилки та конкретний результат збереження.
3. Зберігати повторювані поля: баєр, кількість кампаній/оголошень, цілісний бюджетний профіль (включно з ручними бюджетами), аудиторія, Advantage+, метод, каталог і порядок SUB. Виключити дату, timezone, РК, офер з payload, матеріал, креативні псевдоніми, URL, результати й ручні SUB.
4. На виборі/створенні офера автоматично підставляти профіль лише у новому запуску без ручних змін повторюваних полів. Інакше запропонувати застосувати профіль або залишити поточні. Повільні відповіді та realtime не перезаписують поточну форму. Збережений/скопійований запуск не змінюється автоматично. Перехід до офера без профілю пропонує/застосовує загальні, не профіль попереднього офера.
5. Сервер перевіряє права, scope та whitelist; версія захищає від lost update, ключ і незмінний payload забезпечують повторення після втраченої відповіді. Конфлікт переглядається саме для початкової цілі; перегляд не змінює чернетку.
6. Діагностика через typed operation events: читання/застосування/збереження, закритий scope, flow/attempt, успіх/відмова/скасування. Вміст профілю та назви не збираються. Втрачена відповідь не доводить відсутності серверного commit; відсутня доставка лишається unknown. Оновити capability inventory та перевірити sanitizer → stored events → CLI.
7. Регресії: незалежність профілів, права та архівація, версії/replay, ручні бюджети, A→B з відповідями навпаки, редагування під час читання, fallback, новий/існуючий запуск, разові поля, помилки й retry. Потім повторне рев’ю обома агентами, виправлення та npm run verify.

До плану включено пропозиції баєра про атомарний бюджетний профіль та fallback A→B; дизайнера — точні назви кнопок, правдиве джерело налаштувань, окремі scope-specific conflict/success стани й видимі назви на вузькому екрані.


### Повторне рев’ю реалізації

Обидва агенти повторно перевірили реалізацію. Виправлено всі зауваження: пропозиція старого профілю очищується після save; оновлення версії після конфлікту відокремлено від застосування; conflict review показує режим і точні ручні бюджети; offer RPC відхиляє NULL; початкові значення мають власний текст; кнопка показує pending; повідомлення конфлікту нейтральне до scope, а старий success зникає після редагування. Обидва рев’юери підтвердили відсутність блокерів у виправленому коді. Висновок дизайнера щодо вузького екрана базується на коді, не на реальному мобільному рендері.


### Перевірка реалізації

- 74 тести проходять у шести профільних suites: API whitelist/receipt parsing, SQL scope/permissions/RLS/version/replay/NULL guard, hook application/races/budgets, conflict review, повний LaunchSession save/retry/conflict та analytics producer → sanitizer → storage → CLI. Після останньої правки 43 тести LaunchSpace/LaunchSession повторно пройшли, включно зі старим бюджетним профілем без minBudget.
- Повна перевірка типів застосунків пройшла. Помилку інференсу нового renderHook helper виправлено; повторна перевірка всього дерева тестів також пройшла (`npm run typecheck:tests -- --incremental --tsBuildInfoFile /tmp/launch-defaults-tests.tsbuildinfo`).
- Адресні ESLint і Prettier для змінених TS/TSX файлів проходять; i18n, design tokens і Tailwind gates проходять.
- Загальний `npm run verify` не зелений: full-repository format та lint перевищили 300000 ms у середовищі з паралельними важкими перевірками, тому загальна suite не стартувала. Це обмеження повної перевірки, не успішний global verdict. Production і beta не змінювалися; міграцію треба доставити звичайним релізом до нового web-коду.


## Покращення вибору РК

Вибір лишається одним searchable SelectMenu з інвентарю. Пошук явно пропонує назву соца або ID і підтримує кілька слів у довільному порядку. Варіант показує назву соца, повний ID РК та впізнаване коротке закінчення; вибір має галочку. Повний ID залишається під вибраним полем, щоб однакові закінчення в одному соці не маскували різні РК. Порядок простору зберігається. Архівовані рядки не пропонуються; зниклий поточний вибір не замінюється автоматично. Є окремі empty/no-results стани, клавіатурний вибір та відновлення підпису після незавершеного пошуку.

Діагностика використовує чинні typed source-refresh/save_draft/generation seams. Пошуковий текст та ID/назви не додаються до телеметрії. Успішний локальний вибір не оголошується серверним збереженням; підтвердження дає існуючий autosave receipt і protected draft/source snapshot. Непідтверджені локальні редагування лишаються явною сліпою зоною. Приймання: пошук за повним ID/змішаними словами, однакові suffix, клавіатура, відмова від пошуку, недоступні/архівовані рядки, locked input, незмінні callback-и інших SelectMenu та генерація назв кампаній із вибраного ID.


Перевірка вибору РК: 17 профільних тестів (новий selector, чинний dictionary selector, редактор/preview) проходять після виправлення повторного фільтрування React Aria за одним лише label; ще 12 UI-регресій пройшли окремо. Через навантаження локального середовища профільний повтор виконувався одним worker з test/hook timeout 120000 ms; часові ліміти репозиторію не змінювалися. Перевірка типів web, ESLint, дизайн-токенів, Tailwind та i18n пройшла. Відкрита beta на 5175 належить іншій робочій копії (AffSupport-036-acceptance); її файли, активна форма та база не змінювалися. Візуального browser smoke нового компонента на цій beta не заявляємо.


## Компактне збереження типових налаштувань — UX перегляд

Два незалежні рев’ю (баєр 43/100, дизайнер 46/100) виявили змішування збереження, застосування та довідки. Узгоджений план: окрема компактна полиця «Зберегти налаштування»; «Для офера» — виразна зелена дія, «Як загальні» — нейтральна рамка, поруч короткі області дії. Склад профілю відкривається інфо-кнопкою через доступний Popover. Великі постійні абзаци й статус «Змінено» прибираються. Збережений профіль пропонується окремим рядком із попередженням заміни й двома явними кнопками. Немає профілю або параметри вже однакові — немає пропозиції застосування. Ручні правки, версії, права, frozen retry intent і конфлікти лишаються захищені.

Приймання: два scope викликають правильний save, назва офера й fallback загальних зрозумілі без hover, loading/error/no-offer/read-only/conflict/retry мають коректні доступні дії; довідка працює з touch/клавіатурою й Escape; довга назва й вузький viewport не створюють горизонтального прокручування. Повторні незалежні оцінки використовують фактичний рендер і тести, а не цільову оцінку як доказ.

Аналітика: чинні read/apply/save flow та attempt IDs, partial/failed/cancelled outcomes і підтвердження save лише після видимого feedback залишаються. Прихована builtin-пропозиція, відмова від apply та читання довідки не є операціями і не збираються. Відсутня доставка сигналу лишається unknown; діагностика використовує protected profile/version/idempotency receipts. Назви, значення й пошуковий текст не збираються. Inventory launches.defaults.* уточнено.


UX перевірка: перша реалізація отримала 96/100 (баєр) і 95/100 (дизайнер); виправлено двозначні тексти застосування та помилки читання. У browser320px знайдено переповнення довгого Retry — короткий видимий підпис «Повторити» з повною доступною назвою. Додатково перевірено normal/proposal/no-offer/loading/error/pending, 390/320px, довгу назву, info Enter/Escape/focus return. Горизонтальний scrollWidth дорівнює clientWidth у перевірених вузьких станах. Обидва фінальні незалежні UX вердикти — 99/100, без блокувальних зауважень. Це оцінка локального рендеру реального компонента з synthetic props, не реального beta-сценарію.

67 профільних регресій пройшли: controls, default resolution, workspace integration (scope versions/conflict/idempotent retry), API та operation observation. Перевірка стабільності autosave layout тепер очікує завершення асинхронного завантаження defaults перед виміром: для non-manager порожній defaults блок більше не рендериться. Тестовий preview видалено після візуальної перевірки.

Фінальні перевірки цієї ітерації: web TypeScript build, цільовий ESLint, Prettier, дизайн-токени, Tailwind та i18n пройшли. Після останніх copy/type правок 5 тестів controls повторно пройшли. Повний repository verify у цій UX-ітерації не запускався; 67 — профільний набір, а не весь suite. Beta з іншої робочої копії не змінювалась.


Подальша UI-правка за скріншотами: генерація перенесена в той самий flex-ряд із кнопками збереження через primaryAction slot; окрема широка фонова плашка та її мобільне sticky-оформлення прибрані. Усі locks/handler/доступні назви збережені, генерація лишається доступною для editor без manage. SUB використовують label FormField над кнопкою, scoped column layout справжнього ui-field-control, рівні відступи та окремий переносимий preview. Локальний browser підтвердив однакову top-координату трьох кнопок на desktop і scrollWidth=clientWidth=390 на мобільному. Зміни компонування не додають нових операцій чи телеметрії; чинні save/apply/generation receipts залишаються діагностичним доказом.


Універсалізація тривалості (уточнений scope оунера): RestitchDurationControl з інвентарю містить рамку, перемикач режимів, перетворення секунд/хвилин та DurationSlider. LaunchEditor став одним споживачем; інші місця не мігруються до окремого запиту. Компонент не виконує IO/analytics, чинні autosave/generation спостереження та seconds-based payload збережені.

Шапка: вкладки й status об’єднано в один sticky header; top offset перекриває scroll padding модального вікна, тому поля більше не просвічують над шапкою. Browser layout smoke використав реальний Modal і ті самі header classes: при scrollTop1592 на mobile headerTop25 = dialogTop24 +1px border; status і вкладки видимі. Перевірка типів, lint і 65 профільних тестів проходить (тест catalog selector оновлено на нову загальну CSS-назву й повторно виконано). Тимчасові preview файли видалено.
