# Research decisions — 047

Дата 2026-11-05. Read-only аналіз локального коду й попереднього incident audit.
Посилання на реалізацію описують спостережений стан, не доводять production cause.
Повторна звірка після релізу — T001. Нова технологія або залежність не потрібна.

## R1. Existing durable work, окремі indexed children

**Decision:** video set — дочірній aggregate existing catalog generation intent
або updater attempt. Execution — через `team_operations` та native recovery.
**Rationale:** `private.catalog_restitch_jobs` keyed by catalog, а
`private.catalog_restitch_copies` unique(catalog,role) допускають один spare/in_use
(`20260916120000_catalog_updater_restitch_web.sql`); N потребує іншої cardinality.
`catalog_generation_intents.variant` вже означає варіант каталогу
(`20261201113000_catalog_generation_recovery.sql`), його не перевизначати.
**Alternatives:** N записів у singleton spare порушують unique contract; нова queue
дублює recovery й не потрібна. Обрані назви та зв'язки — data-model.md.

## R2. Recipe identity і reuse fingerprint

**Decision:** ввести внутрішній `recipeRowId`/revision, окремий від публічного product ID;
assignment immutable для video-set + recipe revision. N входить у config contract.
**Rationale:** `_shared/product-catalog.ts` не має стабільного внутрішнього row ID;
`_shared/catalog-updater.ts` навмисно регенерує зовнішні product IDs.
**Alternatives:** array index ламається на reorder; external product ID — на update.
Launch reuse зараз порівнює старий config у
`packages/shared/src/team/launches/revisions.ts`; нові поля мають бути враховані.

## R3. Два результати: таблиця та відеонабір

**Decision:** для delay table readiness і video readiness незалежні; publication
можливий лише після ready і due. Default immediate зберігає поточну поведінку. При restitch off delayed job
публікує original material/version через source target без фіктивного set.
**Rationale:** `drive-ops/launch-catalog.ts` зараз споживає один completed restitch
receipt до створення catalog intent. Цей gate треба розділити явно.
**Alternatives:** чекати всі відео перед створенням delayed таблиці не відповідає
вимозі отримати каталог без відеопосилань; browser timer не переживає закриття.

## R4. Publication policy відокремлена від job

**Decision:** catalog policy immediate/scheduled/held, versioned one-shot job;
cancel переводить policy у held. Add now і нове scheduling — окремі intents.
Published job consumed. Active delivered target/assignment та pending replacement
зберігаються окремо, active pointer swap лише після verified settlement.
**Rationale:** cancel лише job без hold дозволяє regular updater одразу додати URL.
**Alternatives:** один boolean не відрізняє unchecked new creation від cancel already
scheduled. Regular interval не моделює календарне одноразове додавання.

## R5. Один catalog writer та provider settlement

**Decision:** reuse `private.catalog_update_reconciliations` як catalog-wide
reservation; current revision, provider compare-and-swap, content readback.
**Rationale:** `catalog-updater/worker.ts` викликає unconditional multipart replace
у `_shared/drive.ts`, readback підтверджує appProperties marker. Це недостатньо
для доведення незмінності recipe і правильних video cells. `_shared/drive.ts`
має окремий conditional recovery adapter: точний media-write path треба довести
локальним contract test і реальним beta concurrent-write experiment до shipping.
**Alternatives:** PG lock через HTTP погіршує recovery й не блокує зовнішній Drive
редактор; перевірка metadata перед unconditional write залишає race.
Невдалий provider conditional-write proof блокує приймання writer, а не знімає
вимогу. Вимкнення UI не знімає server hold.

## R6. Сумісність має перевіряти реального executor

**Decision:** новий native contract claim передає фактичні підтримані agent versions
і capabilities; сервер звіряє їх із work contract. Відсутність capability — legacy.
**Rationale:** `team-recovery/handler.ts` зараз підставляє server
`RESTITCH_CONTRACT_VERSION`, що саме по собі не доводить підтримку встановленого agent.
**Alternatives:** server version або web version не можуть засвідчити native support.
Нові jobs не видаються legacy executor; legacy N=1 immediate лишаються підтриманими.

## R7. Fallback — класифікована recovery policy

**Decision:** source selection і screen validation до processing, збережені
exclusions, safe reasons і розділені transient/file/global outcomes.
Contract C4 фіксує 32 candidates/slot, bounded transport/decode budgets та 24h
version-scoped refusal memory між звичайними clicks. Corrupt cache перевіряється
повним decode; metadata probe недостатній. Межі — початкове інженерне рішення,
змінюються тільки узгоджено у shared contract/тестах, не різними числами на поверхнях.
**Rationale:** `team/restitch/screens.ts` і `drive-ops/updater-restitch.ts` зараз
повторюють draw при grant refusal; `screen-cache.ts` не запитує новий кандидат
після transfer failure. Codec probe кешу не доводить придатності для decode.
**Alternatives:** blind retry повторює той самий кандидат; blanket blacklist
помилково дискваліфікує pool при глобальному outage.

## R8. Дві різні acceptance доріжки

**Decision:** real beta UI/provider acceptance та isolated synthetic diagnostics
acceptance мають окремі evidence. Production analytics у beta не вмикається.
**Rationale:** spec 031 і BETA.md вимикають звичайне надсилання beta telemetry;
mock emitted event не доводить ingestion/CLI. Локальний fixture runner має пройти
реальний sanitizer/guard/ingestion і SELECT-only CLI у disposable DB.
**Alternatives:** увімкнути production analytics у beta порушує ізоляцію; mock CLI
не доводить відповідність діагнозу фактичному producer contract.

Відкритих продуктових clarification немає. Provider capability, perf budget і
live delivery є implementation acceptance gates з визначеним fail-closed outcome,
а не непідтвердженими обіцянками. Поточні findings і remediation — analysis.md.
