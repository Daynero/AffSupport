# Знахідки: тарифи на простір

## Прохід на локальній беті, 2026-10-11 01:40 (Kyiv)

Міграції `20261127100000`…`20261130120000` застосовано на беті через psql (`migration up` заблоковано чужою версією),
спільний пакет перезібрано, веб — Vite беті `127.0.0.1:5175`. Браузер — окремий Playwright (розширення Chrome не
підключене); акаунти `lead-owner@beta.test`, `lead-member@beta.test`, адмін `beta@soty.local`.

| Сценарій                                  | Результат                                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Вітрина для людини без тарифу (`/team`)   | сторінка, 5 рядків, дві картки тарифів без цін, «Написати адміністратору»                                                                                                                      |
| Попап контакту без налаштованого контакту | лише «Скопіювати повідомлення» з готовим текстом; адмінка попереджає про відсутній контакт                                                                                                     |
| Адмінка → «Тарифи», діалог видачі         | вкладки, підсумок, фільтри з лічильниками, діалог: пошта, Соло/Лід, 1 міс/3 міс/дата, місця, нотатка, оплата, лист                                                                             |
| Видача на пошту з акаунтом без простору   | стан «Чекає входу»; власник бачить майстер створення; `create_team` прив'язав тариф                                                                                                            |
| Простір власника + учасник                | «Місць: 2 з 3» біля запрошення                                                                                                                                                                 |
| `ends_on` = завтра                        | банер «Тариф закінчується завтра, 12 жовтня.» з «Продовжити»                                                                                                                                   |
| `ends_on` = вчора                         | банер «Тариф закінчився. Простір працюватиме до 13 жовтня.»                                                                                                                                    |
| `ends_on` = 5 днів тому                   | власник: «Простір призупинено…» з «Написати адміністратору»; учасник: «Простір «Lead Space» призупинено… власник — lead-owner» з «Нагадати власнику»; адмінка: «Призупинено», «+1 міс → 11.11» |
| Продовження                               | банер зник, простір відкрився на тій самій адресі                                                                                                                                              |

Знайдено й виправлено під час проходу:

- `isPinnedReleaseArtifact` не експортувався зі спільного пакета — продакшн-збірка вебу впала б (виправлено в `types.ts`).
- Заголовок адмінки «Аналітика Soty» над вкладкою «Тарифи» → «Адмінка Soty».

Не перевірено кліками: «Видати» через саму форму (заповнення поля пошти з Playwright не вдалося з селектором; видача
пройшла через той самий RPC), листи (на беті позначаються `skipped`), відновлення оновлювача каталогів (на беті немає
підключеного Диска й каталогів).

## Перепланування й інкремент recurring recovery — 2026-10-20

База роботи `beta@154210f6`; зміни ще не є релізом. Plan/research/data-model/contracts/quickstart/tasks
актуалізовано; analysis/remediation у `analysis.md`. T030–T032 реалізовані.

- Спочатку нові регресії підтвердили відсутність automatic restore й capture expiry до cron.
- Додаткова міграція `20261205100000_tariff_catalog_recovery.sql`: capture до зміни закритого тарифу,
  lock/recheck у sweep, transactional recurring restore, idempotent legacy RPC.
- Профілі/версії/civil schedules не змінюються. Один актуальний catch-up через чинну чергу.
- Тарифна пауза більше не стає хибною зміною користувацького interval у журналі 041.
- Targeted: **104/104 PASS**, 5 suites: space-tariffs SQL/contract, tariff-notices,
  catalog-settings journal SQL, analytics coverage registry.
- Справжній PostgreSQL 17 у локальному `supabase_db_wishly`: повний migration chain у disposable БД,
  **2/2 PASS** двосесійні тести `tariff-catalog-recovery-postgres.test.ts` (sweep↔renew, stop↔renew).
  Існуюча beta БД/ролі не змінювались; тестова БД видалена teardown.
- Початковий real-PG test setup виправлено: файли міграцій мають виконуватись атомарно (тимчасові таблиці
  ON COMMIT DROP), fixture каталогу — через справжній companion registration, а не неповний INSERT.
- Перший загальний verify пройшов lint/typechecks/design gates, зупинився на форматуванні нового тесту
  й раніше неформатованого фрагмента `tests/team-routes.test.ts`; обидва відформатовано без зміни логіки.

Повна US6.6 **не завершена**: durable one-off snapshot/epoch/receipts, scoped agent delegation/executor,
повний recovery UI/CLI та LIFE/LOAD/exact-SHA packaged evidence — T033–T038. Відновлений interval
не є proof старту/terminal/delivery. Поточні зміни не називаються production-ready.

### Підсумок перевірок інкремента, 2026-10-20 20:40 Kyiv

- Повторний `npm run verify`: **13/14 gates PASS**, suite FAIL. У shard 1/8 — 756 PASS,
  1 FAIL: `team-ux-navigation.test.tsx` / `renders the content tabs and marks the active one`,
  timeout 5000ms. Інші shards не виконані; увесь набір не називається green.
- Окремий повтор без зміни навігації/таймаутів: `team-ux-navigation.test.tsx` **12/12 PASS**
  (перший тест 2059ms), `space-tariffs-sql.test.ts` **41/41 PASS**; разом **53/53 PASS**.
  Збій у повному прогоні не відтворився окремо; причина загального таймауту не доведена.
- Canonical результат залишається чесним `verification-result.json: ok=false, error=suite`;
  повтор окремих тестів не перезаписує його й не замінює повного verify.
- `git diff --check` PASS. Docker PostgreSQL перевірка підтвердила відсутність залишених
  `soty_tariff_test_*` БД після teardown.
- T037 завершена як фіксація перевірок першого інкремента. Повні T029/T038 і US6.6 відкриті.

### Наступний інкремент, 2026-10-20

Реалізовані durable pause/recovery items, початковий one-off receipt, server dispatcher,
scoped enrollment/rotation/claim/execute та native journal/Keychain/DPAPI, truthful UI і
read-only investigate/inspect/sync/audit. Міграції: `20261205110000`, `20261206100000`, `20261206110000`.
Браузерний preparer поступається явній native делегації, невідомий результат після restart не replay.

Перевірено локально: SQL 47/47, delegation 9/9, Edge handler 6/6, worker 9/9, journal 2/2,
recovery UI 6/6, browser ownership + legacy preparer 7/7, analytics recovery 4/4,
analytics investigate 19/19, sync 5/5. PostgreSQL two-session races 2/2 повторно пройшли.
Agent/web/review project typechecks і lint пройшли після виправлень.

Виявлена відмінність справжнього Supabase Vault: `vault.delete_secret` відсутня; ротація й retention
використовують видалення рядка `vault.secrets`. Відокремлені тестові stubs цього не виявляли.
Загальна верифікація повторюється після форматування; цей запис не стверджує її успіх.
Реальні Windows credentials, Drive side effects, LIFE/LOAD/exact-SHA packaged beta ще не перевірені.

macOS native proof: synthetic Keychain write/read/delete PASS, без секретів у stdout/arguments.
Corrupt journal quarantined; explicit setup знову доступний, невідома робота не replay (worker regression).

Повторний real PostgreSQL proof із **справжнім `supabase_vault`**, без Vault stubs: **3/3 PASS**.
Два session-race cases + encrypted rotation replay, другий rotation, cleanup expiry.
Наскрізний SQL fixture→restricted SELECT-only role→`getRecoveryEvidence` PASS; one-off lifecycle
queued/claimed/started/terminal доведений окремо від невідомої browser delivery.
`npm run build` (shared/web/agent) PASS; production не деплоївся.

Додано source fence для restitch: snapshot source ID/version, заборона claim при зміні джерела
на тій самій config generation. Regression `source_changed` PASS; новий manual configuration не
відновлює старий snapshot. Секрети/джерельний контент у recovery projection не додавались.

Додатковий real PostgreSQL lease fence/repeated renewal proof: загалом **4/4 PASS**.
Idle telemetry bounded: порожні claims не пишуть journal events, незмінний aggregate не пише
Realtime events (регресії PASS). Explicit local retry не виконує active operation повторно.

### Фінальні локальні уточнення

- Automatic episodes: persisted attempts/since/history/not-before, максимум 3/год, bounded read-only probe
  після exhaustion і повернення доступу, без reset на restart; ручний retry скидає бюджет явним наміром.
- Membership/process/profile revocation працює й при тарифній паузі. Re-add не оживляє старий handle.
- Cancel/permanent-failed restitch не replay; нова явна manual round змінює generation.
  Skipped work у UI не називається resumed.
- Real PostgreSQL повторно **4/4 PASS**. Один проміжний прогін завершив усі 4 тести, але teardown
  перевищив 10 с; БД фактично видалена (0 залишків). Cleanup тепер має bounded 25 с command / 30 с hook;
  product SLO/lease deadlines не змінювались. Повтор green.

Загальний `verify` **FAIL на performance-budgets**, попередні gates PASS; suite зупинився у shard 6/8,
884 PASS / 1 FAIL / 1 SKIPPED у цьому shard. Решта shards не виконана, повний набір не green.
Результат збережено в `evidence/verify-fast-2026-10-20.json`. Додатковий static-only прогін мав **13/13 PASS**;
це не заміна suite. Після останніх правок static-only повторюється.

Ізольована збірка source HEAD `154210f6` з окремо зібраним HEAD shared package та тими самими third-party
dependencies: existing/shared **1 019 899 B** при ceiling **1 004 788 B**. Working bundle попередньої
збірки: **1 043 797 B**. Отже, baseline уже порушує ratchet; спільне дерево додатково збільшує його.
Усі числа й config loader — `evidence/bundle-comparison-2026-10-20.json`. Ліміти не змінені.
Тимчасові worktrees та синтетичні БД очищені; чужі існуючі worktrees не чіпались.

Залишаються T024–026/T028–029/T033–034/T036/T038 proofs за mapping 036: повні lifecycle/fault/load,
Windows DPAPI та Drive output/delivery, schema generation на staged schema, clean exact-SHA packaged beta.
Глобальний bundle ratchet потребує окремого виправлення до загального green; production не змінювався.

Останній static-only повтор: **13/13 PASS** (34 с), latest shared/web/agent build PASS.
Окремий повтор performance gate на свіжому dist: **3 PASS / 1 FAIL**; existing/shared
**1 043 953 B** > **1 004 788 B** (+39 165 B gzip). Entry та largest-chunk gates PASS.
Цей відомий загальний блокер не усунутий і ліміт не підвищено. Повний verify залишається FAIL,
навіть коли `verification-result.json` останнього static-only запуску має `ok=true`.

## Convergence continuation — 2026-10-20

Live Windows acceptance: EXCLUDED_BY_OWNER (explicit instruction), never PASS. No Windows machine
is required to finish 034. Platform implementation and automated contracts remain in scope.

- T040: `20261206120000_recovery_output_fences.sql` captures the original source/version/configuration
  at operation binding. Promotion rechecks lease, workspace, process permission, original source and
  generation, and rejects canceled/failed operations. Late uploads retain retired cleanup receipts.
  Old operations without the new proof are deliberately not promoted.
- Cleanup rechecks its durable lease, workspace, connection and retained-output references immediately
  before the provider delete/trash request. Actual in-flight provider outcomes still receive receipts;
  PostgreSQL cannot atomically recall a Drive HTTP request already sent.
- Native claim → actual TeamProcessBridge → delegate → output receipt → settle regression PASS.
  Unusable preparation is discarded using the same source-version rule as the browser preparer.
- Fresh build PASS. Performance budgets **4/4 PASS**, artwork/style integrity **2/2 PASS** on the current
  shared worktree, without raising the budget. The earlier performance failure above is superseded by
  this result; the concurrent bundle optimizations remain owned by their original work.
- Real PostgreSQL + real Vault + full migration chain: **5/5 PASS**. Includes ten paid spaces, five
  members each, thirty catalogs, double renewal, exactly ten recovery cycles and global ≤12 worker
  leases. The bounded renewal fixture took 661 ms in this local run. This proves queue registration
  and bounds, not the external Drive five-minute SLO or the thirty-minute LOAD-08 soak.
- Canonical schema generator ran on the fully migrated isolated loopback database; no hosted schema
  was queried. `npm run typecheck` PASS (projects/tests/scripts).
- Local beta had pre-existing schema/journal drift in 041 (calendar view/function already present).
  No data reset was performed. Restored the analytics view/read-only grant after the migration retry,
  then applied only the five additive 034 migrations to local beta and recorded their versions.
  Existing app/user/Drive data were retained. General `db push --local` reconciliation remains a
  separate baseline issue; a fresh full-chain database succeeds.

Full verification, live broker/native evidence and exact-SHA packaged acceptance are recorded below
only once actually executed. Production remains unchanged.

## Завершення розробки — 2026-10-20

- Фінальний `npm run verify` **PASS: 14/14 gates, 6257 tests, 17 skips**, 863 с.
  Звіт: `evidence/verify-fast-final-2026-10-20.json`. Skips — explicit environment/platform opt-ins;
  real PostgreSQL 5/5 має окремий попередній evidence, а не прихований PASS у загальному прогоні.
- Final preflight/source handoff regression: **40/40 PASS** (22 SQL + 18 routes).
  Claim зберігає початкові source/version/config generation; bind перевіряє їх і фактичний
  operation source intent. Невдалий handoff скасовує невидані grants/operation, не залишає phantom run.
- Broker/Keychain enrollment, rotate/idle claim/revoke/delete: live local beta PASS.
  Native media processing + actual Drive upload + durable catalog receipt: PASS.
  Синтетичні Drive fixtures, користувачі й тимчасова read-only CLI role прибрані.
- Paid-pause fixture використовує окремого адміністратора та явно перевіряє закритий доступ і snapshot:
  owner-admin exemption не підміняє платний сценарій. Restricted read-only `analytics investigate`
  прочитав чотири recovery items, розрізнив blocked/source_changed та resumed; delivery залишив unknown.
  Це доказ часткового діагнозу, не твердження про повний успіх усіх залежностей.
- Successful upload без catalog receipt не звільняє job; повторний claim не створює другий output,
  доки перший результат не звірений. Handler/SQL regressions PASS.

За прямою вказівкою власника релізні перевірки й пакування відкладено до релізу (T044).
Новий release-run не запускався. Exact-SHA packaged acceptance і тривалий LOAD soak не виконані.
Поточний development scope завершений; production deployment не робився, комітів чужої роботи немає.

## Повторний огляд комерційних захистів — 2026-11-01

Цей розділ уточнює попередню оцінку завершеності. Виявлено незакриті проблеми, наведені нижче.
Шість сценаріїв відтворені на одноразовій PGlite з синтетичними даними:
[результати з хешами джерел](evidence/commercial-review-2026-11-01.json),
[джерело відтворення](evidence/commercial-review-2026-11-01.ts.txt).
Для повтору зберегти джерело як `.ts` у `/tmp` і запустити через `npx tsx` з кореня репозиторію;
імпорт harness вказує абсолютний шлях цього workspace. Production і Google не викликалися.
Service-функції викликались як довірений сервер; це доказ дозволеного SQL-переходу,
а не проведений віддалений exploit чи вимір фактично витраченої Google-квоти.

1. **R01 — P1: старий callback може повернути вже замінений Google-акаунт.**
   Послідовність: store credential A → глобальний адмін схвалює B → запізнілий bind A →
   confirm A. Обидва останні кроки дозволені. `service_bind_drive_credential` та confirm
   перевіряють власника й тариф, але не звіряють credential із поточною
   `commercial_google_principals`. У callback store/bind — окремі запити, тому схвалення
   може змінитися між ними. Потрібна актуальна перевірка схвалення на всіх переходах та
   узгоджені блокування з admin approval. Джерело: `20261207110000_commercial_access_guards.sql:62`.

2. **R02 — P1: старі Google-підключення не мають незмінної прив'язки до першої повторної згоди.**
   Таблиця прив'язок створюється порожньою. Для legacy credential A із Google-поштою,
   відмінною від Soty-пошти платника, видалення credential до першого reauth прибирає
   останній доказ A. Після цього store іншого principal B на Soty-пошту проходить без
   нового схвалення. Потрібно перенести наявні ідентичності до будь-якого detach/delete;
   неоднозначні старі записи позначити для явного вирішення, не скидати мовчки.
   Джерело: та сама міграція, рядки 365/389; відсутня міграція наявних credentials.

3. **R03 — P1: захист повторної видачі губиться при перезавантаженні адмінки.**
   `tariffMutationIds` — тільки Map у пам'яті. Після збереженої видачі та прив'язки простору
   reload створює новий UUID; однаковий grant із ним створює другий тариф. Це відтворено:
   два різні ID для того самого запиту. Є й зворотна проблема: однакові параметри нового
   свідомого grant у тій самій сесії повторно використовують старий UUID назавжди до reload
   або витіснення з Map. ID має зберігати конкретний незавершений намір, переживати reload
   і відрізняти його від нової покупки. Джерело: `apps/web/src/api/team.ts:5681`.

4. **R04 — P1: Google-зміна в одному тарифі від'єднує інші оплачені простори власника.**
   На двох оплачених просторах одна зміна `approvedGoogleEmail` через update першого
   перевела обидва connections у `detached`. Це actor-wide модель схвалення, тоді як форма
   відкрита для одного тарифу й текст говорить про одне попереднє підключення. Потрібно
   явно показати зачеплені простори й погоджувати саме цей обсяг, або звузити операцію.
   Джерела: міграція:955/968 та `apps/web/src/locales/uk.ts:4317`.

5. **R05 — P1: можна видати більше платних місць, ніж сервер дозволяє використати.**
   Grant на 51 місце прийнятий; при 50 членах наступне запрошення відхилене з
   `TEAM_MEMBER_LIMIT`. Адмінка дозволяє до 500 extra, але create/accept/direct-add
   зберігають межу 50 для звичайних платних просторів. Треба мати один узгоджений ліміт
   у продажу, видачі та вступі. Джерела: міграція:550/670/785 і TariffGrantDialog:371.

6. **R06 — P1, викат: міграція падає на старому перевищенні місткості.**
   На схемі до нової міграції створено тариф Team на 3 місця з 4 чинними членами
   (стан можливий через раніше відтворений legacy/Undo шлях). Застосування всієї нової
   міграції в транзакції завершилося `SEATS_IN_USE`: зміна каталогу оновлює всі тарифи,
   а вже встановлений trigger відхиляє цей старий стан. Потрібна явна перевірка й процедура
   врегулювання до DDL; не дарувати місця і не видаляти платних учасників автоматично.
   Джерело: міграція:456–461, trigger:342. Це не твердження, що такий стан є в production.

7. **R07 — P1, викат: сценарії підготовки лишились на заблокованих старих RPC.**
   `scripts/acceptance/fixtures.mjs:146`, `variants.mjs:236`, `tariff-smoke.mjs:33` та
   кілька наявних SQL suites викликають старі grant/end/extend. Окремий запуск
   `tests/recovery-retention.test.ts` завершився `WRONG_STATE` у beforeAll; усі 5 тіл
   тестів пропущені, тому це не доказ несправності самої retention-логіки. Треба оновити
   callers на нові контракти й перевірити bootstrap, не послаблювати серверний захист.

Повний verify/release, реальний Google consent та двосесійні гонки не запускалися.
Залишаються окремими перевірками на викаті фактичний режим/allowlist/квота Google,
production-призначення та вимкнення legacy. T046/T047/T049/T050 знову відкриті;
на момент цієї ітерації огляду findings ще не були виправлені. Нових продуктових рішень від власника не потрібно.

## Виправлення R01–R07 — 2026-11-01

- R01: bind/confirm/replace звіряють чинний principal під тим самим actor-lock, що й
  store/approval. Запізнілий credential відхиляється без зміни справного підключення.
- R02: міграція переносить legacy identities, неоднозначні записи позначає `needs_review`.
  Адреса видачі фіксується при grant/claim; зміна auth email не відкриває інший Google.
  Резервування переживає видалення credential і Soty-акаунта.
- R03: конкретний незавершений grant зберігає payload/UUID у localStorage, scoped адміністратором.
  Web Locks узгоджують вкладки. Після невідомої відповіді/reload форма відновлює саме цей
  запит; відмінний намір блокується до звірки. Після успіху свідома нова покупка має новий UUID.
  Без доступного локального сховища команда не відправляється. Інший браузер/очищене сховище
  потребують звірки серверної історії, автоматичної міжпристроєвої реконструкції не заявлено.
- R04: preview містить усі простори, які від'єднаються. Адмін підтверджує цей список;
  сервер звіряє його revision під actor-lock. Додане підключення після preview дає WRONG_STATE
  без часткового detach. Google approval/reassignment не пропонують неповний Undo.
- R05: create/accept/direct-add користуються єдиною проданою місткістю, приховані 50 прибрано.
  Legacy без тарифу зберігає 50; internal — без тарифної межі. Технічний максимум продажу
  узгоджено на 2000 загалом (максимальна місткість старої схеми), щоб перенесення base → extra
  не ламало граничну стару видачу. Наявні продані місця не урізаються.
- R06: компенсація старої base-місткості виконується до встановлення нового validation trigger.
  Старе перевищення лишається видимим для ручного врегулювання, нові приєднання блокуються.
  Немає автоматичного видалення учнів або безкоштовного збільшення тарифу.
- R07: acceptance fixtures/variants/smoke та чинні SQL suites переведено на UUID/revision RPC.
  Baseline W1 явно отримує потрібне додаткове місце для трьох fixture-учасників.
  Старий RPC залишається лише в навмисному відтворенні схеми до міграції та негативних тестах.

`analytics investigate` читає bounded privacy-safe журнал `commercial_access`: committed
схвалення, спостережене перевищення на міграції та operation receipts. Немає emails, principals,
payloads чи токенів. Пізніша зміна не переписує історію; відсутній журнал, зовнішня оплата,
реальна Google-квота й непідтверджена browser delivery залишаються explicit unknown.

Цільові результати зафіксовані в `evidence/commercial-fixes-2026-11-01.json`.
Production, реальний Google consent, exact-SHA packaged beta та двосесійні гонки не виконувалися;
вони залишаються T044/T051 на викат. Ці виправлення не видавали production-тарифи користувачам.
