# Specification Analysis Report: 046 — Повне видалення перекладача

**Дата**: 2026-10-27. **Результат початкового аналізу**: готово до реалізації.
**Поточний стан**: source implementation виконано; фактичні результати, виправлення
й незавершене platform acceptance — у [reviews/acceptance.md](reviews/acceptance.md).

Перевірено spec, plan, tasks, research, data model, contract, quickstart і scope audit
проти constitution та поточного коду. Спочатку виконано read-only аналіз; окремими
правками виправлено документи за прямою вказівкою власника «виправляй одразу».
Після правок повторено consistency review, включно зі спеціалізованими перевірками
agent/server. Код продукту й міграції у цій роботі не реалізовувалися.

## Findings and remediation

Нижче вже виправлені проблеми. Locations позначають актуальне місце рішення.

| ID  | Category                | Initial severity | Location(s)                                                             | Finding                                                                                 | Applied remediation                                                                                                                  | Status   |
| --- | ----------------------- | ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| C1  | Coverage / verification | HIGH             | tasks.md T002/T032; quickstart.md Focused regression runs               | test:db запускає tests після всієї chain; не доводить upgrade зі старими rows до guards | Feature-only owned disposable prefix→fixture→tail harness, точна команда, дві race fixtures, isolation/cleanup; guards не обходяться | RESOLVED |
| I1  | Inconsistency           | MEDIUM           | contracts/retirement.md Library processing commands; tasks.md T016/T017 | Explicit refusal змішувалася з bulk retry й могла блокувати чинні роботи                | Bulk skips retired, повертає active count; explicit retired request refused; mixed-scope regression                                  | RESOLVED |
| I2  | Task ordering           | MEDIUM           | tasks.md T036/T037 і Dependencies                                       | Packaging стояв перед підготовкою notices/licenses, всупереч залежностям                | T036 docs/licenses перед T037 packaging; dependencies і parallel examples виправлені                                                 | RESOLVED |
| U1  | Underspecification      | MEDIUM           | contracts/retirement.md Diagnostics; tasks.md T040/T046                 | Per-attempt journal cap міг втратити saved/terminal при recovery                        | Dedup до emit; 8 intermediate slots + accepted/saved/terminal/omission; count/last stage і overflow regression                       | RESOLVED |

## Research safeguards verified in final artifacts

- API6 reciprocal guard, а не лише minimum-only tool bump: T006/T033.
- Обидва execution contours, old grants/stored intent, late finalize/contribution: T017/T021/T027–T032.
- Explicit document whitelist, corrupt legacy tolerance без прийняття corrupt source: T007/T008.
- Source segmentation/selection/scroll до видалення translation modules: T003/T004/T010/T013.
- Original-only text, companion fallback, private legacy group roles: T023–T026/T031.
- Моделі/cache лишаються; user files/history не перейменовуються й не стираються: T008/T028/T031/T033.
- Version applicability, historical unknown, bounded SELECT-only evidence/privacy: T039–T046.
- Усі US1–US6 обов’язкові; локальний increment US1 не дозволяє частковий deploy.

## Coverage Summary

Усі 25 FR, 8 AD і 9 SC мають явні implementation/acceptance задачі. Усі SC тут є
перевірюваними умовами, а не post-launch KPI, тому включені до coverage. Посилання
звірені семантично за змістом задач, не лише за збігом ідентифікаторів.
Наведено ключові задачі; повний mapping міститься в самих task descriptions.

| Requirement Key | Has Task? | Key Task IDs                            | Notes                              |
| --------------- | --------- | --------------------------------------- | ---------------------------------- |
| FR-001          | Yes       | T007, T009, T017, T029, T047            | Усі execution contours             |
| FR-002          | Yes       | T003, T007, T010, T048                  | Original speech збережено          |
| FR-003          | Yes       | T004, T013, T035                        | Source-only viewer                 |
| FR-004          | Yes       | T011, T014                              | Original copy/export/routes        |
| FR-005          | Yes       | T009, T012, T037, T050                  | Speech-only install                |
| FR-006          | Yes       | T009, T015, T050                        | No translation download/spawn      |
| FR-007          | Yes       | T010                                    | Видалення pivot                    |
| FR-008          | Yes       | T016–T020                               | Чотири batch scopes                |
| FR-009          | Yes       | T016–T022                               | Active counts/retry/outcomes       |
| FR-010          | Yes       | T023–T026                               | Original у всіх consumers          |
| FR-011          | Yes       | T023–T026                               | Legacy translation не original     |
| FR-012          | Yes       | T008, T028, T031                        | Файли/зв’язки збережено            |
| FR-013          | Yes       | T009, T033, T051                        | No cleaner                         |
| FR-014          | Yes       | T005, T008, T032, T033                  | Persisted compatibility            |
| FR-015          | Yes       | T016, T027, T028, T032                  | Старі роботи припинено             |
| FR-016          | Yes       | T011, T017, T021, T029, T030            | Всі authoritative boundaries       |
| FR-017          | Yes       | T017, T027–T032                         | Late result/resurrection fences    |
| FR-018          | Yes       | T006, T032, T033, T050                  | Reciprocal API/upgrade             |
| FR-019          | Yes       | T012, T020, T025, T034, T038, T047      | Нуль системних згадок              |
| FR-020          | Yes       | T034–T036, T038, T047                   | Актуальні copy/legal/demo/docs     |
| FR-021          | Yes       | T036–T038, T050                         | Package/env/notices                |
| FR-022          | Yes       | T005, T009, T015, T019, T047            | Runtime видалений                  |
| FR-023          | Yes       | T003, T004, T010, T013, T034, T048      | Source helpers і i18n збережено    |
| FR-024          | Yes       | T015, T022, T026, T030–T033, T048–T050  | Rest-of-product regression         |
| FR-025          | Yes       | T001, T038, T047, T051                  | Повний residual audit              |
| AD-001          | Yes       | T039–T041, T046                         | Original stage/attempt/delivery    |
| AD-002          | Yes       | T022, T039–T041, T046                   | Batch/operation/registration       |
| AD-003          | Yes       | T005, T011, T039–T043, T045, T046       | FEATURE_RETIRED без fictitious run |
| AD-004          | Yes       | T042–T044, T046                         | Read-only CLI/registry             |
| AD-005          | Yes       | T005, T021, T043–T046                   | Historical meaning                 |
| AD-006          | Yes       | T022, T039–T044, T046                   | Missing/late/as-of unknown         |
| AD-007          | Yes       | T002, T039–T043, T045, T046             | Bounded privacy                    |
| AD-008          | Yes       | T039, T041–T043, T046, T051             | Producer→storage→CLI proof         |
| SC-001          | Yes       | T034–T038, T047, T050                   | Поверхні/мови/теми/packages        |
| SC-002          | Yes       | T007–T010, T012, T015, T038, T050       | Clean/upgrade без translator       |
| SC-003          | Yes       | T016–T022, T050                         | Active-only batch                  |
| SC-004          | Yes       | T007, T008, T027, T028, T031–T033       | Upgrade без втрати даних           |
| SC-005          | Yes       | T006, T011, T017, T027–T030, T032       | Old command/result refusal         |
| SC-006          | Yes       | T013, T014, T023–T026, T035             | Original view/copy/export          |
| SC-007          | Yes       | T015, T026, T031, T033, T037, T048–T050 | Platforms і чинні інструменти      |
| SC-008          | Yes       | T039, T041, T043–T046, T049, T050       | Correct diagnostic conclusion      |
| SC-009          | Yes       | T008, T009, T015, T033, T050            | Інертні моделі не блокують         |

## Constitution Alignment

Порушень не виявлено. Pre/post gate plan — PASS як дизайн, не як product evidence.
Typed active/legacy boundaries; revisions через реальну несумісність;
RLS/auth/lease/tenant guards збережені; process/governor seams чинні;
inventory/tokens і transport ownership чинні. Немає production writes/cleaner.
Feature-only upgrade harness не змінює universal runner: owned local schema-only
clone, без source application rows/passwords, scheduler disabled, cleanup і resource bounds.
Документи не змінюють constitution або release gates.

## Task structure and dependencies

| Area                 |  Count | Independent acceptance                                         |
| -------------------- | -----: | -------------------------------------------------------------- |
| Setup / foundational |      6 | Baseline, fixtures, neutral helpers, types, protocol           |
| US1                  |      9 | Original local pipeline/view/copy/export без translation/pivot |
| US2                  |      7 | Чотири scopes, active counts/transitions                       |
| US3                  |      4 | Original через всі text/action consumers                       |
| US4                  |      7 | Upgrade, grants, races, legacy files                           |
| US5                  |      5 | Нуль system mentions, поточні notices/packages                 |
| US6                  |      8 | Produced evidence до CLI finding                               |
| Cross-cutting        |      5 | Residual audit, gates, platforms, acceptance                   |
| **Total**            | **51** | Усі implementation tasks залишаються unchecked                 |

T001–T051 послідовні, без пропусків; усі story tasks мають US label і file paths.
[P] лише T004 і T036; shared contracts, міграція та heavy checks не паралеляться.
Приклади паралельних правок не є інструкцією запускати додаткових агентів під час implementation.

## Unmapped Tasks

Немає. Кожна задача має requirement/acceptance mapping.

## Metrics

- Total requirements: **42** (25 FR + 8 AD + 9 SC).
- Total tasks: **51**; coverage **42/42 = 100%**.
- Uncovered requirements / unmapped tasks: **0 / 0**.
- Initial actionable findings: **4** (1 HIGH, 3 MEDIUM); resolved **4**.
- Open findings: **0**; CRITICAL **0**, HIGH **0**, MEDIUM **0**, LOW **0**.
- Unresolved ambiguity / harmful duplication / placeholder: **0 / 0 / 0**.
- Invalid task format / duplicate IDs / broken local links: **0 / 0 / 0**.

## Validation and limits

Перевірено formatting, task ID/label/reference coverage і локальні посилання.
Code/DB semantics досліджено read-only; повторний review підтвердив закриття findings.
Product tests, новий upgrade harness, package acceptance і release не виконувалися:
вони є implementation tasks, не доказами цього документального аналізу.
Known prior verify failure 46 086 > 40 000 у bundle budget лишається явним baseline,
не виправлений підняттям ліміту й не названий зеленим.

Pre/post hooks plan/tasks/analyze відсутні: `.specify/extensions.yml` не існує.
Git-гілка beta, logical feature directory 046; гілку не перемикали.

## Next Actions

Готово до `speckit-implement` за T001–T051. Перший локальний increment — US1 після
foundation; production-ready лише вся ліквідація з US2–US6 і final gates.
Нерозв’язаних design blocker-ів немає. Missing prerequisites/failed actual gates
під час implementation залишають відповідну acceptance умову непідтвердженою.

## Implementation reconciliation — 2026-10-27

The analysis above records the pre-implementation review. Implementation is now
in the working tree, with source tasks marked separately from platform acceptance.
Actual regression locations/deviations are recorded in tasks.md; results and
unobservable stages in reviews/acceptance.md. Additional implementation findings
fixed: orphan dist files, legacy malformed warning tolerance, last contract5 UI
thresholds, per-attempt modal cache/visibility, actor-bound native journal joins,
and workspace accepted-attempt visibility/copy receipts. Canonical verification
and exact-candidate platform evidence are not inferred from planning checkmarks.
