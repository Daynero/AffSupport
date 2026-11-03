# Перевірка виправлень лагів Простору

Дата: 3 листопада 2026. Це локальні докази для поточних змін, не сертифікація
місткості production і не exact-SHA beta promotion record.

## Що перевірено

`tests/workspace-synthetic-sessions.test.tsx` запускає справжні `TeamProvider`,
Realtime invalidation, `useTasks`, `useFolderPage` та `useCatalogSearch` у 3 і 10
одночасних React instances. Є варіанти однієї спільної та окремих команд.
Після initial load кожен instance отримує 10 catalog-only сигналів; змінений
лічильник каталогу має дійти і до folder state, і до search state.

RPC та Realtime transport замінені контрольованими seams; відповіді мають
штучну затримку 25 ms. Немає справжніх акаунтів, JWT, HTTP, RLS чи процесів
браузера. Слово «session» у назві тесту означає React instance.

| React instances | Команди | Зайві task reads | Зайві team-list reads | Потрібні folder reads | Потрібні search reads |
| --------------- | ------- | ---------------- | --------------------- | --------------------- | --------------------- |
| 3               | спільна | 0                | 0                     | 30                    | 30                    |
| 3               | окремі  | 0                | 0                     | 30                    | 30                    |
| 10              | спільна | 0                | 0                     | 100                   | 100                   |
| 10              | окремі  | 0                | 0                     | 100                   | 100                   |

У всіх чотирьох сценаріях контрольований RPC p95 = 25 ms; верхня межа p95
«catalog signal → актуальний hook state» = 1050 ms. Це fake-clock результат
із секундним Realtime debounce, а не виміряна швидкість сервера чи browser paint.
Значення перевіряє проходження оновлення, а не лише завершення Promise.

Історичний reproducer до виправлення виміряв **на одному клієнті** 10 додаткових
task reads і 10 team-list reads на 10 catalog-only ticks. Для 3/10 клієнтів
30/100 зайвих запитів кожного типу були б лише арифметичною екстраполяцією;
старий код у 3/10 справжніх браузерах не навантажували.

Команда:

```bash
npx vitest run tests/workspace-synthetic-sessions.test.tsx --maxWorkers=1 --no-file-parallelism
```

Протокол поточного запуску: `/tmp/soty-lag-investigation/synthetic-sessions.txt`.
Чотири сценарії пройшли. Повний час тестових сценаріїв — близько 1.8 s;
час запуску runner залежить від локального навантаження.

## Межі розділення Realtime-подій

Catalog, storage health та updater/registry мають окремі revisions. Класифікатор
`catalogEventDomains.ts` спирається на чинний CHECK `team_catalog_events`:

| Подія                                                                    | Одержувачі                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `folder_indexed`, `thumbnail_ready`                                      | каталог і storage health; без updater/registry                       |
| `storage_state`                                                          | каталог, storage health і metadata команд; без tasks/members/updater |
| `upserted`, `tombstoned`, `restored`, `sync_state`, `bulk_trash_changed` | каталог, storage health, updater/registry                            |
| відсутній або невідомий `event_kind`                                     | консервативно каталог, storage health, updater/registry              |

`storage_state` означає також зміну доступності або назви Drive root, тому
metadata перечитуються окремо від membership/task invalidation. Терміновий
membership signal і reconnect продовжують оновлювати всі потрібні домени.

Це часткове безпечне звуження: чинні updater/profile producers самі пишуть
`sync_state` та `upserted`. Відключити updater на кожному звичайному `upserted`
без нового контракту producer означало б пропускати його зміни. Ці події та
нетипізовані image/operation signals поки зберігають консервативний fan-out.
Повного усунення інцидентних updater reads ця зміна не доводить.

Додані матричні регресії `tests/team-catalog-event-domains.test.ts` та інтегрована
перевірка `TeamProvider` у `tests/team-realtime.test.tsx`: відокремлені updater
і storage revisions, metadata refresh, сумісність неоднозначних та майбутніх
подій. Їхній результат входить у фінальний gate run; окремого performance
виміру для updater/registry тут немає.

## Генерація під час паралельної роботи

`tests/launch-catalog.test.ts` додатково перевіряє 3/10 паралельних викликів
справжнього durable generator з recording provider/store seams:

- конкретна credential dependency повертає `NEEDS_REAUTH` до pool draws і створення файла;
- інший запит втрачає відповідь Drive після фактичного create;
- здорові запити завершуються незалежно;
- повтор відновлює втрачений результат за intent marker;
- після recovery та повторного registered replay кожен запит створив і фіналізував
  рівно один Sheet.

Усього 24 тести цього файла пройшли. Існуючі сценарії також перевіряють fences,
missing settings, зміну binary source, відмову image authority і provider retry.
Це перевірка правильності, не вимірювання DB contention або швидкості Drive.
Не додано загального блокування каталогів до завершення scan. Серверні sync
limits збережені: global lease bound 3, окремі connection leases, claim limit 1.

## Окремий експеримент із cron cleaner

```bash
SOTY_TEST_DB_SOURCE_PROJECT=<existing-local-project> nice -n 15 node scripts/diagnose-cron-retention-local.mjs
```

Скрипт читає тільки image identity локального Supabase container. Він створює
власний disposable PostgreSQL: 1 CPU, 512 MiB, без swap, без мережі, із вимкненим
scheduler. Ні source schema, ні application rows, ні credentials не копіюються.
Після перевірки власний container і його volumes видаляються.

Fixture містить мінімальну synthetic `cron.job_run_details` із primary key
`runid`. Скрипт запускає `EXPLAIN ANALYZE` victim selection з тим самим cutoff
predicate та limit, а потім точну функцію cleaner із migration source.

| History rows | Expired rows | Victim selection         | Фактично видалено |
| ------------ | ------------ | ------------------------ | ----------------- |
| 10 000       | 0            | 1.36 ms, повне читання   | 0                 |
| 10 000       | усі          | 0.19 ms, PK index scan   | 500               |
| 500 000      | 0            | 140.91 ms, повне читання | 0                 |
| 500 000      | усі          | 0.22 ms, PK index scan   | 500               |

Виклик точної cleaner function разом із docker/psql overhead займав 42–87 ms.
Ці числа не порівнюються безпосередньо з внутрішнім query execution time.
Структурний ризик повного читання за відсутності expired rows підтверджено.
Інцидентні 67–96 s не відтворено; першопричину cleaner не доведено. Production
індекси, cron schedule, worker/connection limits і вартість інстансу не змінено.
Звіт: `/tmp/soty-lag-investigation/cleaner-synthetic.json`.

## Діагностичне покриття і конкретні залишки

Інвентар `scripts/analytics/coverage-registry.ts` уже розділяє:

- `team.find`: emitted attempt start/terminal; query text не збирається;
- `team.index`: aggregate index/previews outcomes; per-folder scan evidence через `sync`;
- поточні task list/read/create/update/editor journeys: operation lifecycle;
  legacy `team_task_completed` лишається явно unsupported;
- launch generation: authoritative `analytics_launch_generations`, stages,
  attempts та safe codes; це не standalone catalog generation.

Додано migration `20261207113000_catalog_generation_diagnostics.sql`:
вузький view над `private.catalog_generation_intents` з opaque IDs, attempt,
закритими state/code, created/updated timestamps і booleans присутності
settings/source/rows/provider result. Присутність checkpoint означає
спостереження, а не підтвердження поточної dependency readiness.
Checkpoint/request/result JSON, назви, URL, provider IDs та payload не видаються.
SELECT дозволено service role та dedicated analytics role; anon/authenticated
доступу не мають. Migration підготовлено локально, production не застосовано.

`investigate.catalog_generations` читає максимум 100 поточних snapshots,
повідомляє truncation, відсутній view/grant і невідомі state/code. Для `--as-of`
повертає явну historical blind spot замість реконструкції минулого з поточного
стану. Історія всіх переходів, intermediate latency та browser delivery
залишаються неспостережуваними. Неповний snapshot не називається успіхом.

`tests/analytics-catalog-generations.test.ts` виконує справжню migration/view SQL
у PGlite: checkpoint projection, actual grants, повний `investigate` через
privacy guard, історична невідомість, невідомі коди/стани та відсутній view.
Чотири тести пройшли; разом із чотирма synthetic-session сценаріями — 8/8.
Це не заміна повного migration-chain test у disposable Supabase PostgreSQL.

## Що ще не є доведеним

Повний authenticated mixed workload з initial indexing, membership/task reads,
search та generation у справжніх 3/10 браузерах не виконаний. Немає production
SC-002/SC-003 verdict, 30% resource-headroom proof, 5-minute error-rate window
або 10-minute recovery observation. Відсутні великі metadata/media fixtures
та реальні auth/500/504 transport faults у цьому новому сценарії.

Feature 042 прямо лишає відкритими authenticated workload orchestration,
correct-result native-browser probes, verified target binding і stop/recovery
(T066/T068/T069/T072/T179/T180/T181). Наявний acceptance CLI має fixtures,
calibration, local smoke та resource primitives, але не готовий повний load runner.
Запущені локальні DB containers і наявний `.env.beta` не доводять exact-candidate
beta readiness. Їх не скидали, не змінювали й не використовували як production fallback.

Для рішення про дорожчий сервер потрібний наступний виміряний isolated/verified
target workload після зменшення fan-out. Локальні regression результати цього
документа не дають підстав обіцяти конкретну production місткість або купувати
більший інстанс.

## Додаткові виправлення після незалежного перегляду

- Deadline охоплює очікування auth SDK та HTTP. Після 15 s запит скасовується,
  owner звільняється, UI може повторити читання; пізня відповідь не застосовується.
  `WORKSPACE_READ_TIMEOUT` — закритий діагностичний код із code-map. Він не
  доводить скасування SQL на сервері й сам по собі не визначає домен запиту.
- Strict folder reload зберігає strict intent через queued follow-up, очищає
  підтверджено порожню папку та відхиляє підтвердження після unmount/scope change.
  Звичайні sync сигнали не відкидають кожне проміжне читання нескінченно: список
  лишається прогресивним, а остаточний refresh чекає останній dirty follow-up.
- Actor, team та підтверджені permissions задають lifetime workspace subtree.
  Звичайний membership сигнал менеджеру не закриває всі його чернетки.
  Access revision окремо інвалідовує захищені read caches. Невдала перевірка
  paused-state не оголошується доведеним видаленням учасника.
- Task cache очищається при зміні actor/access і не записує старі рядки під
  новим filter key. Pagination і mutation replies мають scope fences;
  старий read не затирає підтверджену mutation, за потреби виконується follow-up.
- Polling прихованої вкладки зупинено, повернення запускає один catch-up.
  Health index polling має одного власника; shell опитує лише видимий explorer.
  Помилки recurring reads мають bounded backoff, явний retry його обходить.

## Межі релізу

Є shared-code і SQL view changes, тому це не чистий web-only mini release.
Нову migration не застосовано до production. Для активації потрібний штатний
повний release path і packaged-beta proof точного commit; поточний dirty
checkout на `release/1.3.0` таким proof не є, незмінний опублікований реліз не
перезаписується.

Read-only beta doctor виявив зайняті порти 43140, 5175, 54321, 54322, 54324.
Наявну beta/локальні сервіси не зупиняли й не скидали. Це не доказ готовності
цієї beta до перевірки нового candidate. Протокол: `/tmp/soty-beta-doctor.log`.

## Суміжні приватні кеші

Повторний audit module-level Maps знайшов ту саму відсутню actor/access межу
в labels, preview grants, thumbnail sessions і material notes. Виправлено:

- tasks і labels: спільний hook-owned cache механізм, 20 views, TTL 60 s;
- labels: hook-owned cache, 20 entries, TTL 60 s, serial/deadline reads;
- preview grants: access epoch і stable provider identity, до 200 entries,
  expiry purge, спільний in-flight і заборона late refill після clear;
- thumbnail sessions: до 20 scopes, один pending mint на team/provider,
  deadline 15 s і заборона late refill; old pending TTL/safety-margin mismatch
  більше не створює повторні mint requests;
- material notes: scope/provider keys, до 200 entries/pending reads, спільні
  reads, bounded deadline/abort та версійний fence від старого read після save.

TeamProvider змінює private epoch перед відображенням нового actor/access;
власний unmount очищає межу. TaskAttachmentTile передає stable provider identity
й оновлює вже показані grants при зміні epoch. Це не переписує finance drafts.
Скасування task/assignee reads тепер має cancelled terminal без unknown failure;
закритий workspace timeout збережений у task/member diagnostics і code-map.

Локальні subresource tickets уже мають origin/token epoch і late-reply fence;
цей окремий механізм не змінювався. Локальні transcription document caches та
native entitlement retirement не переписувалися в межах workspace виправлення.

## Перевірки candidate

Збірки `build:web` / `build:agent`, release/team contracts, browser accessibility
і CSP пройшли через `npm run verify:release -- --gates=build,e2e`.
Його database gate спочатку зупинився на consent-вимозі непінованого CLI v3,
а не на SQL failure. Повторено тільки affected database gate зі штатним runner
і зафіксованим CLI 2.117.0, без змін universal runner:

```bash
SOTY_TEST_DB_SOURCE_PROJECT=r2beta045 nice -n 15 npm exec --yes --package=supabase@2.117.0 -- node scripts/test-db-isolated.mjs
```

Результат: повний migration chain; **44 SQL-файли / 1 054 pgTAP assertions**,
**2 auth PostgreSQL tests** та **35 native PostgreSQL concurrency/recovery tests**
пройшли. Owned disposable DB/Auth containers видалені. Існуючі stack containers
не змінені. Логи: `/tmp/soty-performance-release-checks.log` і
`/tmp/soty-performance-database-retry.log`.

Перший fast run зупинився на двох тестових регресіях; вони виправлені без
послаблення перевірок: deterministic barrier замість sleep і очікування
асинхронного початку member read. Два старі search call assertions оновлено
для AbortSignal. Повторний focused run: **71/71**; ширший preceding focused run
дав 280 успіхів і ці два вже виправлені search assertions.

Фінальний `npm run verify` виконується на зафіксованому source. Ідентичність
змінених source files збережена в
`/tmp/soty-lag-investigation/final-candidate-source.json`; це локальна контрольна
сума, не commit/promotion proof. Фінальний verdict додається після завершення.

## Усунення bundle-budget regression

Фінальний прогін після перебудови виявив реальний download-budget failure:
shared/existing приріст 41 730 B при незмінному ceiling 38 000 B. Після
дедуплікації cache/lifetime guards і deadline ownership він лишався 41 786 B;
менша кількість source lines сама по собі не є gzip-покращенням.

Виправлено build-only представлення словників: 4 032 спільні ключі English/UK
зберігаються один раз, значення — окремими векторами. Authoring/type-файли й dev
поведінка збережені. Static AST parser відхиляє невідомі/динамічні форми замість
часткового перекладу. 20 тестів перевіряють усі значення, порядок ключів,
prototype/descriptors та lifecycle plugin. Runtime локалізації не втратив ключів.

Фактичні gzip-метрики готової збірки:

| Метрика                |             Після виправлення |
| ---------------------- | ----------------------------: |
| Locales                |   114 497 B, раніше 140 163 B |
| Усі JS/CSS assets      |                   1 118 370 B |
| Accounts exclusive     |                      79 810 B |
| Launch exclusive       |                      48 791 B |
| Shared/existing growth | 16 148 B при ceiling 38 000 B |

Жодний baseline, allowance чи budget test не послаблений. Повторні 55 focused
перевірок, включно з download budgets і реальним CSP browser smoke, пройшли.
Accessibility: 10 routes × 2 themes, 0 violations, 0 page errors. Один сценарій
foreground recovery додатково перевіряє негайне читання попри попередній backoff.
Після цих виправлень розпочато новий повний fast run; source checksum оновлено,
попередня збережена окремо як `candidate-pre-budget.json`.

## Підсумковий результат

Повний `npm run verify` завершився успішно: **14/14 gates**, усі **8/8 shards**.
У наборі **8 501 test cases: 8 453 passed, 48 skipped, 0 failed**. Coverage
відсоток у fast form не вимірюється. Native PostgreSQL scenarios перевірені
окремо штатним disposable runner (37 passed); platform/manual/resource-gated
пропуски не оголошуються пройденими.

Звірено всі 69 змінених source files: контрольні суми збігаються з candidate
на початку цього повного прогону; несподіваних source changes немає.
`git diff --check` пройшов. Підсумкові локальні артефакти:
`verification-result.json`, `verification-suite.json`,
`/tmp/soty-performance-verify-done.log`,
`/tmp/soty-lag-investigation/bundle-final.json`.

Останні регресії додатково закривають mount на ненульовій realtime revision
без зайвого другого registry read, явний негайний reload, foreground recovery
попри backoff і сумісність основної analytics schema з необов'язковою
catalog-generation projection. Відсутність projection лишається явною в
`catalog_generations.blind_spots`.

Production не змінений, тариф не підвищений. Кодові виправлення й локальна
верифікація завершені. Пакетована beta exact-commit proof, production activation
та післярелізне пасивне підтвердження ефекту залишаються окремим release етапом.
Ці локальні результати не є гарантією cloud capacity або SC-003 verdict.
