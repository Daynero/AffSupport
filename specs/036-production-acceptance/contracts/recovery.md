# Contract: автоматичне відновлення після тарифної паузи

**Проєктований контракт.** Назви нових полів/routes ще не реалізовані. Чинні RPC й envelopes не замінюються; старі клієнти мають лишатися сумісними.

## Access transition та durable intent

`private.after_space_tariff_change(team, was_allowed)` лишається централізованим integration seam. Сервер під узгодженими locks повторно оцінює доступ, реєструє pause provenance/epoch та створює рівно один recovery intent при переході blocked→allowed. Клієнт не може повідомити «я був активний» або визначити epoch.

Порядок locks для всіх writer paths: team/access record → updater record → catalog/job rows у стабільному порядку ID. Реалізація повинна перевірити залежні існуючі functions/triggers на протилежний порядок і вирівняти їх, потім довести реальним двосесійним SQL тестом. Зміна інтервалу/manual stop/cancel збільшує config generation. Pause/renew/claim/finalize використовують той самий fence.

Renewal транзакційно зберігає intent; серверний bounded dispatcher повторює його до прийняття worker-ом. Помилка запуску не скасовує оплату/строк і не губиться у `catch→null`. Повтор запиту повертає той самий логічний recovery. Active→active extension не перезапускає роботу.

Expiry без admin write: gating працює за поточним часом відразу. Recovery capture не чекає 10-хвилинного pause cron: expired access interval і unfinished jobs обробляються тим самим протоколом при наступному transition/claim/sweep. Старий worker перевіряє epoch та effective access перед side effects; lease timeout у тарифній паузі не перетворюється на retry exhaustion.

Snapshot зберігається у WorkspacePause/PauseItem незалежно від майбутнього recovery (data-model §0).
Pause транзакція materialize expiry → insert snapshot → clear runnable state → commit. Renewal транзакція
materialize ще незафіксований expiry → перевірити поточний доступ → insert recovery(pause_id) → commit.
Обидва шляхи використовують той самий lock order; unique pause_epoch та recovery epoch відсікають повтори.
Тестувати crash після snapshot commit, до renewal і після intent commit: збереження попереднього стану
не залежить від пам’яті worker-а. Відновлюються режими роботи, **не попередні права**: актуальне membership,
overrides і revocation завжди мають перевагу.

## Процеси та семантика

| Тип                   | Що зберегти                                                             | Після renewal                                                                    | Що блокує                                             |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Catalog schedule      | enabled, interval, generation, restitch settings, current round receipt | Повернути той самий інтервал; одна поточна round                                 | manual disable, видалений каталог, права/Drive        |
| One-off catalog round | original operation ID, accepted state, source/config version, receipt   | Продовжити незавершену тарифно перервану round; не створювати recurring schedule | user cancel, terminal failure, неперевірний receipt   |
| Sync                  | connection, scan/checkpoint, durable progress                           | Coalesce з чинною full reconciliation; одна актуальна звірка                     | detached/needs_reauth, stale authority                |
| Preview/archive       | material/source version, pending state                                  | Наявний gated claim поновлює pending work                                        | source removed/changed, доступ                        |
| Cleanup               | resource references, retention eligibility                              | Наново перевірити references/право видалення, then bounded claim                 | будь-яке чинне посилання або невідомий результат      |
| Restitch prep         | source identity, output receipt, checkpoint, delegation                 | Scoped executor продовжує чи безпечно перезапускає тільки непідтверджений етап   | agent offline, invalid source, revoked delegation     |
| Agent operation       | operation/attempt, local checkpoint, governor state, output receipt     | Авторизований durable executor поновлює допустиму операцію                       | відсутній checkpoint, manual cancel, зміна особи/прав |

Не дублювати scheduler: sync зберігає global 3/per-connection 1, updater global 12. Черга між командами справедлива. Перший старт ≤5 хв перевіряється під LOAD-08; backlog не маскується статусом completed. Якщо поточний бюджет не дає цілі при заданому обсязі — дефект продуктивності/обмеження, не автоматичне підвищення concurrency.

## Scoped agent execution

Новий backend surface — Edge Function `team-recovery` із closed actions `delegate`, `redeem`,
`rotate`, `revoke`, `claim`, `heartbeat`, `checkpoint`, `settle`. Для custom agent credentials gateway JWT
verification цієї функції налаштовується явно; handler **завжди** перевіряє credential відповідного action
до читання/запису. Відсутність gateway JWT check не означає anonymous доступ. `delegate/revoke` перевіряють
справжній user JWT через чинний auth seam; інші actions приймають тільки описані нижче credentials з audience.

### Enrollment: конкретне підтвердження paired installation

1. Після явного дозволу користувача браузер викликає loopback enrollment endpoint агента через чинні
   origin allowlist, per-boot token, pairing та entitlement checks. Агент генерує випадковий 256-bit ticket,
   тримає його приватно з TTL 120 с і повертає тільки SHA-256 digest + installation ID + local enrollment ID.
2. `delegate` приймає user JWT, team ID, installation ID, ticket digest і allowed kinds. Сервер перевіряє
   member/process/space access і створює одноразовий EnrollmentChallenge TTL 120 с, bound до всіх цих полів.
   Відповідь браузеру містить challenge ID, не refresh credential.
3. Браузер передає challenge ID у той самий захищений local enrollment context. Агент сам звертається
   до HTTPS `redeem` із raw ticket та challenge ID. Сервер constant-time звіряє digest, TTL і binding,
   атомарно споживає challenge, повторно перевіряє actor permissions та видає refresh handle **лише агенту**.
   Отже installation ID сам по собі не є доказом; потрібен секрет, створений через дозволений pairing path.
   Це довіра до authenticated pairing, не апаратна атестація. Replay/rebinding/expired challenge відхиляються.
4. Refresh handle агент атомарно записує у Keychain/Windows credential storage. Втрата відповіді redeem
   не створює прихованого другого grant: challenge позначено consumed; повторний setup revoke-ить незавершений
   grant і проходить новий challenge. У UI стан setup incomplete, не success.

### Credentials за фазами

| Action                      | Credential                             | Binding та результат                                                                                                                                                      |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delegate/revoke             | User JWT                               | Поточні права; revoke також перевіряє власника делегації/належного admin                                                                                                  |
| redeem                      | Одноразовий raw enrollment ticket      | Digest/TTL/actor/team/installation; повертає scoped refresh handle ≤30 днів                                                                                               |
| rotate                      | Refresh handle + persisted rotation ID | Атомарна rotation; повертає новий refresh та **ClaimCredential** ≤5 хв, audience=claim, team/installation/kinds/version, без operation/lease                              |
| claim                       | ClaimCredential                        | Сервер обирає дозволену роботу й lease; повертає **OperationCredential** ≤5 хв, audience=execute, operation/lease/access epoch/config generation + вузькі resource grants |
| heartbeat/checkpoint/settle | OperationCredential                    | Перевірка всіх fences і поточних прав; heartbeat оновлює operation credential тільки для цього lease                                                                      |

ClaimCredential не приймається для settle/upload; OperationCredential не приймається для нового claim.
Зміна actor/team/installation або audience відхиляється. Сервер зберігає hashes opaque handles; raw credentials
не йдуть у лог/браузер. Повтор `rotate` з тим самим old handle + rotation ID протягом 60 с повертає ту саму
зашифровано збережену відповідь; інший rotation ID зі спожитим handle відхиляється й анулює сімейство.
Після 60 с lost-response rotation потребує setup, а не необмеженого grace. Агент зберігає rotation ID до send.
Прострочена делегація дає needs_agent_setup; renewal не повертає revoked credentials чи права.

Browser-led preparer переходить на ті самі durable claims; два executors не можуть виконувати один lease.
Журнал/checkpoint записується атомарно до ack. Важка робота й pause/cancel проходять через PowerGovernor;
manual/user holds не знімаються через поновлення тарифу.

### Числові budgets фонового агента (приймальні цілі)

- Один outstanding claim на delegation; до 25 с long-poll + мінімум 5 с після порожньої відповіді.
  Якщо transport не підтримує long-poll — один claim раз на 30 с з jitter ±10%; token bucket обмежує
  стабільний idle до 2 claims/хв на delegation і 12/хв на installation сумарно, без накопичення burst credit.
  Після позитивного claim наступна робота лише в межах чинного server concurrency budget.
- Під тарифною паузою claims припиняються; read-only access probe не частіше 1/60 с на delegation
  і 6/хв на installation. Agent offline не створює server retries. Після confirmed доступу/залежності
  wake-up один раз, без browser polling. Fair queue враховує кількість делегацій у load profile.
- Lease 120 с, heartbeat раз на 30 с активної операції; claim/rotation/status timeout 10 с,
  long-poll transport timeout 30 с. Не застосовувати tariff clock до leases. Deadlines важкої локальної
  роботи масштабуються governor; мережеві auth/heartbeat deadlines залишаються реальними.
- Transient RPC/registration/claim failure: до 5 повторів після первинної спроби, затримки 2/4/8/16/30 с
  з jitter ±20%, загальний retry episode ≤10 хв. Поважати більший Retry-After; якщо він виходить за бюджет —
  waiting_dependency до вказаного часу, без активного retry. 401/403/revoked/invalid input не повторювати.
- Після exhausted episode item=blocked/retry_exhausted, telemetry має attempt/next_probe/reason.
  Відновлення можливе після явного retry або підтвердженого переходу dependency unhealthy→healthy через
  read-only probe ≤1/60 с; максимум 3 автоматичні episodes/год на item, далі потрібна дія людини.
  Ручний cancel/disable ніколи не скидається probe-ом. У 5-хвилинний first-start SLO входить discovery/probe
  час після фактичного повернення доступних залежностей; незадоволений SLO записується FAIL, не виключається.
- Rotation не частіше раз на 4 хв за валідного credential; heartbeat може продовжувати тільки власний lease.
  Client timeouts, lost responses і server retries використовують ті самі idempotency IDs/receipts.
  Snapshot/diagnostics пишуться на зміну стану, не на кожен idle probe.

Ці budgets — частина typed/shared constants і таблиці resource forecast; тести fake-clock перевіряють
всі межі, LOAD вимірює реальну суму claims/rotation/probes/heartbeat. Пороги не підвищуються мовчки,
щоб приховати перевантаження.

Compatibility: старий веб може викликати `resume_team_catalog_updater`; RPC стає ідемпотентним входом до тієї самої recovery, без blanket re-enable ручних disable. Старий агент без background capability → explicit upgrade/setup, ніколи не прихований fallback до небезпечних credentials. Нову capability/protocol requirement оформити через наявний release contract і підписаний manifest; потребу нового agent release не обходити web-only deploy.

## UI projection

Доповнити поточний space access DTO необов’язковим `recovery`:

```text
id, epoch, state, registeredAt, lastProgressAt,
counts { pending, running, waiting, resumed, completed, skipped, blocked },
reasons[] { code, count, action }, canManageRecovery
```

Деталі ресурсів доступні лише за правами; Soty admin може діагностувати через штатний admin path, не через широке клієнтське читання private tables. Обмежений список details має pagination. Realtime invalidates projection, UI rereads authoritative state; існуючий foreground/reconnect catch-up без нового interval.

Копія UI: «Відновлюємо роботу», «Автооновлення відновлено», «Частину роботи ще не відновлено». Completed toast лише після доведеного стану. Дії для agent offline / reconnect Drive / unavailable checkpoint конкретні; технічні epoch/lease не показуються звичайній людині.

## Reasons, diagnosis та delivery

Закритий словник семантичних причин: waiting_agent, waiting_drive, needs_agent_setup, permission_revoked, manually_disabled, user_cancelled, source_changed, source_missing, checkpoint_unavailable, queue_registration_failed, retry_exhausted, superseded, unknown. Перед реалізацією зіставити з існуючими codes, нові додати у shared closed failure list та code-map; не дублювати той самий сенс під новою назвою.

`investigate`/`inspect`/`sync` читають recovery→items→attempt→terminal і delivery. `audit` перевіряє registered без start, start без terminal, terminal без delivery, пропущені етапи. Діагноз розрізняє факт і гіпотезу. Snapshot polling агентом та UI не є proof of output delivery; потрібне отримання результату цільовим користувачем. Для server-only background work «delivered» означає підтверджено доступний актуальний результат плюс подальше UI observation, яке може залишатися unknown до відкриття.

Обов’язкові regression IDs: LIFE-013/014/020–036, ACL-010/014/015, SYNC-017–022, LAUNCH-007–010 (якщо в scope), OBS-001–003/008. Перевірити repeated renewal, pause/renew/stop races, kill/restart at every durable boundary, no-browser operation, expired delegation, чужа installation/tenant, delayed/replayed receipts, dependency recovery, 50-user burst.
