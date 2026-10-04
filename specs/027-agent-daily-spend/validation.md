# Перевірка реалізації 027

Стан: **реалізація триває**, не готова до production rollout. Позначки в `tasks.md` залишаються джерелом обсягу незавершеної роботи.

## Виконані перевірки

### Повторна візуальна правка після порівняння screenshots

- Попередній flex-based daily layout не відповідав operational view. Замінено на ті самі account/list/agent shells і стилі: 56px minimum row, shared identity typography, account hue/rail/gradient/mark/toggle, counts/tag summaries, міжгрупові відступи. Captions лише один раз зверху на desktop; mobile зберігає підписи полів.
- Accounts + financial fields: 56/56; finance group regression: 1/1, згортання не демонтує draft. Web TypeScript, design-token і Tailwind пройшли.
- Responsive layout пройшов 320/390/768/1600 px та mobile light/dark. Real browser parity assertions підтвердили однакові min-height, font-size identity, rail color і heading gradient для двох режимів. Write/save-all/clear/Undo/history/transfer/month/export workflow пройшов, HTTP 200 / 4801 bytes. Production не змінювався.

### Оновлення 2026-10-04: користувацькі правки

- Source beta використовує той самий range calendar control, що й завдання. Діапазон обмежено 366 включними днями у UI, SQL та DTO; міграцію 107000 застосовано тільки до локального loopback PostgreSQL, без видалення чи reset даних.
- Feature/accounts: 21 файл, 106/106 тестів, включно з трьома real PostgreSQL concurrency tests. Shared task calendar + toolbar: 8/8. TypeScript web, design-token і Tailwind gates пройшли окремо.
- Responsive synthetic layout: 320/390/768/1600 px без горизонтального переповнення; monthly light/dark 390 px також без переповнення.
- Excel завантажено звичайною кнопкою в Safari: `finance-…-2026-10-04-2026-10-04.xlsx`, 5 КБ у Downloads. Без Playwright forwarding. Source beta Vite запущено з явним `SOTY_BETA_FINANCE_NATIVE=1`; unchanged Edge entrypoint слухає 54329 і перевіряє справжній user JWT. Без цього прапорця proxy використовує канонічний локальний Edge 54321; packaged beta/production не використовують dev proxy.
- Повторний real browser workflow завершився: write/draft/save-all/clear/Undo/month/transfer пройшли, footer лишається всередині видимої області після прокрутки, header layer вищий за date cells. Export без route forwarding: HTTP 200, private no-store, справжнє завантаження 4801 байт. Тимчасовий власний QA workspace видалено; користувацький beta workspace не змінювали.
- У Safari вручну вибрано 1–3 жовтня через два кліки спільного календаря: таблиця має саме три дати, Spend 217.25 / Topup 200.00. Excel для цього довільного проміжку також завантажився у Downloads, 5 КБ.
- `SOTY_VERIFY_SERIAL=1 npm run verify -- --gates=static`: 13/13 gates PASS, 261 с; формат, lint, усі typechecks, tokens, Tailwind, styles, i18n, env registry, CSP, audit. Це static verification, не packaged beta/release verification і не coverage run.

### Оновлення 2026-10-03: браузер і UX

- Наступний інкремент: Tabs матриця/підсумки/виписка, повернення до місяця з метрикою/scroll/focus, тристороння навігація з Save-all, пошук цільового соц і same-day history explanation. Browser workflow пройшов, включно з save-all та відновленням фокусу дати.
- Послідовний feature/accounts прогін `npx vitest run tests/team-agent-finance*.test.ts tests/team-agent-finance*.test.tsx tests/team-accounts.test.tsx --no-file-parallelism`: 21 файл, 103/103, 122 секунди; реальний PostgreSQL concurrency 3/3. Це результат до двох додаткових assertion/case у transfer delete regression.
- Перед ним паралельний прогін провалився через 18 test/hook timeouts; не змінювали timeout або assertions, повторний послідовний прогін пройшов. Static attempt: усі typechecks і lint пройшли, formatter перевищив штатний 180-секундний бюджет. Це не green full verification.
- Forward migration `20261003106000_team_agent_finance_delete_compatibility.sql` застосована тільки до локального PostgreSQL: no-money transfer не перешкоджає видаленню агента; former social захищений, якщо агент має фінансову історію. Перед реалізацією тест відтворив FK failure, після реалізації schema+transfer 8/8.
- Workbook тепер має metadata 1–3, social 4, agent 5, dates з 6, freeze 5. Finance XLSX + catalog regression 10/10; browser native-export повторний запуск під навантаженням повернув 500, тому його не зараховано як новий PASS.
- `beta:doctor` пройшов; `beta:up` не підняв повне середовище: Docker OCI health-check повертає input/output error, stack unhealthy. Застарілий ownership record із трьома відсутніми PID та порожнім writtenEnvironment збережено як `release/automation/beta-service.stale-20261003.json`, не видалено. Ні reset, ні stop сторонніх контейнерів не виконувалися.
- Source web beta на loopback 5175 відкрито в Safari через справжню локальну auth session. Agent 43140/канонічний Docker Edge не запущені; це не packaged-beta verification і не доказ повної beta readiness.
- Після завершення важких gates повторний real browser workflow/native Edge download пройшов: HTTP 200, browser XLSX 4800 bytes, ZIP/MIME/private headers. Збережено один синтетичний LOCAL preview workspace для ручної перевірки; решта тимчасових просторів прибрані. Остаточний transfer-delete suite 4/4 також пройшов, включно з видаленням former social без грошей та захистом former social після грошей у новому соц.
- Другий parallel static attempt: 11/13; format (180s) і Tailwind (60s) перевищили штатні бюджети. Наступний запуск використовує наявний `SOTY_VERIFY_SERIAL=1`, без зміни timeout/gates.
- Остаточний `SOTY_VERIFY_SERIAL=1 npm run verify -- --gates=static`: 13/13 PASS, 212 секунд, без зміни gates/timeout. `verification-result.json` містить цей успішний результат (coverage не вимірювалась).
- Для ручної перевірки залишено локальний простір «Бета · Фінанси (тестові дані)»: `http://127.0.0.1:5175/team/2c730907-0984-4945-bbb1-1452461a2c67/accounts`. Відкрито в Safari, активний вид «Щоденні фінанси»: balance 70.00, topup 200.00, spend 150.25; минулий місяць 140.30. Дані синтетичні. Канонічний Excel endpoint у цій веб-беті лишається недоступним до відновлення Docker Edge; успішний download вище використовує явне перенаправлення тестового стенду на native helper.

- Повний fast verification після основних UX-змін: 14/14 gates, 4157 тестів, 10 skipped, 584 секунди. Після останніх змін явної дати імпорту, стилів і Edge error response: targeted suite 61/61 та static gates 13/13 (39 секунд). Повний fast suite повторно після цих останніх змін не запускався.
- `validation/check-finance-workflow.mjs` перевірив реальний AccountSpace з beta auth і локальними RPC: comma amount, authoritative reread, invalid Tab/Escape, draft persistence між видами, порожній наступний день, історичні значення, single clear/Undo, batch retry після реально виконаного запиту з втраченою відповіддю, місячний drill-down, transfer зі збереженням UUID/історії. Runtime errors: 0. Тимчасовий тестовий простір видалено в finally.
- Світла/темна тема 390 px: page overflow 0, monthly horizontal/vertical scrolling і sticky date header перевірені. Переглянуто фінальні PNG світлого дня й темного місяця.
- Реальний browser download XLSX: HTTP 200, 4757 bytes, ZIP signature, MIME і private headers перевірені. Незмінений production entrypoint запущено через локальний Deno helper на loopback 54329; це НЕ перевірка Docker Edge runtime. Виправлено дублювання Authorization header у Supabase SDK, яке реально ламало auth.
- Legacy import тепер вимагає явного вибору дати; новий regression test пройшов. Фіксована пауза браузерного входу замінена очікуванням навігації.
- UX-висновки та відкриті питання: [ux-review.md](ux-review.md). Нижче збережено історичні результати попереднього інкременту; закриті цією секцією обмеження не слід трактувати як актуальні.

- `npm run verify`: 14/14 gates пройшли, 4150 тестів, 10 пропущених; 527 секунд. Coverage цей fast-запуск не вимірює. Запуск завершився до останніх змін форми створення агента, ширини фінансових полів і окремого підтвердження legacy import.
- Після цих змін: `tests/team-accounts.test.tsx`, `tests/team-agent-finance-fields.test.tsx`, `tests/team-agent-finance-operations.test.ts` — 57/57 тестів пройшли. Перевірено передачу IANA timezone від форми, збереження Tab без блокування навігації, повний rollback batch при stale CAS та відмову Undo після новішого редагування.
- `npm run verify -- --gates=static` після останніх змін: 13/13 gates пройшли, 35 секунд. Попередня спроба виявила пропущений `timezone` у типі `AccountsClient`; тип виправлено. `git diff --check` пройшов.
- `tests/team-agent-finance-lifecycle.test.tsx`: новий тест спочатку зафіксував відсутність окремого підтвердження імпорту; після реалізації пройшов. Підтверджується дата, USD та вручну внесена сума, яка може відрізнятися від legacy original.
- `tests/team-agent-finance-report.test.ts`: 3/3. Точні великі суми, порожнє ≠ нуль, X→Y→X, dated copy без повторення платежу за кількома тегами.
- На локальному PostgreSQL: concurrency e2e 3/3 (same metric, different metrics, delete/write), pgTAP 10/10. Другий connection реально очікував PostgreSQL lock; це не послідовна симуляція в PGlite.
- Шість finance migrations застосовані лише до локального Supabase; local database types згенеровані зі схеми, не з linked production.

## Візуальна перевірка

`validation/check-finance-layout.mjs` — ізольований браузерний стенд. Він використовує справжній локальний beta-вхід, але **синтетичну read-only відповідь** finance snapshot; жодних записів у простір не робить. Це не повний end-to-end сценарій AccountSpace.

Денний модуль перевірено на ширинах 320, 390, 768, 1600 px: горизонтальне переповнення сторінки 0 px. Використані довга українська назва соц, повний ID із початковими нулями та максимальні суми. Після візуального огляду поля розширено до 144 px: сума `999999999.99` видима повністю. Скриншоти збережені в `validation/finance-*.png`; переглянуто 390 px у темній темі.

Стенд запускається при локальному beta web на `127.0.0.1:5175`. Для іншої інсталяції Chromium задати `FINANCE_CHROMIUM_PATH`. Точний Vite HMR URL залежності toast важливий, інакше стенд створює два різні context instances.

## Обмеження й залишок

- Потрібні повний release verification, coverage, вимірювання p95 на 500 агентах та повний UI workflow місячного звіту/перенесення/очищення/Undo.
- `npm run test:db` не запустив pgTAP через Docker I/O error при створенні контейнера. Натомість finance pgTAP виконано транзакційно через локальне TCP-з'єднання PostgreSQL. Це не замінює весь canonical database gate.
- Edge entrypoint ще не перевірено у запущеному локальному Edge runtime: Deno відсутній, створення Docker-контейнерів має зазначену помилку. Handler та binary download мають окремі тести.
- Потрібні світла тема, monthly sticky scroll, keyboard/focus, повний layout gate AccountSpace та ручна перевірка контрольного XLSX у Excel.
- Старі money write handlers ще зберігаються в compatibility/test seam; production UI їх приховує, а старі серверні RPC відмовляють fail-closed. Остаточна заміна T033 не завершена.
- Потрібні решта concurrency permutations, batch/Undo UI retry, imported-event links, copy grouping UI за тегами, offline/logout/permission lifecycle та browser-back draft guard.
- Видалення агента після перенесення без грошових записів потребує додаткового узгодження з transfer FKs та тестом T008. Застосовані міграції не редагувати; виправлення — лише forward migration.

Production, stable manifests, версії, Git tags, releases і deployments не змінювалися.
