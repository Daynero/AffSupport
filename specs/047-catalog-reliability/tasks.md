# Задачі реалізації каталогів

Статус: реалізація триває в ізольованій beta-гілці; перевірені результати наведені в Evidence. Порядок і рішення —
[план реалізації](plan.md), інциденти й вихідні вимоги —
[backlog CM01–CM16](../../docs/POST_RELEASE_PROBLEMS.md). Початок виконання — після поточного
релізу. Цей список не є дозволом на production publication.

Для кожної задачі після виконання додати commit, перевірені сценарії та результат
у рядок Evidence. Галочку ставити після перевірки, а не після написання коду.
Назви нових тестів нижче є запланованими; їх ще немає. Розширювати існуючий тест,
якщо він уже відповідає сценарію. Не створювати тести, що лише повторюють реалізацію.
Залежності означають потрібний контракт/результат, не дозвіл обійти release gate.

## Phase 1 — setup: точний післярелізний контекст

- [x] T001 зафіксувати післярелізну базу — `specs/047-catalog-reliability/reviews/baseline.md`. Залежності: завершення поточного релізу.
      Чистий isolated checkout від визначеного SHA; read-only versions/capabilities,
      migrations і beta provenance; звірка F01–F12 із фактичним кодом. Не переносити
      випадково незавершені зміни іншого релізу. Вихід: baseline у delivery evidence.
      **Evidence:** Isolated beta checkout and release SHA recorded in reviews/baseline.md/json; 68709d21 retains full fast verification and tested migration hashes. Actual connected beta ownership/source mismatch and absent candidate packaged proof remain explicit baseline facts, not claimed acceptance.

- [x] T002 карта всіх дій і writers — `specs/047-catalog-reliability/reviews/writers.md`. Залежності: T001.
      Перелік entry points у material action registry, Launch, product-catalog та
      manager; caller → API → RPC/worker → Drive/agent → UI → CLI. Окремо legacy,
      updater, recovery й late provider settlement. Позначити власника кожного
      state/refresh. Вихід: жодна поверхня або writer не лишилися неохопленими.
      **Evidence:** Writer/entry-point/state-owner inventory in reviews/writers.md; source paths reviewed for explorer, manager, create, Launch, scheduled/manual updater and native recovery. Current and proposed writers are separate; failed real provider fencing proof and the pending owner decision are linked.

- [ ] T003 відтворення інцидентів — `tests/catalog-incident-regressions.test.ts`. Залежності: T001–T002.
      `investigate/journal/inspect/catalog` з фіксованим as-of; bounded privacy-safe
      fixtures для Русланових failures та download/share. Побудувати failing regression
      для доведених F01/F05/F06/F09, зберегти невстановлені причини окремо.
      Вихід: доказова причина або конкретна прогалина для кожної скарги, без ad-hoc SQL.
      **Evidence:** —

## Phase 2 — foundational: спільні контракти

- [ ] T004 заморозити доменні й protocol контракти — `specs/047-catalog-reliability/contracts/catalog-lifecycle.md`. Залежності: T002–T003.
      Уточнити spec/data-model/contracts для виправлень, video sets і publication:
      N total, cardinality, states, errors, ACL/CAS, capabilities, ID joins, compatibility.
      Узгодити зі specs 031/035/039 і цим планом; не міняти конституцію або release intent.
      Вихід: повний список RPC, projections, consumers, writers і schema versions до DDL.
      Зафіксувати контракт provider spike (виконання першою дією T031,
      не prerequisite download/share US1) у `supabase/functions/_shared/drive.ts` +
      `tests/catalog-provider-write-contract.test.ts`: exact media conditional-write,
      external edit race, lost acknowledgement і actual-cell readback. Без доведеного
      CAS writer лишається blocked; unconditional fallback заборонений.
      **Evidence:** —

- [ ] T005 типізовані причини й actions — `packages/shared/src/types.ts`. Залежності: T004.
      Shared transport/error list, analytics schema/guards, `team/errors.ts`, uk/en,
      `code-map.ts`. Розрізнити transport, provider, validation, access, clipboard,
      unknown outcome; зберігати safe cause/stage. Перевірки: analytics-code-map та
      producer→guard, malformed/error payloads без витоку provider content.
      **Evidence:** —

## Phase 3 — US1 (P1): файли, посилання та діагностика

Незалежне приймання: A01–A06, real beta file/URL та synthetic CLI path.

- [ ] T006 [US1] закрити діагностику файлових дій менеджера — `apps/web/src/team/materials/MaterialActionHost.tsx`. Залежності: T005.
      `UpdaterRowActions`, `MaterialActionHost`, `useMaterialActions`: передати
      належний storage context, flow/attempt і surface. Share також має lifecycle.
      Перевірка: та сама дія з двох поверхонь доходить до ingestion з failure/success
      і не дублюється; telemetry failure не блокує користувача.
      **Evidence:** —

- [x] T007 [US1] приєднати native terminal до CLI — `scripts/analytics/investigate.ts`. Залежності: T005–T006.
      `queries.ts`, `investigate.ts`, recovery/catalog projections: journal terminal
      має зв’язок із parent/child operation навіть без browser events. Перевірити
      неправильну зупинку inspect на `team.tariff_recovery` reservation. Регресія
      на дві відомі operation Руслана, late/duplicate/conflicting/missing terminal.
      **Evidence:** ed55a766; reviews/verification-fast-manager-native.json (14/14 gates, 8739 tests); native/inspect/investigate regressions and pinned read-only incident readback described in reviews/implementation-progress.md.

- [x] T008 [US1] bounded audit і часові межі CLI — `scripts/analytics/coverage-registry.ts`. Залежності: T005, T007.
      Виявити запит statement timeout; розділити недоступність джерела й решту звіту,
      bounded queries/read-only limits, as-of і current_snapshot. `catalog-updates.ts`
      не видає поточні дані за історичні. Перевірки: query timeout, partial source,
      truncation, unavailable schema і unsupported producer → явний unknown.
      **Evidence:** ed55a766; reviews/verification-fast-manager-native.json; audit failure isolation, bounded native joins and temporal-cutoff regressions; pinned real CLI audit proves source availability, with coverage gaps kept explicit.

- [ ] T009 [US1] виправити download готових каталогів — `supabase/functions/drive-transfer/handler.ts`. Залежності: T003, T005–T006.
      `drive-transfer/{handler,index}`, `useMaterialActions`, agent download/transfer.
      За доведеним типом файла реалізувати правильний bytes/export contract, grant,
      MIME/filename/size/identity handling; native Sheets тільки в дозволеному режимі.
      Перевірки: A01–A02, малий/agent файл, 403/404/expiry/stream interruption; browser
      handoff не записується як disk_saved. Результуючий beta-файл відкривається.
      **Evidence:** —

- [ ] T010 [US1] виправити share/get-link — `supabase/functions/library-ops/index.ts`. Залежності: T003, T005–T006.
      `library-ops`, `api/team.ts`: missing webViewLink/permission verification
      мають класифіковані причини; результат отримується лише з довіреного provider
      contract. Використати idempotent intent/receipt, reconciled retry після втрати
      відповіді; перевірити межі edit/view/share. A01–A03, ready/restricted/revoked.
      **Evidence:** —

- [ ] T011 [US1] стійке отримання URL у UI — `apps/web/src/team/materials/MaterialActionHost.tsx`. Залежності: T010.
      Спільний action host/dialog: pending lock, окремі available/public/copied
      outcomes, поле URL із Copy/Open при denied clipboard. Охопити menu, direct
      catalog buttons і explorer. Перевірки: double click, denied clipboard, закриття
      меню, довгий URL, keyboard; не повторювати share через clipboard failure.
      **Evidence:** —

- [ ] T012 [US1] строгі API результати та неповні списки — `apps/web/src/api/team.ts`. Залежності: T005.
      `api/team.ts` guards для registry/profiles/run/retry/cancel: invalid rows
      позначаються partial, invalid counts/booleans не перетворюються в no-op.
      Моделювати optional legacy fields окремо. Перевірки: A04, valid empty,
      mixed rows, malformed entire response, 0/false проти invalid.
      **Evidence:** —

- [ ] T013 [US1] продемонструвати причину й частковість у менеджері — `apps/web/src/team/catalog-updater/useCatalogUpdater.ts`. Залежності: T012.
      `useCatalogUpdater`, Dialog, list analytics: valid rows доступні, malformed
      omissions/stale read явно показані, Retry читання не виконує mutation.
      Перевірки: старий список при outage, відсутній профіль, відхилені рядки,
      неповний список не створює хибного порожнього success.
      **Evidence:** —

- [ ] T014 [US1] наскрізне приймання отримання результату — `tests/catalog-diagnostics-ingestion.test.ts`. Залежності: T007–T013.
      Тести `material-action-surfaces`, `catalog-ui-diagnosis`, `drive-transfer` та
      beta A01–A06 із реальним provider. Окремо реалізувати synthetic local
      producer→sanitizer→ingestion→SELECT-only CLI acceptance за quickstart;
      не вмикати production telemetry в beta. Виписати browser-save blind spots.
      Вихід: файл/URL реально отриманий, safe evidence читається CLI; можна формувати
      окремий пакет стабілізації за package acceptance у quickstart для його exact SHA.
      Повні T056–T060 не закривати за виконання subset.
      **Evidence:** —

## Phase 4 — US2 (P1): автоматична заміна картинки

Незалежне приймання: A07–A08, один click bad+good і bounded failure/cancel.

- [ ] T015 [US2] класифікувати передачу картинки без втрати причини — `apps/agent/src/team-bridge/screen-cache.ts`. Залежності: T005.
      Agent `transfer.ts` → `screen-cache.ts` → `restitch.ts`: missing/forbidden,
      expired grant, changed identity, checksum/decode/animated, local write, transient
      network та canceled. Preserve causes in closed codes/journal. Регресії на
      transfer_failed, checksum_mismatch, cache_write_failed та abort.
      Bounded full screen decode preflight для fresh/cache, corrupt-cache refetch і
      truncated-but-probeable fixtures; лише ffprobe metadata не приймає screen.
      **Evidence:** —

- [ ] T016 [US2] серверний bounded підбір кандидатів — `supabase/functions/drive-ops/updater-restitch.ts`. Залежності: T004, T015.
      Existing draw RPC/`updater-restitch.ts` і shared selection policy: exclusion
      за candidate+version+slot; shared exact budgets C4, durable consumed counters,
      exclusions за визначеним scope, exhaustion ≠ limit reached,
      перевірка ACL на кожний grant. Не передавати credentials/URLs у diagnostics.
      DB-тести: одна/кілька/всі непридатні, source version changed, empty/missing pool.
      **Evidence:** —

- [ ] T017 [US2] автоматичний fallback усіх шляхів — `apps/web/src/team/restitch/screens.ts`. Залежності: T016.
      `team/restitch/screens.ts`, shared orchestrator, native/recovery/updater:
      на класифікований file failure запитати інший кандидат до processing,
      зберегти підтверджений slot. Transient retry обмежений; outage не перебирає пул.
      Перевірки: один click → готове відео, без loop на останньому файлі, all paths parity.
      **Evidence:** —

- [ ] T018 [US2] пам’ять відмов і snapshot діагностики — `apps/agent/src/team-bridge/recovery-journal.ts`. Залежності: T016–T017, T007.
      Зберігати durable per-attempt exclusions + bounded 24h refusal memory між
      звичайними натисканнями за C4; explicit revalidate окрема дія. Ефективні settings/version і
      parent-child IDs; expired/changed source можна перевірити знову. CLI показує,
      чи повторно вибрана та сама картинка, а не лише загальний screen_fetch_failed.
      Перевірки: unchanged bad + новий click/restart, TTL/version/settings reset,
      successful repair, all remembered bad, eviction; current vs historical settings, privacy guard.
      **Evidence:** —

- [ ] T019 [US2] cancel, recovery і повідомлення при fallback — `apps/agent/src/team-bridge/restitch.ts`. Залежності: T017–T018.
      Скасування припиняє draw/download, не запускає FFmpeg; cleanup та uncertainty
      fences збережені. UI показує заміну/вичерпання/мережу/права/диск і дію користувача.
      Перевірки: cancel на межі grant/process, late response, no healthy candidates,
      power throttling на обох ОС; ніякого вигаданого terminal за таймером.
      **Evidence:** —

- [ ] T020 [US2] повна регресія підготовки — `tests/team-restitch-screens.test.ts`. Залежності: T015–T019.
      `team-restitch-*`, `updater-restitch-routes`, `launch-restitch-runner`,
      `team-catalog-restitch-sql`, analytics journal/inspect. A07–A08 у beta та CLI.
      Вихід: повтор інциденту дає автоматичне відновлення або точну кінцеву причину.
      **Evidence:** —

## Phase 5 — US3 (P1): надійний менеджер

Незалежне приймання: A09–A13, lost reply, partial batch, no-op та progress identity.

- [x] T021 [US3] спільне збереження одиночних і bulk змін — `apps/web/src/team/catalog-updater/useCatalogInlineChanges.ts`. Залежності: T012–T013.
      Виділити мінімальний save/readback controller із `useCatalogInlineChanges`;
      підключити BulkEditor. CAS, accepted/rejected/conflict/unknown, per-item
      outcomes, максимум 4 writes. A09: втрачена відповідь після commit, failed
      readback, retry не повторює confirmed rows і не перезаписує чужі правки.
      **Evidence:** shared saveCatalogProfile controller used by inline and bulk; exact version/readback, typed stale conflict, read-only unknown recovery, scope revocation and four-write bound covered in catalog-profile-save-controller, catalog-inline-changes and catalog-bulk-editor tests. Full canonical verification: reviews/verification-fast-export-save.json (14/14 gates, 8769 tests). Commit 68709d21.

- [ ] T022 [US3] точний bulk schedule та undo — `apps/web/src/team/catalog-updater/CatalogBulkEditor.tsx`. Залежності: T021.
      BulkEditor + IntervalPicker + server patch: interval/time/day/zone атомарні;
      mixed/keep semantics, legacy anchor, DST і preview за server clock.
      Перевірки: одиночний/bulk parity, undo після чужої зміни, зменшення scope,
      failed validation і unknown save не виглядають як confirmed.
      **Evidence:** —

- [ ] T023 [US3] per-item масове видалення — `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`. Залежності: T005–T007, T012.
      `deleteSelected` перевести на наявний workspace receipt/batch seam: partial
      refresh, stable request keys, failed/unknown selection, відновлення/Undo.
      A10: A success/B failed/C unstarted, lost reply, referenced output і running catalog.
      **Evidence:** —

- [ ] T024 [US3] узгодити run/stop/retry — `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`. Залежності: T012, T021.
      Dialog/History + RPC: фактичний accepted count, no-op/false, спільний lock,
      retry same intent після readback; stop current і schedule off окремі.
      A11: дві вкладки, double click, success/cancel race, stale profile/attempt.
      **Evidence:** —

- [ ] T025 [US3] progress із прив’язкою до attempt — `apps/web/src/team/catalog-updater/CatalogProgressRow.tsx`. Залежності: T007, T020, T024.
      Додати відсутню active-attempt identity у read model; ProgressRow/History
      приймають лише matching signals, нова спроба скидає старий максимум.
      A13: back-to-back без inactive poll, old progress, hover, partial, stale observation.
      **Evidence:** —

- [ ] T026 [US3] bounded читання history/readback — `apps/web/src/team/catalog-updater/useCatalogUpdater.ts`. Залежності: T013, T021.
      Перевикористати readCoordinator/withReadDeadline, abort, visibility/actor/team
      scope. Не створювати нового polling owner. A12: завислий Promise, hidden/refocus,
      unmount, old response; відновлення читання не повторює запис.
      **Evidence:** —

- [ ] T027 [US3] consistent profile/runtime snapshot — `apps/web/src/team/catalog-updater/useCatalogInlineChanges.ts`. Залежності: T021, T025–T026.
      Розділити versioned settings і runtime facts; дві відповіді registry/profile
      не створюють вигаданого узгодженого стану. Refresh не підміняє підтверджені
      локальні settings старішими; newer runtime приймається без зміни settings version.
      Перевірки: optimistic/readback/realtime reorder і settings change під час run.
      **Evidence:** —

- [ ] T028 [US3] очищення scope та навігація — `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`. Залежності: T021, T026–T027.
      Locks, drafts, selection, undo, visibleFlows належать team/actor/catalog scope.
      Unsaved/pending/unknown мають доступний recovery, close та контрольовані guards.
      Перевірки: switch team/login, late completion, permission revoked, browser exit.
      **Evidence:** —

- [ ] T029 [US3] truthful outcome історії та command telemetry — `scripts/analytics/catalog-updates.ts`. Залежності: T023–T028.
      Server accepted, provider verified, last success, partial video й UI visible
      розрізнені; catalog current projection не замінює історію спроб. Перевірити
      CLI source join, read-after-write та unknown recovery без нового run.
      **Evidence:** —

- [ ] T030 [US3] приймання стабільного менеджера — `tests/catalog-updater-dialog.test.tsx`. Залежності: T021–T029.
      Розширити catalog-inline/bulk/dialog/row-progress/profile-outcome/runtime tests,
      DB/RPC concurrency. A09–A13 і smoke A01–A08, owner/editor/viewer.
      Вихід: пакет core reliability перед початком багатоваріантного виконання;
      ранній release — окремий package acceptance за quickstart, full tasks лишаються відкритими.
      **Evidence:** —

## Phase 6 — US4 (P2): N відеоваріацій

Незалежне приймання: A14–A17, N physical outputs, persisted mapping, restart/cancel.

- [ ] T031 [US4] модель video-set і сумісні міграції — `packages/shared/src/team/catalog-video-set.ts`. Залежності: T004, T020, T030.
      Спершу виконати T004 provider spike до нових writer migrations; failed proof
      блокує writer/US4, не вже прийнятий download/share. Shared config/profile/Launch
      snapshots, N=1 legacy default, generation/variant
      unique identities, row assignment, ref guards, safe projections. Additive DDL,
      ACL/CAS/cross-team tests, generated DB types. Old writers не claim новий contract.
      Валідація N на effective productCount, без мовчазного clamp.
      Add recipeRowId/recipeRevision і private per-generation slots за data-model;
      не використовувати catalog variant або legacy singleton spare для N.
      Оновити generated `apps/web/src/lib/database.types.ts` і ROLLBACK.md.
      **Evidence:** —

- [ ] T032 [US4] чистий генератор розподілу — `packages/shared/src/team/catalog-video-set.ts`. Залежності: T031.
      Shared seeded/persisted mapping row identity→index; shuffled balanced coverage
      усіх N за internal recipeRowId (не мінливим public product ID). Golden/property
      tests N=1/5/P, P змінено, duplicate IDs, retry/reorder;
      не змінювати distribution у повторі тієї самої row recipe.
      **Evidence:** —

- [ ] T033 [US4] durable parent/child orchestration — `supabase/functions/drive-ops/catalog-durable.ts`. Залежності: T031–T032.
      Розширити catalog intent/recovery: requested N, lazy child claims, attempt keys,
      all-ready gate, partial/unknown state, bounded scheduling. Нема eager grants
      на весь набір. Оновити `supabase/functions/team-recovery/handler.ts` і
      `apps/agent/src/team-bridge/recovery-worker.ts`: actual installed executor
      negotiation, не server RESTITCH_CONTRACT_VERSION як доказ підтримки.
      DB/concurrency tests: duplicate claim, lease takeover, ready replay, old agent/new server.
      **Evidence:** —

- [ ] T034 [US4] виконання варіацій агентом — `apps/agent/src/team-bridge/restitch.ts`. Залежності: T017–T019, T033.
      Existing restitch + managed spawn/recovery-journal: один stable child на index,
      source cache за version, окремі selections, upload receipts; shared power budget.
      A14/A16: 5 фізичних outputs, crash/restart, throttle, grant refresh,
      невідомий upload не запускає друге відео того самого child.
      **Evidence:** —

- [ ] T035 [US4] запис набору в усіх catalog writers — `supabase/functions/_shared/product-catalog.ts`. Залежності: T032–T034.
      `_shared/product-catalog`, `_shared/catalog-updater`, catalog-durable,
      launch-catalog, updater worker: N URL через immutable assignment. Existing
      single-link variation semantics не підміняють набору. Підготувати спільний
      writer policy seam для T043 із доведеним у T031 provider contract, catalog-wide
      reservation і actual cells/recipe readback (marker недостатній). Не міняти active mapping при partial.
      **Evidence:** —

- [ ] T036 [US4] input N у всіх entry points — `apps/web/src/team/launches/LaunchEditor.tsx`. Залежності: T031, T035.
      Launch draft/defaults/validation, create dialog/settings flow, manager button+
      input, detail/bulk. Shared bounds, visible total N, off restitch explanation,
      active snapshot isolation. Оновити
      `packages/shared/src/team/launches/revisions.ts` та SQL receipt/cache fingerprints:
      N/source/settings/recipe змінюють compatible video-set reuse, delay-only edit
      змінює publication intent, але повторно використовує сумісний готовий set.
      A14–A15: 1→10→1, delay-only edit, N>1/restitch off, invalid/mixed counts.
      **Evidence:** —

- [ ] T037 [US4] єдиний K/N progress — `apps/web/src/team/catalog-updater/CatalogProgressRow.tsx`. Залежності: T025, T033–T036.
      Launch/creation/manager читають однаковий ready count і child stage; N/N video
      не означає catalog delivered. Restart/refocus відновлюють receipts, не percent
      за таймером. A16: queued/running/failed/unknown children й terminal всього набору.
      **Evidence:** —

- [ ] T038 [US4] cancel і retention наборів — `apps/agent/src/team-bridge/recovery-worker.ts`. Залежності: T033–T037.
      Parent cancel припиняє enqueue; resumeForTermination, final receipts, cleanup
      refs між каталогами та future publication consumer seam (його records/tests — T049). Старий каталог зберігається до
      підтвердженої заміни. A17: cancel процесу/перед upload/після unknown upload/apply.
      **Evidence:** —

- [ ] T039 [US4] діагностика варіацій — `scripts/analytics/catalog-generations.ts`. Залежності: T007–T008, T031–T038.
      Producers/projections/CLI: generation→index→attempt→output; effective N,
      fulfilled/failed/canceled/unknown, fallback causes, visible delivery.
      Coverage inventory і missing/delayed/cross-version regressions, bounded privacy-safe rows.
      **Evidence:** —

- [ ] T040 [US4] приймання CM15 — `tests/catalog-video-variants.test.ts`. Залежності: T031–T039.
      Нові `catalog-video-variants` доменні/SQL/agent/UI тести + A14–A17 на обох ОС.
      Beta: N реальних outputs, усі представлені в каталозі, restart не дублює
      готові 3/5; stress до допустимого N без одночасних 400 важких processes.
      **Evidence:** —

## Phase 7 — US5 (P2): відкладене додавання

Незалежне приймання: A18–A24, empty before due, real server publication після due.

- [ ] T041 [US5] publication policy/job storage — `packages/shared/src/team/catalog-publication.ts`. Залежності: T004, T031, T040.
      Additive schema: dueAt/zone/revision, generation binding, lease/fence,
      policy immediate/scheduled/held окремо від job state, timestamps, references,
      one-active-job invariant; після published одноразовий job consumed, future update immediate.
      Typed source/video_set publication target для restitch off/on; окремий
      catalog_video_deliveries active target/assignment, null до first publish.
      Legacy adoption і active/pending refs за data-model, без fake generated child.
      Old records immediate; old clients не очищують policy. SQL ACL/CAS/fencing tests.
      **Evidence:** —

- [ ] T042 [US5] календарний contract і валідація часу — `packages/shared/src/team/catalog-publication.ts`. Залежності: T041.
      Shared date/time/zone parsing та server instant; browser/server clock skew,
      past/missing time, DST gap/fold. Використати наявний timezone seam; не сканувати
      всі зони при кожному збереженні. Unit + SQL parity A18.
      **Evidence:** —

- [ ] T043 [US5] publication guard усіх writers — `supabase/functions/catalog-updater/worker.ts`. Залежності: T035, T041–T042.
      Common reservation/revision guard перед зміною відеополів: creation, scheduled,
      manual, Launch recovery, retry і delayed worker. Before due/held: новий каталог
      має порожні video cells; вже published зберігає чинні URL без нової заміни;
      old writer refuse/skip. A20/A24: жоден шлях не обходить час або нову capability.
      **Evidence:** —

- [ ] T044 [US5] server-side due job — `supabase/functions/catalog-updater/worker.ts`. Залежності: T041–T043.
      Вбудувати у чинний bounded scheduler/worker ownership, без browser timer:
      claim due, готовність outputs, reserve, apply, verify, settle; retry_wait/late.
      Перед claim/apply revalidate membership/delegation/entitlement і source version/access
      або живі N outputs відповідно до target kind;
      revoked/deleted → blocked, registered count не підміняє ready K/N.
      Не тримати DB transaction під час provider IO. A19/A22: browser закритий,
      agent offline після підготовки, worker restart, not-ready і provider failure.
      **Evidence:** —

- [ ] T045 [US5] створення каталогу з порожніми відеополями — `supabase/functions/drive-ops/launch-catalog.ts`. Залежності: T043–T044.
      Launch/standalone/updater generation: правильна таблиця доступна до publication,
      готовність відео й due job окремі. Розділити existing completed-restitch-receipt
      prerequisite у launch-catalog: table_create та video_set_ready gates.
      Restitch off + N=1 + delay використовує original target без video set.
      Job registration idempotent з catalog intent;
      lost create reply не створює другу таблицю. Empty fields, не fake URLs. A18–A20.
      **Evidence:** —

- [ ] T046 [US5] reschedule, cancel, add-now та конкурентні зміни — `apps/web/src/api/team.ts`. Залежності: T044–T045.
      Revision CAS, explicit held після скасування; Add now через same writer seam.
      Running provider write спочатку reconcile. Held→scheduled з новою валідною датою
      підтримується без Add now; перевірити після reload і concurrent reschedule. Delete/regular growth/replacement
      перев’язують чи блокують job; stale mapping не записується. A21/A23 без видалення
      уже published links через вимкнення checkbox. Active delivery pointer swap лише
      після verified settlement; routine writer під час pending/held бере active target.
      **Evidence:** —

- [ ] T047 [US5] checkbox, календар, час і manager status — `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx`. Залежності: T042, T045–T046.
      Existing UI inventory у Launch/create/settings/manager; видима зона, confirmed
      due, separate table-ready/video-ready, late/blocked reason, reschedule/cancel/add-now.
      Перевірки keyboard, unknown save, past time, checkbox off, N=5 і browser reload.
      **Evidence:** —

- [ ] T048 [US5] CLI та producer coverage відкладення — `scripts/analytics/catalog-updates.ts`. Залежності: T007–T008, T041–T047.
      Safe schedule_saved/catalog_without_video/waiting/due/apply/verified/visible,
      revision/supersede/cancel, requested count і lateness. `catalog`/`investigate`
      пояснюють відсутність URL без показу URL. A05/A22: missing worker/browser events.
      **Evidence:** —

- [ ] T049 [US5] відновлення та утримання outputs — `supabase/migrations/ROLLBACK.md`. Залежності: T038, T044–T048.
      Pending publication захищає N outputs; cleanup не видаляє їх як unused.
      Unknown write → readback, duplicate due delivery → той самий receipt.
      A17/A21/A23: late callbacks, restart, removed catalog, failed cleanup,
      повтор не генерує відео та не перемішує рядки заново.
      **Evidence:** —

- [ ] T050 [US5] приймання CM16 і поєднання з CM15 — `tests/catalog-video-publication.test.ts`. Залежності: T041–T049.
      Нові `catalog-video-publication` domain/DB/worker/UI/CLI regressions, A18–A24.
      Реальна beta таблиця до due порожня у відеополях; після verified містить
      правильний mapping 5 відео. Окремо restitch off + delay (original target) та
      published 1→pending 10: чинний mapping до due, новий тільки після settlement.
      Перевірити routine update перед due і одночасно з ним, held→rescheduled.
      **Evidence:** —

## Phase 8 — polish: UX і швидкодія

- [ ] T051 узгодити всі видимі сценарії — `apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx`. Залежності: T030, T040, T050.
      Рядок/деталі/Launch/create: один vocabulary станів і next action, inline N,
      schedule/delay не плутаються; selection явно включає hidden selected count.
      Помилка не обнуляє last success; partial/unknown не ховаються за зеленим toast.
      Дизайн за DESIGN.md, компоненти/токени без raw values.
      **Evidence:** —

- [ ] T052 доступність та фокус — `tests/catalog-updater-dialog.test.tsx`. Залежності: T051.
      Focus return за catalog ID, не назвою; duplicate/long names, keyboard/Escape,
      nested dialogs, tooltip focus, 390 px, zoom 200%, uk/en, reduced motion.
      Browser A25 + релевантні accessibility regressions; screenshot evidence.
      **Evidence:** —

- [ ] T053 виміряти й прибрати зайву роботу списку — `apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx`. Залежності: T026–T027, T051.
      Виконати reproducible protocol у quickstart.md: 0/60/500/2000 rows,
      render/input/read counts, baseline/after, environment і raw samples. Maps замість
      repeated find/findIndex, stable row props; pagination/virtualization лише за
      потребою вимірів зі збереженням full-search/select-all. A26, ціль p95 ≤200 мс/500.
      **Evidence:** —

- [ ] T054 тести помилок і текстів допомоги — `apps/web/src/team/errors.ts`. Залежності: T051–T053.
      UI/CLI мають однаковий причинний code; missing/rights/network/disk/pool-exhausted
      messages дають реальну дію. Delayed schedule не маскує failure; source-refusal
      не називається битим файлом. Перевірити переклади, видимий retry/cancel і нефатальні fallback.
      **Evidence:** —

- [ ] T055 acceptance sweep усіх поверхонь — `specs/047-catalog-reliability/reviews/acceptance.md`. Залежності: T051–T054.
      CM12/CM13, A01–A26 на реєстрі T002; підтвердити однакові options/defaults,
      права, готовність і recovery. Оновити specs 035/039/031, walkthrough та
      support instructions; прибрати застарілі обіцянки/обхідні поради.
      **Evidence:** —

## Phase 9 — cross-cutting: приймання та release evidence

- [ ] T056 комплексна fault/concurrency матриця — `specs/047-catalog-reliability/reviews/fault-matrix.md`. Залежності: T014, T020, T030, T040, T050, T055.
      Виконати A01–A26 і уточнення C1–C8 з code/evidence references: timeout перед/після commit,
      duplicate/reordered messages, two workers/tabs, cross-team ACL, old versions,
      cancel/apply race. Не приймати mock coverage як доказ реального provider outcome.
      **Evidence:** —

- [ ] T057 міграції, сумісність, bounded ресурси — `supabase/migrations/ROLLBACK.md`. Залежності: T056.
      Replay повного chain через isolated DB runner, RLS/role tests, default N=1,
      immediate legacy, old-writer fences, reference protection, 400-child lazy scheduling,
      macOS/Windows power/cancel. Без remote database URL і без production mutations.
      **Evidence:** —

- [ ] T058 canonical verify та packaged beta — `specs/047-catalog-reliability/reviews/verification.md`. Залежності: T057.
      Single-worker touched suites, `npm run verify` до коміту, release gates і
      exact-SHA packaged beta за runbook. Один heavy child, nice 15, справжня beta
      auth/entitlements. Зберегти machine-readable verification result, UI/provider/CLI evidence.
      **Evidence:** —

- [ ] T059 скласти конкретний release candidate і звіт — `specs/047-catalog-reliability/reviews/release-candidate.md`. Залежності: T058.
      Перелік commit/migrations/capabilities, завершені A-scenarios, material risks,
      accepted limitations і recovery runbook. Shared/agent/functions не видавати
      за mini web release. Publication тільки за окремо авторизованим production intent.
      Для проміжного пакета явно вказати subset; решта T-задач лишаються відкритими.
      **Evidence:** —

- [ ] T060 перевірити ефект після авторизованого релізу — `specs/047-catalog-reliability/reviews/post-release.md`. Залежності: T059 і фактичний реліз.
      Fixed as-of CLI для Руслана/нових контрольних спроб; denominator + freshness +
      cohorts, no new unknown codes; практично отримати файл/URL і пройти N=5+delay.
      Закрити кожну скаргу лише за доказом. Відсутній/недоставлений signal не є успіхом.
      **Evidence:** —

## Зв’язок із усіма вихідними вимогами

| Вимога              | Задачі                            | Приймання         |
| ------------------- | --------------------------------- | ----------------- |
| CM01 відтворення    | T001–T004                         | База для A01–A26  |
| CM02 download       | T009, T014                        | A01–A02           |
| CM03 share/copy     | T010–T011, T014                   | A01–A03           |
| CM04 fallback       | T015–T020                         | A07–A08           |
| CM05 diagnosis      | T005–T008, T018, T029, T039, T048 | A05–A06, A16, A22 |
| CM06 contracts      | T012–T013, T027                   | A04, A11          |
| CM07 bulk/calendar  | T021–T022                         | A09               |
| CM08 commands       | T024, T029                        | A11               |
| CM09 delete         | T023                              | A10               |
| CM10 reads/recovery | T026–T028                         | A12               |
| CM11 progress       | T025, T029, T037                  | A13, A16          |
| CM12 UX             | T051–T052, T054–T055              | A25               |
| CM13 performance    | T053                              | A26               |
| CM14 acceptance     | T056–T060                         | A01–A26           |
| CM15 N variations   | T031–T040                         | A14–A17, A23–A24  |
| CM16 delayed links  | T041–T050                         | A18–A24           |

F01–F04 покривають T005–T011; F05–F06 — T012/T013/T024;
F07–F08 — T021/T022; F09 — T023; F10 — T025; F11 — T026;
F12 — T053. Попередні інциденти 1–5 backlog збережені як доказові fixtures T003.

## Формат доказу виконання

Для виконаної задачі Evidence має містити: SHA, суттєві змінені файли,
команду/результат тесту, applicable A-ID, діагностичний приклад з opaque IDs
та обмеження. Для UI/provider задач — фактичне спостереження в beta.
Для completed нового lifecycle потрібен весь producer→ingestion→CLI шлях.
Не прикладати secrets, grant URLs, сирі шляхи/контент або user media.

Старий baseline 89 тестів не зараховується як виконання цих нових задач.
Планування не ставить галочок реалізації. Стан у backlog оновлювати разом
з evidence цього чекліста, без другого незалежного списку completed.

## Порядок і можливе паралельне виконання

Setup T001–T003 → foundation T004–T005 → US1 (9 tasks) → US2 (6) → US3 (10)
→ US4 (10) → US5 (10) → polish/cross-cutting (10). Setup/foundation разом 5.
Детальні залежності в кожній задачі мають пріоритет над фазовим порядком.
MVP — US1 з applicable acceptance/release gates; N/delay не є умовою виправлення download.

Один heavy process на машині; відсутність [P] — свідомо консервативна:
shared/API/SQL файли перетинаються, цілі tasks не є безумовно паралельними.
Після завершення вказаних prerequisites можна розподілити незалежні підчастини:

- US1 після T005: розслідування fixtures download (T009) та read-only CLI join (T007).
- US2 після T016: web fallback caller (T017) та native preflight fixture (T019).
- US3 після T021: BulkEditor schedule (T022) та scoped reads (T026).
- US4 після T035: Launch input (T036) та CLI projections (T039), після появи producers.
- US5 після T046: calendar UI (T047) та CLI output formatting (T048), після контрактів.

Це можливості для майбутнього виконавця, не дозвіл на одночасні heavy tests або
конкурентні правки одного файла. Кожен increment закривається власною regression
і наскрізним доказом до переходу до наступного. Спочатку failing tests усередині
кожної bug/state-machine задачі, потім implementation і acceptance; не чекати
кінцевого T056, щоб уперше перевірити поведінку.
