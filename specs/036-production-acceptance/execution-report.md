> **Current scope decision — 2026-10-24:** 036 is CLOSED for completed local implementation and verification. Remaining substantial acceptance obligations are OPEN in [042 Production Readiness](../042-production-readiness/spec.md), with exact mapping in [scope-transfer.json](scope-transfer.json). See [closure.md](closure.md). Earlier full-campaign requirements and NO_GO checkpoints below are retained as historical requirements/evidence for 042; no production GO or test PASS is inferred from this scope change.

### Current full local verification — 2026-10-24 13:04Z

Fresh `npm run verify:release` PASS: 22/22 gates, 7,374 passed tests and 41 explicitly skipped tests, 81.38% line coverage. All 3,134 input paths and bytes stayed unchanged during the 33m37s run. All eight shard reports are valid; all 843 test files have exactly one COLLECT/START/END. A separate completed-log lifecycle check passed 106 tests. Proof: `release/acceptance/acceptance-036-fresh-20261021/drive-followup/t180-current-full-release-proof.json`. This supersedes earlier local canonical failures, without rewriting their historical evidence.

Real two-user reconnect follow-up passed: B committed an owned folder while A was offline; A received it automatically after reconnect, then both observed cleanup. No precise latency claim. Proof: `drive-followup/two-user-reconnect-20261024.json`. This is scoped evidence, not complete managed fault acceptance.

Task accounting remains 99/182 closed, 83 open; full036 remains NO_GO. Hosted discovery found only the production project, which is excluded from testing; a separate hosted test-project configuration is still needed. Packaged acceptance and remaining isolated runtime/fault/load/adoption/backup work remain open. Native Windows remains owner-excluded. These report updates were made after the frozen verification run.

> Рішення власника 2026-10-23: продовжувати до завершення всього доступного обсягу; нативну перевірку Windows виключено через відсутність реального пристрою. Канон виключення — [acceptance-policy.json](acceptance-policy.json), scope `native-windows-runtime`, case REG-017 і лише Windows-частини T059/T173. Це не PASS і не доказ Windows-сумісності. Unit/contract/build перевірки підтримуваних платформ та macOS multi-device залишаються обов’язковими. Інші зовнішні передумови й невиконані перевірки зберігають власний статус.

# Форма звіту прийомки

### Latest accelerated verification and local metrics checkpoint — 2026-10-24 12:16Z

All eight unit shards completed in32minutes:7318passed/41declared skips, zero failed tests;3129input paths and bytes unchanged. The full release command stopped at the i18n per-file coverage ratchet(95.57% after dictionary extraction). Added cross-tab/fallback/plural regressions now pass80targeted tests with99.11% i18n coverage; baseline unchanged. Remaining canonical build/contracts/a11y/CSP phases passed. Database first selected the unavailable default project; the explicit retained local source retry passed948pgTAP/39files+29native tests and removed its disposable container. Environment gate passed. These are scoped results, not a single current full canonical PASS.

T180 local collection is integrated: opaque expiring handles, actual fixture readiness, dedicated SELECT-only reader, repeated role/instance checks, bounded sampling and exact reset-aware counters.64focused tests, test/script types and lintPASS. Actual `resources` CLI returned two local samples; zero reader connections remained; web/agent/Auth HTTP200 and retained profile inode unchanged. Observations are database-wide and include sampler activity. Function deployment identity, management binding, hosted load/capacity and full T180 remain unverified. Proof: `drive-followup/t180-local-resources-proof.json`. Counts remain99/182closed,83open. Separate hosted test-project configuration requested; native Windows remains owner-excluded. Light tests use two workers; media/database workloads remain bounded.

### Latest focused execution and performance checkpoint — 2026-10-24

T099 execution milestone is complete:12focused scopes with explicit evidence dates/limits; `two-user/focused-completion-20261024.json` does not adopt historical receipts into current acceptance.99/182tasks closed,83open; full036NO_GO.

Official suite hit its45minute wall budget while progressing in shard5. Exact-source continuation preserved blobs/coverage1–4, passed shard5 (868tests) and found2bundle failures in shard6 (993passed/2failed). Source3123unchanged for that attempt. The canonical timeout and failures remain retained, not converted to PASS. Source has since changed to fix bundles: largest144890→129007B, Launch graph40200→39222B, all4budget testsPASS without budget edits. Both locale dictionaries were moved byte-for-byte; formatting and synchronous translation API remain. A common cached plural formatter keeps tested CLDR categories. Launch fixture setup now seeds before each test and the conflict/rebase test uses its existing controlled-debounce pattern;43file testsPASS. Current full verification is pending.

User closed excess apps. Observed free memory improved32→71–72%, workerRSS about1.1GB, no thermal warning; continue one heavy command at a time with bounded heap. Retained beta health/web/Auth200 and profile inode104616221 preserved after suite timeout.

### Latest resume checkpoint — 2026-10-24

User resumed. Retained beta remains schema361 with original Drive root/profile/pairing. Real A owner + temporary B admin browser shared sync PASS: both saw progress; A request detached before completion, B visibly completed without reload and authoritative same-job state succeeded. B restored to one active editor membership with empty overrides; own two new folders trashed, originals untouched. Proof: `drive-followup/two-user-shared-sync-20261024.json`. Offline reconnect trial remains partial because commit-before-restoration was not established.

Current full release attempt froze3122unchanged inputs:13static gatesPASS, suite stopped in shard1 with878passed/6skipped/1failed at `launch-workspace-ui` waiting for Update launch confirmation. Unchanged isolated file43PASS. The test now waits for Generate to become available after editing;43PASS. This is a test-readiness correction, not proof of a product defect or a new whole-suite PASS. Runner regression fixed partial JSON loss:4native orchestration regressions plus18workflow testsPASS; real covered failing Vitest shard merged into accurate partial JSON without partial coverage. Current focused T178168tests/12filesPASS remains partial; actual authenticated worker/provider faults, hosted and packaged acceptance remain open. Counts98/182closed,84open. Full036NO_GO. Earlier checkpoints below are historical.

### Live beta clock integration — 2026-10-23 18:12Z

Retained beta is now schema361. Guarded incremental local application preserved tariff rows, Launch defaults, cleanup coverage, Drive binding, profile and pairing. Current runtime instance52791090-93a4-4e3c-8705-8094962cb01e; source/calendar CLI dependencies synchronized from static-validated ROOT files. Seventh controlled restart passed preservation checks. Production unchanged.

Actual CLI set/TTL/clear/repeated clear PASS with a1second overlay using the current instant: tariff day and rows unchanged; expiry fell back to real time and final overlay removal confirmed. Initial harness SQL-alias failure and missing W CLI dependencies were diagnosed before any set and corrected; retained first failure is private. Native far-shifted notice proof passed948pgTAP+29native tests; root test merged and all-test typesPASS. Chrome real-calendar smoke shows19November matching authenticated server endsOn2026-11-19/tariffToday2026-10-23, with connected Drive and agent. Owned tab closed; owner's tabs untouched. This is not far-shifted physical UI proof. T011/T012 remain open for remaining boundary acceptance; full ROOT canonical remainsFAIL from the unrelated30second setup timeout, despite unchanged6test rerunPASS.

Proofs: `t012-local-361-apply.json`, `ui-restart-seventh-20261023.json`, `t011-live-clock-cli-proof.json`, `t011-live-calendar-rpc.json`, `t011-live-calendar-ui.json`, `t011-native-notice-overlay-proof.json`.

### Current verification checkpoint — 2026-10-23 14:43Z

ROOT now contains the361st tariff-clock migration and31 selectively merged source/test files; retained beta remains schema360 with original profile, pairing and Drive preserved. Merged focused185tests/11filesPASS. The full ROOT `npm run verify` completed with13static gatesPASS, then suiteFAIL: `task-diagnostics.test.ts` beforeAll exceeded30s in shard2. All3099 input paths and bytes remained unchanged. Shards1/2 retain862+873passing tests; this is partial evidence, not a whole-suite PASS. An unchanged isolated rerun of task-diagnostics passed6tests in7.22s. Resource contention is a hypothesis, not a proven root cause; no further timeout change was made.

NEXT's previous complete disposable database run passed948pgTAP/39files plus28native tests and removed owned resources. A new native notice-overlay case is now running separately and is not yet counted. T011/T012 remain open for actual guarded CLI, overlay notice proof and physical UI effective-date agreement. Next order: finish native notice proof; reconcile merged source and docs; guarded preserve-profile local acceptance when it will not disrupt the owner's UI session; current full/release gates and whole-suite lifecycle reconciliation. Hosted load, Windows, backup and exact-SHA packaged acceptance remain unresolved. No production action is authorized or implied.

**Стан: DEVELOPMENT IN PROGRESS. Рішення про production: NO-GO до завершення критеріїв.** Копіювати цю форму для кожної кампанії; не перетворювати відсутні результати на PASS.

## Поточний стан —2026-10-23, після перезавантаження

**Status**:2026-10-23: NO_GO for full036.94/174tasks closed. T014 and T174 integrated; retained beta schema360, profile/pairing/Drive preserved. Current canonical failed on two10-second database setup hooks; scoped30-second setup budgets now pass22affected tests. Current full/release verification remains open. T169 has4physical browser Web Locks cases on synthetic SDK, with actual Auth/legacy mid-logout limits explicit. Isolated clock/JWT work continues in NEXT; hosted load, Windows, backup and exact-SHA packaged acceptance remain open.

Proofs: `reboot-runtime-restored-20261023.json`, `t170-release-interrupted-reboot.json`, `t170-release-reboot-inputs.json`, `t012-clock-database-behavior.json`, `t012-native-clock-confirmed.json`, `beta-loopback-live.json`, `beta-startup-journal-merge.json`. The restored Chrome explorer shows the existing connected root and own QA folder; no Google reconnect or provider writes were needed. Earlier checkpoint paragraphs retain their historical scope.

## Кандидат і стенд

- Campaign ID, відповідальний, UTC початку/кінця:
- Base tag/SHA; candidate SHA; clean/dirty; artifact digests:
- Web/agent/protocol versions; backend migrations/function revisions:
- macOS/Safari/Chrome/Windows версії; профілі/агенти:
- Fixture ID, контрольний manifest даних, clock/fault fixture версія:
- Локальний чи hosted стенд, план/compute, інші споживачі квот:
- Scope diff проти попереднього прогону та причини N/A:

## Виконання

Кожен із 174 ID має щонайменше один рядок. Перестановка браузерів/фаза/профіль створює новий рядок з тим самим ID й окремим Run ID. Порожній рядок не рахується виконанням.

| Case ID / Run ID | Роль / браузер / fixture | Час UTC | Фактичний результат | PASS / FAIL / BLOCKED / NOT RUN / N/A | Доказ / correlation IDs | Defect ID / повтор |
| ---------------- | ------------------------ | ------- | ------------------- | ------------------------------------- | ----------------------- | ------------------ |
| —                | —                        | —       | Не виконано         | NOT RUN                               | —                       | —                  |

## Дефекти

| ID  | Severity | Кейс / кандидат | Очікуване → фактичне | Відтворення | Останній доведений етап / причина / unknown | Власник | Fix SHA | Повтор і залежна регресія |
| --- | -------- | --------------- | -------------------- | ----------- | ------------------------------------------- | ------- | ------- | ------------------------- |
| —   | —        | —               | —                    | —           | —                                           | —       | —       | —                         |

Severity: S0 — втрата/витік даних або обхід доступу; S1 — тариф/команда/sync/ключова операція не працює; S2 — обхідний шлях існує, не зачіпає даних/прав; S3 — косметика. S0/S1 блокують продажі. Критичний BLOCKED або NOT RUN також блокує, навіть без зареєстрованого багу. S2/S3 потребують явного рішення власника продукту, строку виправлення та відсутності порушених критеріїв.

## Ресурси

| LOAD ID | Люди / команди / вкладки | Дані / тривалість | p95 / errors / sync delivery | CPU / RAM / IO / DB pool | Monthly квоти / DB growth | Recovery | Джерела / unknown |
| ------- | ------------------------ | ----------------- | ---------------------------- | ------------------------ | ------------------------- | -------- | ----------------- |
| —       | —                        | —                 | —                            | —                        | —                         | —        | —                 |

| Ресурс | Поточний вимір і UTC | 30/90-денний прогноз | Квота / запас | Free verdict | Найменший перевірений план | Вартість та припущення |
| ------ | -------------------- | -------------------- | ------------- | ------------ | -------------------------- | ---------------------- |
| —      | —                    | —                    | —             | Не доведено  | Не перевірено              | —                      |

## Остаточне рішення

- Кількість PASS / FAIL / BLOCKED / NOT RUN / N/A окремо за P0/P1; сума дорівнює затвердженому scope.
- Всі зміни manifest мають доказ або обґрунтоване виключення.
- SC-001…SC-007: фактичний вимір і посилання на доказ для кожного.
- Відкриті дефекти та сліпі зони; прийняті S2/S3 з відповідальним.
- `verification-result.json`, Windows-доказ, exact-SHA packaged beta record.
- Backup/restore: час копії, відновлення, звірка даних/прав, досягнуті RPO/RTO.
- Рішення Free/Pro/compute та невідомі метрики; відповідальний за моніторинг перших 14 днів.
- GO / NO-GO, підпис власника продукту, дата. GO прийомки не підміняє G0, sandbox evidence і canonical production release gates.

## Додаткові докази після аналізу

- Recovery: pause_id/pause_epoch, snapshot до renewal, restart proof; актуальні права після відновлення.
- Agent auth: enrollment ticket replay/rebinding, ClaimCredential ≠ OperationCredential, rotation lost-response,
  auth audience denial; idle/retry/heartbeat фактичні лічильники проти budgets.
- Hosted: runtime-manifest/readiness hashes, migrations/functions/scheduler/Realtime/test ingestion checks,
  identity до/після load; no production fallback.
- UI latency: browser/action/profile, warmup count, samples, visible-result proof, API time окремо,
  timeouts/censored/errors, delivery clock error bound.
- Evidence adoption: executed_pass/adopted_pass окремо; для кожного adopted case — source SHA/run,
  dependency hashes, reviewer/adoption ID; forbidden adoption дає FAIL validation, не PASS.

## Робоча кампанія 2026-10-20

Campaign: acceptance-036-20261020. HEAD 95467002, dirty; final GO не розглядається.
Chrome extension доступний, профіль Roman; Safari встановлений, незалежні профілі ще не доведені.
Windows/hosted sandbox readiness не підтверджено. Colima був зупинений, запуск відновлюється без reset.
Tooling boundary regression: 28/28 PASS (target + record schema); це не продуктові кейси.
Початковий manifest і подальші артефакти: release/acceptance/acceptance-036-20261020/.

### Стенд і перший повтор — UTC 2026-10-20 / Kyiv 2026-10-21

macOS 26.6.2 (25G83), Safari 26.6.2, Chrome 155.0.8059.85, Node 22.23.2.
Дві native Safari сесії: Daynero=A (owner W1), Aff=B (editor W1); Chrome Roman=C (viewer W1).
П’ять синтетичних осіб A/B/C/X/S через справжній local Auth; S — окремий Soty admin без W1 membership.
W1/W2 мають Lead; owner A не є Soty admin, X — outsider W1 та owner W2.

- Local marker/Auth/DB/schema/functions preflight: 8/8 checks PASS; finalCandidateReady=false.
- Actor smoke: 16/16, evidence у smoke/1792530217972.json; це часткові складові TEAM/ACL, не повні manual case PASS.
- Existing recovery regression: 89/89 tests PASS (8 suites).
- Tooling regression після нового report/load accounting: 60/60 PASS.
- Full verify спершу FAIL(format: tests/acceptance-actors.test.ts); formatting виправлено, final repeat ще потрібен.
- Під паралельним static verification Colima health checks перевищували 2s timeout; Auth health згодом HTTP 200/0.252s. Safari B показав network error і повернув збережену сесію після refresh. Причина лишається hypothesis(resource contention), не доведений product defect. UI latency у цей час не вимірювалася.
- Drive W1/W2 не підключений: файлові end-to-end cases BLOCKED, права/акаунти доступні прямим URL.
- Windows runtime, hosted sandbox, paid compute/quotas та final packaged SHA: NOT VERIFIED/BLOCKED відповідних фінальних доказів.

SET-001 development PASS записано в immutable run record після перевірки виходу B та збереження A/C.
Окремий browser delivery observation: синтетичний акаунт B видно A/C без refresh; жодної числової latency claim.
Повтор actor smoke: 17/17, включно з відсутністю видимого побічного запису після трьох відмов;
artifact `smoke/1792531357563.json`.

### Свіжий isolated stack та виправлення — 2026-10-21

Project `acceptance036`, fixture namespace `acceptance-036-fresh-20261021`, ті самі loopback
ports. Початкові wishly volumes та 3.8 GB mutable Soty Beta state збережені окремо, без reset.
Повний migration chain плюс additive `20261206130000_membership_access_signals.sql` застосовано
лише локально. Initial preflight 9/9; function probe уточнено: structured error обов'язковий,
CORS-only HTTP 403 більше не вважається readiness. Final candidate ready=false.

- Native sessions повторно: Safari Daynero=A, Safari Aff=B, Chrome Roman=C; вихід B залишив
  A/C авторизованими після refresh. B→A/C `036 fresh native delivery 003` видно без refresh.
- Real Auth tariff smoke: 21/21 — immediate pause/undo, denied reads/writes, unchanged W2,
  no unauthorized side effects, актуальні viewer/outsider права після відновлення.
- D036-001: orphan picker — fixed; owned osascript зник після canonical beta:down без kill.
- D036-002: missing membership invalidation — fixed; real Chrome draft preserved, Save/Enter
  blocked після downgrade, membership removal прибрав список; old-session read denied.
  Повторне invitation create/accept відновило viewer membership. У першому harness response
  parser неправильно шукав `data` замість canonical `value`; observation beta-link=null/unknown,
  це не підтверджений дефект beta isolation. Actor envelope normalization виправлено.
- Restricted read-only investigate бачить revision і явний unknown browser_delivery; audit
  бачить `members.access_refresh`: 4 starts, 4 terminals, 4 pairs, 0 orphan starts.
- Real-media 11/11 без skips: actual agent contracts/routes/diagnostics, FFmpeg encoding,
  governor equivalence, HEVC warning, actual Whisper synthetic speech content/word timings.
- Vite security gate: patched 8.1.6/7.3.7; 0 blocking, без exceptions. Full verify interrupted
  для нового product fix; остаточний повтор і release form ще потрібні.

Публічні докази свіжого стенду: `release/acceptance/acceptance-036-fresh-20261021/`.
Regression/build/security logs і defect records: `release/acceptance/acceptance-036-20261020/`.
Credentials/private runtime logs не входять до evidence. API calibration не є LOAD-01.
Source SHA 95467002 + dirty changes; жодний proof не називається final exact-SHA promotion.
Windows/Drive/hosted/8h soak/full backup та final package лишаються відкритими. Старі 13 migration
gaps початкової wishly DB не виправлялися цією кампанією.

Останній focused repeat: 23 suites / 150 tests PASS; real-media окремо 11/11 без skips.
Після fixes actor smoke повторено 17/17, tariff smoke 21/21. Local calibration: 330 offers,
30 warmup, 300 measured correct, 0 dropped/timeout; API-only p95 15.6 ms на synthetic data,
це не native UI, не hosted load і не quota verdict. Canonical invitation function roundtrip
підтвердив beta invite link і revoke; секретне посилання не збережене в публічних доказах.
Formal immutable fresh SET-001, SET-003, REG-005, REG-011 і REG-012 PASS; report для 174 ID: 5 PASS, 4 BLOCKED, 165 NOT_RUN,
0 FAIL/NA, verdict NO_GO. Інші development observations не підміняють повні case executions.

### Повторні регресії та keyboard retest

Canonical fast verify: 13 static gates PASS, shard 1 FAIL на трьох existing
workspace cleanup tests. Причина — нова team table без reference fence; додано
forward migration `20261206131000`, лише fresh local stack. Focused cleanup +
membership 19/19 PASS, додано явний inventory regression. Повний suite ще не green.

Private fixture checkpoints: atomic 0600 writes, bounds/symlink guards і session
provisioning lock; focused private-state/reader/fixtures 14/14 PASS. CLI redaction
додатково відхиляє raw JWT та sb_secret values; це не завершення adoption/scoped clear.

D036-003: calendar keyboard entry потребував 22 Tab. Initial library autofocus
проходив unit, але не live через hidden positioning. Остаточне рішення — explicit
Popover initialFocus після visible placement, лише п’ять calendar consumers.
Focused 15/15 PASS; actual Chrome 1000×420: selected-day focus, ArrowLeft, commit
2026-10-20 без date shift, Escape/selection повертають trigger. Нижні тижні
доступні через internal scroll; саме clipping не зараховано як defect. Viewport reset.
Release verification спершу FAIL lint на deliberate private JSON cause redaction;
privacy exception пояснено локально. Наступний прогін перервано лише для native
focus correction; interrupted ніколи не означає PASS. Final repeat required.

### Fixture variants і безпечне очищення

Окремий local namespace `acceptance-036-variants-20261021`: baseline + SOLO/PENDING,
bound Solo / unbound pending / legacy без tariff. Preflight 11/11, повторний apply
зберіг ті самі IDs, smoke 17/17 і tariff smoke 21/21. Actual adversarial adoption
спочатку показав зайвого member та чужий note; після hardening обидва відхиляються,
початковий synthetic state відновлено. Імена harness обмежено product limit 40.

Окремий порожній namespace `acceptance-036-cleanup-20261021`: dry-run, actual clear,
штучно втрачена відповідь після реального успішного Auth DELETE, durable pending
checkpoint, provisioning fence, resume і repeat. Усі 5 Auth identities, власні teams,
tariffs і restricted reader role прибрано. Контрольні A/W1/accounts іншого namespace
та canonical read-only role незмінні. Це synthetic transport fault, не реальний
network outage. Populated variants dry-run відхилено з 11 blockers, mutated=false.
Жодного Drive/Storage/Vault/provider cleanup proof не заявлено.

Release repeat: static 13/13, suite shards 1–5 PASS; shard 6 виявив hygiene rule у
трьох нових tests (temporary cleanup helper). Виправлено; shard 7–8/build/database
тоді не запускалися. Наступний повний прогін має окремий log/result.

### Додаткові native та protocol докази

- REG-005: Safari editor створив synthetic task і зберіг20 жовтня клавіатурою; refresh та
  Chrome viewer підтвердили ту саму дату. Chrome1000×420: dialog bottom412, selected-day focus,
  range20..20, trigger return; filter пережив reload. Override reset.
- REG-011: Safari та окремий private Chrome editor записали/виправили дві дати; кінцеві totals
  20.10=8.90USD,21.10=16.66USD,month=25.56USD. Viewer та Safari reread узгоджені, input readonly.
  Owned private window закрито, generated login page прибрано; C не змішався з B.
- REG-012: normal account transfer зберіг RK UUID/task link; tag пішов за новим соц-акаунтом.
  Chrome viewer підтвердив той самий task, transferred amount13.22 та total25.56 без втрати.
- Real Auth/Postgres membership RLS8/8: own rows only, authenticated PATCH403/42501,
  diagnostic projection403, anon401. No privileged actor workload.
- Realtime namespace `acceptance-036-realtime-20261021`: перший burst5/s має85/100 successful
  writes і255/300 deliveries,15 dropped actions. Steady1/s має100/100 і300/300, delivery p95≈592ms,
  X/S=0 signals, own channels disconnected. Обидва під concurrent canonical unit suite; baseline
  без паралельного навантаження ще потрібний. Невдалий artifact збережено, не superseded.
- Останній focused foundation:24 suites/124 tests PASS, scripts typecheck PASS. Canonical release
  repeat:13 static gates PASS, shard3 FAIL на existing500-catalog5s timeout; isolated file36/36 PASS,
  той тест≈2.07s. Timeout не збільшувався; build/DB gates цього repeat не виконані.

Latest formal report:5PASS/0FAIL/4BLOCKED/165NOT_RUN/0NA, NO_GO. Protocol calibration не присвоює
manual LOAD case PASS. Safari26.6.2(21624.5.1.11.3), Chrome155.0.8059.85(8059.85), read з installed plist.

Safety review знайшов reader-role/cleanup interleaving у development tooling. Reader preparation
тепер серіалізована з clear/apply і перевіряє durable checkpoint до preflight та після lock.
Before4/4 FAIL; after related8/8 PASS. Actual held PostgreSQL lock повернув BUSY≈1.92s,
normal reuse успішний, completed namespace повернув CLEANUP_PENDING; його reader не відтворився,
canonical/own reader attributes unchanged. `verify-frozen-interruption.json` фіксує штатне
завершення лише6 owned verifier processes; цей interrupted run не має PASS verdict.

Наступний canonical release пройшов13 static gates і зупинився у shard1 на Launch manual-restore
тесті: real500ms autosave стартував до restore click, кнопка була disabled. Поруч існуючий test
уже фіксував clock для цього unsaved branch. Два решта сценарії приведено до того самого
controlled-clock pattern; assertions manual save/conflict/current result лишилися. Після fix
`launch-workspace-ui.test.tsx`39/39 PASS. Це test determinism fix, не зміна продуктового debounce.

Canonical launch-timing repeat: static13/13 і shards1–6 PASS, shard7 FAIL на двох assertions. No-events test очікував лише одну workspace gap, але membership projection дає окремий unknown; тепер перевірено обидва details. Default-model unit test успадковував явний model override для actual-media; тест очищає лише цю env у своєму scope і відновлює її, окремий test підтверджує override для обох modes. Продуктовий вибір моделі не змінено. Build/database цього repeat не виконувалися.

## Після reboot та зміни пріоритету власником — 2026-10-21

Власник підтвердив зависання й перезавантаження комп’ютера. `verify-release-diagnostic-model-20261021` обірвано у shard8 після7 завершених shards, нового terminal result немає; попередній `verification-result.json` лишається історичним FAIL іншого run. Це interrupted, не green.115 frozen source files збігаються у ROOT/isolated worktree; збережений початковий Soty Beta state на місці. Colima відновлюється без reset, stale beta ownership узгоджується canonical beta:down/up.

Власник скоротив ручний пріоритет до взаємодії двох користувачів. Чинний маршрут — `two-user-focus.md`; ordinary single-user screens — `owner-ui-checklist.md`. Історичний повний report5PASS/4BLOCKED/165NOT_RUN залишається незмінним і не є denominator нового focused report. Windows/hosted/8h/backup/exact-SHA не вважаються виконаними чи автоматично виключеними з production.

### Двокористувацький повтор і D036-004

Після фактичного invitation accept B сервер мав3 members/0pending, а відкрита Safari A сторінка лишалася2/1. Before4 regression failures: MembersSection і SQL manager/invitation invalidation. Additive06132000 повторно використовує content-free own rows для affected user/current managers (distinct sorted recipients); own-row RLS не розширено. MembersSection тепер читає TeamContext revision. Focused35/35 PASS; actual native A/B retest05:54:14–05:54:35UTC показав3/0 без owner refresh. Попередній admin B з overrides повернувся тільки editor/{} після нової invitation; edit200, self-admin escalation403.

Real Auth own-row RLS after fanout11/11: A/B own row only, no write/effect, чужий W2 порожній, diagnostic projection403, anon401. Concurrent normal A revoke/B accept завершився revoked/B0, accept400/revoke200; через нову invitation baseline B editor відновлено. Native online removal прибрало W1 з B; old RPC read/write403; A4/B0 private Realtime signals після видалення, channels teardown0.

Capture включено тільки для server-validated synthetic A/B через DEV helper. Read-only audit delta між before/after: +6 correlated access_refresh, +7 members.list, +1 remove, orphan starts0. Cumulative audit має історичних3 users — це не три поточні workload actors. A revision6 доводить signal production, browser_delivery у CLI лишаєтьсяunknown; окремий native proof доводить DOM. Focused evidence: `release/acceptance/acceptance-036-fresh-20261021/two-user/`; повний174-case report не переписано.

D036-005: deferred RPC tests відтворили stale seat reply/error та previous-space count (3/3 FAIL before), не native fault injection. Request generation + space/client snapshot fence виправлено; related22/22 PASS. Access/member-list terminal не є доказом окремого tariff/invitation read — це явно додано в capability unobservable/fallback evidence, unknown не згортається до success.

### Дві особи: finance/task delivery, D036-006/007

F2-07 PASS: B explicitSave4.33 доставлено A16.67; A restore4.32 доставлено B16.66. RK перенесено B в finance007 й A назад у private005; UUID, task tag/link і підсумки збережені; server readback4/4. F2-08 після D036-006/007 має native retest PASS: editor/viewer бачить036 B без private member-management RPC; B status доставлено у вже відкритий A editor, viewer title/status/assignee disabled і update403. Before FAIL artifacts лишилися. Related assignee55/55, remote/fallback25/25, web typecheck PASS. Canonical gates ще не завершено після reboot.

D036-007 не rebases pending typing на нову remote version: зберігає expectedUpdatedAt для SOURCE_CHANGED. Capability `members.assignees` доводить тільки RPC directory read, не DOM. Generic `team.tasks` лишається unsupported_by_producer; T106 явно відокремлює відсутню незалежну діагностику від цього native проходження.

### Focused manual checkpoint:10/12 PASS,2 Drive BLOCKED

F2-01 independent refresh/logout/relogin A/B PASS; F2-06 private-A/private-B native deep links, foreign read/write403 and private realtime isolation PASS. Valid admin ownership-transfer attempt403; earlier wrong RPC signature404/self-target400 kept as harness errors, not permission evidence. Own channels0/disconnected after teardown. F2-09 shared draft normal field creativeAlias concurrent same-version race: one commit, one40001, both native editors same winning copy; viewer disabled/server403. Ordinary history UI belongs to owner checklist, generation/history invariants are not claimed. F2-10 pause/undo real Auth13 checks and native owner/member screens PASS; D036-008 neutral scheduled-end-date text fixes false future expiry claim. B returned to baseline editor/{}.

Focused report10PASS/2BLOCKED, not full174-case/production GO. F2-11/12 require test Drive; optional question remains unanswered. Single-user walkthrough owner checklist stays unexecuted, never markedPASS. T106 task lifecycle diagnostic blind spot is explicit; assignee directory capability does not prove task delivery. Final canonical fast/release repeat is still pending; original mutable runtime restoreT088 follows shutdown of own acceptance environment.

### D036-009 — conflict choices, cold native retest (2026-10-21)

Focused F2-08 був повторно відкритий FAIL: take-server закривав діалог, але лишав локальний опис; keep-mine мав stale write base. Failing queue/choice regressions збережені. Виправлено pending queue, acknowledged patch replay, latest confirmed snapshot і explicit reviewed version. Related36/36 PASS. Після cold reload native B прийняв server description10 chars та status done; інша спроба keep-mine коректно повторила conflict після додаткових A writes, потім зберегла20 chars. Real Auth A/B reads підтвердили однаковий updated_at/status/noteLength. Evidence: `two-user/task-conflict-choice-cold-after-20261021.json`. Старі mixed-HMR спроби не зараховано PASS. T106 diagnosis та canonical release gates лишаються відкритими.

### T106 / T110 — незалежний diagnostic proof

Native read-only audit зафіксував create1/list88/read14/update9/editor_refresh48/editor_preserve_draft27 correlated pairs,0 orphan starts. Legacy team.tasks лишився unsupported. Реальні update/preserve SOURCE_CHANGED спочатку губили fingerprint у investigate: terminal code перекривав detail попередньої error event. Окремо producer UUID attempt не розпізнавався resolveSubject. Before2 regressions FAIL; related25/25 PASS. Actual mapped investigation після fix має7 failures з точними tasks fingerprints і code locations; raw task content не збирається. Evidence: `task-diagnostics-native-final-audit-20261021.json`, `task-diagnostics-native-mapped-investigate-20261021.json`. Повний canonical release verdict ще pending.

### Canonical release repeat / D036-010 (2026-10-21)

`verify-task-conflict-release-result-20261021.json`:13 gates PASS (format/lint/all types/tokens/styles/i18n/env/CSP/audit/shared build); suite FAIL у shard1/8,791 tests PASS/1 FAIL. Existing `team-workspace.test.tsx` не дочекався launch.mp4, shell був aria-busy. Причина ще перевіряється; не піднімаємо budgets і не зараховуємо подальші gates. Спроба зупинки вже завершеного процесу була відхилена own-PID guard, жоден сигнал тоді не пішов. Окремий перегляд виявив failed autosave retry: actual-click regression показала1 write замість2. One-line кнопка explicit held-patch retry виправлена; related tests pending. Короткий дубль focused test зупинено, INTERRUPTED log збережено, не зараховано verdict.

### D036-010 / workspace coverage retest

Retry fix related22/22 PASS, original expectedUpdatedAt asserted. Existing workspace failure відтворився окремо з coverage. Temporary measurement: first-content wait5247ms, pageCalls0, subsequent actual ExplorerShell import6300ms/pageCalls0 — lazy Vite transformation, не RPC/content failure. Probe прибрано; actual WorkspaceShell/ExplorerShell імпортуються у test setup, усі assertions і budgets збережені. Same-file coverage repeat PASS: full walkthrough6458ms within existing20s. `workspace-preloaded-coverage-20261021.log`. Built browser performance лишається окремим required gate. Новий full release repeat ще не має verdict.

### Independent build/browser/database gates, D036-011

Full unit repeat76171 FAIL at shard2: four5/10s SQL/PGlite deadlines; static13gates and shard1 PASS. Focused coverage54PASS/1FAIL/6setup-skipped; profile showed retention init5154ms plus130ms to finish all SQL assertions, and team DB init5936ms/345migrations ready9811ms. Temporary timing probes restored byte-for-byte; no timeout budgets changed.

Canonical e2e group40961: shared/web/agent builds, release/team contracts, a11y, CSP browser PASS; database FAIL:29files/834assertions, single failure team-workspace test12 requires all team tables enable+force RLS. `team_membership_access_signals` had only ENABLE. Behavioral non-bypass-owner regression before fix saw2 foreign signal rows. Forward-only06133000 adds FORCE only, existing policies/grants unchanged. Focused and real database retests pending. No production side effects.

### D036-011 — закриття та відновлення стенду

142-file freeze: unit actor/manager10/10 PASS; normal local A/B ownrow revisions+2/+2, viewer write403, baselineeditor/{} restored. Native B open editor disables/enables after A viewer→editor without reload. Canonical e2e repeat8/8 PASS: build/shared/web/agent/contracts/full isolated database/a11y/CSP. Fresh dist download budget4/4 PASS, no skips;123JS/HTML/CSS marker scan contains no acceptance helper/capture/campaign.

Current142 static repeat: lint/all types/token/style/CSP/env-registry checks PASS; formatter hit300000ms under parallel phase, retainedFAIL. Environment gateFAIL: local repository configuration lacks VITE_GOOGLE_PICKER_API_KEY/VITE_GOOGLE_PROJECT_NUMBER; no placeholder invented. Full release unit suite stillFAIL by5/10s PGlite/SQL deadlines; no broad PASS inferred. Next fast repeat uses existing SOTY_VERIFY_SERIAL=1 with unchanged gates/deadlines.

T088 completed2026-10-21T11:13Z: own beta health busyfalse/ownershipverified, canonicalW beta:down stoppedacceptance036/released43140+5175/retainedDBvolumes. Fresh mutable state archived; only own2models/runtime symlinks removed; preserved original directory renamed back with same inode/device identity, assets present. Initial original stack not started/migrated. Native own beta tabs closed, original Habr/AIO tabs retained. Public proof: runtime-restored-20261021.json. Future Whisper env must use restored Soty Beta/models, not former preserved pathname. Do not beta:up W without renewed app-support isolation.

## 2026-10-21 — фінальні локальні результати

Canonical serial fast: 14/14 gates PASS, 6442 tests PASS /17 skipped, без coverage. Public Picker config retrieved read-only from canonical GitHub repository variables and hydrated only isolated W env; ROOT env unchanged. Correct-config canonical environment 2/2 and e2e 8/8 PASS. Fresh-dist performance 4/4 PASS, artifact guard 123 files PASS. Real Postgres recovery opt-in 5/5 PASS on disposable full-chain/Vault clone, source roles unchanged and clone removed. Own DB-only window closed, original Soty Beta directory identity preserved. Evidence under `release/acceptance/acceptance-036-20261020/`. Full release coverage suite remains unverified on final candidate; no full release PASS claimed. Focused manual 10 PASS /2 Drive BLOCKED; owner-only checklist separate; full 174-case catalog remains NO_GO.

## SQL fixture та preflight identity follow-up

Final coverage suite77200 terminal FAIL у shard2: Launch full-chain setup10000ms і retention test5000ms. Default-priority focused repeat підтвердив нестабільність Launch setup, retention систематично включав PGlite initialization у test budget. T114: retention initialization/schema/data/migration винесено у beforeAll, cleanup у afterAll; SQL/assertions/test deadlines незмінні. Launch beforeAll отримав existing SQL-suite60s fixture convention, лише для setup. Focused nice15 coverage12/12 PASS. Повтор canonical coverage suite19541 ще RUNNING на144-file freeze; це не PASS. Продуктовий код/SQL від fullfast не змінено.

T005: додано mock-only acceptance-preflight-identity,7/7 PASS (36ms assertions): live stack/API/DB mismatch, Auth/DB namespace, subject mismatch, missing migration та truthful unknown deployment/package identity. Цей новий файл існує поки лише в ROOT і не входить у поточний W coverage freeze; окремий evidence log збережено.

## Coverage shard6 follow-up

144-file suite19541 terminal FAIL після PASS shards1–5: team-space-lobby та workspace-section-state first interaction5000ms. Окремий baseline7/7 PASS підтвердив нестабільність; cold first section3744ms. T115 повторює existing T112 test fixture: actual WorkspaceShell/ExplorerShell module imports підготовлено поза interaction budget; actual component mount/state assertions залишилися без змін. Focused coverage7/7 PASS, first section1613ms/lobby1009ms; collection7360ms. Жодних production imports, SQL чи test timeout змін. Повторний full verify:release готується на147-file candidate із доданим preflight identity7-test suite. Усі попередні FAIL збережено, повний release PASS поки не доведено.

## Calendar test-driver follow-up

Full canonical release8039 on147 files terminal FAIL at shard5: task-dates-one-calendar keyboard5000ms; static and shards1–4 PASS. Wrapper finally closed own DB-only source, source roles unchanged, original Soty Beta identity preserved. Profile demonstrated correct keyboard behavior in838ms and expensive role lookup390ms; accessible-label/explicit-role query was proven to return the same DOM element in8.7ms. T116 keeps accessibility visibility check and all keyboard assertions, unchanged5000ms deadline; full-file coverage7/7 PASS with720ms keyboard case. Product calendar unchanged. Temporary W profiling restored before final one-query correction.

Next full verification uses standard npm process priority, serial gates, one worker and heap2048; earlier nice15 failures remain historical FAIL, no blanket infrastructure PASS or full release PASS claimed. This is local verification, no production release operations.

## 500-catalog fixture та coverage watchdog policy

Full release14881518 terminal FAIL у shard3: catalog-updater-dialog500 catalogs5000ms. Static/shards1–2 PASS; wrapper cleanup closed own source, roles unchanged and original Soty Beta identity preserved. Targeted instrumented profile reproduced5044ms: render setup reached first catalog at4399ms; row counting322ms, search lookup76ms, filtering/result198ms. T117 prepares the same500-row fixture in scoped beforeEach and counts hidden rows too (61 initially,2 after searching499), so hidden full lists cannot pass the DOM cap. Full file36/36 coverage PASS under the original5s test watchdog. Temporary instrumentation restored exactly; product unchanged.

T118 corrects watchdog policy for coverage only: individual Testing Library queries already allow5s, so a whole instrumented multi-step test now has15s and setup30s. Fast retains5s/10s, e2e120s, per-query5s, explicit performance metrics and45-minute suite gate unchanged. This is a hang budget, not a product latency acceptance. Nine affected files112/112 coverage PASS. Previous FAILs remain FAIL; no full release PASS claimed. Next canonical full run uses the frozen candidate with these test-only changes.

### Другий reboot і coverage verdict — 2026-10-21

Attempt11317 перерваний host reboot після last-observed7/8 shards; PASS не зараховано. Після reboot усі150 frozen hashes у ROOT/W та перелік changed paths збіглися. Початковий app-support inode збережено, filesystem device ID змінився. Owned source DB звірено за ID/label, roles hash збігся, scoped stop завершено. ResetCounter btn_rst/btn_seq_reset не визначає причину зависання.

Повтор9040 завершився FAIL на coverage:14 executed gates PASS, suite6432 passed/17 skipped/0 failed (6449 total), coverage80.41%. Downstream release gates цього attempt не виконувалися. Усі8 shards завершено; baseline/floors збережено. Own DB закрито, roles і початковий app-support identity збережено. Canonical result/log/suite/summary та runtime cleanup proof: release/acceptance/acceptance-036-20261020/_reboot2-final_. Контрольні platform/catalog76/76 підтвердили ті самі catalog percentages; це не доказ помилки merge. T119 відкрито для поведінкових gaps, а не blanket timeout або зниження coverage.

Нові focused checks: catalog progress/countdown + recovery/Undo12/12; native credential contract13/13, лише mocked native processes (не live Keychain/DPAPI acceptance). Додаткові tests ще в роботі; повний release PASS відсутній. Історичне число6442 у fast runner є total, не автоматично passed: фінальні повідомлення мають розрізняти passed/skipped за suite JSON.

T119 expanded regression:12 files99/99 PASS with coverage (coverage-gap-regressions-expanded-20261021.log). Diagnostic Istanbul union with preserved full map has80.66% and zero named floor/ratchet violations; this is explicitly not a fresh canonical verdict. Native platform tests use only mock child processes; no live Keychain/DPAPI writes. Added model/VAD cases clear inherited overrides and simulate presence, so developer-machine assets do not determine coverage. Existing product files, baseline and critical floors are unchanged from150-file freeze; next candidate adds/extends tests and records only. A tests-only TypeScript issue from unsupported getByRole exact option was corrected; string name matching remains exact by default.

### Наступний інкремент T120 — manifest binding (ROOT only)

Read-only tooling audit у synthetic temp підтвердив, що caller manifest із SET-002 приймався writer/report попри збережений scope SET-001; report все одно залишав NO_GO.7/7 нових regressions були red до fix. Writer/report тепер звіряють disk context, перша нова публікація атомарно закріплює canonical manifest snapshot та actual-byte SHA-256 у run; immutable source не переписується. Legacy development report explicit unfrozen, append/final downgrade відхиляються. Окремий I/O regression відтворив orphan pending run після failed write; cleanup виправлено до retry. Остаточний focused group44/44 PASS. Додані boundary variants на snapshot bytes, symlinks, oversize/parser privacy, concurrent first writes та publication failure.

Це ROOT-only наступний інкремент; W161 не змінено і продовжує release57705. Його canonical fast PASS14/14:6473 passed/17 skipped/0 failed (6490 total). Full release161 та static/test typecheck для T120 ще очікуються. T006/T007 загалом лишаються відкритими, EvidenceAdoption не реалізовано. Докази: manifest-binding-audit-20261021.json, manifest-binding-red-20261021.log, manifest-record-write-red-20261021.log, manifest-binding-final-focused-20261021.log.

T120 closure:53/53 focused including real CLI; CLI red reproduced generic ACCEPTANCE_INPUT_FAILED, explicit manifest codes added to closed allowlist, producer→record→frozen storage→read-only report succeeds and forged scope returns ACCEPTANCE_MANIFEST_MISMATCH. Scripts/tests typecheck and ESLint PASS. Existing9-run report retains5 PASS/4 BLOCKED/165 NOT_RUN, legacy_unfrozen, NO_GO; no frozen snapshot created or old run rewritten. Temporary tooling campaigns removed.

W161 release57705 terminal: unit6473 passed/17 skipped/0 failed, coverage80.54%; only remaining verdict failure apps/web/src/api/subresource-paths.ts89.83 vs baseline93.22. Old16-file violations eliminated; downstream release gates not run in this attempt. Owned DB window closed, roles/original identity preserved. Canonical result/log/suite/summary/runtime: _coverage-gap-final_.

T121 runtime audit: browser ticket cache keyed only by resource path returns an old ticket after a token change; actual agent HMAC validator rejects it under new secret. Explicit clear while a request is pending reuses its old promise. All fetches stubbed, no real session secrets or network; this proves stale capability/preview failure, not a data leak. Evidence subresource-ticket-scope-audit-20261021.json; failing regression and implementation next.

### D036-012 / T121 — local preview authority after reconnect

Four direct cache regressions failed before fix: changed token/origin reused old authority and clear retained pending replies. Two mounted URL regressions also failed: hook had no pairing subscription. Cache now tracks current origin/session and epoch, rejects stale responses/bodies, and deletes only its own in-flight slot. URL hook uses existing pairing notifications, fences older completions and unsubscribes; no new polling. API and subresources share a pure typed request-failure observer.

8-file60/60 coverage group PASS; subresource paths, request-failure observer and URL hook100% lines. Actual issueTicket/ticketAuthorises validate the returned authority across synthetic sessions; no real credentials or agent network were used. Public client→observer regressions cover401/403/transport errors; AgentProvider regression proves correlated privacy-safe link_inconsistency and recheck; the existing read-only connection query runs against PGlite and retains coverage/unknown semantics. Other HTTP/protocol errors and actual media visibility are not claimed by link events; native display is in the owner checklist. Focused report is not new real-Auth A/B acceptance. Full canonical/static validation pending.

### Фінальні canonical gates та передача —2026-10-21T18:19Z

Frozen172 source hashes однакові в ROOT/isolated worktree перед/після обох commands. Перший fast зупинився у shard1: Launch copy5s timeout,794 passed/1 failed; решту не виконано. Окремий файл40/40 PASS, copy58ms; без source чи timeout змін повний canonical repeat PASS14/14 за1287s:6508 passed/17 skipped/0 failed(6525 total). Ця первинна невдача залишається окремим FAIL; причина таймауту не встановлена.

`npm run verify:release` PASS22/22 за1646s: ті самі6508/17/0; coverage80.55%, усі floor/ratchet gates пройдено, baseline/floors незмінні. subresource-paths/request-failures/useSubresourceUrl мають100% lines. Включено shared/web/agent builds, release/team/web-env contracts, isolated full-chain pgTAP database, a11y, browser CSP. Новий real producer→observer→trackLinkInconsistency→sanitizer→stored PGlite→read-only getConnection regression включено у suite; fixture window отримується після insert, щоб новий created_at не був за старим as-of. Це локальний diagnostic proof, не доказ production delivery або native media visibility.

Власний DB-only window закрито у finally; source roles hashes збігаються, source container absent, ports43140/5175 вільні, original Soty Beta inode80094769 збережено. Тестові процеси завершено. ROOT/wishly не запускався/не мігрувався. No production writes/deploy/releases, Git commits/tags/version changes.

Artifacts у release/acceptance/acceptance-036-20261020/: source-freeze-subresource-final-20261021.json; verify-subresource-final-fast-* (перший FAIL); verify-subresource-final-retry-fast-* (PASS); verify-full-release-subresource-final-* (PASS); subresource-final-release-runtime-window-20261021.json; final-verification-cleanup-audit-20261021.json. Current canonical verification-result.json SHA-256:469e5e7847d03069ac45bf14f2a9a3ad3fea58f5361b7cf3a170a22b13132dc4.

T080/T119/T121 закриті лише у відповідному scope. Focused A/B10 PASS/2 BLOCKED(Test Drive)/0 FAIL; owner single-user10-screen checklist готовий. Original174-case catalog5 PASS/4 BLOCKED/165 NOT_RUN, NO_GO; remaining full036 tasks/Windows/hosted/Drive/backup/package не підмінено canonical gates. Після tested freeze оновлено лише документацію/status; продуктовий код не змінено.

## Зупинка за вказівкою власника —2026-10-21

За прямою вказівкою власника перевіряти лише двох користувачів і зупинитися: доступні F2-01–10 PASS, F2-11/12 BLOCKED(Test Drive). Single-user перевірки передано за owner-ui-checklist.md. Подальшу повну036 не продовжувати без нового запиту. T027 retry/backoff defect відтворено, незавершений increment збережено приватно й4 source/test files повернуто до pre-audit стану. Цей fix не застосований і не зарахований як завершений; продукт відповідає canonical172 PASS, T026 tests-only increment23/23 залишено. Повна036 NO_GO.

## Поновлений UI-прохід за новим запитом власника —2026-10-21

Запит «провіряй поки все сам» поновив перевірку10 вікон з owner-ui-checklist.md. Широкий аудит036 і parkedT027 не поновлено. Ізольована acceptance036 beta запущена з реальним локальним Auth; original Soty Beta збережено, runtime/models незалежно клоновано. Прод не змінюється.

Виявлено й виправлено чотири проблеми: resumed wizard Back губив назву/identity;403 PERMISSION_DENIED помилково називався load failure; upload failure креативу помилково називався неправильним вибором файлу; статус завдання змагався з текстовим autosave за стару версію. Статус тепер проходить спільну versioned queue, peer-conflict protection збережено. Focused7wizard+4creative+27editor/layout PASS. Chrome retest підтвердив Back/Continue, правдиві обидва тексти помилок, швидкий опис→Done100% без помилки, дату22Oct та збереження післяreload. Fullfast verification ще триває; історичний releasePASS не є verdict нового increment.

UI-докази/залишки: `release/acceptance/acceptance-036-fresh-20261021/single-user-ui/report.json`. Акаунти/фінанси: створення/rename, Save40/17.45, reload, archive/restore, дата та move з сумами/запуском пройдено. Тарифи: admin search, emptyfilter, +month/Undo та history пройдено. Drive-залежні files/attachments/catalog execution/launch generation та результати медіа не зараховуються. Агентський nativepicker запущено, але його діалог недоступний CUA; browser nativepicker працює без зміни securitypermissions.

П’ятий UI defect: tariffCalendar popover без явної ширини стискався до18px (calendar0px); pointer selection не змінював день, keyboard працював. Додано generic alias існуючого launch calendar popover style, TariffDateField використовує його. Nativeafter320px/calendar252px, click20Nov/save/readback20Nov, restore19NovPASS; no new rawstyle values. Firstfast failed newtest typeoption, secondfast staticallPASS крім formatting того самого testline; виправлено й окремий8-filePrettier PASS. Підсумковийfast ще pending.

FocusedUI final: T122–126 завершено. Frozen10 source/test files ROOT=W незмінні після перевірок.13static gates PASS; перший повний suite FAIL2existinglaunch5stimeouts(793passed), незмінний focusedfile40/40PASS. Повтор лише affectedsuite gate: buildshared+suite2/2PASS,6519passed/17skipped/0failed,6536total,1299s. Initialfailure залишається окремим доказом, причина таймаутів не встановлена. Composed fastcheck evidence, не single fullrunPASS; coverage/release нового increment не вимірювались. NativeUI5fixes retestPASS, але partial/blockedwindows не прирівняно до повної036acceptance.

Artifacts:single-user-ui/report.json,summary.md,final-check-evidence.json,ui-fix-source-freeze-final.json,verify-third-result.json,launch-focused.log,verify-suite-retry-{result,suite,progress}.json/log і runtime-cleanup.json. ОригінальнийSotyBeta inode80094769 повторно звірено післяsuite; власні порти закрито,037 не чіпали. No production writes/releases/commits. ParkedT027 не застосована.

## Підключений Drive і тарифна вітрина — поточний прохід 2026-10-22

Новий дозвіл власника: тестувати самостійно всередині підключеного кореня, створювати й копіювати файли, видаляти лише власні; зберегти Google-сесію. Ізольований acceptance036 runtime активний, оригінальний Soty Beta inode80094769 збережено окремо. Попередній запис про зупинений стенд описує попередній прохід.

Власна QA-папка: `036 QA 2026-10-22 — створено агентом`. Пройдено upload MP4/PNG/ZIP/папки, preview/play, rename/copy/move/trash/restore, примітку й taskattachment; дві реальні локальні Auth-сесії підтвердили realtime rename/note/folder і межі ролей. C viewer відкрив готовий landing preview без локального агента. Catalog create/recreate, manual update та hourly schedule пройдено; тестовий schedule повернуто Off. Generate без каталогу і з каталогом пройдено. Синтетичне зображення каталогу — placeholder URL, тому приймання Meta не перевірене.

Виправлення: bounded reason для catalog WRONG_STATE; видимі SUB errors у розгорнутому accordion; ранній Stop, який міг пропустити late receipt у запуск агента; неправильний transcription indicator під час compression. Для Stop додано correlated workflow/run terminal і явні diagnostic blind spots. Перший native cancel помилково виглядав успішним, але файл з’явився пізніше: первинний PASS відкликано. Після виправлення раннє скасування підтверджене regression tests і read-only diagnose workflow; це не доказ повного mid-flight cleanup у Drive.

Тарифна вітрина отримала суцільну inventory surface, компактний hero, адаптивну сітку переваг і читабельний статус заявки; перевірено світлу й темну теми на поточному desktop viewport. У тарифній таблиці зменшено summary typography, заголовок переноситься, кнопки дій мають мінімальну ширину. Mobile viewport не зараховано.

Докази: `release/acceptance/acceptance-036-fresh-20261021/drive-ui/report.json`, `source-freeze.json`, `investigate-final.json`. 13 static gates PASS за152s після T132; повний suite ще виконується. Перерваний попередній suite збережено як ABORTED, він не PASS. Повна036 залишається NO_GO; parkedT027 не застосовується. Прод, stable manifest, migrations і релізи не змінювалися.

Додаткові T133–134: live view revoke залишав старі таблицю/відео; тепер authoritative view=false демонтує workspace,25focusedPASS і browser video/table/dialog=0. Уже виданий range grant після відкликання теж повертає PERMISSION_DENIED. Початкові editor defaults B відновлено. Sync власної підпапки завершився після закриття вкладки-ініціатора:6files,1folder,runCount1,error/cancel null; це не доказ двох різних admin requests.

Native destination picker виявив ще один Stop defect: agent download реєструвався після вибору папки, тому cancel повертав404, а дочірній діалог лишався. Реєстрація перенесена перед очікуванням; per-waiter AbortSignal закриває власний діалог macOS/Windows, але не діалог іншого активного waiter; TERM→KILL має межу й очищає таймери. UI чесно лишається choosing до agent progress, DOWNLOAD_CANCELED завершує workflow як cancelled.4RED regressions і2RED progress/diagnostic regressions збережені;89relatedPASS. Оновлений agent зібрано й запущено через official beta:down/up, local Auth/Google connection збережені. Native retest: choosing copy, cancel200, download499, own childgone, UIidle. 13static gates PASS127s на21-file freeze; повний suite ще виконується. Перервані раніші suites — ABORTED, не PASS.

Початковий профіль inode80094769 повторно звірено в preservedState; активний синтетичний профіль inode104616221 не підмінювався. Beta залишається активною для збереження підключення. Native destination chooser недоступний CUA для вибору теки; його скасування пройдено. Окрема authenticated local API integration зі своїм destination дала справжній перезашитий MP4 (власні video+PNG): перший кадр синій, H264/AAC320x180; source3.000s/output2.983s. Це core/API delivery proof, не повний UI chooser acceptance. Жодних production writes/releases.

T135 виявлено під час реальної browser оптимізації власного ZIP: macOS ditto додав AppleDouble/xattrs, а transport filename потрапив у folder prefix.2RED→58relatedPASS; zipDirectory лишається platform seam і не пакує resource/extended attributes, team landing worker використовує displayname landing. Діагностичне покриття лишає archive contents unobservable: сам terminal не доводить правильний ZIP чи економію байтів; потрібні synthetic archive/browser checks. Нова аналітика не збирає імен/шляхів/вмісту.

Тарифна вітрина додатково пройшла actual native Chrome widths777/496/406px, scrollWidth=viewport; wrapped email/CTA доступні після scroll. Вікно повернуто до1199x666(початково1200x666). Це responsive desktop proof, не мобільний OS smoke. Поточний25-file freeze ROOT=W; попередні fullsuite attempts були зупинені через знайдені defects і лишаються ABORTED. Фінальний прогін після T135 ще pending.

### Test profile isolation incident (T136)

Final T135 suite aborted after discovering existing optimizer tests write normal Soty landing settings. Observed file preserved privately; pre-test original unavailable, so no guessed restoration. Central Vitest env now assigns separate UUID profiles per project before imports; exact directories cleaned after workers finish. 21 focused tests pass, Main settings hash/mtime unchanged, no leftover verification profile. Full suite must be repeated; earlier aborted runs are not passes. Drive originals and preserved original Beta profile unaffected.

T136 recovery update: original Main process15865 had been running since18:48 before tests. Read-only landing/state retained actual active preferences; only imageQuality differed from incident disk. Rechecked live settings and incident SHA/mtime, atomically restored exact live preference object at23:36:49Z without restarting Main or Beta. Original JSON formatting unknown. Recovery evidence private; subsequent isolation monitoring uses restored baseline.

### Final Drive/UI increment result (T127–T136)

Browser pass complete with documented limits:41 scenarios; fixes and scoped evidence in `release/acceptance/acceptance-036-fresh-20261021/drive-ui/summary.md` and `report.json`. Final static13/13PASS108s; isolated full unit suite6541PASS+17explained skips,0fail,1593s. Coverage not measured; no release/package/production acceptance claimed. Source freeze28files stable and ROOT/acceptance worktree identical. All temporary verification UUID profiles cleaned. Main live preferences recovered and stable through the remaining suite; original Beta profile inode80094769 preserved, active synthetic inode104616221 retained. Beta/Google connection stays running; no production deployment or release.

Current remaining limits: native chooser completion, full mid-flight provider upload cleanup, two different admins starting sync concurrently, and broad036 Windows/hosted/load/backup/package evidence. F2-11 focused role/media cases PASS; F2-12 remains PARTIAL. Broad036 remains NO_GO. Optional owner review is three windows in owner-ui-checklist.md.

### Додатковий автономний прохід22жовтня — поточний checkpoint

Докази та відомі невиправлені дефекти: [drive-followup summary](../../release/acceptance/acceptance-036-fresh-20261021/drive-followup/summary.md). Два локальні виправлення: E5 no-warmup та packet-cadence proof для довгого held output. Real-model5PASS; bundled held-contract19PASS; system long-embedding2PASS; PostgreSQL834pgTAP+5tariffPASS у видаленому disposable container; shared budget2PASS; concurrent owner+admin sync API PASS з поверненням ролі B. T139 late-upload orphan та T143 bundled7.1.1 sparse/EXIF defects лишаються відкритими. Повторний повний canonical verifier ще виконується, PASS не заявлено. Старий6541PASS є історичним і не замінює перевірку нинішнього source snapshot. Full036 NO_GO.

### Follow-up355/T156 — 2026-10-22

Локальні354/355 застосовано безreset зі збереженням auth/Drive.355isolated:885pgTAP/36files+10nativePASS; service-role SELECT працює, actualDELETE WHERE FALSE42501 наобох diagnostic views; investigate/inspect readbackPASS. Canonical snapshot3001inputs unchanged:13staticPASS, suite зупинився shard1 на2timeouts (805PASS/6skip); незмінений targeted repeat28PASS. Повна регресія не завершена.

T1564RED→19relatedPASS: native ownership reread після reconnect/newinstance таstorage/focus; event pulse opaque/no credential, disabledstorage fallback. Development proof only; no actual cross-tab/native ownership PASS. Accepted owner tariff UI unchanged. Full036 NO_GO; Windows/hosted/load/backup/exact-SHA та відкриті tasks зберігаються.

### T157–159 local development checkpoint2026-10-22

T157 valid different-subject entitlement no longer inherits older account state solely because its expiry is shorter;8focusedPASS, shared98related+13staticPASS. Native delegation actor binding/revocation remains a separate openT034/T038 requirement, and the running Beta agent has not been rebuilt for this source change.

T158 stale showcase headings/email assertions reproduced in2tests and aligned to accepted owner9dca022d UI. Product showcase unchanged. T156 canonical result remains FAIL atshard6; no full successful suite or lifecycle reconciliation claimed.

T159 bounded retention:2RED→5retention+23delegation regressions; shared98relatedPASS includes synthetic Vault delete failure rollback.356migration chain:885pgTAP/36filesPASS;initial native10PASS/1existing5stimeout, unchanged fresh native group retry11PASS, disposable containers removed. New two-session case proves locked oldest root is retained while100others are pruned, then removed next sweep.13staticPASS72s. Local356 applied without reset; auth/Drive/root preserved; actual localCLI investigate/inspectPASS, unknown execution/delivery remains explicit. Bounds are per retention class and lifecycle roots, not fixed cascaded row count or global dispatch duration. T047resource/LOAD, actor isolation, foundation tooling, Windows/hosted/backup/exactSHA and full036 remain open; NO_GO.

T160–161 protocol/logout checkpoint (2026-10-22, source only): compatibility fence is GREEN: handler rejects missing/unsupported numeric protocol2 before RPC; forward357 rejects old redeem/claim/checkpoint callers even behind an older Edge. Disconnect remains a cleanup exception. A marker is compatibility evidence, never actor authority. Four protocol/worker files82PASS. Native gate now serializes actor-scoped logout with token acceptance, runs durable retirement preparation before clearing signed state, writes an atomic null cache, and does not clear a newer actor on stale logout. Cleanup compares the verified stored subject even after grace expiry. New paired `/api/entitlement/logout` requires allowed origin and session token while remaining entitlement-exempt. Gate3RED and native route3RED became GREEN; expired-subject cleanup is also covered. Latest7files112PASS. Agent typesPASS; other current checks recorded separately. Browser logout is NOT wired yet: define bounded durable retry when native is unreachable so cloud logout cannot silently leave a restartable old delegation. Retirement diagnostics/native357/live acceptance/full gates remain open. No runtime mirror, migration apply or provider write in this batch; owner-approved tariff UI untouched.

T161 browser lifecycle checkpoint (2026-10-22, source only, supersedes browser-not-wired note): explicit AuthContext logout and external SIGNED_OUT now publish a per-actor native retirement intent before discarding browser identity. A bounded32-entry metadata queue (actor UUID + random intent UUID only; no token/provider data) survives reload. A per-tab serialized publication lane plus shared revision fences token exchanges started before logout. Reconnect drains intents even if the initial health says entitled, re-reads health after retirement, and only then evaluates token exchange. Pending native cleanup blocks new identity publication; cloud signout itself is not held hostage to an unreachable native app. A newer same-actor intent cannot be deleted by an older acknowledgement. Disabled storage has only a bounded in-page fallback, explicitly unrecorded rather than durable.

Evidence:3 behavioral AuthProvider regressions RED→GREEN; original retirement test's first RED was missing-module import only, not a behavioral reproduction. Current6browserfiles40PASS including real ensureAgentEntitlement delayed exchange/retirement overlap, offline queue restart, retained other actors, signout event, reconnect order and fresh health. Browser/test TypeScript and targeted ESLint PASS. Follow-up7tests isolate module state per test. This is development evidence; no live native/Beta migration357/rebuild, provider writes, owner UI change or fullcanonical claim.

Remaining T161 blockers within implementable scope: a persisted browser retry is NOT sufficient if native starts headless and the browser never returns. Add authenticated server-side retirement scoped to the intended actor/installation before session destruction (or another proven server lifecycle seam), with canonical operation/grant fences and no effect on another actor. External SIGNED_OUT with no usable session must remain diagnosable unknown, not alleged server acknowledgement. Native pending/server-ack/local-cleanup stages and browser storage failure need complete privacy-safe CLI evidence. Cross-tab in-flight publication races, native rotation/enrollment, source357 PostgreSQL/live paired verification and final gates remain open. Do not close T160/T161 or broaden retirement to unrelated devices without checking the logout scope contract.

T161 scoped server logout checkpoint (2026-10-22, source only):3 behavioral database regressions RED→GREEN. Source357 now factors canonical per-delegation cancellation into a private owner-only helper. New authenticated `retire_team_recovery_installation(uuid)` derives actor solely from auth.uid(), retires only that actor on the selected installation, revokes bound unfinished-process grants, preserves terminal/unrelated operations and other actor/device delegations, deletes that scope's pending enrollments and is idempotent. Anonymous/helper execution is denied. Setup/redeem/installation logout share one actor+installation advisory lock before row locks, including the absent-row case, so the logout delegation snapshot cannot miss a redeem already racing with enrollment deletion. This still requires real multi-session PostgreSQL proof; model execution is not concurrency acceptance.

Native paired health advertises a non-secret installation selector; public health does not. Browser remembers the validated hint after paired health or setup and never guesses an installation when absent. Explicit logout calls the authenticated server RPC before destroying its session, while native durable retirement runs independently. The request uses a captured JWT, so a concurrent switch to another actor cannot redirect cleanup to that actor. Missing hint/session, refused/malformed receipt, timeout or missing RPC returns unconfirmed, not global retirement. Auth lookup itself is bounded:1RED timeout→GREEN without raising the test timeout; a late lookup after expiry cannot issue the request. External SIGNED_OUT attempts cleanup only with a still-matching usable session and otherwise remains unconfirmed.

Current10files121PASS after the shared SQL lock; agent/web/test TypeScript PASS, targeted lint recorded separately. Types include the draft RPC shape but authoritative local generation must follow the native357 cutover. ROOT source only, W/runtime still356; source357 has never been applied or mirrored. No provider writes, no production mutation, accepted tariff UI unchanged. Remaining: native357 and two-session grant/redeem/logout/rotation races, cross-tab publication, missing-session/failed-server retirement diagnostic coverage, durable pending/server-ack/local-cleanup read-only CLI evidence, upgrade UX and current full canonical/release checks. An unconfirmed cloud retirement does not prove that a headless old worker has stopped; no such acceptance is claimed. T160/T161 and broad036 remain open/NO_GO.

T161 native357 checkpoint (2026-10-22, supersedes native-not-run notes): complete ROOT357 chain replayed in a disposable real Supabase PostgreSQL clone using only schema/role definitions, no application rows or source passwords; scheduler disabled.36pgTAP files/885assertions PASS, plus14real native cases across4files PASS. Three new retirement cases use controlled open transactions and observed pg_stat_activity states, without timing sleeps: redeem-first→logout waits and retires the created delegation; logout-first→redeem waits then AUTH_REQUIRED on the removed ticket; another installation completes while the original transaction remains held. Current SQL hash matches the previously recorded357 source. The clone and volumes are removed (verified docker ps -a prefix empty); source acceptance036 and unrelated037 databases are unchanged. Current Beta/W remain356; no357 apply, source mirror, rebuild, provider action or production mutation.

A separate local persistence audit found2behavioral RED: an old blocked/permission_revoked checkpoint skipped saving a new revoking flag, and a failed first checkpoint save left memory equality that could skip the second durable preparation. Worker now saves even when the blocked checkpoint already matches, before allowing identity publication.66worker/journal/entitlement relatedPASS; current agent/test TypeScript and targeted lintPASS. This is failure/retry/restart development proof, not physical power-loss or Windows acceptance.

T160/T161 remain open. Next: native pending/server-ack/local-cleanup diagnostic stages and agent-readable correlation (do not equate browser receipt/local preparation with server acknowledgement), further delegate/rotation/cross-tab publication races and explicit upgrade UX, then coherent source mirror, guarded local357 cutover/rebuild and synthetic paired two-actor native QA. Current full canonical/release verification and broader036 requirements still pending; overall NO_GO. Proof: drive-followup/t161-native-retirement-proof.json.

### T161 diagnostic/CI checkpoint — 2026-10-22

Native worker emits the shared closed retirement vocabulary with only stage+opaque delegation ID. Pending is emitted after successful durable preparation, never after a failed write. Server acknowledgement and protected-key cleanup are separate; a missing last handle leaves server_unknown. Phase duplication is suppressed while the same registration state is unchanged. Real DiagnosticsLog sanitization accepts the records without credentials or protected account names.

3workerRED +3investigateRED +1auditRED→GREEN. investigate groups by delegation and native instance and selects highest seq, so delayed arrival of an older pending record cannot replace a newer local-cleanup phase. Unsupported stage/binding stays insufficient without echoing arbitrary props. Cross-boot ordering/current status is not inferred. audit reads only matching retirement journal groups, excludes future recorded/received receipts at as-of, and lists server_acknowledgement_unknown/local_cleanup_unconfirmed/unknown_retirement_stage_or_binding. Its browser-only gap remains explicit; it never adopts unrelated sync jobs as retirement proof.153related tests/11filesPASS;11container safety casesPASS; current agent/scripts/test TypeScript and targeted ESLintPASS. A test instrumentation type incorrectly admitted null values; aligned with the real producer non-null contract, without changing runtime assertions.

Canonical `npm run test:db` now runs all four real native PostgreSQL files after pgTAP, serially. Guards accept only the exact random canonical/acceptance container prefixes and reject live/beta/project containers and ambiguous names. Optional SOTY_TEST_DB_SOURCE_PROJECT selects a strictly validated local schema/role baseline only; it accepts no remote URL and copies no application rows or source passwords. Actual canonical run against acceptance036 baseline:885pgTAP/36files+14native/4filesPASS, clone/volumes removed and source stack unchanged. This is the real tracked runner, not just the earlier private helper.

Plan/task headers and T160/T161 text now show current source-only state; historical RED/pending notes below are not current status. W/Beta remains356,357 not applied, no mirror/rebuild/provider action/production change. Remaining server/browser-only receipt, unusable-session fallback, delegate/rotation/cross-tab races, upgrade UX, live paired A/B and full current canonical/release/broader036 criteria keep T160/T161 open and whole036 NO_GO. Proof: drive-followup/t161-retirement-diagnostic-proof.json.

### T040 current source checkpoint — 2026-10-22

8behavioralRED→upgrade/capability handlingGREEN. First draft fixture used a stale installation after emptying registrations; corrected before the recorded8RED. New actor-bound capability requires protected credentials and, in health, enforced signed identity plus the registered worker module. API health preflight precedes identity/enrollment. Legacy native status/disable stays available; new setup is withheld. Missing actor in a valid older receipt no longer throws before saving its issued refresh: the handle is retained for retirement, with AGENT_UPDATE_REQUIRED. Malformed actor and a different valid actor remain INVALID_RESPONSE/PERMISSION_DENIED; confirm preserves only closed errors and never arbitrary upstream text. UI uses existing translations/components; owner-approved plan-selection window is unchanged.

2additionalRED→GREEN: no setup while ownership is unknown; old team state does not expose actions for the next team. The scoped panel also discards state on native instance/connection changes. Initial static run found the wrong instance property and2format issues; corrected to lastKnownAgent.instanceId, added explicit native-instance regression, then124related/12files and13static gatesPASS.3020source inputs unchanged over the successful static run. This is current source evidence, not live old-artifact acceptance. Beta public health was read-only checked:1.2.6+71/95467002,busy=false,noactor-boundcapability; no mirror/rebuild/migration/provider action. W/runtime remains356. T040 andT160/T161 remain open for live paired/full candidate/browser-only/further-race acceptance. Full canonical regression is next on a fresh frozen snapshot; previous partial shards must not be reconciled as complete. Proof:drive-followup/t040-upgrade-proof.json.

### T166 source checkpoint — retained journal provenance (2026-10-22)

Current Beta remains the verified T164 runtime. T166 is source-only and not yet accepted live. Newly produced records retain `agentInstanceId` plus per-boot `instanceSeq`; the local `seq` remains a monotonic file cursor, preserving031 persistence/rotation. This implements033 fresh sequence per boot on the ingestion wire without destroying local historical pagination. Legacy records are never assigned a fabricated producer. Malformed stored binding is refused.

Native history requires explicit `journal=bound-v1` and returns `journalProvenance=bound-v1`. The default response of a configured native journal includes only its current boot, so old web clients cannot relabel retained history. New web clients send contiguous producer groups under their original UUID and per-boot sequence, with at most five bounded fetch/send iterations; the physical cursor advances only after acknowledgement. Cursor v2 replays history that v1 clients may have skipped; server uniqueness handles duplicate delivery. No SQL migration or automatic beta analytics is introduced.

Initial producer tests2RED→GREEN and historical-forwarding1RED→GREEN.139related tests passed before the added native API opt-in and old-cursor migration regressions. Fresh related/static checks, actual native restart, real local capture→read-only CLI and full canonical/release remain pending. T166 remains unchecked; browser-only/actor attribution gaps stay explicit.

### T166 actual restart and product-forwarder checkpoint — 2026-10-22T20:02Z

30runtime files guarded-mirrored after184related/7files and13static gatesPASS on3023 unchanged inputs; W rebuilt using official beta down/up. Owner tariff window preserved; schema357 and profile inode104616221 unchanged. Real X/W2→A handoff repeated successfully, finalA restored, no provider writes. First T166 boot `ffd5eb68-ab71-42a4-a300-2b299082112f` produced3retirement stages carrying original boot/per-boot sequence. No server capture before restart. Official beta down/up then produced UUID `2e2911ec-6720-4bde-9804-7e93eac3f421`, with boot sequence1 and the prior3records intact.

The actual ROOT product forwarder (bundled only to run in Node with explicit local transport/auth adapters) delivered22real records, then replayed22duplicates after cursor clearing, rejected0 and created no duplicate rows. Each trigger retained the≤5fetch/send budget. Existing SELECT-only reader and ROOT CLI returned all3old-boot retirement records and a completed fact under the original boot; current boot seq1 was also confirmed. Native default response served only the current boot for old clients. Proof: `drive-followup/t166-retained-journal-live.json`. The first private harness preflight incorrectly expected paired health.ready; corrected to paired.ok plus public.ready/idle before any ingestion. Its failed result is retained.

Automatic Beta analytics stays disabled. Explicit test adapters do not prove unattended browser trigger delivery; observed-underA does not prove actorX attribution. Legacy unbound history remains unknown. Browser-only/session-loss diagnosis, full canonical/release and broad036 remain OPEN/NO_GO. Added explicit rotation/provenance and bound-history legacy exclusion regressions; current repeat and complete canonical pending.

Final T166 affected repeat:186tests/7filesPASS, including provenance across file rotation and legacy bound-page exclusion. Production source unchanged after the successful live mirror; only two test cases and planning records were added. Next is a fresh complete canonical fast verification, retaining shard diagnostics and whole-suite transition observations. No full result is claimed in advance.

### T168 correction — old/new web sequence identity (2026-10-22T20:16Z)

Read-only actual native inspection exposed a defect in T166 compatibility: default API returned physical seq637/638 while bound-history forwarder ingested those same current-boot records as seq1/2. The same semantic fact could therefore have two server uniqueness keys when old/new web coexist. Prior T166 actual-forwarder/restart proof remains valid for its tested path, but did not cover cross-version ingestion identity. T166 is reopened for this correction.

The complete canonical run was intentionally terminated for this confirmed defect, not an observation timeout: exact owned wrapper and5descendants verified, only owned descendants SIGTERM. Terminal wrapper exit1 retained shard1:839PASS/0fail/0skip, partial only. Proof: `t166-full-canceled-for-cross-client-defect.json`. Do not reconcile that incomplete transition log as a whole-suite result.

2native API/sequence regressions RED. Default API now filters/paginates in per-boot sequence and uses that same head for an empty page; explicit bound history keeps physical cursor plus original producer sequence. Current related/static/live old+new ingestion/replay repeat and a fresh full canonical remain pending. Beta still runs the pre-T168 candidate until guarded update.

### T168 live cross-client correction verified — 2026-10-22T20:23Z

186related/7files and13static gatesPASS on3023 unchanged frozen inputs, then guarded30file mirror and official Beta down/up. Current boot UUID `775b2ddf-49d6-4d1d-9460-785ed1a2e91e`; actual paired X/W2→A handoff repeatsPASS, finalA restored, protected handle removed, providerWrites0. Owner tariff window/profile/root/schema357 preserved.

Old-format API seq1 was explicitly delivered to the local ingestion RPC first. The actual current ROOT product forwarder then delivered bound history and replayed after cursor reset:18accepted,64duplicates,0rejected across bounded runs. Existing SELECT-only ROOT CLI proves exactly one current-boot seq1 fact and the original3retirement records still under producer UUIDffd5eb68. Current/old clients now share the same uniqueness key. Proof: `t168-retained-journal-live.json`; no fabricated metadata, no automatic beta analytics. This closes the narrow T166/T168 development correction; browser-only/session-loss/actor attribution, complete canonical/release and wider036 remain open.

Additional real browser-function tests (Node transport adapters, no native calls) passed missing/mismatched sessions, other-actor isolation, server revocation, repeated idempotent retirement and loss before write/after commit. A committed action with a lost reply remains client-unconfirmed until a successful retry. Own synthetic delegation cleanup confirmed. Proofs: `t167-browser-only-live.json`, `t167-browser-only-loss-live.json`. These prove function/server behavior, not physical-browser signout UI or complete diagnostic coverage. T167 remains required.

### T168 complete canonical checkpoint — 2026-10-22T21:02Z (local 2026-10-23)

The complete canonical fast verifier finished successfully:14/14gates,6873tests total =6847PASS+26conditional skips,0FAIL;2175seconds. All3023frozen input hashes and the complete Git input path set stayed unchanged. The dedicated wrapper ended0 and retained all8shard reports. Actual source-run Beta remainsT168, not an exact-SHA package or promotion record. The subsequent lifecycle reconciliation used the completed whole-suite log with REPORT set and LOG unset:106PASS. It did not append observations to the report it checked. T165 current-functional/full-fast verification is now satisfied; release form and broader036 acceptance remain open.

Proofs: `drive-followup/t168-full-proof.json`, `t168-full-canonical-result.json`, `t168-full-suite-details.json`, `t168-full-transition-reconciliation.log`. Conditional skips include signing/notarization, separately gated real media/translation/power and disposable PostgreSQL runs; they are not PASS/N/A. Current schema357 real PostgreSQL evidence remains separate from this fast command. New T167 work exists only in `/Users/daynero/RiderProjects/AffSupport-036-next`; it is not covered by these T168 results or mirrored into the running Beta. No production deployment/migration/release was performed.

### T167/T169 local development evidence after T168

Current isolated related114PASS/12files and static13/13PASS119seconds; actual guarded beta capture6/6accepted,0dropped and SELECT-only NEXT CLI verifies shared-state refusal, superseded intent and unknown lost-actor terminal. Physical browser/Web Locks ordering is not observed. Source32files are now merged into ROOT with hash checks; runtime remainsT168/schema357. Current merged full/receipt358/runtime acceptance is NOT_RUN. These are scoped development proofs and do not mark any of the174manual cases PASS or authorize production. Proofs: `t169-logout-diagnostic-live.json`, `t169-intent-diagnostics-static-result.json`, `t167-t169-root-source-merge.json`.

### T170 beta358 cutover and actual receipt acceptance

Applied only tested migration358 through the pinned explicit-local CLI after verifying all357existing migration files/history matched and runtime idle. Migration hash matches disposable919pgTAP+14native proof. No reset/reconnect: connected Drive binding hash/count, profile/pairing, original retirement RPC and sweep body preserved; cleanup coverage remains verified. Six runtime files mirrored with base/source hash checks, six owner tariff files unchanged. Official beta down/up completed: new native UUID14d284e2-b54a-436a-b6df-75be244c1621, real entitlement enforced, new web lane module served and358schema retained.

Actual ROOT function + real synthetic X/W2 and A authentication/Edge/RPC + guarded typed capture delivered8/8events,0dropped. A cannot retire X; missing/mismatched sessions do not issue scoped requests; pre-write loss has no receipt; committed reply loss is server-confirmed/browser-unconfirmed; cached attempt preserves a fresh setup; matching/repeated receipts confirm; original numeric endpoint remains compatible. SELECT-only ROOT CLI proves these distinctions and excludes A's chosen attempt UUID colliding with X's actor ID. Own delegations cleaned; native/provider requests0 for this browser-function harness. No physical signout UI claim.

Native X→A handoff repeatedPASS on the new boot: server revocation, protected-handle removal and final A restoration confirmed, providerWrites0. Retained original-boot3records, current-boot seq1 old/new unique-key agreement and cursor-reset replay repeatPASS through actual forwarder/RPC/readonlyCLI. Public proofs: `t170-local-358-apply.json`, `t170-runtime-cutover.json`, `t167-observed-receipt-live.json`, `t170-paired-native-handoff-repeat.json`, `t170-retained-journal-repeat.json`.

A final inventory regression was RED: receipt-capable databases must not still claim browser server outcome is universally unobserved. Native cleanup remains unobserved separately; legacy missing projections retain the old explicit gap. Corrected query/inventory plus legacy investigation's explicit unavailable-receipt expectation:49PASS/4files. `docs/BETA.md` now documents the proven preserve-profile incremental path. Current full/release verification remains pending; T170 full canonical starts next on frozen current ROOT inputs. No production action or promotion.

### T170 terminal frozen full verification — 2026-10-22T23:56Z

Canonical fast verification finished successfully:14/14gates,6917PASS+26explicit skips=6943tests; all8retained shard reports have0fail/unknown/errors. Terminal validation proves all3042source inputs and the complete3043Git path set unchanged against the T170 freeze. Whole completed transition log reconciliation passed106tests with REPORT-only and LOG unset. Proof: `release/acceptance/acceptance-036-fresh-20261021/drive-followup/t170-full-proof.json`. This closes current fast/full evidence only; T170 remains open for relevant release-form/build/database contracts. T167/T169 physical two-tab and older non-cooperating tabs remain explicit limits. Broader036 verdict remains NO_GO; isolated NEXT adoption schema is excluded from this frozen result.

### Startup recovery and bounded clock CLI — 2026-10-23

T171 source is selectively mirrored to ROOT/W. The exclusive private journal is published before
stack startup and environment changes, records each spawned child, and survives failure.
The actual beta:down script was exercised against isolated OS/CLI adapters: partial start
cleanup and environment restoration passed; a borrowed listener was refused without a stop.
29startup/network tests passed; the later CLI/runner/startup run passed37tests. Scripts typecheck
and targeted lint passed after correcting declaration scope and cleanup. Real official down/up
completed on schema358: `beta-startup-journal-runtime-after.json` confirms new boot, retained
profile/pairing/Drive, unchanged6owner tariff files,9containers/3published loopback bindings.
Chrome A/W1 explorer visibly reconnected. No provider writes or production changes.

NEXT-only clock CLI accepts canonical UTC and real TTL1s–1h, and supports explicit clear.
Unsafe target/date/flags/TTL are refused without opening the target. Native359chain/942pgTAP
and14parallel tests passed in the disposable database. The live beta still has358migrations;
clock activation/automatic fixture-clear/native rollback/production isolation and031diagnostics
remain required. A corrected parameterized Git-path regression passed16tests; its earlier
setup timeout remains recorded. No evidence adoption or full036 pass is claimed.

T171 closure: current ROOT run49918 passed29tests/3files on the mirrored source. NEXT scripts and tests typechecks passed; the initial test typecheck used stale shared declarations, and rebuilding the isolated shared package resolved it. `beta-startup-journal-proof.json` binds source hashes across ROOT/NEXT/W. T170 and broader036 remain open.

### Clock lifecycle and physical-browser checkpoint —2026-10-23 07:57Z

Clock cleanup now uses the same ordered namespace/global advisory locks as its setter. The fixture cleanup orchestrator restores real tariff time before deleting application or Auth fixtures, refuses foreign overlays before deletion and supports interrupted Auth cleanup retry without requiring already-deleted users. PG18 NOT NULL catalog entries are accepted only after exact required-column validation. Current combined related repeat17PASS/3files: PGlite teardown6, runner8 and actual cleanup orchestration3 (GoTrue/local-stack/private-receipt adapters). Native full attempt:942pgTAP PASS and20/21native PASS; initial rollback test setup used a text argument in a UUID position. The corrected focused native repeat replayed all359migrations in a fresh disposable database and passed7clock tests, including actual rollback/forward and synthetic row preservation. It did not rerun pgTAP or manufacture a full canonical result. Current static12/13PASS; format timeout retained; isolated affected-gate repeat PASS.

Physical Chrome: two newly owned local synthetic accounts, two incognito tabs. Signout propagated without reload; replacement login propagated. Onboarding completion did not refresh the sibling cached profile, which corrected after reload. Private window closed; main owner explorer remains connected and native actor A/profile/pairing preserved. This is ordinary shared-session behavior, not proof of delayed logout/pending OAuth or old non-cooperating-tab races. Public evidence: `browser-session-two-tab-proof.json`, `browser-session-profile-preservation.json`. No provider writes, membership grants, original-user mutations or production changes.

Current focused clock lifecycle proof: `clock-lifecycle-proof.json`;17related testsPASS and7native testsPASS. Static attempt12/13PASS with format timeout; affected format repeatPASS. No current full canonical PASS is claimed.

### T172 completed —2026-10-23

Profile synchronization now publishes only an opaque project-scoped invalidation; each recipient reads its own RLS profile, with10second abort, coalescing and activation fallback. Delayed reads and writes cannot overwrite a replacement actor or a completed local write; SDK SIGNED_OUT still permits its own logout cleanup. Initial3RED reproduced the stale sibling and old-actor overwrite. Final80related tests/8filesPASS; ROOT additive merge50tests/4filesPASS; NEXT web/all-test typechecks and targeted lint/formatPASS. Initial static timeout and two implementation errors remain recorded rather than erased. Source update and recipient refresh have independent typed, actor-fenced diagnostics; actual local collector7accepted/0dropped and SELECT-only CLI prove failures, recovery and explicit missing-terminal uncertainty.

Physical Chrome two-tab onboarding and name change/restoration passed without reload or second onboarding submit. Own private window closed; original A/native profile/pairing/Drive and schema358 preserved. Owner tariff files and concurrent ROOT launch-defaults registry retained. Proof: `t172-profile-sync-proof.json`. Full current canonical T170 and broader036 remain open. T173 records an independently observed verifier timeout orphan; this is not a diagnosis of prior machine freezes.

### T173 verifier timeout cleanup — 2026-10-23

The failing real-process regression is fixed: a timed-out wrapper and its ordinary descendant terminate while an unrelated process remains alive. POSIX gates use a private process group; Windows uses bounded PID-scoped taskkill /T /F and refuses reaped wrapper identities. Failed OS cleanup remains explicitly unconfirmed and output pipes cannot hold the verifier open. Focused validation:37PASS/5files, lint, format, scripts and all-test types PASS. Exact tested files merged into ROOT and retained beta with baseline/hash guards; six owner tariff files preserved. Native Windows execution and full current canonical verification remain pending; T173 stays open. Proof:`t173-process-tree-proof.json`. This observation does not establish a cause for earlier machine freezes.

### User-requested current Launch UI beta restart — 2026-10-23

Mirrored14exact ROOT files for the latest Launch account selector/defaults UI and its shared/schema dependencies into retained beta, with private preimages and hash guards. Official beta:down/up completed; new boot6c8c5f7b-aa1f-4def-985a-22515212a65c. Guarded local migration up applied only20261206140000_launch_offer_defaults: beta now has359migrations. Profile inode, pairing and original Drive binding preserved; no reset or production change. Chrome original owner session visibly loads Explorer, Launch list and new form with account combobox and offer/workspace defaults. User is checking this UI; do not restart or change that live worktree while independent NEXT work can proceed. Proof:`ui-launch-restart-proof.json`.

The unapplied NEXT clock migration has a timestamp collision with the now-applied Launch migration. Rebase the clock candidate to a later unique version and replay its focused SQL/rollback checks before any merge or local application; historical359clock-only proofs are not proof of the new combined chain. T011/T012/T016 remain open. T016 source/artifact containment guard is newly implemented in NEXT but not yet validated or merged.

### Combined-chain regression found by full native gate — 2026-10-23

The first full isolated360migration attempt failed5of942pgTAP assertions in recovery execution/receipt coverage; native tests did not run. Frozen2354source inputs were unchanged and the disposable container was removed. The new Launch offer-default table lacked the shared task_cleanup_reference_fence, so conservative cleanup correctly refused complete coverage. NEXT now adds a separate forward migration20261206140500, registering the existing generic trigger rather than exempting JSON or future columns.23PGlite testsPASS prove existing references retain orphans, new references after a cleanup claim are refused with WRONG_STATE, and regular Launch defaults remain valid. Full361migration repeat is running; no fix applied to live beta yet. Proof:`launch-defaults-reference-fence-proof.json`.

### Full combined361 database gate completed — 2026-10-23

Repeat session93269 exited0:948pgTAP assertions/39files and21native tests/5files PASS. All2356frozen source inputs and their complete filtered path set remained unchanged; the owned disposable database was removed. Actual clock rollback/forward preserved nonempty synthetic tariff and offer-profile rows and unchanged offer RPC definitions. The first5/942failure is retained. Local SQL benchmark fixture setup was slow (full pgTAP511s); this is an observation, not a hosted load or UI-latency acceptance result. Clock and new reference-fence source remain NEXT-only. Proof:`clock-rebase-proof.json`.

### Second user-requested UI restart completed — 2026-10-23

Mirrored9current ROOT Launch UI files in two guarded snapshots (initial8plus5newer deltas;9unique paths), with private beta preimages. No shared/schema changes or reset. First beta:up74477 failed Supabase storage/realtime/pg_meta health timeout; official beta:down reconciled it and retry81174 is resident/healthy. Boot6870f41b-7d49-4f57-8bc5-cfa93feaf8eb; schema359, profile inode, pairing and Drive binding unchanged. All9live UI hashes match current ROOT; physical Chrome form reload shows the compact Save settings controls. Proof:`ui-launch-second-restart-proof.json`. Keep beta available for the owner.

Next independent work: finish lint/all-test type checks and diagnostic inventory for the verified Launch reference-fence fix, then merge that small fix into ROOT with baseline guards. T016 containment code remains NEXT-only with66focused tests. Clock361combined DB gate is green, but actual guarded live clock, invitation/JWT/lease/undo clock boundary proof, mail capture,031diagnostics and final integrated acceptance remain incomplete.

### 2026-10-23 — Launch cleanup reference fence merged

The additive360 reference trigger and native regression are merged into ROOT without copying the NEXT clock. NEXT and ROOT each pass36focused tests across3files; lint passes in both, all-test types pass in NEXT. The expanded SQL regression invokes the real read-only CLI reader under a read-only database session: existing references and disabled coverage retain files with their distinct closed codes and zero confirmed deletions; content stays absent. The original361migration native proof remains valid for unchanged SQL, not a claim of a new full canonical run. Owner Launch diagnostic additions were retained by exact-fragment updates; a later concurrent standalone-duration inventory note is preserved and recorded separately. Live beta remains359 with the owner’s current UI; T174 tracks local migration and runtime acceptance. Proof: `launch-defaults-reference-fence-merge-proof.json`.

### 2026-10-23 — T016 executable hook and ancestor boundary proof

Three real release-command regressions reproduced target-binding reads before fixture rejection; moving binding resolution after the isolation scan makes contract/candidate/final reject the leaked clock fixture first. The actual beta doctor similarly rejects a capture marker before profile or service checks. Two additional failures showed that lstat on a leaf follows a linked parent; every ancestor below the selected repository is now checked before input reads.80tests across6files pass, together with formatting, lint, scripts and all-test types.439source inputs scan clean; no built web exists in this candidate, explicitly not bundle acceptance. All changes remain NEXT-only. T016 stays open for fault/mail adapters and live teardown. Proof: `t016-hooks-proof.json`.

### 2026-10-23 — T011 operational deadlines under the real local clock fixture

The new isolated deadline suite installs the actual fixture SQL and shifts only its tariff_at by minus and plus five years. Production RPCs retain invitation14days, enrollment120seconds, claim300seconds, immediate-claim rate refusal, Undo and cleanup60second lease behavior; both valid and expired paths are exercised. The first run exposed fixture preparation mistakes (invitation timestamp constraint and insufficient synthetic tariff seats), corrected without changing product code.76tests across4files plus touched lint and all-test types PASS with recorded source hashes. No native DB rerun was needed because SQL did not change; prior361native evidence is separate. Supabase JWT under the actual local overlay, guarded live CLI and notice capture remain unproven, so T011 stays open. Retained beta/profile/Drive unchanged. Proof:`clock-deadlines-proof.json`.

### 2026-10-23 — T014 mail capture implemented in NEXT

Real worker capture is now an explicitly trusted beta-only dependency; deployed index has no activation flag. The CLI validates the local target, stack and synthetic ownership, refuses foreign pending or leased notices before global claim, and renders redacted messages into immutable files. Actual PGlite pipeline tests prove skipped rather than sent, no repeat artifacts, database rollback after partial storage failure, and unknown commit acknowledgement.95tests across6files, formatting, lint, scripts/all-test types PASS;361migration sources unchanged. Native lock-contention and retained-beta CLI runs remain open; no live beta/profile/Drive or production writes occurred. Proof:`t014-mail-capture-proof.json`.

T014 final refinement:97tests/6files and all static/type checks PASS. The adapter now reports an explicit pending count and partial/idle state, and rechecks the cleanup marker under the namespace lock. Initial95-test proof and validation are retained; current source hashes are in `t014-mail-capture-proof.json`. T014 remains open for native concurrency, live CLI, all notice variants and integration; runtime beta unchanged.

### T014 native database concurrency — 2026-10-23

Added3 native concurrency/recovery cases in NEXT and registered them in the isolated DB runner. Full361 migration replay;948pgTAP PASS and21existing native PASS. New file initially failed on clone-only private function ownership, then on an incorrect expectation that SKIP LOCKED raises an error. Read-only inspection confirmed beta uses postgres ownership; fixture now models that fact. Failure callback must be observed before rollback assertion. Final affected-only replay:3PASS, lint/all-test types PASS. First npx CLI package failure and all test-development failures retained privately. Used installed vendor CLI2.115.0 for pgTAP via scoped private PATH shim; no dependency/production change. Disposable containers removed. Proof:`t014-mail-native-proof.json`. Native contention checkpoint is complete; stalled capture deadline, live CLI/JWT and complete notice/report acceptance remain open.

### T014 asynchronous recording timeout — 2026-10-23

Reproduced indefinite callback wait (RED after6500ms), then added5second per-record/30second recording-phase deadlines in NEXT. Timeout returns explicit captureUnconfirmed and prevents later callbacks/DB finishes before rollback. Late immutable artifact is safely verified on retry. Final98related tests/6files and4native PostgreSQL tests/1filePASS; native run uses fresh full361 schema clone, no source rows/passwords. Format/lint/isolation guard/scripts types/all-test typesPASS after correcting result shape and test-only callback annotations; failures retained. Proof:`t014-mail-deadline-proof.json`. No root code merge, live-beta restart/data/Drive mutation or production action. Next unresolved boundary: frozen event loop needs server-side lock timeout; uninterruptible OS IO may still retain CLI process despite released transaction. Live CLI/JWT/clock and full variants/diagnostics remain open, soT014 stays unchecked.

### T014 frozen-process DB protection — 2026-10-23

RED native reproduction blocked the entire Node event loop for17seconds. Added transaction-local PostgreSQL15second idle timeout; initial diagnostic test caught25P03 being delivered through rollback rather than an idle socket event, and both paths now preserve DATABASE_IDLE_TIMEOUT. Final5native casesPASS on fresh full361 schema clone,98related testsPASS, format/lint/source guard/scripts/all-test typesPASS. Backend disappearance and subsequent claims with attempts=1/sent_at=null prove server rollback and release, independently of JS timers. All disposable containers removed; retained beta/Drive and production unchanged. Proof:`t014-mail-process-stall-proof.json`. Remaining next boundary is CLI termination with uncancellable OS file IO, then guarded live CLI/JWT/clock and full notice/report acceptance. T014 remains open.

### T014 live CLI and seven-kind bilingual matrix — 2026-10-23

Retained beta359 accepted actual guarded NEXT mail-capture CLI without source migration/restart. One new synthetic X/W2 granted notice captured locally, skipped in DB with attempts1/sent_atnull; replay claimed0. Removed only the created UUID. Initial/final original notice digest, schema, clock absence and agent instance match. Private artifact hash and receipt retained. Added14 cases for all7kinds in both locales through actual SQL due/claim/finish and immutable redacted file/replay;112related tests and all static gatesPASS. Proof:`t014-mail-live-variants-proof.json`. No Drive or production access. Next scope audit should distinguish completed adapter work from T011/T012 overlay/JWT and T044 updater acceptance; avoid treating a baseline359 live capture as clock-overlay proof. Running-updater/report linkage, unverified OS-pending CLI termination and integrated/root merge remain open.

### T014/T044 producer and scope checkpoint — 2026-10-23

Added actual catalog companion plus authenticated updater save/stop fixture in disposable SQL. Four locale×running cases prove actual scheduled grace queue→claim→renderer→immutable file→skipped receipt, warning absent when stopped, and repeated scheduled producer dedup.113related tests/6files and all static checksPASS; no live DB/provider or production changes this checkpoint. Proof:`t014-mail-updater-proof.json`. Original adapter requirement mapping and next guarded ROOT integration dependencies are now explicit in `contracts/mail-capture-acceptance.md`; T014 stays open until ROOT integration is proven. Clock/JWT belongs toT011/T012, complete owner UI toT044, containment toT016 and full canonical/release toT048/T170. Unverified OS-level CLI termination remains a stated limit, not a claimed capability.

### T014 ROOT integration completed — 2026-10-23

Merged21owned files/deltas with preimages and freshness checks; preserved owner UI and additive analytics notes. Included actual release/doctor containment hooks. Existing local edge env alias initially failed strict containment; RED→15guard tests prove exact regular sibling alias is scanned while external/chained/ancestor links remain rejected. ROOT157related tests, lint/format/source-artifact/scripts/all-test typesPASS. Full ROOT360 disposable DB run:925pgTAP/38files and14existing nativePASS, but5new mail tests skipped because URL was not forwarded. Fixed runner env and fail-on-incomplete configuration; affected-only fresh360 replay5PASS, final static checksPASS. Root CLI live idle/read-only queue digest proofPASS; original positive synthetic capture evidence retained. No new migrations, beta restart or production actions. Proof:`t014-root-integration-proof.json`. T014 now[x],93/174closed; full036 remainsNO_GO. Known OS-pending process exit limit and adjacent clock/JWT/T016/T044/final acceptance remain explicit.

### Current ROOT verification and fifth beta restart — 2026-10-23

The post-T014 canonical `npm run verify` terminated at 12:24:22Z: 12/13 executed gates passed; formatting exceeded its 300-second deadline. The unit suite did not start (zero tests executed). All 3083 frozen Git paths and their contents remained unchanged. This is a failed current verification, not a new full PASS. Evidence: `release/acceptance-private/t170-root-after-t014/result.json` and its retained `verification-result.json`. A read-only formatting diagnostic is in progress; no timeout has been relaxed. T170 remains open.

At the owner's request, the retained beta was restarted again with current source. The fifth restart passed authenticated readiness and preservation checks: native profile inode, pairing token digest, Drive connection binding and all 359 migration records were unchanged; web returned success. Runtime instance: `98b9493c-6903-4cdf-800c-1805be370075`. Proof in the retained beta worktree: `release/acceptance/acceptance-036-fresh-20261021/drive-followup/ui-restart-fifth-20261023.json`. No reset, production action or migration360 application occurred.

Formatting diagnostic completed successfully with exit0: all matched files use Prettier style. It traversed the complete unchanged format command with debug logging and finished in approximately three minutes. No formatter configuration, code, gate scope or deadline was changed. The original timeout remains a failed run; a fresh canonical verification is required.

### T174 closed; actor void RPC fix integrated — 2026-10-23

Guarded migration360 restored retained-beta cleanup coverage. Real user RPC/upload and the scheduled worker retained our PNG while attached to a second task; after final detach the worker confirmed its trash result. SELECT-only CLI returned cleanup_referenced/confirmed_count0 and trashed/confirmed_count1. Both own QA tasks were then deleted; original files untouched. Proof: `t174-live-proof.json`, `t174-local-360-apply.json`, `t174-owned-teardown.json`. ROOT tasks now94/174closed.

This live test exposed a harness defect: successful void RPC HTTP204 was treated as malformed JSON. ROOT now accepts204 for RPC only; function envelopes and empty200 remain strict. NEXT regression:8PASS, including actual live successful begin_task_upload. No application Auth/SDK code changed.

The second canonical run finished13:03:21Z with13static gates PASS but a failed suite: two10-second database setup hooks timed out in team-restitch-storage-sql and analytics-tariff-recovery. Only2of8shard blobs were produced; no full PASS. All3083frozen inputs and paths were unchanged. Targeted diagnosis is in progress.

Four physical Chrome two-tab cases passed real Web Locks/storage with actual session-mutations source and synthetic SDK responses. This does not prove actual Auth endpoint behavior or old non-cooperating writes after getSession. The source contract now names that scope accurately; T169 stays open. Proof:`t169-two-tab-locks-proof.json`.

Targeted follow-up: the two observed database setup timeouts were reproduced in a standalone run (13PASS/1timeout). Only their setup hook budgets changed from10to30seconds; test assertions, suite deadline and format deadline are unchanged. Root rerun:22PASS/3files, including8actor tests; affected formatPASS. Proof logs:`release/acceptance-private/t170-root-after-t014-retry/affected-{rerun,fixed}.log`. A fresh full verification is still required.

### T011 real Auth/clock proof — 2026-10-23

NEXT replayed all361migrations on a fresh disposable database, then ran actual GoTrue v2.195.0 on a Docker internal network with no published Auth ports. The test signed up only its own synthetic actor. At tariff offsets−5and+5years, the valid JWT returned200; expired and forged JWTs returned403/bad_jwt. Database wall time remained real.2native testsPASS, format/lintPASS; all-test types still running at this checkpoint. Containers/networks and own actor were removed; retained beta instance98b9493c was unchanged. No live beta clock modification.

Earlier attempts failed during harness setup or on an incorrect expected HTTP status, not on observed JWT acceptance: literal GoTrue version00 metadata, Docker internal-network publication behavior, then expected401 versus actual403/bad_jwt. Those failed logs remain retained. This proves JWT isolation only; T011/T012 still require live guarded CLI, notices and UI agreement. New native test/canonical-runner integration is not yet merged into ROOT. Proof:`t011-native-auth-clock-proof.json`.

### T178 fault foundation and transactional cleanup — 2026-10-24

ROOT now has the closed seven-kind model, bounded private journal, exact schema/ACL validation, verified-local controller/CLI and response/provider-read/delivery adapter foundation. Related focused tests:89PASS/7files. A fresh disposable native PG17 proved independent-connection single claim, stale-effect fencing after clear, competing namespace-lock refusal, foreign column-grant preservation and own teardown without changing the application operation; the container/volumes were removed. A real loopback HTTP request completed on the server before its reply was suppressed. This is test-tool coverage, not real product recovery acceptance.

An integration regression exposed that the conservative fixture graph correctly blocked its actor/team references in the new journal. Cleanup now removes only validated own journal rows within the transaction that inspects the complete reference graph. Dry-run, blockers and scanner errors roll back removal; no scan exemption was added. Interrupted Auth cleanup resumes after fault/time teardown. Current local-beta read-only binding verified361migrations, cleanup coverage true, journal absent and unchanged54operations/20Auth users; no live fault was armed or fixture installed. Production, owner UI and Drive originals were untouched.

T178 remains partial: current ownership needs an existing tagged operation and cannot prove initial acceptance creation. Verified pre-acceptance intent binding, real handler/provider retry/cursor integration, native worker checkpoint/crash and browser reconnect/visible delivery remain open. `t178-fault-foundation-proof.json` records these limits. Full036 remainsNO_GO,97/182tasks closed; native Windows execution is owner-excluded rather than passed.

### Current full verification findings — 2026-10-24

A fresh frozen ROOT fast run (3116unchanged inputs) passed all13static gates and failed shard2only: the historical-finance test checked applied telemetry immediately after observing its DOM version. The unchanged12-test file passed alone; explicitly waiting for the passive effect preserved all stage/content assertions. A second frozen run (again3116unchanged inputs) passed shards1–5 with4386passed/23skipped tests, then failed shard6with976passed/2skipped and3failures: missing critical coverage entry for the new Launch defaults module, a duplicate Auth startup polling sleep, and three direct recursive temp-directory cleanup sites. Neither run is a full PASS; later shards were not executed. The failed final shard blob was removed by the suite runner before the private poller copied it; the bounded terminal failure/progress logs remain retained. Do not infer complete shard retention.

Fixed those concrete gates without changing application behavior: Auth readiness uses the existing bounded waitFor helper; the three tests use removeTemporaryDirectory; Launch defaults has a100%critical floor and3business-boundary tests. Focused V8 coverage confirms100%lines/functions/branches for that module. The first hygiene group38testsPASS; final focused group21testsPASS including actual macOS owned-child cleanup/unrelated-process preservation, Windows adapter contracts and suite gates. The historical T173 test source hash changes only for shared temp cleanup; original source-hash proof remains historical, with this current native rerun as supplemental evidence. Native Windows remains owner-excluded. A new complete current verification is still required.

### Current complete ROOT release-form verification PASS — 2026-10-24

The frozen run finished06:40:14Z with exit0: verify:release22/22gates;7265passed tests,41explicit skips;81.37%line coverage. Builds,release/team/environment contracts,isolated database,a11y and CSP allpassed. All3117source paths/bytes stayed unchanged;8/8shard blobs retained. The progress log matches all836reported modules with exactly oneCOLLECT/START/END and no anomaly. A separate completed-log transition test passed415records/68distinct edges; its105other tests were intentionally unselected, not new acceptance skips. Proof:`t170-current-release-verification-proof.json`.

T170 is closed;98/182tasks closed,84open. The current dirty candidate has no packaged-beta,hosted,capacity or restore-drill acceptance and full036 remainsNO_GO. Test-only status documentation was updated after the frozen run. Native Windows remains owner-excluded; current actual macOS process cleanup is revalidated in `t173-current-release-supplement.json`. Original Drive data and the connected beta were preserved; disposable test DB/Auth resources were removed.
