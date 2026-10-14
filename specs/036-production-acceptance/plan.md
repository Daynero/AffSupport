# Implementation Plan: прийомка перед продажами просторів

**Branch**: фактична Git-гілка `beta`; feature ID `036-production-acceptance`.
**Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)
**Input**: 174 ручні кейси після v1.2.6, 2 Safari + Chrome, автоматичне відновлення після поновлення тарифу, місткість на 30–50 людей.
**Status**: дизайн і план готові; реалізація, браузерні прогони та load test ще не виконані.

## Summary

Підготувати відтворювану приймальну кампанію, закрити відомий розрив автоматичного відновлення тарифно призупиненої роботи, виконати ручну регресію й виміряти ресурсний бюджет. Рішення про production ґрунтується на одному зафіксованому кандидатові, результатах кожного кейсу, реальних обмеженнях інфраструктури та exact-SHA packaged beta evidence.

Робота 034 T023–T029 є продуктовою залежністю 036, а не другим паралельним варіантом реалізації. Вона має один набір міграцій/контрактів/тестів. План 036 описує її інтеграцію з прийомкою. Вже завершені задачі 034 не доводять автоматичне відновлення.

## Technical Context

**Language/Version**: TypeScript strict/ESM у наявних apps/shared; SQL migrations; `.mjs` для orchestration; Node 22 для локальних тестів (packaged runtime за чинним build contract).

**Primary Dependencies**: наявні React/HeroUI, Fastify agent, Supabase Postgres/Auth/Realtime/Functions, Google Drive, Vitest 3.2.7, PGlite та реальні SQL тести. Новий web framework або брокер черг не потрібні.

**Storage**: наявні team/catalog/job tables плюс мінімальний durable recovery state; локальні JSON/JSONL артефакти кампанії. Fixture credentials окремо від артефактів.

**Testing**: single-worker Vitest регресії; реальна локальна БД для concurrency/RLS; native Safari/Chrome ручні кейси; Windows і окремі агентні машини; авторизований load harness з отриманням результатів.

**Target Platform**: macOS з двома Safari profiles та Chrome, підтримуваний Windows agent, локальний beta stack; окремо ізольований hosted стенд для перевірки ресурсів Supabase.

**Project Type**: доповнення наявного web/agent/backend продукту та приймального tooling.

**Performance Goals**: recovery enqueue ≤60 с, перший каталог ≤5 хв за здорових залежностей; p95 live delivery ≤5 с, reconnect ≤15 с; p95 warmed list/search ≤2 с; ≥99% звичайних дій; 8 годин без втрат/дублів; ≥30% запас квот.

**Constraints**: немає production writes/load, немає dev-auth у beta, analytics лишається read-only, немає нового recurring client polling, старі застосовані міграції не переписуються. Не відновлювати ручні cancel/disable або роботу без актуальних прав.

**Scale/Scope**: 174 кейси, LOAD-01–10; 30/50 людей, 1/10/50 команд, 100 звичайних і 150 пікових вкладок; первинний та великий індекс за capacity-plan. Число людей не є одиницею DB connections або Realtime delivery.

## Constitution Check

Перевірено до дослідження та повторно після дизайну. **PASS для плану**; це не результат реалізації.

| Принцип              | Рішення й перевірка                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Typed boundaries  | Shared recovery DTO/closed codes; JSON campaign validator; unknown на межі, без довіри до клієнтської причини паузи                                                     |
| II. Release identity | Manifest base/candidate/schema, clean SHA для final, чинний packaged promotion gate; жодного version bump/deploy у цій фазі                                             |
| III. Least privilege | Server recovery перевіряє чинне членство/тариф; SQL security definer із порожнім search_path; fixture writer окремий від read-only CLI; production targets відхиляються |
| IV. Child resources  | Агент через power spawn/governor, hold/resumeForTermination і scaled deadlines; recovery не додає другого suspender                                                     |
| V. Stable contracts  | Доповнення чинних envelopes/RPC; backward-compatible optional поля та стабільні reason codes                                                                            |
| VI. UI/state         | Єдиний Realtime/SSE transport; authoritative reread після reconnect; компоненти й токени docs/DESIGN.md; без нового polling                                             |
| Analytics 031        | Correlated intent → accepted → start → terminal → delivered; blocked/partial/unknown явні; capability/code-map/CLI регресії                                             |
| Verification         | Немає прихованого PASS при відсутньому Drive/Windows/hosted; стандартні verify gates плюс campaign report                                                               |

## Project Structure

### Documentation (this feature)

```text
specs/036-production-acceptance/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── contracts/recovery.md
├── contracts/acceptance-tooling.md
├── manual-test-cases.md, runbook.md, capacity-plan.md
├── scope.md, execution-report.md, checklists/requirements.md
└── tasks.md  # 83 задачі, створено наступною фазою speckit-tasks
```

### Source Code (repository root)

```text
packages/shared/src/team/tariffs.ts          # розширення DTO recovery
packages/shared/src/team/analytics.ts       # typed сигнали
apps/web/src/team/tariffs/                  # стан відновлення замість обов’язкової кнопки
apps/web/src/team/workspace/WorkspaceShell.tsx
apps/agent/src/team-bridge/                 # scoped background executor/checkpoint recovery
apps/agent/src/platform/platform.ts         # protected credential storage seam
supabase/functions/team-recovery/           # запропонований scoped delegation/claim endpoint
supabase/migrations/                        # нова forward-only міграція recovery
supabase/functions/tariff-notices/           # reuse renderer; beta capture adapter
supabase/functions/catalog-updater/         # наявні bounded claims
scripts/acceptance/                         # запропоновані fixture/load/report .mjs
scripts/analytics/                          # розширення read-only діагностики
supabase/tests/database/, tests/            # SQL, contract, UI, agent, tooling regressions
release/acceptance/<campaign-id>/           # запропоновані локальні докази, git-ignored
```

**Structure Decision**: використовувати існуючі seams. `scripts/acceptance/` і recovery artifacts — проєктований код, не вже наявні команди. Конкретні інтерфейси наведено в contracts. На початку реалізації звірити вкладені AGENTS.md та актуальний diff; сторонні зміни не перезаписувати.

## Phase 0 — Scope, дослідження та фіксація рішення

1. Звірити HEAD/base v1.2.6, незакомічений Launches, окремо розгорнуті backend hotfixes. Оновити scope manifest; кожному файлу призначити конкретний case/gate або доказ виключення. Загального `REG` для остаточного freeze недостатньо.
2. Зберегти initial dirty manifest для дослідної кампанії; clean candidate визначити після виправлень. Немає автоматичного checkout/reset/commit чужої роботи.
3. Прийняти рішення [research.md](research.md): server-owned recovery, локальний clock overlay, capture без реальних листів, native Safari, окремий hosted target.
4. Зафіксувати доступність Drive fixture, Windows/другого агента і hosted стенду. Відсутність ресурсу не зупиняє розробку локальних засобів, але дає BLOCKED відповідним execution cases.

**Вихід**: уточнений scope, fixture schema, список доступних середовищ, дизайн без нерозв’язаних архітектурних питань.

## Phase 1 — Підготовка стенду й доказів

1. Додати local-only fixture writer поверх beta isolation guards: звичайні A/B/C/X, окремий Soty admin, W1/W2, плани/місця/ролі, контрольні дані. Стандартну beta fixture не видавати за платного власника.
2. Додати controlled tariff clock: одна доменна точка часу для всіх tariff access/notice paths; production повертає серверний час, заміна реалізації встановлюється лише локальним test overlay поза production migrations. Жодних клієнтських `now`/SQL session overrides, що може встановити користувач. Lease, JWT і worker timeout лишаються реальними.
3. Додати named fault fixtures для acceptance lost/status lost/429/expired cursor/worker interruption. Безпечний capture email використовує реальний renderer і dedup, але не мережеву доставку. Перевірити, що production build/конфігурація не приймає тестові перемикачі.
4. Додати loopback-only diagnostic capture: звичайна beta analytics лишається вимкненою (tests/beta-analytics.test.ts). Typed події проходять спільні validation/ingestion до test DB й читаються штатним CLI; це окремий test adapter, не VITE_ANALYTICS_ENABLED=true. Довести missing/delayed signals.
5. Створити campaign manifest/result schema validator; status append-only, evidence hashes, redaction, totals за 174 ID, N/A reasons, stale candidate rejection. CLI `report` не пише стандартний `verification-result.json` — стандартний verify лишається єдиним його власником.
6. Запустити SET та тест реальних прав прямими викликами як A/B/C. Native Safari профілі відкрити за runbook; harness не імітує Safari Chromium/WebKit-емуляцією.

**Вихід**: SET PASS, fixtures повторювані, негативні isolation guards PASS, жодної реальної розсилки.

## Phase 2 — Автоматичне відновлення (034 T023–T029)

1. Спершу failing тести для LIFE-023–036: mixed enabled/disabled, renewal без UI, rapid pause/renew, double renew, worker restart, missing agent/Drive, права, manual stop, результат уже створений.
2. Розширити серверний перехід `private.after_space_tariff_change`: в одній транзакції з оновленням тарифу записати ідемпотентний recovery intent при blocked→allowed; зафіксувати revision/epoch для fencing. Поновлення активного тарифу не породжує recovery.
3. До очищення leases атомарно зберегти WorkspacePause/PauseItem незалежно від майбутнього recovery; renewal посилається на цей durable snapshot. Права завжди актуальні, видалене членство/делегації не відновлюються. Відновити тільки items із доведеною тарифною паузою. Використати `paused_interval` для per-catalog schedule, зберегти restitch/інші налаштування; версія ручної зміни перемагає snapshot. Під mutex/row locks узгодити всі mutation paths; провести реальний concurrency тест, не покладатися лише на PGlite.
4. Закрити вікно expiry→pause cron→renew: зберігати факт/час переходу та виконувати той самий pause/recovery протокол, навіть коли 10-хвилинний cron ще не встиг записати маркер. `now_allowed` повторно перевіряється під блокуванням. Старий worker не може публікувати після втрати epoch/прав.
5. Відновлювач обробляє durable intents із числовими claim/probe/rotation/retry budgets із contracts/recovery.md (5 retries, ≤10 хв/episode, ≤3 automatic episodes/hour, явний retry_exhausted). У транзакції renewal уже є enqueue evidence; scanner до 60 с підбирає залишене після crash. Наявні scheduler budgets обмежують старт; одна актуальна round, без replay пропущених інтервалів. Перевірити 5-хвилинний поріг при масовому поновленні.
6. Sync повертає одну reconciliation. Preview/archive/cleanup/restitch jobs повертаються через існуючі claims за чинного workspace access. Для кожного типу явний mapping у recovery contract; не створювати незалежного scheduler для кожного.
7. Перенести browser-led виконання `useRestitchPreparer` до спільного durable claim protocol із scoped background agent executor. Наявний team bridge не читає Supabase й має memory-only state: це окремий необхідний блок реалізації. Додати paired ticket enrollment (TTL 120с), delegate/redeem/rotation/revocation, окремі ClaimCredential до claim та OperationCredential після нього, захищене платформне зберігання та атомарний локальний журнал за contracts/recovery.md; не копіювати browser/service-role credentials. Browser та agent не можуть одночасно виконувати той самий claim. Нову capability й сумісність оформити через канонічний release contract; за потреби agent release, не web-only bypass.

   Агентні незавершені операції мають окремий checkpoint/receipt контракт. Відсутній безпечний checkpoint означає blocked/manual action, а не сліпий повтор. User cancel та permanent failure не перетворюються на tariff pause. За agent offline — durable waiting, продовження після handshake та перевірки прав; жодного стороннього process suspend.

8. UI показує pending/running/partial/blocked/completed з конкретною дією для залежності; нормальний renewal не вимагає «Увімкнути». Попередження до несплати лишаються owner-only й залежать від активності updater. Учасники бачать стан роботи лише у межах прав.
9. Додати typed signals, code map, capability inventory, розширення `investigate`/`inspect`/`sync`/`audit`; довести terminal та delivery, missing/delayed signals. Оновити 034 contracts/data-model й інструкцію адміністратора лише відповідно до реалізованої поведінки.

**Вихід**: LIFE-013/014/020–036, ACL та affected SYNC PASS, diagnosable partial recovery, нові міграції й типи, жодного «ще ручного» шляху в нормальній роботі.

## Phase 3 — Повна ручна кампанія

Порядок: SET → TEAM → ACL → TARIFF → LIFE → RO → SYNC → REG → LAUNCH → OBS. Виконувати кожен кейс на відомому fixture, писати фактичний результат і докази з трьох сесій. Поміняти ролі Safari↔Chrome для критичних потоків. Серверні заборони перевірити реальною особою, не service-role. Перевірка Drive/Windows із відсутньою залежністю — BLOCKED.

Кожен дефект: відтворення → failing regression → виправлення → targeted single-worker tests → повтор кейсу й залежних груп. Зміна SHA робить залежні докази stale; фінальна критична регресія виконується на зафіксованому чистому кандидатові. Незалежний P1 evidence переноситься лише через EvidenceAdoption (data-model §5a): immutable source PASS, reviewed dependency closure та однакові hashes/config/schema/fixtures. Foreign SHA без adoption відхиляється. Усі P0, tariff/security/recovery, LOAD/performance, backup, Windows credentials/recovery та packaged evidence виконуються заново; report розрізняє executed_pass/adopted_pass.

**Вихід**: усі 174 кейси мають результат; P0/P1 без FAIL/BLOCKED/NOT RUN, N/A обґрунтовано відсутністю функції у кандидатові.

## Phase 4 — Ресурси, довга робота й вибір плану

1. Реалізувати seeded authenticated load harness за contracts: 30/50 реальних test users, team actions + Realtime delivery; відкритий темп надходження, bounded concurrency, actual vs offered load, timeout та recovery latency включені у статистику. Метрики навантажувального комп’ютера збираються окремо. Native Safari A/B та Chrome C входять до 30/50 сесій; LOAD-02/03/04/06/07 вимірюють action→visible correct DOM для списку/пошуку (10 warmups, ≥100 measured attempts/action/browser/profile, timeout 15с врахований). API latency не підміняє SC-003 UI p95.
2. Виконати LOAD-01–10 з [capacity-plan.md](capacity-plan.md). Почати локально для correctness/cost ratios, далі на окремому hosted sandbox для квот. Стандартний local beta runner не розширювати до remote. До LOAD виконати окремий hosted prepare: verified allowlist, candidate migrations/Functions/web, Realtime/RLS/scheduler, test ingestion, actual synthetic worker/auth/agent smoke; immutable runtime-manifest та readiness ≤15 хв. Hosted verify перевіряє докази й identity read-only; немає готового runtime → BLOCKED.
3. Перед resource collection перевірити SQL та management targets окремо: management у поточному CLI бере active deployment binding, не ANALYTICS_DATABASE_URL. Додати explicit verified acceptance binding та reject mismatch. Read-only baseline/trend: physical DB, index/grants/history growth, CPU/IO/pool, Functions, Storage/egress, Realtime messages і sockets. Невідома метрика не стає нулем. Heavy aggregate scan лише start/end, не частий polling.
4. Розрахувати 30/90-day прогноз з idle, fan-out, onboarding та іншими споживачами квот. Перевірити 8 годин, reconnect burst та stop thresholds. Після stop підтвердити збереження даних і повернення черги, а не просто завершення генератора.
5. Free лише за ≥30% запасу всіх квот і backup/restore доказу. Якщо не проходить — мінімальний кандидат Pro+Micro, повторити профілі; compute upgrade обґрунтувати виміряним bottleneck. Не називати Pro гарантовано достатнім без повтору. Ціни/квоти звірити з офіційними джерелами на дату фактичного рішення.

**Вихід**: виміряна таблиця ресурсів, план/compute і кошторис із припущеннями, відновлення backup з RPO/RTO.

## Phase 5 — Фінальна готовність

На чистому SHA пройти `npm run verify`, `npm run verify:release`, Windows acceptance та packaged beta за канонічним runbook. Важкі команди послідовно. До звіту додати стандартний verification-result, artifact hashes, beta verification record, 174 case outcomes, LOAD evidence, backup proof, усі unknown/defects.

GO можливе лише при SC-001–007, FR-016 та відсутності S0/S1/критичних сліпих зон. Приймальна кампанія не випускає реліз і не замінює G0/sandbox evidence. Production виконується окремо за docs/PRODUCTION.md. Після продажів — запланований bounded read-only контроль перших 14 днів та хвиль 10/30/50 людей, без створення розкладу в цій фазі.

## Dependency and verification map

| Робота            | Залежить від                                 | Доказ                                   |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| Fixtures/evidence | Scope, target guards                         | SET, tooling safety tests               |
| Recovery backend  | Fixtures, failing regressions                | SQL races + LIFE + diagnostics          |
| Recovery UI/agent | Backend DTO/checkpoint                       | UI/agent tests + three-session delivery |
| Full manual       | Recovery, Drive, test accounts               | 174 outcomes                            |
| Load capacity     | Stable core, harness, isolated hosted target | LOAD-01–10, resource forecast           |
| Final go/no-go    | All above + Windows/backup                   | Clean SHA, canonical verification       |

## Complexity Tracking

Винятків із constitution не потрібно. Durable recovery record потрібен для restart/idempotency; один виклик UI не виконує вимогу без браузера. Окремі local fixture writer та read-only analytics мають різні повноваження за призначенням. Hosted sandbox — окрема перевірка ресурсу, не обхід local beta guard.

## Післяпроєктна перевірка

Виявлені під час research додаткові залежності включено: beta diagnostic capture, mail capture, management-target guard,
one-off round provenance та browser-independent scoped agent executor. Це не приховані припущення про наявні можливості.
Архітектура не потребує винятків із constitution; реалізація делегації включає security regressions та платформні gates.
Hook-файл `.specify/extensions.yml` відсутній: before/after plan hooks не застосовуються.
`setup-plan.sh` повернув logical BRANCH=036-production-acceptance з feature context; `git branch --show-current`
підтвердив фактичну `beta`. Гілку не перемикали. Задачі сформовано в tasks.md; реалізація ще не починалася.
