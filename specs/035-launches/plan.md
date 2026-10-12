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
