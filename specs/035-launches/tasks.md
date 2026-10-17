# Tasks: 035 — Запуски

**Вхід:** [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts](contracts/launch-api.md), [quickstart.md](quickstart.md). Дата: 12.10.2026.

Імплементацію розпочато за окремою командою користувача. Позначки нижче відображають тільки перевірені завершені задачі; решта може містити частковий код. Production deployment не дозволений цією роботою.

**Обсяг:** 70 задач: 16 підготовчих/фундаментальних, US1 — 13, US2 — 15, US3 — 8, US4 — 7, US5 — 5, 6 фінальних. Паралельні можливості й незалежна прийомка наведені нижче.

## Організація та правила виконання

US1–US5 і пріоритети нижче — групування сценаріїв специфікації для виконання, а не зміна погодженого обсягу. Усі п’ять сценаріїв потрібні для повної готовності. MVP означає внутрішній перевірюваний зріз «Інше», а не дозвіл випустити неповний модуль.

| Сценарій | Пріоритет | Джерело               | Результат                                                |
| -------- | --------- | --------------------- | -------------------------------------------------------- |
| US1      | P1        | §3.1, §4–9            | Створити запуск «Інше», отримати та скопіювати результат |
| US2      | P1        | §3.1–3.2, §10, §12–13 | Каталог, точний прогрес, recovery і скасування           |
| US3      | P1        | §3.3, §4.1, §14       | Ручні правки, явне оновлення, незмінна історія           |
| US4      | P2        | §3.4, §4, §15         | Простір, виконавці, фільтри та стандартні параметри      |
| US5      | P2        | §3.5, §16, AC-44      | Копіювання та безпечне видалення запуску                 |

Формат: `- [ ] Tnnn [P?] [USn?] дія з конкретним шляхом`. `[P]` означає незалежні файли **після виконання зазначених залежностей**, а не можливість виконати задачу до фундаменту. Послідовні задачі одного файла не паралелити. Майбутні файли нижче є запропонованими точками реалізації; чинні seams перелічені в plan/research. Нові timestamp міграцій обрані після поточного останнього `20261201100000`; перед реалізацією перевірити колізії й за потреби синхронно оновити посилання.

Тести прямо передбачені §17 специфікації. Для кожного зрізу спочатку написати відповідні тести й отримати очікуваний fail, потім реалізувати. Використовувати синтетичні URL/секрети, локальну БД та чинний test harness. Не звертатися до production і не додавати нових бібліотек/сервера/файлового сховища. Shared strict TypeScript/NodeNext є єдиним джерелом доменних правил; Edge використовує зібраний shared/dist.

## Фаза 1. Підготовка

Мета: закріпити контракти й безпечні тестові входи; не повторювати дослідження з нуля.

- [x] T001 Звірити робочі рішення `adv+`, bounds, literal SUB keys та відкриті production gates із `specs/035-launches/research.md`; записати в `specs/035-launches/quickstart.md` матрицю середовищ, відсутні рішення й критерії перевірки Google Drive visibility та signed tracking URLs. Невизначеність не блокує локальну розробку на синтетичних даних, але не позначається як погоджена.
- [x] T002 Підготувати синтетичні fixture builders у `tests/fixtures/launches.ts`: два простори, ролі, соц/РК з однаковими suffix, material versions, календарні дати, raw URLs, catalog child outcomes; використати наявний test harness без нового runner. Equal-suffix account options перевірені у `launch-editor-preview` 2/2 PASS.

## Фаза 2. Фундамент — shared domain, persistence, diagnostics

Блокує інтеграцію US1–US5. Вихід: єдині генератори, захищене зберігання, atomic intent і typed lifecycle. Чисті тести T004–T006 незалежні після T003; T007–T009 реалізуються після їхнього fail.

- [x] T003 Визначити config/draft/result/revision/generation/step DTO, enums, bigint-as-string versions і input guards у `packages/shared/src/team/launches.ts`; експортувати через `packages/shared/src/team/index.ts`, не дублюючи existing Account/Material/Restitch types. Визначити typed expectedSourceSnapshot для preview sources та current IANA timezone у copy payload за contracts/launch-api.md.
- [x] T004 [P] Додати golden URL/ASCII vectors у `tests/launch-url.test.ts`: untouched bytes, duplicates, empty preserve, encoded/case keys, fragment, macros, spaces, Cyrillic/emoji, invalid scheme/host/length; повторна генерація тільки з original.
- [x] T005 [P] Додати Math.round/manual budgets, ranges, naming, local tomorrow/DST/leap/year і preview purity/performance cases у `tests/launch-generators.test.ts`; включити всі бюджетні приклади й age=100.
- [x] T006 [P] Додати DB/permission/idempotency/state tests у `tests/launch-persistence.test.ts`, `tests/launch-state.test.ts` і `supabase/tests/database/launches.test.sql`: foreign IDs, viewer, blocked space, immutable revisions, stale versions, active lock, request replay/mismatch і cancel-vs-commit.
- [x] T007 [P] Реалізувати boundary validation і normalization у `packages/shared/src/team/launches/validation.ts`: Buyer/creative ASCII обов’язково, social коли використаний, пробіли→`_`, унікальні ordered variables, partial draft проти generate validation, limits; не перейменовувати sources.
- [x] T008 [P] Реалізувати lossless raw-segment patcher у `packages/shared/src/team/launches/url.ts`: original зберігати дослівно, змінювати лише values literal `sub1/sub2/sub3`, усі дублікати, missing active append перед fragment, empty preserve; URL parser тільки для validation, не serialization всього URL.
- [x] T009 [P] Реалізувати чисті budgets/ranges та naming/date helpers у `packages/shared/src/team/launches/budgets.ts` і `packages/shared/src/team/launches/naming.ts`: строгі manual budgets, явний reset при N/max change, method suffix, versioned fixed template, local date-only tomorrow.
- [x] T010 Зібрати чистий preview і dependency signatures у `packages/shared/src/team/launches/preview.ts`, експортувати через `packages/shared/src/team/launches.ts`; довести однакові результати browser/Edge, відсутність IO, rebuild shared та Edge import smoke у `tests/launch-shared-parity.test.ts`.
- [x] T011 Створити forward-only schema у `supabase/migrations/20261201110000_launches.sql`: dictionaries/defaults/member prefs, launches/revisions/campaigns/generations/steps/revision_catalogs, snapshot/schema versions, FK/team constraints, unique request/reservation boundaries, indexes; rollback notes у `supabase/migrations/ROLLBACK.md`. Додати expected_source_snapshot у draft aggregate та recovery next_attempt_at/lease indexes за data-model.md.
- [x] T012 Створити grants/RLS і атомарні read/draft/metadata/dictionary/default/history RPC у `supabase/migrations/20261201111000_launch_access.sql`: explicit actor/team ACL, safe list projection без URL, protected detail, draft/aggregate optimistic versions, archived references; не відкривати raw sensitive tables через Realtime. saveLaunchDraft атомарно зберігає expectedSourceSnapshot із config; partial draft дозволений, Generate вимагає повного source expectation.
- [x] T013 Створити restricted intent/step/lease/fence/publication/cancel RPC у `supabase/migrations/20261201112000_launch_generation.sql`: одна unsettled generation, durable digest replay, source-version recheck, atomic candidate+campaigns, CAS active revision; всі mutators перевіряють generation lock.
- [x] T014 Оновити `apps/web/src/lib/database.types.ts` штатним способом і тонкі typed wrappers/response guards у `apps/web/src/api/team.ts` за `contracts/launch-api.md`; лишити permissions авторитетними на сервері, transport timeout відновлювати тим самим requestKey.
- [x] T015 Ввести typed Launch lifecycle/stage/terminal/visible/cancel/recovery signals та safe error codes у `packages/shared/src/team/analytics.ts`, `packages/shared/src/types.ts`, `apps/web/src/analytics/events.ts`, `apps/web/src/analytics/guard-contract.ts`; узгодити closed sets із `scripts/analytics/code-map.ts` без content payloads. Typed producers/sanitizers і code-map tests пройшли, а повний agent-readable шлях лишається у T016/T066.
- [x] T016 Додати agent-readable Launch evidence joins у `scripts/analytics/queries.ts`, `scripts/analytics/investigate.ts` та capability entries у `scripts/analytics/coverage-registry.ts`: flow/generation/attempt/child, last proven stage, missing terminal/visibility; покрити sanitized/missing/delayed evidence у `tests/launch-analytics.test.ts`, не писати до production. Restricted DB view і read-only `inspect`/`investigate`/`audit` показують attempt number, відсікають майбутній та позаперіодний стан і розрізняють persisted vs visible; `launch-analytics` 9/9 PASS. Повний source→CLI/missing-code audit лишається T066.

## Фаза 3. US1 — створити запуск «Інше» (P1, MVP)

Незалежна прийомка: з локальними account/material fixtures створити N=3/max=30/ads=3, побачити 10/20/30 і точні назви, згенерувати один URL, скопіювати та повторно відкрити результат. Жодного catalog/restitch IO; перезавантаження не повторює generation. Залежить від фази 2.

- [x] T017 [P] [US1] Додати UI acceptance у `tests/launch-ui.test.tsx` та суміжні `launch-editor-preview`, `launch-creative-picker`, `launch-overrides`, `launch-history`: усі поля, ordered SUB/reorder, live preview purity, alias ASCII, single creative, required accent, compact age+, tomorrow, result copy/clipboard failure та reopen. `launch-editor-preview` 3/3 і повний Launch sweep 207/207 PASS; live MVP лишається у T029/T068.
- [x] T018 [P] [US1] Додати server flow tests у `tests/launch-other.test.ts`: canonical source join, одна generation при double-click/timeout, короткі реальні stages, authoritative lock, cancel/commit race, no catalog calls, no secrets у response metadata. Включити rename Buyer/соца між preview і Generate при незмінній Launch version → SOURCE_CHANGED без side effects; replay accepted intent не resolve-ить новий результат.
- [x] T019 [US1] Реалізувати source resolution і server orchestration other у `supabase/functions/drive-ops/launches.ts`, підключити action guards у `supabase/functions/drive-ops/index.ts`: читати saved draft, перевіряти membership/тариф/material/РК, рахувати shared results, приймати intent до IO й публікувати через fenced RPC. Порівнювати збережений expectedSourceSnapshot з server-resolved sources до accepted intent; DB sources recheck атомарний, Drive version revalidation перед використанням. Unknown source identity не дає cache hit.
- [x] T020 [US1] Додати route й мінімальний список Launches у `apps/web/src/team/routes.ts`, `apps/web/src/team/TeamSpace.tsx`, `apps/web/src/team/workspace/WorkspaceShell.tsx`, `apps/web/src/team/launches/LaunchList.tsx`, `apps/web/src/team/launches/LaunchCard.tsx`: один Launch = одна плитка, ready→result, unfinished→settings, Tasks не змінює subtype.
- [x] T021 [US1] Створити контрольований draft hook у `apps/web/src/team/launches/useLaunchDraft.ts`: explicit save, dirty state/navigation handling, authoritative version conflicts, default tomorrow тільки при створенні; preview не зберігає фінальний результат. Draft/конфліктний ввід тільки в RAM, без browser storage/journal/cache; explicit refresh sources оновлює expectedSourceSnapshot і preview для нового підтвердження; logout/scope switch очищає RAM.
- [x] T022 [P] [US1] Створити searchable account/offer/Buyer selectors у `apps/web/src/team/launches/LaunchSelectors.tsx`: existing UUID joins, full external ID для розрізнення suffix, inline dictionary create, offer як один текст, Buyer окремо від assignee.
- [x] T023 [P] [US1] Створити single-material adapter у `apps/web/src/team/launches/LaunchCreativePicker.tsx`, використавши `apps/web/src/team/tasks/TaskAttachmentPicker.tsx`, `apps/web/src/team/catalog/material-actions-client.ts` і чинний drop/upload pipeline; другий файл явно відхиляти, alias без extension не перейменовує файл.
- [x] T024 [P] [US1] Створити ordered SUB builder у `apps/web/src/team/launches/SubBuilder.tsx`: індикатори ①–④, keyboard reorder, лише enum variables, empty preserve, live normalized values та field errors; довгий фінальний URL у формі не показувати.
- [x] T025 [US1] Зібрати форму й паралельне desktop preview у `apps/web/src/team/launches/LaunchEditor.tsx` і `apps/web/src/team/launches/LaunchPreview.tsx`: усі §5 поля, budgets/manual reset, warning-token для required empty/invalid, optional/hidden без warning, compact числовий age +; HeroUI inventory/tokens, без нової дизайн-системи.
- [x] T026 [US1] Реалізувати generation controller у `apps/web/src/team/launches/useLaunchGeneration.ts` через чинні `apps/web/src/team/useTeamRealtime.ts` та `apps/web/src/api/useAgentEventStream.ts`: initial/reconnect/foreground read, request lookup, stateVersion ordering, pending/lock/cancel, без нового recurring polling і без fake delay.
- [x] T027 [US1] Створити компактний `apps/web/src/team/launches/LaunchResult.tsx` і `apps/web/src/team/launches/CopyResultField.tsx`: summary/URL/campaigns/assignee/status, copy всім полем і клавіатурою, actual clipboard success→green confirmation; не показувати технічні IDs.
- [x] T028 [US1] Додати всі US1 тексти у `apps/web/src/i18n.ts` та lifecycle/result_visible/clipboard outcome integration у `apps/web/src/team/launches/analytics.ts`; термін URL без AIO, signals без текстів/URL/імен.
- [ ] T029 [US1] Завершити US1 acceptance і producer→CLI trace у `tests/launch-other.test.ts`, `tests/launch-ui.test.tsx`, `tests/launch-analytics.test.ts`; записати результат targeted runs і MVP сценарію в `specs/035-launches/quickstart.md`. Chrome beta довела Other draft save/reload та validation без генерації; `launch-other` 8/8 довела, що typed live-source mismatch не створює generation intent. Live Generate/result і повний producer→CLI шлях ще відкриті через відсутні РК/креатив/Drive source у beta fixture.

## Фаза 4. US2 — каталог, прогрес, recovery та скасування (P1)

Незалежна прийомка: fixture Launch із catalog/restitch off/on створює одну variation й Google Drive sheetUrl; збої після create/finalize/link відновлюють той самий output; cancel не публікує candidate і після settlement повертає draft/попередній result. Спільний catalog hardening можна почати після фази 2; UI інтегрується після US1.

- [x] T030 [P] [US2] Додати fault injection/reservation/replay/cancel regressions у `tests/product-catalog-handler.test.ts`, `tests/launch-catalog.test.ts`, `tests/launch-catalog-execution.test.ts` і `tests/launch-state.test.ts`: concurrency на одному video, lost create reply, child succeeded before catalog link, late fenced executor та failure sharing. Суміжний прогін **76/76 PASS**; live provider matrix лишається в T044.
- [x] T031 [P] [US2] Додати progress/lock/reconnect/cancel UI tests у `tests/launch-progress.test.tsx`, `tests/launch-generation-hook.test.tsx`, `tests/launch-operation-observation.test.tsx`, `tests/team-realtime.test.tsx` і workspace UI: nullable вимір, stages skipped без restitch, child vs parent completion, cleanup_pending, closing tab не cancel, жодних timer percentages. Суміжний прогін **32/32 PASS**; live provider progress лишається T036/T044.
- [x] T032 [US2] Витягнути orchestration із `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx` у `apps/web/src/team/product-catalog/catalog-orchestration.ts`: existing dialog використовує той самий seam, durable checkpoint adapter замість залежності від React processed/key state; зберегти parity у `tests/product-catalog-parity.test.ts`.
- [x] T033 [US2] Додати atomic variation reservation, operation→result lookup та provider/sharing ownership ledger у `supabase/migrations/20261201113000_catalog_generation_recovery.sql`; уникнути MAX+1/replay дефекту, прив’язати випадковий вибір rows до прийнятого intent, надати тільки потрібні service grants.
- [x] T034 [US2] Використати `supabase/functions/drive-ops/catalog-durable.ts` як спільний begin/replay adapter до `product-catalog.ts` для старого dialog і Launch callers: reservation перед variant/random/sharing, frozen rows, окремий registration checkpoint і bounded replay без другого генератора.
- [x] T035 [US2] Додати bounded provider-marker lookup/reconciliation у `supabase/functions/_shared/drive.ts` та `supabase/functions/drive-ops/product-catalog.ts`: persist intent до create, ID після, verify scope/owner/mime/parent, lost reply не веде до blind recreate; inconclusive lookup→interrupted.
- [x] T036 [US2] Завершити measured checkpoints/counts і cancel/fence checks для create/finalize/link у спільних `catalog-durable.ts`/`product-catalog.ts`; Launch UI не повинен трактувати timer stages або константні відсотки як вимір. `uploading/30` у `drive-ops/index.ts` належить звичайному file-copy flow, тому не змінювати його в межах Launch. Зберігати prior permission і created permission ID та явно показувати unknown outcome. Create/finalize/link мають fenced durable receipts; UI рахує лише succeeded server steps і показує indeterminate catalog progress без виміряного total. Live Drive fault matrix лишається у T044/T068.
- [ ] T037 [US2] Довести ownership-aware cleanup і bounded hosted recovery до кінця. `launch-recovery.ts`, `catalog-updater/index.ts` і міграції 138000–192000 дають due→dispatch→lease→fenced trash, native quiescence, bounded backoff і exact-ID source grant cleanup з DB consumer proof, retained registered consumer та pending unknown. Synthetic SQL/worker regressions і локальний pgTAP проходять. Provider pagination fix у `drive.ts` не дозволяє вважати grant на другій сторінці видаленим після lost DELETE; Drive/catalog/recovery regressions 102/102 PASS і static 13/13 PASS. Наступна edge-case регресія відхиляє порожній/некоректний `nextPageToken` у listing та marker lookup; прицільні 49/49 PASS. Незакрите: live Google/worker fault matrix, зокрема lost create/delete replies та паралельні image consumers у реальному Drive. Не відмічати `cleanup_pending` як success і не повторювати terminal failed child без explicit retry.
- [x] T038 [US2] Захистити Launch-linked каталоги від неявного recreate/update/trash через DB guards у `supabase/migrations/20261201130000_launch_catalog_mutation_guards.sql` та існуючі action routes: operation rename/move/content_edit/new_version/trash, folder trash, updater round, replace intent, version overwrite. Regression у `tests/launch-state.test.ts`; reuse path повторно перевіряє доступність каталогу й не запускає implicit recreate.
- [x] T039 [US2] Розширити coordinator у фактичних `drive-ops/launches.ts` і `drive-ops/launch-catalog.ts`: optional persisted restitch child, frozen screens/settings/source identity, окремий productCount, existing `createDurableProductCatalog`→XLSX/Sheets pipeline, child/material/catalog IDs і Google Drive webViewLink. Synthetic coordinator/state/parity тести проходять; live Drive proof лишається у T044/T068.
- [x] T040 [US2] Підключити чинні restitch grants/contract/defaults через каталоговий блок фактичного `LaunchEditor.tsx`, `apps/web/src/team/launches/restitch-runner.ts`, наявні `screens.ts` і agent restitch seam: UI показує хвилини, config зберігає секунди, preparation фіксує screens/settings/source, підтримує reuse і waiting_dependency без агента. `launch-catalog-settings`, `launch-restitch-runner` та authoritative state regressions проходять; live agent acceptance лишається у T044/T068.
- [x] T041 [US2] Довести parent→child cancel і fencing у `supabase/functions/drive-ops/launches.ts`, `supabase/functions/drive-ops/launch-recovery.ts`, `apps/agent/src/team-bridge/process.ts`: resumeForTermination, PowerGovernor/timeout scaling, previous result restore лише після settlement; success-before-cancel повертає completed. Durable cancel/cleanup fences та попередній result перевірені `launch-state` 41/41, recovery 13/13; native resume/terminal finalize — `team-bridge` 21/21, restitch runner 7/7. Live Drive/native fault matrix лишається в T044/T068.
- [x] T042 [US2] Додати `apps/web/src/team/launches/LaunchGenerationProgress.tsx`, розширити `apps/web/src/team/processing/OperationStatus.tsx` nullable measured progress і використати у Launch workspace/result flow; прибрати timer illusion для Launch у reuse seam `apps/web/src/team/product-catalog/ProductCatalogProgress.tsx`, додати i18n етапів. Launch використовує лише authoritative persisted stages/counts через `LaunchGenerationProgress`, не викликає timer-based `ProductCatalogProgress`; невідомий або нульовий total лишається indeterminate. `launch-progress` 6/6 та `team-file-operations` 9/9 PASS.
- [x] T043 [US2] З’єднати hosted stages/local SSE/recovery diagnostics у `apps/web/src/team/launches/useLaunchGeneration.ts`, `apps/web/src/team/launches/analytics.ts`, `scripts/analytics/code-map.ts`, `scripts/analytics/coverage-registry.ts`; unknown child outcome показувати як insufficient, не успіх. `inspect` і `investigate` називають unsettled cancellation blind spot; synthetic hosted/child/diagnostic sweep 49/49 PASS. Live provider acceptance лишається T044/T068.
- [ ] T044 [US2] Пройти fault injection matrix, existing XLSX/parity/handler regressions і macOS/Windows restitch contract у `tests/launch-catalog.test.ts`, `tests/launch-progress.test.tsx`, `tests/product-catalog-xlsx.test.ts`; зафіксувати доказ variant reuse/cleanup/Drive link у `specs/035-launches/quickstart.md`. Local paginated-permission/lost-DELETE/cyclic-token fault slice PASS; malformed changes cursor теж відхиляється (суміжні 71/71 PASS). Live provider та решта матриці відкриті.

## Фаза 5. US3 — редагування та історія (P1)

Незалежна прийомка: на готовому fixture редагувати кожне result поле, скопіювати до save, зберегти/reopen/reset із помаранчевою позначкою; age-only update створює revision без каталогу, URL change — новий каталог зі старим придатним restitch. US1 потрібний для інтеграції; catalog cases залежать від US2.

- [x] T045 [P] [US3] Додати manual outputs tests у `tests/launch-overrides.test.tsx` із `tests/launch-ui.test.tsx`, `tests/launch-revisions.test.ts` і авторитетними state regressions: кожен allowed field, local copy, editor click не copy, baseline/reset/orange badge, no derived side effects, viewer/version conflict, limits і save/reopen. Перевірити dependent mismatch hint при ручному URL/budget/range/SUB, save/reopen/reset; warning не викликає IO. Профільний Launch sweep **204/204 PASS**; live каталогова залежність лишається в T046/T044.
- [x] T046 [P] [US3] Додати dependency/history/source tests у `tests/launch-revisions.test.ts`: name-only, unused Buyer, URL/source/restitch changes, deleted/moved sources, old overrides, explicit confirmation, immutable previous output і no silent mutation. Explicit restore historical config (стара дата/config budgets, dirty save/discard/cancel, source removed, viewer, generation lock/conflict) покрито також `launch-history` і `launch-workspace-ui`; active result незмінний до нової generation. Разом 41/41 PASS. Live Drive source mutation лишається T044/T068.
- [x] T047 [US3] Реалізувати dependency decision і bounded manual-output guards у `packages/shared/src/team/launches/revisions.ts`, експортувати через `packages/shared/src/team/launches.ts`: names/URL/media/catalog signatures, original baseline + overrides map, SUB ASCII validation; ручний URL не нормалізувати serializer-ом.
- [x] T048 [US3] Додати `list_launch_revisions`/`save_launch_overrides` у `supabase/migrations/20261201114000_launch_revisions.sql`: atomic version/ACL/lock, baseline relation, immutable manual snapshot, catalog reuse та безпечні summary; wrappers у `apps/web/src/api/launches.ts` і `apps/web/src/api/team.ts`. Authoritative state і manual UI regressions проходять.
- [x] T049 [US3] Підключити revision impact у фактичних `drive-ops/launch-catalog.ts`/`launches.ts` і service reuse RPC: names-only reuse catalog, URL change зберігає перевірений restitch material і резервує нову variation, source/settings changes виконують залежні етапи. Source identity/availability перевіряються повторно, старі overrides не переносяться; synthetic state/revisions/catalog tests проходять, live Google прийомка лишається у T044/T068.
- [x] T050 [US3] Додати inline editing/local overrides у `apps/web/src/team/launches/CopyResultField.tsx` і `apps/web/src/team/launches/LaunchResult.tsx`: усі displayed generated fields, warning token + «Змінено вручну», поточне значення для copy до save, reset baseline, явне збереження нової manual revision. Показати «Змінено для копіювання; каталог не оновлено» для advertisingUrl override й відповідні залежні підказки для інших полів; derivation від baseline/overrides зберігає їх після reopen, reset прибирає.
- [x] T051 [US3] Підключити `LaunchHistory.tsx` і `LaunchChangeReview.tsx` у фактичній `LaunchSpace.tsx`: історичний перегляд, explicit change confirmation, «Відновити конфігурацію» через authorized read у RAM draft зі старою датою, dirty save/discard/cancel, source refresh перед новою генерацією й попередження beforeunload. Історія не відновлює result overrides чи metadata; `launch-history`, `launch-revisions`, `launch-overrides` разом 16/16 PASS. Додаткова UI регресія забороняє показ попереднього result під URL іншої revision до завершення protected read в обидва напрями (суміжні 45/45 PASS). Перехід на іншу revision того самого Launch і browser Back/Forward тепер питають discard при dirty RAM draft; `launch-workspace-ui` 32/32, launcher 10/10, team navigation/finance 14/14 PASS. Chrome live switching лишається T068.
- [x] T052 [US3] Додати typed privacy-safe outcomes для manual save, історичного restore, copy і generation у `apps/web/src/team/launches/analytics.ts` та UI тексти в `i18n.ts`; `launch-analytics` 7/7, `launch-overrides` 6/6 і `launch-revisions` 6/6 PASS. Catalog reuse regression — `launch-state` та `launch-catalog-execution`; зовнішня Drive прийомка лишається у T044/T068.

## Фаза 6. US4 — робота в просторі, фільтри та defaults (P2)

Незалежна прийомка: два користувачі й кілька Launch fixtures; Calendar→Yesterday→Today фільтрує launchDate до pagination разом зі статусом/виконавцем; defaults діють лише на новий draft; Buyer та assignee незалежні. Залежить від US1, не від catalog happy path.

- [x] T053 [P] [US4] Додати query/permissions/defaults tests у `tests/launch-workspace.test.ts`: cursor/date/status/assignee composition, DST, dictionary uniqueness/archived refs, active mutation lock, source snapshots, default whitelist і optimistic conflict. `launch-workspace` 9/9 PASS; active lock/source snapshot додатково покриті авторитетними `launch-state` regressions (`LAUNCH_BUSY`/`SOURCE_CHANGED`).
- [x] T054 [P] [US4] Додати calendar/defaults/collaboration UI tests у `tests/launch-workspace-ui.test.tsx`: Tasks control order, range/clear, active assignee, member revoked, two tabs/reconnect, optional fields без accent, existing drafts незмінні. `launch-workspace-ui` 22/22 та `team-realtime` 12/12 PASS; два авторизовані Chrome-сеанси beta підтвердили появу draft і зміну todo→in_progress через Realtime/list refetch. Штатний `TeamSpace` тепер чекає на вже наявний `TeamProvider` read, не дублюючи початковий список просторів.
- [x] T055 [US4] Довести list/query/metadata/defaults/dictionary RPC у `supabase/migrations/20261201115000_launch_workspace.sql` і наступних 128000/162000 проєкціях: stable date/id cursor, filter до limit, assignment/workStatus, member/permission checks і metadata-only cards без URL/SUB. Generated `database.types.ts` синхронізовано з локальним Postgres; `launch-workspace` 5/5 PASS, ширші collaboration/DST тести лишаються у T053/T059.
- [x] T056 [US4] Додати search/status/assignee/date filters у фактичний `apps/web/src/team/launches/LaunchSpace.tsx` через чинний `TaskDateFilterControl` з `inlineDays` (Calendar→Yesterday→Today), reset cursor при новому query; `LaunchCard.tsx` показує budgets/status/assignee. Server-side filter-before-pagination перевірено у `tests/launch-workspace.test.ts`.
- [x] T057 [US4] Застосувати workspace defaults у фактичному `LaunchSpace.tsx`/`useLaunchDraft.ts`: config плюс окремий ordered SUB builder лише для нового draft, «Зберегти як стандартні», DB whitelist без URL/material/date/РК/offer/assignee/overrides і `LaunchDefaultsReview.tsx` для version conflict без silent overwrite. `launch-defaults-review` + `launch-workspace` 7/7 PASS.
- [x] T058 [US4] Додати assignment/status controls у спільну оболонку фактичного `LaunchSpace.tsx` із чинного UI inventory, server authority й workspace Realtime invalidation через `useTeamRealtime.ts`; активна генерація блокує mutators, scope switch очищає session/cache. Authoritative state і workspace UI regressions проходять; двокористувацька прийомка лишається у T059/T068.
- [x] T059 [US4] Завершити diagnostics, i18n і collaboration acceptance у `apps/web/src/team/launches/analytics.ts`, `apps/web/src/i18n.ts`, `tests/launch-workspace.test.ts`, `tests/launch-workspace-ui.test.tsx`; перевірити revoked membership і invalidation без повторних subscriptions/polling. Серверний list/detail після видалення учасника відмовляє, UI прибирає protected detail при втраті view, Realtime coalescing має один channel і catch-up на reconnect/visibility. Суміжний прогін workspace/UI/realtime/i18n/analytics **84/84 PASS**; двосеансове beta оновлення статусу PASS. Окрема live перевірка другого користувача після revoke лишається у T068.

## Фаза 7. US5 — копіювання та видалення (P2)

Незалежна прийомка: copy ready/draft→одна незалежна tomorrow/todo чернетка без outputs/files/overrides; archive з historical catalog попереджає про збереження Drive ресурсів, unchecked preference комітиться лише після успіху. Залежить від US1; історичні fixtures можуть перевірятися без живого catalog provider.

- [ ] T060 [P] [US5] Додати copy/archive atomic/ACL tests у `tests/launch-copy-archive.test.ts`: request replay, stale source, unavailable material/member, tomorrow, no files/results/history copied, historical catalog warning, preference scope й no Drive deletion. Current browser timezone проти source, deterministic midnight/DST через `private.launch_tomorrow`, missing material revalidation і durable aged-receipt replay — 11/11 PASS; повна migration chain у beta reset і static 13/13 PASS. Chrome beta додатково довела draft→copy з новим ID та archive обох через UI; fixture очищено. 16.10 нова чернетка показала 17.10 після фактичної зміни локальної доби. Залишилося live beta підтвердження replay копії після реальної зміни дати та відсутності Drive side effects; не називати synthetic clock/receipt доказом реальної доби.
- [x] T061 [P] [US5] Додати warning/action UI tests у `tests/launch-workspace-ui.test.tsx`: unchecked «Не показувати знову», cancel не зберігає, failed archive повторюється тим самим ключем без окремого запису preference, active generation locked, copy відкриває settings. Перевірено 10/10 UI tests; preference фіксується лише серверною archive transaction.
- [x] T062 [US5] Додати atomic copy/archive/preference RPC у `supabase/migrations/20261201120000_launch_copy_archive.sql` із forward guard `20261201188000_launch_copy_generation_guard.sql`: source snapshot/version recheck, fresh tomorrow date за user timezone contract, todo/active assignee, no derived outputs, history-aware warning eligibility, preference у тій самій успішній archive transaction. API приймає current IANA timezone; сервер validate-ить і рахує tomorrow від часу першого commit, зберігає date/timezone. Replay з тим самим payload повертає первісну дату; changed timezone/same key → conflict. `launch-copy-archive` 8/8 PASS; реальний перехід через північ лишається у T060.
- [x] T063 [US5] Підключити wrappers у `apps/web/src/api/team.ts` та дії у `apps/web/src/team/launches/LaunchSpace.tsx`, `apps/web/src/team/launches/LaunchCard.tsx` і спільному `apps/web/src/team/launches/useLaunchCopy.ts`: replay timeout без нового key, inline доступний copy, один warning при archive за потреби; не trash-ити catalog/restitch. Передавати timezone браузера, утримувати той самий timezone/key для retry після півночі.
- [x] T064 [US5] Додати локалізацію і safe copy/archive diagnostics у `apps/web/src/i18n.ts`, `apps/web/src/team/launches/analytics.ts`; завершити відповідні сценарії у `tests/launch-copy-archive.test.ts`, `tests/launch-workspace-ui.test.tsx` та `tests/launch-copy-hook.test.tsx`, включно з активним method=other та історичним каталогом при поточному method=other. Targeted 20/20 PASS; новий copy guard у migration 188000 не блокує replay підтвердженої копії.

## Фаза 8. Наскрізна прийомка та готовність до релізу

Залежить від усіх US. Це перевірки майбутньої реалізації, а не автоматичний дозвіл на production. Не відкладати основну телеметрію до цієї фази: тут доводиться її повний шлях.

- [ ] T065 [P] Додати наскрізну synthetic secret regression у `tests/launch-privacy.test.ts`: input→handler/error→logs/audit/analytics/list/Realtime/CLI, URL/CAPI/ручні values відсутні поза protected detail та явно погодженим catalog content; закрити data visibility gate у `specs/035-launches/research.md` тільки за реальним рішенням. Перевірити також localStorage/sessionStorage/IndexedDB/Cache API/workspaceOperationJournal і service-worker cache protected detail після input/conflict/copy/reload/logout: секретів немає; unsaved values існують тільки в RAM. Local producer→persisted analytics queue→sender/logout і DB list/Realtime/request ACL/detail **15/15 PASS**. UI очищає protected detail після non-retryable rejected read (permission/space/not-found/invalid-response), зберігає RAM edits після retryable error та відкидає dirty new draft тільки після confirm; `launch-workspace-ui` 29/29 і `launch-privacy` 6/6 PASS. Live Chrome discard/reopen/storage результат не підтверджений через перерване керування вкладкою; CAPI visibility decision залишається відкритим.
- [ ] T066 [P] Розширити `tests/launch-analytics.test.ts`, `tests/analytics-code-map.test.ts`, `scripts/analytics/coverage-registry.ts`: failure/partial/cancel/interruption/recovery/lost-visible, missing/delayed signals і source→guard→CLI; audit/inspect/investigate мають розрізняти fact/hypothesis/insufficient. `launch-analytics` 21/21 PASS, включно з partial/interrupted і fact/insufficient. Real local PostgreSQL probe виявив nullable `result_is_active` crash; migration 26000 + regression 10/10 і read-only `inspect`/`audit` після `beta:reset` PASS, synthetic URL absent. Повторний beta-only read-only `audit --period 30d` через локальну dedicated role повернув `uncovered/launch_evidence_in_period` без хибного success, бо beta generation fixture відсутня. `inspect` явно надає пріоритет DB terminal над conflicting browser terminal; DB час нормалізовано в UTC, malformed step timestamp із synthetic secret стає `unknown` та `unexpected` blind spot. Суміжні 43/43 PASS. Live SSE/provider delivery та повна producer→guard→CLI матриця залишаються.
- [ ] T067 Пройти keyboard/clipboard/reduced-motion/narrow-screen/token і preview performance checks у `tests/launch-ui.test.tsx`, `tests/launch-progress.test.tsx`; поправки лише через чинний UI inventory/`apps/web/src/styles/tokens.css`, доказ preview <=50мс для N100 зафіксувати у `specs/035-launches/quickstart.md`. Chrome beta 390×844: document без горизонтального overflow, статус прокручується всередині, новий editor keyboard ArrowDown/Escape/Tab PASS; `launch-workspace-ui` 23/23 і static 13/13 PASS. Browser reduced-motion та live clipboard/result interaction ще відкриті.
- [ ] T068 Виконати всю матрицю AC-01–46 у `specs/035-launches/quickstart.md`: local DB/RLS, Edge shared parity, catalog fault injection, source mutation, two tabs, offline/reconnect, macOS/Windows/throttle; позначити реальні результати й залишкові external gates, не ставити PASS без evidence.
- [x] T069 Запустити послідовно targeted tests і `nice -n 15 npm run verify` за `specs/035-launches/quickstart.md`; виправити доведені failures, звірити `verification-result.json`, актуалізувати generated types/contracts і документацію. Останній повний fast verify після router guard: 14/14 gates, 5539 PASS, 12 skipped; `verification-result.json` має `ok: true`. Власник уточнив beta-only цикл до наступних правок: `verify:release` відкладений до окремого рішення про реліз, production не чіпати. Beta runtime acceptance лишається в T068/T070.
- [ ] T070 Підготувати rollout/rollback і beta acceptance evidence у `specs/035-launches/quickstart.md` за `docs/BETA.md` та `docs/PRODUCTION.md`: additive migration order, shared/agent compatibility, exact-SHA packaged beta у доступному середовищі; unresolved tracker/Drive visibility рішення блокують production, не виконувати deploy/tag/release в межах tasks generation.

## Залежності та порядок виконання

```text
T001–T002 → T003 → tests T004–T006 → T007–T010 → T011–T016
                                                        ↓
                                                     US1/MVP
                                                        ↓
                              US2 integration ───────→ US3 catalog cases
                              ↑                         ↑
Foundation → US2 catalog hardening                     US3 other cases ← US1

US1 → US4; US1 → US5; усі US → фінальна прийомка
```

- Foundation виконується до story integration; T007–T009 паралельні тільки після T003–T006, T010 залежить від усіх трьох. DB schema→access→generation RPC→wrappers; telemetry contracts→CLI integration.
- US2 tests/hardening T030–T038 можуть іти після foundation поряд із US1; T039–T044 вимагають готового US1 і hardened catalog pipeline. На спільних `drive-ops/index.ts`, `api/team.ts` чи analytics файлах зміни виконуються послідовно.
- US3 other tests/overrides можна почати після US1; T049 та catalog cases T052 завершуються після US2. Не вважати весь US3 готовим лише за other.
- US4/US5 можна робити після US1 незалежно від живого каталогу, використовуючи persisted fixtures. Shared UI/API/i18n edits серіалізувати.
- Кожний story checkpoint включає свої tests, ACL та diagnostic evidence. Final gates не замінюють checkpoint tests.

## Приклади паралельної роботи

Це можливості розподілу майбутньої реалізації, не команда запускати агентів зараз.

| Область    | Незалежні задачі                             | Передумова                                                     |
| ---------- | -------------------------------------------- | -------------------------------------------------------------- |
| Foundation | T004 + T005 + T006; потім T007 + T008 + T009 | T003 і відповідні fail-first tests                             |
| US1        | T017 + T018; T022 + T023 + T024              | foundation; для components готові DTO/wrappers/draft interface |
| US2        | T030 + T031                                  | foundation й catalog contracts                                 |
| US3        | T045 + T046                                  | US1 і revision contracts                                       |
| US4        | T053 + T054                                  | US1 і workspace contracts                                      |
| US5        | T060 + T061                                  | US1 і copy/archive contracts                                   |
| Final      | T065 + T066                                  | усі stories, без спільних файлів                               |

## Простежуваність Acceptance Criteria

Кожний рядок охоплює реалізацію та її перевірки. Критерії залишаються визначеними у spec.md, ця таблиця їх не послаблює.

| AC        | Задачі                                                       |
| --------- | ------------------------------------------------------------ |
| 01        | T017, T020, T029                                             |
| 02–03     | T003, T018–T019, T022                                        |
| 04        | T011–T014, T022, T053–T059                                   |
| 05        | T017, T023                                                   |
| 06–09     | T005, T007, T009–T010, T021, T025                            |
| 10        | T004, T007, T024                                             |
| 11–14, 46 | T004, T008, T010, T065                                       |
| 15–16     | T005, T009–T010, T017–T019, T025                             |
| 17–18     | T030, T032–T035, T039–T040, T044, T046, T049                 |
| 19–20     | T006, T013, T018–T019, T030, T033–T035, T044                 |
| 21        | T017–T019, T026–T029, T031, T039, T042–T044                  |
| 22–24     | T045–T052                                                    |
| 25        | T053–T059                                                    |
| 26        | T017, T027, T029, T067                                       |
| 27        | T006, T011–T014, T018–T019, T048, T053–T064                  |
| 28        | T038, T044                                                   |
| 29        | T001, T039, T042, T044, T065, T070                           |
| 30        | T015–T016, T028–T029, T043, T052, T059, T064, T066           |
| 31        | T012, T015–T016, T065–T066                                   |
| 32        | T006, T013, T030–T031, T035–T037, T041–T044, T068            |
| 33–34     | T060–T064                                                    |
| 35        | T053–T056, T059                                              |
| 36–38     | T045–T052                                                    |
| 39–40     | T004, T007–T008, T017–T019, T022–T025                        |
| 41–43     | T006, T013, T018–T019, T026, T030–T031, T036–T037, T039–T044 |
| 44        | T060–T064                                                    |
| 45        | T017, T025, T054, T067                                       |

## Стратегія виконання та готовність

1. Foundation + US1 → внутрішній MVP «Інше». Перевірити повний create→preview→generate→copy→reopen і діагностику; catalog side effects відсутні.
2. Посилити catalog pipeline, завершити US2 з fault injection/cancel; це найбільший технічний ризик, не відкладати spike до фіналу.
3. US3 → explicit edits/history/manual values; US4 → defaults/filters/collaboration; US5 → copy/archive. Other частини можна завершувати до catalog integration, не оголошуючи повний реліз готовим.
4. Пройти final checks, звірити незакриті рішення в research, підготувати beta evidence. Окремий production workflow — поза цією командою.

Не створювати реалізацію чи міграції під час підготовки цього документа. Checkbox позначати лише після фактичного виконання задачі й відповідного доказу перевірки.

## Покриття уточнень після аналізу

| Знахідка                             | Уточнені задачі            | Критерії    |
| ------------------------------------ | -------------------------- | ----------- |
| G1: автономний recovery dispatch     | T011, T037, T068           | AC-21/32/43 |
| A1: source expectation після preview | T003, T011–T012, T018–T021 | AC-24       |
| A2: current timezone при copy        | T003, T060, T062–T063      | AC-33/34    |
| G2: RAM-only privacy                 | T021, T051, T065           | AC-31       |
| G3: manual mismatch hint             | T045, T050                 | AC-37       |
| A3: restore historical config        | T046, T051                 | AC-22/23/38 |

T037 включає SQL dispatch, endpoint wiring і worker; його перевірка не залежить від відкритого UI чи існування scheduled catalog jobs. Source expectation входить у foundation й US1, а не відкладається до US3. Детальні контракти — launch-api.md/generation.md/ui-and-url.md; додаткові перевірки — §20 spec і сценарії 13–18 quickstart.
