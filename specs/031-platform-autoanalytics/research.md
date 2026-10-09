# Research: Агентна автоаналітика платформи — незалежне читання і фактичний стан

**Date**: 2026-10-10 · **Status**: написано незалежно від [spec.md](./spec.md), потім зведено в нього (US6, FR-048…FR-057, SC-012…SC-017, реєстр, пріоритети); цей файл лишається як Phase 0 research · **Author**: coding agent, after a read-only inventory of the real pipeline (producers, storage, consumer) and the 2026-09/10 incidents.

Мета цього документа — не повторити spec.md, а сказати те, чого там немає або що там сформульовано як абстрактна вимога без прив'язки до того, як платформа насправді влаштована. Після цього обидва документи зводяться в один.

## 1. Що є насправді (факти з коду, 2026-10-10)

| Шар | Факт | Наслідок для діагностики |
| --- | --- | --- |
| Продюсер | Єдиний автор подій — веб-клієнт (`apps/web/src/analytics/service.ts`). Агент не шле жодної телеметрії; Edge Functions не пишуть `analytics_events`. | Усе, що сталося в агенті (краш, spawn, picker, drain, entitlement), видно лише через те, що веб встиг помітити. |
| Черга | `localStorage`, 40 подій, найстаріші тихо скидаються; 3 спроби доставки, далі подія тихо губиться; жодного лічильника втрат; немає expiry; `flush` при `offline` — no-op. | Доставка «best effort» без доказу втрат. Критичні terminal-події не захищені від витіснення progress-подіями. |
| Ідентичності | `installation_id`, `session_id` (30 хв idle), `user_id`; `flow_id`/`run_id` лише як UUID; `instanceId` агента не передається; платформа — з User-Agent (Android → `linux`); авторитетна платформа агента не зберігається. | Неможливо з'єднати подію з конкретним запуском агента; когорта «платформа» хибна для емульованих/мобільних UA. |
| Guard | `analytics_properties_are_safe_v2` — закритий allowlist ключів і enum-ів; відкинута подія повертається клієнту як `accepted=false`, клієнт лише `console.warn` і після 3 спроб губить її. Клієнт сьогодні шле щонайменше 12 ключів, яких guard не знає (`limit_percent`, `selection_count`, `folder_count`, `ready_count`, `unavailable_count`, `attention_reason`, `item_count`, `tile_state`, `had_agent`, `reason`, `contribution_*`) і outcome-значення `ready`/`failed`. | `team_storage_*`, `team_index_completed`, `team_previews_ready`, `team_landing_render`, `power_limit_changed` **ніколи не долітають**. Аудит релізу 1.2.5 бачив «нуль storage-подій» і трактував це як відсутність активності. |
| Каталог подій | 42 імені оголошені, але ніде не емітяться (увесь `pairing_*`, `local_app_check_*`, `install_detected`, `compatibility_checked`, усі `update_*` після `update_started`, `input_add_started/rejected`, `estimate_failed`, `landing_optimization_completed/failed`, `result_*`, `session_started`, `screen_viewed`…). CLI-команди `friction`/`features`/`cohorts` рахують деякі з них. | Команди повертають нулі, які читаються як «добре». |
| Start без terminal | `stitch_started` без id; `landing_optimization_started` без своїх terminal; `estimate_started` без `estimate_failed`; `update_started` без продовження; `agent_disconnected` без відновлення; `tool_opened` без readiness. | Неможливо відрізнити «не завершив» від «ми не слухали». |
| Помилки | `error_occurred` емітить лише стітчер (після 2026-10-09); компресор/транскрибація/лендінг/простір — ні. Категорія помилки компресора — regex по рядку. | `errors` показує `unknown/unknown/unknown` для більшості кластерів (підтверджено 30-денним зрізом). |
| Бага продюсера | `CreateSpaceWizard.tsx:57` — `useRef(startTeamOnboardingFlow())` стартує новий flow на кожному рендері. | SC-001 onboarding-когорта роздута фантомними стартами. |
| Споживач | CLI read-only (3 шари), `journey` ігнорує період і друкує properties сирими; `EVENTS_RANGE` фільтрує за `created_at` (час прийому), а порядок — `occurred_at`; період завжди «до зараз», без фіксованого snapshot. | Повторний аналіз «того самого» періоду бачить інші дані; прострочені доставки міняють минуле. |
| Retention | Немає жодного retention/cron для `analytics_events`; видалення акаунта лише nullить `user_id`, `installation_id`/`session_id` лишаються. | 031 FR-030 (30/90 днів) — не реалізовано; privacy-зобов'язання не виконуються структурно. |
| Тести | Схема PGlite у тестах CLI написана вручну **без guard-функції**; жоден тест не звіряє клієнтський allowlist із серверним. | Саме так 12 ключів розійшлися непомітно. |

## 2. Чого бракує в spec.md

spec.md правильно вимагає «реєстр можливостей», «доказовий ланцюжок», «аудит покриття» і «read-only інтерфейс для агента». Він не каже:

1. **Що першим кроком є ремонт, а не розширення.** Поки guard тихо відкидає події, а клієнт тихо губить їх, будь-які нові сигнали — ілюзія покриття. Контракт «клієнтський allowlist ⊆ серверний allowlist» має стати тестом, що запускається у `verify`.
2. **Що «відкинуто» і «втрачено» — самі є сигналами.** Клієнт має рахувати відкинуті/витіснені/прострочені події і доставляти лічильник (`analytics_delivery_report`), інакше FR-013/FR-017 неперевірювані.
3. **Де межа спостережуваності агента.** Агент не шле телеметрію — і не повинен (privacy-first, без мережевих залежностей). Але він може вести **локальний bounded журнал діагностичних фактів** (spawn/exit категорії, picker lifecycle, drain/shutdown причини, token/entitlement рішення) і віддавати його вебу через наявний `/api/diagnostics`, а веб — включати **вибрані** нормалізовані факти в події (наприклад, `link_recovered.instance_changed`) або в support-bundle. spec.md FR-045 говорить про bundle; тут уточнюється, що джерелом є агентський журнал, а не логи ОС.
4. **Що `run_id`/`flow_id` мають стати обов'язковими для кожної операції кожного інструмента**, а не лише для компресора; що `attempt_id` — колонка, а не властивість; що `instance_id` агента — частина envelope (без PII: випадковий UUID на запуск).
5. **Що зафіксований snapshot періоду — обов'язковий для повторюваного аналізу** (`--as-of`), і що CLI має розрізняти `occurred_at` і `created_at`, показуючи лаг доставки.
6. **Що «readiness інструмента» — окремий сигнал** (`tool_ready` з результатом initial read / subscribe) — інакше «connected but unready» (FR-037) не спостережуваний.
7. **Що retention має бути реалізований міграцією з cron** (pg_cron або scheduled Edge Function) і перевірений тестом, а не описаний.
8. **Що пріоритет — аддитивний і за цінністю**: (a) ремонт guard/доставки + контрактний тест; (b) terminal-події й `error_occurred` для кожного інструмента з `flow_id`; (c) з'єднання/pairing/update lifecycle (зроблено в 032); (d) readiness інструментів і input lifecycle; (e) локальний журнал агента + `/api/diagnostics` v2 + bundle; (f) CLI: `coverage`, `inspect <flow>`, `as-of`, delivery lag; (g) retention.
9. **Що самоаналіз — це фіксована процедура CLI (`npm run analytics -- audit`)**, яка видає: expected vs observed stages per capability, orphan starts, unknown codes, guard-rejected keys (з лічильника), builds без покриття, і записує JSON-артефакт у `specs/031-platform-autoanalytics/analysis/<date>.json`. Без LLM, без дашборда.

## 3. Capability Coverage Registry — конкретна форма

Файл `scripts/analytics/coverage-registry.ts` (machine-readable, тестований):

```text
capability: compressor.run
  stages: input_add → estimate → start → progress → terminal → result_visible
  start_events: compression_started (run_id)
  terminal_events: compression_completed | compression_failed | operation_cancelled (run_id)
  readiness: tool_ready{tool:compressor}
  error_event: error_occurred{tool:compressor, error_stage ∈ …}
  platforms: macos, windows
  unobservable: result file opened by the user outside Soty
```

Реєстр перелічує кожну можливість продукту (компресор, стітчер/restitch, транскрибація/переклад, landing optimizer/preview, catalog updater, простір: storage/index/sync/upload/download/move/rename/delete/share, library, tasks, accounts/finance (лише метадані), notebook/TOTP (лише факт використання), з'єднання/pairing/update, аналітика сама). Команда `audit` звіряє реєстр із фактичними подіями за період: для кожної можливості — `covered` / `partial(stages…)` / `uncovered` / `declared_but_never_emitted`.

## 4. Вимоги, яких немає в spec.md (кандидати на злиття)

- **IFR-1**: Клієнтський allowlist ключів/enum-ів MUST бути єдиним джерелом, з якого генерується (або проти якого тестується) серверний guard; тест у `verify` MUST падати на розходженні.
- **IFR-2**: Клієнт MUST рахувати події, відкинуті сервером, витіснені з черги й прострочені, і MUST доставляти агрегований `analytics_delivery_report` (лічильники за причиною, без вмісту) не рідше ніж раз на сесію.
- **IFR-3**: Кожна операція кожного локального інструмента MUST мати `run_id` (envelope-колонка) і terminal-подію з тим самим `run_id`; `tool_opened` MUST супроводжуватись `tool_ready{outcome, duration_ms}`.
- **IFR-4**: `error_occurred` MUST емітитись кожним інструментом із `error_stage`, стабільним `error_code` і `error_fingerprint = <tool>:<stage>:<code>`; regex-класифікація рядків помилок компресора MUST бути замінена кодами з агента.
- **IFR-5**: Envelope MUST містити `agent_instance_id` (випадковий per-boot UUID) і `agent_platform` (авторитетна платформа агента, коли підключений); браузерна платформа лишається окремим полем.
- **IFR-6**: Агент MUST вести локальний bounded журнал діагностичних фактів (ring buffer ≤ 2 000 записів / ≤ 1 МБ, без шляхів/назв/секретів) і віддавати його через `/api/diagnostics?since=`; веб MUST уміти зібрати support-bundle з нього локально, показати користувачу й лише тоді дати скопіювати.
- **IFR-7**: CLI MUST підтримувати `--as-of <iso>` (фіксований end time) і показувати `delivery_lag` (p50/p95 `created_at − occurred_at`) у кожній відповіді, що агрегує події.
- **IFR-8**: CLI MUST мати команду `audit` (coverage registry vs observed; orphan starts; unknown codes; guard-rejected counters; uncovered builds) і `inspect <flow_id|run_id>` (повний ланцюжок однієї спроби з усіх інструментів); обидві пишуть machine-readable артефакт і не змінюють дані.
- **IFR-9**: Retention MUST бути реалізований: деталізовані події — 90 днів, агрегати — безстроково у `analytics_daily_*` (матеріалізація cron-ом), `installation_id`/`session_id` анонімізуються разом із `user_id` при видаленні акаунта.
- **IFR-10**: Жодна команда CLI MUST NOT повертати нуль для сигналу, який не емітиться у жодній відомій версії клієнта; замість нуля — `unsupported_by_producer`.

## 5. Success criteria, яких немає в spec.md

- **ISC-1**: `npm run verify` падає, якщо клієнт емітить ключ/enum, якого серверний guard не приймає (контрактний тест на PGlite із реальним тілом guard-а).
- **ISC-2**: За 7 днів після релізу частка відкинутих сервером подій < 0,1% і відома; раніше — невідома.
- **ISC-3**: `audit` за період показує 0 `declared_but_never_emitted` серед подій, які CLI використовує в обчисленнях (або команда позначає їх `unsupported_by_producer`).
- **ISC-4**: Для кожного локального інструмента `errors` показує `error_stage ≠ unknown` у ≥ 95% кластерів нового релізу.
- **ISC-5**: `inspect <run_id>` відновлює ланцюжок від `tool_opened` до terminal для 100% контрольних прогонів на беті для компресора, стітчера, транскрибації, landing optimizer, restitch.
- **ISC-6**: Повторний `audit --as-of` на тому самому snapshot дає байт-ідентичний артефакт.

## 6. Поза обсягом (явно)

- Телеметрія з агента напряму в хмару; дашборд; LLM у CLI; збір вмісту файлів/транскриптів/шляхів; аналітика до авторизації (неможлива без identity — лише локальний журнал агента).
