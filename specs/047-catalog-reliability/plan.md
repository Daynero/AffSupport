# Implementation plan: 047 — надійні каталоги

**Feature context:** `047-catalog-reliability`. **Git branch під час планування:** `main`
(не перемикалася). **Дата:** 2026-11-05. **Spec:** [spec.md](spec.md).

## Technical Context

TypeScript 5.9 strict/ESM NodeNext; Node >=22.12 <25; React 19/Vite 8 web,
Fastify 5 local agent, existing Supabase PostgreSQL/Edge Functions, Google Drive
adapter. Залежності та lockfile не оновлюються заради цієї роботи.
Storage: existing durable intents, team operations, receipts і additive private
aggregates; жодної другої top-level queue. Tests: central Vitest 3, isolated SQL
runner, real packaged beta macOS/Windows, synthetic local ingestion/CLI harness.
Performance: p95 локальної реакції ≤200 ms/500 rows; fixtures 0/60/500/2000;
один heavy child на generation, shared machine PowerGovernor. До 400 товарів за
поточним shared контрактом, N≤фактичної кількості. Продукт — web + local agent +
server orchestration; зміни перетинають усі три межі.

## Constitution Check

| Принцип               | Pre-research / post-design вимога                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| I — typed boundaries  | Shared discriminated unions/guards/constants, no unchecked casts; SQL constraints і generated types; T004/T005/T012/T031/T041 |
| II — release/protocol | Existing release identity, explicit capability negotiation, exact-SHA beta; T031/T057–T059; новий scope не є web-only mini    |
| III — least privilege | RLS/revoke/narrow grants, qualified definer RPC search_path='', current ACL/entitlement, read-only CLI; T031/T041/T057        |
| IV — resources        | Managed spawn, bounded logs/temp cleanup, resumeForTermination, scaleTimeout, single-worker verification; T019/T034/T038/T057 |
| V — API/errors        | Existing request/envelope/module seams, stable closed codes, logError; T005/T009/T015/T039/T048                               |
| VI — frontend         | UI inventory/tokens, typed i18n/analytics, one SSE/Realtime owner, no new polling; T026/T036/T047/T051–T055                   |

Design conforms subject to acceptance evidence; no constitution amendment or waiver
is requested. Passing design review does not claim runtime gates passed.

## Artifacts and source layout

- [Research](research.md), [data model](data-model.md), [contracts](contracts/catalog-lifecycle.md),
  [validation guide](quickstart.md), [tasks](tasks.md), [analysis](analysis.md).
- Shared domains: `packages/shared/src/team/`; web actions/creation/manager/Launch:
  `apps/web/src/team/`; native execution: `apps/agent/src/team-bridge/`.
- Server: `supabase/functions/{drive-ops,catalog-updater,team-recovery,_shared}/`;
  schema: `supabase/migrations/`; read-only diagnosis: `scripts/analytics/`;
  all regression tests: `tests/`.
- New proposed modules: `packages/shared/src/team/catalog-video-set.ts`,
  `packages/shared/src/team/catalog-publication.ts`; additive SQL names are described
  in data-model.md. New test/file paths in tasks are intended outputs, not existing files.

The original incident backlog remains evidence. This package is the single source
of implementation tasks; older docs entry points redirect here.

Дата: 2026-11-05. Статус: дизайн і задачі узгоджені після аналізу для поетапної реалізації після поточного
релізу. Реалізація, міграції та production activation ще не виконані.
План охоплює всі CM01–CM16 з [переліку проблем і вимог](../../docs/POST_RELEASE_PROBLEMS.md).
Виконання ведеться за [чеклістом із 60 задач](tasks.md).

Мета: користувач отримує готовий каталог, може завантажити/поширити його,
керувати оновленням і перезашивкою без повторів навмання; може підготувати
N відеоваріацій і додати їхні посилання у визначений календарем момент.
Кожен результат і збій пояснюється через read-only CLI.

## Межі та вихідні докази

- Перший аудит коду — `c31c3250`; HEAD під час деталізації плану — `e3fcc194`.
  Перед реалізацією зафіксувати фактичний післярелізний SHA й повторно звірити
  знахідки. Номери рядків старого аудиту не використовувати як незмінні адреси.
- Дві доведені невдалі перезашивки Руслана та скарги на download/share
  описані в розділах 1–5 вихідного документа. Їхні причини не об’єднувати
  лише через одночасність. Первинна причина download/share ще не доведена.
- Baseline попереднього аудиту: 89 існуючих тестів у 8 файлах пройшли;
  це не доказ успішного live download/share. Повний CLI audit завершився
  statement timeout; цей збій також входить у роботу.
- Складність висока: web, shared protocol, SQL/RLS, Edge workers, Drive,
  локальна черга на двох ОС, recovery і аналітика. Найбільший ризик — повтор
  виконання/запису після втраченої відповіді та рання публікація посилань.
  Архітектурні зміни й перевірку гонок виконувати сильною reasoning-моделлю.
- План не передбачає повного переписування менеджера, нового queue framework,
  стороннього сховища відео чи незалежного циклу polling у браузері.

Нормативні джерела: [AGENTS.md](../../AGENTS.md),
[DESIGN.md](../../docs/DESIGN.md), [DESIGN-PRINCIPLES.md](../../docs/DESIGN-PRINCIPLES.md),
[031](../031-platform-autoanalytics/spec.md),
[039](../039-catalog-manager-ux/spec.md),
[035](../035-launches/spec.md),
[BETA.md](../../docs/BETA.md), [PRODUCTION.md](../../docs/PRODUCTION.md).
Нові вимоги власника з розділів 7–8 backlog доповнюють старі специфікації.

## Зафіксовані продуктові рішення

| Правило                    | Реалізаційна семантика                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Кількість варіацій         | N загалом у наступній генерації; 1→10 означає набір із 10, не 11. Default 1.                                                                                                                                           |
| Межа N                     | Ціле 1 ≤ N ≤ authoritative productCount цієї спроби. Наявна верхня межа товарів 400; не вводити окрему довільну нижчу межу відео. Перевіряти актуальний контракт на T004.                                              |
| Справжні outputs           | N окремих результатів перезашивки; query-параметри одного URL не є N відео.                                                                                                                                            |
| Розподіл                   | Зафіксоване випадкове перемішування збалансованого набору індексів; усі N використані, різниця частоти ≤1. Retry зберігає mapping. Це прийняте технічне уточнення до «рандомно».                                       |
| Зміна налаштувань          | CAS профілю; зміни діють на наступну спробу. Активна використовує immutable snapshot.                                                                                                                                  |
| Погана картинка            | Автоматична заміна до обробки відео в межах одного натискання; скінченний перебір; не повторювати відхилену версію кандидата.                                                                                          |
| Повтор                     | Повторювати тільки доведено невдалі/непочаті child jobs. Unknown outcome спочатку звіряється.                                                                                                                          |
| Часткова готовність        | Зберігати ready receipts; не зменшувати N мовчки й не замінювати робочий каталог неповним набором відео. Чинний partial для інших стадій залишається явним.                                                            |
| Відкладене посилання       | Checkbox + календарна дата + час + видима IANA zone; одноразове додавання незалежне від регулярного розкладу.                                                                                                          |
| Підготовка для відкладення | При restitch on відео готуються заздалегідь; off використовує original source. Створення таблиці з порожніми відеополями може завершитися до готовності всіх відео; UI окремо показує стан таблиці й підготовки відео. |
| Час публікації             | Не раніше dueAt; після dueAt — перший доступний серверний цикл за готовності залежностей. Запізнення видиме; секундної гарантії немає.                                                                                 |
| Скасування додавання       | Залишає відеополя порожніми й прибирає автоматичний запуск. «Додати зараз» — окремий явний намір.                                                                                                                      |
| Вимкнення після публікації | Не видаляє додані посилання. Нова відкладена публікація існуючого каталогу не приховує чинні посилання без окремої майбутньої вимоги.                                                                                  |
| Прогрес                    | Ready K/N — доступні й зареєстровані outputs; запис/перевірка таблиці показуються окремо.                                                                                                                              |

Автоматичне відновлення не підміняє відсутні права. Постійно недоступний файл,
мережа, прострочений grant, зміна джерела і диск мають різні коди й дії.
Тексти помилок називають підтверджену причину, не гіпотезу.

## Архітектура та точки змін

| Область             | Існуючі точки розширення                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Межі API            | `apps/web/src/api/team.ts`; `packages/shared/src/team/catalog-updater.ts`, `restitch.ts`, `launches.ts`; закриті error codes у `packages/shared/src/types.ts`          |
| Менеджер            | `apps/web/src/team/catalog-updater/`: Dialog, RowActions, InlineChanges, BulkEditor, IntervalPicker, StatusDetails, ProgressRow                                        |
| Спільні файлові дії | `team/materials/MaterialActionHost.tsx`; `team/catalog/useMaterialActions.ts`; `team/product-catalog/ProductCatalogMenuDialog.tsx`                                     |
| Усі створення       | `team/product-catalog/catalog-orchestration.ts`, `CreateProductCatalogDialog.tsx`, settings flow; `team/launches/LaunchEditor.tsx`, draft/generation/result hooks      |
| Підготовка відео    | `team/restitch/screens.ts`; `drive-ops/updater-restitch.ts`; agent `team-bridge/screen-cache.ts`, `restitch.ts`, `transfer.ts`, recovery-worker/journal                |
| Generation/writer   | `drive-ops/catalog-durable.ts`, `product-catalog.ts`, `launch-catalog.ts`; `catalog-updater/worker.ts`; `_shared/product-catalog.ts`, `catalog-updater.ts`, `drive.ts` |
| Файли/доступ        | Edge `library-ops/index.ts`, `drive-transfer/index.ts`, `handler.ts`; existing grant/ancestry/capability checks                                                        |
| Дані                | Нові additive migrations у `supabase/migrations/`, існуючі профілі, intents, operations, receipts та reference guards; generated `database.types.ts`                   |
| Діагностика         | `scripts/analytics/{queries,investigate,catalog-updates,code-map,coverage-registry}.ts`, journal ingestion, типізовані web/agent producers                             |

Шляхи web у таблиці відносні до `apps/web/src/`, Edge — до
`supabase/functions/`, agent — до `apps/agent/src/`.
Нові чисті доменні модулі для video-set/publication policy розмістити у
`packages/shared/src/team/`; проєктовані назви наведені вище; T004 звіряє їх і чинний schema baseline до DDL.
Не дублювати state machine по Launch/standalone/updater.

### Логічна модель даних

Це проєктовані записи, не вже створені таблиці. Фізичне розміщення визначене в [data-model.md](data-model.md): дочірні private
aggregates перевикористовують чинні intents/operations, без другого scheduler.

| Запис               | Обов’язкові поля й інваріанти                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile/config      | variationCount; publication preference; profileVersion. Старі записи читаються як N=1, immediate. Новий конфіг не змінює snapshot активного run.                                                                                 |
| VideoSetGeneration  | generationId, team/catalog/Launch binding, source identity/version, settings snapshot, productCount, requestedCount, state, revision, parent operation, cancellation state.                                                      |
| VideoVariant        | generationId + index унікальні; child operation/attempt, selected inputs/version, status, output material, provider receipt, failure code. Index не змінюється через retry.                                                      |
| Row assignment      | generationId + row recipe revision + stable row identity → variant index. Mapping immutable після прийняття; external reordered/changed rows вимагають звірки.                                                                   |
| Candidate rejection | generation/child/slot + candidate/version + safe reason + attempt/time. Persisted exclusions у спробі та bounded refusal memory між спробами; reset тільки expiry/version/settings change або explicit revalidate (contract C4). |
| Video publication   | catalog/typed target binding, окремий active delivery, policy mode, dueAt UTC, zone/local date-time, revision, job state, lease/fence, nextRetryAt, failure, verifiedAt. Один актуальний намір на каталог.                       |
| References          | Active delivery + pending typed target (source або video_set) окремо утримують outputs; після confirmed apply посилання переходять до актуального каталогу. Cleanup перевіряє всі consumers.                                     |

Секретні grants/URL живуть лише в захищених чинних seams, не в analytics.
SQL перевіряє ACL, cross-team ownership, CAS і unique keys. Derived counters
K/N рахуються за receipts, не довіряють довільному progress від клієнта.

### Стани та гарантії виконання

1. **Video-set:** accepted → preparing → ready → applying → verified.
   Failed/blocked/unknown/cancel_requested/canceled_with_cleanup_pending —
   окремі outcomes. Ready набір і verified таблиця не тотожні.
2. **Variant:** queued → downloading/preparing → processing → uploading →
   registered. Перед запуском/завантаженням — чинний execution fence.
   Втрачений acknowledgement не робить роботу вільною для повтору.
3. **Publication:** waiting_dependencies/waiting_time → applying → verifying →
   published. Окремо held, retry_wait, blocked, unknown, canceled/superseded.
   Після скасування поточна політика held утримує порожні поля нового каталогу,
   до явного «Додати зараз» або нового valid schedule. У вже published каталозі
   зберігає чинні URL та стримує майбутню заміну; regular updater не скидає policy.
4. **Запис у Drive:** спершу транзакційне резервування revision/fence, потім
   provider conditional content write (contract C6), потім actual-cell readback і settlement. Не тримати довгу SQL
   транзакцію через мережу й не обіцяти атомарну транзакцію PostgreSQL+Drive.
5. **Reschedule/cancel при applying:** не повідомляти «скасовано» до звірки
   вже відправленого provider write. Користувач бачить, що запис уже виконується
   або результат уточнюється; старі workers не отримують нове право на запис.
6. **Єдиний writer policy:** creation, manual/scheduled update, Launch recovery,
   delayed job і повтор виконують спільну перевірку publication revision.
   Тільки «Додати зараз» явно скасовує часовий hold.
7. **Зміна товарів до due:** нова row recipe/version атомарно перев’язує pending
   assignment або переводить job у waiting_dependencies. Stale worker не
   перезаписує нові товари старим snapshot.
8. **Навантаження:** generation queue bounded; початково одна важка variant
   на generation, загальний PowerGovernor на машині. Не зменшувати N заради
   бюджету; показати чергу. Grants видавати/оновлювати перед фактичною роботою,
   а не одночасно на всі 400 відео з ризиком спільного expiry.
9. **Fallback картинки:** policy перед отриманням фінального screen set;
   одна тимчасова помилка не робить файл постійно непридатним. Після bounded
   transient retry вибирати інший кандидат лише за класифікованою file-specific
   причиною; загальний outage зупиняє перебір. Cap reached ≠ all files broken. Точні counters/bytes/deadlines, TTL і decode
   validation задані contract C4, відновлення бюджету після restart не допускається.
10. **Платформи:** OS-специфіка тільки через platform module; managed spawn,
    resumeForTermination і scaleTimeout обов’язкові. 100% power зберігає чинну поведінку.

## Стадії реалізації

| Стадія                                   | Задачі    | Залежність               | Перевірний результат                                                     |
| ---------------------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------ |
| S0 — основа                              | T001–T004 | Поточний реліз завершено | Incidents, fixtures, contracts, сумісність і code-map заплановані точно  |
| S1 — отримання результату й діагностика  | T005–T014 | S0                       | Download/share працюють; API не вигадує success; причини доходять до CLI |
| S2 — автоматичне відновлення перезашивки | T015–T020 | S0, T005–T007            | Погана картинка автоматично обходиться, terminal доведений               |
| S3 — надійний менеджер                   | T021–T030 | S1; T025 також S2        | Bulk, schedule, run/stop/retry, history, delete та progress узгоджені    |
| S4 — N варіацій                          | T031–T040 | S2–S3                    | Один спільний video-set lifecycle у Launch/creation/updater              |
| S5 — відкладені посилання                | T041–T050 | S4                       | Durable schedule, порожні поля до due, verified додавання після due      |
| S6 — полірування                         | T051–T055 | S1–S5                    | UX, accessibility, 500/2000-row performance, state consistency           |
| S7 — повне приймання                     | T056–T060 | S0–S6                    | Повна матриця, gates, точний beta proof та післярелізна перевірка        |

Можна відправити окремий пакет виправлень після S1 або S3, не очікуючи нових
можливостей за окремим package acceptance з quickstart.md для його exact SHA.
Повні T056–T060 залишаються відкритими до приймання всього scope; вони не є
умовою раннього US1 bugfix і не позначаються виконаними за subset.
Повний запит закритий лише після S7 для всього обсягу. Поділ на стадії не є
дозволом автоматично публікувати будь-яку з них.

## Діагностика та контракти перевірки

Кожна задача реалізації містить telemetry/CLI частину в тому самому пакеті.
Використовувати existing typed operation lifecycle: intent, accepted, stage,
terminal, persisted, delivery, visible; parent/child/generation/attempt IDs.
Нові коди — shared closed list + web message + code-map + producer/ingestion tests.

| Питання користувача              | Мінімальний доказ                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Чому не отримав файл/URL?        | Surface/action, API stage, safe code, browser handoff/clipboard outcome; disk save unknown, якщо браузер його не підтверджує |
| Які налаштування діяли?          | Захищена проєкція snapshot/version, N, source mode/slots, opaque selection IDs; без назв/контенту                            |
| Чому замінилася картинка?        | Candidate/version, classified reason, rejection/reselection, bounded count                                                   |
| Скільки відео готово?            | RequestedCount + registered/available receipts (available перевірено перед apply); failed/unknown/queued окремо              |
| Чому в каталозі немає відео?     | Publication policy, dueAt, generation readiness, job state/code, verified delivery                                           |
| Чи безпечно повторити/скасовано? | Authoritative terminal, execution/upload fence, cleanup/ref state; не лише browser timer                                     |

CLI: розширити `investigate`, `inspect`, `catalog`, `journal`, `audit` сумісно.
Окремо підтримати missing/delayed signals, часові межі/as-of, truncation,
unsupported producers і часткову недоступність джерел. Не виконувати ad-hoc SQL
для production-розслідування. Native/browser version disagreement — unknown
із доказами, не довільне виправлення metadata.

## Матриця приймання всього обсягу

| ID  | Сценарій                                                                  | Результат                                                                                  |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A01 | Один готовий каталог у менеджері та провіднику                            | Обидва downloads відкриваються; обидва share/copy повертають очікуваний URL                |
| A02 | Missing size/webViewLink, deleted file, revoked permission                | Конкретна причина та diagnosis, без вигаданого fallback URL або success                    |
| A03 | Clipboard denied, double click, lost reply                                | Стійке поле URL, одна логічна операція, readback перед retry                               |
| A04 | Одна невалідна строка API / весь payload невалідний                       | Partial/contract state; жодного тихого «немає каталогів»                                   |
| A05 | Журнал має failed terminal, browser події немає                           | inspect/investigate називають terminal та code; delivery unknown                           |
| A06 | Audit source timeout                                                      | Bounded відповідь із missing source, не фальшивий covered                                  |
| A07 | Погана+хороша картинка; одна погана; усі погані                           | Auto-reselect або точна кінцева помилка; new click/restart не повертає unchanged known-bad |
| A08 | Спільний outage/expiry/диск; cancel при fallback                          | Правильна причина; не перебрати весь пул і не запустити відео після cancel                 |
| A09 | Bulk lost commit reply; CAS conflict; mixed calendar                      | Readback, per-item state, правильні time/day/zone; жодного blind replay                    |
| A10 | Delete A success/B failed/C unstarted                                     | Точні per-item outcomes, refresh і retry лише потрібного                                   |
| A11 | Run/retry count=0; cancel=false; дві вкладки                              | Правдивий no-op/поточний стан, без «запущено 1» та дубля work                              |
| A12 | History timeout, hidden tab, switch team/account                          | Bounded reads, один owner, без stale data іншого scope                                     |
| A13 | Нова спроба між polls; old late progress                                  | Progress належить своїй спробі; last verified success не губиться                          |
| A14 | N=1/5/productCount та invalid values                                      | Shared/server/DB checks, рівно N outputs, усі використані                                  |
| A15 | 1→10→1; productCount зменшився; profile changed midrun                    | Активний snapshot стабільний; нова спроба перевіряє межу, не додає 10 до 1                 |
| A16 | 3/5 готові, restart, lost upload response                                 | Готові не генеруються знову; unknown reconciled, справжній K/N                             |
| A17 | Cancel на download/process/upload/apply                                   | Нема нових child jobs; cleanup без видалення referenced outputs                            |
| A18 | Calendar/timezone/DST/past time/clock skew                                | Однозначний server instant, зрозуміла валідація; не раніше due                             |
| A19 | Browser closed, agent offline після підготовки                            | Сервер додає готові посилання; залежність від браузера відсутня                            |
| A20 | Раннє regular/manual update/recovery                                      | Відеополя лишаються порожніми; явно Add now є окремим наміром                              |
| A21 | Reschedule/cancel/delete одночасно з worker                               | Один актуальний fence, чесний outcome; old job не публікує пізніше                         |
| A22 | Due із неготовими відео/provider outage                                   | Видиме запізнення/blocked/retry; жодної фальшивої punctual success                         |
| A23 | N=5 + delay; restitch off + delay; published 1→pending 10; reorder/growth | Актуальний збережений mapping, усі ready URLs, без перезапису чужих змін                   |
| A24 | Старий встановлений агент за новим server, legacy web/worker, нові записи | N=1 immediate сумісні; N>1/hold не виконуються старим непідтриманим writer                 |
| A25 | Keyboard, 390 px, zoom 200%, довгі/однакові назви                         | Доступні всі дії, focus повертається до потрібного catalog ID                              |
| A26 | 0/60/500/2000 рядків, realtime burst                                      | Виміряні render/read counts; ціль p95 локальної реакції ≤200 мс при 500                    |

A01/A19/A23 перевірити реальним browser/provider readback у beta, не тільки
mock-тестом. Матриця для macOS/Windows, дозволів owner/editor/viewer та
підтриманих browser/capability cohorts. Частотні метрики обов’язково мають
attempt denominator, freshness і coverage, інакше це не доказ надійності.

## Міграції, сумісність і випуск

1. T004 заморожує shared schema/states й список усіх writers. T031/T041
   додають лише forward additive migrations, ACL, constraints та projections.
   Не редагувати вже застосовані міграції й не мігрувати production під час роботи.
2. Existing records → N=1, immediate; no-op update старого клієнта не скидає
   нові поля. Активні legacy operations залишаються в своєму контракті.
3. Server claim дозволяє нові generation/policy лише спроможному executor.
   Старий writer має відмовитися/не claim, а не тихо вписати один URL у held catalog.
4. Grants прив’язуються до актуального child/version, late workers fenced.
   Deactivation нової UI не видаляє jobs/receipts та не прибирає publication hold.
5. Один важкий локальний процес за раз, nice 15, один test worker. DB-тести
   тільки disposable runner; реальна beta auth/entitlements збережені.
6. Перед комітом коду — `npm run verify`; release/DB/build gates та exact-SHA
   packaged beta — за канонічним runbook. Shared/agent/functions і складні DB
   зміни не оголошувати web-only mini. Для справді чистого web-пакета — лише
   штатна read-only eligibility та належний web proof.
7. Невідомий provider outcome досліджувати read-only. Автоматичні rollback,
   replay невизначеного запису, очищення evidence чи stale lock заборонені.
8. Після окремо авторизованого релізу — зафіксований as-of, CLI і практичне
   підтвердження користувача. Нуль подій без coverage не закриває інцидент.

## Критерій завершення

Implementation-ready: T001–T059 виконані з evidence і candidate report; це не
production GO. Incident-closed: після окремо авторизованого фактичного релізу
також T060. Для повного scope усі A01–A26 пройдені або
мають доведене non-applicable обґрунтування без виключення вимог власника.
Звіт розділяє готовність відео, таблиці, посилань і видимість користувачу.
Відкриті критичні bugs, unknown execution без recovery та відсутня diagnostic
coverage блокують відповідний пакет. Календарний строк уточнюється після
T003/T004; вигадана оцінка не підміняє перевірку production-контрактів.
