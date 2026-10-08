# Зависання ручної синхронізації: діагностика і план

Дата: 2026-10-07. Код: `c4ee7eb5` / Soty 1.2.5.
Статус: план реалізовано як фічу 028 (`specs/028-manual-sync-lifecycle/`), гілка
`028-manual-sync-lifecycle`, усі чотири релізи в коді й перевірені локально та на беті
(2026-10-08). Production ще не оновлено; знімок інциденту (крок 1) не знято.
Друге, незалежне читання коду того ж дня: усі сім знахідок підтверджені,
розділ «Незалежний аудит» нижче додає те, чого бракувало, і «Крок 0» — мінімальний
зріз, який знімає сам симптом без повного редизайну.

## Висновок

Проблема не зводиться до швидкості Google Drive або застарілого агента. Виявлено
кілька незалежних дефектів життєвого циклу синхронізації. Один серверний сценарій
точно відтворює механізм «новий запит другого користувача розблоковує старий».
П'ять клієнтських сценаріїв також відтворені окремими діагностичними тестами.

Це доводить наявність дефектів у поточному коді, але не встановлює, який саме
стався у повідомленому випадку: немає прив'язаних до двох натискань job/request ID
і серверної історії станів. У наявному analytics CLI немає діагностики sync-job.
Не виконувались довільні SQL-запити до production.

## Незалежний аудит (друге читання, 2026-10-07 увечері)

Усі знахідки F1–F7 перевірені повторно по коду; жодна не спростована. Що
уточнилось або додалось:

- **Canonical job гине легше, ніж описано.** `failed` настає не після 1000 спроб,
  а після 10, або одразу при неповторюваній помилці (`service_retry_catalog_sync_job`,
  `attempts + 1 >= 10 or p_permanent`). Неповторюваними зараз є: будь-який 400
  від Drive, у тому числі протухлий page token — гілка `PAGE_TOKEN_REJECTED` в
  `engine.ts` мертва, бо `#request` у `_shared/drive.ts` ніколи його не породжує;
  403 за ліміт запитів (`rateLimitExceeded` не відрізняється від втрати прав);
  **ярлик Drive серед змін** (`UNSUPPORTED_MEDIA` з `proveLiveAncestry`, index.ts
  перекидає далі). Будь-якого з них у фіді змін досить, щоб кожне наступне ручне
  сканування простору висіло в `running`, доки хтось не натисне ще раз. Це робить
  F1 основною гіпотезою інциденту, а не одним із кандидатів.
- **Є другий, м'якший механізм того самого симптому.** Якщо canonical не `failed`,
  а в `retry` з backoff (до 15 хв), waiter чекає весь backoff:
  `service_complete_catalog_sync_job` підтягує canonical лише зі стану `pending`
  (`least(next_attempt_at, now)` під `state = 'pending'`). Новий finite job тут
  теж нічого не створює (`on conflict do nothing`), тож другий клік не допомагає;
  збіг у часі виглядає як «розблокував». Діагностика має розрізнити ці два випадки.
- **Прострочений lease ніколи не рахується як невдача.** Claim у
  `20260924160000` більше не інкрементує `attempts` (лише `run_count`); job, що
  щоразу вмирає посеред сторінки, перехоплюється нескінченно і не стає `failed`.
  Успішний коміт сторінки/кандидата/папки скидає `attempts = 0`, тому поріг 10
  для циклу «перелічили — знову недоступно» недосяжний. Є ще один кандидат на
  вічний цикл: у reconciliation перевірка `parents.includes(folder)` стоїть перед
  перевіркою hidden-cache, а listing такі файли відсікає, тож активний `.soty`-рядок
  у каталозі щопроходу дає `incompleteListing` і перезапуск generation.
- **Waiter тримає cron у роботі.** Gate в `invoke_catalog_sync_worker` не дивиться
  на `replay_after`, а `next_attempt_at` waiter-а вже в минулому; worker
  викликається щотику впусту. Дрібниця, але платна (вересневий egress).
- **Усі записи change replay не огороджені epoch.** Durable scan огороджений
  повністю (`lock_catalog_sync_lease` в кожному RPC); `upsert_catalog_page`,
  tombstones, `invalidate_landing_renders` разом із trash у Drive, transcripts,
  `mark_folder_indexed`, `mark_root_state`, `touch_catalog_reconciled`,
  `enqueue_catalog_reconciliation` — ні. Застарілий worker дописує всю сторінку
  після втрати lease. У розділі 6 це не «перевірити», а відома прогалина.
- **SQL-помилки невидимі.** `rpcValue` в `index.ts` перетворює будь-яку помилку RPC
  на retryable `DRIVE_UNAVAILABLE` без логу: `INCOMPLETE_SCAN`, `INVALID_SCOPE`,
  `PROVIDER_PROOF_REQUIRED` у журналі не з'являться. Єдиний лог worker-а
  `catalog_sync_job_result` не має team/connection/actor/worker id; зіставити
  з браузером можна лише за `jobId`.
- **Фінальне перечитування програє власному Realtime-сигналу.** Завершення job
  породжує подію → `revision` → фоновий `read()` у `ExplorerProvider`, який через
  `readSequence` робить строгий read «superseded» → `onComplete` відхиляється →
  тост «не вдалося» після вдалої синхронізації. У F5 це згадано мимохідь; за
  ймовірністю в здоровій системі це P0, і тесту на це немає.
- **Read-only CLI не бачить sync-jobs.** Роль `wishly_analytics_ro` має SELECT лише
  на `analytics_events`, `analytics_users`, `analytics_team_workspace`. Команда
  діагностики з кроку 1 потребує міграції з редагованим view і grant.
- **Докази ще є, але недовго.** Retention видаляє завершені finite jobs через 7
  днів після `completed_at`; incremental не видаляє ніколи. Знімок історії job-ів
  інциденту треба зняти до 2026-10-14.
- **Дрібні уточнення.** Cron справді 30 с (`20260921180000`), а не 10 с, як у
  вересневому інциденті й коментарі `index.ts`. `__root__` живе лише у вебі, SQL
  його не знає; root job і subtree job ніколи не join-яться між собою.
  `join_catalog_subtree` може приєднати запит до вже завершеного waiter-а, бо не
  перевіряє `replay_after`. Jobs від'єднаних connections ніколи не стають
  terminal. Детальний status RPC відсікає root scans
  (`requested_folder_id is not null`). Тимчасових probes у робочій копії немає —
  їх доведеться написати заново одразу як регресії.

## Що перевірено

- Ручна кнопка → RPC прийняття → черга → worker → Drive → каталог → фінальний
  replay → статус → перечитування списку й дерева → Realtime іншого користувача.
- Шлях папки та повного простору, повторний клік, предок/нащадок, перехід між
  папками та між просторами, завершення запиту після unmount, таймаути.
- Серверний scheduler, lease/epoch, повтори, залежність від canonical incremental
  job, проєкції status/health, очищення історії.
- Read-only analytics `users`, `journey`, `errors`. Для ймовірного акаунта
  Санчоса журнал підтверджує web/agent 1.2.5 о 12:13 UTC (15:13 Київ).
  Подій прийняття/прогресу/завершення саме ручної синхронізації немає;
  порожня вибірка errors не доводить відсутності цих помилок.
- Тимчасові діагностичні тести: 5 React probes + 1 PGlite probe, усі підтвердили
  поточну проблемну поведінку. Це не тести успішного виправлення.
- Попередній загальний `npm run verify` уже завершився: 13/14 gates, suite
  failed у `team-batch-queue.test.tsx`, сценарій скидання черги під час паузи.
  Цей результат не використовується як доказ справності синхронізації.

## Причини й прогалини

### F1 — серверне очікування завершення може залишитися без виконавця (P0)

У `20260924100000_catalog_sync_ownership.sql` завершений finite scan переводиться
в `pending / change_replay` з `replay_after = confirmed_sequence + 1`.
Scheduler виключає такі jobs із видачі. Завершити їх може canonical incremental
job, коли підтвердить наступну позицію змін Drive.

Якщо canonical job переходить у `failed`, залежні сканування не отримують
термінального статусу або явного стану блокування. Старий status RPC продовжує
повертати `running`. Сам waiter більше не може виконуватися. Якщо canonical
у `retry`, waiter чекає весь backoff (до 15 хв), бо завершення finite job
підтягує canonical лише зі стану `pending`.

Створення нового finite job викликає `ensure_catalog_sync_authority`: якщо
активного canonical job немає, trigger створює його. Після його успішного replay
старі waiters теж стають `succeeded`.

Локальний PGlite probe пройшов таку послідовність:

1. Запросити сканування папки, пройти порожню сторінку і закінчити її generation.
2. Завершити finite scan, отримавши replay waiter; canonical перевести у failed.
3. Claim повертає порожньо, status першого job залишається running.
4. Запросити ту саму вже оброблену папку ще раз: отримати інший finite job і новий canonical.
5. Підтвердити replay новим canonical: перший job стає succeeded.

Це сильний кандидат на описаний симптом, а не підтвердження стану production
у момент інциденту. Відмова auth/Drive може бути первинним тригером, а зависання
waiter — другою помилкою, яка приховує її від людини.

### F2 — браузер може чекати запит без кінця (P0)

`useFolderResync.ts`:

- У `start()` немає deadline на `resyncFolder()`; 5-хвилинний таймер з'являється
  лише після прийняття запиту. Зависання HTTP/auth refresh залишає spinner назавжди.
- AbortController монітора не передається мережевому RPC. При завислому status
  таймер прибирає spinner, але `await monitor()` не завершується і
  `accepting.current` лишається true. Видимо доступна кнопка нічого не запускає.
- Pending job зберігається після timeout. Наступний клік читає саме старий job,
  не викликаючи request RPC. Інший браузер без цього локального запису може
  створити нову роботу — асиметрія між користувачами реальна.
- Один збій status-read показується як failed, навіть коли серверна робота жива.
  Немає окремого стану «зв'язок зі статусом втрачений».

`withFreshSession()` повторює rejected token один раз, але сам не задає deadline.
`ExplorerProvider.refreshStrict()` також не обмежує очікування дерева; завершена
серверна робота може застрягти на останньому клієнтському перечитуванні.

### F3 — навігація не закриває всі асинхронні обробники (P0)

Є корисні захисти: sessionStorage key містить teamId/folderId; Explorer має
`key={explorer:teamId}`; RPC перевіряє приналежність job до team; читання списку
має generation і scope. Пряме змішування даних двох просторів не доведене.

Але acceptance після unmount може запустити новий monitor старого компонента:
cleanup перериває лише вже створений monitor. Локальний probe підтвердив виклик
status, onComplete і onOutcome після unmount. Це зайві запити та потенційно
запізнілий toast від попереднього простору.

У межах одного Explorer pending acceptance старої папки блокує запуск іншої,
хоча її кнопка виглядає доступною. Пізня помилка користується latest callback
і показується вже на іншій папці. Root sentinel `__root__` не входить до scope
нащадків: загальна синхронізація не успадковується ними так, як синхронізація
звичайної батьківської папки.

### F4 — статус надто бідний і немає скасування (P1)

UI використовує `getFolderResyncStatus()` з трьома значеннями. Детальний
`getFolderSyncStatus()` уже існує, але в робочому UI не використовується;
SQL цієї детальної версії ще виключає повні root scans.

Queued, leased, retry і replay wait показуються однаково. Немає причини
очікування, часу останнього корисного прогресу, результатів цього проходу,
зрозумілої помилки, deadline наступної спроби чи серверного cancel RPC.

Просто під'єднати існуючий детальний status недостатньо: його discoveredFiles
рахується з `catalog_scan_seen`, а retention видаляє observations завершених
generations навіть до завершення всього job. Лічильник може зменшуватися.
Також «переглянуто файлів» не означає «знайдено нових файлів».

### F5 — видимий список залежить від стану доставки оновлень (P1)

Polling ручного job перечитує список лише після succeeded. Проміжні результати
залежать від Realtime. Завислий replay разом із непрацюючим Realtime залишає
користувача зі старим списком, навіть коли частина каталогу вже записана.

`useTeamRealtime` перечитує на subscribe, події та visibility; після кількох
невдалих reads самостійні повтори припиняються до нового сигналу. Його callback
спочатку чекає `listTeams`, і тільки потім рухає revision матеріалів. Зависання
membership-read затримує оновлення списку. Фоновий refresh може supersede
strict completion-read і перетворити серверний успіх на повідомлення про помилку.

Health має хвилинний fallback, але failed-read мовчки залишає старий snapshot
без віку/ознаки застарілості. Health простору й статус конкретної папки — різні
факти; один не має підміняти інший.

### F6 — часові бюджети не обмежують усі одиниці роботи (P1)

У tracked конфігурації cron має крок 30 s, worker бере один job, бюджет проходу
8 s, lease 180 s, глобально до трьох leases, один на connection. Це вже дає
очікування черги навіть за здорового Drive; фактичні production timings треба виміряти.

У durable reconciliation перевірка budget стоїть після обробки порції до 100
кандидатів, а один provider call може чекати 15 s. У change replay є ancestry
walks, invalidation та transcript ingestion до checkpoint. Ліміт 8 s не є
жорсткою межею такого проходу. Повторні втрати lease/runtime до checkpoint можуть
повторювати одну й ту саму роботу без нормального збільшення лічильника помилок.

При unavailable candidate код перезапускає generation, а успішні page/candidate
commits скидають attempts. Цикл «знову перелічили — знову немає доступу» потребує
окремого обліку відсутності поступу, а не лише consecutive exceptions.

### F7 — права, діагностика і релізні перевірки (P1)

Кнопка в Explorer знаходиться під `permissions.upload`, тоді як request RPC
дозволяє лише owner/admin. Це різні критерії; треба узгодити видимість і
авторизацію, не розширюючи права випадково.

Ручний folder request не має повної correlation історії actor/request/job.
Звичайний production-config gate перевіряє ACTIVE/наявність функцій, а не їхні
фактичні bytes або прогрес worker. Зелений smoke не доводить справність
cron → HTTP worker → claim → Drive → commit → обидва браузери.

## Крок 0 — мінімальний зріз, який знімає сам симптом

Повний план нижче великий і правильний, але це тижні. Цей зріз — один невеликий
реліз (одна additive-міграція, правка хука, регресії), який закриває обидва
механізми зависання і фальшивий «не вдалося», не чекаючи редизайну статусу й cancel.
Знімок production (крок 1) робиться паралельно і зріз не блокує.

Сервер, одна міграція поверх `20261006120000`:

1. `service_retry_catalog_sync_job`: коли canonical стає `failed`, усі його waiters
   (`replay_after is not null and state = 'pending'`) → `failed` з
   `error_code = 'CANONICAL_FAILED'` і кодом причини canonical. Якщо помилка
   canonical retryable, натомість одразу створити новий canonical з поточного
   cursor тим самим кодом, що в тригері, а waiters лишити чекати.
2. Finite-гілка `service_complete_catalog_sync_job` і `request_team_folder_resync` /
   `request_team_catalog_resync`: підтягувати canonical і зі стану `retry`, не лише
   `pending`. Ручний запит не має чекати backoff фонового feed-у.
3. Claim: при перехопленні простроченого lease робити `attempts + 1`. Скидання
   `attempts` при коміті замінити окремим лічильником перезапусків тієї самої
   generation; N перезапусків без нового `listed` → `failed / NO_PROGRESS`.
4. Sweeper у наявному 5-хвилинному retention-cron: waiter без активного canonical
   старший за 2 хв → створити canonical; waiter старший за 60 хв →
   `failed / REPLAY_TIMEOUT`; jobs від'єднаних connections → `canceled`. Gate
   `invoke_catalog_sync_worker` пропускає jobs з `replay_after`.
5. `_shared/drive.ts`: 403 з `reason in (rateLimitExceeded, userRateLimitExceeded)` →
   `RATE_LIMITED`; 400 з `invalidPageToken` → `INVALID_INPUT / PAGE_TOKEN_REJECTED`
   (оживити мертву гілку в `engine.ts`); ярлик у `proveLiveAncestry` → пропустити
   запис і порахувати як `unavailable`, не валити job.
6. `rpcValue` в `index.ts` логує код і повідомлення SQL-помилки (без параметрів);
   `catalog_sync_job_result` отримує `connectionId` і `teamId`.

Веб, `useFolderResync.ts` та `ExplorerProvider.tsx`:

7. Deadline 20 с на `resyncFolder()` і на кожен status-read; `AbortSignal` іде в
   supabase-js (`.abortSignal(signal)`), щоб abort справді обривав HTTP. У `finally`
   завжди скидати `accepting`, навіть коли RPC так і не відповів.
8. Timeout монітора лишає pending key, але наступний клік спершу робить один
   status-read: `succeeded` / `failed` → показати результат і зняти key; інакше
   продовжити монітор. Перехідна мережева помилка на status → новий outcome
   `disconnected` («зв'язок зі статусом втрачено, сервер продовжує»), не `failed`.
9. `onComplete`: `CATALOG_REFRESH_SUPERSEDED` означає, що новіший read уже пішов;
   дочекатися його і вважати успіхом. Тост «не вдалося» лише на справжній
   `FOLDER_TREE_REFRESH_FAILED`.

Регресії зрізу (пишуться першими, бо probes втрачені): PGlite у
`catalog-sync-ownership.test.ts` — «canonical failed → waiters failed з причиною»,
«canonical у retry → waiter завершується без backoff», «lease прострочений N разів →
failed», «sweeper створює canonical сироті»; React у `team-folder-resync.test.tsx` —
«accept завис → кнопка знову працює через 20 с», «status завис → lock звільнено»,
«superseded strict read → success toast». Повторити 20 послідовних запусків одного
акаунта на тестовому Drive і один прогін з ярликом у папці.

## План реалізації в порядку залежностей

### 1. Зафіксувати інцидент і додати діагностику

- Зіставити акаунт, простір, provider folder ID та приблизний час двох натискань.
- Додати штатну read-only команду діагностики sync до CLI з `--json`, без
  обходу SELECT-only ролі. Для цього потрібна міграція: view
  `public.analytics_catalog_sync_jobs` поверх `private.catalog_sync_jobs` +
  `catalog_sync_authority` без cursor/token-полів і назв файлів, з `grant select`
  для `wishly_analytics_ro`. Поки її немає, знімок знімає власник через SQL-editor
  у Dashboard тим самим SELECT-ом і кладе результат у цей документ; зробити це
  до 2026-10-14, доки retention не стер finite jobs. Привілейовані worker/cron
  журнали отримувати окремим штатним read-only шляхом, з редагуванням секретів.
- Перше питання до знімка: у якому стані був canonical job connection у момент
  першого кліку — `failed` (F1, і з яким `error_code`), `retry` (другий механізм
  з аудиту, і скільки лишалося до `next_attempt_at`), чи `leased` з простроченим
  lease. Відповідь визначає, який пункт кроку 0 був би вирішальним.
- Знімок: request/job/connection IDs, actor, created/accepted/claimed timestamps,
  kind/phase/state, покоління, прогрес, lease expiry, retries/next attempt,
  replay dependency та canonical state, останній worker result і HTTP outcome.
- Перевірити production розклад, Vault-конфігурацію, відповідь worker,
  фактичну версію catalog-sync, auth/403/429, DB lock waits. Не запускати новий
  resync до зняття знімка, щоб не знищити картину природним «одужанням».
- Корелювати браузерний request з серверним job. Не логувати refresh tokens,
  provider cursors, назви приватних файлів або їхній вміст.

### 2. Закрити серверне зависання і правила повтору (P0)

- Зробити залежність finite scan від replay явною і відновлюваною.
- При terminal canonical failure усі його waiters отримують blocked/failed
  з конкретною причиною та дією; вони не лишаються running без виконавця.
- Автоматичне відновлення retryable canonical роботи має бути bounded і
  зберігати confirmed cursor/provenance. NEEDS_REAUTH/permission loss вимагають
  дії власника; не маскувати їх нескінченним автоматичним retry.
- Watchdog знаходить осиротілі waiters, прострочені leases та відсутність
  поступу. Відновлення не повинне потребувати іншого користувача чи нового scan.
- Розрізнити «продовжити стежити», «повторити невдалу роботу» та «новий scan
  після змін». Сервер атомарно join/retry/create за request idempotency key.
- Приєднуватися лише до роботи, яка ще покриє запитану актуальність. Для вже
  пройденої гілки — один follow-up. Перевірити parent/child/root/selected roots,
  двох користувачів, дві вкладки та одночасні accept/retry/cancel.
- Врахувати вже завислі jobs під час міграції; каталог зберегти, ambiguous
  missing не перетворювати на видалення, не скидати всю базу/індекс.

### 3. Єдиний життєвий цикл у браузері (P0)

- Обмежити acceptance, status і final refresh окремими deadlines та передавати
  abort до мережі. Abort/timeout гарантовано звільняє локальні locks.
- Втрата acceptance-відповіді означає unknown, бо commit міг відбутися: знайти
  job за request key перед повтором, не створювати дублікат навмання.
- Замінити один running boolean на явні стани. Timeout зв'язку не є failed
  серверного job; повільний scan зі справжнім поступом не обривати через 5 хв.
- Реєстр операцій із ключем user/team/connection/scope/job, поза lifecycle
  сторінки. На зміну акаунта/logout — від'єднання й очищення локального контексту.
- Перехід A → B не скасовує серверну роботу A, не блокує B і не дозволяє
  callback A оновити B. Пізнє acceptance зберігається за A, не запускає orphan UI.
- При поверненні або reload відновити authoritative status; root scope охоплює
  нащадків. Для одночасних вкладок не плодити зайві monitors/jobs.

### 4. Прогрес, результат і ручне зупинення (P1)

- Один status contract для папки й root scan: queued, running, retry_wait,
  blocked, canceling, canceled, succeeded, failed; phase окремо.
- Показувати scope, час запуску, тривалість, останній корисний поступ,
  переглянуті файли, нові/оновлені/прибрані записи, завершені та відомі
  незавершені папки; кількість недоступних елементів і причину.
- Довговічні агрегати job/generation, які не зменшуються через retention чи
  подвійний replay. Чітко розділити scanned та added/changed.
- Коли total невідомий, показувати абсолютні числа й етап. ETA — лише за
  достатніх даних; великий невідомий підкаталог не отримує вигаданих 90%.
- Після завершення: «додано N, оновлено M», «змін немає» або «частково;
  K елементів недоступні». Нульовий/частковий результат не називати повним успіхом.
- Кнопка «Зупинити» викликає серверний cancel для конкретного ручного запиту.
  Не зупиняти весь connection чи canonical feed. Якщо роботу поділяють кілька
  запитів, від'єднати цей запит; фізично cancel underlying job можна лише коли
  він не потрібен іншим. UI пояснює спільну роботу і права адміністратора.
- Cancel перевіряється між bounded units, відкликає право подальшого commit;
  уже знайдені файли зберігаються, пізні відповіді не повертають running/success.
- Коротка історія та доступне копіювання diagnostic ID. Помилки мають конкретну
  дію: відновити зв'язок, повторити, перепідключити Drive, надати доступ.
- Компоненти й токени з DESIGN.md; keyboard/focus/aria-live без озвучування
  кожного файлу. Синхронізація, локальне завантаження і Realtime мають різні підписи.

### 5. Доставка результатів усім учасникам (P1)

- Проміжні commit batches інвалідовують потрібну папку; під час активного scan
  bounded status polling може ініціювати debounced refresh видимого списку,
  якщо progress/revision змінився, навіть без Realtime.
- Не перечитувати весь простір по кожному файлу. Зберегти visible-window,
  pagination, anchor, filters і selection; debounce/coalesce запити.
- Відділити membership refresh від критичного читання списку, зберігши реакцію
  на втрату прав. Read failure/застарілий health snapshot показувати явно.
- Final refresh координується з Realtime refresh, а superseded read не
  перетворює успішну синхронізацію на помилку. Success UI — після підтвердженого
  читання поточного scope; для неактивного простору зберегти його результат.
- Reconnect, online, повернення вкладки після sleep і повторна автентифікація
  роблять authoritative catch-up. Відписаний старий канал не інвалідовує новий простір.

### 6. Бюджети, справедливість черги та захист даних (P1)

- Перевіряти deadline до/після окремого candidate/provider read, з bounded
  concurrency та durable checkpoint. Усі довгі RPC/provider/auth виклики мають deadline.
- Враховувати runtime termination і lease loss окремо від звичайних retries.
  Рахувати фактичний поступ, повтори тієї самої generation/page та загальне
  очікування; будь-яка зміна timestamp не є поступом.
- Фінальний replay для waiters не має голодувати за ручними запитами.
  Виміряти latency при одночасній роботі кількох просторів; idle ticks не
  збільшувати без потреби й не навантажувати workspace reads.
- Transcript ingestion/preview cleanup не повинні безмежно блокувати
  видимість основного каталогу; за потреби окрема надійна enrichment-черга.
- Огородити epoch усі записи change replay (список неогороджених RPC у розділі
  аудиту): застарілий worker зараз дописує всю сторінку й робить trash у Drive
  після втрати lease. Cancel/stale worker не повинні перезаписувати свіжі дані.
- Лічильник невдач має бачити прострочені leases і перезапуски generation, бо
  зараз `attempts` ніколи не досягає порога; `run_count` без поступу — теж сигнал.
- 403/404/incompleteSearch/rejected page token, moved/deleted files і змінені
  права не доводять повного очищення папки. Зберегти generations та proof-based
  reconciliation; статус partial пояснює обмеження.
- Cache/Restitched не має створювати нескінченні follow-up scans. Зберегти
  потрібну видимість службових результатів, виключення hidden previews та
  помірне навантаження від restitch/update циклів.

## Матриця обов'язкового приймання

| Сценарій                                                           | Очікуваний результат                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Санчос запускає, інший учасник нічого не робить                    | Робота завершується або пояснює блокування самостійно; обидва бачать результат |
| Другий користувач натискає ту саму папку                           | Join або один обґрунтований follow-up; жодного прихованого «порятунку» першого |
| Canonical failed до/під час replay                                 | Залежні jobs відновлюються або переходять у явний blocked/failed               |
| Accept завис / відповідь загубилась після commit                   | Обмежений wait, request lookup, працездатна кнопка, немає дубля                |
| Status завис / мережа зникла / token протух                        | Локальні locks звільняються; server state не підміняється network error        |
| A → B → A, обидва синхронізуються                                  | Незалежні scope, жодних чужих toast/rows, правильне відновлення                |
| Перемикання до acceptance, після acceptance, під час final refresh | Пізні callbacks fenced; немає orphan polling                                   |
| Root → child; parent ↔ child; siblings; selected roots             | Правильне охоплення, bounded follow-up, немає пропущеної гілки                 |
| Reload, закриття вкладки, sleep, restart агента                    | Сервер продовжує; монітор відновлює статус і не вимагає іншого користувача     |
| Дві вкладки, logout/login іншим користувачем                       | Немає дублювання і локального витоку чужого job/context                        |
| Realtime відключений або reconnect під навантаженням               | Активний scan і його результати видимі через bounded fallback                  |
| Порожня папка / змін немає / лише перейменування або видалення     | Однозначний результат, застарілі rows не зберігаються після підтвердження      |
| 50k файлів, широка/глибока структура, 100+ missing candidates      | Повнота, bounded calls, справжній поступ, кероване cancel                      |
| 429, 503, 403/404, reauth, root від'єднаний або видалений          | Коректні retry/blocked/partial; причина й дія доступні користувачу             |
| Worker помирає, lease прострочився, застаріла відповідь            | Recovery без нескінченного replay; старий worker не комітить                   |
| Cancel у queued/running/replay/retry і одночасно з complete        | Єдиний кінцевий результат, корисні записи збережено                            |
| Cancel спільного job одним учасником                               | Інші запити та фоновий feed продовжують працювати                              |
| Retention під час довгого scan, старий збережений job              | Стабільні counters; expired status не є невідомим нескінченним running         |
| Переміщення/upload/rename паралельно зі scan                       | Нові зміни не перезаписуються старою сторінкою                                 |
| Багато просторів і безперервні ручні запити                        | Обмежені queue wait і cloud load; replay/background не голодують               |
| Owner/admin/member з різними permissions                           | Кнопки відповідають RPC-дозволам; сторонній team/job недоступний               |
| Cache/restitch/catalog updater працюють паралельно                 | Немає sync storm, hidden previews не засмічують каталог                        |
| Canonical у `retry` з довгим backoff, користувач натискає папку    | Waiter не чекає backoff; результат за хвилини, не за 15 хв                     |
| Ярлик Drive або 403 rate-limit у фіді змін                         | Canonical не гине; запис пропущено/відкладено, статус пояснює                  |
| Протухлий page token у listing або changes                         | Перезапуск сторінки, не terminal failure connection                            |
| Активний `.soty`-рядок у папці під час reconciliation              | Немає вічного перезапуску generation; лічильник без поступу спрацьовує         |
| Worker убитий посеред replay-сторінки, lease перехоплено           | Старий worker не дописує сторінку й не робить trash у Drive                    |

## Критерії завершення та rollout

- До реалізації написати заново 6 probes як регресії з очікуванням правильної
  поведінки (у робочій копії їх уже немає); додати серверні
  dependency/cancel/idempotency тести. Спершу полагодити або карантинувати
  `team-batch-queue.test.tsx` — інакше жоден verify не буде зеленим і сигнал
  від нових тестів потоне.
- Обмеження коротких мережевих очікувань: початкова ціль 15–20 s до явного
  стану зв'язку та повторної дії; це не обмеження загальної тривалості scan.
- Для здорового тестового Drive: 20 послідовних запусків одного учасника без
  втручання іншого; 20 переходів A/B із jobs; жодних завислих locks/waiters.
- Виміряти request→claim, first visible change, last useful progress,
  scan→replay→visible, provider calls і p95 queue latency. Зафіксувати бюджети
  для тестових розмірів після baseline, а не обіцяти універсальний ETA.
- Перевірити двома реальними акаунтами та на macOS/Windows; зібрати evidence
  із вимкненим Realtime, offline і примусовими worker failures.
- Backend additive migration/status API спочатку сумісні зі старим web.
  При rollout коректно розібрати старі waiters. Мати rollback, який не втрачає
  cursor provenance і не відновлює вже canceled jobs.
- Targeted tests локально (vitest single-worker, після перевірки `uptime`);
  `npm run verify` і `npm run verify:release` — лише через CI або раннер релізу,
  не на цій машині. Packaged beta для точного commit. Потім канонічний
  production runbook із окремим release intent.
- Крок 0 випускати окремим релізом раніше за решту плану: він additive, сумісний
  зі старим web (нові `error_code` старий клієнт показує як звичайний `failed`)
  і сам по собі вже знімає симптом.
- Спостереження після випуску: stalled jobs, replay waiter age, terminal failures,
  lease-loss loops, queue latency, видимість в обох акаунтах. ACTIVE function та
  HTTP 200 без корисного прогресу не вважаються успіхом.

## Основні місця змін

- `apps/web/src/team/explorer/useFolderResync.ts`, `ExplorerShell.tsx`,
  `ExplorerProvider.tsx`, `useFolderPage.ts`.
- `apps/web/src/api/team.ts`, `apps/web/src/lib/supabase.ts`.
- `apps/web/src/team/useTeamRealtime.ts`, `TeamContext.tsx`,
  `storage/useStorageHealth.ts`, `storage/StorageChip.tsx`.
- `packages/shared/src/team/transport.ts` і типи status/request.
- `supabase/functions/catalog-sync/index.ts`, `engine.ts` та нові forward migrations
  поверх ownership, generations, scope join, fairness, coverage і retention.
- Штатна діагностика CLI, worker logs, tests та feature 026 acceptance evidence.

## Стан після реалізації (2026-10-08)

| Знахідка | Що зроблено | Де |
| -------- | ----------- | -- |
| F1 сироти після смерті canonical | waiters → `CANONICAL_FAILED` з причиною або новий canonical автоматично; nudge з `retry`; sweeper у cron; data-fix при міграції | M1 `20261008100000` |
| F2 браузер чекає без кінця | deadline 15/15/30 с, abort до HTTP, кнопка завжди звільняється, стани `unreachable/disconnected/stalled`, localStorage між вкладками | `useFolderResync.ts` |
| F3 orphan callbacks, `__root__` | callback-и огороджені scope; `__root__` на початку scope кожної папки; гейт кнопки за роллю | `ExplorerShell.tsx` |
| F4 бідний статус, немає cancel | 8 станів, причина й дія, підсумок у числах, «Зупинити» через `cancel_team_folder_sync`, лічильники на job | M3 `20261015100000`, `SyncStatusPanel.tsx` |
| F5 доставка залежить від Realtime | superseded strict read → успіх; revision до membership; invalidation з монітора ≤ 1/5 с; вік застарілого health | `readSettle.ts`, `TeamContext.tsx`, `useStorageHealth.ts` |
| F6 бюджети й fencing | бюджет між кандидатами, checkpoint до транскриптів, усі replay-RPC огороджені, lease-live перед Drive trash, `NO_PROGRESS` | M4 `20261022100000`, `engine.ts`, `index.ts` |
| F7 права й діагностика | кнопка = RPC-дозвіл; view `analytics_catalog_sync_jobs`, команда `analytics -- sync`; лог worker-а з ідентифікаторами; SQL-помилки видимі | M2 `20261008110000`, `scripts/analytics` |
| Аудит: ярлик/403/page token | ярлик розміщується за власними батьками, rate-limit 403 → `RATE_LIMITED`, page token → перезапуск сторінки | `_shared/drive.ts` |

Крок 1 (знімок production) лишається відкритим: після backend-apply M1+M2 —
`npm run analytics -- sync <owner-email> --json`, до 2026-10-14.
