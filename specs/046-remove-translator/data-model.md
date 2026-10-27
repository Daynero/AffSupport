# Data model: translator retirement

## Original transcription

Active DTO: перевірені source/job identity, settings `language/quality`, чинний status,
attempt correlation, original text/segments/words/timings/language/core reliability.
Немає translationLanguage/Declined, summary, translations, translationSource,
translator/alignment model states, pivot phase/results.

Old JSON reader перевіряє core та відбирає поля явно, без spread raw. Legacy translation
payload і PIVOT_UNAVAILABLE відкидаються незалежно від їх пошкодження; invalid source
core як і раніше refused. Нове збереження пише лише active поля. Старий кеш на диску
не сканується/не переписується масово й не запускає задач.

Correlation: `flow_id=job.id`, `run_id` зберігає чинну job прив’язку, `attempt_id` —
новий opaque UUID кожного прийнятого запуску/повтору. Старі записи без attempt ID
не отримують вигаданої історичної кореляції.

## Active library entities

| Entity         | Active invariant                                                       | Historical policy                                                                         |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Requirement    | transcription/original або landing_optimization/чинний variant         | Stored translation не claimable                                                           |
| Attempt        | Actor/team/source/lease guards і окремий attempt на повтор             | Translation не heartbeat/retry/finalize                                                   |
| Result         | Original transcript або landing result                                 | Готовий переклад не видаляється й не стає original                                        |
| Video text DTO | Original-only, актуальна sourceVersion; optional accepted attempt UUID | Original-companion fallback зберігається; legacy-only translation не задовольняє original |
| Scan           | Created/missing/ready тільки active kinds, включно з null/default      | Historical translation не входять у знаменники                                            |
| Contribution   | Нові active actions                                                    | Historical translation не переписуються як transcription                                  |

Active command parsers і private historical readers мають різні допустимі значення;
не робити історію невалідною через видалення значення з active union.

## Retirement transitions

Нового business state `retired` немає. Використати чинний `canceled` у library rows і team_operations, FEATURE_RETIRED у reason/error полі й наявні transition timestamps.

| Початковий запис                                            | Після retirement                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Translation requirement pending/leased/running/failed/stale | canceled + FEATURE_RETIRED, не активна робота                       |
| Already canceled/skipped requirement                        | Неактивний, повтор не створює спроб                                 |
| Ready requirement/result                                    | Збережений historical факт, виключений з active counts/variants     |
| Leased/running attempt                                      | canceled + FEATURE_RETIRED + finished_at, lease без права виконання |
| Historical terminal attempt                                 | Збережений факт, нова публікація заборонена                         |
| Pending/running generic translation operation               | canceled + FEATURE_RETIRED, input/finalize grants revoked           |
| Succeeded generic operation                                 | Незмінний вже прийнятий результат; тільки historical readback       |

Guards і припинення встановлюються однією forward-only транзакцією. Після неї
expiry/cancel/fail/heartbeat/retry не повертають translation у pending/running/ready;
new insert/kind change теж blocked. Повторне припинення ідемпотентне, не другий success. Bulk scoped retry ігнорує
retired rows і повертає active count, explicit retired request відхиляється.

## Process ownership and companions

Stored intent.tool_id, operation/team/actor/sourceVersion/grant binding — authoritative.
Retired tool відхиляється до grant issue/consume, provider I/O та result adoption.
Чинні ownership/adoption fences лишаються; request body не підмінює stored intent.

Матеріали/links не видаляються. Старі companion roles читаються приватно для групових
дій, без чинного create/process контракту перекладача. Звичайний файл доступний за
своїми правами та довільною користувацькою назвою.

Уже розпочатий provider upload може мати unknown наслідок. Гарантія — відсутність
нового прийнятого translation result, не вигадана фізична відсутність remote-файла.
Масового cleaner немає, existing cleanup не обходить ownership і не чіпає прийняті файли.

## Diagnostic projection

Restricted `public.analytics_translation_retirement` (запланований view):

- Closed record_kind: requirement/attempt/operation.
- Opaque id/team_id та actor_id/requirement_id/attempt_id/operation_id/agent_instance_id
  лише за наявного доведеного зв’язку.
- Closed state/reason_code, created_at/updated_at/finished_at згідно з source semantics.
- retirement_api_version=6 — версія правила, **не** доведена версія старого пристрою.

Без names/paths/text/provider IDs/URLs/grants/secrets. REVOKE від public/anon/authenticated,
SELECT лише service/analytics roles; source tables не стають доступними writer-ам.
Reader default100/max500, bound period/as-of, explicit truncated/schema gaps.
Mutable rows, змінені після as-of, не реконструюються; unknown actor/version/delivery
залишаються blind spots. Віддалений список встановлених моделей не збирається.

## Historical errors and coverage

TRANSLATION_FAILED/TRANSLATOR_UNAVAILABLE та historical translate stage зберігаються
в inert catalog для CLI, без active producer і без file links на видалені модулі.
FEATURE_RETIRED — current closed refusal; rejected request не отримує fictitious run.
Registry розділяє current lifecycle retired-for-API6 і historical producer coverage.
Missing version provenance означає unknown applicability; absence of events ≠ zero usage.
CLI envelope незмінний, retirement evidence лише additive.
