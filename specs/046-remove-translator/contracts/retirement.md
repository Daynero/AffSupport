# Contract: original-only transcription and retired processing

## Protocol and compatibility

Зміна запланована: API6, supported [6,6], transcription contract6 у shared release.ts.
Product version/build і signed manifest не змінюються в design; їх визначає release prep.

| Web / Agent         | Поведінка                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------- |
| New API6 / new API6 | Original-only, translation execution відсутнє                                            |
| New API6 / old API5 | agent_update_required до queue/tool requests                                             |
| Old API5 / new API6 | web_update_required до queue/tool requests                                               |
| Old / old offline   | Віддалене відкликання коду не гарантується; new backend independently fences translation |

Tool min6 окремо не забезпечує третій рядок; потрібен двобічний API guard.
Взаємний version test перевіряє не лише label, а й відсутність запиту до tool state.

## Local command/state/document

Active settings: language оригіналу й quality. Active state/document не містить
translation summary, cached payload, translationSource, target language/decline,
translator/alignment model info або pivot phase/results. Old JSON проходить через
explicit whitelist. Corrupt translation fields не знищують valid original;
corrupt source core не приймається. Новий source text не змінює мову на англійську.

First-run download встановлює тільки speech model/потрібні чинні speech компоненти.
Copy/export content — тільки transcript; TXT/SRT/VTT з чинними timing rules.
Збереження з перекладом і переміщення медіа задля bilingual export видалені.

Раніше відомі route patterns translator download/cancel, job translations GET/POST/DELETE
і save-with-translation мають лише lightweight tombstone після чинних auth/origin gates:
`409 { error: 'FEATURE_RETIRED' }`, nonretryable, без запуску queue/model/provider.
Не створювати run для відхиленого запиту, не повертати cached translation.
У new typed client немає wrappers для цих дій. Старі settings поля відкидаються на
читанні persisted state; live mutation retired-only fields відхиляється FEATURE_RETIRED,
mixed active+retired patch відхиляється цілком, без часткового збереження.

Усі решта route/error envelopes зберігаються. Тільки historical-compatible reader
може знати old literals; це не route, що виконує стару фічу.

## Library processing commands

Active kinds: transcription/landing_optimization. New identities, chosenKinds і
supportedKinds не приймають translation; mixed kind list з retired значенням
відхиляється атомарно FEATURE_RETIRED до enqueue. Null/default scan означає всі
**чинні** види. Dry-run і commit мають однаковий active denominator.

Active scan response містить created/missing/ready лише чинних kinds; новий parser
відкидає legacy translation counts і не включає їх до загального progress. Раніше
відомий backend payload може читатися інертно заради original fields, але retired
значення не перетворюються на supported kind або дозвіл дії.

Claim/heartbeat/cancel/fail/accept і explicit identity commands перевіряють stored requirement.kind. Для
translation: nonretryable FEATURE_RETIRED, без pending/running/ready transitions,
нової спроби, contribution або success event. Expiry recovery її не підхоплює.
Bulk scoped retry без explicit kind пропускає retired rows, повторює лише active failed
роботи й повертає active count; mixed scope не відхиляється через інертний старий рядок.
Explicit retired kind/attempt command відхиляється FEATURE_RETIRED.
Скасовані retirement записи не можна воскресити через пізній heartbeat/fail.
Усі чинні team/actor/lease/source/idempotency guards залишаються.

`list_video_text_variants` повертає лише original, зі збереженим original-companion
fallback. Якщо лишився тільки translation, original відсутній і може бути створений
за чинними правами. Primary transcript copy/view ніколи не вибирає legacy translation.

## Generic process/grant/upload fence

Це окремий шлях, не підмножина library finalize.

| Межа                           | Обов’язкова перевірка                                               |
| ------------------------------ | ------------------------------------------------------------------- |
| Process start/intent binding   | Новий translation tool не створює operation/grants                  |
| Process input/grant consume    | Stored intent.tool_id authoritative; revoked/retired refused        |
| Prepare upload                 | Stored intent/operation/grant binding, retired refused              |
| Output start                   | Edge guard до provider request; DB admission guard проти stale Edge |
| Output finalize                | Не допускає adoption/registration retired result                    |
| Browser upload finalize        | Та сама stored process guard, навіть без kind у body                |
| SQL finalize uploaded material | Транзакційна відмова до нового material/link/result/contribution    |
| Cache/generated text           | Не індексує/реєструє новий translation як current/original          |
| Contribution append            | New translation contribution refused, history unchanged             |

Незавершені старі operations припинені, active process_input/finalize grants revoked.
Сервер не покладається на version UI або на те, що нова queue «не попросить» стару дію.

Historical succeeded replay дозволений лише як readback вже прийнятого незмінного
result ID, без нового provider I/O або мутації. Library accept retired kind не має
success-replay винятку. Auth/source/ownership guards не обходяться жодною гілкою.

In-flight remote upload може залишитися unknown поза DB транзакцією. Він не отримує
нового product registration. Чинні cleanup ownership/adoption правила збережені,
нового blanket cleaner немає. Уже прийняті файли не видаляються й не відв’язуються.

## Historical file/read compatibility

Private companion snapshot parser продовжує читати legacy translation role для
move/share/copy/trash/restore. Active creation/process enums її не пропонують.
Ні role, ні legacy result не перейменовуються в original. Системні UI labels можуть
бути нейтральними, збережені historical records і користувацькі names/content незмінні.

## Diagnostics

### Correlation and stage evidence

| Journey                   | Identity / stages                                                                                        | Що є доказом                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Original transcription    | flow=job.id, run=чинний job binding, новий attempt UUID; accepted→input/extract→transcribe→saved→visible | Agent journal для accepted/stages/saved/terminal; browser visible після document commit |
| Space processing          | batch flow UUID, run=operation UUID, attempt=library attempt UUID, source-version binding                | scan/accepted/execution/saved/uploaded/registered/visible окремі факти                  |
| Cancel/interruption/retry | Той самий flow, окремий accepted retry attempt                                                           | Причина й остання доведена стадія; жодного invented success                             |
| Rejected retired request  | flow/request UUID якщо є, existing attempt/operation лише якщо справжній                                 | FEATURE_RETIRED refusal, без fictitious run/start                                       |
| Stored retirement         | opaque existing requirement/attempt/operation IDs                                                        | canceled transition + FEATURE_RETIRED; historical ready unchanged                       |

Використати чинні operation_started/stage/completed/failed/cancelled та result_opened
events, typed discriminators `transcription_original`, `transcription_result_visible`,
`library_original_processing`. Original variant повертає optional accepted `attemptId`
(opaque UUID, null/absent для historical companion). `result_opened`/visible
емітується після commit тексту; copied — після clipboard success. Це з’єднує
видимість із попередніми accepted/uploaded/registered receipts тієї самої спроби.
Historical companion без provenance не отримує вигаданої спроби.
Result visibility не виводиться зі status=completed.
Зберегти existing run counts, нова attempt correlation не створює дубль старту.

Agent journal розширюється закритою категорією transcription та кодами accepted,
stage, terminal, feature_retired, з allowlisted stage/outcome/apiVersion6/opaque IDs.
На один original attempt максимум 12 записів. Повторні однакові стадії deduplicate
до emission; зарезервувати accepted, saved, terminal та один omission marker,
решта бюджету — максимум 8 проміжних переходів. Перший пропуск дає bounded marker;
terminal містить omitted_stage_count і останню доведену стадію. Saved/terminal
не губляться через вичерпання проміжного бюджету; crash без terminal лишається unknown.
Без progress ticks, filenames, content,
models inventory або provider payloads. Чинні 2000 records/1MiB і транспорт лишаються.
Новий FEATURE_RETIRED проводиться через shared current error lists, team transport,
Edge status map (409/nonretryable), DB error catalog, sanitizers і code-map.
Historical translation errors лишаються в окремому read catalog; code-map посилається
на retained shared compatibility/current boundary, не видалені translator файли.

### Read-only evidence

Новий restricted `analytics_translation_retirement` view і reader описані в
[data-model.md](../data-model.md#diagnostic-projection). Reader додається до inspect,
investigate й audit, без нового ad-hoc SQL від агента або нового dashboard.
Default limit100/max500, period/as-of bound, explicit truncated/schema gaps.
Якщо actor/binding не відомий, читання за email не вигадує зв’язок: required ID або
insufficient; identifier lookup через наявні authorized analytics seams.

Audit зберігає current lifecycle retired-for-API6 окремо від historical coverage;
дозволене additive status/lifecycle поле з tests усіх consumers. Unknown build/API
не прирівнюється до нового producer. Дата migration filename не є cutover instant.
Відсутня/затримана terminal/delivery, changed-after-as-of snapshot і старий unknown
producer лишаються явними blind spots. Поточний view не реконструює mutable history.

### Acceptance of evidence

Producer→sanitizer→stored event/journal/authoritative row→CLI→agent finding перевіряється
для успіху, failure, cancel, interruption, retry, retirement refusal, delayed/missing
signal і older schema. Emit-only test недостатній. Beta без analytics delivery:
локальні журнали та fixtures reader; real delivery не позначати доведеною.

## Non-goals

Не видаляти provider-файли, старі локальні моделі/cache, applied migrations, історичні
події й frozen releases. Не додавати installer cleaner, нову queue/recovery службу,
polling або окремий екран про ліквідацію. Не виконувати production дії цими документами.

### Уточнення за concurrency regression

Транзакція, що вже увійшла в попередню PL/pgSQL body до cutover й чекала на lock, може завершитися старим LEASE_EXPIRED після скасування її attempt. Вона не публікує результат. Новий виклик після committed cutover обов’язково повертає FEATURE_RETIRED; тест перевіряє обидві відмови й незмінність material count. Це не дозвіл на replay або нову роботу.
