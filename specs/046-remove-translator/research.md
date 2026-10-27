# Research: повне видалення перекладача

**Дата**: 2026-10-27. Локальне read-only дослідження; production не читалася й не змінювалася.

## R1 — Взаємна сумісність

**Decision**: API6, supported6–6, transcription6 у `packages/shared/src/release.ts`.
**Rationale**: `toolContractCompatible` minimum-only, старий web min5 приймає tool6.
`connection.ts:41` перевіряє обидві межі API, `api/client.ts:188` не читає tool state
після несумісного health. State/routes removal справді несумісний.
**Alternatives**: tool bump alone недостатній; нова handshake negotiation зайва.

## R2 — Локальні старі дані

**Decision**: read normalization explicit whitelist, без disk migration/cleaner.
**Rationale**: `transcription/document-store.ts:716` spread raw залишив би translations
у GET. Перевіряти core оригіналу, не legacy payload. Змінити протилежні очікування
`tests/transcription-reliability.test.ts:126`, `transcription-quality.test.ts:98`;
PIVOT_UNAVAILABLE відкинути з чинного reliability/UI.
**Alternatives**: масове переписування зайве; new-only reader втрачає оригінали;
raw spread лишає фічу в активному контракті.

## R3 — Непрямі текстові залежності

**Decision**: спочатку нейтральні segmentation/range/selection/scroll seams.
**Rationale**: Whisper chunks/words/transcriber і document store імпортують
`translation/segmentation.ts`; `selection-dom.ts` залежить від `alignment.ts`,
а modal використовує source pointer selection і centerActiveWord.
**Alternatives**: механічне видалення ламає оригінал; новий алгоритм змінює таймінги;
лишити старі execution modules під приводом helpers означає неповне видалення.

## R4 — Прихований Whisper pivot

**Decision**: прибрати createEnglishPivot, translateToEnglish/-tr, englishText/Words,
pivot phase та translationSource; source progress використовує весь source budget.
**Rationale**: `transcription-queue.ts:1290`, `whisper/transcriber.ts:338–430,1123`
додають англомовний прохід для Hindi/Urdu. Мовна підтримка лишається.
**Alternatives**: Gemma-only removal залишає зайву важку роботу.

## R5 — Library RPC

**Decision**: forward-only зміна останніх scan/claim/heartbeat/cancel/fail/retry/accept,
variants/totals; historical constraints/ready rows зберегти.
**Rationale**: scan — `20260916190000_batch_chooses_its_work.sql:11`; claim —
`20260906030000_library_scope_is_a_set.sql:212`; retry —
`20260906050000_retry_speaks_of_a_set.sql:10`; heartbeat/cancel/fail/accept —
`20260814101000_creative_library_actions.sql:845,903,935,1002`.
Expiry/cancel повертають роботу в pending, fail/heartbeat можуть воскресити canceled.
Потрібні guards кожного transition, не лише разове припинення rows; ready counts теж фільтруються.
**Alternatives**: UI-only лишає writers; видалення legacy constraints ламає rows;
редагування applied SQL порушує canonical replay.

## R6 — Generic process/upload

**Decision**: stored translation intent fence для start/grant consume/prepare/start/
finalize/register/contribution; active operations canceled, grants revoked.
**Rationale**: незалежний flow у `drive-ops/index.ts:176,1862,2066,2191,1001`;
останній intent RPC — `20260801102000_team_transfer_operations.sql:341`, grant consume —
`20260827106000_team_thumbnail_session.sql:72`, generic finalize —
`20260830180000_finalize_overwrite_support.sql:13`, output start —
`20261206134000_process_upload_ownership.sql:100`, prepare —
`20261206135000_process_output_adoption_fence.sql:18`.
Kind не присутній у кожному request, треба читати stored binding.
**Alternatives**: Edge-only обходить stale Edge/grant; SQL-only не зупиняє provider I/O;
blanket cleanup втрачає файли й порушує ownership.

## R7 — Sidecars і original fallback

**Decision**: private historical role reader зберегти, active video-text DTO original-only.
**Rationale**: group snapshots у `creative_library_actions.sql:1677,1804` і
`_shared/library.ts:33,173` читають translation role. `VideoTextActions.tsx:62` зараз
надає перекладу перевагу. Останній variants RPC —
`20260830150000_video_text_variants_companion.sql:11` — має original companion fallback.
**Alternatives**: прибрати роль скрізь — broken group actions/orphans;
перейменувати translation в original — підміна змісту.

## R8 — Причина припинення й діагностика

**Decision**: closed nonretryable FEATURE_RETIRED, current envelopes, restricted
retirement view/schema-aware reader, historical error catalog і version-aware registry.
**Rationale**: WRONG_STATE не пояснює припинення; code-map file-existence test
не дозволить посилатися на видалений coordinator. Registry translation зараз unsupported,
тому історичне використання лишається невідомим.
**Alternatives**: стерти історію — втрата доказів; uncovered current capability — хибна
діагностика; нова analytics служба — зайве.

## R9 — Очищення й випуск

**Decision**: залишити старі local artifacts, прибрати active dependencies/notices/env,
повний узгоджений release через чинні gates.
**Rationale**: owner відмовився від складного прибирання; моделі докачуються,
не вбудовані в installer. Agent/shared/Edge/DB зміна не є web-only mini release.
**Alternatives**: cleaner/новий UI видалення поза scope; web-only несумісний.

## Outcome

Усі design decisions визначені, невирішених уточнень немає. Номери рядків — орієнтири
на дату дослідження, реалізація повторно перевіряє останні definitions. Це не product
acceptance evidence. Попередній bundle-budget failure лишається явним baseline.
