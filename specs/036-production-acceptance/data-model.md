# Data model: recovery та приймальна кампанія

Усі нові поля/сутності нижче — дизайн, ще не міграції. Повторно використовувати наявні operation/catalog IDs і receipts; не копіювати користувацький контент у recovery або telemetry.

## 0. WorkspacePause і PauseItem (durable, private, до поновлення)

WorkspacePause: `id`, `team_id`, `pause_epoch`, `access_ended_at`, `captured_at`, `tariff_revision`,
`state=captured/recovery_registered/superseded`, `recovery_id` nullable. Unique `(team_id, pause_epoch)`.
PauseItem: `pause_id`, `team_id`, `kind`, `resource_id`, nullable `operation_id`, `previous_enabled`,
`config_generation`, `previous_interval`, `checkpoint_ref`, `source_version`, `output_receipt_ref`.
Unique `(pause_id, kind, resource_id, operation_id)` з явно нормалізованим null operation identity.

Ці записи створюються при фіксації тарифної зупинки **до** очищення runnable state/lease/round;
їм не потрібен recovery_id. FK PauseItem → WorkspacePause, tenant composite FK обов’язкові.
Після crash до оплати snapshot лишається придатним. Поновлення створює WorkspaceRecovery з `pause_id`
та похідні RecoveryItem; копіює лише refs/мінімальний стан, не права чи вміст. PauseItem незмінний:
пізні ручні зміни підвищують live config generation і мають перевагу.

Поточний access row має persisted `access_epoch`, `last_access_ended_at`, `captured_pause_epoch`.
На всіх pause/claim/renew/cleanup шляхах спершу materialize пропущений expiry під тим самим lock:
зберегти snapshot з durable job/config/receipt до будь-якого очищення. Навіть коли renewal випередив cron,
між expiry і renewal створюється одна пауза. Якщо старий producer уже втратив необхідний checkpoint,
створити blocked item з `checkpoint_unavailable`, не вигадувати попередній стан.
Активні pause/snapshot, на які посилається recovery, не видаляються; terminal retention починається
після завершення всіх залежних recovery items і становить щонайменше 30 днів.

## 1. WorkspaceRecovery (durable, private)

- `id`, `team_id`, `pause_id`, `access_epoch`, `tariff_id`, `trigger_revision`, `trigger_kind`, `created_at`, `last_progress_at`.
- `state`: registered / running / waiting_dependency / partial / completed / superseded.
- `error_code` nullable; counts pending/running/blocked/done; числа агреговані з items, не незалежна істина.
- Unique `(team_id, access_epoch)` для одного відновлення доступу. Не створюється на звичайне продовження активного тарифу.
- Epoch монотонний на кожній зміні доступу; повторна пауза інвалідує старі claims. Межа календарної expiry враховується під row lock навіть до cron.
- FK на простір; server-only mutation; user-facing read лише через filtered projection поточному члену.

`registered → running → completed`; за залежностей `running → waiting_dependency/partial → running`; новий access epoch переводить старий цикл у superseded. Completed означає всі eligible items реально відновлено/безпечно завершено, а не тільки створено intents. Unknown terminal не маскується completion.

## 2. RecoveryItem (durable, private)

- `recovery_id`, `pause_item_id`, `team_id`, `kind` (catalog_schedule / sync / restitch / preview / archive / cleanup / agent_operation).
- `resource_id`, `operation_id` nullable, `pause_reason=tariff`, `previous_enabled`, `config_generation`, `paused_at`.
- `previous_interval`, reference на поточну конфігурацію (не дубль її контенту), `checkpoint_ref`, `expected_source_version`, `output_receipt_ref`.
- `state`: pending / leased / waiting_dependency / resumed / completed / skipped_manual / blocked / superseded.
- `stage`, `reason_code`, `attempt`, `lease_owner`, `lease_expires_at`, `next_attempt_at`, `started_at`, `finished_at`.
- Unique logical resource на recovery epoch; claim/finalize compare access_epoch + config_generation + lease identity.
- `skipped_manual` доводить пізніше manual stop/cancel; відсутній checkpoint дає blocked. Completed/cancelled/permanent-failed jobs не стають eligible автоматично.
- Recurring schedule item `resumed` тільки після фактичного першого worker start; його звичайний round terminal й delivery пов’язуються через operation ID. Великі завдання не зобов’язані завершитись за 5 хв, але не можна видати queue за start.

Повторний upload спершу перевіряє output receipt та source version. Перевірки прав і tenant повторюються на start, зовнішній side-effect та finalize. Lease/retry clock реальний; час тарифного очікування не витрачає operation retry budget.

## 3. AgentDelegation та локальний checkpoint

- Server record: id, team_id, actor_id, installation_id, allowed_operation_kinds, token_hash, rotation/revocation version, issued_at, expires_at, revoked_at.
- Видається authenticated actor з чинним правом process і підтвердженим pairing; grants прив’язані до однієї installation/team, не дають довільного list/read/write.
- EnrollmentChallenge: id, actor/team/installation, allowed kinds, ticket_hash, expires_at (120 с), consumed_at; raw ticket створюється й залишається в paired agent до redeem, браузер передає лише hash. Повний handshake — contracts/recovery.md.
- Довгоживучий refresh handle зберігається тільки в платформному захищеному сховищі. RotationSession: delegation_id, rotation_id, previous_handle_hash, current_handle_hash/version, encrypted_response, response_expires_at (60 с); забезпечує повтор тієї самої rotation після втрати відповіді, не другий обмін.
- ClaimCredential (≤5 хв): delegation/actor/team/installation/kinds/version, audience=claim; **без** operation/lease, придатний тільки для отримання роботи. Жодних browser refresh/service-role tokens.
- OperationCredential видається тільки після успішного claim, scoped на operation/lease/epoch/config-generation, audience=execute, ≤5 хв; heartbeat може оновити його після revalidation. Повторна перевірка актуальних прав на кожному серверному зверненні; suspend блокує claim, не відновлює revoked delegation після оплати.
- Локальний журнал: operation ID, epoch, stage, checkpoint/output receipts, config/source version, terminal. Локальні шляхи можуть зберігатися приватно на машині для recovery, але не йдуть у серверну діагностику. Запис atomic, scoped на beta/production та installation; cleanup лише після safe terminal/retention.
- Зміна особи/відключення пристрою анулює делегацію. Offline device → waiting_agent. Немає делегації у старого клієнта → needs_agent_setup/upgrade, а не silent success.

## 4. CampaignManifest (локальний JSON)

`schemaVersion`, `campaignId`, `createdAt`, `baseTag/baseSha`, `candidateSha`, `dirty`, hashes dirty inputs, artifact digests, schema/function revisions, configFingerprint (без secrets), browsers/OS/agent versions, target kind/id, fixtureVersion, clock/fault mode, includedCases, exclusions, loadProfiles.

Для final dirty=false. Target ID звіряється з DB + auth + functions + management source. Копія manifest immutable після початку run; новий кандидат створює новий revision/кампанію, не редагує старі докази.

## 5. CaseExecution та Defect (локальний JSONL)

`runId`, `campaignId`, `caseId`, `variant`, actor aliases, browser, fixture hash, start/end UTC, expected/actual summary, status PASS/FAIL/BLOCKED/NOT_RUN/NA, reason, evidence refs/hashes, operation IDs, defect IDs, supersedesRunId.

PASS вимагає доказів відповідно до case; NA — signed scope reason; BLOCKED називає залежність. Один поточний результат на case+variant, історія не стирається. Severity S0…S3, reproduction, fixSha, retest IDs. Unknown server result не може бути PASS.

## 5a. EvidenceAdoption (локальний append-only JSON)

`adoptionId`, `sourceCampaignId`, `sourceRunId`, `sourceSha`, `targetCampaignId`, `targetSha`,
`caseId`, `variant`, `sourceEvidenceHashes`, `dependencyClosure` (paths + source/target hashes),
`schemaFunctionConfigFixtureHashes`, `environmentFingerprint`, `diffDigest`, `rationale`,
`reviewer`, `reviewedAt`, `decision=accepted/rejected`, `validatorVersion`.

Оригінальний run/SHA не змінюється. Тільки прямий PASS із clean source campaign можна прийняти;
transitive adoption заборонений. Закриття dependencies має включати shared code, migrations/functions,
permissions, transport, test driver і fixture; невідоме dependency → reject/retest.
Відмінність будь-якого dependency/environment hash → reject. Адоптація не застосовується до P0,
тарифів/прав/recovery, LOAD/performance, backup/restore, Windows credentials/recovery і packaged evidence:
ці перевірки повторюються на кінцевому SHA. Решта P1 може бути перенесена після review та validator PASS.
Звіт окремо рахує executed_pass/adopted_pass, показує source SHA та adoption ID; в загальному PASS
вони враховуються лише після перевірки всіх умов. NA/FAIL/BLOCKED/dirty або змінений hash не приймається.

## 6. ResourceSample та Projection

`sampleId`, campaign/load profile, target ID, observedAt, interval, sample source, units, gauge/counter, value or null, availability, resetEpoch, role client/server/agent. Не підсумовувати cumulative counters без delta і перевірки reset.

Projection зберігає formula/inputs, workload mix, monthly cycles, physical/logical storage distinction, quotas/source URL/date, headroom, unmeasured fields та selectedPlan/compute. Відсутня обов’язкова метрика не дає enough=true.

## 7. Diagnostic correlation та retention

`campaignId` лишається test context; recovery_id/epoch/resource/operation/attempt використовуються у typed diagnostic events. Для production не включати штучні fixture metadata. Події: requested, queued, started, waiting, rejected, terminal, delivered. Невідомий delivery явно unknown.

Local acceptance artifacts містять тільки синтетичні дані/псевдоніми. Credentials, необроблений HAR та email delivery secrets не записуються. Server recovery retention узгоджується з існуючим діагностичним горизонтом: активні/waiting записи не видаляти, terminal зберігати щонайменше 30 днів для investigate, bounded cleanup; розмір включити в прогноз. Історію ручного тарифного аудиту не очищати цією фічею.
