# Quickstart — перевірка реалізації Launches

Нижче наведено повну матрицю приймання та фактичні перевірки у checkpoint.
Fixtures містять лише синтетичні URL/дані; production database не
використовується для implementation acceptance.

## Підготовка

Потрібні Node за package.json, installed workspace dependencies, локальна БД/Beta за docs/BETA.md, owner/editor/viewer двох test spaces, соц g1 і РК 1234567892, test video material та catalog/restitch defaults. Для restitch — підтриманий локальний агент; для «Інше» не потрібний. Не запускати beta:reset без наміру скинути тестові дані.

Після реалізації та створення відповідних тестів:

```bash
npm run build -w @video-compressor/shared
npx vitest run tests/launch-generators.test.ts tests/launch-url.test.ts tests/launch-state.test.ts --maxWorkers=1
npx vitest run tests/launch-ui.test.tsx tests/launch-persistence.test.ts tests/launch-catalog.test.ts --maxWorkers=1
nice -n 15 npm run verify
```

Launch tests уже створені; повна матриця приймання нижче залишається обов’язковою. Existing regressions: product-catalog-handler/parity/xlsx, task attachment/date controls, team operation cancellation. Команди heavy запускати послідовно. `npm run beta:doctor`, `npm run beta:up` — чинний шлях до інтерактивного local acceptance; packaged evidence за runbook після готової реалізації. `verify:release` лишається release gate і не запускається в поточному beta-only циклі за вказівкою власника від 15.10.

## Сценарії

1. **Other end-to-end.** Створити g1-892/video_5, ProCaps TR, patrik, N3/max30/ads3/M45, Advantage off, date2026-10-13. Exact budgets 10/20/30, names із §9 spec; один URL; нуль catalog calls. Generate коротко показує accepted/work → result, поля locked.
2. **URL invariants.** Виконати golden vectors contracts/ui-and-url.md; comparison untouched raw substrings, не лише semantic URL equality. Вставити synthetic token marker; перевірити його відсутність у diagnostics/audit/list/Realtime.
3. **Required/normalization.** Порожні required orange, populated valid очищує accent. `creative test`→`creative_test`, `Відео`/Buyer `роман` блокує Generate на web/Edge. Порожні SUB і assignee дозволені за контрактом.
4. **Defaults/copy/filter.** Save defaults, new Launch отримує їх, existing не міняється. Copy створює незалежний tomorrow/todo draft без files/results; double-click дає один copy. Calendar/Yesterday/Today у визначеному порядку, date filter до pagination.
5. **Manual outputs.** Edit кожний result field; copy current value до save; orange badge/reset/save/reopen. Catalog не змінюється від ручної правки назви/URL. Concurrent save дає conflict, не overwrite.
6. **Catalog.** N кампаній створює одну variation. Copy link дорівнює Google Drive webViewLink. Restitch off пропускає local work; on показує фактичні етапи та minutes config. Не показувати fixed 30% із старого catalog adapter як вимір.
7. **Recovery injection.** Перервати відповіді після provider create, finalize, catalog link і Launch commit. Reload/retry reconciles same logical operation; не другий варіант. Two launches same video reserve distinct variants. Child succeeded без catalog link не дає ready.
8. **Cancel.** Скасувати на підготовці, restitch, Drive create, finalize/link; previous result/draft відновлюється після settlement. Cleanup видаляє лише owned unpublished outputs; sharing rollback не знімає чужий permission. Unknown outcome показаний; late fenced executor не публікує result.
9. **Edit dependency.** Age/budget/ads → лише text revision; Buyer у невикористаному SUB не змінює catalog. Changed URL → new catalog with reused restitch; changed material/version → affected processing. Old catalog лишається.
10. **Archive.** Перевірити catalog і historical catalog коли active method=other. Warning + unchecked checkbox. Cancel не запам'ятовує preference; archive+checked приховує наступне warning тільки для того самого user/team. Catalog/video лишаються на Drive.
11. **Permissions/transport.** Viewer, cross-team IDs, blocked space, removed member, source permissions, two tabs. No URL у safe projection; no extra recurring polling; reconnect/foreground rereads authoritative state.
12. **Diagnosis.** Failure, delayed/lost terminal, result committed without rendered, canceled cleanup. `npm run analytics -- inspect <test-flow-id> --json`, `investigate <test-subject> --json`, `audit --period 7d --json` лише зі свідомо налаштованим read-only test connection. CLI називає stage/cause або insufficient, не вигадує нуль проблем. Не перемикати CLI на production для цих сценаріїв.

## Exit criteria

Для передачі власнику на beta-перевірку: AC-01–46 звірені з доступними сценаріями, targeted tests та `verify` green, source→guard→CLI coverage доведено або сліпі зони названо явно, beta runtime працює з поточним 035 worktree. Production gates та `verify:release` відкладаються до окремого циклу релізу. External tracker contract для підписаних URLs і видимість original URL у доступній за посиланням таблиці лишаються відкритими продуктовими рішеннями.

## Додаткові регресії після аналізу задач

13. **Autonomous recovery.** Прибрати з test fixtures усі scheduled updater/retired-copy jobs; лишити один due Launch recovery або cleanup, закрити UI. SQL dispatcher має викликати endpoint і settle-ити допустиму роботу. Повторний tick не створює другий output. Перевірити справедливість при backlog, missing credentials, waiting_dependency та відсутність automatic retry terminal failed stage. Test: tests/launch-recovery-dispatch.test.ts.
14. **Preview/source race.** Не змінюючи Launch version, перейменувати використаний Buyer/соц після preview. Generate → SOURCE_CHANGED, нуль side effects; explicit source refresh і нове підтвердження дають актуальний result. Accepted request replay зберігає первісний intent. Unknown Drive version не дає reuse без перевірки.
15. **Copy timezone/replay.** Source створений в іншому поясі. Copy у поточному browser timezone біля півночі/DST; retry наступного дня повертає той самий ID/date. Changed timezone на тому самому key → conflict.
16. **Browser privacy.** Synthetic URL token/ручний секрет: input→conflict→copy→reload/logout. localStorage/sessionStorage/IndexedDB/Cache API/operation journal і service-worker cache protected detail не містять значень; unsaved RAM очищується, saved detail доступний тільки через ACL.
17. **Manual mismatch.** Ручна зміна URL → catalog warning, зміна budget/range/SUB → відповідна dependent hint. Save/reopen лишає підказки; reset відповідного override прибирає. Жодного catalog update/rename.
18. **Restore history.** Відкрити стару revision→«Відновити конфігурацію», перевірити dirty save/discard/cancel, стару дату, config budgets, відсутність result overrides і незмінну metadata. Removed source блокує Generate, explicit refresh оновлює preview; viewer/active lock/conflict відмовляє. Лише explicit Generate публікує нову revision, старий каталог/результат зберігаються.

## Implementation checkpoint — 13.10.2026

| Середовище                      | Дозволена перевірка                                               | Фактичний стан                                                                                           |
| ------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Shared/browser/Edge unit tests  | Синтетичні config/URL, зібраний shared/dist                       | URL 7, generators 8, shared parity 2 — PASS                                                              |
| PGlite                          | Повна локальна migration chain, synthetic users/materials         | State/defaults/fence/recovery/dictionary parity/dispatch 11 — PASS; не замінює pgTAP/RLS role acceptance |
| Catalog adapter fault injection | Fake Drive, existing generator, lost reply/ownership/pools/replay | Durable adapter 5 + existing handler 25 — PASS; не є live Drive acceptance                               |
| Local beta Postgres             | Тільки 127.0.0.1:54322; forward migrations; без reset             | Launch міграції 110000–191000 застосовані локально forward-only; production не змінено                   |
| Local beta browser/agent        | Real local auth, два користувачі, реальні stages/reconnect/cancel | Ще НЕ ПРОЙДЕНО                                                                                           |
| Production                      | Немає дозволу на міграції/deploy/release                          | Не змінюється                                                                                            |

Рішення з research залишаються чинними: ` adv+` тільки в імені; bounds N≤100/max≤999999/ads≤1000, age — positive safe integer; exact case-sensitive raw `sub1/sub2/sub3`. Duration використовує `clampStitchEndDuration` чинного stitcher (1–3600 секунд), UI whole minutes 1–60.

Pure preview N100 вклався в тестовий поріг 50мс у `tests/launch-generators.test.ts` (увесь suite 8 tests — 22мс; це не benchmark реального пристрою). Live beta/performance/Windows/throttle acceptance ще не проведено. Стан checkbox не слід прирівнювати до готовності всього модуля.

Fenced coordinator `drive-ops/launch-catalog.ts` підключено до hosted recovery. Користувацька генерація каталогу без перезашивки приймається за готового worker після source preflight. Локальний Launch runner підключений до існуючого restitch orchestration: frozen preparation, grants тільки в RAM, bind/settle, явний retry та reuse перевіреного відео для URL-only revision. Відсутній або застарілий агент залишає прийнятий запуск у waiting_dependency із причиною; автоматичного повтору failed operation немає. Live Google/agent acceptance ще не проведено.

### Незакриті зовнішні gates

- **Signed tracking URLs:** потрібне підтвердження платформи або тест із контрольованим signed URL, що дозволена зміна тільки SUB не порушує підпис. Синтетичні lossless vectors цього не доводять. Без доказу відповідні URL мають бути блоковані або мати явну погоджену політику; автоматично вважати підтриманими не можна.
- **Google Drive visibility / CAPI:** чинний catalog tool створює link-readable Google Sheet. Потрібне явне рішення щодо можливості записувати туди рекламний URL із чутливими query values та live перевірка webViewLink/permission policy у контрольованому просторі. Ні кодування, ні redaction logs не захищають вміст публічно читаної таблиці.

Ці gates блокують production rollout, але не синтетичну локальну реалізацію. Вони не закриті припущенням чи unit test.

### Перевірка доповнень 13.10.2026

- `launch-state`, `launch-catalog`, `launch-revisions`, `launch-catalog-execution`: 20 тестів PASS. Зареєстрований child відновлюється за точним generation key перед source re-proof; stale fence відхиляється. Це не замінює автономний hosted recovery worker.
- `launch-generation-hook` + `launch-ui`: 6 тестів PASS. Мережевий повтор Cancel зберігає request key; подвійне натискання відсікається.
- Ручні ordinal/budget/range guards не допускають leading zeros, як і SQL. Buyer Zs normalization відповідає shared; tabs/control/Cyrillic відхиляються.
- Async dictionary callback не змінює форму після блокування генерацією чи unmount; clipboard completion після unmount не створює timer.
- Повний `npm run verify`: перший запуск зупинився на форматуванні, решта статичних gates до цього PASS. Форматування виправлено; фінальний результат повторної перевірки ще не зафіксовано.

### Hosted settlement і підсумок перевірок

`20261201136000_launch_settlement_dispatch.sql` додає provider-free settlement через
чинний catalog-updater scheduler. Due Launch без updater jobs запускає dispatcher;
worker може завершити відомий registered child або Other intent та скасування без
зовнішніх side effects. Batch bounded (1–10, worker використовує 3), aggregate-before-generation
locks, SKIP LOCKED, чинні ACL/fences; terminal failed/partial/waiting_dependency не перезапускаються.
Незареєстровані чи невідомі provider outputs і власні sharing grants ще потребують
ownership-aware cleanup/recovery. T037/T041 залишаються відкритими.

- Цільова перевірка 21 файлу: **190 тестів PASS**, включно з catalog handler/parity/XLSX/updater
  regressions, Launch state 11, durable adapter 8, progress 2 та cancel-hook 1.
- SQL-контракт регенеровано через штатний generator; tests team-contract та explorer navigation PASS.
- Повний `verify` пройшов static gates, але suite має падіння поза модулем Launches
  (database-health CLI, Finder, admin loading, installer/release URLs, power scope).
  Повний зелений результат не заявляється. Виявлені Launch-related regression expectations
  виправлено й повторно перевірено цільовими тестами.
- Critical inventory розширено для нового shared import graph; floors ще потребують release coverage
  перевірки, тому сам inventory check не є доказом виконання coverage thresholds.

### Restitch receipt checkpoint

Міграції 142000–147000 фіксують actor-scoped defaults/draw без transfer grants,
стабільний child process key, захист старту після cancellation і скасування bound child.
Чинний worker викликає bounded `service_settle_launch_restitch_batch` до parent settlement;
успішна child operation переводить waiting_dependency в accepted/catalog_planning,
помилка завершує цей етап без автоматичного повтору. Скасований parent не відновлюється.
Catalog executor бере лише fenced receipt своєї operation і передає її existing generator.
Catalog attach отримує справжні operation/material IDs із `team_catalog_restitch_copies`,
перевіряє їх проти preparation і зберігає checksum/Drive identity у protected snapshot.
Два клієнти можуть спостерігати child через TeamContext revision без нових Realtime channels;
пізня відповідь попереднього operation ID не перезаписує актуальний стан.

Цільова перевірка `launch-state`, `launch-catalog-execution`, `launch-operation-observation`,
`catalog-orchestration`: **24 тести PASS**. Це не live Google/agent acceptance і не
завершення T037/T041. Локальний runner підключено наступним checkpoint нижче; ця історична перевірка сама по собі не доводить live pipeline.

### Runner, revision fences та mutation replay checkpoint

Міграції 148000–160000 застосовано тільки до локальної beta БД без reset.

- Відновлення child після втраченої start/bind відповіді не запускає другу operation. Явний retry має стабільний ключ і frozen source/settings/draw.
- URL-only revision повторно використовує сертифіковане відео того самого Launch; зміна контенту або налаштувань забороняє reuse. Permission-only version change дозволена лише за доведеного незмінного checksum/Drive identity.
- Publication перевіряє baseline revision CAS; partial/interrupted залишають settings заблокованими до settlement.
- Історичні та unsettled-owned outputs захищені від ordinary orphan/retired cleanup, overwrite, recreate та trash ancestor folder. Відоме скасування до upload може settle без provider; невідомий upload outcome залишається cleanup_pending, а не удавано canceled.
- Прогрес використовує чинний UI inventory і показує лише справжні stage/counts; legacy weighted percent не приймається як вимір.
- Ручні SUB відображаються, нормалізують spaces→underscore, мають warning/badge/reset; URL/каталог не змінюються від локальної правки. Максимум joined/manual SUB — 512 ASCII символів.
- Defaults, manual revision та archive replay зберігають початкові payload/key під час невідомої відповіді. Невідомий outcome блокує edits, але дозволяє явний повтор; відома відмова знімає блокування.

Остання завершена static verification: **13/13 gates PASS**, включно з typecheck, lint, formatting і design gates. Це не повний verify або release coverage. Наступні зміни archive replay потребують повторної перевірки. T037/T041, live two-user/browser/provider/Windows acceptance та зовнішні production gates залишаються відкритими.

## Продовження локальної реалізації — 14.10.2026

Міграції 161000–177000 застосовані тільки до локальної beta БД, без reset. Додано атомарне збереження робочої конфігурації разом із ручними результатами перед відновленням історичної конфігурації; явний review наслідків нової генерації; очищення RAM при зміні користувача або втраті view-доступу. URL і ручні результати не додаються до аналітики; копіювання повідомляє тільки тип поля та outcome.

Налаштування, тексти й вибрані зображення каталогу фіксуються перед довгою перезашивкою та повторно використовуються при recovery. Зареєстрований каталог і його відео захищені від очищення навіть до фінальної прив’язки до Launch; попередження видалення враховує цей стан. Повторний вхід до раннього checkpoint не позначає пізніші або допоміжні етапи завершеними.

Конфлікт стандартних налаштувань вимагає явного читання й перегляду актуальної версії. Чернетка Launch при цьому не замінюється. Скасування до acceptance використовує приватний durable request fence; після acceptance воно делегує чинному parent/child механізму, а успіх, зафіксований першим, залишається успіхом. Втрачені відповіді повторюються з тими самими ключами.

Перевірено перед останнім cancellation-зрізом: launch-state **24/24**, copy/archive **4/4**, workspace UI **4/4**, defaults review **2/2**. Static run виявив помилку типу нового test fixture; виправлено на typed catalog config, повторна перевірка ще потрібна. Це не доказ повного verify або production готовності. Скасування після upload із невизначеним provider outcome, ownership-aware очищення перезашитого відео, повна двокористувацька/live Google/Windows прийомка й production gates залишаються відкритими.

Останній широкий Launch-прогін: **148 PASS / 1 FAIL**, 25 файлів. Єдиний fail виявив stale React view незавершеного cancellation intent після втраченої відповіді. Виправлення підтверджене наступним цільовим прогоном: generation hook **11/11** і workspace UI **4/4**. Не подавати початковий широкий прогін як повністю зелений; повний `npm run verify` запущено після виправлення. T007/T009/T010 позначені завершеними після перевірки shared guards, budgets/date/naming, pure preview і browser/Edge parity.

### Подальша перевірка 14.10.2026

- `npm run verify -- --gates=static`: **13/13 PASS** перед наступним UI/conflict/copy зрізом. Новий static прогін виконується після цього зрізу.
- PostgreSQL pgTAP: `npx supabase test db supabase/tests/database/launches.test.sql` — **16/16 PASS**: forced RLS, захищені URL, ACL RPC, service-only acceptance/cleanup, заборона worker обійти canceled request.
- Повний fast verify завершився **5343 PASS / 16 FAIL / 12 skipped**. Два пов’язані падіння виправлено: updater video query test очікував неправильний другий `?`, SQL contract seed потребував регенерації після нового коду. Targeted перевірка: team-contract **14/14**, updater IDs **9/9**, workspace UI **5/5**, copy hook **4/4** — PASS. Інші падіння — Finder, admin loading, installer/release artifact fixtures та power scope; повний verify не є зеленим.
- Новий UI тест усіх дев’яти result fields підтвердив edit→copy поточного значення→save override map→reopen→окремий reset без зміни generated baseline. Overrides UI **4/4**, mutation analytics/privacy **6/6** — PASS. Це компонентний reopening зі збереженим map, не live Drive acceptance.
- Persistence **5/5** і state **27/27** — PASS: viewer reads/mutation denial, archived workspace/read/replay denial, foreign Buyer before acceptance; source identity, immutable publication, recovery/cancel races.

`LaunchConflictReview` дає явний protected reload і keep/discard. Ручні правки не переносяться на іншу generated baseline. Copy плитки та відкритого Launch використовують `useLaunchCopy`: невідома відповідь повторює той самий key/version/timezone; після підтвердженої копії read failure повторює тільки detail read. Старий callback не перенаправляє нову сесію, а unmount припиняє protected reads/notifications. Усі такі inputs/results лишаються в RAM.

Нові `launchMutation` сигнали доводять intent та RPC acceptance/failure для save draft/overrides/defaults/copy/archive. Вони не доводять delivery/visibility; цей сигнал відокремлений. Невідома помилка лишається UNKNOWN, її текст та provider payload не збираються. Full source→guard→CLI coverage, live multi-user прийомка та ownership-aware video cleanup лишаються фінальними відкритими вимогами.

### Контракти етапів і втрата прав

Локальні forward-only міграції 173000–176000 фіксують відому помилку підготовки після acceptance, додають bounded protected step receipts та service-only обробку відкликаних прав. Unchecked preparation RPC не доступний браузеру. Повторна відома preparation failure повертає ту саму причину без нового draw; цей RPC не завершує чужий native child. Generation hook не трактує post-acceptance failure як pre-acceptance refusal.

Protected generation DTO містить до 50 step receipts без checkpoint content, явний truncation marker і closed step states. Незнайомі stages/causes стають unknown/UNKNOWN; bigint versions — канонічні додатні рядки в межах PostgreSQL bigint.

Worker окремо й обмежено записує PERMISSION_DENIED/SPACE_BLOCKED для actor authority loss. Recovery list одразу відбирає тільки доступні actors, тому valid робота не чекає завершення всієї черги відмов. Це не доказ native termination чи очищення provider outputs. Targeted state **29/29**, recovery **6/6**, step contract **3/3** — PASS; pgTAP **18/18** — PASS. Останній широкий Launch-прогін до цього зрізу: **182/182**, 28 файлів.

### Інтерфейс і локальне прев’ю — наступний зріз

Пошуковий SelectMenu використовує один ComboBox замість вкладеного пошуку й другого dropdown. Вибір креативу перевикористовує TaskAttachmentPicker із single selection і текстами Launch. Локальне прев’ю назв та SUB працює до введення URL і вибору фізичного матеріалу; це не послаблює валідацію генерації. Перше збереження нової чернетки оновлює адресу Launch без remount сесії.

Тривалість перезашивки недоступна, коли вона вимкнена; custom minutes відображаються лише після ввімкнення. Перемикання старої чернетки без catalog config на «Каталог» додає стандартний блок без зміни дати чи інших параметрів. Результат показує явне повідомлення про відмінність налаштувань від збереженої конфігурації; ручні й згенеровані значення не перезаписуються. Targeted catalog settings, overrides і workspace UI: **13/13 PASS**. Це не повна прийомка native cancellation чи live Google.

Після цього зрізу `npm run verify -- --gates=static`: **13/13 gates PASS** (typecheck проєктів, тестів і scripts, lint, format, design, i18n та інші static gates). Suite й coverage цей запуск не вимірює.

### Cancellation fencing and privacy regression — 14.10.2026

The native process bridge preserves the cloud's confirmed terminal finalize reply
when a late local cancel races its consumption. Pre-finalize cancellation still
uses the existing abort path; a lost provider reply remains uncertain. Failure
logs now carry only closed codes, including the Edge finalize path; raw provider
errors, filenames and local paths are excluded.

Migration 178000 requires both owner and expiry on parent and catalog cleanup
leases. Four null-field regression cases prove that neither provider cleanup
authorization nor settlement can proceed after a lease field disappears. Applied
only to local beta without reset. Targeted bridge, state, recovery and code-map
regressions: **64/64 PASS**. Unknown native upload outcomes and ownership-aware
video cleanup remain open; T037/T041 are not complete.

Required-field accents now distinguish a missing physical creative from a valid
creative alias. Invalid product count and active custom restitch duration are
highlighted independently and clear once valid; hidden settings are omitted.
Two-file drag-and-drop is rejected before folder creation or upload. Targeted
creative/catalog settings plus existing Tasks material picker: **25/25 PASS**.

Latest completed verification for this slice: **278/278 tests PASS**, 33 files
(all Launch tests plus native bridge, code map, transport parsers and catalog
reuse regressions). Static gates: **13/13 PASS**. Local pgTAP Launch contracts:
**18/18 PASS** after migration 178000. These runs do not measure full-project
coverage or constitute packaged beta / live Google / Windows acceptance.

### Pre-upload cancellation proof — 14.10.2026

New Launch restitch upload requests now record an explicit private phase before
and immediately before the Drive resumable-upload call. A stopped child with
`not_started`, no provider result and no material can settle cancellation;
`started` or legacy `NULL` remains cleanup_pending. Non-Launch restitch uses the
existing path. The service RPCs are service-only and require the bound Launch
operation; a late start after parent cancellation is rejected. Migrations
179000–181000 were applied only to local beta. The final upload authorization
locks the launch and generation in cancellation order. This does not resolve uploads
that may already have reached Google Drive; video ownership reconciliation and
physical cleanup remain required before catalog cancellation is complete.

New Launch restitch uploads now carry the private Drive appProperty
`soty.launch.restitch.operation` with the bound operation ID. A bounded lookup
rejects incomplete or duplicate result pages. The hosted worker obtains a
service-only cleanup lease, verifies the exact marker, parent, video type and
absence of a registered material, then rechecks the lease before trashing the
file. The local agent must first acknowledge that its upload promise has settled,
using the original finalization ticket even when cancellation revoked it. A
database `canceled` state alone is not cleanup authority. If that receipt is
lost, the operation remains pending for investigation. A confirmed trash records
a durable `cleaned` phase; the next settlement can restore the draft or previous
result. Unknown, moved, legacy and registered outputs remain cleanup_pending.
The lookup deliberately includes already-trashed files, as supported by the
[Drive files.list contract](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list),
so a lost trash reply can be reconciled without deleting twice.
Local fake-Drive and SQL tests cover this path; live Drive marker propagation
and shared-drive ownership are still unverified. Roll out the matching agent
and Edge receipt route before enabling automatic cleanup on existing
installations; older agents cannot provide this proof.
The hosted-worker due predicate now includes positively unstarted and quiesced
native cancellations without a catalog intent; a missing receipt does not
wake provider cleanup. The local SQL regression checks the due transition
before and after a valid receipt. Unknown cleanup results wait five minutes
before retry; a confirmed `cleaned` receipt wakes final cancellation settlement.

Copy/archive UI acceptance now covers unchecked retention preference, cancel
without persistence, exact-key retry after a failed archive, active-generation
locks and copy opening settings without generation. Targeted UI/SQL/copy-hook
run: **18/18 PASS**; static gates: **13/13 PASS**. A subsequent DB regression
found and fixed missing copy-generation locking in migration 188000; its
five-test copy/archive suite passes, including safe replay of a previously
committed copy while a new generation is active. Native cleanup backoff and
dispatch checks: focused **71/71 PASS**, local Launch/restitch pgTAP **49/49 PASS**.
The expanded copy/archive acceptance run is **20/20 PASS**; it verifies
historical-catalog retention, failed-archive preference rollback and per-user,
per-workspace suppression. T061 and T064 are marked complete; wider time-zone
and full acceptance matrix tasks remain open.

Implementation reconciliation marks T011–T013 (schema/RPC authority), T020–T026
(routing, RAM draft, selectors, creative adapter, SUB builder, editor and
generation controller), and T028 (localized, content-free lifecycle signals)
complete. Evidence is the local DB/RLS suite, authoritative state regressions,
selector/creative/UI/controller tests and static design/i18n gates. This does
not close T017/T029 or the external/full-device acceptance tasks.
T014 is also complete after `npm run types:supabase:local` against loopback
Postgres, formatting, project/test type checks and **88/88** shared-parity,
transport-parser and generation-controller tests. The generated delta contains
only the new service-only native-cleanup RPCs.
T018/T019 are complete with the non-catalog orchestration tests and authoritative
DB regressions: Buyer/social mutation before acceptance, immutable accepted
replay, exact row-UUID account selection despite identical suffixes, cancellation
fences and privacy-safe errors. The focused authoritative suite is **36/36 PASS**.

Latest module verification: 36 Launch/catalog/analytics test files,
**272/272 PASS** (including live editor updates without IO, copy/archive UI,
cleanup-pending UI, pre-cancellation receipt,
shared-drive lost-trash reconciliation and protected URL-list projection). The prior focused
bridge/state/recovery run was **66/66 PASS**; local
Launch pgTAP **20/20 PASS** (including service-only cleanup grants); static
verification **13/13 gates PASS**. Full `nice -n 15 npm run verify`
then reported **13/14 gates PASS**, 5,418 tests discovered, 12 skipped and
14 failures outside Launches (Finder, admin skeletons, Windows/download
fixtures, power scope and release notices); Launch-targeted tests passed.
No packaged-beta, Windows or live Google acceptance has been recorded.
Release build phase: **5/5 gates PASS** (web, agent and contracts). Release e2e
phase: a11y and browser CSP PASS, but the full database gate fails in existing
agent-journal, catalog-sync, sync orphan and workspace suites on the current
local stack. Its restitch privilege test was updated to exclude the intentionally
service-only Launch helper and now passes **29/29**; the Launch pgTAP file is
**20/20 PASS**. This is not
a release-ready verification result.

Migration 189000 prevents a terminally failed catalog child from being replaced
by background recovery. The Launch-specific service gate requires an explicit
parent retry that observed **that same failed attempt**; a prior retry for an
unrelated interruption does not authorize another catalog attempt. The parent
request replay remains idempotent, and a consumed authorization cannot replace
a second failed child. Local authoritative regression: `launch-state` **37/37
PASS**. The ordinary durable reconciliation path still reuses the original
reservation, selected rows and provider marker after a lost reply.
T034/T038 are reconciled as complete: the existing catalog dialog and Launch
call the same durable catalog adapter; the database blocks ordinary
rename/move/content edit/new version/trash, parent-folder trash, updater rounds,
replace-intent and version-overwrite for a catalog referenced by any Launch
revision. Synthetic PGlite regression covers these entrypoints; live Google
permission and availability acceptance remains separate.
The remaining cancellation gap is the catalog permission ledger: an owned
unpublished sheet can be trashed with fenced authority, but a newly created
`anyone` grant on a source video/image is kept in `cleanup_pending` when no
safe rollback proof exists. Do not count that state as canceled or remove an
unknown shared permission. T037 stays open until an exact provider permission
ID, competing-consumer check, fenced rollback and lost-reply reconciliation
are verified end to end.
Migration 190000 fixes a false-settlement case: a grant observed after a lost
create reply is no longer relabeled as preexisting. The private ledger retains
`prior_anyone=false` and `cleanup_pending`; authoritative regression
`launch-state` **38/38 PASS**. This migration does not itself revoke a grant.
Migration 191000 settles only a grant attached to a sheet whose owned,
unpublished file was positively trashed under the cleanup fence. The same DB
transaction marks that sheet grant `cleaned`; source-video/image grants remain
pending. The authoritative cleanup test proves a sheet grant no longer traps a
fully cleaned cancellation, while preserving the stronger source-grant rule.
Historical restore and manual result controls were reconciled against the
current `LaunchSpace`/`LaunchHistory` implementation. Targeted history,
revision and override UI tests: **17/17 PASS** after adding dependency hints
for manually changed URL, SUB, budget and ad range. History remains a RAM draft
until explicit save/generation; broad two-user and source-loss acceptance stays
open.
Historical configuration restore now emits the typed `restore_config` intent
and result with only flow/Launch/revision IDs. A synthetic URL secret is absent
from the analytics call payload; `launch-analytics` **7/7 PASS** and current
history/workspace UI regressions **15/15 PASS**. Project and test TypeScript
checks pass after wiring the restore flow.
Copy acceptance now checks first-commit tomorrow independently in
`Pacific/Kiritimati` and `Pacific/Honolulu`, plus exact-key replay against the
original saved date. `launch-copy-archive` **7/7 PASS**. A real replay across
midnight/DST and multi-user beta run remain in T060/T068.
After migrations 189000–191000, the restore signal and permission-recovery
regressions, the Launch/catalog/analytics module run passed **277/277 across
36 files**. This is targeted coverage, not a successful full release gate.
Two further durable-adapter fault regressions pass in `launch-catalog` **10/10**:
sharing refusal and interrupted finalize both retain the same owned sheet and
reserved variation on retry. Live provider reply-loss and concurrent-client
acceptance remain in T030/T044.
Local preview calculation benchmark with a valid 100-campaign fixture:
1,000 runs, 100 campaigns each, p95 **0.27 ms**, max **19.32 ms** on this machine.
This measures the pure generator only; browser render, low-power devices and
accessibility checks remain in T067.
The Launch list date-control regression now checks visible keyboard order
Calendar → Yesterday → Today and confirms the Today shortcut sends the local
calendar-day bounds to the server, then clears the bounds on a second click.
`launch-workspace-ui` **11/11 PASS**. Calendar range, DST and two-user beta
acceptance remain open under T053/T054/T068.
The workspace query regression now composes assignee, status, launch date and
search before cursor pagination. A separate authoritative database case proves
that removing a member immediately denies both the Launch list and protected
detail, including the original URL. `launch-workspace` **7/7 PASS**. Realtime
multi-tab invalidation and DST cases remain open.
The browser session regression confirms an unsaved protected URL stays out of
localStorage and sessionStorage during editing and disappears from the rendered
tree on workspace-view revocation. `launch-workspace-ui` **12/12 PASS**.
IndexedDB, Cache API, operation journal and full client-to-CLI secret-path
checks are still open under T065; this narrow test is not a complete privacy
gate.
The read-only Launch diagnostic query now carries the authoritative generation
`attempt_no` already available in its restricted database view. `inspect` and
`investigate` can distinguish retries of the same generation without selecting
config, URL or provider payloads. `launch-analytics` **7/7 PASS** with a
synthetic second attempt. This improves T016/T066 but does not yet prove the
entire producer-to-CLI path under delayed browser delivery.
The latest Launch-prefixed targeted sweep after these changes passed **195/195
tests across 30 files**. This includes the database, UI, URL, catalog and
diagnostic regressions; it does not replace the full fast/release verification
or external Google/Windows/beta acceptance gates.
The editor regression also verifies that the soft orange accent on the
required URL field appears when empty and disappears immediately after a valid
value is entered. `launch-editor-preview` **2/2 PASS**.
The authoritative list also returns exactly the stored `2026-03-29` Launch
date across the Europe/Kyiv daylight-saving boundary when filtering that
calendar day; adjacent dates are excluded. `launch-workspace` **8/8 PASS**.
The Launch progress panel now lists the server-confirmed steps for the current
attempt with their actual states. It does not infer restitch stages when no
restitch step exists, and the bar stays indeterminate without a measured count.
`launch-progress` **5/5 PASS**; static verification **13/13 gates PASS**.
T036/T042 remain open for full provider checkpoint and generic operation
progress acceptance.
A coordinator regression now simulates a lost reply while publishing a parent
whose catalog child is already registered. Re-running the same generation
restores that child and publishes the parent without source/provider work or a
second variation. `launch-catalog-execution` **3/3 PASS**. This is synthetic;
provider and database fault injection remain under T030/T044.
Latest `nice -n 15 npm run verify` (2026-10-14) completed **13/14 gates**,
5,444 tests discovered, 12 skipped. The suite gate has 16 failures in Finder,
admin skeletons, Windows/download notice fixtures, power-scope and web bundle
budgets; no Launch-prefixed test failed. The total/largest-asset budget failures
still require a current bundle attribution and should not be silenced by simply
raising the baseline. `verification-result.json` records the exact failure
list. Full verification therefore remains red; release verification and beta
acceptance are not claimed.
The current web build measured **1,020,908 B total**, **6,116 B entry**,
**138,511 B largest chunk** gzipped. The lazy `LaunchSpace` chunk is **17,489 B**;
the largest chunk is shared HeroUI, not Launch. The repository's main-line
budget is dated 2026-10-10 and explicitly says the pending 024 HeroUI baseline
supersedes it; that branch records 956,941 B total and 136,110 B largest.
The current total is still 63,967 B above that accepted 024 measurement, so
bundle attribution/re-ratification remains open rather than silently raising
`performance-baseline.json` for this feature.
Follow-up: the Finder/power/admin/release failures were stale test contracts,
updated to match current route admission, tab order, governed CPU decoding and
pinned signed-artifact URLs; their targeted suites pass. The accepted measured
024 HeroUI baseline was adopted exactly (956,941/6,019/136,110 B), while the
new lazy `LaunchSpace` route has its own explicit 20,000 B cap. The current
route is 17,489 B; excluding only that separately budgeted route leaves
1,003,419 B against the accepted baseline's 5% ceiling of 1,004,788 B.
`performance-budgets` **4/4 PASS** after a fresh web build. A new complete
`npm run verify` result is still needed before claiming the fast gate green.
That repeat completed **13/14 gates** with the suite red after ~37 minutes.
The earlier Finder/admin/release/power/budget failures are gone. Eighteen
unrelated UI assertions instead failed in many files with `STACK_TRACE_ERROR`
at approximately the 5-second test limit or a dependent missing element;
`creative-library-tasks`, `launch-overrides` and `launch-selector` all passed
when rerun together in isolation (**29/29**). System load was high and the
verify process ran at niceness 15. This is evidence of suite instability under
that load, not proof that the entire suite is green. Preserve the JSON report
for a controlled resource/timing investigation before release.
The workspace UI regression also simulates another tab's workspace revision:
the server detail advances from version 1 to 2, but an unsaved local Age 50
draft remains visible and its attempted save still carries version 1, allowing
the server's normal conflict gate to protect the other tab's result.
`launch-workspace-ui` **13/13 PASS**. This is a component-level test, not the
two authenticated-browser beta scenario required by T054/T068.

The workspace dictionary regression now proves team-local uniqueness, archived
Buyer exclusion from defaults, and revival under the same ID; the calendar,
assignee/status/search cursor and Europe/Kyiv DST cases remain green.
`launch-workspace` **9/9 PASS**. Copy replay now retains its original ID/date
after the source changes and rejects a changed timezone on the same key;
`launch-copy-archive` **8/8 PASS**. A retry on a genuinely different calendar
day still needs controlled-time or live acceptance evidence.

`investigate` now reports unknown result visibility only for a successful
generation without a matching `team_launch_visible` receipt. It no longer
flags canceled/failed generations or results already acknowledged by the
browser. Combined workspace/copy/analytics/code-map tests **34/34 PASS**;
the latest static verification **13/13 gates PASS** after formatting. Full
fast verification remains at the prior **13/14** result; release and beta
promotion evidence remain open.
The `investigate` Launch read now uses the requested period's lower bound as
well as its end. A generation from an older period can no longer create a
spurious missing-visibility finding in a 30-day investigation. The added
analytics window regression passes (**8/8** in `launch-analytics`).
`inspect` now removes its generic visibility blind spot only when the inspected
revision has a correlated browser `team_launch_visible` receipt. The positive
receipt regression passes (`launch-analytics` **9/9**). Three earlier attempts
to run this file hit the local PGlite setup hook's 10-second timeout while the
machine was under load; its setup timeout is now explicitly 30 seconds, and
the final targeted run passed. The ordinary fast suite gate still needs a
controlled full run.
The full Launch-prefixed sweep after these changes passed **204/204 tests in
30 files** with one worker. Script and test typechecks also passed, as did
`git diff --check`. This still does not prove live Drive, two-user beta,
Windows restitch, or the repository-wide suite gate.
`beta:doctor` reports both local ports in use because the beta processes are
already running; health and web HTTP both respond. The agent reports
`sourceRevision=9aa46f8cd873defbc3abd8d5276d42faf6890e5e`, older than this
working tree, so this is not exact-source beta acceptance. The available CUA
surface reports no browser, and its in-app browser entry point is unavailable;
the two-authenticated-user browser matrix was not run. No beta reset or process
restart was performed.
The progress, cancellation, operation-observation and shared workspace
Realtime suites passed **32/32** together. They include no timer percentage,
no inferred restitch stage, cleanup-pending wording, unmount without cancel,
and catch-up on subscribe/reconnect/foreground through the existing workspace
channel. Provider-measured progress and live child settlement remain separate
acceptance work (T036/T044).
Revision dependency coverage now explicitly distinguishes changed budget/ad
ranges (names only) from changed active custom restitch duration (media and
catalog invalidated). The duration uses the existing whole-minute validation;
`launch-revisions` **7/7 PASS**. Historical restore and live catalog reuse
acceptance still remain under T046/T044.
The generic read-only CLI command regressions also remain green after the
Launch evidence changes: `analytics-audit-command`, `analytics-investigate-command`
and `analytics-inspect-command` **41/41 PASS**. This is local synthetic data;
T066 still requires complete source→guard→CLI and unknown-code coverage.

On 2026-10-14 the local Colima runtime was started and the stale beta ownership
record was reconciled with the normal `beta:down` command; no beta reset ran.
`beta:doctor` then passed and `beta:up` served current local web/agent on
127.0.0.1. The agent `/health` returned `ready: true`, environment `beta`,
and web returned HTTP 200. Local Supabase pgTAP
`supabase test db supabase/tests/database/launches.test.sql` passed **20/20**.
This is local DB and service readiness evidence, not two-user browser or
packaged-beta acceptance: CUA exposed no browser and refused Safari control.

After the interrupted session, Launch progress now treats a provider count with
`total: 0` as indeterminate. It no longer computes a non-finite percentage or
claims `0 / 0` as measured progress. `launch-progress` **6/6 PASS** and the
static verification **13/13 gates PASS**. The full Launch-prefixed sweep passed
**206/206 tests in 30 files** with one worker. The shared operation status now
accepts explicit `null` measured progress and renders an indeterminate bar;
`team-file-operations` **9/9 PASS**, including invalid non-finite progress.
Launch uses persisted stages and counts,
not the timer-based `ProductCatalogProgress` used by the separate catalog
dialog. T042 is complete; full fast/release verification and live provider
acceptance remain open.

UI acceptance expanded to all naming controls, manual-budget reset, full
account IDs with equal suffixes, and source/URL/SUB controls;
`launch-editor-preview` **3/3 PASS**. The release build phase passed **5/5**
(shared, web, agent, release and team contracts). A full suite attempt was
stopped before a verdict while 240 of roughly 630 files had completed; it is
not recorded as a pass. T017 is complete at component level, while live MVP
and packaged acceptance remain T029/T068/T070.

### Verification after interrupted run — 14.10.2026

The release e2e gate completed with **7/8 gates passing**: shared, web and
agent builds, release/team contracts, accessibility, and browser CSP passed.
`database` failed because no local PostgreSQL listener was available at
127.0.0.1:54322 (`DbConnectError`), not because a Launch assertion failed.
`git diff --check` passed. The separate current-source `beta:up` attempt
started the local database but refused readiness because several Edge functions
returned `BOOT_ERROR` (`failed to determine entrypoint`). A concurrent
`supabase start` belongs to a 037 temporary checkout; the beta stop command
refused to stop the resulting listeners without its ownership record. No
manual stop or reset was performed.

After the competing start process exited, `beta:doctor` passed, but a second
`beta:up` still found only the database running and reported the other local
Supabase services stopped. The readiness loop was interrupted; no packaged
beta or Edge acceptance claim is made. The latest current-tree static run
passed **13/13 gates** in 53 seconds.
The current Launch-prefixed Vitest sweep passed **208/208 tests in 30 files**
with one worker (41 seconds).
The current-tree full suite gate was started but stopped before a verdict while
another checkout's full Vitest run was still active and saturating the machine.
It is not recorded as passed; the release suite and coverage gates remain open.

### Source sharing rollback — 15.10.2026

Migration 192000 and the hosted cleanup worker now reconcile known grants on
source videos and selected images by the exact Drive permission ID. The service
lease, source identity, registered consumers and active intents are checked
before deletion; a short catalog-start fence closes the interval around the
provider call. The worker reads the exact ID after DELETE, so a lost reply can
settle only when that ID is absent. A grant required by a registered catalog
is recorded as retained and the canceled parent may settle; an in-flight
consumer or unprovable grant remains cleanup_pending. One grant is processed
per tick to bound provider calls. No raw URL or provider payload enters the
cleanup plan or diagnostics.

The current source cleanup tests passed in `launch-state` **40/40**,
`launch-recovery` **13/13**, `launch-analytics` **11/11**, and `analytics-code-map`
**10/10**. The forward migration was applied only to local `wishly` Postgres;
the native Launch pgTAP passed **24/24**, including new service-only ACL and
closed-search-path checks. Generated local database types include the new
RPCs. The real Google Drive fault matrix and packaged beta remain open.

With that database temporarily available, the full pgTAP run showed failures
outside Launch (analytics role and catalog sync contracts), so it was stopped;
`supabase/tests/database/launches.test.sql` itself reported **PASS** in that
run, consistent with the earlier dedicated **20/20 PASS**. This environment
does not provide a clean full release verification or packaged beta acceptance.

### Current beta and diagnostic checkpoint — 15.10.2026

After a preserved local stack restart, `beta:doctor` and `beta:up` completed;
the beta web and agent health endpoints both returned HTTP 200. No reset was
performed because the existing beta database contains test work. In a fresh
Chromium session, the local test account opened Beta Workspace → Launches, a
ready Other result with three campaigns and budgets 10/20/30, and a Catalog
draft with preview and Generate action. No page exception or technical UUID was
visible in those screens. This is a source-beta read-only UI smoke, not a
Google provider or packaged-beta acceptance result.

At a 390 px viewport the Launch card initially caused 820 px horizontal
scrolling and overlapping content. The card now gives the shared Button a
multiline label and content height. A Chromium recheck measured `scrollWidth`
of **390 px** and visually confirmed separate card text and Copy controls;
Launch UI/workspace tests passed **19/19**, and design token/Tailwind gates
passed. Other narrow detail views still require browser acceptance.

The Launch audit now correlates `team_launch_visible` with both generation
`run_id` and revision: a receipt for another attempt cannot hide missing
delivery. `team_launch_visible` is declared as an audit probe. Focused
Launch analytics and coverage registry tests passed **21/21**. The full fast
verify found no failing assertion but rejected two unrelated macOS signing
tests skipped without `[needs: …]`; their missing script/notarization
requirements are now explicit and that test passes **6 passed, 2 explained
skips**. The current-tree fast verify repeat completed **14/14 gates PASS**
(5,465 tests, 12 explained skips). The full release form is being rerun after
the computer restarted during its coverage suite; the interrupted run has no
release verdict. The local
`wishly` database's stale migration-history entry `20261112100000` prevents
`migration up --local`; this local history issue has not been hidden by a
production repair. Exact-SHA packaged beta remains unavailable while 035 and
037 edits coexist uncommitted in the shared tree.

### Перевірка після перезапуску комп’ютера — 15.10.2026

Локальний Docker/Postgres відновився без `beta:reset`; дані beta збережено.
Повторний `verify:release` було зупинено під час suite, коли інший checkout
одночасно запустив fast verify. Жодного release-вердикту з цього запуску немає.
Повторювати release слід послідовно після звільнення машини: одночасні Vitest
процеси помітно збільшили тиск на пам’ять. `git diff --check` пройшов.

Порт 5175 зараз обслуговує Vite з `/private/tmp/affsupport-037/apps/web`, а
агент 43140 вимкнений. Відкрита у Chrome сторінка beta тому не є доказом
поточної реалізації 035. Окремий source beta web 035 на 5176 успішно стартував,
але новий origin не має test-сесії й веде на login; цей smoke не зараховано.
Тимчасовий сервер 5176 і вкладки закрито, щоб звільнити ресурси. Packaged beta
та повна матриця реальних provider/agent сценаріїв залишаються відкритими.

Вузький `tests/csp-smoke.test.ts` у sandbox зависав на локальному HTTP bind;
той самий тест із дозволеним loopback завершився **2/2 PASS за 2,13 с**.
Повний `verify:release` із loopback пройшов цей файл і 356 тестових файлів
coverage suite, після чого його свідомо зупинено при 23% вільної пам’яті та
активному swap, відповідно до вимоги не перевантажувати комп’ютер. Це не
release PASS і не доказ coverage/build/database/e2e gates. Наступний повний
прогін робити лише за достатнього вільного ресурсу, одним важким процесом.

Окремо після зниження навантаження: release build group **5/5 PASS**
(`build:shared`, web, agent, release/team contracts); browser a11y
**10 маршрутів × 2 теми, 0 порушень і 0 page errors**; CSP **2/2 PASS**.
Повний `supabase test db` на збереженій локальній базі дав **FAIL** у старіших
analytics role, catalog sync, orphan recovery і workspace SQL tests; Launch
файл у тому самому прогоні — PASS, а окремий `launches.test.sql` — **24/24 PASS**.
`npx supabase` у цьому середовищі також пробує недоступний npm registry;
встановлений `supabase` CLI працює. Ці часткові результати не складаються в
`verify:release` PASS; `verification-result.json` після групового запуску
описує лише build group, а не всю release форму.

Окремий послідовний release suite завершився: **626 тестових файлів**, сам
`suite` gate PASS, але `coverage` gate FAIL. Новий критичний
`packages/shared/src/team/launches/persistence.ts` мав 24,2% рядків проти
мінімуму 75%. Доданий контрактний тест перевіряє позитивні protected
detail/revision/progress/list відповіді та відхилення пошкоджених полів;
targeted Vitest **3/3 PASS**, targeted V8 line coverage **83,75%**. Повторний
повний release suite після цього доповнення: **5 468 tests PASS**,
`persistence.ts` **91,4% line coverage**, глобально **75,65%**. Coverage gate
все ще FAIL через ratchet regression у 19 інших модулях, зокрема web і agent
поза 035; їх не можна приховати оновленням baseline без окремого розбору.
Після форматування нового тесту повторний
`nice -n 15 npm run verify` завершився **14/14 gates PASS**, **5 468 tests**,
**12 explained skips**. Це все ще не `verify:release` PASS.

### Source beta build і вузький Result — 15.10.2026

Поточний 035 web зібрано через `npm run build:beta -w @video-compressor/web`
і відкрито окремим локальним preview на 5176 з реальним beta fixture sign-in.
Порт 5175, що належить checkout 037, не змінювався. У Chromium 390px список
Launches завантажив draft Catalog і готовий Other result без page errors;
`scrollWidth = 390`. Після відкриття Result довгий URL виявив горизонтальний
overflow до 6236px. Причина: базовий `white-space: nowrap` shared Button
перекривав utility class поля Copy. Для CopyResultField додано вузький клас із
перенесенням довгих значень. Повторна beta build і Chromium перевірка:
Result `scrollWidth = 390`, `innerWidth = 390`, `white-space = normal`,
0 page errors. У draft Settings другий довгий label матеріалу давав 445px;
правило перенесення обмежено контейнером Launch detail. Після ще однієї beta
build Chromium підтвердив список, Settings і Result: кожен `scrollWidth = 390`
при `innerWidth = 390`, 0 page errors. Значення URL не записувалося в цей
доказ. UI targeted tests **19/19 PASS**, design token і Tailwind gates PASS.
Після остаточного CSS/JSX виправлення `nice -n 15 npm run verify -- --gates=static`
дав **13/13 gates PASS** (format, lint, typechecks і policy checks).
Це source beta smoke,
не exact-SHA packaged beta й не підтвердження Google provider delivery.

### Захищений detail у browser storage — 15.10.2026

У тому самому ізольованому beta preview на 5176 Chromium увійшов fixture
акаунтом і відкрив готовий Other detail. У DOM був protected URL з CAPI
маркером; браузерний скрипт повернув лише булеві результати без значення
маркера. Після перегляду: localStorage **false**, sessionStorage **false**,
IndexedDB **false** (перевірено 1 database та всі object stores), Cache API
**false** (0 caches), service worker registrations **0**. Після Sign out і
переходу на `/login`: маркера немає в DOM, localStorage і sessionStorage;
Cache API лишився порожнім. Цей live browser smoke підтверджує саме
перегляд/вихід для цього beta account; він не замінює synthetic secret
input→handler→audit/analytics/Realtime/CLI matrix або зовнішнє рішення щодо
публічного catalog sourceLink.

У copy/archive regression додано перевірку джерела з історичним каталогом:
нова копія має **0 revisions** і **0 generations**, а archive не прибирає
catalog record оригіналу. `tests/launch-copy-archive.test.ts` — **8/8 PASS**.

Chromium source beta Result перевірено також з `prefers-reduced-motion:
reduce`: Copy URL отримує keyboard focus, натискання Enter записує в
clipboard рівно показане поле (`matches: true`), 0 page errors. У доказі
збережено лише збіг і довжину, без значення URL. Цей smoke не замінює повну
keyboard/motion матрицю AC-01–46.

### CLI diagnostic projection guard — 15.10.2026

Synthetic PGlite diagnostic view з довільним рядком у `flow_id`, generation
state/stage/method/error code та step stage/state/child ID спочатку повертав
цей рядок із `getLaunchEvidence`. CLI consumer тепер повторно нормалізує ці
поля через закриті shared enum, невалідні IDs повертає як `null`, а результат
явно містить blind spot про неочікувану проєкцію. Для понад 50 steps є
обмеження й окреме повідомлення про truncation. Failing-before/fixed-after
regression у `launch-analytics` і суміжні CLI/code-map тести — **43/43 PASS**;
`typecheck:scripts`, Prettier та `git diff --check` PASS. Після правки повний
fast static group також **13/13 gates PASS**. Це захист на межі
читання навіть якщо SQL view згодом розшириться без узгодженого enum; він не
підміняє повну source→handler→delivery матрицю.

### Catalog fence і виміряні кроки — 15.10.2026

Fault tests у durable catalog перевірили lease loss безпосередньо перед
Drive create, DB finalize і catalog link. У кожному разі наступний side
effect не викликається; після втрати fence перед finalize/link уже створений
sheet лишається зареєстрованим у checkpoint для reconciliation. Виявилося,
що `check()` перед link уже був у поточному коді; це acceptance доказ, а не
новий provider fix. Launch progress тепер показує лише число `succeeded`
step receipts поточної спроби, без фіксованого відсотка чи припущеного
загального числа; `stepsTruncated` позначено окремо. Цільові
catalog/progress/i18n тести **40/40 PASS**, project typecheck, Prettier,
Tailwind і `git diff --check` PASS. Після всіх змін fast static group
**13/13 gates PASS**. Реальні Google lost replies, конкуренція
споживачів і provider cancel timing залишаються зовнішньою fault matrix.
Повторний `nice -n 15 npm run verify` на цьому дереві завершився
**14/14 gates PASS**, **5 473 tests**, **12 explained skips**; coverage
у fast формі не вимірюється. Повний release verdict залишається відкритим.

### Послідовний release build — 15.10.2026

Окремий release build group спочатку хибно впав у `contract:release`: contract
читав старий beta asset із `apps/web/dist`, поки `build:web` паралельно
замінював його production bundle. Після завершення build beta endpoint у
`dist` вже не було. У `scripts/verify-all.mjs` build phase тепер exclusive,
тому contract читає тільки завершений артефакт поточної збірки. Повторний
`nice -n 15 npm run verify:release -- --gates=build` — **5/5 gates PASS**;
`tests/verify-all.test.ts` і `tests/gate-serial.test.ts` — **20/20 PASS**,
`nice -n 15 npm run verify -- --gates=static` — **13/13 gates PASS**,
`git diff --check` PASS. Це групова перевірка, не повний release verdict;
coverage ratchet і local DB drift лишаються відкритими.

Для US1 повторно виконано `launch-other`, `launch-ui` і `launch-analytics`:
**27/27 tests PASS**. Це targeted regression, повний producer→CLI trace і
ручний MVP сценарій ще потрібні для T029.

Історичний restore має регресію на стару дату/бюджет, очищення source
snapshot у RAM draft і незмінність поточного detail/result до генерації:
`launch-history` **6/6 PASS**. Суміжні state/controller/agent cancel тести
**73/73 PASS**, зокрема success-before-cancel, pause→cancel та settlement
upload. Це локальні synthetic тести; реальну parent→child/provider fault
matrix для T041 вони не замінюють.

### Видимість результату з точною генерацією — 15.10.2026

Знайдено розрив між producer і CLI: Result надсилав `team_launch_visible`
із revision ID, але без `run_id`, а `getLaunchAudit` обґрунтовано вимагав
обидва IDs. Migration 193000 додає `generationId` до protected revision
projection для успішно згенерованої revision. UI передає його у visible
receipt; ручна revision без власної генерації не приписує собі чужий run.
`investigate` тепер також порівнює run і revision, тому receipt іншої
генерації тієї самої revision не закриває blind spot. Targeted
analytics/persistence/investigate **37/37 PASS**; окрема PGlite регресія
перевірила blind spot до й після правильного receipt. SQL migration створено
й виконано в локальній транзакції з rollback, protected projection реально
викликано на локальному fixture (**PASS**). Fast static **13/13 gates PASS**.
Додатково exact generation/revision збіг перевірено на успішному локальному
fixture в rollback transaction (**PASS**). Повторний повний `npm run verify`
зупинився на 180-секундному тайм-ауті `format`, коли паралельно працював
static verify окремого checkout 037; lint/typecheck цієї спроби пройшли,
окремий `nice -n 15 npm run format:check` завершився PASS. Цю перервану
спробу не вважати full fast PASS. Це також не доказ browser→remote analytics
доставки в beta.

Після повторного 180-секундного format timeout навіть без паралельного
checkout його bounded gate budget у `verify-all.mjs` збільшено до 300 секунд.
Окремий Prettier завершився PASS; повторний fast static group на поточному
дереві **13/13 PASS** за 196 секунд (`format` 163,7 с). Довгий час пояснює
попередні тайм-аути, але повний fast suite після цієї зміни ще не пройдено.

Окремий `nice -n 15 npm run verify -- --gates=suite` після цього працював
понад 11 хвилин і був перерваний перезапуском комп’ютера. Його session handle
зник; `verification-result.json` лишився від static group о 12:22:57 за
локальним часом. Отже, нового suite verdict немає. Через це не повторювати
довгий suite без контролю навантаження; targeted тести нижче є лише частковим
доказом.

Після перезапуску додано ізольований PGlite regression для самої migration
193000: успішний producing generation перемагає новіший failed attempt і
чужу team; manual revision має `generationId: null`, foreign revision не
проєктується. Повторний targeted analytics/projection/persistence прогін
**20/20 PASS**, `typecheck:tests` і формат нового тесту PASS. Це підтверджує
серверну кореляцію, але interrupted suite лишається без verdict.

Додатковий consumer audit знайшов, що `inspect` знімав visibility blind spot
за одним revision ID, хоча `audit` і `investigate` вимагали також run ID.
Тепер `inspect` звіряє обидва, а тест із receipt іншої генерації перевіряє
blind spot до правильного receipt і його зникнення після. Суміжні
analytics/investigate/code-map тести **44/44 PASS**, Prettier і
`git diff --check` PASS. Це усуває неправдивий висновок CLI про доставку
результату; remote delivery все ще вимагає beta перевірки.

### Фактичний history restore у LaunchSpace — 15.10.2026

Нові інтеграційні UI тести перевіряють, що viewer може бачити історію без
дії restore, активна generation блокує restore, а відновлення старої
конфігурації переносить дату/бюджет лише в RAM draft. Поточний опублікований
Result залишається видимим; save/generate не запускаються автоматично.
Після restore відсутній source блокує спробу Generate на клієнті з
`INVALID_INPUT`: серверний generate не викликається. `launch-workspace-ui`,
`launch-history`, `launch-revisions` разом **30/30 PASS**; `typecheck:tests`
і форматування PASS. Dirty restore окремо покриває Cancel (ніякого historical
read) та Discard and restore (стара конфігурація лише в RAM). При
`LAUNCH_VERSION_CONFLICT` на Save and restore локальні edits і
поточний Result зберігаються, історичний read не запускається; цей UI тест
**17/17 PASS**. Інші history/source сценарії T046 ще відкриті.

Додатковий source regression: перейменований Offer змінює назви наступної
revision, історичний preview лишається незмінним, відомий settings version
дозволяє reuse каталогу (**launch-revisions 8/8 PASS**). Недоступний creative
(`lifecycle=missing`) дає `SOURCE_CHANGED` і в `get_launch_sources`, і при
accept, без запису generation (**launch-state targeted 1/1 PASS**).
Профільний повтор `launch-state`, `launch-revisions`, `launch-workspace-ui`
після змін — **66/66 PASS**.

Save and restore тепер підтверджує успішно збережену working copy одразу після
авторизованого current read. Якщо подальший historical read повернув `NOT_FOUND`,
діалог закривається, локальна версія вже відповідає серверній; наступний Save
використовує нову версію, а старий result не підміняється. UI regression
`launch-workspace-ui` **18/18 PASS**.
Після зміни порядку read/acknowledgement профільний повтор чотирьох файлів
`launch-state`, `launch-revisions`, `launch-workspace-ui`, `launch-history`
**73/73 PASS**; `typecheck:tests` і Prettier PASS.

US1 producer→CLI regression тепер проводить реальний `launchVisible` через
`ProductAnalytics` queue/sender envelope через справжню SQL функцію
`analytics_properties_are_safe_v2` до локальної PGlite `analytics_events`,
після чого `getInspect` знімає visibility blind spot лише за точного
generation/revision збігу. Guard також відхиляє raw URL. `launch-other`,
`launch-ui`, `launch-analytics` **29/29 PASS**. Це synthetic transport/CLI доказ; real beta MVP і actual
network delivery ще не пройдені, тому T029 лишається відкритою. Станом на
15.10.2026 13:37 локальні `5175`/`43140` не слухають, `beta:doctor`
повернув `BETA_PREREQUISITE_MISSING`: container runtime не запущений;
`colima status` підтвердив stopped. `beta:up` не запускався в цьому проході.

Пізніше запущено ізольований Colima `soty-beta-026` (спершу 4 ГБ, потім 6 ГБ;
2 CPU). Старий beta ownership record прибрано штатним `beta:down` без reset.
Перший `beta:up` завантажив потрібні образи, але локальний Supabase Storage
повернув `HealthCheckTimeoutError`; другий `beta:up` зупинився на
`BETA_PORT_IN_USE (5175)`. Порт тримає Node/Vite з окремої копії
`/private/tmp/affsupport-037-copy` (PID 17030 на момент перевірки), тому
процес не чіпали. Colima зупинено, beta acceptance **не проведено**; ані
пакетована beta, ані production з цього не випливають.

Повторна повна fast verification після виправлення нестабільного порядку
тарифних листів: `nice -n 15 npm run verify` — **14/14 gates PASS**, 5485
тестів, 12 умовних skip; `verification-result.json` має `ok: true`,
`form: fast`, `generated_at: 2026-10-15T11:43:36.117Z`. Перший повний запуск
показав єдиний збій у `space-tariffs-sql`: два записи з однаковим
`created_at` міняли порядок; assertion тепер перевіряє точні `kind/state`
без залежності від порядку, весь файл 39/39 PASS. Release form і beta
acceptance цим не підтверджені.

Release suite checkpoint: `nice -n 15 npm run verify:release -- --gates=suite`
виконав 5485 тестів (12 умовних skip), сам suite PASS, global line coverage
75.72% проти збережених 73.84%. Coverage gate FAIL через 19 per-file
ratchet deficits, зокрема `platform.ts`, `TeamSpace.tsx`, catalog/restitch UI;
`AgentMoney.tsx` видалено після baseline. `coverage-baseline.json` востаннє
оновлено 30.09.2026, а названі файли змінювалися пізніше. Всі Launch critical
floors виконані, але загальний release gate не green. Baseline не
перезаписувався автоматично; потрібен окремий audit доданих рядків/тестів і
зважене оновлення ratchet перед release verification.

Revision regression доповнено: Buyer, який використовується у SUB, змінює
наступний URL та потребу в каталозі без зміни назв чи історичного preview;
невикористаний Buyer не змінює жодного output; втрата binary identity матеріалу
забороняє media/catalog reuse. `launch-revisions` **10/10 PASS**. Для доказу
reuse тест фіксує відому версію catalog settings: за невідомої версії система
консервативно вимагає новий каталог. Повна T046 лишається відкритою до
перевірки всіх сценаріїв restore/source availability.

Cancellation settle deadline у native bridge тепер також проходить через
`PowerGovernor.scaleTimeout`, щоб CPU throttle не перетворював очікування
завершення managed child на хибний `PROCESS_CANCELED`. Targeted
`team-bridge` + `launch-restitch-runner` **28/28 PASS**; після змін
`nice -n 15 npm run verify -- --gates=static` — **13/13 gates PASS**.

Окрема release build-група після цього зрізу:
`nice -n 15 npm run verify:release -- --gates=build` — **5/5 gates PASS**
(shared, web, agent, release contract, team contract). Це не замінює
повну release form; останній release suite/coverage verdict вище лишається
FAIL до аудиту ratchet.

Catalog acceptance subset повторно пройшов після build: `launch-catalog`,
`launch-progress`, `product-catalog-xlsx`, `launch-shared-parity`,
`launch-catalog-execution` — **32/32 PASS**. Це синтетичні provider і XLSX
сценарії; real Drive fault matrix та двоплатформний native запуск у T044
не закриті.

Workspace UI regression з активним виконавцем тепер перевіряє, що після
відкликання його членства в іншій сесії workspace revision прибирає його з
доступних варіантів без metadata mutation. `launch-workspace-ui` **19/19
PASS**, `typecheck:tests` і Prettier PASS. Повна двокористувацька Realtime
приймальна матриця T054/T059/T068 ще відкрита.

Release coverage audit: два найбільші дефіцити мали конкретні неперевірені
шляхи після вересневого baseline. Нові поведінкові тести для історії пошуку
каталогу покрили keyboard apply/forget/navigation і підняли цільовий файл до
**100% lines (147/147)**; тести повідомлень про restitch delivery покрили
running→delivered та unconfigured manager/viewer, **98.03% lines (50/51)**.
Обидва вузькі coverage-прогони й `typecheck:tests` PASS. Це не verdict повної
release suite: решта per-file deficits ще потребує аудиту.

Діагностичний PGlite regression тепер подає child з
`canceled_with_cleanup_pending`/`LAUNCH_RESULT_UNCERTAIN`: `inspect` лишає
terminal порожнім, показує точний child operation і останній доведений етап,
а `audit` рахує generation як unsettled. `launch-analytics` **17/17 PASS**.
Це доводить безпечну інтерпретацію synthetic projection, не живий Drive
cleanup і не всю T066.

Після нових тестів повний `nice -n 15 npm run verify:release -- --gates=suite`
завершив suite PASS: **5492 тести**, 12 умовних skip, global line coverage
**75.75%**. Coverage gate ще FAIL, але per-file список скоротився з 19 до 17:
`CatalogSearchBar` тепер **100%**, `RestitchDeliveryNotices` **98.03%**.
`verification-result.json` для цього проходу має `ok:false`, `form:release`,
`coverage_lines:75.75`; це не green release verification. Решту baseline
відхилень не приховано автоматичним refresh.

Аудит решти 17 baseline-відхилень: 16 файлів мають комітні зміни після
`b4324864`/30.09.2026 (зокрема +326 рядків dev mock, +307 shared restitch,
+247 platform, +194 agent queue, +173 TeamSpace); `AgentMoney.tsx`
видалено. `Modal.tsx` не змінювався, але вимір втратив 3 покриті рядки.
Найбільші реальні діри нового коду (пошук каталогу й delivery notices) закриті
окремими поведінковими тестами вище. Критичні floors для platform,
catalog-search, restitch та всіх Launch-модулів пройшли у повному suite;
глобальне покриття вище старого baseline. Тому наступний крок — **явний**
refresh per-file ratchet штатним `--update-coverage-baseline`, зі збереженням
критичних floors і повним повтором release verification. Це не оголошує
непокриті гілки решти модулів перевіреними.

Штатний `nice -n 15 npm run verify:release -- --gates=suite
--update-coverage-baseline` завершився **2/2 gates PASS**, 5492 тести,
12 умовних skip і 75.75% line coverage. `coverage-baseline.json` тепер має
дату цього виміру й 614 виміряних файлів; усі critical floors повторно
перевірено без відхилень. Це явне оновлення ratchet за описаним аудитом,
не доказ live beta/Drive і не повна release form.

Release groups після refresh: `--gates=static` **13/13 PASS**,
`--gates=environment` **2/2 PASS**. `--gates=e2e` спершу виявив стару
локальну DB (backup із migration history до 28.09), тож штатний
`supabase migration up --local` застосував тільки відсутні forward migrations
у Colima `soty-beta-026`, без reset і без production. Повторний e2e:
web/agent build, release/team contracts, browser a11y і CSP PASS; `database`
FAIL. `launches.test.sql` та більшість pgTAP файлів PASS, але загальна DB
suite має непов’язані failures: catalog sync claim повертає 0 у fairness/
ownership, локальна роль не може `SET ROLE wishly_analytics_ro` у journal/
retention, security assertions для `team_restitched_folders` та
`admin_revoke_tariff_invitation`, search_path assertion. Повний release
verdict **не green**. Потрібно відрізнити локальний role/test harness стан
від справжніх source/migration regressions перед будь-яким виправленням.

Додаткова локальна діагностика: роль `postgres` у відновленому контейнері
мала membership `wishly_analytics_ro` з `SET FALSE`; локально (не міграцією)
увімкнено `SET TRUE`, після чого `agent-journal.test.sql` **38/38 PASS**.
`analytics-retention.test.sql` тоді дійшов до наступної помилки: pgTAP `is()`
викликається вже під read-only роллю без доступу до pgTAP schema — це test
harness mismatch, не Launch schema. У catalog-sync claim нова
`private.team_workspace_allowed(c.team_id)` (034 tariffs) відсікає старі
test-fixture teams без тарифу, тому fairness/ownership тести отримують 0 jobs.
`launches.test.sql` у загальному e2e PASS. DB release gate залишається FAIL;
ці суміжні тести треба узгодити з чинним тарифним контрактом, не прибираючи
production guard.
Окремий повтор `npx supabase test db supabase/tests/database/launches.test.sql`
на актуалізованій локальній базі — **24/24 PASS**.

15.10, наступний DB аудит: оновлено старі pgTAP fixtures catalog claim, щоб
тестові команди мали чинний tariff (production `team_workspace_allowed`
залишено); `catalog-discovered-subtree`, `catalog-scan-generations` і
`catalog-sync-fairness` PASS. `sync-orphan-recovery` тепер звіряє фактичний
Postgres `search_path=""` і PASS. `analytics-retention` виконує перевірки
доступу всередині відповідної ролі без викликів pgTAP із неї — **43/43 PASS**.
Приватний `team_restitched_folders` отримав forced RLS окремою forward
migration `20261202123000_restitched_folder_rls.sql`; admin revoke invitation
додано в явний allowlist caller-checked RPC. `team-workspace` і
`team-restitch` після міграції **336/336 PASS**. `catalog-sync-ownership`
із обмеженим retry для короткого advisory-lock contention пройшов **3 окремі
прогони по 14/14**. У повному pgTAP до цієї зміни він один раз дістав пустий
claim на циклі 449; повний прогін після цього було зупинено, бо benchmark
вставка 50 000 матеріалів тримала локальну VM під високим CPU понад 4 хвилини.
Тому повний database/e2e verdict досі **не green**; потрібен повтор у
ресурсно вільному середовищі. Локальний PostgreSQL не скидався, production
не торкалися.

Privacy regression 15.10: `launch-privacy.test.ts` тепер перевіряє unsaved
synthetic CAPI URL при edit→discard→remount із забороною запису до
localStorage/sessionStorage та відкриття IndexedDB/Cache API; **4/4 PASS**.
`launch-persistence.test.ts` перевіряє той самий synthetic marker у protected
detail та відсутність у list, request receipts, двох Realtime signal tables і
team audit; **6/6 PASS**. Це не закриває T065: потрібен повний
input→handler→CLI сценарій, перевірка logout/cache на реальному браузері й
окреме рішення щодо CAPI у anyone-readable Google Sheet. У застосунку
service worker і Cache API не використовуються за поточним пошуком коду;
браузерний acceptance ще не проведений.

UI acceptance 15.10: клавіатурний тест виявив, що `CopyResultField` після
натискання Edit не переводив focus у input. Додано focus переходи Edit→input
і Enter→Copy; user-event Tab/Enter/edit/copy regression PASS. Разом
`launch-ui` 7/7, `launch-progress` 6/6, `launch-generators` 9/9 (у тому числі
N100 preview <50 мс у локальному тесті). `verify:release --gates=static`
після форматування **13/13 PASS**. Вузький екран, реальна клавіатура,
reduced-motion і продуктивність на beta пристрої ще потребують browser
acceptance; T067 лишається відкритим.

US1 targeted acceptance повторено 15.10: `launch-other` 7/7,
`launch-ui` 7/7, `launch-analytics` 17/17 — разом **31/31 PASS**.
Producer→guard→read-only CLI synthetic evidence описаний вище лишається
чинним, але реальний beta MVP (N3/max30/ads3 → copy → reload без повторної
generation) ще не виконано. Порт beta 5175 зараз займає окремий Vite
процес із `/private/tmp/affsupport-037-copy/apps/web`; його роботу не
переривали. Тому T029 залишається відкритою, а цей targeted pass не
подається як live acceptance.

Повтор `nice -n 15 npm run verify:release -- --gates=suite` 15.10 після
privacy/focus правок досяг **timeout 2 700 000 мс**. `verification-progress.log`
для цього запуску має лише **135 START/135 END test modules**; повного
результату тестів і coverage немає. `verification-suite.json` із 5492 тестами
належав **попередньому** прогону, а verify runner помилково прочитав його як
поточний. Це **FAIL повного release suite**; попереднє формулювання про
5492 успішні тести саме в цьому прогоні було хибним. Runner виправлено:
перед suite він прибирає старі JSON/coverage-summary, а coverage оцінює
лише після успішного gate. `--gates=static` 13/13 PASS і цільові
US1/UI/privacy прогони PASS, але T069 лишається відкритою. Причину
сповільнення слід діагностувати перед новим повним прогоном.

Контрольний `nice -n 15 npm run verify -- --gates=suite` після виправлення
runner завершився **2/2 gates PASS за 606 секунд: 5495 тестів, 12 умовних
skip**. `verification-progress.log` має часові мітки й показує завершення
всіх 628 test modules. Fast form не вимірює coverage і не замінює release
suite; причина попереднього timeout локалізована до coverage режиму або його
взаємодії з послідовним виконанням.

Діагностика release suite: попередній timeout прогін мав 135 завершених
файлів і зупинився після `ui-workflow.test.tsx`; цей файл окремо з V8
coverage пройшов за 3 секунди. Fast suite з часовими мітками пройшов ту ж
послідовність і завершив **628/628 test modules** за 606 секунд. Coverage
вибірка 7 важких/Launch файлів на одному worker — **54/54 PASS за 63 с**;
двох worker — **54/54 за 37 с**, без swap. Проте стандартний контракт
`workflow-contract.test.ts` вимагає `--maxWorkers=1` і
`--no-file-parallelism` для all-core media тестів: експериментальна зміна
на два worker була відхилена тестом і **повернута**. Остаточний
`verify:release --gates=static` з однопотоковим runner **13/13 PASS**.
На той момент повний release coverage gate лишався невирішеним; його не
підміняли паралельним локальним запуском.

Штатний Vitest 3 blob/shard merge перевірено на семи файлах: два
**послідовні** shard із одним worker злили **54/54 тестів** та **13.14%**
line coverage — рівно стільки, як нерозбитий прогін. Одна з восьми частин
повного suite пройшла приблизно за 76 с. `scripts/run-unit-suite.mjs`
тепер запускає 8 shard по черзі з `--maxWorkers=1 --no-file-parallelism`,
зберігає timestamp progress, потім зливає blob у чинні
`verification-suite.json` та `coverage/coverage-summary.json`. Зовнішній
verify gate, coverage ratchet і формат machine-readable результату не
змінено; workflow-contract перевіряє one-worker budget.

Повтор `nice -n 15 npm run verify:release -- --gates=suite` із цим runner
**PASS 2/2 за 712 с**: 8/8 shard, 628/628 test modules, **5495 тестів,
0 failed**, 12 умовних skip, **75.79% line coverage**. `verification-result.json`
має `ok:true`, `form:release`; merged suite JSON та coverage summary
підтверджують ті самі counts/percentage, `git diff --check` PASS. Це
закриває попередній release suite timeout, але не database/e2e, live beta,
Drive або зовнішні tracker/CAPI рішення.

Локальний PostgreSQL через Colima `soty-beta-026` 15.10: повний
`npx supabase test db` **26 файлів / 795 pgTAP PASS за 33 с**. Повторний
`DOCKER_CONTEXT=colima-soty-beta-026 nice -n 15 npm run verify:release --
--gates=e2e` **8/8 PASS за 75 с**: shared/web/agent build, release/team
contracts, database (37 с), browser a11y і CSP. Це локальна e2e перевірка
схеми й збірок; реальні Google Drive та packaged beta acceptance окремі.

Фінальний послідовний прогін 15.10: `nice -n 15 npm run verify`
**14/14 PASS за 647 с**; `DOCKER_CONTEXT=colima-soty-beta-026
nice -n 15 npm run verify:release` **22/22 PASS за 826 с**. Останній
`verification-result.json` після повного прогону мав `ok:true`, `form:release`, 5495 тестів,
12 умовних skip, **75.75% line coverage**. Усі 628 test modules завершилися
в 8 послідовних shards; `git diff --check` PASS. Локальні generated database
types та release/team contracts перевірено статичними й build gates.
Це закриває T069 для локального verification; live Drive fault matrix,
packaged beta, tracker URL та політика видимості CAPI URL лишаються
окремими acceptance gates, без production rollout.

`npm run beta:doctor` після цього прогону зупинився на
`BETA_PORT_IN_USE (5175)` — порт займає окремий Vite з
`/private/tmp/affsupport-037-copy/apps/web`. Другий пункт,
`BETA_PREREQUISITE_MISSING`, очікуваний після зупинки локального Colima
для звільнення пам’яті. Beta stack або packaged beta в цьому стані не
запускали; сторонній процес не зупиняли.

T060 targeted follow-up: `launch-copy-archive` **9/9 PASS**. Новий DB
regression копіює ready Launch з активною manual revision і історичним
catalog link; новий draft бере конфігурацію revision, але не переносить
manual advertising URL, source expectation, revision/result history,
catalog link або generation. Midnight/DST replay через реальний перехід
дати та provider side effects цим тестом не доведені: окремий replay тест
штучно зістарює лише receipt timestamp і підтверджує незмінні дату/ID,
але не пересуває годинник PostgreSQL. T060 відкрита.

T066 targeted follow-up: `launch-analytics` **18/18 PASS**. Новий
`investigate` regression перевіряє дві однакові failed generation:
відомий safe code повертає `fact` з fingerprint, відсутній code —
`insufficient`. Інші end-to-end шляхи fault/recovery і доставка сигналів
лишаються частиною відкритої T066.

T043/T066 observation follow-up: `launch-analytics` **19/19 PASS**.
`canceled_with_cleanup_pending` з невідомим child outcome породжує лише
stage observation, тоді як terminal `canceled` — окремий cancellation
receipt. Цей тест не доводить live SSE/recovery reconciliation.

T046 restore permission follow-up: `LaunchHistory` вимикає Save/Discard
після втрати права edit, навіть якщо confirmation уже відкрита; Cancel
залишається доступним. Під час generation lock усі рішення тимчасово
вимкнені. Viewer може переглянути ready історію без дії Restore;
`launch-history` **8/8 PASS**. Інші source/revision conflict
сценарії T046 ще відкриті.

Спроба browser acceptance 15.10: Computer Use auto-review відхилив
доступ до відкритих Safari і Chrome (`Computer Use was not approved`),
а Chrome tab inventory повернув policy error. Порт 5175 і далі займає
PID 17030, beta-mode Vite з `/private/tmp/affsupport-037-copy/apps/web`;
ця збірка не є worktree 035. Жоден її UI стан не зараховано як acceptance
035, паралельний процес не зупиняли.

T054 follow-up: `launch-workspace-ui` **20/20 PASS**. Новий two-tab
regression оновлює workspace defaults через revision invalidation і
підтверджує, що вже відкритий draft зберігає age/max budget та не
виконує implicit save. Сценарії на рівні реального browser reconnect,
і двох авторизованих користувачів ще не доведені. Додатковий
`launch-editor-preview` regression перевіряє submitted/empty Buyer як
обов'язкове поле за spec §4; optional assignee перевіряється окремо
в workspace. Попередню помилкову класифікацію Buyer як optional
виправлено. `launch-workspace-ui`/editor після виправлення **25/25 PASS**;
assignee без вибраного користувача не отримує warning accent. Статичні
gates були **13/13 PASS за 49 с** до цього test/doc edit;
повний release verdict для поточного коду ще потрібний у T069.

T036 durable-link follow-up: спільний `catalog-durable.ts` тепер записує
`linkCompleted:true` тільки після успішного `deps.link` і до terminal
`registered`, через той самий fenced checkpoint RPC. Якщо fence втрачено
після відповіді link, adapter повертає `LEASE_MISMATCH`, не повідомляє
готовий каталог; recovery перевіряє вже зареєстрований catalog через
`service_reconcile_catalog_result`. Fault regression перевіряє порядок і
відмову post-link checkpoint. `launch-catalog`, `launch-catalog-execution`,
`product-catalog-xlsx` **26/26 PASS**. Числовий progress для catalog
створення не додавався: spec AC-41 вимагає підтверджені етапи та фактичний
restitch progress, а довільний відсоток для Drive create був би хибним.
Це закриває T036 на рівні durable checkpoints, server step counts і
cancel/fence regressions. Live Drive fault matrix лишається у T044/T068.
Після link checkpoint `nice -n 15 npm run verify:release -- --gates=static`
**13/13 PASS за 28 с**; повний release suite для цього коду ще не повторено.

T043 diagnostic reconciliation: `inspect` тепер явно показує blind spot
для `cancel_requested`/`canceled_with_cleanup_pending`; `investigate`
класифікує їх як `insufficient` і додає
`launch_settlement_unknown`, навіть якщо код
`LAUNCH_RESULT_UNCERTAIN` відомий. Код є фактом про спостереження,
не доказом фіналу child/provider. Hosted hook, workspace child observation,
UI progress, analytics і code map разом **49/49 PASS**. Це закриває
integration T043, але не live fault matrix T044/T068.
Після diagnostics edit `verify:release --gates=static` **13/13 PASS
за 29 с**; повний suite/release на цьому коді лишається T069.

Після цього UI edit `nice -n 15 npm run verify:release -- --gates=static`
**13/13 PASS за 27 с**. Команда оновила `verification-result.json` на
груповий static verdict; повний release verdict вище стосується попереднього
стану коду і потребуватиме нового повного прогону перед фінальним gate.

T067 keyboard/selection follow-up: `CopyResultField` тепер не запускає
clipboard write, коли користувач виділив текст у самому copy control;
звичайне натискання Enter/Space лишається доступним. `launch-ui`,
`launch-progress`, `launch-generators` **23/23 PASS**; останній набір
включає assertion N100 preview <50 мс. Окремо `tsc -b apps/web` та
`tsc -p tsconfig.check.json --noEmit` **PASS**. Після розрізнення pointer
selection і клавіатурної активації `launch-ui` **8/8 PASS**, повний
static gate `verify:release --gates=static` **13/13 PASS за 45 с**.
Реальна narrow-screen і
reduced-motion browser acceptance лишається у T067.

Наступний Chrome beta T067 slice на viewport **390×844**: Launch list і
новий Settings editor не мали document-level horizontal overflow
(`scrollWidth=innerWidth=390`); довгий статусний ряд був горизонтально
прокручуваним у власному date-filter container. Статус «Всі» став доступний
після scroll/click. У новому editor ArrowDown відкрив РК listbox, Escape
закрив його, Tab перевів фокус на combobox «Офер». Після повернення до
звичайного viewport кнопка «Скасувати» закрила чисту чернетку; новий UI
regression підтвердив відсутність unsaved prompt, `launch-workspace-ui`
**23/23 PASS**. Жоден Launch у beta не збережено. Reduced-motion у браузері
ще не емулювався; token layer має `prefers-reduced-motion` override для
motion durations, але це static evidence, не browser acceptance.

AC-45 follow-up: `LaunchEditor` передає `required` у спільний `FormField`,
тому обов'язкові Launch поля мають явний маркер біля label разом із
warning accent; submitted/empty Buyer regression у `launch-editor-preview`
**4/4 PASS**. Це не замінює повного screen-reader/browser acceptance.

## T070 — rollout/rollback handoff (підготовлено, не виконано)

15.10 beta-only direction: власник тестує готовий функціонал 035 у beta
і планує подальші правки до release. `nice -n 15 npm run verify` цього дня
було перервано сигналом SIGINT (exit 130) після різкого зростання swap до
~2.5 ГБ; це **не PASS і не FAIL** тестів. `verify:release` та production
дії до beta acceptance не запускати. Порт beta web 5175 наразі зайнятий
PID 17030 із окремої копії 037; agent 43140 не запущений. Цей UI не
вважати перевіркою поточного worktree 035. Легкий
`node scripts/verify-beta-env.mjs` повернув лише два blocker codes:
`BETA_PORT_IN_USE (5175)` і `BETA_PREREQUISITE_MISSING` (container runtime
не запущений). Beta 035 не запущена й немає runtime acceptance для
поточного worktree.

T059 local collaboration follow-up: `team-realtime` **12/12 PASS**;
подвійний `team_launch_workspace_signals` invalidation дає одне
авторитетне перечитування після початкового subscribe, не відкриває
другий канал і прибирає канал після unmount. Це synthetic contract, а
не доказ реального reconnect двох beta-користувачів.

T066/AC-26 telemetry isolation: відмова browser storage під час analytics
`track` більше не перетворює успішний Launch RPC на failure/retry і не
перекреслює фактичний clipboard success. `launch-analytics` + `launch-ui`
**29/29 PASS**, включно з throw-on-track та throw-on-copy-outcome regressions.
`tsc -b apps/web` і `tsc -p tsconfig.check.json --noEmit` **PASS**.
Така відмова лишає явний delivery blind spot; вона не є доказом доставки
analytics. `coverage-registry.ts` тепер називає цей browser enqueue blind spot;
`audit` regression перевіряє його наявність. Після доповнення інвентарю
цільовий набір повторно **29/29 PASS**. Beta runtime acceptance ще попереду.

T046 historical-source follow-up: synthetic restore старої конфігурації з
недоступним material залишає поточний published result; source re-resolution
отримує `NOT_FOUND`, нова Generate не звертається до generation API, доки
джерело не буде виправлено. `launch-workspace-ui` **22/22 PASS**,
`tsc -p tsconfig.check.json --noEmit` **PASS**. Реальний provider/source
mutation у beta ще не перевірений.

T046 draft hydration follow-up: перше авторитетне завантаження source snapshot
для незміненої конфігурації тепер не позначає чернетку як редаговану й не
вимагає зайвого Save/Discard перед історичним restore. Якщо користувач змінив
конфігурацію, подальше завантаження джерел зберігає dirty state. `launch-history`

- `launch-workspace-ui` **31/31 PASS**; `tsc -p tsconfig.check.json --noEmit`
  **PASS** після виправлення typed test fixture. Це synthetic UI evidence;
  beta runtime лишається відкритим.

T060 local copy/archive regression: `launch-copy-archive` **9/9 PASS** —
idempotent copy receipt, source mutation replay, browser timezone/date-line,
foreign actor, generation lock, historical catalog warning та archive preference.
Тест `launch-generators` окремо перевіряє календарний tomorrow на DST/межі року.
Це не доводить реальні Drive side effects або replay наступного дня у beta.

Наступний T060 checkpoint: нова міграція `20261202125000` винесла
календарне tomorrow у `private.launch_tomorrow(timezone, instant)` без зміни
першого commit/replay fence. Fixed UTC tests перевірили до/після локальної
півночі в Kiritimati/Honolulu, весняний пропуск години й осінню повторну
годину в Kyiv. Окремий DB scenario копіює Launch з material, який став
`missing`: та сама reference лишається в новій чернетці, але authoritative
`get_launch_sources` повертає `SOURCE_CHANGED` до генерації; фізичний
material не дублюється. `launch-copy-archive` **11/11 PASS**, `beta:reset`
застосував усю migration chain, `verify -- --gates=static` **13/13 PASS**.
Реальний replay після зміни системної дати й Google Drive side effects
залишаються невиконаними live beta сценаріями T060/T068.

Широкий single-worker Launch прогін 15.10: `tests/launch-*.test.ts{,x}` —
**257/257 PASS, 32/32 файли, 35 с**. Суміжні XLSX/template/updater/agent bridge
регресії — **75/75 PASS, 4/4 файли**. `team-bridge` навмисно вивів
`PROCESS_CANCELED` у stderr у тесті cancel; сам тест пройшов. Це local synthetic
evidence, не live Drive/Windows або packaged beta.

15.10 full unit gate: `nice -n 15 npm run verify -- --gates=suite` —
**2/2 gates PASS** (`build:shared`, `suite`), **5511 tests PASS / 12 skipped**,
767 с. `verification-result.json` містить `ok: true`, `form: fast`, саме ці
два gates; coverage у fast формі не вимірювався. Разом із попереднім static
13/13 це доказ обох фаз на поточному коді, але окремі invocations не є одним
формальним повним `npm run verify`. Swap протягом suite зменшився приблизно
з 3.56 до 3.48 ГБ. Beta runtime та external gates залишаються відкритими.

Формальний повний `nice -n 15 npm run verify` спершу зупинився на Prettier
для нового `launch-history` тесту; після форматування повторний запуск —
**14/14 gates PASS, 5511 tests PASS / 12 skipped, 887 с**.
`verification-result.json` від 2026-10-15T17:58:58Z: `ok: true`,
`form: fast`, `failed: 0`, `coverage_lines: null`. Це завершує T069 для
поточного worktree. Після прогону beta port 5175 усе ще тримає 037 PID 17030,
Docker daemon недоступний; beta runtime/packaged acceptance окремо не пройдено.

Після повного verify додано вузьку privacy regression: при втраті protected
detail змонтований draft очищує з RAM і збережений, і незбережений synthetic
URL. `launch-privacy` **5/5 PASS**; повторний static gate на цій зміні
**13/13 PASS**. Повний suite verdict вище передував саме цій тестовій правці;
T065 лишається відкритим для end-to-end browser/cache/CLI visibility.

### Beta runtime 15.10.2026 — локальна перевірка поточного worktree

Colima default піднято на 2 CPU/4 ГБ. Процес Vite 037 з тимчасової копії
зупинено м'яким SIGTERM; `beta:doctor` після цього **PASS**. `beta:up`
підняв web 5175 і agent 43140 з `/Users/daynero/RiderProjects/AffSupport`;
обидва повертають HTTP 200. `beta:reset` **PASS**: усі міграції до
`20261202123000_restitched_folder_rls.sql` застосовані, fixtures і worker
secrets відновлені. Поточна beta має uncommitted source revision
`265502d665b8`; це тест worktree, не packaged exact-SHA acceptance.

Через локальну Supabase Auth beta fixture `beta@soty.local` виконано HTTP/RPC
smoke без друку токенів: workspace знайдено; Launch з synthetic URL створено;
той самий save request повернув той самий ID; protected detail повернув URL,
а list не містив synthetic secret; copy створив інший ID, replay повернув той
самий copy, result/source snapshot не перенесені; warning не заявив catalog;
обидва тестові Launch заархівовані й зникли зі списку. **PASS**. Це реальні
beta Auth/PostgREST/RLS/SQL контракти, але не browser UI, Edge Generate,
Google Drive/live source, two-user collaboration чи packaged beta. Після reset
fixture не містить підключеного Drive/material, тому external end-to-end
journeys AC-01–46 усе ще відкриті. Beta залишена запущеною для подальшої
перевірки власником; memory free ~39%, swap ~4.1 ГБ після старту stack.

Додатковий beta negative slice: анонімний `list_launches` і запит до чужого
workspace повернули PostgreSQL `42501`; Edge
`drive-ops/launches/generate` для неповної збереженої чернетки повернув
HTTP 400 із закритим `INVALID_INPUT` (envelope `ok:false`). Чернетка може
бути неповною до Generate; це очікувана поведінка Save, не дефект. Усі
тимчасові Launch із цього зрізу заархівовані. Це доводить Auth/RLS і
pre-acceptance validation у beta, але не source/provider generation.

Після `beta:reset` виконано штатні `beta:down`→`beta:up`, щоб agent не тримав
старий queue state у RAM. Повторний read-only smoke після відновлення backup:
fixture Auth і workspace доступні, `list_launches` повертає масив,
Edge Generate для неіснуючого ID відповідає HTTP 404/`NOT_FOUND`.
Отже web/agent/Auth/PostgREST/Edge після restart працюють на поточній beta;
жодного production endpoint не використовували.

### Chrome UI beta slice — 15.10

Ізольований Google Chrome на локальній beta: fixture sign-in, onboarding,
deep link `.../launches`, empty list і New Launch відкрилися без page errors.
Візуальний огляд 1280 px виявив надмірні початкові повідомлення
«Потрібно заповнити» під усіма незаповненими полями. UI виправлено:
попереджувальний accent збережено, але help/error текст з'являється після
взаємодії з полем або Generate; SUB і creative picker дотримуються того
самого правила. Chrome повторно підтвердив **0** таких повідомлень у новій
формі, **1** після введення невалідного URL, **0** після його виправлення;
page errors **0**. Порожній Generate показав **4** потрібні повідомлення і
не викликав Edge Generate (0 requests).

У Chrome через UI збережено нову неповну чернетку з synthetic URL,
перевірено перехід на новий ID, скопійовано її в окремий ID, обидва Launch
архівовано кнопкою інтерфейсу. Після архівування список знову порожній;
page errors **0**. На viewport 390 px форма й preview стали в один стовпець,
`document.documentElement.scrollWidth === innerWidth === 390`, кнопка
збереження доступна. `launch-editor-preview`, `launch-creative-picker`,
`launch-ui`, `launch-catalog-settings` **19/19 PASS**; `tsc` і повторний
static gate **13/13 PASS**. Паралельна static перевірка з beta stack підняла
swap до ~6 ГБ; подальші важкі suite/build перевірки запускати лише
послідовно після оцінки пам'яті. Повний fast `verify` вище передував цій UI
правці; beta Chrome slice і static/targeted доводять її локально, але не
замінюють повного нового suite.

UI follow-up: спроба key-by-ID для очищення touched state зламала контракт
першого Save (editor remounts 2 замість 1); ключ прибрано, бо зовнішній
LaunchSpace вже тримає стабільну editing-session identity під час першого
збереження. Повторні `launch-workspace-ui` + editor + creative + UI тести
**38/38 PASS**. Цей fail був лише проміжним local regression і виправлений
до передачі beta.

Chrome beta follow-up для списку Launch: пошук тепер має видимий placeholder,
поля пошуку й виконавця не займають повну ширину desktop toolbar. На viewport
390 px контейнер фільтрів більше не розширює сторінку: після виправлення
`document.documentElement.scrollWidth === innerWidth === 390` (раніше 434).
На desktop 1280 px горизонтального overflow немає; page errors **0**.
`launch-workspace-ui` **22/22 PASS**, design token і Tailwind gates PASS,
`git diff --check` PASS. Це live browser beta smoke, а не packaged beta verify.

Chrome privacy slice на новій незбереженій формі: введено у URL унікальний
synthetic marker; до reload він не з'явився в localStorage, sessionStorage,
Cache API або назвах IndexedDB. Після reload поле URL порожнє, marker не
з'явився у цих сховищах, page errors **0**. Це підтверджує лише unsaved RAM
частину AC-31 у браузері; protected saved detail, IndexedDB records,
service-worker cache, conflict/copy/logout і CLI visibility потребують
окремого наскрізного доказу для T065.
Окремий synthetic URL збережено через UI; його marker також не з'явився в
localStorage/sessionStorage після Save. Тестовий draft видалено через UI;
після повторного входу beta список порожній. Cache API/IndexedDB для
збереженого detail у цьому проході не перевірялися.

Chrome timezone copy slice: вихідну чернетку створено у beta UI, потім
окремі реальні Chrome-сеанси з `Pacific/Kiritimati` і `Pacific/Honolulu`
скопіювали її через кнопку Launch. Копії отримали різні ID, не мали
active result, а protected detail показав відповідно `2026-10-17` і
`2026-10-16` та відповідні timezone. Це «завтра» в поточному часовому
поясі кожного браузера біля лінії зміни дати; вихідна timezone не
переноситься. Усі три тестові Launch видалено через UI, після reload
список beta порожній. SQL replay/ACL/незалежність окремо перевіряє
`launch-copy-archive`; browser slice не є доказом DST чи replay наступного дня.
Після browser slice `launch-copy-archive` + `launch-copy-hook` **13/13 PASS**;
`git diff --check` PASS. Пам'яті вільно 43%, важкого паралельного прогону не було.

Two-tab beta probe: у першій вкладці зміна статусу чернетки дійшла до
авторитетного detail (`workStatus=in_progress`, version 2) і до
`team_launch_signals` (version 2). Друга вкладка в короткому проході не
оновила картку; цей прохід **не зараховано** як AC two-tab PASS.
Ізольована перевірка Realtime на тій самій локальній beta показала delivery
UPDATE для `team_launch_signals` через WebSocket і додатковий
`list_launches` read; аналогічний workspace signal дав той самий результат.
Отже transport працює, але потрібен стабільний end-to-end test саме зміни
Launch між двома вкладками з очікуванням subscribe/initial reads. Тимчасові
чернетки probe заархівовані; локальна DB не має active fixture Launch після
прибирання. `team-realtime` + `launch-workspace-ui` **34/34 PASS**;
`git diff --check` PASS. Продакшн не зачіпали.
У наступному Chrome проході друга вкладка спільного browser context
періодично залишалася на «Перевіряємо вашу сесію Soty…» до відкриття
Launches, а інколи ще не показувала картку після перших успішних list RPC.
Такий прохід не можна використовувати для висновку про Launch Realtime.
В окремому одному готовому Chrome-сеансі ізольований SQL UPDATE
`team_launch_signals` доставляв WebSocket UPDATE і запускав ще один
`list_launches` read у Chrome. Повторити справжню metadata→second-tab
перевірку після стабілізації початкової auth/route готовності; не позначати
two-tab acceptance як PASS на основі transport-only сигналу.
Окремий Chrome context зі скопійованим валідним beta auth storage теж
проходив auth, але понад 20 с лишався на «Відкриваємо простір…» до
Launch list; токен у цьому probe мав ще близько години до expiry.
Отже саме browser E2E для двох вкладок зараз залежить від нестабільного
початкового завантаження workspace у локальній beta. Це не доказ збою
Launch metadata або доставки сигналу; на тому checkpoint T054/T059/T068
лишалися відкритими.

Наступний beta fix/proof: `TeamSpace` у штатному режимі використовує
завершення `TeamProvider` initial teams read замість власного дубльованого
`list_my_teams`; кастомний test/embed client зберігає власне читання.
`tsc` PASS, team-space lobby/cache/navigation і team-realtime **29/29 PASS**.
Після цієї зміни другий авторизований Google Chrome context відкрив Launches,
усі три спостережені `list_my_teams` RPC завершилися. Далі в двох готових
сеансах нова чернетка з першого з'явилася в другому, зміна її статусу
todo→in_progress дійшла до protected detail і картки другої вкладки;
WebSocket мав два додаткові Launch updates, список зробив два додаткові
авторитетні reads. Це **PASS для live beta двосеансового Launch
invalidation**, але не для окремого сценарію втрати прав або reconnect після
offline. Тимчасовий Launch видалено; active fixture count = 0,
`git diff --check` PASS. Попередні невдалі probes вище не є результатом
після цієї правки.
Регресія у `team-space-cache` перевіряє, що штатний provider робить лише
один initial team read у звичайному mount (4/4 файл PASS); TypeScript після
додавання тесту PASS.

Повний звичайний `nice -n 15 npm run verify` після цих змін завершився
**14/14 gates PASS** за 750 с: **5514 tests PASS, 12 skipped**;
`verification-result.json` має `form=fast`, `ok=true`. Це актуальний
repository-wide fast verdict для цього worktree, не `verify:release`, не
packaged beta і не production rollout. Beta fixture active Launch count = 0;
під час suite вільна пам'ять трималася близько 68–72%.

T059 collaboration/diagnostics acceptance: `launch-workspace`,
`launch-workspace-ui`, `team-realtime`, `team-i18n-glossary`,
`launch-analytics` **84/84 PASS**. Зокрема SQL відмовляє list/detail після
видалення member; UI стирає protected detail коли `view` відкликано;
Realtime coalesces workspace signal в одному channel та перечитує після
reconnect/visibility. Live beta довела синхронізацію двох сеансів одного
користувача. Відкликання другого реального beta-користувача ще не
перевірено у Chrome і лишається частиною T068.

Наступний beta slice виявив permission defect: editor міг прочитати protected
Launch detail, але setup екрана блокувався на `list_team_members`, дозволеному
лише менеджеру учасників. Міграція `20261202124000` додає
`list_launch_assignees` з проєкцією тільки active `user_id/display_name`,
обмеженою `launch_access(view)`; LaunchSpace тепер використовує цей RPC.
`beta:reset` повторно застосував увесь ланцюг міграцій і видалив тимчасові
Launch/member fixtures. Адресні `launch-workspace` + `launch-workspace-ui`
**31/31 PASS**: editor читає assignee projection, `list_team_members` йому
заборонений, після видалення member list/detail/assignees відмовляють і
власник не бачить видаленого виконавця. `npx tsc -b apps/web` PASS. Chrome
owner beta після reset показав порожній екран Launches без помилки.
Реальний editor Chrome replay і revoke flow лишаються у T068: Chrome
автоматично відхилив програмне перемикання сесії через browser security
policy. Альтернативний обхід не виконувався; тимчасового beta-користувача
видалено. SQL/RLS і UI regression є поточним доказом для цього slice.
Після форматування повний `nice -n 15 npm run verify` завершився
**14/14 gates PASS** за 1664 с: **5514 tests PASS, 12 skipped**;
`verification-result.json` має `form=fast`, `ok=true`. `git diff --check`
також PASS. Це звичайний fast verdict, без release suite чи deployment.
T046 local history/source acceptance: `launch-revisions`, `launch-history`,
`launch-workspace-ui` **41/41 PASS**. Покрито name/Buyer/URL/media/settings
dependency, відсутню або замінену source identity, immutable previous output,
стару дату/бюджет у staged restore, save/discard/cancel, viewer, generation
lock і conflict. Це закриває локальний тестовий зріз T046; реальна зміна
Google Drive source лишається зовнішнім сценарієм T044/T068.

T065 Chrome beta unsaved-input probe: синтетичний URL
`https://example.invalid/?token=SYNTHETIC_SECRET_035_Q7` був у полі нової
чернетки, але не в `location.href`; натискання «Скасувати» викликало native
unsaved-change confirm. Browser-use read-only evaluation не надає
`localStorage`, `sessionStorage`, `indexedDB` або `caches`, тому їхній вміст
цим probe **не перевірений**. Після прийняття confirm browser automation
завис на focus-emulation command; спроби закрити або перенаправити створену
вкладку не виконались, а native Chrome control відхилено автоматично.
Жодного Save/Generate не натискали. Вкладка може лишатися з незбереженим
синтетичним URL; це тестове значення, не реальний секрет. Повний storage/
cache/logout regression і live cleanup evidence залишаються T065.

T065 наступний ізольований browser-storage QA: Chrome extension відхилив
read-only CDP storage inspection через збережене користувацьке налаштування
дозволів. Обхід через інший browser surface або прямі browser команди не
виконувався. У React integration `LaunchSpace` protected URL проходить
detail→edit→revoke без появи в local/sessionStorage; додані spies
підтверджують, що цей шлях не відкриває IndexedDB або Cache API,
`launch-workspace-ui` **23/23 PASS**. Це не замінює live browser storage
inspection після повного save/reload/logout і не закриває T065.

T065 local privacy chain: `launch-privacy` + `launch-workspace` **15/15
PASS**. Синтетичний URL і довільний error code пройшли через Launch
producer, persisted `ProductAnalytics` queue, sender та logout без появи
секрету. Після DB `save_launch_draft` список і Realtime
`team_launch_signals` лишилися content-free; `team_launch_requests.payload`
не читається browser role навіть власником, а авторизований `get_launch`
повертає URL лише в protected detail. Статичний пошук не знайшов Launch
записів у `workspaceOperationJournal` або реєстрації service worker/Cache
API в web app. Це доповнює, але не замінює live storage/cache/browser
acceptance та рішення про CAPI у anyone-readable Sheet.

T066 partial/interruption diagnostics follow-up: `launch-analytics` **21/21
PASS**. Для двох authoritative generation records `inspect` показує окремі
`database:launch_partial` і `database:launch_interrupted` та їхні останні
доведені stages; `audit` рахує одну невідому причину, а `investigate`
позначає partial із safe code як `fact`, interrupted без code як
`insufficient`. Цей тест не доводить live SSE/provider delivery або повну
source→guard→CLI матрицю для всіх дій, тож T066 лишається відкритою.

Після цих міграції й тестів повний `nice -n 15 npm run verify` завершився
**14/14 gates PASS за 736 с**, **5518 tests PASS, 12 skipped**. Це повний
fast checkpoint до наступного T065 privacy test, без release suite та
без production дій.

Після T065 privacy follow-up адресні `launch-privacy` + `launch-workspace`
**15/15 PASS**, `verify -- --gates=static` **13/13 PASS**. Поточний
повний `nice -n 15 npm run verify` до останнього уточнення SQL регресії:
**14/14 gates PASS**, 5520 tests PASS, 12 skipped, 742 с. Після уточнення
`launch-workspace` **10/10 PASS** та `verify -- --gates=static` **13/13 PASS**
за 45 с; `verification-result.json` відображає саме останній static-only
прогін. Release suite не запускали.

Read-only CLI smoke на **явно локальному** `127.0.0.1:54322` після reset:
`npm run analytics -- audit --period today --json` повернув `ok=true`,
`team.launches.status=uncovered`, `missing=[launch_evidence_in_period]`,
`samples=0`. Пароль створено лише для локальної `wishly_analytics_ro`;
production URL не використовувався. Це коректне відображення порожнього
beta fixture, **не** доказ producer→CLI live generation чи feature health.

T066/T065 реальний PostgreSQL diagnostic regression: synthetic failed
generation без active revision спершу ламав `npm run analytics -- inspect`
помилкою `Invalid Launch diagnostic projection`. Причина: SQL вираз
`active_revision_id = revision_id` повертав `NULL`, а CLI контракт вимагав
boolean. Forward migration `20261202126000` використовує `coalesce(...,
false)` без розширення проєкції. `launch-workspace` regression **10/10 PASS**,
`beta:reset` застосував увесь ланцюг. Після цього read-only CLI на локальній
beta БД: `inspect` → `database:launch_failed`, stage `accepted`,
`result_is_active=false`; `audit` → 1 synthetic sample. URL із маркером
`SYNTHETIC_CLI_PRIVATE_035`, присутній у protected revision, не з’явився
в JSON команд. Fixture видалено в `finally`; Launch/generation count = 0.
Окрема PostgreSQL регресія також перевіряє перехід проєкції з `false` до
`true` після встановлення активної ревізії, без появи URL; `launch-workspace`
**10/10 PASS** після цього уточнення. Додатково тест читає весь JSON рядок
diagnostic view і перевіряє відсутність synthetic URL та protected
`config`/`original_url`/`generated_url` колонок; **10/10 PASS**.
`npx tsc -p tsconfig.check.json --noEmit` і Prettier check для зачеплених
файлів також PASS.
Це справжній DB projection→CLI proof для synthetic failure, не live
provider/producer generation і не production analytics.

Другий локальний PostgreSQL→read-only CLI probe перевірив одночасно failed
draft і succeeded active revision (обидва synthetic, без Google): `inspect`
дав відповідно `database:launch_failed` / `accepted` та
`database:launch_succeeded` / `result_committed`; `audit` показав
`team.launches.status=partial`, `samples=2`,
`missing=[browser_result_visible]`. Це правильна межа доказу для success
без browser receipt. Маркер protected URL був відсутній у всіх CLI JSON;
обидва fixture Launch видалено, залишок = 0.

Після reset відкрив локальну beta у Chrome: вхід через beta test account
пройшов, `Beta Workspace` видно в lobby, але він зупиняється на кроці 2/2
«Підключіть папку Google Drive». Візуально перевірено цей екран. Підключення
Drive у fixture відсутнє, тому живий Launches flow після reset не запускали;
відповідні acceptance пункти лишаються відкритими.

Наступний Chrome beta прохід відкрив явний маршрут
`/team/<beta-team-id>/launches` без завершення Drive wizard. Для методу
«Інше» перевірено UI validation порожнього Generate (польові warning,
без генерації), Save Draft → новий Launch ID → reload з тими самими URL,
alias, бюджетами й датою → Copy Draft з окремим Launch ID → дві картки у
списку → archive кожної через UI → порожній список після server refresh.
У локальній PostgreSQL обидва test Launch мали `archived_at` і не мали
active result; після перевірки test rows видалено, залишок = 0. Це живий
browser+RPC доказ для draft/copy/archive частини AC-33/34/44, не доказ
Generate Other, зміни календарної доби чи Drive side effects: beta fixture
не має РК/креативу/підключеної Drive папки. Chrome залишено на порожньому
списку Launches.
Код `drive-ops/index.ts` підтверджує межу: навіть метод «Інше» перед
`service_accept_launch_generation` викликає `proveLaunchSource`, що читає
поточний файл із Google Drive і звіряє identity/version/checksum. Локальні
рядки РК/матеріалу без чинного Drive файлу не можуть чесно довести Generate;
підставляти fake provider receipt у beta не слід.
Окрема `launch-other` regression тепер перевіряє typed `SOURCE_CHANGED`
саме на `proveSource` boundary: `service_accept_launch_generation` не
викликається, помилка зберігає діагностичний код. `launch-other` **8/8
PASS**, TypeScript/Prettier/diff checks PASS.

T037/T044 provider pagination regression: Google Drive
[`permissions.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list)
повертає `nextPageToken` на shared drives. Старий `listAnyonePermissions`
читав лише першу сторінку, тож cleanup після втраченої DELETE відповіді міг
помилково позначити точний anyone grant як видалений, якщо він був далі.
Нова regression спершу впала (`[]` замість grant на сторінці 2). Drive
adapter тепер читає всі сторінки в межах 50, відхиляє malformed/cyclic
token і не повертає частковий результат; recovery regression лишає
`pending`, коли grant на сторінці 2 пережив втрачений DELETE reply.
Зачеплені Drive/catalog/recovery тести, включно з cyclic-token кейсом,
**102/102 PASS**. `verify -- --gates=static`
**13/13 PASS** за 57 с. Live Google fault matrix усе ще відкрито.

Після Drive pagination fix повний `nice -n 15 npm run verify` завершився
**14/14 PASS** за 796 с: **5524 tests PASS, 12 skipped**. Це fast suite,
без `verify:release`, packaged beta чи production дій. `verification-result.json`
має відповідний останній fast verdict. Під час запуску стежили за load і
пам’яттю; після статичної фази тестовий воркер працював без зависання.

Наступний Drive pagination edge-case: `nextPageToken: ''` у звичайному
listing і `nextPageToken: ''`/`0` у bounded Launch marker lookup більше не
вважаються завершеним пошуком. Спершу нові тести відтворили хибний success;
після виправлення `drive-listing-integrity`, `launch-drive-upload-marker`,
`launch-catalog`, `launch-recovery` — **49/49 PASS**. Повний fast verdict вище
отримано до цієї додаткової зміни; після неї static **13/13 PASS** за 63 с.
Останній `verification-result.json` містить static verdict. Live Google fault
matrix досі відкрито.

Суміжний `changes.list` parser теж відхиляє присутні некоректні або порожні
`nextPageToken`/`newStartPageToken`, щоб синхронізація не прийняла хибний
cursor/checkpoint. Нові чотири cases спершу відтворили помилку; після fix
`drive-listing-integrity`, `catalog-sync`, `catalog-sync-completeness` і
`launch-recovery` — **71/71 PASS**. Це локальна перевірка адаптера, не
provider fault matrix.

Після обох додаткових cursor fixes повний `nice -n 15 npm run verify`:
**14/14 gates PASS** за **792 с**, **5530 tests PASS, 12 skipped**.
`verification-result.json` містить цей останній fast verdict. Це не
`verify:release`, packaged beta або live Google acceptance.

Privacy follow-up після повного verify: UI refresh з `PERMISSION_DENIED`,
`SPACE_BLOCKED` або `NOT_FOUND` тепер очищає старий protected Launch detail;
retryable read error залишає несейвлену RAM чернетку. Новий тест спочатку
відтворив залишення URL після revoked read. Після fix
`launch-workspace-ui` **25/25 PASS**, разом із `launch-privacy` **31/31 PASS**.
Static після цієї правки **13/13 PASS** за 58 с; останній
`verification-result.json` тепер містить static verdict. Повний fast verdict
вище був до UI fix. Live browser storage inspection лишається відкритим.

Chrome beta 16.10 follow-up: штатний UI показав порожній Launch list і нову
форму з default date 17.10; синтетичний URL уведено лише в unsaved form.
Після натискання «Скасувати» з’явився штатний confirm «Є незбережені зміни».
Chrome automation втратила доступ до стану вкладки під час підтвердження;
тому результат discard/reopen і браузерне сховище тут **не перевірені**.
Синтетичний URL `example.invalid` не відправлявся генератору.
Замість недоведеного browser discard додано React acceptance: dirty new draft
залишається після відхиленого confirm, після прийнятого confirm новий mount
порожній, sentinel відсутній у local/sessionStorage. `launch-workspace-ui`
**26/26 PASS**, з `launch-privacy` **32/32 PASS**; це не підміняє live Chrome
reopen доказ.

Protected detail recheck тепер очищає попередній result і RAM draft при
будь-якій non-retryable `TeamApiError`, включно з malformed `INVALID_RESPONSE`;
retryable error залишає локальні правки для повтору. У UI regression
перевірено `PERMISSION_DENIED`, `SPACE_BLOCKED`, `NOT_FOUND`,
`INVALID_RESPONSE` і retryable case; `launch-workspace-ui` **29/29 PASS**,
разом з `launch-privacy` **35/35 PASS**. Ця зміна після останнього static
verdict; новий static запуск **13/13 PASS** за 37 с. Останній
`verification-result.json` містить цей static verdict; повний fast verdict
14/14 вище передує privacy UI changes.

Revision switching follow-up: delayed protected read раніше залишав на
екрані попередній result після зміни URL на іншу revision. Новий UI test
спершу відтворив поточний result під історичним URL. `LaunchSpace` тепер
показує detail лише для того самого launch ID і запитаної revision; обидва
напрями current↔historical перевірено. `launch-workspace-ui`,
`launch-history`, `launch-privacy` — **45/45 PASS**. Повний fast/static
verdict вище передує цій правці; після виправлення тестової фікстури
static **13/13 PASS** за 43 с, це останній `verification-result.json`.
Live Chrome switching не підтверджено.

Same-Launch revision navigation: dirty RAM draft раніше обходив confirm,
оскільки guard звіряв лише launch ID. Новий тест відтворив перехід на
історичний URL попри відхилений confirm. Guard тепер також звіряє revision ID:
відхилення лишає URL і правки, прийняття дозволяє перехід.
`launch-workspace-ui` **31/31 PASS**. Browser back/forward guard окремо не
підтверджений цим тестом; live Chrome лишається відкритим. Суміжні
`launch-workspace-ui`, `launch-history`, `launch-privacy` **46/46 PASS**;
static після правки **13/13 PASS** за 48 с, це останній
`verification-result.json`.

Browser history follow-up: `popstate` раніше обходив dirty guard повністю.
Новий Host/useBrowserRoute тест відтворив втрату URL чернетки при відхиленому
confirm. Router тепер посилає той самий cancellable before-navigation signal
для Back/Forward; cancel відновлює поточний URL без unmount, accept переходить
до списку. `launch-workspace-ui` **32/32 PASS**, суміжні Launch/launcher
**57/57 PASS**, team navigation/finance **14/14 PASS**. Static/full fast після
цієї спільної router правки: static **13/13 PASS** за 38 с. Live Chrome
лишається відкритим.

Після shared router `popstate` guard повний `nice -n 15 npm run verify`:
**14/14 gates PASS** за **753 с**, **5539 tests PASS, 12 skipped**.
Останній `verification-result.json` тепер містить цей fast verdict. Це не
`verify:release` і не packaged/live beta acceptance.

Local beta analytics audit (16.10): `.env` CLI target налаштований на
production pooler, тому для цього probe явним environment override обрано
тільки `wishly_analytics_ro@127.0.0.1:54322` з локальним тимчасовим
паролем. `npm run analytics -- audit --period 30d --json` → `ok:true`,
`team.launches.status=uncovered`, `missing=[launch_evidence_in_period]`,
`samples=0`. Це очікуваний чесний висновок для beta fixture без generation;
не доказ повного producer→CLI trace. Production CLI/дані не читали.

Launch `inspect` authority follow-up: додано conflicting browser
`team_launch_terminal=success` поруч із DB `failed` і поруч із
`canceled_with_cleanup_pending`. `inspect` тепер явно бере terminal із
авторитетного Launch diagnostic row: `failure` для failed, `null` для
unsettled cleanup; browser event залишається у events як окреме свідчення.
`launch-analytics`, `analytics-inspect-command`, `analytics-audit-command`
**43/43 PASS**. Ця зміна після останнього повного fast verdict; static
**13/13 PASS** за 38 с, це поточний `verification-result.json`.

CLI timestamp/privacy follow-up: DB `timestamptz::text` нормалізовано до
UTC ISO для Launch generation і `inspect` terminal. Новий regression спочатку
довів, що malformed step timestamp з synthetic secret проходив дослівно через
`getLaunchEvidence`; тепер він стає `unknown` з `unexpected` blind spot.
`launch-analytics` + inspect/audit commands **43/43 PASS**. Це після
попереднього static verdict; новий static **13/13 PASS** за 38 с і є поточним
`verification-result.json`. Live producer→CLI все ще відкритий.

16.10 Chrome beta календарний smoke: новий незбережений Launch показав
default `launchDate=2026-10-17` при локальній даті 2026-10-16. Чисту
чернетку закрито без запису; список лишився порожнім. Це підтверджує
новий default після фактичної зміни локальної доби, але не replay копії,
започаткованої попереднього дня.

Chrome beta Drive opt-in follow-up: локальні `.env.beta` та
`supabase/functions/.env.local` мають усі задокументовані OAuth/Picker
ключі (перевірено лише наявність, без виводу значень). Кнопка підключення
перейшла до Google account chooser для `Soty Beta` з redirect на локальний
`127.0.0.1:54321`; callback/consent не завершували, жоден акаунт не обрано.
Живі provider сценарії через це досі не мають доказу. `beta:doctor` при
активній беті повернув тільки `BETA_PORT_IN_USE` для 43140/5175; `lsof`
підтвердив loopback listeners. Для повторного doctor не треба гасити
працюючу beta сесію.

Раніший static checkpoint до beta bring-up: `nice -n 15 npm run verify
-- --gates=static` — **13/13 PASS** за 56 с; `git diff --check` — PASS.
Тоді `npm run beta:doctor` ще повертав `BETA_PORT_IN_USE (5175)` і
`BETA_PREREQUISITE_MISSING`; ці перешкоди усунуто в описаному вище beta
runtime slice.

T029/T067 локальний зріз: `launch-other` + `launch-ui` + `launch-analytics`
**36/36 PASS**; `launch-generators` + `launch-progress` **15/15 PASS**,
включно з автоматичним порогом 50 мс для preview N=100. Це не є виміром
браузерної взаємодії або end-to-end beta; MVP journey і producer→CLI live trace
залишаються відкритими.

1. Після закриття локальних acceptance задач зафіксувати clean commit на
   `beta`. Локальний PostgreSQL підтвердив повний порядок міграцій і
   795 pgTAP, але production migration gate залишається окремим. Застосовувати
   увесь лексикографічний ланцюг `supabase/migrations/`, зокрема Launch
   20261201110000–20261201193000 і пізніший RLS guard
   20261202123000 і assignee projection 20261202124000, без вибіркового ручного пропуску. Перед web rollout
   перевірити shared/agent/Edge compatibility чинними build/contracts та
   локальним beta з реальною авторизацією.
2. Beta порт 5175 звільнено й beta 035 піднято; `beta:doctor` і `beta:reset`
   пройдені на поточному worktree. Далі потрібні source/Drive acceptance
   AC-01–46 і, після окремого clean commit для promotion, `beta:down`,
   `beta:package`, `beta:verify` на тому самому clean SHA. Тільки успішний packaged runtime journey
   записує exact-SHA `release/beta/verification.json`; наразі такого доказу
   для цього worktree немає.
3. Production rollout залишається окремою дією за `docs/PRODUCTION.md`
   після закриття tracker signed-URL compatibility, політики доступу до
   CAPI URL у anyone-reader Sheet та live Drive recovery matrix. Цей
   quickstart не є дозволом виконувати deploy/tag/release.
4. При несправності спершу зупинити нові Launch generation і перевірити
   durable states/ownership через read-only diagnostics. Web rollback
   робити лише за чинним production runbook і після compatibility check:
   уже застосовані SQL migrations та Drive side effects не відкочуються
   автоматично разом із web. Не видаляти shared source, попередній каталог
   чи артефакт з невідомим ownership; лишати `cleanup_pending` до fenced
   recovery або forward fix. Для schema/agent incompatibility готувати
   окрему forward migration/release, а не ручне видалення Launch таблиць.

### 16.10.2026 — повторна перевірка після діагностичних правок

- `nice -n 15 npx vitest run tests/launch-analytics.test.ts --maxWorkers=1`:
  21/21 PASS. Окремий послідовний прогін UI/privacy/generators:
  `launch-workspace-ui`, `launch-ui`, `launch-privacy`, `launch-generators` —
  57/57 PASS. Це підтверджує локальні регресії, а не live Google/Drive.
- Повторне підключення до тієї ж Chrome beta вкладки завершилось CDP timeout
  на `Emulation.setFocusEmulationEnabled`; після цього не заявляємо browser
  PASS для discard/reopen, clipboard/result, reduced motion чи storage.
  Beta stack лишився піднятим для подальшої візуальної прийомки в Chrome.
- Перевірка поточної beta: web `127.0.0.1:5175` і agent
  `127.0.0.1:43140/health` відповідають HTTP 200. Базовий seed розширено
  РК `g1`/`1234567892`, офером `ProCaps TR` і Buyer `patrik`; він повторно
  застосований до локальної beta без reset. Другий replay PASS, усі чотири
  записи присутні, а `list_team_accounts`/`list_launch_dictionaries` читають
  їх від імені fixture користувача через чинний authenticated/RLS шлях.
  Drive material лишається відсутнім, тому цей seed сам по собі не доводить
  Generate → result. За `docs/BETA.md` потрібне окреме тестове Google OAuth
  підключення й наданий Drive доступ.
- Read-only стан локальної beta після seed: `connected_drives=0`,
  `indexed_videos=0`, `active_launches=0`. Повторне підключення до тієї ж
  вкладки Chrome знову завершилось timeout на
  `Emulation.setFocusEmulationEnabled`; browser acceptance не підтверджена.
- Поточний worktree пройшов `nice -n 15 npm run verify` після виправлення
  форматування `docs/BETA.md`: 14/14 gates, 5539 tests PASS, 12 skipped,
  `verification-result.json` має `ok: true`, form `fast`. Це не release suite
  і не доказ зовнішнього Drive сценарію.

### 16.10.2026 — Chrome beta прийомка Launches

- У Chrome beta з реальною локальною авторизацією підключено Drive та
  проіндексовано тестове відео `HR17_restitched.mp4`. Сценарій **Other**:
  створено Launch із РК, офером, Buyer і Drive creative; генерація завершилась
  станом `succeeded/result_committed`, результат містить три кампанії та
  підставлені SUB1–3. Натискання копіювання показало `Скопійовано`.
- Сценарій **Catalog**: після збереження локальних beta цін і синтетичних
  fallback title/description/image та оновлення джерел новий Launch завершив
  генерацію `succeeded/result_committed`; локальна база містить каталог із
  трьома товарами, а браузер показав посилання Google Sheet і рекламний URL.
  Копіювання посилання показало `Скопійовано`. Вміст clipboard окремо не
  прочитано, тому це підтвердження UI feedback і видимого результату.
- До цього дві невдалі спроби каталогу виявили неочевидні залежності від
  налаштувань ціни та текстових/зображувальних ресурсів. UI тепер перевіряє
  їх перед Generate, пояснює нестачу й веде в налаштування каталогу. Одна
  скасована спроба лишилась у `canceled_with_cleanup_pending` з
  `LAUNCH_RESULT_UNCERTAIN`; фоновий recovery повернув `pending:1`, тому її
  зовнішній cleanup не вважаємо доведеним. Новий успішний каталог незалежний
  від цієї спроби.
- Візуально перевірено desktop і 390×844: непрозорі поверхні, вирівняні
  секції, компактний editor, читабельний result, однорядкова мобільна панель
  дій, чисті числові поля, навігація зі стрілкою, `scrollWidth=390` та жодне
  поле копіювання не має прихованого переповнення. Незалежний оглядач після
  чотирьох циклів зауважень оцінив кінцевий стан **9,8/10**. Це beta UI
  acceptance, не production promotion чи повна зовнішня fault matrix AC-01–46.
- Після UI змін static gates у повному `nice -n 15 npm run verify` пройшли;
  suite знайшов старі очікування тексту кнопок. Тести оновлено за фактичною
  доступною назвою та значенням result. Повторний
  `nice -n 15 npm run verify -- --gates=suite` завершився **2/2 gates PASS,
  5540 tests PASS, 12 skipped**. `prettier --check` змінених файлів,
  design-token і Tailwind checks та `git diff --check` — PASS. Release form не
  запускався за beta-only обмеженням власника.

### Regression: Launch image-pool scope and stage cells (2026-10-16)

1. In beta space settings, select one usable Drive image for each enabled re-stitch slot. Create a catalog Launch with re-stitching. The owner and a member inheriting the space settings must draw these images; a member explicitly using personal settings must draw their own pool.
2. Retry preparation before starting native work: the same frozen draw and process key must return. Change an enabled source before requesting a redraw: it must stop with `SOURCE_CHANGED`. A genuinely empty configured pool must persist `RESTITCH_POOL_EMPTY` at `restitch_preparing`, visible in the restricted diagnostic projection.
3. The recovery button opens `settings=1&tab=restitch` and preserves `launch` and `launchTab`. Return after correcting the images, refresh sources, and generate explicitly.
4. Observe Preparation → Video → Catalog → Result cells with the current action below them. Encoding at 100% must leave upload/finalization unfinished. A durable finalized-video receipt keeps Video complete when catalog planning resumes. Offline/quiet states retain last-confirmed status and an explicit bounded status read.
5. Delay a coordination reply past 30 seconds or cancel while granting image access: no late reply may start a new child. Native processing itself has no network-reply deadline. The two slot grants begin concurrently and preserve slot order.
6. Click the card heading, date and padding; each opens the Launch once. Checkbox/menu actions remain independent, and Enter on the main opening button works.

Automated evidence: `launch-state`, `launch-restitch-runner`, `team-restitch-screens`,
`launch-progress`, `launch-generation-hook`, `launch-ui`, `launch-workspace-ui` tests.
The SQL test first reproduced `RESTITCH_POOL_EMPTY` with two configured images before
migration `20261202134000_launch_restitch_pool_scope.sql` corrected the lookup.
The read-only beta CLI reports `analytics_disabled`; beta UI checks are not production
telemetry or a packaged-beta promotion record. Parallel grant preparation removes one
serial network wait; no end-to-end media speedup factor is claimed.

Beta acceptance for this correction: applied only the pending local migration above,
without a reset. The open space showed one eligible image in each enabled slot.
Clicking the card heading opened the Launch; the settings route opened the image
section. The stage-cell component was inspected in the design gallery with four
cells and its status caption below. The user's original saved draft was preserved;
no new Drive output was generated during this check. Refresh the page and, for an
older saved source snapshot, explicitly refresh sources before retrying.

Validation: the latest focused SQL, coordinator, workspace-route and token tests
passed (94 tests), as did the URL and revision tests (21) and diagnostic code-map
tests (10). All static gates passed. The broad suite is not fully green: the
existing built Launch chunk exceeds its size budget (23,634 versus 20,000 gzip
bytes), `static-edge-cache.ts` is absent from the critical-module inventory, and
`catalog-image-sharing.test.ts` has a real timer outside the suite's permitted
cases. These unrelated budgets and inventories were not weakened. A fresh full
verification remains required before promotion; this is local beta acceptance.

### Regression: regenerate changed inputs (2026-10-17)

The SQL regression first failed when changing only the lower duration bound:
`get_launch_restitch_reuse` returned the old video. Both video and catalog guards
now compare active duration fields, including both bounds and the center. The
actual processing revision must match too, so another generation repairs a
historically mislabeled reused video. A second regression reproduced the reuse
probe advancing to catalog registration before declining reuse; it now remains
in preparation until a reference is proven.

Acceptance covers changed bounds, center, mode, disabled restitch, creative,
source bytes and file identity, selected restitch image/defaults, URL, product
count, catalog title/price/image, names/budgets and unchanged inputs. SQL/shared
parity covers all five duration modes with enabled and disabled restitch. New
preparations use a distinct process key and bounded duration; request replay
retains that exact preparation.

The local beta diagnostic CLI confirmed the reported launch had a new catalog
referencing the preceding generation's video operation. Migration
`20261202135000_launch_reuse_input_identity.sql` was applied locally without a
reset. `reuse_evidence` was read back through `inspect --json`; production and
external Drive outputs were not modified during this verification. The real
media encode/upload cycle is still a manual beta acceptance step.

Validation for this correction: 123 tests passed across `launch-state`,
`launch-duration-bounds-db`, `launch-revisions`, `launch-catalog-execution`,
`launch-restitch-runner`, `launch-generation-hook`, `launch-shared-parity`,
`launch-analytics`, and `analytics-code-map`. All 13 static verification gates
passed. The follow-up checkpoint correction is
`20261202136000_launch_reuse_checkpoint.sql`. This does not supersede the broad
suite limitations or packaged-beta promotion requirements recorded above.
