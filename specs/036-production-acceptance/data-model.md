# Data model: recovery та приймальна кампанія

Recovery сутності §0–3 вже реалізовано в 034; цей опис є acceptance expectations і потребує звірки з чинними SQL/DTO. Campaign сутності §4–6 описують повний контракт; local manifest/immutable runs/report і partial fixtures уже реалізовані036, adoption/required-variant closure та full LOAD лишаються відкритими. Повторно використовувати наявні operation/catalog IDs і receipts; не копіювати користувацький контент у recovery або telemetry.

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

Локальне закріплення: перед першим новим записом writer звіряє caller context зі збереженим `manifest.json` і атомарно публікує `manifest.frozen.json` через exclusive link. Snapshot містить canonical JSON (рекурсивно відсортовані object keys, незмінний порядок arrays, один LF); SHA-256 саме цих bytes записується в `manifestSha256` кожного нового run. Зміна scope/config/fixture або snapshot bytes відхиляє writer/report. Це гарантія інструмента для process-crash boundaries, не доказ fsync каталогу чи power-loss durability.

Історичні development runs без snapshot не переписуються: read-only report явно має `manifestBinding.state=legacy_unfrozen`, зберігає NO_GO і забороняє подальше append у цей legacy журнал. Для нового виконання потрібна нова campaign. Final report без frozen snapshot відхиляється. Це закріплення manifest не реалізує EvidenceAdoption і не доводить final candidate identity.

## 5. CaseExecution та Defect (локальний JSONL)

`runId`, `campaignId`, `manifestSha256` (обов’язковий для нових frozen runs), `caseId`, `variant`, actor aliases, browser, fixture hash, start/end UTC, expected/actual summary, status PASS/FAIL/BLOCKED/NOT_RUN/NA, reason, evidence refs/hashes, operation IDs, defect IDs, supersedesRunId.

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

## Реалізовані private fixture checkpoints036

Baseline `fixtures.json` містить лише namespace, closed A/B/C/X/S identities і W1/W2 refs;
optional `variants.json` v1 — окремі SOLO/PENDING, WSolo/WLegacy і grant IDs. Credentials лежать
поза public evidence, bounded64KiB/0600, atomic publication і symlink guards; існуючі Auth/DB
markers та variant members/grants звіряються перед reuse. Global legacy rule не змінюється.

`cleanup.json` містить ownership digest, exact retired team/tariff IDs, acknowledged aliases,
startedAt і phase `planned → app-disabled-auth-pending → complete`. Це metadata, не видалені
credentials. Profile/admin access знімається до Auth DELETE; pending не означає universal JWT
revocation. Lost DELETE response повторно перевіряє actual Auth absence. Unknown/content/provider
references блокують cleanup; supported scope — empty fixtures only. Checkpoint не видаляється:
apply/variants/diagnostic reader перевіряють його під shared namespace lock. Для нового циклу
після complete потрібний новий campaign namespace, не стирання tombstone.

Local Realtime collector зберігає bounded offered index/result identity і per-receiver readback
час у collector-monotonic clock. Public evidence містить outcomes/timings/counts, не tokens чи
row content. Delivery вимагає matching result ID/name після signal, включно з pre-HTTP-ack arrival;
це не DOM receipt. Missing/late/dropped/warmup/notOffered залишаються окремими знаменниками.

### Реалізація bounded retention — T159

Міграція356 обмежує кожен sweep до100rotation responses,100claim receipts,100expired credentials,100expired enrollments,100old rate buckets та100eligible lifecycle roots. Selection впорядковано йіндексовано; locked candidates пропускаються. Видалення Vault response івідповідного pointer/receipt атомарне. Це bound вибраних root records, не гарантований bound каскадних children, overall dispatch iteration чиwall-clock часу. Active/waiting/dependent records і30-day horizon лишаються захищеними; реальні cleanup/resource SLO потребують LOAD. Native356:885pgTAP/36filesPASS+11nativePASS after unchanged-group retry; local356applied безreset,auth/Drivepreserved.98related+13staticPASS; actual localCLI aftercutoverPASS. LOAD/finalacceptance неоголошено завершеними.

T161 scoped server logout checkpoint (2026-10-22, source only):3 behavioral database regressions RED→GREEN. Source357 now factors canonical per-delegation cancellation into a private owner-only helper. New authenticated `retire_team_recovery_installation(uuid)` derives actor solely from auth.uid(), retires only that actor on the selected installation, revokes bound unfinished-process grants, preserves terminal/unrelated operations and other actor/device delegations, deletes that scope's pending enrollments and is idempotent. Anonymous/helper execution is denied. Setup/redeem/installation logout share one actor+installation advisory lock before row locks, including the absent-row case, so the logout delegation snapshot cannot miss a redeem already racing with enrollment deletion. This still requires real multi-session PostgreSQL proof; model execution is not concurrency acceptance.

Native paired health advertises a non-secret installation selector; public health does not. Browser remembers the validated hint after paired health or setup and never guesses an installation when absent. Explicit logout calls the authenticated server RPC before destroying its session, while native durable retirement runs independently. The request uses a captured JWT, so a concurrent switch to another actor cannot redirect cleanup to that actor. Missing hint/session, refused/malformed receipt, timeout or missing RPC returns unconfirmed, not global retirement. Auth lookup itself is bounded:1RED timeout→GREEN without raising the test timeout; a late lookup after expiry cannot issue the request. External SIGNED_OUT attempts cleanup only with a still-matching usable session and otherwise remains unconfirmed.

Current10files121PASS after the shared SQL lock; agent/web/test TypeScript PASS, targeted lint recorded separately. Types include the draft RPC shape but authoritative local generation must follow the native357 cutover. ROOT source only, W/runtime still356; source357 has never been applied or mirrored. No provider writes, no production mutation, accepted tariff UI unchanged. Remaining: native357 and two-session grant/redeem/logout/rotation races, cross-tab publication, missing-session/failed-server retirement diagnostic coverage, durable pending/server-ack/local-cleanup read-only CLI evidence, upgrade UX and current full canonical/release checks. An unconfirmed cloud retirement does not prove that a headless old worker has stopped; no such acceptance is claimed. T160/T161 and broad036 remain open/NO_GO.

## Owner-authorized scope adjustment — 2026-10-23

`acceptance-policy.json` is reviewed repository input, never a caller-provided campaign waiver. Its SHA-256 and source path appear in report `policyBinding`. Version1 allows only `native-windows-runtime`, REG-017 and the native Windows portions of T059/T173, authorized by the owner because no physical Windows device is available. It does not exclude platform unit/contract/build checks, macOS multi-device checks or any other case.

Reports preserve original `totals`, execution history and per-case execution `status`. They add per-case `scope=required|owner_excluded`, `scopeExclusions`, `requiredCaseCount` and `requiredTotals`. The latter omit only the reviewed owner-excluded native case. No synthetic PASS/NA run is written and no frozen manifest/source evidence is changed. Thus native Windows retains its actual BLOCKED/NOT_RUN status in historical execution data without blocking completion of the owner's adjusted required scope. This exception does not certify native Windows readiness or authorize production. Any wider exception requires a separately reviewed policy/code change.

## Required-variant closure — T176

`required-variants.json` defines the reviewed variants and allowed execution kinds for all174 catalog cases, bound to the exact manual catalog SHA-256. The module rejects incomplete groups, unknown cases, duplicate IDs and unsupported proof kinds. The policy cannot be replaced by a caller's campaign JSON. A new campaign records `variantPolicySha256`; the immutable manifest hash then binds each newly published run to that policy. A supplied wrong/stale digest is rejected. Legacy manifests without the field remain readable with `variantPolicyBinding.state=unbound`, but cannot produce completed current acceptance.

Each report case preserves historical `status` and adds `requiredStatus`, `requiredVariants`, `missingVariants` and `ineligibleVariants`. `requiredTotals` counts the required closure, excluding only the owner-waived native Windows case. A required variant with implementation-only/unit evidence remains missing. An additional current FAIL blocks the case even if required variants pass. A candidate exclusion reason without hashed evidence cannot complete acceptance. Native-browser/manual, server-authority, recipient-visible and role/browser-swap requirements follow their catalog/FR/SC bases in the policy; unit evidence remains supplementary. LOAD and packaged cases require their actual execution kinds.

`executed_pass` counts fully closed required cases, while `recorded_pass` counts current raw PASS executions; neither rewrites original runs. `adopted_pass` remains0 until T177 verifies the complete adoption boundary. `variantPolicyBinding` includes the policy ID, source path, actual policy/catalog hashes and bound/unbound state. Policy verification is deferred until needed so a documentation-only fingerprint drift cannot block importing teardown commands; report readiness still fails closed. Full runtime evidence and final GO remain separate requirements.


### Scoped fault journal follow-up — 2026-10-24

The private fixture relation acceptance_scoped_faults is not a production migration. Its descriptor carries namespace, faultId, kind, resourceKind, actorId, teamId, operationId, flowId, ttlMs, optional bounded delayMs, createdAtMs/expiresAtMs/changedAtMs and state. resourceKind is team_operation by default or catalog_sync_request; no arbitrary relation is configurable. operationId may be null only for initial acceptance-response loss. It then denotes a pre-acceptance intent: absent at arm/claim and resolved from the actual actor/team/key row before effect-start. For scan scope the non-null identifier denotes the request, whose matching connection/job must independently resolve. Diagnostic result fields distinguish resolvedResourceId, resolvedOperationId and resolvedRequestId/resolvedJobId; no fabricated team operation stands in for a scan job.

armed, claimed, effect_started, observed and cleared are stored; expiry is derived against real database wall time and never extends on retry. Limits are64rows per namespace,256global and a65-row bounded corruption read. Namespace/schema transaction locks protect mutation; uncertain commit acknowledgements remain unknown. Fixture cleanup removes only own validated rows while checking all other references in the same transaction and rolls back on dry-run/blocker/error. Native checkpoint handles are in-process opaque capabilities, not JSON or stored PIDs. Their current RecoveryJournal fixture proof explicitly excludes authenticated worker/refencing and browser delivery acceptance.
