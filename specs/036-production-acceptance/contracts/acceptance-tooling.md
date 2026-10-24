> Current T175/T176 contract (2026-10-23): native Windows execution is owner-excluded by acceptance-policy.json, with its actual historical status preserved. Reports now require hash-bound variant policy from required-variants.json; original totals/history remain visible, requiredTotals and executed_pass reflect complete required variants, recorded_pass is raw execution history. Legacy unbound manifests cannot close current acceptance. New campaign manifests must record variantPolicySha256. Adoption, managed faults, full load/hosted execution and final package remain open.

# Contract: tooling приймальної кампанії

Статус 2026-10-23: реалізовано `validate-target <target.json>`, `preflight <target.json>` (local fixture readiness), `fixture apply <target.json>`, optional `fixture variants <target.json>`, conservative `fixture clear <target.json> [--dry-run]`, `smoke <target.json>`, `login-page <target.json>`, `record <campaign-dir> <manifest.json> <record.json>` та `report <campaign-dir> <manifest.json>`. DEV/local-beta typed capture, `diagnose`, `media`, `tariff-smoke` та API-only `calibrate` та bounded `calibrate-realtime <target.json> [steady|burst]` також реалізовано. Clock/fault/full load/hosted/adoption залишаються **запропонованими**. Невідомі команди й flags повертають ACCEPTANCE_USAGE/nonzero. Entrypoint: `node scripts/acceptance/cli.mjs <command>`. Реалізація не повинна підміняти `npm run analytics`, beta guards чи release runner.

## Команди та повноваження

| Command       | Ввід                                             | Ефект                                                                                              |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| preflight     | target manifest, candidate, fixture version      | Read-only identity/capability checks; всі проблеми в одному звіті                                  |
| fixture apply | local manifest, named fixture                    | Запис лише allowlisted локальних test fixtures; auth provisioning відокремлено від тестового actor |
| fixture clock | local manifest, ISO instant                      | Local tariff-domain overlay; не змінює OS/JWT/leases                                               |
| fixture fault | local manifest, named fault, duration            | Локальна scoped fault injection з TTL та teardown                                                  |
| fixture clear | local target manifest [--dry-run]                | Видаляє overlay/fault, чистить лише campaign-owned fixture; не whole database reset                |
| load          | explicit test target, profile ID, seed, duration | Реальні actor actions + subscriptions, bounded offered load, stop policy                           |
| record        | case ID, variant, result, evidence refs          | Append-only локальний execution record                                                             |
| report        | campaign ID                                      | Валідований JSON і markdown, totals, stale evidence, go/no-go inputs                               |

Вихід: schemaVersion, command, campaignId, targetFingerprint, ok, data або stable error. Невалідний manifest/target/secret redaction має nonzero exit. Підсумок load містить completed/aborted/blocked; 0 exit не означає PASS кейсів автоматично.

## Target identity та guards

Manifest містить target kind local/hosted-acceptance, точні auth/functions/DB/management IDs, синтетичний marker, ephemeral fixture namespace. Secret values підтягуються окремо й не друкуються.

Local writer вимагає loopback + beta identity + marker; відхиляє malformed/remote DSN до першого запису. Hosted load runner вимагає окремого acceptance manifest, узгодженості всіх project IDs та заборони відомого production ID. Тестові identity/provisioning не переносити у canonical beta config. Hosted provisioning/reset — окремий test-only workflow, default deny; не розширювати `beta:reset`.

Analytics SQL target та management target перевіряються незалежно. Наявний `database-health --management` використовує active deployment binding; потрібен явний acceptance override з read-only verification, перш ніж читати hosted metrics. Не використовувати мовчки production binding. Непідтверджена ціль блокує дію.

Локальне спостереження: `node scripts/acceptance/cli.mjs resources <private-target.json>` повертає два bounded SQL-знімки через окремий SELECT-only reader після actual Auth/DB fixture readiness. Непрозорий handle має TTL, ліміт і мінімальний інтервал; повторна перевірка відхиляє зміну ролі, instance або target fingerprint. JSON report не надає права доступу. Лічильники зберігають точні uint64-значення; reset/missing/invalid лишаються unknown, не нулем. Метрики охоплюють усю локальну БД, включно із самим sampler; це не навантаження30/50користувачів. Management, deployed-function identity і hosted capacity лишаються непідтвердженими; команда не приймає hosted/production target та не використовує activeBinding. Повний T180 і підключення прогнозу ще відкриті.

## Clock, fault, email та diagnostics capture

Clock overlay поза production migration chain; однаковий effective tariff instant для gateways, state projections, scheduler notices і UI. Позначка в campaign manifest і proof teardown обов’язкові; фінальний packaged smoke без overlay. Сценарії lease/network використовують реальні bounded timers.

Named faults allowlist: lost_acceptance_response, lost_status_response, drive_429, expired_cursor, worker_crash_after_checkpoint, delayed_delivery, missing_signal. Запис fault ID, scope, start/expiry, teardown. Немає довільного виконання SQL/code через command payload.

Mail capture використовує чинний renderer/claim/dedup pipeline, записує redacted HTML/text локально для синтетичного recipient; не виставляє provider delivery=sent. Відрізняє rendered/captured від delivered. Production send behavior не змінено. Відсутність capture адаптера робить email case BLOCKED.

Beta diagnostic adapter не вмикає звичайну production analytics. Він loopback-only, передає typed synthetic events через ті самі guards/ingestion до test DB, з якої читає штатний CLI. Тести доводять, що remote sink відхилено, реальні secrets/content не потрапляють у payload, пропуск сигналу видимий audit. Hosted campaign використовує окреме test ingestion налаштування, scoped тільки на цей test project.

## Load contract

Profiles та обсяги беруться з capacity-plan.md. Не виконувати load до preflight та мінімального SET/ACL smoke. Усі actor actions використовують їхні справжні JWT/roles; privilege key тільки для окремого provisioning, не для workload. Ін’єкція даних напряму в DB не є тестом користувацької дії.

Генератор задає offered arrival rate, записує scheduled/start/end, rejected/dropped work і achieved rate. Обмеження concurrency не приховує перевантаження, dropped work не зникає зі знаменника. Timeout/missing delivery враховуються як невдалі/незавершені дії. Warmup позначено окремо; p50/p95/p99 та sample counts доступні для action і cross-client delivery. Найменше 100 delivery samples на профіль для SC-002.

Кожен клієнт має Realtime lifecycle і catch-up; усі отримувачі перевіряють authorized content/version. Correlation IDs дозволяють розрізнити одноразовий intent і retries. Sockets/channels і fan-out вимірюються фактично. Після stop generator скасовує власні timers/subscriptions, не вбиває сторонні agents/servers.

Stop conditions із capacity-plan (85% ресурсу, >1% unexpected errors за 5 хв, leak/data loss/storm) записують reason/evidence; прогін не рахується успішним лише через коректне завершення процесу. Відновлення перевіряється до ≤10 хв або фіксується FAIL.

## Evidence completeness

Повний report має перевіряти manifest усіх174 ID і required variants. Реалізований development report перевіряє case IDs/records/evidence; required-variant closure ще pending, тому verdict завжди NO_GO. PASS без evidence/target/candidate відхиляється; N/A без exclusion відхиляється. Native Safari, synthetic client і automated unit tests мають різні testKind. Repeated attempts не переписують FAIL історію. Невідомі метрики — null з reason, не 0.

Артефакти лежать у `release/acceptance/<campaign-id>/`, поза git; перед записом перевірити .gitignore. Стандартні `verification-result.json` та `release/beta/verification.json` лише посилаються/копіюються з checksum, ніколи не генеруються acceptance harness як заміна canonical tools.

## Hosted runtime bootstrap — обов’язкова передумова LOAD

`hosted prepare` (запропонована команда) працює лише з explicit acceptance target; `hosted verify`
повторно доводить identity без запису та перевіряє свіжість smoke evidence, створеного prepare. Це окремі test-only scripts, не зміна local beta runner.

1. До першого запису перевірити explicit allowlist project ID, non-production ID, ownership test marker,
   auth/DB/functions/management identity. Порожня або неоднозначна ціль відхиляється. Без доступного
   дозволеного sandbox — BLOCKED, жодної автоматичної покупки чи production fallback.
2. Побудувати immutable `runtime-manifest.json` з candidate SHA, web/shared/agent build digests,
   ordered migration hashes, function bundle digests, config fingerprint без секретів та fixture version.
   Брати migrations/functions лише з цього кандидата, не з довільного dirty робочого дерева.
3. Застосувати candidate migrations на виділений test project, розгорнути Functions і test web bundle,
   налаштувати Realtime publications/RLS та scheduler/Vault worker endpoints з test-only secrets.
   External email delivery credentials відсутні. Drive — окремий test client і synthetic folders.
4. Окремо підключити test ingestion до цього ж project: ті самі typed validation/redaction/ingestion,
   bounded capture queue; production analytics DSN і production endpoints не можуть бути fallback.
   Відправити synthetic event і довести його читання через CLI з тим самим target ID. Mail — recording
   adapter без зовнішньої доставки, навіть якщо cron запущений.
5. У prepare виконати synthetic smoke; у verify лише читати його докази й перевіряти identity. Перевірити applied migration hashes, Function/Web build identity, реальну відповідь Auth/REST/Functions,
   Realtime authorized delivery й denial outsider, scheduler claim/terminal у synthetic job,
   scoped agent handshake та diagnostic event ingestion. База без worker/cron readiness не проходить preflight.
6. Записати `runtime-readiness.json` з per-check evidence, timestamps, SHA та digests. Load runner
   вимагає all-required-ready, незмінні hashes і перевірку ≤15 хв перед стартом; після зміни deployment
   або config попередня readiness недійсна. На завершенні повторно перевірити identity.
7. Teardown лише campaign-owned test workers/fixtures/secrets/endpoints; ніколи не whole-account delete.
   Restore/reset допускається тільки для визначеного disposable test project за його workflow.

Acceptance може використовувати test-only delivery/ingestion adapters, але product queries, permission checks,
recovery/claim логіка та schema мають відповідати candidate hashes. Test adapters і накладні витрати зазначити
окремо. LOAD-08/10 faults керуються лише scoped test harness з TTL; local clock overlay на hosted не ставиться:
для tariff transitions використовуються test-admin зміни дат/відкликання, для faults — дозволені test workers.

## Перенесення доказів між кандидатами

`report` за замовчуванням відхиляє foreign/stale SHA. Виняток — валідний EvidenceAdoption за data-model §5a:
reviewed dependency closure, однакові source/target dependency hashes, environment/schema/fixture fingerprint,
immutable source PASS і hash кожного artifact. Неповний або transitive adoption відхиляється.

На кінцевому SHA заново виконуються всі P0, TARIFF/LIFE/ACL security/recovery варіанти, LOAD/performance,
backup, Windows credentials/recovery і exact-SHA packaged verification. Незалежний P1, наприклад незмінений
пошук з тим самим shared/transport/schema/fixture, можна перенести лише після явного review й validator PASS.
Зміна очікувань тесту або test driver інвалідує доказ навіть за незмінного продуктового коду.
`executed_pass` і `adopted_pass` відображаються окремо, original run не перейменовується під target SHA.

## Вимірювання браузерного результату під навантаженням

Protocol clients створюють основне навантаження, але не дають SC-003 UI verdict. Одночасно працюють native
Safari A/B та Chrome C; їхні сесії включені в загальні 30/50, а не приховані додаткові користувачі.
Точний набір браузерних workload probes запускається для LOAD-02/03/04/06/07; відкриття списку й пошук
вимірюються окремо в кожному браузері й у foreground.

- `action_start`: monotonic performance timestamp реального click/keyboard submit/navigation intent,
  до debouncing/request. Warmup: перші 10 виконань кожної дії окремо, вони збережені, але не в warmed p95.
- `result_visible`: потрібний scope/query/revision committed у DOM, loading overlay відсутній, expected
  synthetic result IDs/empty state перевірено; timestamp після наступного animation frame, у якому
  цей стан відображається. Stale cache/попередній query не завершує вимір. Запис не містить тексту файлів.
- UI latency = result_visible − action_start на одному браузерному monotonic clock. HTTP latency — окрема
  метрика; clock offset між машинами не використовується для цієї різниці.
- Не менше 100 **виміряних спроб**, після warmup, на action/browser/profile. Timeout 15 с або неправильний
  результат = failure/censored sample, не видаляти зі знаменника; report показує success rate і censored
  count разом із p95, за >5% censored не можна довести p95 ≤2 с. Background/sleep latency звітується окремо.
- Cross-user delivery вимірюється від підтвердженого commit до видимого відповідного revision у іншому
  клієнті; використати один collector monotonic clock для обох receipt-ів або clock-sync з виміряною похибкою,
  збереженою у звіті. Error bound >100 мс → latency proof unavailable, не точний p95.
- Реалізувати test-only browser probe hooks/collector; ввімкнення лише verified acceptance config.
  Native Safari proof не заміняти WebKit emulator. Зібрати OS/browser versions і generator CPU/RAM;
  відсутній native browser probe дає BLOCKED SC-003, навіть коли protocol latency добра.

Нові command entries: `hosted prepare`, `hosted verify`, `adopt-evidence`, `browser-probe`; schema/target guards ті самі. `adopt-evidence` пише лише локальний review record, не змінює source execution.

## Atomic record storage

Нормативний журнал виконань зберігається як `runs/<runId>.json`: immutable files, exclusive atomic link publication, checksum validation до publication. Це замінює первинний JSONL writer, щоб crash не лишав torn tail, а concurrent duplicate runId відхилявся атомарно. JSONL case files у задачах — майбутні derived exports, не друге джерело істини. `record` не стверджує live target readiness. Local preflight, baseline/optional variants та conservative empty-fixture clear реалізовано; final candidate identity, full campaign adoption і populated/provider-aware cleanup залишаються відкритими.

`record` і `report` звіряють переданий manifest зі збереженим campaign `manifest.json`. Перед першою публікацією нового run writer створює immutable `manifest.frozen.json` (canonical JSON + LF), після чого записує його actual SHA-256 у run `manifestSha256`. Невідповідність caller/disk/snapshot/hash, symlink/oversize або видалення snapshot відхиляються; відмова запису прибирає лише власний unpublished temp. Concurrent first writers можуть закріпити один ідентичний snapshot, але не замінити його.

Старий development журнал читається як `manifestBinding.state=legacy_unfrozen`, без ретроактивного засвідчення; append у нього повертає `ACCEPTANCE_MANIFEST_UNFROZEN`. Потрібна нова campaign. Final без frozen snapshot відхиляється. Коди boundary: `ACCEPTANCE_MANIFEST_INVALID`, `ACCEPTANCE_MANIFEST_PATH_UNSAFE`, `ACCEPTANCE_MANIFEST_MISMATCH`, `ACCEPTANCE_MANIFEST_UNFROZEN`, `ACCEPTANCE_MANIFEST_PUBLISH_FAILED`. JSON parser input не додається до public error/cause. Adoption і final required variants залишаються окремою відкритою роботою.

## Local fixture secrets і readiness

Credentials лежать у `release/acceptance-private/<namespace>/fixtures.json` (mode 0600), поза campaign evidence. Ніколи не копіювати цей файл у звіт. Звичайні actors не отримують service-role key; bootstrap перевіряє точні loopback ports, beta profile, Supabase status target та синтетичний namespace у Auth і DB. A/B/C/X не можуть бути Soty admin; S bootstrap-адміністратор не стає учасником W1.

Preflight використовує read-only DB session і порівнює Auth/DB markers, recovery schema version, Functions availability. Він явно повертає finalCandidateReady=false: deployment digests, hosted capacity та packaged SHA цим не доведені.

`login-page` генерує git-ignored `apps/web/acceptance-login.html` без credentials: форма викликає справжній Supabase password Auth і доступна лише DEV+beta+127.0.0.1:5175. Це test driver, не новий product login. Перед final packaging прибрати generated page.

## Реалізована локальна Realtime calibration

Named steady/burst profiles мають фіксовані count110/warmup10/concurrency4/timeout15s, interval1000/200ms.
Усі writes — звичайні A/B actor gateways. Кожний receiver A/B/C після signal перечитує справжній
список і звіряє result ID/name; pre-ack delivery зберігається лише з наступною ID verification.
X/S слухають W1 без членства; будь-яка delivery чи scope mismatch зупиняє workload. Async reads
серіалізовані на receiver і coalesce invalidations. Final samples містять кожну offered action ×
receiver, з warmup, dropped, timeout/censored і notOffered окремо. Не відкидати невдалий профіль
після успіху повільнішого. Власні clients/channels закриваються у finally; сторонні runtime не чіпаються.
API/readback clock collector-monotonic; native DOM та hosted limits не доведені цим calibration.

Diagnostic reader bootstrap використовує той самий namespace try-lock, що apply/variants/clear,
і durable cleanup fence до preflight та після lock. Після planned/pending/complete cleanup reader
role не створюється повторно. Busy scope відхиляється bounded error, без очікування чужого lock.

### Локальний запис тарифних листів — NEXT candidate, 2026-10-23

Команда: `node scripts/acceptance/cli.mjs mail-capture <target.json>`. Це не HTTP-параметр і не production env flag. Перед DB-записами перевіряються loopback beta target, локальний acceptance project, profile без delivery credentials, live stack identity, complete fixture, Auth namespace/email, точні W1/W2 owner/name та clock ownership. Відкрите fixture cleanup блокує запуск.

У транзакції беруться namespace/clock locks, потім bounded tariff/notice locks; максимум100 pending кандидатів. Наявність будь-якого чужого pending листа з attempts<3 (навіть з активною lease) відхиляє весь запуск до global claim RPC. Не прибирати чужі листи, щоб обійти цю відмову. Поточний production claim/finish SQL не змінюється.

Реальний worker використовує тільки trusted local capture dependency, доступну лише для beta exact `http://127.0.0.1:5175` та порожніх sender credentials. Нормальний beta HTTP endpoint і далі пропускає листи без запису; request body не активує capture. Лист проходить чинний renderer після заміни names/contact/recipient на synthetic placeholders; dates, kind, locale й updater state зберігаються. Результат — `release/acceptance-private/<namespace>/mail-<notice-id>.json` з redacted HTML/text, subject, hash та `delivered:false`. Це immutable create-only файл; тотожний повтор читає його, інший вміст дає conflict і не перезаписує.

`summary.captured` — підтверджені локальні записи, незалежні від `summary.skipped`. База отримує лише skipped, ніколи sent; `sent_at` не виставляється. Failed capture/finish відкатує DB-транзакцію, але залишає вже записані локальні артефакти для безпечного повтору. Втрачена відповідь commit повертає `ACCEPTANCE_MAIL_CAPTURE_UNCONFIRMED` і `databaseCommitted:null`; це не доказ rollback чи доставки. Інші відмови — `ACCEPTANCE_MAIL_CAPTURE_REFUSED` з bounded stage/reason, без raw SQL/provider/storage errors. Відсутній артефакт або відповідь лишається невідомим результатом, не успіхом.

97focused tests/6files, format/lint/scripts/all-test types PASS у NEXT. PGlite integration доводить реальний claim/renderer/store/finish, foreign leased refusal, retry та lost-commit distinction; native PostgreSQL contention тепер має3PASS: SKIP LOCKED не дає дубля, тарифна зміна очікує до bounded lock refusal, cleanup/clock locks відхиляють capture, failed recording відкочує claim і звільняє locks. Guarded live-beta CLI та bounded stalled-filesystem handling ще відкриті. Native proof:`t014-mail-native-proof.json`. Proof:`t014-mail-capture-proof.json`. Не вважати це production delivery acceptance.

Final refinement: owned leased notices remain `pending`; the result is `partial` with an explicit pending count, or `idle` when no work remains. Pending fixture cleanup is rechecked after acquiring the namespace lock, closing the preflight-to-transaction race. Final97tests PASS; the initial95-test checkpoint is retained separately.

### T014 asynchronous recording deadline — 2026-10-23

NEXT waits at most5seconds for one recording callback and gives the recording phase30seconds. Timeout prevents further recording callbacks and claim/finish mutations, then rolls back the transaction. Error reason is CAPTURE_TIMEOUT; `captureUnconfirmed` counts pending writes whose outcome is unknown, independently of `captured` and `delivered:false`. Filesystem promises are not assumed cancelled: a late immutable artifact may remain and is verified on retry. A returned result never acquires a late success count. Actual PostgreSQL test proves another session can mutate the tariff and claim both notices after timeout; PGlite test proves actual late file publication/replay.98related+4nativePASS; static checksPASS. This does not yet prove server-side release during a frozen Node event loop or CLI exit while uncancellable OS IO remains pending. Proof:`t014-mail-deadline-proof.json`.

### T014 server-side idle termination — 2026-10-23

The capture transaction now sets LOCAL idle_in_transaction_session_timeout=15s, alongside10s statement and2s lock timeouts. The DB guard works even while the Node event loop cannot run: a native17second synchronous freeze proves PostgreSQL backend termination, rolled-back claims, released locks and retry attempts=1/sent_at=null.25P03 arriving through either connection error or rollback query is reported as DATABASE_IDLE_TIMEOUT. The CLI owns a connection error handler until final close; the core operation removes its listener on completion.98related/5native tests plus all static gatesPASS in NEXT. This closes the previous frozen-event-loop lock-release gap, but not CLI exit while uncancellable OS file IO remains pending. Live CLI/JWT/overlay and full variants/report coverage remain open. Proof:`t014-mail-process-stall-proof.json`.

### T014 live baseline and full kind/locale matrix — 2026-10-23

Actual NEXT CLI ran from retained beta cwd through unmodified target/profile/stack/fixture guards on schema359 with no tariff overlay. Initial idle→one new synthetic X/W2 granted notice→captured1/skipped1/sent0→replay idle→delete only owned UUID succeeded. Private redacted artifact and receipt retained; original notice digest, schema, absent clock and agent instance unchanged. No restart or Drive call. Installed vendor CLI2.115.0 was selected via private npx shim after cache eviction; checks were not bypassed.14 PGlite integration cases prove7kinds×uk/en: actual due predicate, claim, localized render, immutable file, skipped receipt and duplicate-free replay.112related/6files plus static gatesPASS. Producer scheduling, active-updater behavior, live overlay/JWT and acceptance-report integration are separate from this proof. Proof:`t014-mail-live-variants-proof.json`.
