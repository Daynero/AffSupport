# Contract: tooling приймальної кампанії

Наведені команди — **запропоновані**, поки що їх немає. Майбутній entrypoint: `node scripts/acceptance/cli.mjs <command>`. Реалізація не повинна підміняти `npm run analytics`, beta guards чи release runner.

## Команди та повноваження

| Command       | Ввід                                             | Ефект                                                                                              |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| preflight     | target manifest, candidate, fixture version      | Read-only identity/capability checks; всі проблеми в одному звіті                                  |
| fixture apply | local manifest, named fixture                    | Запис лише allowlisted локальних test fixtures; auth provisioning відокремлено від тестового actor |
| fixture clock | local manifest, ISO instant                      | Local tariff-domain overlay; не змінює OS/JWT/leases                                               |
| fixture fault | local manifest, named fault, duration            | Локальна scoped fault injection з TTL та teardown                                                  |
| fixture clear | campaign ID                                      | Видаляє overlay/fault, чистить лише campaign-owned fixture; не whole database reset                |
| load          | explicit test target, profile ID, seed, duration | Реальні actor actions + subscriptions, bounded offered load, stop policy                           |
| record        | case ID, variant, result, evidence refs          | Append-only локальний execution record                                                             |
| report        | campaign ID                                      | Валідований JSON і markdown, totals, stale evidence, go/no-go inputs                               |

Вихід: schemaVersion, command, campaignId, targetFingerprint, ok, data або stable error. Невалідний manifest/target/secret redaction має nonzero exit. Підсумок load містить completed/aborted/blocked; 0 exit не означає PASS кейсів автоматично.

## Target identity та guards

Manifest містить target kind local/hosted-acceptance, точні auth/functions/DB/management IDs, синтетичний marker, ephemeral fixture namespace. Secret values підтягуються окремо й не друкуються.

Local writer вимагає loopback + beta identity + marker; відхиляє malformed/remote DSN до першого запису. Hosted load runner вимагає окремого acceptance manifest, узгодженості всіх project IDs та заборони відомого production ID. Тестові identity/provisioning не переносити у canonical beta config. Hosted provisioning/reset — окремий test-only workflow, default deny; не розширювати `beta:reset`.

Analytics SQL target та management target перевіряються незалежно. Наявний `database-health --management` використовує active deployment binding; потрібен явний acceptance override з read-only verification, перш ніж читати hosted metrics. Не використовувати мовчки production binding. Непідтверджена ціль блокує дію.

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

Report валідатор знає manifest усіх 174 ID + необхідні variants. PASS без evidence/target/candidate відхиляється; N/A без exclusion відхиляється. Native Safari, synthetic client і automated unit tests мають різні testKind. Repeated attempts не переписують FAIL історію. Невідомі метрики — null з reason, не 0.

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
