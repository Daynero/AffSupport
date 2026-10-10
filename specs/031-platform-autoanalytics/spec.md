# Feature Specification: Агентна автоаналітика та діагностика всієї платформи

**Feature Branch**: не створювалася; специфікація незалежна від гілки

**Created**: 2026-10-09

**Status**: Draft — зведена з незалежним читанням 2026-10-10 ([research.md](./research.md)); ready for planning

**Input**: Власник не відкриває аналітику вручну. Агент має пояснювати, чому конкретний користувач не може запустити Soty, стиснути медіа, підключити простір або виконати будь-яку іншу дію; самостійно знаходити збої, слабкі місця, втрачені ланцюжки спостереження та нові крайові сценарії. Власник отримує лише потрібний короткий висновок або запускає самоаналіз без повідомлень.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Пояснити проблему конкретного користувача (Priority: P1)

Власник повідомляє агенту «цей користувач не може запустити / стиснути / підключити простір». Агент знаходить відповідну спробу, відновлює шлях від наміру до видимого результату, визначає останню доведену успішну стадію, причину блокування та наступну дію без ручного перегляду аналітики власником.

**Why this priority**: основна цінність — розбирати реальну проблему, а не лише рахувати події.

**Independent Test**: контрольні спроби запуску, стиснення й підключення простору з відомими збоями; агент отримує лише користувача та приблизний час.

**Acceptance Scenarios**:

1. **Given** відома помилка запуску, **When** агент діагностує користувача, **Then** результат містить стадію, стабільну причину, докази, версії, вплив і дію відновлення.
2. **Given** запит прийнято, але відповідь загубилась, **When** агент аналізує спробу, **Then** він відрізняє втрату відповіді від невиконаної операції та не радить небезпечний повтор.
3. **Given** застосунок не дійшов до першої події, **When** немає незалежних доказів запуску, **Then** результат — «недостатньо даних», із точною сліпою зоною та мінімальним способом отримати безпечні докази; відсутність подій не видається за причину.
4. **Given** кілька одночасних спроб, **When** запит нечіткий, **Then** агент показує кандидатів і невизначеність, не змішує пристрої, команди чи користувачів.

### User Story 2 — Знайти проблеми та ризики без звернення в підтримку (Priority: P1)

Власник запускає самоаналіз за періодом, релізом, користувачем або простором. Агент аналізує помилки, зависання, повтори, деградацію та успішні операції з прихованими проблемами й зберігає пріоритетний набір висновків. У тихому режимі звіт залишається доступним наступному агенту без повідомлень власнику.

**Why this priority**: користувач може піти мовчки, а успішний статус може приховувати втрату результату.

**Independent Test**: набір даних із повторюваним збоєм, одиничним критичним збоєм, повільним відновленням і здоровою малою когортою.

**Acceptance Scenarios**:

1. **Given** кластер невдач нового build, **When** запускається самоаналіз, **Then** він показує кількість унікальних користувачів і спроб, знаменник, базу порівняння, обмеження вибірки та пріоритет.
2. **Given** операції завершені, але результат не доставлений або не видимий, **When** аналізується ланцюжок, **Then** це окрема проблема, а не успіх.
3. **Given** тихий режим, **When** аналіз завершується, **Then** артефакт збережений, повідомлення не надсилаються, production не змінюється.
4. **Given** повторний запуск на тому самому знімку, **When** немає нових доказів, **Then** знахідки не дублюються, а зміна оцінки має пояснення.

### User Story 3 — Виявити сліпі зони самої аналітики (Priority: P1)

Агент перевіряє, чи всі можливості продукту спостережувані, чи можна зв'язати клієнт, локальний застосунок, сервер і провайдера, та чи доказано доставлення подій. Він формує конкретне завдання на відсутній сигнал замість вигаданої першопричини.

**Why this priority**: жодних гарантій діагностики немає, якщо збирач даних сам мовчки падає.

**Independent Test**: видалені terminal events, незв'язані IDs, невідома схема, відставання доставки, стара версія та вимкнена аналітика.

**Acceptance Scenarios**:

1. **Given** старт без завершення, **When** є незалежний завершений стан, **Then** знахідка класифікується як дефект спостереження, а не збій інструмента.
2. **Given** нова можливість без діагностичного покриття, **When** виконується аудит, **Then** вона входить у список непокритих можливостей і блокує повне підтвердження readiness.
3. **Given** дані застарілі чи доступні частково, **When** створюється звіт, **Then** невідомий стан не стає зеленим статусом.

### User Story 4 — Перетворити інциденти на перевірювані виправлення (Priority: P2)

Агент пов'язує реальні спроби з порушеним очікуванням, формує безпечний опис відтворення, регресійний сценарій та вимоги до виправлення або додаткового спостереження. Наступний аналіз перевіряє ефект виправлення на визначеній когорті.

**Why this priority**: знання має накопичуватися між агентами й релізами.

**Independent Test**: інцидент зі sync waiter без поступу до та після виправлення.

**Acceptance Scenarios**:

1. **Given** підтверджений інцидент, **When** агент готує завдання, **Then** воно містить доказові посилання, очікувану поведінку, регресію й критерій перевірки без приватного вмісту.
2. **Given** гіпотетичний новий corner case, **When** агент його записує, **Then** він позначений як гіпотеза та має спосіб підтвердження.
3. **Given** після виправлення немає релевантних спроб, **When** оцінюється ефект, **Then** статус «ще не перевірено», а не «виправлено».

### User Story 5 — Підключено, але файли не можна додати (Priority: P1)

Агент діагностує спільний збій входу до всіх інструментів: загальне підключення зелене, але native file picker не відкривається, drag-and-drop не додає файли або панель налаштувань відсутня. Він відрізняє readiness конкретного інструмента від доступності агента та знаходить місце розриву до початку обробки.

**Why this priority**: реальний кейс 2026-10-09 на Windows, build 1.2.5+70: користувач повідомив, що діалог вибору не відкривається в усіх інструментах; screenshot показує stitcher без налаштувань. Є agent_connected/tool_opened, але немає доказів input attempts та їхніх причин. Першопричина не встановлена; це не підтверджений збій формату чи антивірусу.

**Independent Test**: із працездатним загальним підключенням відтворити невдале читання стану інструмента, блокування запиту, невдалий запуск native picker, завислий/прихований діалог та невдале додавання dropped file.

**Acceptance Scenarios**:

1. **Given** агент доступний, але стан інструмента не завантажений, **When** користувач відкриває інструмент, **Then** діагностика показує помилку/затримку readiness цього інструмента; зелений connection не є доказом його готовності.
2. **Given** натискання вибору файлу, **When** запит не відправлено або не прийнято агентом, **Then** можна визначити останню підтверджену межу та відрізнити UI блокування, транспорт, авторизацію й capability rejection.
3. **Given** picker запит прийнято, **When** запуск завершився помилкою, **Then** є нормалізована причина запуску/завершення; cancel не підміняє failure, а запущений процес не доводить видимість діалогу.
4. **Given** drag-and-drop, **When** файл не додано, **Then** окремо пояснено отримання input, resolution original, доступ, перевірку та відмову або невідоме місце розриву.
5. **Given** підозра на antivirus/OS policy, **When** немає підтверджувального evidence, **Then** вона залишається гіпотезою; агент просить мінімальні безпечні докази, не рекомендує вимкнути захист.

### User Story 6 — Відремонтувати фундамент збору, перш ніж його розширювати (Priority: P0)

Власник хоче вірити цифрам. Сьогодні серверний guard тихо відкидає щонайменше дванадцять ключів, які клієнт шле навмисно (усі `team_storage_*`, `team_index_completed`, `team_previews_ready`, `team_landing_render`, `power_limit_changed`), клієнт після трьох спроб тихо губить подію, 40-елементна черга витісняє найстаріше без лічильника, 42 оголошені імена подій ніде не емітяться, а CLI рахує деякі з них і повертає нулі, які читаються як «добре». Агент не має жодного запису про власні рішення. Перший результат фічі — усунути ці сліпі зони й зробити їх неможливими надалі.

**Why this priority**: будь-яка нова діагностика поверх дірявого збору — фіктивне покриття; аудит релізу 1.2.5 уже прочитав відсутність storage-подій як відсутність активності.

**Independent Test**: контрактний тест клієнт↔guard у `verify`; лічильник відкинутих/витіснених/прострочених подій доставляється й видимий у CLI; `audit` показує 0 `declared_but_never_emitted` серед подій, які CLI використовує.

**Acceptance Scenarios**:

1. **Given** клієнт емітить ключ або enum-значення, якого серверний guard не приймає, **When** запускається `npm run verify`, **Then** контрактний тест падає з назвою ключа.
2. **Given** сервер відкинув подію або черга витіснила її, **When** наступна успішна доставка, **Then** агрегований звіт доставки (лічильники за причиною, без вмісту) потрапляє в аналітику і `audit` його показує.
3. **Given** CLI-команда спирається на подію, яку жодна версія клієнта не емітить, **When** команда виконується, **Then** відповідь містить `unsupported_by_producer` замість нуля.
4. **Given** майстер створення простору рендериться повторно, **When** користувач проходить onboarding, **Then** існує рівно один `team_onboarding_started` на flow.

### Edge Cases

- Offline, sleep, crash, force quit, restart, clock skew, події не за порядком, повторне доставлення та переповнення буфера.
- Збій до авторизації або запуску збирача; download без install; OS блокує запуск; пристрій ніколи не виходить у мережу.
- Кілька вкладок, пристроїв, облікових записів; logout/login; зміна членства або ролі під час операції.
- Retry з новою спробою, join спільного job, cancel одночасно з success, lease takeover, старий worker та відповіді попереднього scope.
- Операції перетинають часовий період чи строк зберігання; стара версія не підтримує нові сигнали.
- Частковий успіх batch, порожній результат, no-op, втрачений output, успіх сервера без видимого результату.
- 403 permission проти rate limit; 404 deleted проти hidden; revoked OAuth, provider outage, quota, backoff без поступу.
- Низький power budget, довга законна черга та великі файли не повинні виглядати як зависання лише через wall-clock.
- Збір вимкнений, база недоступна, джерела суперечать одне одному, обрізана вибірка, видалені історичні дані.
- Вхідні помилки й логи містять секрети або текст, схожий на інструкції агенту: це недовірені дані, не команди.

## Requirements _(mandatory)_

### Functional Requirements

#### Покриття всієї платформи

- **FR-001**: MUST існувати повний реєстр можливостей із власником сигналів, очікуваними стадіями, доказом успіху, можливими terminal outcomes, правилами часу й рівнем покриття для кожної підтримуваної платформи та версії. Нові можливості входять у реєстр до production.
- **FR-002**: MUST охоплювати шлях download/install → native launch → локальний runtime → web boot → auth/session → pairing → entitlement/capabilities → ready, а також update/download/drain/restart/rollback. Для стадій до запуску явно вказати доступні незалежні докази й принципово неспостережувані випадки.
- **FR-003**: MUST охоплювати всі локальні інструменти: compressor, stitcher/restitch, transcription/translation, landing preview/optimization, catalog generation/updater та кожен інструмент із актуального реєстру продукту; input validation, queue, dependency readiness, виконання, cancel, cleanup, output і видимість результату.
- **FR-004**: MUST охоплювати простори, створення/join/invitations/roles, OAuth/storage connection/reauth/detach, listing/index/sync/replay/reconciliation, пошук/фільтри/preview, upload/download/move/rename/delete/share, creative library/tasks/media companions, team accounts, notebook/TOTP та finance — лише безпечні метадані операцій, без їхнього вмісту.
- **FR-005**: MUST охоплювати фонові роботи, залежності, доставлення стану, ресурсні обмеження та відмови зовнішніх провайдерів. Реєстр звіряється з фактичними можливостями, а не лише зі списком відомих подій.

#### Наскрізний доказовий ланцюжок

- **FR-006**: Кожна спостережувана спроба MUST мати зв'язувані ідентичності користувача/анонімної доавторизаційної сесії, інсталяції, boot/session, flow, operation, attempt, parent/dependency та непрямі ідентичності workspace/resource. Зв'язування після auth не може привласнювати історію іншого акаунта.
- **FR-007**: MUST розрізняти намір, локальну валідацію, відправлення, прийняття, queue/claim, поступ, очікування залежності, terminal outcome, збереження/доставлення результату та видимий клієнтом стан. Completion процесу не є доказом корисного результату.
- **FR-008**: MUST розрізняти succeeded, partial, no-op, failed, rejected, canceled, interrupted, blocked, retry-wait, superseded та unknown; нормальне закриття вкладки не означає скасування серверної роботи.
- **FR-009**: MUST зберігати occurrence/receipt time, порядок у джерелі, environment, build identities, platform/capabilities, схему сигналу й підтримку спостереження. Невідомі значення не підміняються поточною версією.
- **FR-010**: Помилка MUST мати стабільний код, stage, джерело, retryability, нормалізований fingerprint, безпечний causal chain, останній корисний поступ та рекомендовану дію. Fingerprint не залежить від user IDs, шляхів або випадкових timestamp.
- **FR-011**: Повтори доставки MUST бути ідемпотентні; retries операції рахуються окремими attempts у межах одного наміру. Batch показує і загальний результат, і часткові outcomes без роздування кількості користувачів.
- **FR-012**: MUST виявляти відсутній terminal outcome, stalled progress, dependency/lease loops, непропорційні retries та stale visible state за правилами конкретної операції; враховувати queue, backoff, sleep, input size і power throttle.

#### Надійність та якість спостереження

- **FR-013**: MUST мати обмежене відновлення доставки після offline/crash із відомими межами буфера, expiry та поведінкою переповнення; показувати lost/rejected/delayed signals, де це доступно. Не обіцяти доставлення з пристрою, який ніколи не повернувся онлайн.
- **FR-014**: MUST незалежно звіряти події з дозволеними authoritative outcomes/jobs, readiness і контрольними сценаріями; збій збирача не повинен маскуватися його власним heartbeat.
- **FR-015**: Кожний результат аналізу MUST містити fresh-through для джерел, період і timezone, schema/coverage versions, unsupported cohorts, sampling/truncation, denominators, missing joins, затримку й достатність даних. Недоступне джерело не повертає нуль замість помилки.
- **FR-016**: Критичні стадії, помилки й terminal outcomes MUST не семплюватися. Частий progress можна агрегувати із зазначенням втраченої точності. Події не повинні блокувати дію продукту; черги, payload і resource cost обмежені.
- **FR-017**: MUST підтримувати аудит coverage: expected vs observed stages, orphan events, duplicate/conflicting terminals, unknown codes, зламані identity joins, drop/lag/schema mismatches і розбіжність event vs authoritative state. Для кожної сліпої зони — вплив і мінімальний потрібний сигнал.

#### Інтерфейс для агентів і самоаналіз

- **FR-018**: MUST розширювати наявний read-only analytics CLI, зберігаючи сумісність його JSON. Агенту доступні діагностика користувача/операції/простору, аудит coverage, платформний самоаналіз і порівняння release/cohort без ad-hoc SQL або ручного dashboard.
- **FR-019**: MUST підтримувати обмежений період, фільтри середовища/build/platform/tool/user/team, pagination та продовження великих читань. Один analysis run використовує фіксований end time; усі часткові читання й ліміти явно відображаються.
- **FR-020**: Висновок MUST відокремлювати факти, гіпотези та невідоме; містити evidence references, confidence із підставами, impacted users/attempts, тяжкість, поточний стан, recovery і наступну перевірку. Жодна причина не вважається доведеною лише через часову кореляцію.
- **FR-021**: Самоаналіз MUST ранжувати recurrent failures, unrecovered users, near misses, деградацію часу/черги, retry amplification, version/provider concentration і дефекти аналітики. Одинична критична втрата/витік/помилкова destructive дія не відкидається через малу вибірку.
- **FR-022**: Порівняння MUST показувати обсяги та зіставність когорт, internal/test activity окремо від реальних користувачів, абсолютну й відносну зміну; мала або незріла вибірка позначається insufficient. Near miss означає виміряне наближення до порога або відновлений небезпечний сценарій, не прогноз без доказів.
- **FR-023**: MUST створювати версіонований, очищений від секретів analysis artifact: scope, source snapshot, findings, evidence, coverage gaps, regression proposals, пріоритети й machine-readable результат. Наступний агент може продовжити аналіз без історії чату.
- **FR-024**: MUST підтримувати короткий summary та тихий режим. Analysis artifact може зберігатися локально; analysis не змінює production data, не запускає роботи на пристроях користувачів, не надсилає повідомлення й не створює зовнішні issues автоматично.
- **FR-025**: MUST мати стійку ідентичність знахідок, стани new/ongoing/regressed/resolved/unverified і посилання на інцидент/виправлення. Resolved потребує релевантних спроб та достатнього покриття після виправлення.
- **FR-026**: MUST існувати інструкція для агента: complaint → candidate attempts → causal evidence → coverage check → diagnosis → safe next action; self-analysis → prioritized findings → reproduction/regression → implementation proposal → post-fix validation. Факти з реальних користувачів та синтетичні відтворення позначаються окремо.

#### Безпека, зберігання та production readiness

- **FR-027**: MUST зберегти SELECT-only роль, forced read-only transactions, SQL guard, bound parameters і allowlisted privacy-scoped views. Додаткове читання станів не використовує production superuser/service credentials.
- **FR-028**: MUST виключати файли/контент, raw paths/names, transcripts, search text, finance amounts/details, notebook/TOTP values, account credentials, tokens, cookies, signed URLs і raw provider payloads. Дозволені bounded size/duration/resource buckets та нормалізовані коди. Санітизація діє перед відправленням і перед експортом доказів; нові поля за замовчуванням заборонені.
- **FR-029**: MUST ізолювати production/beta/dev і дані акаунтів/просторів; development не надсилає production analytics. Діагностика може ідентифікувати користувача через наявний дозволений user lookup, але публічні/зовнішні артефакти використовують непрямі IDs.
- **FR-030**: MUST визначити й перевірити retention: default 30 днів деталізованих очищених доказів, 90 днів агрегатів; локальна недоставлена черга до 7 днів у межах квоти. Видалення акаунта очищує або незворотно анонімізує зв'язувані дані й похідні докази; звіт вказує expired evidence. Ці defaults уточнюються планом лише з явним обґрунтуванням.
- **FR-031**: Production readiness MUST мати матрицю всіх критичних journeys на macOS/Windows, старої/нової сумісної версії та packaged beta exact commit. Кожен ін'єктований збій перевіряє product behavior, remote diagnosis, delivery recovery, privacy і coverage, а не тільки факт emit.
- **FR-032**: MUST використовувати additive rollout, сумісні schemas/commands, оцінений ingestion/storage/query budget, безпечне вимкнення нового збору та rollback без поломки продукту. Новий збір не реконструює неіснуючі історичні докази.
- **FR-033**: MUST формувати readiness verdict ready/blocked/insufficient із явними причинами; непокритий критичний шлях, витік або зламане доставлення блокують готовність. Ця evidence доповнює канонічні beta/production gates, не обходить їх і не дає дозволу на реліз.

#### Вхідні файли, native dialogs та readiness інструментів

- **FR-034**: MUST відстежувати наскрізну спробу додавання input за способом picker/drop/path: UI intent і локальне блокування → відправлення → прийняття агентом → capability/auth validation → виконання → відповідь → застосування стану → видимий input. Відсутній крок означає конкретну coverage gap; ідентифікатор спроби зберігається через межі джерел.
- **FR-035**: Native picker MUST мати докази request accepted, launch attempted, process started або spawn failure, завершення/exit category, selected-count, explicit cancel, timeout/interruption і приєднання до вже відкритого діалогу. Зберігати лише очищені коди й тривалості, без script bodies, command lines, шляхів або назв файлів. Process started не означає dialog visible; якщо видимість/foreground не спостережувані, це явно unknown. Законний час вибору користувачем не класифікується як failure за універсальним коротким timeout.
- **FR-036**: Drop MUST розрізняти прийняття browser input, доступність виду передачі, resolution оригіналу, неоднозначність/not-found, grant/access rejection, inspection/refusal та added-count. Picker і drop одного інструмента діагностуються незалежно; size/extension metadata допускаються лише у дозволених bounded категоріях.
- **FR-037**: MUST діагностувати initial state/settings reads, subscribe/reconnect і apply/visible state для кожного інструмента окремо. Connection healthy при tool state unavailable є degraded, не ready. Silent swallowed read errors входять до coverage audit навіть якщо користувач не почав run.
- **FR-038**: MUST розрізняти OS/process/access errors, endpoint auth/capability failures, відмову перевірки файлу й підтверджене блокування security policy. Антивірус не виводиться лише з access denied/non-zero exit. За відсутності доступних дозволених доказів — hypothesis і мінімальний fallback: час повтору, чи є прихований діалог, нормалізована помилка або відповідний запис protection history, очищений від приватних полів. Не вимагати broad security-log collection, elevation, вимкнення захисту чи автоматичних exclusions.
- **FR-039**: Shared-seam audit MUST перевіряти цей клас збоїв для всіх інструментів, що використовують той самий picker/input/state transport, а не тільки першого повідомленого. Regression matrix включає macOS/Windows, connected-but-unready, spawn refusal, cancel, hidden/unknown visibility, pending joined requests, transport/auth failure, dropped-original-not-found, inspection refusal та успішне відновлення. Не створювати fake run/completion events до реального додавання input.

#### Діагностика середовища та підтримка реального кейсу

- **FR-040**: MUST зберігати окремо authoritative platform локального агента та заявлену browser platform/mobile mode, з походженням і часом кожного сигналу. Розбіжність Windows agent / Android browser є діагностичною ознакою, не доказом фактичного Android-пристрою, antivirus block або причини відмови. Browser/agent identities не зливаються на основі User-Agent; збирати лише allowlisted нормалізовані категорії, не повний fingerprint браузера.
- **FR-041**: MUST відрізняти UI intent, preflight outcome, фактичне прийняття handler-ом, auth/capability decision, очікування native picker та transport failure. Pending/provisional browser headers і успішний preflight самі по собі не доводять, що handler виконується або діалог відкритий. Для підтримки доступні безпечні endpoint category, environment/port role, elapsed time і остання підтверджена стадія без session tokens чи повних headers.
- **FR-042**: MUST давати agent-readable evidence запуску picker: helper available, spawn attempted/started, normalized launch/exit error, pending dialog lifecycle і shared in-flight request. Перевірка hidden/foreground visibility має явний supported/unknown статус; за наявності дозволеного сигналу non-interactive desktop, іншого user context або elevation mismatch він записується категорією без OS username/paths. Відсутність такого сигналу не перетворюється на вигадану OS-причину.
- **FR-043**: Для resolution dropped original MUST пояснювати search coverage: нормалізований location class (Downloads/Desktop/Videos/other local drive/cloud-backed/network/unknown), які дозволені класи перевірено, чи скан завершений, budget exhausted, access denied, no match або ambiguous match, і спосіб безпечного відновлення. Без raw paths/names, directory listings чи contents. «Локальний файл» не означає, що його папка охоплена resolver-ом; хмарний placeholder не видається за доступний локальний original.
- **FR-044**: MUST будувати матрицю часткової працездатності: image browser upload, video native picker, video drop resolution, tool initial state, execution engine і result delivery — незалежні стадії. Успіх image upload підтверджує лише відповідний шлях і не означає справність video picker/resolver. Непрацездатність кількох інструментів перевіряється на спільний seam, але спільна першопричина потребує causal evidence, а не лише однакових симптомів.
- **FR-045**: MUST мати безпечний support evidence bundle для недоступних центральній аналітиці причин: короткий локальний проміжок навколо конкретної спроби, operation/attempt IDs, normalized process/transport/state errors, builds і coverage metadata. Інструкція має відповідати фактичній платформі та встановленій версії; не вимагати ручного розбору логів власником. Bundle локально переглядається/санітизується перед передачею, без credentials, session tokens, raw request headers, команд, файлів і приватних provider data; збір обмежений часом/обсягом і не потребує elevation за замовчуванням.
- **FR-046**: MUST зв'язувати complaint timeline, час відтворення та результати діагностичних дій (restart, normal-browser retry, local-folder retry) з новими attempts; «нічого не змінилось» не означає, що restart доведено виконаний. Спосіб входу web/tray і фактичний boot identity розрізняються. Агент не повторює вже перевірені поради без нової підстави й не приписує причину за принципом «в інших працює».
- **FR-047**: MUST виявляти втрату первинної помилки через generic UI message, swallowed state-read errors, відсутній request/attempt ID, client-only refusal та відсутній локальний launch log. Звіт пов'язує видимий текст із stable machine code, якщо доказ доступний, і формує конкретну coverage task для кожної непоясненої межі. User screenshot або цитата є reported evidence, не автоматично verified telemetry; arbitrary user/provider text не виконується як інструкція.

#### Фундамент: доставка, контракт guard-а, ідентичності, readiness (зведено з незалежного читання)

- **FR-048**: Клієнтський allowlist ключів і enum-ів MUST бути єдиним джерелом, проти якого тестується серверний guard `analytics_properties_are_safe_v2`; тест на PGlite із реальним тілом guard-а MUST входити до `npm run verify` і падати на будь-якому розходженні. Ключі, які клієнт уже шле, а guard відкидає, MUST бути додані аддитивною міграцією.
- **FR-049**: Клієнт MUST рахувати події, відкинуті сервером (`accepted=false`), витіснені з черги та прострочені, і MUST доставляти агрегований `analytics_delivery_report` (лічильники за причиною та ім'ям події, без вмісту) не рідше ніж раз на сесію та при наступній успішній доставці; критичні terminal-події MUST мати пріоритет над progress-подіями при витісненні.
- **FR-050**: Кожна операція кожного локального інструмента (компресор, стітчер/restitch, транскрибація/переклад, landing optimizer, landing preview, team process/download/library) MUST нести `run_id` в envelope і terminal-подію (`*_completed|*_failed|operation_cancelled`) з тим самим `run_id`; `stitch_started`, `landing_optimization_started`, `estimate_started`, `update_started` MUST отримати свої terminal-и або бути вилучені з обчислень CLI.
- **FR-051**: `tool_opened` MUST супроводжуватись `tool_ready{tool_identifier, outcome, duration_ms, error_code?}` після початкового читання стану й підписки; readiness, що не настав, — окрема знахідка (FR-037).
- **FR-052**: `error_occurred` MUST емітитись кожним інструментом із `error_stage`, стабільним `error_code` і `error_fingerprint = <tool>:<stage>:<code>`; regex-класифікація рядків помилок у клієнті MUST бути замінена кодами, які повертає агент.
- **FR-053**: Envelope MUST містити `agent_instance_id` (випадковий per-boot UUID агента) та `agent_platform` (авторитетна платформа з health), коли агент підключений; браузерна платформа лишається окремим полем; жодне з них не є PII.
- **FR-054**: Агент MUST вести локальний bounded журнал діагностичних фактів (ring buffer ≤ 2 000 записів / ≤ 1 МБ; нормалізовані категорії spawn/exit, picker lifecycle, drain/shutdown причина, рішення token/entitlement, stream subscribe/evict; без шляхів, назв, команд, секретів) і віддавати його через `/api/diagnostics?since=<seq>`; веб MUST уміти зібрати з нього support-bundle, показати користувачеві повністю і лише тоді дати скопіювати (FR-045).
- **FR-055**: CLI MUST підтримувати `--as-of <iso>` (фіксований кінець періоду для повторюваного аналізу) і повертати `delivery_lag` (p50/p95 `created_at − occurred_at`) у кожній агрегуючій відповіді; `journey` MUST застосовувати period за замовчуванням і санітизувати властивості тим самим allowlist-ом, що й клієнт.
- **FR-056**: CLI MUST мати команди `audit` (реєстр можливостей vs спостережені події за період: `covered|partial|uncovered|declared_but_never_emitted`; orphan starts; unknown codes; лічильники відкинутого; builds без покриття; записує артефакт `specs/031-platform-autoanalytics/analysis/<date>.json`) та `inspect <flow_id|run_id>` (повний ланцюжок однієї спроби з усіх інструментів); обидві read-only.
- **FR-057**: Retention MUST бути реалізований міграцією: деталізовані події зберігаються 90 днів, щоденні агрегати (`analytics_daily_*`, матеріалізація за розкладом) — безстроково; видалення акаунта MUST анонімізувати `installation_id` і `session_id` разом із `user_id`; тест MUST підтверджувати обидва правила. Числа 90/безстроково замінюють 30/90 з FR-030 як узгоджені defaults.

### Key Entities

- **Capability Coverage Record**: можливість, платформи/версії, стадії, owner, джерела доказів, deadline rules і сліпі зони.
- **Attempt / Operation / Flow**: намір користувача, окрема спроба, parent/dependencies, outcomes і видимий результат.
- **Diagnostic Signal**: очищений факт із ідентичністю, порядком, часом, джерелом, версією та quality metadata.
- **Evidence Reference**: стійке посилання на дозволені докази із часом доступності/expiry; не секретний payload.
- **Finding**: факт/гіпотеза/coverage defect, impact, confidence, fingerprint, статус і regression case.
- **Analysis Run**: фіксований scope/snapshot, версія правил, completeness, findings і артефакти.
- **Readiness Record**: матриця сценаріїв, exact build identities, результати перевірок, blocked/insufficient reasons.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% зареєстрованих критичних journeys мають перевірений success, failure, interrupted/blocked і missing-evidence сценарій на кожній підтримуваній платформі або явний capability exclusion.
- **SC-002**: У наборі щонайменше 30 ін'єктованих збоїв (не менш як 10 startup/auth/update, 10 local tools, 10 workspace/provider) агент визначає правильну стадію й причину для всіх випадків із достатніми доказами; для всіх решти чесно визначає конкретну сліпу зону. Жодної вигаданої доведеної причини.
- **SC-003**: Після отримання доступних доказів діагностика одного користувача формується до 2 хвилин, аналіз 7 днів при 35 користувачах / 100 000 signals — до 5 хвилин; більші вибірки завершуються частинами з явним прогресом і лімітами.
- **SC-004**: При здоровій мережі 99% критичних signals доступні для діагностики до 2 хвилин; після повернення онлайн буфер у межах квоти доставлений до 5 хвилин. Втрати/expiry не приховуються як відсутність діяльності.
- **SC-005**: У контрольному наборі всі вставлені missing joins, terminals, conflicting outcomes, stale sources і schema rejects виявлено; жодний unknown/insufficient не дає ready verdict.
- **SC-006**: У privacy та isolation перевірках немає заборонених значень у зібраних даних, CLI output і analysis artifacts; усі спроби production writes через аналітику відхиляються.
- **SC-007**: Повторний аналіз незмінного snapshot не створює дубль findings; після виправлення підтвердження містить кількість релевантних attempts, вік спостереження та покриття.
- **SC-008**: Тихий режим у 100% перевірок створює артефакт без зовнішніх повідомлень або production side effects; короткий режим пояснює impact, причину/невідоме та наступну дію без ручної навігації власника.
- **SC-009**: Вимкнений або недоступний збір не змінює outcomes продукту; при контрольному навантаженні збір збільшує p95 часу інтерактивної дії не більш як на 5%, залишається у задокументованих квотах пам'яті/диска/мережі.

- **SC-010**: У матриці FR-039 кожна ін’єктована помилка має зв’язуваний input attempt і правильну останню доведену стадію; cancel, pending user interaction, launch failure та unknown visibility не змішуються. Для кожного інструмента зі спільним механізмом перевірено healthy та connected-but-unready сценарії; жодна непідтверджена security-block гіпотеза не стає доведеною причиною.

- **SC-011**: На контрольному кейсі connected Windows agent + Android browser identity + successful image upload + pending video picker + dropped-original-not-found агент правильно розділяє п’ять фактів, не оголошує OS/antivirus спільною доведеною причиною, визначає потрібний локальний evidence bundle та search coverage. Після повтору й restart історія містить окремі attempts; відсутні докази залишаються unknown. Bundle privacy checks не знаходять токенів, raw paths або вмісту.

- **SC-012**: `npm run verify` падає, якщо клієнт емітить ключ або enum-значення, якого серверний guard не приймає; на момент злиття відомі 12 таких ключів усунені.
- **SC-013**: Через 7 днів після релізу частка відкинутих сервером подій відома і < 0,1%; `team-workspace` показує ненульові storage-метрики за наявності реальних підключень.
- **SC-014**: `audit` за період показує 0 `declared_but_never_emitted` серед подій, які CLI використовує в обчисленнях; решта позначена `unsupported_by_producer`.
- **SC-015**: `errors` показує `error_stage ≠ unknown` для ≥ 95% кластерів нового релізу по кожному локальному інструменту.
- **SC-016**: `inspect <run_id>` відновлює ланцюжок від `tool_opened` до terminal для 100% контрольних прогонів на беті для компресора, стітчера, транскрибації, landing optimizer і restitch; `link` journey (032) включно.
- **SC-017**: Повторний `audit --as-of` на незмінному snapshot дає ідентичний артефакт; `delivery_lag` присутній у кожній агрегуючій відповіді.

## Capability Coverage Registry — форма

Машинно-читаний реєстр `scripts/analytics/coverage-registry.ts` (тестований): для кожної можливості — стадії, start/terminal події з ідентифікатором кореляції, readiness-подія, error-подія, платформи, принципово неспостережувані стадії. `audit` звіряє реєстр із фактом. Приклад:

```text
capability: compressor.run
  stages: input_add → estimate → start → progress → terminal → result_visible
  start_events: compression_started (run_id)
  terminal_events: compression_completed | compression_failed | operation_cancelled (run_id)
  readiness: tool_ready{tool:compressor}
  error_event: error_occurred{tool:compressor}
  platforms: macos, windows
  unobservable: result file opened outside Soty
```

## Пріоритети реалізації

1. Ремонт guard-а і доставки + контрактний тест (FR-048, FR-049, SC-012).
2. Terminal-події, `run_id`, `error_occurred`, `tool_ready` для кожного інструмента (FR-050…FR-052).
3. З'єднання/pairing/update lifecycle — виконано у 032.
4. Envelope: `agent_instance_id`, `agent_platform` (FR-053).
5. Локальний журнал агента + `/api/diagnostics` v2 + bundle (FR-054, FR-045).
6. CLI: реєстр, `audit`, `inspect`, `--as-of`, `delivery_lag`, `unsupported_by_producer` (FR-055, FR-056, FR-018…FR-022).
7. Retention (FR-057).

## Виміряний стан на 2026-10-10 (read-only, 30 днів)

| Факт                                    | Значення                                                                | Що означає                                              |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `team-workspace` storage                | connected 0, index 0, previews 0, attention 0                           | подій немає в базі, хоча клієнт їх шле — guard відкидає |
| SC-001 onboarding                       | 4 спроби, 0 успіхів, `insufficient`                                     | роздуто фантомними стартами з повторних рендерів        |
| `cohorts --cohort-by local-app-version` | когорта `unknown`: 27 користувачів, 2 800 подій, 0 успіхів/невдач       | події без контексту агента; не «здорова когорта»        |
| `errors`                                | усі кластери `error_stage=unknown`, `fingerprint=unknown` крім стітчера | жоден інструмент, окрім стітчера, не каже, де впав      |
| `events`                                | `agent_connected` 554 проти `agent_disconnected` 32                     | розриви невидимі (закрито в 032)                        |
| `features`                              | лише маркетингові impressions                                           | `feature_*` майже не емітяться                          |

## Assumptions

- Основний споживач — coding agent; складний машинний контракт бажаний, dashboard не є вимогою. Власник отримує стислий висновок.
- Це специфікація, а не реалізація чи дозвіл на production зміни. Автономний аналіз read-only; виправлення коду й реліз проходять власні чинні workflows.
- Самоаналіз запускається явним запитом або вже авторизованим automation; новий постійний scheduler і повідомлення власнику не входять у базовий scope.
- Неможливо дистанційно довести OS-level failure на пристрої, який не видав жодного сигналу. Передбачено безпечний fallback evidence bundle за участі користувача; власнику не потрібно вручну відкривати аналітику.
- Privacy-first модель Soty зберігається. Деталізація означає причинні метадані, не збір вмісту користувача.
- Numeric budgets є приймальними цілями цієї фічі, не заявою про поточну систему; план визначає методику вимірювання.

## Existing Foundation & Dependencies

- [Analytics CLI](../../docs/ANALYTICS_CLI.md), `scripts/analytics/`, event v2 та typed web analytics — існуюча база. Розширювати її, не створювати паралельний analytics backend.
- [028 manual sync lifecycle](../028-manual-sync-lifecycle/spec.md) і [026 reliable folder sync](../026-reliable-folder-sync/spec.md) визначають authoritative sync states; ця спека додає наскрізну діагностику, не змінює їхні workflows.
- [Sync incident](../../docs/incidents/2026-10-07-folder-sync-diagnosis-and-plan.md) демонструє різницю між доведеним дефектом коду та недоведеним конкретним кейсом без request/job evidence.
- [007 beta staging](../007-beta-staging-environment/spec.md), [008 power throttle](../008-agent-power-throttle/spec.md), [Production runbook](../../docs/PRODUCTION.md) та constitution залишаються чинними.
- Planning MUST інвентаризувати реальні producer/transport/storage/query seams і скласти coverage matrix та контракти agent analysis. Наявність команди `journey`, `run` або `sync` сама по собі не доводить повноту спостереження.

## Regression Seed — Windows input incident, 2026-10-09

Це набір reported symptoms і доступних спостережень для planning, не завершена діагностика конкретного користувача. Ідентифікатор кейсу — `windows-input-2026-10-09`; email і секрети зі screenshot не копіюються в spec.

| Спостереження                                                                         | Що воно підтверджує                           | Що ще треба довести                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| Аналітика: Windows x64, local build 1.2.5+70, agent_connected і багато tool_opened    | Агент був доступний для зафіксованих подій    | Readiness кожного інструмента й input attempt lifecycle                     |
| Початковий screenshot stitcher без нижніх settings                                    | Панелі не видно в цьому знімку                | Помилка initial read, subscribe/apply або інша причина відсутності          |
| User: кнопка не відкриває діалог у всіх перевірених інструментах                      | Reported shared symptom                       | Handler acceptance, helper launch, visibility, error або legitimate pending |
| DevTools: production local endpoint, без показаної відповіді; mobile Android identity | Endpoint target і заявлена browser identity   | Чи був request прийнятий; емуляція/підміна чи інший context; вплив на збій  |
| User: пробував anti-detect і особистий браузер                                        | Повідомлена зміна браузера                    | Чи прибрано override/емуляцію і чи це той самий Windows host                |
| Image upload працює; settings на пізнішому screenshot видно                           | Працює окремий шлях; панель пізніше з'явилася | Чи photo input був browser picker або drop; стан video native picker        |
| Drop починає роботу, далі «Soty не знайшов цей файл на диску»                         | Visible original-resolution failure           | Location/search classes, denied access, incomplete search чи no match       |
| User: файл локальний, antivirus немає, після повторного відкриття нічого не змінилось | Повідомлені умови й результат спроби          | Точний location class, security evidence, фактичний новий boot і attempt    |

Acceptance набір MUST відтворювати цей клас симптомів із незалежними причинами (picker launch failure, hidden dialog, limited resolver coverage, inaccessible original, initial-state failure) та зі спільним підтвердженим environmental failure. Агент має визначати різні причини там, де вони різні, і одну лише за достатнього доказу. Також потрібен healthy control: preflight success + pending request під час відкритого діалогу → explicit cancel/selection → завершена відповідь.

До planning handoff включити coverage для shared picker, browser image upload, dropped resolver, tool state transport, local process diagnostics і support bundle. Історичний кейс не оголошується поясненим лише після додавання нових signals: новий збір допомагає майбутньому відтворенню, а не відновлює незібране минуле.
