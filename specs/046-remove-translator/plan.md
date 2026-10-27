# Implementation Plan: Повне видалення перекладача

**Branch**: фактична `beta`; логічний feature ID `046-remove-translator`; нову git-гілку не створено.

**Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Вилучити переклад із транскрибатора й простору, включно з фоновими та
серверними шляхами. Встановлені моделі залишити інертними без cleaner.
Реалізацію авторизовано власником; production дії не авторизовані.
Фактичні докази й незавершені gates — у `reviews/acceptance.md`.

## Summary

Видалити виконуваний перекладач, автопереклад, міжмовне зіставлення й англомовний
pivot-прохід Whisper. Спільне розбиття оригіналу, виділення й автопрокрутку спочатку
перенести в нейтральні модулі. Старі локальні документи нормалізувати на читанні
явним набором полів оригіналу, без object spread і масового переписування диска.

Серверна ліквідація має два незалежні контури: library requirements/attempts та
generic process operations/grants/uploads. Forward-only міграція припиняє старі
роботи й забороняє нове виконання/публікацію на кожній authoritative межі. Готові
результати й provider-файли зберігаються; private legacy companion reader потрібен
для групових move/share/trash/restore/copy.

Несумісне вилучення state/routes потребує API **6**, supported range **6–6** і
transcription contract **6**. Minimum-only tool bump сам не блокує старий web.
Потрібен повний узгоджений випуск DB/Edge/shared/agent/web, не web-only mini release.

## Technical Context

**Language/Version**: TypeScript 5.9 strict/ESM; Node з чинного `engines >=22.12 <25`;
Deno Edge Functions; PostgreSQL через чинну Supabase migration chain.

**Primary Dependencies**: наявні React 19, Fastify 5, HeroUI v3/React Aria,
Supabase client, FFmpeg і Whisper. Нові runtime dependencies не потрібні.

**Storage**: локальні state/document JSON; чинні library requirements/attempts/results,
process intents/operations/grants, companion links, bounded diagnostics journal.
Старі моделі/кеші не чистяться, користувацькі файли не змінюються.

**Testing**: single-worker Vitest, PGlite для контрактів, pgTAP через isolated DB runner,
справжній PostgreSQL для lock/race, browser acceptance, macOS/Windows package smoke,
`npm run verify`, перед release — `npm run verify:release` та exact-SHA packaged beta.

**Target Platform**: macOS arm64, Windows x64, підтримувані desktop/touch браузери,
hosted space backend і packaged local web; обидві теми та мови UI.

**Project Type**: чинний monorepo agent + web + shared + Edge + DB + read-only CLI.

**Performance Goals**: нуль translation downloads/processes/pivot passes; нуль retired
робіт у нових batch counts. Не додавати polling, cleaner або обхід усіх локальних файлів.

**Constraints**: зберегти оригінали, права, атомарне збереження, governor, cancel/shutdown
і перевірку доставки. Не переписувати applied migrations/релізи/історію. Чужі
незакомічені зміни не включати до майбутнього feature commit.

**Scale/Scope**: всі поверхні [scope-audit.md](scope-audit.md), чотири batch scopes,
обидва execution contours, old API5/new API6. Кількість старих встановлень невідома.

## Constitution Check

| Принцип              | Рішення                                                                                                   | До research / після design |
| -------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| I: typed boundary    | Active типи без перекладу; окремі historical readers; explicit whitelist unknown                          | PASS / PASS                |
| II: release          | API6/tool6 через несумісність; product version не змінювати в design; shared rebuild і full packaged beta | PASS / PASS                |
| III: least privilege | Auth/RLS/lease/source guards; SELECT-only вузький diagnostic view; no provider cleanup                    | PASS / PASS                |
| IV: resources        | Видалити translation children, зберегти governor/termination і preview shutdown; no new spawns            | PASS / PASS                |
| V: errors            | Невиконувані tombstones, closed nonretryable FEATURE_RETIRED, чинні envelopes                             | PASS / PASS                |
| VI: UI/state         | Чинні inventory/tokens, local SSE і team Realtime; no polling                                             | PASS / PASS                |
| 031                  | Producer→storage→CLI→висновок, version applicability, missing/late evidence unknown                       | PASS / PASS                |

Винятки не потрібні. PASS — відповідність дизайну, не виконана перевірка продукту.

## Project Structure

### Documentation (this feature)

`spec.md`, `scope-audit.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/retirement.md`, `quickstart.md`, `tasks.md`, `analysis.md`,
`checklists/requirements.md`; докази — `reviews/`.

### Source Code (repository root)

- Заплановані neutral seams: `apps/agent/src/transcription/segmentation.ts`,
  `apps/web/src/transcription/text-ranges.ts`, `useTranscriptSelection.ts`, `useTranscriptScroll.ts`.
- Agent: `index.ts`, `queue/{transcription-queue,transcription-store}.ts`,
  `transcription/{routes,document-store,export}.ts`, `whisper/`, `team-bridge/{process,library}.ts`.
- Видалення: `apps/agent/src/translation/`, `queue/translation-coordinator.ts`,
  translation-only web components/hooks/styles після переносу спільної поведінки.
- Shared: `packages/shared/src/{types,lifecycle,release}.ts`,
  `team/{library-processing,creative-library,transport}.ts`, exports/generated outputs.
- Web: `transcription/`, `team/library/` і всі consumers тексту у catalog/explorer/
  materials/tasks/workspace; API wrappers, locales, legal/demo/styles.
- Server: `supabase/functions/{drive-ops,library-ops}/`, `_shared/{library,errors}.ts`;
  нові `20261207090000_retire_translation.sql` і `20261207091000_translation_retirement_diagnostics.sql`.
- Diagnostics: запланований `scripts/analytics/library-retirement.ts`, чинні schema,
  queries/types/investigate/registry/code-map, web typed events та bounded agent journal.
- Packaging/docs: `scripts/package-*.sh`, `verify-*package*`, `stage-windows-runtime.mjs`,
  `windows-smoke.mjs`, notices/licenses/env references та чинні guides.
- Tests: `tests/`, новий `supabase/tests/database/translation-retirement.test.sql`.

**Structure Decision**: чинні seams, без нової служби, daemon або універсальної recovery системи.

## Phase 0 — Research

[research.md](research.md) фіксує перевірені рішення: reciprocal API6; explicit local
normalization; нейтральні segmentation/range helpers; видалення pivot; два серверні
контури; незворотні retirement transitions; private legacy companion reader;
FEATURE_RETIRED і historical diagnostics; відсутність cleaner.
Невирішених уточнень немає. Заплановані вільні migration filenames наведено нижче; T001 повторно перевіряє
порядок і колізії. Release identity визначає чинна release preparation, не цей план.

## Phase 1 — Design

### 1. Original-only local pipeline

Спершу перенести lexical splitting та source range/selection/scroll зі збереженням
поведінки. Змінити active shared types, прибрати target/alignment/pivot lifecycle.
Historical errors винести з active producers у окремий inert catalog.

Old state/document reader відбирає чинні поля явно. Translation summary/payload,
translationSource і PIVOT_UNAVAILABLE не ламають справний оригінал та не потрапляють
у нове DTO. Не переписувати весь диск. Зберегти atomic document locks, вихід Whisper,
preview shutdown, probe wakeups, оригінальний source progress і всі підтримувані мови.

### 2. Дві серверні межі

Новою forward-only міграцією змінити **останні** scan/claim/heartbeat/cancel/fail/retry/
accept/variants/totals та generic process/upload RPC. У тій самій транзакції поставити
guards, припинити незавершені translation requirements/attempts/operations і відкликати
їхні input/finalize grants. Використати чинний `canceled` у library і team_operations,
FEATURE_RETIRED і чинні timestamps; нового business state `retired` не вводити.

Bulk scoped retry пропускає retired rows і відновлює лише active failed без abort
змішаного набору; explicit retired commands відхиляються FEATURE_RETIRED.
Нові active kinds — `transcription | landing_optimization`; null/default і dry scan
також без перекладу. Ready counts виключають історичні translation rows.
Кожна RPC перевіряє stored kind/intent до мутації й до success replay; DB guards
закривають insert/kind change і resurrection у pending/running/ready старим writer.
Edge відмовляє до provider I/O, SQL — транзакційно до прийняття/реєстрації результату.
Без цих двох меж старий grant або stale Edge обходив би UI й queue removal.

Готовий historical result не змінюється; succeeded upload readback може повертати
лише вже прийнятий незмінний результат без нової публікації/contribution. Невідомий
in-flight provider upload зберігає ownership/adoption fences і факт невизначеності.
Не обіцяти фізичної відсутності файла після вже розпочатого зовнішнього запиту.
Жоден такий файл не стає новим прийнятим translation result; масового cleaner немає.

### 3. Space/UI/file compatibility

`list_video_text_variants` повертає тільки original, включно з transcript-companion
fallback без library result. Legacy-only translation не задовольняє наявність оригіналу.
Private snapshots move/trash/restore/share/copy продовжують читати старі companion roles.
Історичні системні UI-підписи нейтральні, а користувацькі назви/контент незмінні.
Прибрати фічу з першого запуску, menu/copy/export, descriptions/legal/demo/styles,
packaging/env і перевірок, що нині вимагають installed translator.

### 4. Diagnostics

Подробиці — [contracts/retirement.md](contracts/retirement.md#diagnostics).
Використати typed events і bounded agent journal; додати лише потрібні closed
discriminators/коди, перевірені sanitizer і DB guard. Для original runs зберігати
job identity й окремий attempt UUID; видимість/експорт не прирівнювати до compute success.

Новий restricted `analytics_translation_retirement` view: opaque IDs, closed states/
reason, timestamps і версія правила 6, без content/provider/grants. Default reader
limit100, max500, bound period/as-of, explicit truncation/schema gaps. Read-only CLI
`inspect`, `investigate`, `audit` додає evidence без зміни envelope. Mutable rows після
as-of не реконструюються. Registry відділяє current retirement API6 від історичного
producer coverage. Відсутній version provenance лишається unknown; дата spec або
timestamp назви міграції не є датою релізу. Новий producer записує apiVersion6 у
безпечному контексті, старі невідомі події не переатрибутовує.

### 5. Сумісність і випуск

API6↔API6 підтримується; API5↔API6 відхиляється в обидва боки до tool requests.
Backend independently refuses retired kind незалежно від версії UI. Повний release
за `docs/PRODUCTION.md`; не міняти product version/stable manifest/tag у цій роботі.
Cutover спочатку встановлює authoritative server fences перед прийняттям нової роботи,
потім узгоджені Edge/agent/web; старі локальні офлайн-програми дистанційно не відкликаються.
Кожна production дія залишається за чинними ratification/exact-SHA gates.

### 6. Verification

[quickstart.md](quickstart.md): першими failing regressions для old grant→late finalize,
corrupt translation→lost valid original, running summary→restart, source selection
та mixed-version requests. Потім зміна і наскрізна перевірка до CLI-висновку.

Окремий feature-only `scripts/test-translation-retirement-upgrade.mjs` робить
canonical prefix → old SQL fixtures → feature tail → real PG assertions; чинний
`test:db` робить повний clean replay і не є upgrade proof. Новий harness повторює
локальну schema/roles-only isolation з existing helpers, не змінює універсальний runner.
Release readiness вимагає обох перевірок, PostgreSQL race tests,
обох платформ, обох execution contours, негативного network/process evidence,
privacy acceptance і повного пошуку залишків. Відомий попередній bundle-budget
failure 46 086 > 40 000 — baseline, не привід змінити ліміт або назвати verify зеленим.

## Complexity Tracking

Constitution violations немає. Додаткова складність обмежена API guard, двома
вже наявними execution contours і вузьким diagnostic view; cleaner і універсальну
recovery систему відхилено як непотрібні.
