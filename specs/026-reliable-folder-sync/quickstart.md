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
- T009 regression coverage is split by authority: `catalog-sync.test.ts`
  checks finite completion, cursor independence and lease loss (including a
  discovered-folder scheduling refusal); PGlite scope-join/discovery tests check
  overlapping requests; scan-generation tests check concurrent catalog
  mutations. The five targeted suites passed **51/51**. This does not replace
  the 20/20 provider-backed MVP acceptance run.
- Realtime recovery regression reproduced a stale `reconnecting` indicator
  after a failed authoritative read later succeeded. The hook now marks the
  channel healthy only after that read succeeds. Realtime and chip UI suites
  passed **18/18**; two-account timing evidence remains outstanding.
- T025 partial harness checks empty confirmed versus indexing, permission loss,
  reauthorization and provider rate-limit presentation. A failed health read
  now retains the last same-team snapshot rather than hiding it; request
  generations prevent an old response replacing a newer team's state. The
  storage-health/chip/realtime suites passed **17/17** at this checkpoint;
  partial-coverage and delayed projections were completed in the later T027/T028
  checkpoint below.
- T025–T028 now add an additive `get_team_storage_health_v2` projection with
  `coverage`, `syncHealth`, `lastConfirmedAt` and `nextAction`. A queued
  discovered subtree downgrades coverage until its finite scan completes;
  creation time and mere job claims never count as confirmed success. The
  existing health RPC and catalog rows are unchanged. The web chip/settings
  display the distinction, including a beta note for partial/permission-limited
  access. Isolated PGlite coverage tests passed **5/5**, native pgTAP **8/8**,
  and the six targeted health/API/beta suites passed **46/46** before the final
  discovered-subtree assertion was added. No migration was applied to beta or
  production; this is not a provider-backed end-to-end acceptance result.
- Final US6 check: the added discovered-subtree PGlite assertion passed in a
  **5/5** coverage suite, native pgTAP passed **8/8**, and static verify passed
  **13/13** gates. This static form runs no tests; it is not a full `npm run
verify` or `verify:release` result.
- T029/T031 scheduler checks passed **8/8** in PGlite and **6/6** in isolated
  native PostgreSQL. They cover 3 user-priority claims plus one background
  claim, ten ready connections, checkpoint failure reset, seven simulated days
  of idle polling and 100 simulated changes/min for five minutes. The worker
  still claims one job per invocation. These are deterministic scheduling and
  cursor-integrity tests, **not** measured provider latency or a production
  throughput benchmark; SC-004/005/008/009 remain to be measured.
- T032 worker result logs now record only per-job kind/phase, starting folder
  queue length, runtime, Drive call count, processed count, slices and outcome.
  The counters do not publish byte progress or file names, paths, content or
  OAuth credentials. Provider call counts exclude token refresh and count the
  worker's direct Drive operations (including ancestry and transcript reads).
- T033 adds a private five-minute cleanup capped at 500 staging rows per call:
  completed-generation observations, abandoned generations older than 24 hours
  without a live lease, and terminal finite jobs older than seven days. Native
  pgTAP passed **9/9** in the isolated database, including batch bounds and
  protection of a live lease/canonical job. It has not run in beta or production.
- After T032/T033, the targeted scheduler/coverage suites passed **13/13** and
  `npm run verify -- --gates=static` passed **13/13** gates. This form runs zero
  tests; full `npm run verify` and release verification remain open.
- T035/T037/T038 add a browser-only manifest with explicit empty directories,
  mixed roots, all dropped-reader batches, Unicode comparison keys, and bounded
  counts/depth/bytes. The metadata validator rejects File/handle objects and
  absolute/traversal paths before any future journal serialization. The focused
  manifest suite passed **7/7** and project/test typechecks passed. This is a
  unit-level intake seam; Explorer drop/chooser integration and native fallback
  remain T036/T039–T047.
- The subsequent static rerun passed lint, project/test/script typechecks and
  the design/security fences, but its repository-wide Prettier gate exceeded
  the runner's 180-second budget on this machine. This is **not** a static PASS;
  the four new/edited manifest files were checked separately with Prettier.
- T036 Explorer DOM regressions now cover delayed drop enumeration with a
  frozen destination, an explicit same-name skip/keep-both decision, and a
  failed parent folder that must not stop an unrelated file. The three focused
  tests passed **3/3**. The pre-fix failed-parent path caused an unhandled
  rejection; the file loop now reports that item and continues. This is still
  the existing upload path, not the future workspace-wide coordinator.
- T039 adds the workspace-owned, in-memory upload coordinator above Explorer.
  It creates directories topologically, retains empty directories, runs at most
  three file transfers per group and six across the provider, refuses a known
  conflict without an explicit choice, and does not report success until the
  caller's authoritative catalog postcondition resolves. Focused provider
  tests passed **6/6**; project/test typechecks and targeted lint passed. The
  current Explorer drop/chooser still uses its previous upload loop until T040.
- T040 connects the Explorer drop entry point to that coordinator in a workspace.
  It snapshots the Drive/material destination before asynchronous enumeration,
  passes native drop entries through the lossless manifest (including empty
  directories), serializes conflict decisions, and waits for strict catalog/tree
  refresh before reporting success. The standalone Explorer legacy path remains
  for isolated use; chooser unification is T042–T047. Focused Explorer tests
  passed **4/4**, including an empty-directory integration case; provider tests
  passed **6/6**. Project/test typechecks and targeted lint passed.
- T041 adds a per-directory request key, Drive app-property replay lookup and an
  atomic `folder_create` claim in existing `team_operations`. Only the winning
  claimant may create; another Edge instance can confirm the marked Drive
  folder and commit its catalog row but cannot race a second create. Replayed
  keys with a different name/parent fail. The route retains upload authorization,
  server-side destination checks and the existing idempotent catalog upsert;
  success follows that upsert and the operation transition. New pgTAP claim
  assertions passed **7/7** in a rolled-back local transaction, with no local
  migration left applied. Focused Drive/Explorer/provider tests passed **38/38**;
  project/test typechecks, targeted lint and diff check passed. The local
  Supabase stack is behind the pending feature migrations, so linked generated
  types and the complete database gate remain release-verification work.
- T042 chooser tests cover handle/drop manifest parity, empty-only browser
  folder selection, no-handle behavior and chooser cancellation. The browser
  picker now passes its directory handle through the same manifest/coordinator
  as drop; `webkitdirectory` was removed because it loses empty folders. With
  no browser handle, the action stops before remote writes until the scoped
  agent fallback and actionable copy arrive in T043–T047. Focused chooser and
  Explorer tests passed **8/8**, with project/test typechecks and targeted lint.
- T043 defines the opaque native directory grant, bounded relative manifest,
  capability flag and typed select/chunk-read wrappers. The capability remains
  unadvertised until the native routes exist. Boundary, capability and guard
  tests passed **84/84**, with project/test typechecks and targeted lint.
- T044–T045 add a native folder picker and an ephemeral, picker-scoped agent
  grant. The agent enumerates explicit empty directories within manifest bounds
  and reads only bounded chunks of enumerated files; symlink escapes and stale
  identities are refused. Files-module registration, health advertisement,
  authentication, shutdown, cancel, grant expiry, and macOS/Windows picker
  branches have focused coverage: **82/82** tests passed, plus project/test
  typechecks, targeted lint and diff check. Live Windows picker validation
  remains pending for T059.
- T046–T047 use one inventory Add files menu with Files/Folder modes. Browser
  directory handles remain primary; when absent, the native adapter retains
  empty folders and streams enumerated files through bounded 2 MiB reads.
  Unsupported environments receive actionable copy before any cloud write;
  either chooser cancel is mutation-free. Focused Explorer/manifest/transfer
  tests passed **49/49**, with project/test typechecks, targeted lint and both
  design fences. Live macOS/Windows parity and zero-byte cloud finalize still
  require end-to-end acceptance; the latter is not proven by manifest tests.
- T048 fixes the local stage denominator contract: preparing/catalog checks and
  zero-byte transfer are indeterminate, while byte/item percentages use only
  confirmed work. Toasts use the inventory Progress, announce five-point
  increments and stage/detail copy, without making a progress network call.
  Focused toast/feedback tests passed **20/20**, with project/test typechecks,
  targeted lint and diff check. Provider-level progress projection and the
  full cloud-cost parity harness remain for T054–T055.
- `npm run verify` was retried after formatting two test files. Static gates
  passed again, but the serial full unit suite produced no terminal result
  after roughly ten minutes and was interrupted; this is **not** a full-suite
  PASS. Targeted catalog-sync tests passed **28/28**, realtime scale **2/2**,
  and project/test typechecks passed separately.
- The earlier complete `npm run verify` was not green: 3 bundle-budget failures,
  2 space-settings failures and 1 tool-registry failure were reported. That full
  suite has not yet been rerun after this block.
- 2026-09-26 local-only progress follow-up: `npm run verify` passed all 13
  static/build gates but failed the unit suite (3,956 tests reported). The
  failure list was three download-budget assertions, two space-settings cases,
  one tool-registry case and one two-factor SQL case. A targeted rerun passed
  two-factor SQL (14/14); the single space-settings callback case passed in
  isolation (1/1), though it timed out in the combined rerun. The tool-registry
  case still failed in isolation: it expected both remembered spaces but got
  only the first. This is not a green `verify` result.
- A fresh `npm run build -w @video-compressor/web` and
  `npm run build -w @video-compressor/agent` passed. The download-budget test
  still failed against fresh web assets: total gzip 858,282 versus 635,811
  allowed, entry 6,027 versus 5,645, and largest chunk 122,173 versus 95,563.
  The baseline must not be raised merely to make this gate green. Targeted
  local-progress, realtime and Explorer tests passed 30/30; the native grant
  log-redaction, operation-summary and coordinator tests passed 17/17 in a
  separate run. No provider-backed 20/20 MVP run or two-account timing was
  performed, and `verify:release` remains pending.
- US1 targeted rerun on the same checkout passed `catalog-sync.test.ts` and
  `team-folder-resync.test.tsx` **37/37**, covering finite sync and accepted
  versus completed UI regressions. This is deterministic test evidence only;
  the 20/20 provider-backed folder run, singleton/retry beta observation and
  cross-account timing required by T016/T023 are still unverified.
- `npm run verify:release` was also run on 2026-09-26. Its canonical
  `verification-result.json` reports **13/14 gates**, 3,956 tests and a failed
  suite gate; coverage has no final value because the suite failed. The six
  reported failures were the same three fresh-asset download budgets, two
  `space-settings` cases and the `tool-registry` expectation above. The
  earlier fast form additionally reported one transient two-factor SQL failure;
  its isolated 14/14 rerun passed. Neither verification form is a PASS, and
  no production or beta promotion was attempted.
- After T062–T063, `npm run verify` was rerun on 2026-09-26. The canonical
  `verification-result.json` reports **13/14 gates**, 3,962 tests and a failed
  suite gate. No new folder-sync test failure was reported. The five failures
  were the same three fresh-asset download budgets, one `space-settings`
  callback case (`STACK_TRACE_ERROR` only in the full suite), and the
  `tool-registry` two-space expectation. All six `space-settings` tests passed
  in isolation; the `tool-registry` expectation still fails in isolation
  because the HomePage limit renders one space. This is not a full verify PASS.
- Bundle triage on that build: the largest asset is the generated CSS at
  **122,173 B gzip**, followed by shared `heroui` (**114,489 B**) and `ui`
  (**109,187 B**) chunks. The local operations provider chunk is **7,009 B**.
  The budget baseline was measured on 2026-09-14, before multiple subsequent
  UI changes. This breakdown does not establish a single feature cause or
  justify increasing the baseline; T060 stays open pending an intentional
  budget review or reduction. `git diff --check` passed.
- `npm run beta:doctor` on 2026-09-26 failed only its running-container-runtime
  prerequisite. Colima is installed but `colima start` could not inspect its
  existing VM: the host-agent socket under the external Colima data volume
  refused the connection. No VM deletion/recreation or `beta:reset` was
  attempted. Thus provider-backed 20/20, two-account timing, and packaged-beta
  verification remain **unverified due to local environment**, not failed
  product acceptance. Native Windows picker and real Google Drive load
  scenarios are also unverified on this macOS host.
- A later `colima status`/Docker check and `npm run beta:doctor` on 2026-09-26
  still found no running container runtime. A non-destructive `colima start`
  again failed while inspecting the existing instance because its Lima
  host-agent socket refused the connection. `colima list` reports the default
  profile as **Broken**, while a Lima hostagent process and the socket still
  exist; `limactl list` does not find an instance under its default directory.
  This points to a host runtime state/configuration problem, not a product
  acceptance result. The existing VM/processes were not reset, killed or
  deleted, and no beta data was changed.
- A normal `colima stop` followed by `colima start` also left the existing
  profile `Broken` with the same refused host-agent socket. No profile reset
  or deletion was performed.
- Later on 2026-09-26, a separate `soty-beta-026` Colima profile (4 CPU, 8 GiB)
  started successfully after explicit DNS configuration. The broken `default`
  VM was stopped through Lima's instance-scoped force-stop; its orphaned SSH
  port-forward process was terminated after confirming it held only beta ports.
  Neither VM disk was deleted. Supabase CLI's Colima socket detection matches
  paths under `/.colima/`, so a local alias socket to the new profile was needed
  for its vector container to mount the guest Docker socket. With that alias,
  `beta:doctor` and `beta:up` passed; the local stack, web (5175), and agent
  (43140) became healthy. This is infrastructure recovery, not provider-backed
  feature acceptance.
- The fresh beta database initially had no users, spaces, or Drive connection.
  After backing up the 55 MiB of resettable `Soty Beta` local state to
  `/Volumes/LaCie/DevData/Colima/beta-state-backup-026.qXwXL6`, documented
  `beta:reset` applied the full migration chain and seeded one beta account and
  one space. It cleared eight resettable local entries; models and runtime were
  preserved. `beta:down`/`beta:up` then restored the seeded database. No Drive
  connection exists yet, so US1 provider-backed 20/20 and two-account evidence
  are still unverified.
- Native PostgreSQL on the seeded beta stack passed **90/90** pgTAP assertions
  across `folder-resync` (18), catalog ownership (14), scan generations (14),
  discovered subtree (6), coverage health (8), fairness (6), retention (9),
  workspace live state (8), and upload folder claim (7). These were run with
  pgTAP created inside each test transaction; every file rolled back. The beta
  fixture counts remained one user/one space afterward and pgTAP was not left
  installed. The `supabase test db --local` wrapper itself failed to connect
  through the host port-forward, so this is native SQL evidence, not a green
  wrapper result.
- A subsequent `npm run verify:release` after correcting the stale HomePage
  shortcut expectation reported **13/14 gates** and 3,962 tests in canonical
  `verification-result.json`. The suite still failed: the same three download
  budgets, plus two `space-settings` UI cases. The first UI case exceeded the
  default 5-second test timeout under the full suite; its successor then saw
  duplicate `Sync now` buttons from the unfinished test. Both cases now have
  15-second per-test timeouts without weakened assertions. Their targeted
  rerun with `tool-registry` passed **23/23**, test typecheck and diff check
  passed. At that checkpoint the whole release gate had **not** been rerun after
  the second timeout adjustment. The budget ratchet belongs to
  unfinished `specs/024-heroui-workspace` T143, which explicitly pairs added
  UI-library weight with deleted CSS; it must not be raised in isolation here.
- Convergence T062–T063 closed two US5 UI gaps. Browser manifest enumeration
  now reports bounded discovered file/folder counts to an indeterminate
  preparing toast; a delayed zero-byte child test sees the folder count before
  enumeration finishes. The local summary retains terminal outcomes, exposes
  failed relative paths and cancel, and routes retry to Explorer for explicit
  reselection of the original manifest/destination. A mismatched reselection
  stays in retry mode; it never falls back to a fresh group. Provider tests
  retain the succeeded-item/lost-finalize guards. Focused manifest/provider/
  Explorer/summary tests passed **29/29** after adding a delayed-enumeration
  cancel regression (no remote write after cancel); the fast static form passed
  **13/13 gates**. This does not supersede the failed full verification or
  live keyboard/screen-reader and two-account acceptance in T059.
- A repeat fast static verification on 2026-09-26 passed **13/13 gates**
  (`npm run verify -- --gates=static`), including format, lint, all typechecks,
  and design checks. This is not a full-suite or release result.
- On 2026-09-27 local time, the repeated `npm run verify:release` reported
  **13/14 gates** and 3,962 tests in canonical `verification-result.json`.
  The two `space-settings` failures were caused by an ambiguous test query:
  both the Explorer root and the Drive settings panel now have a `Sync now`
  button. The tests now select the button inside the `Google Drive storage`
  section and pass **6/6** in isolation; the full release suite reports no
  `space-settings` failure. Its only reported failures are the three unchanged
  download budgets: total 858,282 B versus 635,811 B allowed, entry 6,027 B
  versus 5,645 B, and largest chunk 122,173 B versus 95,563 B. Web and agent
  builds pass separately. The baseline remains unchanged pending the 024
  HeroUI/CSS weight review (T143), so T060 is still open and this is not a
  release-verification PASS.
- The existing `soty-beta-026` Colima VM and seeded local beta were restarted
  without reset. `beta:doctor` and `beta:up` passed using the profile's existing
  `~/.colima/soty-beta-026/docker.sock` alias. The first `beta:up` attempt with
  the external volume socket failed because Supabase vector could not reach its
  guest Docker socket; the alias resolved that local runtime issue.
- With the beta stack reachable, the standard `npm run test:db` first exposed
  six failures across 549 assertions. Three `catalog-progress` assertions used
  the retired ten-second schedule and lease-less worker signatures; one
  re-stitch assertion incorrectly included service-only functions; and the
  team-workspace grant list still required a retired claim helper. Those
  contract tests now assert the current 30-second read-relief cadence, fenced
  worker grants and caller-facing re-stitch API. The remaining failure was a
  real authorization bug: a non-member's null role bypassed the owner/admin
  check in `request_team_catalog_resync`. New migration
  `20260927010000_catalog_resync_role_guard.sql` makes null membership a
  denial without changing the function signature. Its rollback is documented;
  generated local public types still match the checked-in RPC shape.
- After that migration was tested in a rolled-back transaction and applied
  **only to local beta**, `npm run test:db` passed **553/553** across 15 files.
  The extra assertions confirm both non-member denial and administrator access.
  This database result is newer than the last `verify:release`, which stopped
  at the bundle-budget suite gate before reaching its database gate.
- On the current checkout, `npm run verify -- --gates=static` passed **13/13**;
  `npm run verify:release -- --gates=build` passed **5/5**; and
  `npm run verify:release -- --gates=e2e` passed **8/8**, including the standard
  database gate, accessibility gate and browser CSP smoke. The focused
  catalog-sync, ownership and folder-resync Vitest files passed **42/42** after
  the new migration. These split-phase results do not replace a full
  `verify:release` PASS because the suite phase still fails its three web
  download-budget assertions.
- A further full `npm run verify:release` after the catalog role-guard migration
  again passed all static gates and reported no other suite failure. It stopped
  at the same three download budgets on freshly built assets: total 859,161 B
  versus 635,811 B allowed, entry 6,028 B versus 5,645 B, and largest chunk
  122,173 B versus 95,563 B. This run preceded the Creative Library SQL-only
  fix below; its bundle sizes remain the relevant measured baseline.
- A second nullable `NOT IN` guard was found in the existing Creative Library
  contribution-aggregate RPC. A new foreign-team pgTAP assertion failed before
  the fix (`caught: no exception`), then passed after
  `20260927011000_library_totals_role_guard.sql` made missing membership an
  explicit denial. The migration was exercised in a rolled-back local
  transaction, its reverse guidance was documented, and generated types still
  match the checked-in function signature. It was applied **only to local
  beta**. The full `npm run test:db` suite then passed **554/554** across 15
  files, and focused Creative Library security/contribution Vitest files passed
  **6/6**. Neither guard migration has reached production.
- The beta lifecycle exposed a separate process-ownership issue: `beta:up`
  recorded the npm wrapper PID, while Vite listened from its child PID, so
  `beta:down` treated its own web listener as borrowed. The launcher now starts
  Vite directly from the web workspace. A subsequent local `beta:up` and
  `beta:down` both passed; ports 43140 and 5175 were released without resetting
  the seeded database. The static verification phase passed **13/13** after
  this change.
- `beta:down` now rechecks listener ownership before its `SIGKILL` escalation,
  so a process that takes over a released beta port is not force-killed. The
  beta-service policy tests passed **3/3**, static gates passed **13/13**, and
  another live `beta:up` → `beta:down` cycle passed with both ports released.

No production migration/deployment, two-account beta acceptance, Windows picker
validation or provider-load benchmark has been performed. These checks do not
complete T016/T034/T060 or prove that T012–T013 runtime adoption is finished.

Зупинити локальну beta:

```bash
npm run beta:down
```

До evidence додати результати `npm run verify`, pgTAP/Vitest, скриншоти або запис обох профілів, метрики масштабного прогону та перелік перевірених macOS/Windows середовищ. Результат не вважається повним, якщо каталог видимий лише після reload або повної реіндексації.
