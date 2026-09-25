# Quickstart: перевірка надійної синхронізації

Цей сценарій виконується після реалізації задач із плану. Він не є інструкцією для production і не повинен змінювати production-дані.

## Передумови

- Node.js 22 і залежності монорепозиторію встановлені.
- `npm run beta:doctor` проходить без помилок.
- Є два beta-акаунти: власник/адміністратор і учасник із правом перегляду.
- До beta підключено тестове Google Drive дерево, яке явно доступне поточному OAuth-з’єднанню.
- Підготовлено локальний набір `Кампанія/UA/Лікарі/a.png`, `Кампанія/PL/Лікарі/a.png`, порожню `Кампанія/Чернетки`, кілька окремих файлів і вкладеність щонайменше 10 рівнів.

Для чистого одноразового середовища дозволено `npm run beta:reset`, але лише для локальної beta та лише коли її поточні дані не потрібно зберігати. Не запускати reset під час звичайної перевірки на наявній beta.

## 1. Статичні та автоматизовані перевірки

З кореня репозиторію:

```bash
npm run verify
```

Під час розробки можна запускати цільові тести окремо:

```bash
npx vitest run tests/catalog-sync.test.ts
npx vitest run tests/team-folder-resync.test.tsx
npx vitest run tests/team-explorer-folder-upload.test.tsx
npx vitest run tests/team-progress-cost.test.tsx
npx vitest run tests/team-realtime.test.tsx
npx supabase test db --local tests/database/folder-resync.test.sql
npx vitest run tests/workspace-operation-journal.test.ts
```

Очікування: усі контракти, RLS-перевірки, переходи станів, пагінація та клієнтські сценарії зелені. Перед релізним рішенням додатково виконується `npm run verify:release` за чинним runbook.

## 2. Запуск beta

```bash
npm run beta:up
```

Відкрити один простір паралельно у двох окремих браузерних профілях. Перший користувач — власник або адміністратор, другий — звичайний учасник.

## 3. Зовнішня зміна й точкова синхронізація

1. У Google Drive без участі Soty створити `Лікарі/Будь-ласка побач її/картинка.png`.
2. У Soty відкрити `Лікарі` та натиснути «Синхронізувати цю папку».
3. Перейти в іншу папку, повернутися, а в одному профілі також перезавантажити сторінку.

Очікування:

- з’являється одна стійка робота зі станом `queued` або `running`, а повторний клік приєднується до неї;
- вкладена папка та картинка з’являються без повної реіндексації;
- обидва користувачі бачать результат без ручного reload;
- перехід між папками й reload не запускають роботу наново;
- постійний change cursor не змінюється від ручного subtree scan.

## 4. Переміщена заповнена папка

1. Поза підключеним деревом Drive створити папку з кількома рівнями та файлами.
2. Перемістити її всередину підключеного дерева.
3. Дочекатися автоматичного виявлення або виконати точкову синхронізацію батьківської папки.

Очікування: у каталозі з’являється вся наявна структура, а не лише коренева папка. Окремі старі нащадки не потребують власних provider change events.

## 5. Точне звіряння та безпечне видалення

1. Видалити або винести файл із підключеного дерева та завершити точковий обхід його батьківської папки.
2. Повторити тест, але штучно перервати читання до останньої сторінки.

Очікування:

- після повного обходу старий активний запис стає відсутнім і зникає з актуального списку;
- після неповної пагінації, rate limit, втрати доступу або worker failure решта дітей не tombstone-иться;
- помилка відображається як стан синхронізації, а не як порожня папка;
- тимчасові seen-записи очищуються після terminal state або watchdog cleanup.

## 6. Drag-and-drop папок

1. Перетягнути в одну папку Soty підготовлену `Кампанія`, другу кореневу папку та окремий файл одним жестом.
2. Не змінюючи операцію, перейти в іншу папку Soty.
3. Повторити на підтримуваних macOS і Windows.

Очікування:

- усі корені створені в папці, яка була призначенням на старті;
- збережені всі відносні шляхи, однакові імена в різних батьках і порожня `Чернетки`;
- дерево не сплющене й корінь не дубльований;
- нерозбірливий елемент дає partial result із конкретним відносним шляхом;
- великі каталоги не обрізаються першою порцією enumeration.

## 7. Універсальна дія «Додати файли»

1. Переконатися, що окремої toolbar-кнопки «Додати папку» немає.
2. Через «Додати файли» обрати один файл, кілька файлів, а потім папку.
3. Закрити системний chooser без вибору.

Очікування: одна дія дає доступні режими «Файли» і «Папка», результати збігаються з drag-and-drop, а скасування не створює групу, remote folders або error toast.

## 8. Прогрес завантаження та переміщення

1. Завантажити набір із файлами суттєво різного розміру.
2. Перемістити пакет матеріалів.
3. Під час кожної операції закрити тост; для upload також перезавантажити сторінку.
4. Спричинити одну часткову помилку, перевірити деталі та повторити лише невдалі елементи.

Очікування:

- підготовка й неподільне очікування показуються indeterminate, без вигаданих відсотків;
- upload progress зважений за байтами й візуально оновлюється не рідше ніж раз на 2 секунди під час активного передавання;
- batch move рахує лише підтверджені terminal items;
- після 100% передавання є окремий етап «Оновлення простору» до catalog postcondition;
- один тост представляє одну групу, а його закриття не скасовує роботу;
- локальне зведення відновлює checkpoint і звіряє existing material operation IDs після reload; втрачений source стає `interrupted_input_required`;
- retry спершу перевіряє lost-finalize і не повторює succeeded items. Unfinalized upload після reselection починається з byte0/new attempt навіть за однакових path/size. Перевірити дві вкладки, quota failure і sign-out purge.

## 9. Масштаб, справедливість і вартість

Використати контрольні fixtures до 50 000 файлів, 10 100 папок, глибини 20 та локальний manifest до 1 000 файлів/100 папок. Відкрити простір багатьма клієнтами або симулювати 100 учасників і до 10 одночасних ручних sync-запитів. Сім simulated days без змін, потім 100 changes/min; кожен ready простір отримує обслуговування ≤180 с.

Зібрати:

- кількість canonical incremental jobs на connection;
- provider list/change calls, повторні claims і consecutive failures;
- p50/p95 часу старту ручної роботи та появи каталожної зміни;
- catalog-event deliveries, catch-up reads і повні refresh-и;
- нуль додаткових progress cloud requests/writes/subscriptions для on/off та bounded orphan staging rows.

Очікування:

- існує рівно одна постійна incremental job на connection;
- кількість provider scans не множиться на кількість учасників;
- ручна робота стартує p95 не пізніше 60 секунд без голодування background sync;
- відкриті екрани отримують командні зміни за 5–15 секунд, а зовнішні зміни за нормальної роботи — за 2–5 хвилин;
- reconnect робить bounded catch-up, а не повний reread на кожну подію;
- нормальний успішний checkpoint скидає consecutive failure count.

## 10. Завершення

### Поточні implementation checks — 2026-09-24

- Ownership/backfill/claim/engine/listing/contracts/selection/storage-health:
  8 Vitest files, **70/70 passed** (PGlite applies the complete migration chain).
- Generation checkpoint, stale page, concurrent edit/move, ambiguous absence,
  provider-proof guard, 10 100-entry frontier, safe member status and expired lease: **10/10 passed**
  in `tests/catalog-scan-generations.test.ts`.
- Latest targeted rerun: generation **10/10**, ownership **5/5**, API boundary
  **10/10** (25/25 together). API acceptance is not completion; malformed/private
  status fields and a mismatched job ID are refused. Existing folder-resync,
  catalog-read and audit-wire tests also passed in the prior 21-test client run.
- Folder-resync UI recovery: **7/7** tests passed. The accepted job ID survives
  navigation and remount within the browser tab, then the existing status read
  and strict catalog refresh establish success; it does not request a second job.
  `npm run typecheck:tests` and `npm run typecheck:projects` passed for this change.
- `npm run verify -- --gates=static`: **13/13 gates passed**. This is static-only,
  not a full-suite or release PASS.
- Earlier isolated native PostgreSQL checks: ownership **13/13** and folder
  resync **12/12** passed. The added 1 005-poll pgTAP regression and the new T007
  pgTAP file still need a native run; Docker was stopped on continuation.
- T006/T007 affected RPC definitions were generated with Supabase against an
  isolated local schema copy and checked against the narrowed client types.
- Docker recovered without resetting beta. Native PostgreSQL on the existing
  isolated `codex_sync_026_20260924_final` database passed ownership **14/14**,
  scan generations **14/14**, and folder scope joins **18/18** pgTAP checks.
  Supabase types were generated from that isolated schema; the T007 signatures
  match `database.types.ts`. The generated whole-file replacement was withheld
  because it would remove local narrowed aliases and import unrelated schema drift.
  PGlite scope-join tests passed **2/2**. No migration was applied to beta.
- Colima recovered on a normal `colima start`. The working beta DB was not reset
  or migrated; native checks used the isolated schema database named above.
- Realtime UI tests covered subscribe race, duplicate/in-flight delivery,
  reconnect, explicit retry, visibility and membership loss: **19/19 passed**
  across the targeted three-file run. A separate mocked 1/100-client catch-up
  harness passed **2/2**: one initial and one event-triggered catalog read per
  client, with no provider-list call from the client path. This is a cost-boundary
  unit test, **not** a production provider-call or latency benchmark.
- Visible-window tests retained three loaded pages, a selected row and the
  active search page after invalidation. DOM scroll-anchor restoration and
  two-account timing remained unverified at that checkpoint.
- A follow-up DOM regression simulates a row inserted above the first visible
  material and verifies the same row remains at the same pixel. The folder
  hook captures the anchor before replacing the visible window; 11/11 targeted
  live-refresh/page tests passed. This is a jsdom regression, not a two-account
  browser timing result.
- The visible-window refresh now retries a transient failed read without
  discarding loaded rows, and stale folder/tree/search responses cannot replace
  a newer revision or team. The expanded live-refresh and tree suites passed
  **14/14**; the folder-page suite passed **8/8** separately.
- After these US2 changes, `npm run verify -- --gates=static` passed **13/13**
  gates. This is a static-only result; the full unit/release gates and two-account
  acceptance still remain open.
- T021 old/new-parent invalidation uses a `team_materials` move trigger in the
  same transaction as Drive-operation and catalog-scan commits. The isolated
  PGlite scope test passed **2/2**; native pgTAP live-state/RLS passed **8/8**,
  and `pg_publication_tables` includes `parent_folder_id`. The isolated native
  database needed a local `supabase_realtime` publication fixture because its
  schema copy omitted publications; no beta or production schema was migrated.
  Public types for the new nullable event field were generated against this
  isolated schema and selectively merged.
- T026 change-feed folder discovery now requests finite coverage before the
  canonical cursor advances. Manual and discovered requests share the same
  scope-join helper; already indexed unchanged folders are skipped, while new,
  moved and restored folders get work. PGlite discovered-scope tests passed
  **3/3**, native pgTAP lease/grant tests **6/6**, and an engine harness walked
  **50,000 files / 500 pages** before finite completion. Existing scan-generation
  tests cover a 10,100-folder durable frontier. These are local correctness
  fixtures, not a provider-load or production latency benchmark. The isolated
  native database was used; beta and production remained untouched.
- T024 completeness regressions additionally cover moved-in/restored folder
  scheduling before cursor commit and rejected page-token recovery with a new
  generation. The dedicated file passed **5/5**; five related catalog suites
  passed **46/46** before those added cases. Test typecheck and `git diff --check`
  passed. The 10,100-folder frontier assertion lives in the scan-generation
  database test, not the dedicated engine file.
- `npm run verify` was retried after formatting two test files. Static gates
  passed again, but the serial full unit suite produced no terminal result
  after roughly ten minutes and was interrupted; this is **not** a full-suite
  PASS. Targeted catalog-sync tests passed **28/28**, realtime scale **2/2**,
  and project/test typechecks passed separately.
- The earlier complete `npm run verify` was not green: 3 bundle-budget failures,
  2 space-settings failures and 1 tool-registry failure were reported. That full
  suite has not yet been rerun after this block.

No production migration/deployment, two-account beta acceptance, Windows picker
validation or provider-load benchmark has been performed. These checks do not
complete T016/T034/T060 or prove that T012–T013 runtime adoption is finished.

Зупинити локальну beta:

```bash
npm run beta:down
```

До evidence додати результати `npm run verify`, pgTAP/Vitest, скриншоти або запис обох профілів, метрики масштабного прогону та перелік перевірених macOS/Windows середовищ. Результат не вважається повним, якщо каталог видимий лише після reload або повної реіндексації.
