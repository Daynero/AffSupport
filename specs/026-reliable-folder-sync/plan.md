# Implementation Plan: Надійна синхронізація та завантаження вкладених папок

**Feature**: `026-reliable-folder-sync` | **Git branch**: `main` (не перемикається цим редагуванням)
**Spec**: [spec.md](spec.md) | **Tasks**: [tasks.md](tasks.md)
**Revision**: findings remediation + рішення користувача про локальний прогрес.

## Scope amendment — чинне рішення користувача

Прогрес показується лише локально в тості ініціатора, використовуючи вже наявні upload callbacks і результати move/sync. Заборонено додавати RPC, database writes, Realtime publication, polling або telemetry events для передавання відсотків. Звичайні файлові операції, синхронізація каталогу й доставка готових змін команді продовжують споживати ресурси; фіча не обіцяє безкоштовний backend.

Не створюємо `team_workspace_operations`, `team_workspace_operation_items`, `ReportItemProgress`, серверну історію груп або окремий журнал catch-up events. Зберігаємо чинні `team_operations` для повноважень, ідемпотентності й результатів файлових дій. Учасники бачать готові матеріали через спільний каталог, але не чужі відсотки.

Це уточнення замінює частини FR-027–034 / US5 про спільний чи відновлюваний серверний прогрес. Локальне зведення доступне ініціатору; після reload показується останній локальний checkpoint та перевірені результати наявних material operations. Без локального запису історія групи не обіцяється. Перед кодом T001 синхронізує `spec.md`, `research.md`, `data-model.md`, `contracts/` і `quickstart.md`: їх попередні server-progress і event-cursor рішення є superseded, їх не реалізовувати.

## Summary and delivery order

1. US1 + US2: точкова синхронізація та автоматичне оновлення всіх учасників.
2. US6 + US7: завершення initial/change-feed повноти й перевірки черги, затримок та вартості.
3. US3 + US4 + US5: повна локальна папка через drop або одну дію «Додати файли», чесний локальний прогрес.

Upload infrastructure не блокує sync MVP. Singleton, безпечний backfill і базові retry/fairness гарантії входять у sync foundation; їх не відкладаємо до пізньої фази.

## Technical Context

- TypeScript strict, React, наявні Supabase Edge Functions/Postgres/каталог і Google Drive adapter.
- Shared contracts: `packages/shared/src/team/transport.ts`; дозволи: чинний `contract.ts`. Усі state поля — literal unions із boundary validators, без `state: string`.
- Активний backend шлях: `catalog-sync/index.ts` → `engine.ts`. `state.ts` містить transcript helpers, `worker.ts` не є основним scheduler. Не реалізовувати виправлення лише в допоміжному шляху.
- Один workspace-level React provider володіє локальними операціями; він стоїть над Explorer і переживає навігацію між вкладками простору.
- Postgres зберігає каталог, існуючі material operations і sync checkpoints; IndexedDB зберігає тільки локальні metadata/checkpoints ініціатора. File bytes, handles, credentials і signed URLs у журнал не записуються.
- Підтримка macOS/Windows; browser directory handles та наявний native picker/agent boundary.
- Перевірки: Vitest у `tests/`, чинні pgTAP suites у `supabase/tests/database/`, beta із двома профілями. SQL tests запускаються штатним database gate.
- Масштаб: 50 000 файлів / 10 100 папок / depth 20; local upload — 1 000 файлів / 100 папок / depth 10, включно з порожніми.

## Constitution Check

| Principle               | Рішення                                                                                                                                            | Gate                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| I. Contracts            | Валідовані closed unions; shared domain bounds; frontend progress aggregate лишається local state.                                                 | PASS by design                    |
| II. Release             | Agent fallback capability змінюється через shared protocol seam; production identity не змінюється.                                                | PASS by design                    |
| III. Least privilege    | Private staging, RLS, revoke then narrow grants, definer RPC із empty search_path; журнал ізоляційний за account/team.                             | PASS by design                    |
| IV. Resources           | Bounded enumeration/transfers; native filesystem тільки за picker grant, platform-specific код у чинному platform/picker seam.                     | PASS by design                    |
| V. API                  | Existing async operation results, stable error codes; жодного progress endpoint.                                                                   | PASS by design                    |
| VI. State/transport     | Constitution 3.0.1: local-agent SSE, hosted-team Supabase Realtime; один власник subscribe/reconnect, без нового recurring polling.                 | PASS by design; T002 resolved     |
| Migrations/verification | Кожна міграція має reverse steps у `supabase/migrations/ROLLBACK.md`, generated types і database test до застосування.                             | PASS by design                    |

T002 завершено окремим constitution workflow після відповіді користувача на явний запит. Scope agent SSE / hosted-team Realtime зафіксовано в конституції 3.0.1. Це узгодження implementation, не твердження про merge/ratification чи перевірку runtime US2. Додатковий gateway не потрібен.

## A. Sync ownership and reconciliation

- Одна canonical incremental job володіє connection cursor; manual/discovered subtree jobs кінцеві й мають власний request status.
- Єдина lease/fencing authority для записів каталогу на connection: provider I/O може виконуватися поза транзакцією, але commit перевіряє чинний lease epoch і версію запису. Старий worker не змінює новіші дані.
- Курсори Google є непрозорими токенами. Backfill використовує підтверджений connection checkpoint та його provenance, не порівнює значення токенів чи лише час оновлення job. За неоднозначності запускає bounded reconciliation зі збереженням відомого каталогу.
- Canonical uniqueness/backfill та retirement idle/leased duplicates завершуються до увімкнення нових job kinds. Застосовані міграції не дописуються наступними історіями.
- Manual/discovered запити тієї самої області приєднуються до одного сканування незалежно від reason. Якщо активний ancestor scan ще гарантовано покриє запитану гілку, запит приєднується до нього; якщо гілку вже пройдено до запиту — рівно один follow-up. Lease не відбирається для об’єднання.
- Seen staging має scan generation, folder і provider ID. Після rejected page token нове покоління починає listing заново; старі seen rows не беруть участі у звірянні.
- Drive adapter повертає `incompleteSearch`, discarded/invalid-entry diagnostics і pagination status. Пропущений malformed item не дозволяє вважати список повним.
- Кінець pagination створює тільки кандидатів на missing. Потрібні complete coverage, чинний lease, scan baseline та відсутність новішої catalog mutation. Для кандидатів перевіряється актуальний provider parent/trash стан; ambiguous 403/404 означає unavailable, а не доведене видалення.
- Зміни, що надійшли під час listing, застосовуються через canonical change replay; finite scan завершується лише після reconciliation barrier. Перевірка версій не дозволяє старій сторінці повернути файл у попереднього батька. Повторна перевірка потрібна кандидатам/конфліктам, не кожному незміненому файлу.
- Зникнення папки враховує її відомих нащадків у списках і пошуку; subtree visibility не лишає доступними orphan rows. Переміщення/restore зберігає material identity.
- Folder frontier зберігається durable порціями; queue bound означає перенесення решти на наступний checkpoint, ніколи не обрізання після 10 000.
- Retry count рахує consecutive failures, successful checkpoint скидає його. Manual p95 ≤60 с, max ≤180 с; кожна ready connection обслуговується ≤180 с у контрольному навантаженні.

## B. Shared catalog refresh

Повторно використовуємо дозволені `team_catalog_events` та існуючі operation completion events через чинний team subscription seam (після T002). Нового серверного event replay/cursor API не додаємо.

- Подія є invalidation із scope; move invalidates old і new parent. Повторні події безпечні, debounce об’єднує affected reads.
- На initial subscribe/reconnect/visibility читаємо авторитетний snapshot видимого вікна, дерева, поточного пошуку й storage health.
- Подія під час in-flight read встановлює dirty flag і викликає bounded повторний read після завершення. Generation guard відкидає відповіді старого team/route.
- Не порівнюємо event IDs на суміжність і не трактуємо MAX(id) як commit watermark. Це прибирає потребу в окремій впорядкованій історії подій.
- Оновлюємо завантажене вікно навколо stable material anchor, не лише першу сторінку. Зберігаємо sort/filter/route та selection доступних IDs; видалений anchor замінюється найближчим живим.
- Відмова каналу або catch-up робить stale/reconnecting видимим. Немає постійного polling. Manual sync лишається доступним і перевіряє результат одним authoritative refresh після completion.
- Чинні membership checks та RLS перевіряються також при reconnect/retry. Втрата доступу прибирає cached дані й локальний журнал цього простору.

## C. Local manifest and universal chooser

- Manifest містить explicit directory/file entries, кілька roots, empty dirs, original names, normalized comparison keys, relative paths та issues.
- Enumeration читає всі batches directory reader, має cancellation і count/depth/size bounds. Нульові файли та лише порожні каталоги є валідним набором.
- Directory picker використовує `showDirectoryPicker` у підтримуваному desktop Chromium. Звичайний file input підходить тільки для файлів; `webkitdirectory` не є lossless folder fallback.
- Якщо directory handle недоступний, та сама дія «Додати файли → Папка» використовує native picker агента: scoped opaque grant + directory enumeration включно з порожніми + existing authorized local source read. Локальні абсолютні шляхи не йдуть у Supabase.
- Fallback реалізується й тестується як конкретний capability контракт. Без підтримуваного browser/agent показуємо actionable unsupported стан до початку роботи; таке середовище не називається платформою з повною folder support.
- Destination фіксується до асинхронного enumeration. Каталоги створюються зверху вниз один раз; concurrency передач — 3, спільний local cap на provider instance — 6.
- Conflicts вирішуються явно per parent: skip/keep both/explicit replace. Failed-parent skips відрізняються від свідомих user skips.

## D. Local operations and progress

Один `WorkspaceOperationsProvider` зберігає локальну групу й використовує чинні material operations для кожної реальної мутації. Clipboard, drag-to-folder, context menu та upload входять через одного координатора. Cycle/permission/ancestry checks виконуються також сервером.

- Preparing: локальний indeterminate toast з кількістю знайденого; він з’являється до enumeration, cancel chooser його прибирає без помилки.
- Upload: відсоток підтверджених байтів із чинних callbacks; deduplicate offset per attempt. Move: підтверджені terminal units, failures окремо; single move indeterminate.
- 100% stage не означає success: після finalize перевіряємо catalog postcondition через вже потрібне оновлення каталогу.
- Відсотки лише в пам’яті UI. IndexedDB записується на accepted manifest і підтверджену item/state transition, не на кожний byte callback.
- Локальний журнал містить actor/team, destination, relative metadata, operation/idempotency IDs, outcomes і attempt, але не file bytes/handles/tokens. Read після reload звіряє відомі operation IDs пакетно через існуючу API можливість; не запускає повторних мутацій до перевірки.
- Після reload незавершені uploads потребують повторного вибору. Не продовжуємо стару byte session за збігом path/size: незавершений файл починається з byte 0 у новій attempt після явного підтвердження набору; спочатку перевіряємо, чи попередня attempt уже finalized. Підтверджені файли/каталоги повторно не створюються.
- Retry зберігає succeeded results, reset denominator/new attempt явно позначається. Skip/error/cancel не дають фальшивого повного успіху.
- Cancel зупиняє scheduling і abort активні transfers; підтверджені мутації не відкочуються.
- Дві вкладки не виконують одну local group одночасно: IndexedDB ownership lease + local tab coordination, без серверного heartbeat.
- Local history: terminal metadata — 7 днів, interrupted — 30 днів, quota failure показується як session-only recovery. Sign-out видаляє локальну історію поточного account. Чужі акаунти її не читають.
- Тост використовує інвентарний Progress і обмежені aria announcements. Одночасно видно до 3 тостів; інші local groups доступні у зведенні.
- Cost regression: перемикання local progress on/off для однакового набору не змінює cloud request/write/subscription counts. Звичайні file operations і catalog refresh обліковуються окремо.

## Source ownership

| Scope            | Paths                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared types     | `packages/shared/src/team/transport.ts`, `contract.ts`, `index.ts`                                                                                 |
| Sync runtime     | `supabase/functions/catalog-sync/engine.ts`, `index.ts`, `supabase/functions/_shared/drive.ts`                                                     |
| Schema           | Нові chronological migrations у `supabase/migrations/`, reverse steps у `ROLLBACK.md`                                                              |
| Catalog UI       | `apps/web/src/team/TeamContext.tsx`, `useTeamRealtime.ts`, `explorer/useFolderPage.ts`, `ExplorerProvider.tsx`, `catalog/useCatalogSearch.ts`      |
| Local operations | Нові `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx`, `workspaceOperationJournal.ts`, `localManifest.ts`, `useWorkspaceOperations.ts` |
| Mutations        | Чинні `supabase/functions/drive-ops/index.ts`, `handler.ts`, `apps/web/src/team/materials/tail.ts`                                                 |
| Native fallback  | `apps/agent/src/files/picker.ts`, новий `files/directory-intake.ts`, `server/capabilities.ts`, `apps/web/src/api/client.ts`                        |
| Tests            | `tests/` і чинна pgTAP directory `supabase/tests/database/`                                                                                        |

## Rollout, retention and verification

- Кожна schema task включає migration + test + ROLLBACK documentation + `npm run types:supabase`. Номер нової міграції обирається після останньої на момент виконання.
- Engine підтримує legacy/new job shapes до ввімкнення request RPC; draining/fencing не дає старому worker перезаписати canonical cursor.
- Seen rows видаляються після reconciled folder; failed/canceled generations — terminal cleanup; orphan watchdog після 24 годин без живого lease. Terminal finite jobs — 7 днів із batch cleanup ≤500 rows. Canonical job/cursor не видаляються.
- Не змінюємо retention існуючих catalog events/material operations як побічний ефект local progress.
- Sync MVP приймається за 20/20 папок «Лікарі» та двома профілями: p95 5 с/max 15 с для оновлення екранів.
- Engine tests: concurrent upload/move/delete під час listing; invalid metadata; incompleteSearch; lease loss; rejected page token; overlapping scopes; 50k files/10.1k folders.
- Scheduler tests: 10 ready spaces, p95/max/service bound; 7 simulated days no-change, потім нова зміна; 100 external changes/min з p95 2 хв/max 5 хв та видимим delayed станом.
- Platform tests: однакова структура picker/drop, 1k files/100 dirs/10 empty dirs, keyboard, native fallback, Unicode, symlinks, zero-byte.
- Progress tests: жодного додаткового cloud I/O, partial/cancel/retry, zero-byte denominator, reload, same-size changed file, lost finalize response та multi-tab ownership.
- `npm run verify` обов’язковий для реалізації; relevant builds і `npm run verify:release` дають повну перевірку. Beta package/verify — за `docs/BETA.md` для конкретного commit, production promotion окремо за авторизацією.
