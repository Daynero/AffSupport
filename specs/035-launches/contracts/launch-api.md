# Launch API contract

Нові методи — проєкт, не вже доступні endpoints. Browser wrappers у apps/web/src/api/team.ts; SQL-only CRUD через Supabase RPC, generation orchestration через drive-ops handler. Використати чинні TeamApiError/TeamFunctionError envelopes й guards, не вводити REST сервер.

## Спільні правила

Every input is unknown → typed parser; actor береться із verified session, не request body. teamId UUID і актуальний доступ обов'язкові. Request key 8–200 safe символів за requireIdempotencyKey; digest bound до actor/team/action/payload. Same key+digest → replay; mismatch → conflict. Version — bigint wire decimal string, не JS number, щоб уникнути precision loss.

List DTO не містить URL. Detail містить секретні рядки тільки після view ACL. Mutation відповідає authoritative snapshot/version, а не optimistic guessed result. Transport timeout → lookup request, не новий UUID.

## Read/CRUD

| Method               | Input                                                                             | Output / правила                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| listLaunches         | teamId,cursor?,pageSize<=100,search?,workStatus?,assigneeId?,date all/range       | items,nextCursor. Дата включна YYYY-MM-DD; фільтр до pagination, стабільний date/id cursor; зміна filter скидає cursor               |
| getLaunch            | teamId,launchId,revisionId?                                                       | aggregate/version,draft,active result,selected historical result,generation state; foreign revision відмовляється                    |
| saveLaunchDraft      | teamId,launchId?,expectedVersion?,requestKey,config,expectedSourceSnapshot?       | launchId/version; partial draft дозволений, Generate вимагає повної валідності                                                       |
| updateLaunchMetadata | teamId,launchId,expectedVersion,requestKey,assigneeId?/workStatus?                | version; generation lock; no result regeneration                                                                                     |
| listLaunchRevisions  | teamId,launchId,cursor                                                            | revision summaries, no URL до detail                                                                                                 |
| copyLaunch           | teamId,sourceLaunchId,sourceRevisionId?,expectedSourceVersion,requestKey,timezone | new launchId/draft/version. Source refs/config copied, tomorrow/todo, active assignee; no outputs/overrides/history/file duplication |
| archiveLaunch        | teamId,launchId,expectedVersion,requestKey,suppressCatalogRetentionWarning=false  | archived/version. Active generation відмовляє; warning eligibility за всіма revisions; preference комітиться атомарно лише при true  |

Copy/archive не відправляють запрошень чи повідомлень учасникам. Double click copy = один новий Launch на key.

## Dictionaries/defaults

list/create/archive offers і buyers: team scope, manage_metadata для запису, view для читання. Buyer creation normalizes spaces; invalid non-ASCII відмовляє; Offer лишається одним текстом. Unique normalized dictionary key; collision повертає existing ID.

get/setLaunchDefaults(teamId,expectedRevision,requestKey,config,subConfig): whitelist, schemaVersion, без URL/material/date/РК/assignee/offer/overrides. Персональна delete preference — окремий scope team/user, не default простору.

## Generation

`generateLaunch({teamId,launchId,expectedVersion,baseRevisionId,requestKey})` читає збережений draft, resolve-ить sources і запускає accepted intent. Edge pure generator формує derived payload; service RPC ще раз перевіряє version/source identity і комітить snapshot+campaigns+generation атомарно. Browser-supplied derived names/budgets не є довіреними.

Відповідь містить generationId/revisionId/state/stateVersion, childOperationIds, confirmed stage і progress evidence. Детальний schema див. generation.md. `getLaunchGeneration` та `findLaunchGenerationByRequestKey` відновлюють lost reply. `resumeLaunchGeneration` і `cancelLaunchGeneration` використовують explicit requestKey/version, не створюють нової конфігурації.

Публікацію ready виконує restricted service RPC за fence/current state. UI не має права встановлювати succeeded, variant або output IDs.

## Manual overrides

`saveLaunchResultOverrides({teamId,launchId,baselineRevisionId,expectedVersion,requestKey,overrides})` → new manual revision/version, catalog reused. Allowed field keys: advertisingUrl, campaignName/budget/adRange за ordinal, catalogName/catalogUrl, subValue за slot якщо показаний. Тільки bounded strings; content validation повертає field errors. Baseline editable outputs не містять internal IDs/state.

Локально copy використовує поточне значення до save. Save не запускає catalog чи normalizer всього URL. Для SUB controls — той самий ASCII guard. Conflict не стирає local overrides; user може reload/merge свідомо.

## Errors

Reuse: INVALID_INPUT, PERMISSION_DENIED, NOT_FOUND, WRONG_STATE, SOURCE_CHANGED, SHARE_NOT_ALLOWED, DRIVE_UNAVAILABLE, SPACE_BLOCKED, AGENT_UPDATE_REQUIRED де вони вже підтримані потрібним seam.

Запропоновані нові codes: LAUNCH_VERSION_CONFLICT, LAUNCH_BUSY, LAUNCH_URL_INVALID, LAUNCH_SUB_INVALID, LAUNCH_BUDGET_INVALID, LAUNCH_RESULT_UNCERTAIN. До додавання перевірити чинні closed code sets; wire mappings shared/Edge/web/analytics оновлюються разом. Payload: code, retryable, safe field/stage; без URL, value, filename або provider error body.

## Source snapshot і підтверджене прев’ю

`expectedSourceSnapshot` — versioned typed набір source IDs, versions та фактичних source values, використаних у прев’ю: соц/зв’язок РК/external ID, offer, Buyer, material identity/version і застосовні catalog/restitch settings. Це очікування клієнта, не довірене джерело генерації. Shared parser визначає точний whitelist; не включати URL/токени чи випадково вибрані під час generation ресурси. Snapshot отримується з авторизованих source reads і зберігається разом із draft через saveLaunchDraft. Partial draft може мати неповний snapshot, Generate — ні.

Generate читає snapshot з draft, сервер сам resolve-ить доступні sources і порівнює їх із очікуванням до прийняття intent та side effects. Зміна version/identity/релевантного value → SOURCE_CHANGED; навіть якщо aggregateVersion Launch незмінна. DB-джерела повторно перевіряються в intent transaction; зовнішній material version фіксується при revalidation і перевіряється перед використанням. Невідомий зовнішній version не означає збіг. Неможливість довести source identity блокує відповідний етап, а не дає cache hit. Error містить лише safe тип зміненого джерела; актуальні values отримуються захищеним read. UI пропонує явне «Оновити джерела», оновлює preview і зберігає новий expected snapshot після перегляду. Старі revisions не змінюються. Replay вже прийнятого requestKey повертає той самий intent до порівняння із новими live sources; зміна джерела не перетворює replay на нову генерацію.

## Поточний пояс при копіюванні

`copyLaunch.timezone` — обов’язковий поточний IANA timezone браузера, перевірений сервером; не брати пояс із source revision. У першій успішній transaction сервер фіксує час прийняття, обчислює в цьому поясі наступний календарний день і зберігає date/timezone нової чернетки. Replay тим самим requestKey повертає той самий Launch і дату, навіть після півночі або DST. Клієнт зберігає початковий payload/key для retry; зміна timezone з тим самим key → digest conflict.

## Відновлення конфігурації з історії

Окремий RPC не потрібний: authorized getLaunch(revisionId) → локальна робоча копія historical config → saveLaunchDraft з expectedVersion і новим requestKey → Generate після звичайного diff/confirmation. Перед save поточні sources явно звіряються, як описано вище. Відновлення переносить конфігурацію, включно зі збереженою датою та ручними config budgets, але не result overrides/outputs/operations; assignee/workStatus не змінює. Для manual revision береться її config snapshot, не effective output fields. Save draft не створює result revision; лише успішна генерація публікує нову. Existing active result і всі historical revisions залишаються доступними. edit ACL, generation lock і optimistic conflicts ті самі, що для звичайного редагування.
