# Data model — Launches

Це майбутня схема, не міграція. Усі назви `team_launch_*` нові. Реальні джерела: teams/members, team_accounts/team_account_agents, materials, team_product_catalogs, team_operations. `team_agent_runs` не стає Launch.

## Aggregate і версії

`team_launches` — mutable aggregate: UUID id/team_id, created_by, nullable assignee_id + label snapshot, work_status(todo/in_progress/done), draft_config, draft_version bigint, aggregate_version bigint, active_revision_id nullable, copied_from_launch_id/revision_id nullable, archived_at, timestamps. Assignee — active member, не Buyer. Усі mutations compare expected aggregate version. Draft save також збільшує draft_version.

Revision має immutable content після insert. Generation state записується окремо. Поки нова generation працює, active_revision_id лишається попереднім. Ready publication — atomic CAS лише після catalog registration, якщо застосовно.

`team_launch_revisions`: UUID/team/launch, monotonic revision_no, result_kind=generated/manual, base_revision_id, baseline_revision_id для manual, config snapshot, resolved sources snapshot, original_url, generated_url, sub_values, generator versions/signatures, typed result_overrides, created_by/at. Unique(launch_id,revision_no). Candidate revision відображається тільки як pending/failed generation, не автоматично як активна.

Manual revision посилається на generated baseline і містить effective override map. Новий manual save від manual revision зберігає той самий generated baseline, merged overrides і explicit parent revision. Reset видаляє override; baseline лишається. Генератори ніколи не читають overrides як config.

`team_launch_campaigns`: team/revision/ordinal, budget_usd integer, ad_start/ad_end positive integer, name. Unique(revision,ordinal); всі N rows атомарні. Для generated revision rows створює довірений generator; manual revision не дублює rows, читає baseline + overrides. API завжди повертає effective rows і separate generated baseline, щоб позначки було можливо відновити.

## Config snapshot

- schemaVersion, agentRowId, offerId, buyerId, materialId, creativeAlias.
- campaignCount/maxBudget/adsCount, budgetMode=auto/manual, overrides масив або null.
- age, gender=M/W/ALL, advantagePlus, method=catalog/other.
- launchDate YYYY-MM-DD, timezone IANA snapshot.
- originalUrl exact string; subConfig version + ordered enum arrays.
- catalog options: productCount, restitchEnabled, finalDurationMode/customFinalDurationSeconds; hidden catalog options можна тримати у draft, але не виконувати для other.

Resolved sources: accountId/name, full textual agentId/suffix, offer name, buyer raw/normalized value, creative filename/alias/materialId/driveVersion, resolved restitch defaults і selected resources/versions. Resolved values походять із доступних team sources; сервер повторно перевіряє version перед прийняттям snapshot. Видалення source не каскадує immutable content.

## Довідники й defaults

`team_launch_offers`: id/team/name/normalized_key/archived_at/created_by/timestamps. `team_launch_buyers`: аналогічно value. Unique(team,normalized_key), duplicate create повертає existing. Archived item не пропонується новій конфігурації, історичний snapshot читається.

`team_launch_defaults`: team PK, config_schema_version, config без конкретних URL/material/РК/offer/date/assignee/overrides, окремий sub_config, revision, updated_by/at. Manage_metadata, optimistic update.

`team_launch_member_preferences`: composite PK team/user; suppress_catalog_retention_warning default false, updated_at. Тільки власні preference активного учасника. Прапорець комітиться лише з успішним archive. Видалення Launch з каталогом у будь-якій revision лишає каталог/перезашите відео.

## Generation і children

`team_launch_generations`: id/team/launch/revision, request_key, request_digest, state, stage, state_version, attempt_no, lease_owner/token/expiry, fence bigint, last_progress_at, safe_error_code/retryable, cancel_requested_at, timestamps.

States:

```text
accepted → running ↔ waiting_dependency
running → partial / failed / interrupted / succeeded
accepted/running/waiting_dependency/partial/interrupted → cancel_requested
cancel_requested → canceled_with_cleanup_pending → canceled
cancel_requested → canceled   (немає side effects)
failed/partial/interrupted → running   (explicit resume, новий attempt)
```

Success commit і cancel acceptance змагаються під row lock. Якщо success вже committed, cancel повертає completed result; якщо cancel accepted першим, executor не публікує output. Cleanup pending залишається неготовим станом із lock, як визначено користувацьким сценарієм. Retry не відновлює canceled generation; нове явне Generate створює новий intent.

Unique(team,request_key), partial unique index одного unsettled generation на launch. Request digest server-only; mismatch same key дає conflict. Hash не міститься в diagnostics. One stage attempt key для transport retries, новий attempt key лише після доведеного failure, зі зв'язком predecessor.

`team_launch_generation_steps`: generation/team, stage, attempt_no, stable_step_key, team_operation_id, state, input_signature, result_material_id, reserved_variant, provider_intent_key, provider_file_id, fence, safe error/timestamps. Ключі/refs записуються до IO; random outputs/selections зберігаються до retry. Shared catalog reservation може жити у спільній catalog operation table, а step зберігає FK на неї, не другу reservation.

Output і sharing rollback ledger: належить чинному operation persistence seam; записує generation/step owner, resource/permission ID, before-state, created_by_this_attempt, registration/publication state, cleanup state/attempt/error. Не дублює credential/token. Додавання такої структури — частина M4; без доказу ownership cleanup заборонений.

`team_launch_revision_catalogs`: team/revision PK, catalog record ID, catalog material ID, variant, name snapshot, sheet_url з Google Drive, restitch operation/material IDs, settings snapshot. Names-only revision може посилатися на той самий каталог. Catalog ref сам не є ownership: shared/published artifacts не належать cleanup поточного attempt.

## Constraints й індекси

- Composite same-team FKs для всіх live refs; check active revision belongs to same Launch. Source refs nullable/guarded; snapshots зберігаються.
- Positive integer bounds; safe multiplication N×adsCount; date validity; exact allowed enums; JSON validated by canonical parser + structural DB checks.
- Не використовувати CASCADE від material/account/member на Launch history. Видалення учасника очищає assignee, snapshot лишається.
- List index(team,archived_at,effective_launch_date desc,id desc), assignee/work_status indexes. effective_launch_date підтримується сервером із active revision, а до неї — draft.
- Operation indexes(team,request_key), unsettled launch, lease expiry, result lookup by operationId; reservation unique(video,variant) і unique(logical operation).
- Paginated list search через дозволені metadata, без URL/SUB body. Empty draft date підтримати явно, не підміняти createdAt.

## Access і transport projections

RLS увімкнено на всіх таблицях; revoke all, narrow grants; security-definer RPC з empty search_path, fully-qualified identifiers. Sensitive tables не дають browser blanket SELECT. Service-role handler також перевіряє actor membership/capabilities перед side effects.

List DTO: IDs, safe display summary, effective date, work/generation state, assignee, budgets. Detail DTO: config/URL/campaigns/catalog links/overrides для authorized view. Realtime: тільки IDs/state/version invalidation, не raw table з config/URL. Audit: action, entity ID, changed field names, без значень.

User permissions: view detail/list; edit create/config/meta/manual save/copy/generate; manage_metadata dictionaries/defaults; upload/process за child action; delete archive. Все scoped тарифом/членством/матеріалом. Active generation lock діє на config/meta/overrides/archive.

## Збереження і видалення

Дія «Видалити запуск» = archive. Прямі каталог/відео лишаються доступні. Їхні ownership guards не повинні зникати через archive. Retention/purge не реалізується в v1; видалення всього team підпорядковується чинній політиці і окремій future migration strategy. Production secret visibility policy — gate з research R9.

## Уточнення після аналізу задач

- `team_launches.expected_source_snapshot` зберігається атомарно з draft/draft_version: typed schemaVersion, source IDs/versions і дозволені values, які бачив користувач. Частковий snapshot допустимий тільки для чернетки. Сервер перевіряє його проти власних source reads; generation зберігає перевірений immutable resolved snapshot. Client expectation не є авторизацією чи довіреним derived payload.
- Copy request journal включає timezone у digest, accepted_at і resulting launch ID; date/timezone обчислюються один раз під час першого commit. Restore config використовує чинний draft/revision механізм і не потребує нової таблиці.
- Recovery має next_attempt_at, lease/fence і bounded retry/cleanup evidence у generation/step ledger; SQL dispatch враховує due Launch work незалежно від catalog updater jobs. Див. contracts/generation.md.
- RAM-only draft/overrides не мають browser persistence; safe request IDs не містять URL. Захищений серверний save — єдина persistence конфігурації. Ручні dependency warnings виводяться з baseline/overrides після reopen, не з випадкового локального прапорця.
