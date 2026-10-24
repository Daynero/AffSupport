# Specification Quality Checklist: передпродакшен-прийомка

**Purpose**: перевірка якості специфікації, не виконання продуктових тестів.
**Created**: 2026-10-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Специфікація описує користувацькі результати; технічний порядок винесено в runbook/capacity-plan.
- [x] Фокус на готовності до продажів, збереженні даних і доступності.
- [x] Основний текст українською, зрозумілий власнику продукту.
- [x] Усі обов’язкові розділи шаблону заповнено.

## Requirement Completeness

- [x] Немає нерозв’язаних NEEDS CLARIFICATION; припущення явні.
- [x] Вимоги перевірні, є конкретні пороги й стани.
- [x] Критерії успіху вимірювані та сформульовані через результати.
- [x] Приймальні сценарії визначені для всіх п’яти user stories.
- [x] Граничні випадки та конкурентні дії включено.
- [x] Scope обмежений baseline/candidate, із manifest локальних змін.
- [x] Залежності, test fixtures, hosted/Windows межі та припущення названо.

## Feature Readiness

- [x] FR-001–003 → SET/TEAM/runbook; FR-004/008 → TEAM/ACL; FR-005 → SYNC; FR-006 → TARIFF/LIFE; FR-007 → RO.
- [x] FR-009 → scope/REG/LAUNCH; FR-010–011 → LOAD/capacity; FR-012 → report; FR-013 → runbook; FR-014 → REG-017/OBS-009–010; FR-015 → report.
- [x] 174 кейсів мають ID, передумови, кроки та очікування; форма виконання відокремлена.
- [x] Діагностика охоплює delivery, failure, partial, cancel, recovery та unknown; захищені дані не збираються.
- [x] Достатність Free не заявлена без вимірів; квоти мають офіційні джерела.
- [x] Відмінність read-only/призупинення та ручних тарифів/платіжного процесора явно зафіксована.

## Notes

Якість документа перевірено; жоден продуктовий кейс не виконаний. Технічні назви браузерів, Supabase та CLI залишено там, де вони є явною вимогою користувача або потрібні для безпечної діагностики, а не як запропонована нова архітектура.

Наступна фаза — speckit-plan: підготовка fixtures керованого часу/помилок, безпечного capture повідомлень, harness прямих відмов і навантаження, рішення про isolated hosted стенд, потім виконання каталогу. Відсутність цих засобів під час виконання дає BLOCKED, не PASS.

Hooks: `.specify/extensions.yml` відсутній під час створення; before/after hooks не застосовуються. Preset overrides відсутні; використано `.specify/templates/spec-template.md`. Активну фічу записано у `.specify/feature.json`.

Поправка 2026-10-14: FR-016 → LIFE-021–036; нова вимога автоматичного відновлення відділена від поточної ручної реалізації, задачі 034 T023–T029 відкриті.

Планування виконано: plan.md, research.md, data-model.md, contracts/recovery.md, contracts/acceptance-tooling.md та quickstart.md. Наступна фаза — speckit-tasks; фраза про speckit-plan вище описує стан до планування.

Генерацію tasks завершено: [tasks.md](../tasks.md), 83 відкриті задачі, 174 кейси зіставлено з execution tasks. Готово до cross-artifact analyze; продуктових PASS не додано.

## Виправлення consistency analysis

Документальні виправлення внесено; реалізація та runtime перевірки ще не виконані.

| Finding | Виправлення та перевірні задачі                                                      |
| ------- | ------------------------------------------------------------------------------------ |
| I1      | SC-004: лише актуальні права; T021, T030, T050                                       |
| U1      | Enrollment та двоступеневі credentials, lost-response rotation; T026, T028, T033–039 |
| U2      | Durable WorkspacePause/PauseItem до renewal; T024–025, T029–030, T047                |
| G1      | Candidate hosted runtime bootstrap/readiness; T064, T071–072                         |
| I2      | EvidenceAdoption, окремі totals та заборонені категорії; T006–007, T055–056, T079    |
| G2      | Native browser visible-result latency під load; T063, T065–066, T072–073             |
| U3      | Числові retry/request budgets та exhaustion; T027–028, T038, T046, T068, T074        |


Оновлення2026-10-21: нотатки про відсутність execution вище є історією створення checklist.
Чинний стан реалізації/доказів — [execution-report.md](../execution-report.md) і [tasks.md](../tasks.md).
034 development recovery закрито до цієї кампанії;036 перевіряє його, не створює другу реалізацію.
Formal development executions5PASS,4BLOCKED,165NOT_RUN; production NO_GO.
