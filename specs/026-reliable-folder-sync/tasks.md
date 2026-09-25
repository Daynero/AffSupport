# Tasks: Надійна синхронізація та завантаження вкладених папок

**Feature**: `026-reliable-folder-sync` | **Source of current decisions**: [plan.md](plan.md)
**Revision**: analysis findings + local-only progress.
**Status**: Implementation in progress; completed tasks checked below. T002 resolved in constitution 3.0.1.

## Чинні обмеження

- Жодних server progress groups/items, percentage RPC/writes/publications чи progress polling. UI використовує вже потрібні operation responses.
- Звичайна синхронізація/файлові дії та доставка каталогу мають власні витрати. Cost тест перевіряє саме відсутність додаткового I/O від progress.
- T001 приводить старі supporting artifacts до рішення користувача перед implementation. Попередні вимоги про shared percentages/server group history не реалізовувати.
- T002 — точний governance gate перед US2 transport edits; жодного автоматичного переписування конституції.
- `[P]` позначає незалежні файли після передумов фази. Перетини shared contracts, ExplorerShell або SQL migrations виконуються послідовно.
- Нові міграції отримують вільний timestamp після останньої в репозиторії; `*_slug.sql` задає конкретний суфікс, а не дозвіл редагувати всі файли. Кожна завершується test + ROLLBACK.md + generated types до застосування.
- Tests спочатку відтворюють суттєву помилку; не вимагати штучного падіння вже справної поведінки.

## Phase 1 — Узгодження документів і меж

**Мета**: Зафіксувати нове рішення про local-only progress і перевірені точки інтеграції.

- [x] T001 Синхронізувати з Scope amendment у plan.md документи `specs/026-reliable-folder-sync/spec.md`, `research.md`, `data-model.md`, `contracts/transfer-contract.md`, `contracts/sync-contract.md`, `contracts/workspace-live-state.md` і `quickstart.md`: видалити server groups/progress/cursor-replay, замінити state:string на closed unions, описати local recovery й однакові acceptance criteria.
- [x] T002 Задокументувати scope SSE/чинного team Realtime у `specs/026-reliable-folder-sync/research.md` з посиланням на `.specify/memory/constitution.md`; до US2 transport edits отримати явне governance resolution окремим constitution workflow, якщо wording справді потребує зміни; не заявляти PASS і не будувати додатковий gateway.
- [x] T003 Зіставити runtime `supabase/functions/catalog-sync/index.ts` → `engine.ts`, чинні migration/RPC та реальні move entry points; записати backfill/rollout ownership у `specs/026-reliable-folder-sync/research.md`, не змінюючи helper worker.ts/state.ts як заміну активного коду.

## Phase 2 — Мінімальна sync foundation

**Мета**: Тільки інфраструктура синхронізації; upload і local progress не є залежностями.

- [x] T004 [P] Створити paginated/concurrent/invalid-metadata Drive fixtures у `tests/fixtures/catalog-sync.ts` та перевірки boundary parsers у `tests/team-sync-contracts.test.ts`.
- [x] T005 Додати closed sync status/job/coverage unions і shared bounds у `packages/shared/src/team/transport.ts` та exports у `packages/shared/src/team/index.ts`; build shared перед використанням Edge functions.
- [x] T006 Додати нову chronological `supabase/migrations/*_catalog_sync_ownership.sql`: canonical job, lease epoch, finite kinds, confirmed-cursor provenance, backfill і retire duplicates до uniqueness enforcement; ambiguous cursors запускають reconciliation, не порівнюються як числа/рядки. Додати pgTAP у `supabase/tests/database/catalog-sync-ownership.test.sql`, reverse steps у `supabase/migrations/ROLLBACK.md` і типи через npm run types:supabase.
- [X] T007 Додати chronological `supabase/migrations/*_catalog_scan_generations.sql`: private seen generations, durable frontier, conditional commit/reconcile RPC, completion status, baseline checks; RLS/revoke/narrow grants/empty search_path. Додати `supabase/tests/database/catalog-scan-generations.test.sql`, `supabase/migrations/ROLLBACK.md` і перегенерувати `apps/web/src/lib/database.types.ts`.
- [x] T008 Додати типізовані request/status/catalog-read wrappers у `apps/web/src/api/team.ts` та shared error mapping у `apps/web/src/team/errors.ts`; не додавати group progress або event replay endpoints.

## Phase 3 — US1: точкова синхронізація (P1, MVP)

**Мета**: Одна sync дія знаходить зовнішню папку, коректно звіряє зміни й завершується.

**Незалежна перевірка**: 20/20 повторів Лікарі/Будь-ласка побач її/картинка.png: правильне дерево без reload/full reindex; concurrent changes не губляться.

- [X] T009 [P] [US1] Додати regression tests finite completion, overlapping manual/discovery/ancestor requests, cursor independence, concurrent upload/move/delete та lost lease у `tests/catalog-sync.test.ts`.
- [X] T010 [P] [US1] Додати UI regressions accepted≠complete, error, navigation/reload sync-status recovery і failed catalog reread у `tests/team-folder-resync.test.tsx`.
- [x] T011 [US1] Розширити `supabase/functions/_shared/drive.ts` та `tests/drive-listing-integrity.test.ts`: повертати incompleteSearch, invalid-entry diagnostics, completeness; не перетворювати відкинуті parser-ом записи на підтверджену відсутність.
- [X] T012 [US1] Реалізувати finite subtree lifecycle, scan generation і seen-page checkpoints у `supabase/functions/catalog-sync/engine.ts`; після page-token rejection починати нове покоління, не змішуючи seen rows.
- [X] T013 [US1] Реалізувати lease/version-guarded reconciliation у `supabase/functions/catalog-sync/engine.ts` та RPC adapters у `index.ts`: missing candidates перевіряти за актуальним parent/trash, ambiguous access лишати unavailable, чекати canonical replay barrier; перевірити subtree visibility й незмінність material identity.
- [X] T014 [US1] Реалізувати ancestor overlap join або один follow-up, fencing і terminal cleanup у `supabase/functions/catalog-sync/index.ts` та новій `supabase/migrations/*_catalog_sync_scope_join.sql`; додати `supabase/tests/database/folder-resync.test.sql`, `ROLLBACK.md` і regenerate DB types.
- [X] T015 [US1] Підключити безпечний accepted/status результат до `apps/web/src/team/explorer/useFolderResync.ts`, оновлення `ExplorerProvider.tsx` після підтвердження; використовувати один існуючий status seam без окремого progress polling.
- [ ] T016 [US1] Записати результати MVP прогону й targeted tests у `specs/026-reliable-folder-sync/quickstart.md`; перевірити singleton/retry поведінку до першої beta демонстрації.

## Phase 4 — US2: актуальний простір для команди (P1)

**Мета**: Події invalidation + authoritative refresh видимих даних; без нового event replay журналу.

**Незалежна перевірка**: Два профілі бачать один каталог p95≤5 с/max≤15 с; reconnect, in-flight event і п’ята сторінка зберігають правильний стан.

- [X] T017 [P] [US2] Додати duplicate/out-of-order event, subscribe race, reconnect/visibility, event-during-read та membership-loss tests у `tests/team-realtime.test.tsx`; numeric event gaps не означають втрату.
- [X] T018 [P] [US2] Додати visible-window/scroll anchor/selection/search tests для кількох завантажених сторінок у `tests/team-explorer-live-refresh.test.tsx`.
- [X] T019 [P] [US2] Додати RLS тести catalog events і existing operation reads для viewer/removed/foreign-team у `supabase/tests/database/workspace-live-state.test.sql`.
- [X] T020 [US2] Після T002 узгодити дозволені subscriptions у `apps/web/src/team/useTeamRealtime.ts`, lifecycle/dirty refresh у `TeamContext.tsx`; reuse catalog/material operation events, без group progress channel, MAX(id) watermark і нового polling.
- [X] T021 [US2] Додати affected old/new parent invalidation у `supabase/functions/drive-ops/index.ts` та наявних catalog commit RPC через нову `supabase/migrations/*_catalog_invalidation_scope.sql`; документувати `supabase/migrations/ROLLBACK.md`, тести й типи.
- [X] T022 [US2] Реалізувати anchor-based visible-window refresh, dirty retry та generation guards у `apps/web/src/team/explorer/useFolderPage.ts`, `ExplorerProvider.tsx` і `apps/web/src/team/catalog/useCatalogSearch.ts`; не скидати все на першу сторінку.
- [ ] T023 [US2] Зв’язати stale/reconnecting/retry UI з реальним status у `apps/web/src/team/workspace/RealtimeChip.tsx`; записати two-account evidence у `specs/026-reliable-folder-sync/quickstart.md`.

## Phase 5 — US6: повнота initial scan і зовнішніх змін (P1)

**Мета**: Ті самі правила повноти для первинного, ручного та автоматичного обходу.

**Незалежна перевірка**: 50k файлів/10 100 папок/depth20, moved-in populated subtree, restart та permissions: повний доступний каталог або явна причина неповноти.

- [X] T024 [P] [US6] Додати initial scan, moved-in/restored subtree, wide frontier понад 10k, cursor loss і 50k correctness tests у `tests/catalog-sync-completeness.test.ts`.
- [X] T025 [P] [US6] Додати empty/partial/auth-revoked/rate-limited/delayed storage tests у `tests/team-storage-health.test.tsx`.
- [X] T026 [US6] Enqueue-ити discovered subtree через той самий scope-join механізм і відновлювати durable frontier без truncation у `supabase/functions/catalog-sync/engine.ts`; canonical cursor commit залишається окремою authority.
- [X] T027 [US6] Розширити health projection через нову `supabase/migrations/*_catalog_coverage_health.sql` і `supabase/functions/catalog-sync/index.ts`; додати `supabase/tests/database/catalog-coverage-health.test.sql`, reverse steps у `ROLLBACK.md` і DB types.
- [X] T028 [US6] Показувати coverage, last confirmed success і next action у `apps/web/src/team/storage/useStorageHealth.ts`, `StorageChip.tsx` та `drive/BetaStorageNotice.tsx`; не змінювати OAuth scope і не очищувати відомий каталог через access failure.

## Phase 6 — US7: обмежені ресурси й затримки (P2)

**Мета**: Закріпити cost/latency гарантії sync до розширення upload UX.

**Незалежна перевірка**: 10 ready spaces: p95≤60 с/max≤180 с і кожна≤180 с; 7 simulated days no-change; 100 changes/min; 1→100 members ≤10% зміни provider calls.

- [X] T029 [P] [US7] Додати scheduler tests із fake clock, 7 days no-change→new event, 100 changes/min та stall visibility у `tests/catalog-sync-scheduler.test.ts`.
- [X] T030 [P] [US7] Додати provider-call/catch-up counter harness для 1/100 клієнтів у `tests/team-realtime-scale.test.tsx`.
- [X] T031 [US7] Реалізувати bounded fair scheduling і successful-checkpoint failure reset у активних `supabase/functions/catalog-sync/engine.ts`, `index.ts` та новій `supabase/migrations/*_catalog_sync_fairness.sql`; додати pgTAP, `supabase/migrations/ROLLBACK.md`, DB types. Не переписувати ownership migration.
- [X] T032 [US7] Додати агреговані per-job queue/runtime/provider-call/result counters у `supabase/functions/catalog-sync/index.ts`; без file content, secrets або byte-progress events.
- [X] T033 [US7] Додати retention cleanup: seen generations після completion, orphan >24h без живого lease, terminal finite jobs 7d, batch≤500 у новій `supabase/migrations/*_catalog_sync_retention.sql`; додати `supabase/tests/database/catalog-sync-retention.test.sql` і `ROLLBACK.md`; не видаляти canonical cursor.
- [ ] T034 [US7] Записати measured SC-004/005/008/009 результати у `specs/026-reliable-folder-sync/quickstart.md`, окремо provider calls, catalog delivery й latency; mock harness не називати production benchmark.

## Phase 7 — US3: повний drag-and-drop дерева (P1)

**Мета**: Local manifest і один локальний координатор поверх чинних material operations.

**Незалежна перевірка**: Змішані roots, 1k files/100 dirs/10 empty dirs, unreadable branch та навігація: збережені структура й destination; partial не success.

- [X] T035 [P] [US3] Додати mixed roots, batch enumeration, empty/zero-byte, Unicode, cycles, limits і cancellation fixtures/tests у `tests/fixtures/local-manifest.ts` та `tests/local-manifest.test.ts`.
- [ ] T036 [P] [US3] Додати drag/drop, frozen destination, explicit conflicts і failed-parent tests у `tests/team-explorer-folder-upload.test.tsx`.
- [X] T037 [US3] Додати local-only operation/manifest closed unions і validators у `packages/shared/src/team/transport.ts`; server serializers не приймають File, handles або absolute paths.
- [X] T038 [US3] Реалізувати bounded file/directory manifest enumeration у `apps/web/src/team/explorer/localManifest.ts`, включно з усіма directory-reader batches, explicit empty directories та original-name preservation.
- [ ] T039 [US3] Створити `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx` і `useWorkspaceOperations.ts`, змонтувати над explorer у `apps/web/src/team/workspace/WorkspaceShell.tsx`; context override для тестів, topological folder creation, per-group concurrency3/global6, чинні material idempotency keys.
- [ ] T040 [US3] З’єднати drop entry point у `apps/web/src/team/explorer/ExplorerShell.tsx` і conflicts у `UploadConflictDialog.tsx` з одним координатором; destination фіксувати до enumeration, resolved parent mappings використовувати повторно.
- [ ] T041 [US3] Перевірити server authorization, directory creation/finalize idempotency і postcondition у `supabase/functions/drive-ops/handler.ts`, `index.ts` та `tests/drive-folder-intake.test.ts`; не додавати cloud group/items tables або progress RPC.

## Phase 8 — US4: одна кнопка файли/папки (P1)

**Мета**: Одна action із двома режимами та конкретним lossless directory fallback.

**Незалежна перевірка**: macOS/Windows: keyboard file(s)/folder choice і cancel; folder picker зберігає порожні каталоги так само, як drop.

- [ ] T042 [P] [US4] Додати chooser/drop parity, no-handle environment, empty-only tree і cancel tests у `tests/team-explorer-add-files.test.tsx`.
- [ ] T043 [US4] Описати directory-intake capability, relative manifest і opaque grant контракти у `packages/shared/src/team/transport.ts`; зареєструвати flag у `apps/agent/src/server/capabilities.ts` і typed wrappers у `apps/web/src/api/client.ts`.
- [ ] T044 [US4] Реалізувати fallback через чинний `apps/agent/src/files/picker.ts` та новий `apps/agent/src/files/directory-intake.ts`: capability-gated register routes у files module, picker-scoped read grant, bounded enumeration/authorized source read, no symlink escape і no cloud absolute paths; OS branching тільки через platform seam.
- [ ] T045 [US4] Додати native capability/auth/path-grant/cancel/platform tests у `tests/directory-intake.test.ts` і перевірити module health/shutdown registration у `apps/agent/src/files/directory-intake.ts`.
- [ ] T046 [US4] Замінити toolbar controls у `apps/web/src/team/explorer/ExplorerShell.tsx` на одну інвентарну action Файли/Папка; primary showDirectoryPicker, fallback scoped agent adapter у `localManifest.ts`; webkitdirectory не називати повним folder fallback.
- [ ] T047 [US4] Оновити тексти chooser/capability/unsupported у `apps/web/src/i18n.ts`; explicit unsupported до remote writes, а cancel не створює mutation.

## Phase 9 — US5: тільки локальний прогрес і відновлення (P1)

**Мета**: Чесний тост без серверного передавання відсотків; локальна група переживає навігацію.

**Незалежна перевірка**: Upload/move/sync, partial/retry/cancel/reload і дві вкладки; local progress on/off дає однакову кількість cloud requests/writes/subscriptions.

- [ ] T048 [P] [US5] Додати stages/zero-byte denominator/aria/throttling tests у `tests/toast-progress.test.tsx` та cost regression для відсутності progress network calls у `tests/team-progress-cost.test.tsx`.
- [ ] T049 [P] [US5] Додати local journal/reload, same-size changed source, lost finalize response, duplicate tab ownership, quota failure і account isolation tests у `tests/workspace-operation-journal.test.ts`.
- [ ] T050 [P] [US5] Додати progress parity tests усіх move входів — clipboard, tree drop, context menu — та server cycle/permission rejection у `tests/team-explorer-move-progress.test.tsx`.
- [ ] T051 [US5] Реалізувати account/team-scoped IndexedDB metadata journal у `apps/web/src/team/explorer/workspaceOperationJournal.ts`: checkpoints лише accepted/item-state transitions, no byte callbacks/credentials/handles, terminal7d/interrupted30d retention, sign-out purge і local ownership lease.
- [ ] T052 [US5] Підключити local journal, attempt-aware cancel/retry і reload reconciliation existing operation IDs у `WorkspaceOperationsProvider.tsx` та `useWorkspaceOperations.ts`; unfinalized uploads після reselection починати з byte0/new attempt, перед retry перевіряти lost-finalize outcome, succeeded items не дублювати.
- [ ] T053 [US5] Звести clipboard, moveTo/tree drop і context-menu дії в один coordinator через `apps/web/src/team/explorer/useExplorerClipboard.ts`, `ExplorerShell.tsx` та `apps/web/src/team/catalog/useMaterialActions.ts`; зберегти material tails і old/new parent invalidation.
- [ ] T054 [US5] Агрегувати confirmed offsets у `apps/web/src/team/explorer/useWorkspaceOperations.ts`, використовуючи чинний `apps/web/src/team/drive/resumableUpload.ts` callback; stage transition/new attempt явно змінює denominator, shared uploader не містить group state.
- [ ] T055 [US5] Розширити `apps/web/src/components/toast.tsx` інвентарним determinate/indeterminate Progress, preparing/detail labels і throttled aria; local provider проєктує ≤3 тости та local summary через `apps/web/src/team/workspace/BackgroundWorkChip.tsx`, включно з sync status без додаткових progress запитів.
- [ ] T056 [US5] Оновити local-only/reselection/session-only/partial/cancel тексти у `apps/web/src/i18n.ts`; catalog postcondition має пройти до success, dismissal не скасовує action.

## Phase 10 — Наскрізне приймання

**Мета**: Документація, реальні beta сценарії та proportionate verification.

- [ ] T057 [P] Оновити `docs/TEAM_WORKSPACE_OPERATIONS.md`: scope/coverage, локальний прогрес, відсутність shared percentage/history, recovery limits і native fallback.
- [ ] T058 [P] Перевірити redaction metadata/native grant/logs у `tests/log-redaction.test.ts`; жодних local paths, file content, tokens у cloud telemetry.
- [ ] T059 Пройти macOS/Windows picker/drop parity, keyboard/screen-reader і 20 local groups, two-account sync та network-cost сценарії; записати evidence у `specs/026-reliable-folder-sync/quickstart.md`, відсутнє середовище позначати неперевіреним.
- [ ] T060 Виконати npm run verify, relevant web/agent/shared builds і npm run verify:release для реалізації; читати канонічний `verification-result.json` та виправити feature failures.
- [ ] T061 Звірити повноту `specs/026-reliable-folder-sync/spec.md`, `plan.md`, `tasks.md` і supporting contracts після реалізації; packaged-beta evidence збирати за `docs/BETA.md` для конкретного commit, production release не включати у завершення фічі.

## Dependencies and delivery checkpoints

1. Setup T001–T003 → sync foundation T004–T008 → US1 T009–T016.
2. US2 T017–T023 залежить від foundation + T002; інтеграційне приймання використовує US1. **Перший корисний інкремент — US1 + US2**, без upload infrastructure.
3. US6 T024–T028 → US7 T029–T034: повнота й навантаження sync. Базовий singleton/backfill уже завершений у Foundation.
4. US3 T035–T041 → US4 T042–T047 і US5 T048–T056. US3 можна розробляти незалежно після Setup, його shared edits координуються з Foundation; US5 залежить від US3 local provider і використовує US1 sync status.
5. Final T057–T061 після всіх історій. Не називати повну фічу завершеною за одним MVP.

```text
Setup → Sync foundation → US1 → US2 → sync MVP
                         └→ US6 → US7
Setup → US3 → US4
            └→ US5 ← US1
Усі історії → final acceptance
```

## Parallel examples by story

| Story | Незалежна робота після передумов                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------- |
| US1   | engine regression tests і folder-resync UI tests                                                          |
| US2   | channel lifecycle tests, visible-window tests і database RLS tests                                        |
| US3   | local-manifest tests і drop integration tests; backend authorization після shared contract                |
| US4   | native adapter tests і browser chooser tests після capability contract; UI entry edits послідовно         |
| US5   | toast/cost tests, local-journal tests і all-entry move tests; provider integration після їхніх контрактів |
| US6   | completeness fixtures і storage health UI tests                                                           |
| US7   | fake-clock scheduler suite і client fan-out suite                                                         |

Shared code у `engine.ts`, `transport.ts`, `ExplorerShell.tsx`, `api/team.ts` не редагувати паралельно незалежними виконавцями. Перевірки великих builds запускати послідовно в межах локального resource budget.

## Analysis finding coverage

| Findings                      | Remediation                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| C1 typed state                | T001, shared closed unions у Foundation/local contracts                            |
| C2 reverse migration docs     | Кожна schema task містить ROLLBACK та database validation                          |
| C3 transport wording          | T002, явний gate; без прихованого PASS                                             |
| I1 inactive runtime paths     | T003, runtime implementation у engine.ts/index.ts                                  |
| U1 reconciliation races       | Adapter completeness, generations, fencing, candidate proof, replay barrier        |
| U2 event cursor ordering      | Вилучено replay cursor; authoritative visible snapshots + dirty refresh            |
| I2 empty-folder fallback      | Explicit native directory-intake capability, без lossless webkitdirectory обіцянки |
| I3 pagination state           | Anchor-based loaded-window refresh і regression tests                              |
| I4 dependency/migration order | Sync-only foundation; backfill до rollout; нові пізні міграції                     |
| U3 progress costs             | Тільки local aggregate/journal; zero-extra-cloud-I/O regression                    |
| U4 changed-file resume        | New attempt byte0, lost-finalize check, no path/size-based old session resume      |
| U5 overlapping scopes         | Reason-independent ancestor join або один follow-up                                |
| G1 move entry points          | Clipboard/tree/context єдиний coordinator плюс server checks                       |
| G2 measured load              | 7-day fake clock, 100 changes/min, fairness і 100 clients                          |
| U6 retention                  | Конкретні local/sync строки й bounded cleanup                                      |

## Verification policy

Документаційні зміни перевіряються форматуванням, IDs/dependencies і покриттям. Runtime gates, beta resets/builds, migrations та uploads виконуються лише на implementation/validation етапі. Наявну beta не скидати для підготовки документації.
