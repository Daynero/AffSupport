# Аналіз специфікації, плану й задач — 047

Дата: 2026-11-05. Source baseline: `e3fcc1941e19c092ed2daa7571bd3c35adc883d1`.
Цикл: план → tasks → read-only analysis → авторизовані користувачем виправлення
артефактів → повторний read-only analysis. Реалізація продукту після поточного релізу.
Аналіз не змінював runtime, production data, git branch або release context.

## Підсумок

Початковий прохід виявив 11 проблем планування; повторна архітектурна перевірка —
ще 2 HIGH випадки (G02/G03). Усі 13 виправлено в документах. З них 6 HIGH,
6 MEDIUM, 1 LOW; CRITICAL — 0. Конституцію не змінювали, waiver немає.
Після remediation відкритих виявлених проблем планування немає.
Provider CAS, native capability negotiation, full diagnostics і beta acceptance —
майбутні перевірки реалізації, а не вже доведені властивості продукту.

## Findings і remediation

| ID  | Категорія / severity        | Початкове місце                             | Проблема                                                                                                 | Виправлення та перевірка                                                                                                                |
| --- | --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | Inconsistency / HIGH        | spec FR-010, plan Candidate rejection, T018 | Ordinary новий click дозволяв повернути ту саму bad version всупереч backlog                             | C4: durable attempt exclusions + 24h scoped memory; expiry/version/settings/explicit revalidate; new-click/restart tests T018/T020      |
| U01 | Underspecification / HIGH   | plan fallback, T016–T019                    | «Bounded» без чисел і consumed budget після restart                                                      | C4: 32 candidates, retry/refresh/byte/time bounds; persisted counters; cap ≠ all-bad                                                    |
| U02 | Underspecification / MEDIUM | T015/T020                                   | Probe metadata міг пропустити corrupt cache або truncated image                                          | C4: bounded full decode/cache refetch; fixtures і пізній proven-failed processing recovery                                              |
| G01 | Coverage specificity / HIGH | T031–T036 проти research R1/R2/R5/R6        | Задачі не називали singleton→slots, recipe identity, Launch reuse, actual agent support і provider proof | T031–T036: конкретні файли/міграції/keys, old-agent-new-server тест, actual-cell readback і fail-closed CAS spike                       |
| I02 | Inconsistency / HIGH        | T043 проти FR-029                           | «Before due/held → empty» могло стерти вже published URL; held re-enable нечіткий                        | C5/C6: empty тільки first publication; active mapping збережений; explicit held→scheduled/add-now; T043/T046/T050                       |
| I03 | Inconsistency / MEDIUM      | T014 проти spec 031/BETA                    | CLI evidence із beta без уточнення disabled telemetry                                                    | T014/quickstart: synthetic isolated producer→ingestion→SELECT-only CLI окремо від real beta UI/provider                                 |
| I04 | Dependency / MEDIUM         | plan early package, T014, T056              | MVP начебто чекав full tasks для N/delay                                                                 | Quickstart package acceptance exact SHA; US1 пакет незалежний, full checklist не закривається subset; provider spike виконується у T031 |
| U03 | Underspecification / MEDIUM | A26/T053                                    | p95 без interaction/harness/samples/environment                                                          | Quickstart: три дії, 10 warmups + 50 samples, input→paint, seeded fixtures, environment, baseline/after                                 |
| I05 | Inconsistency / MEDIUM      | plan completion                             | Implementation-ready змішане з post-release T060                                                         | Розділено candidate T001–T059 і incident closure T060 після окремого production intent                                                  |
| D01 | Duplication / MEDIUM        | docs plan/tasks і пакет 047                 | Дві редаговані копії могли розійтися                                                                     | Старі docs стали посиланнями; spec/plan/tasks у 047 — один нормативний пакет                                                            |
| E01 | Executability / LOW         | quickstart baseline command                 | Два test paths мали помилкове .tsx                                                                       | Звірено наявні .test.ts; майбутні tests явно позначені planned                                                                          |
| G02 | Coverage / HIGH             | C1 проти publication model                  | Delay + restitch off дозволений UI, але model вимагав generated set                                      | VideoTarget source/version або video_set; original readiness без fake generation; T041/T044/T045/T050                                   |
| G03 | Coverage / HIGH             | publication policy / FR-030                 | Pending replacement не мав окремого active delivered pointer                                             | catalog_video_deliveries + pending policy target; verified swap; source/active/pending refs; published 1→10 сценарій                    |

Locations вказані за stable requirement/task/contract IDs: після remediation номери
рядків змінилися. Відтворення первинного production failure не замінюється цим
аналізом: download/share cause залишається предметом T003/T009/T010.

## Coverage summary

Нижче coverage означає «існує конкретна задача», а не passing tests або фактичну
diagnostic coverage. 36 FR + 8 buildable SC = 44 ключі. Post-release outcome
SC-008/T060 відділений від buildable acceptance у SC-008; бізнес-KPI не включалися.

| Requirement key | Has task? | Task IDs                                                                                 | Notes                               |
| --------------- | --------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| FR-001          | Так       | T009, T014                                                                               | Заплановано; ще не виконано         |
| FR-002          | Так       | T010, T014                                                                               | Заплановано; ще не виконано         |
| FR-003          | Так       | T011, T014                                                                               | Заплановано; ще не виконано         |
| FR-004          | Так       | T005, T006, T007, T009, T010, T011, T014                                                 | Заплановано; ще не виконано         |
| FR-005          | Так       | T012, T013                                                                               | Заплановано; ще не виконано         |
| FR-006          | Так       | T007, T018, T029                                                                         | Заплановано; ще не виконано         |
| FR-007          | Так       | T008                                                                                     | Заплановано; ще не виконано         |
| FR-008          | Так       | T016, T017, T020                                                                         | Заплановано; ще не виконано         |
| FR-009          | Так       | T005, T015, T016, T019, T020                                                             | Заплановано; ще не виконано         |
| FR-010          | Так       | T018                                                                                     | Заплановано; ще не виконано         |
| FR-011          | Так       | T019, T020                                                                               | Заплановано; ще не виконано         |
| FR-012          | Так       | T021                                                                                     | Заплановано; ще не виконано         |
| FR-013          | Так       | T022                                                                                     | Заплановано; ще не виконано         |
| FR-014          | Так       | T023                                                                                     | Заплановано; ще не виконано         |
| FR-015          | Так       | T024, T029                                                                               | Заплановано; ще не виконано         |
| FR-016          | Так       | T025, T037                                                                               | Заплановано; ще не виконано         |
| FR-017          | Так       | T026, T028                                                                               | Заплановано; ще не виконано         |
| FR-018          | Так       | T027, T028, T029, T030                                                                   | Заплановано; ще не виконано         |
| FR-019          | Так       | T031, T036, T040                                                                         | Заплановано; ще не виконано         |
| FR-020          | Так       | T031, T034, T035, T040                                                                   | Заплановано; ще не виконано         |
| FR-021          | Так       | T032, T035, T040                                                                         | Заплановано; ще не виконано         |
| FR-022          | Так       | T031, T036, T040                                                                         | Заплановано; ще не виконано         |
| FR-023          | Так       | T033, T034, T038, T039, T040                                                             | Заплановано; ще не виконано         |
| FR-024          | Так       | T037, T038, T040                                                                         | Заплановано; ще не виконано         |
| FR-025          | Так       | T042, T047, T050                                                                         | Заплановано; ще не виконано         |
| FR-026          | Так       | T045, T050                                                                               | Заплановано; ще не виконано         |
| FR-027          | Так       | T041, T044, T050                                                                         | Заплановано; ще не виконано         |
| FR-028          | Так       | T043, T050                                                                               | Заплановано; ще не виконано         |
| FR-029          | Так       | T046, T047, T050                                                                         | Заплановано; ще не виконано         |
| FR-030          | Так       | T046, T049, T050                                                                         | Заплановано; ще не виконано         |
| FR-031          | Так       | T004, T031, T033, T041, T043, T057                                                       | Заплановано; ще не виконано         |
| FR-032          | Так       | T004, T009, T010, T016, T031, T041, T044, T049, T056, T057                               | Заплановано; ще не виконано         |
| FR-033          | Так       | T005, T006, T007, T008, T014, T018, T029, T039, T048, T055, T056                         | Заплановано; ще не виконано         |
| FR-034          | Так       | T011, T036, T047, T051, T052, T054, T055                                                 | Заплановано; ще не виконано         |
| FR-035          | Так       | T019, T034, T038, T053, T057                                                             | Заплановано; ще не виконано         |
| FR-036          | Так       | T001, T002, T003, T004, T014, T020, T030, T040, T050, T055, T056, T057, T058, T059, T060 | Заплановано; ще не виконано         |
| SC-001          | Так       | T014                                                                                     | Заплановано; ще не виконано         |
| SC-002          | Так       | T020                                                                                     | Заплановано; ще не виконано         |
| SC-003          | Так       | T030                                                                                     | Заплановано; ще не виконано         |
| SC-004          | Так       | T040                                                                                     | Заплановано; ще не виконано         |
| SC-005          | Так       | T050                                                                                     | Заплановано; ще не виконано         |
| SC-006          | Так       | T052, T053, T055                                                                         | Заплановано; ще не виконано         |
| SC-007          | Так       | T014, T039, T048, T056                                                                   | Заплановано; ще не виконано         |
| SC-008          | Так       | T056, T057, T058, T059, T060                                                             | T060 тільки після фактичного релізу |

**Unmapped tasks:** немає; усі T001–T060 покриті таблицею. Вихідні CM01–CM16 і
F01–F12 додатково зіставлені в [tasks.md](tasks.md). US1: 9 tasks, US2: 6,
US3: 10, US4: 10, US5: 10; setup/foundation: 5; polish/acceptance: 10.

**Метрики:** task coverage 44/44 (100%); unchecked tasks 60/60; acceptance A01–A26.
Початкові ambiguity/underspecification findings U01–U03: 3; duplication D01: 1;
critical constitution findings: 0. Усі наведені findings мають remediation,
але жоден implementation task не позначений completed.

## Повторна перевірка

Фінальний structural check: PASS. Перевірено 60 унікальних ordered task IDs,
185 dependency edges без forward/cyclic dependencies, story labels, primary paths
і порожні Evidence; 44 requirement mappings, CM01–CM16 та рівно A01–A26.
Усі локальні Markdown links у 11 документах існують, baseline test paths правильні,
незаповнених template placeholders немає. Scoped Prettier і git diff --check — PASS.
SpecKit setup-plan/setup-tasks/check-prerequisites виконані в isolated metadata
context; repo .specify/feature.json лишився на 045, git branch main не перемикалася.
Extension hooks відсутні. Runtime tests, migrations і packaged beta у цьому
документаційному циклі не запускалися; усі implementation tasks відкриті.

Незалежна архітектурна перевірка підтвердила виправлення actual executor negotiation,
provider fail-closed contract, source/recipe identity, Launch fingerprint і
registered-versus-available прогресу; її додаткові G02/G03 внесені в model/contracts/tasks.
Останній незалежний recheck G02/G03 і held→scheduled: немає HIGH/CRITICAL
суперечностей. Приймання реального provider CAS залишається окремим T031 gate.

## Наступна дія

Після завершення поточного релізу виконувати [tasks.md](tasks.md) з T001 через
speckit-implement. Початковий MVP — US1 (download/share і diagnosis) з окремим
package acceptance. Повний scope включає US2–US5. Critical acceptance failure
блокує відповідний пакет; немає дозволу пропускати gates або публікувати production.
