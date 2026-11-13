# Tasks: загальний пул білих зображень052

**Input**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts](./contracts/allocation.md), [quickstart.md](./quickstart.md).

**Tests**: прямо потрібні специфікацією для cleanup/concurrency/diagnostic acceptance. Спочатку змістовний failing regression, потім fix; центральний tests/, one worker. Назви файлів — первісні implementation targets; фактичні тести можуть розширювати чинні canonical suites, як зазначено в evidence notes нижче.

**Format**: `- [ ] Tnnn [P?] [USn?]`; залежності explicit, [P] лише після їх виконання та за різних файлів. Статуси оновлюються лише після реалізації та відповідних перевірок.

## Phase 1: Setup

Зафіксувати source/limits і створити ізольовані fixtures. Production не чіпати.

- [x] T001 Перевірити актуальний migration head, lockfile/runtime versions і всі045/047 producers; записати source SHA, planned file inventory та numeric budgets у `specs/052-shared-white-images/research.md`. Refs: FR-024 FR-029 FR-036. Deps: none.

- [x] T002 Створити synthetic seed/clock/ACL/provider fixtures у `tests/fixtures/catalog-global.ts`, включно2000ready images, legacy pool, protected global/video/restitch/original controls і stable catalog identities. Refs: FR-003 FR-030 FR-032 SC-015 SC-018. Deps: T001.

- [x] T003 Створити contract3/guards/bounds/unions у `packages/shared/src/team/catalog-global-images.ts`, exports у shared index та closed codes у `packages/shared/src/types.ts`/team transport; синхронізувати Edge/web error maps, locales і `scripts/analytics/code-map.ts`. Refs: FR-008 FR-012 FR-025 FR-031 AD-003 AD-006. Deps: T001.

## Phase 2: Foundational

Спільні security/data/identity seams; policy inactive. Незалежні story tests після checkpoint.

- [x] T004 Написати boundary/precision/code-map regressions у `tests/catalog-global-contract.test.ts` для contract3, decimal bigint, retired payloads, issued vs confirmed та privacy allowlist; отримати змістовний failing baseline. Refs: FR-008 FR-012 FR-025 FR-031 AD-003 AD-006. Deps: T002 T003.

- [x] T005 Додати inactive additive tables/constraints/indexes за data model у `supabase/migrations/20261208100000_catalog_global_pool.sql`: global ownership, pair/slot/recipe uniqueness, policy/manifest identities, journal/jobs і counters без cascading team ownership. Refs: FR-001 FR-003 FR-008 FR-009 FR-014 FR-025 FR-030 FR-032. Deps: T004.

- [x] T006 Реалізувати service-only RPC authorization/empty search_path/RLS/revoke-all та operator grants у `supabase/migrations/20261208100000_catalog_global_pool.sql`, typed service adapter у `supabase/functions/_shared/catalog-global-images.ts` і function registration у `supabase/config.toml`. Refs: FR-006 FR-008 FR-021 FR-031 AD-006. Deps: T005.

- [x] T007 Додати typed global lifecycle/epoch metadata, bounded sanitized journal emission та ingestion guards у `packages/shared/src/types.ts`, `apps/web/src/analytics/events.ts`, `supabase/functions/_shared/catalog-global-images.ts`; без URL/content telemetry. Refs: AD-001 AD-002 AD-003 AD-006 AD-007 AD-009. Deps: T003 T005 T006.

- [x] T008 Закласти durable catalog_identity до draw у `supabase/functions/drive-ops/catalog-durable.ts` та Launch resource-freeze RPC у `supabase/migrations/20261208100000_catalog_global_pool.sql`; registration/updater зв’язує ту саму identity без нового assignment. Refs: FR-009 FR-014 FR-025 FR-026 AD-001. Deps: T005 T006.

- [x] T009 Створити read-only Worker workspace/build skeleton у `apps/catalog-image-delivery/package.json`, `tsconfig.json`, `vite.config.ts`; включити його build/typecheck/test у `scripts/verify-all.mjs` без deploy побічних дій. Refs: FR-003 FR-026 FR-027 FR-036. Deps: T001 T003.

- [x] T010 Додати SQL role/constraint/ownership fixtures у `supabase/tests/database/catalog-global-security.test.sql` і isolated harness registration у `scripts/test-db-isolated.mjs`; перевірити no remote URL/row/password copy. Refs: FR-006 FR-008 FR-021 FR-024 FR-032 AD-006 SC-011. Deps: T005 T006 T008.

## Phase 3: US1 — автоматична global видача

Create/Launch/updater з global fixture без налаштувань. Independent test: new/existing spaces,100/200rows, немає private fallback.

- [x] T011 [US1] Написати failing Create/Launch/updater regressions у `tests/catalog-global-create.test.ts` та `tests/catalog-global-update.test.ts`: всі users/global, legacy false flag, complete rows і no private inventory. Refs: FR-001 FR-002 FR-022 SC-001 SC-009. Deps: T010.

- [x] T012 [US1] Реалізувати базовий batch allocate/freeze RPC у `supabase/migrations/20261208100000_catalog_global_pool.sql` за allocation contract: весь рецепт атомарно, ready metadata й stable pair/slot, no legacy fallback. Refs: FR-001 FR-003 FR-004 FR-005 FR-014 FR-025 FR-026. Deps: T011.

- [x] T013 [US1] Інтегрувати contract3 global image parse/URL/facts у `supabase/functions/_shared/catalog-image-draw.ts`, `catalog-image-rows.ts` та shared catalog types, з валідатором всього outgoing set. Refs: FR-003 FR-004 FR-022 FR-026 SC-002. Deps: T012 T003.

- [x] T014 [P] [US1] Увімкнути global recipe у standalone Create і durable replay через `supabase/functions/drive-ops/product-catalog.ts`/`catalog-durable.ts`, з trusted completion reference та незмінною identity. Refs: FR-001 FR-002 FR-014 FR-022 AD-001 AD-002. Deps: T013 T008.

- [x] T015 [P] [US1] Інтегрувати Launch planning/child registration і global readiness у `supabase/functions/drive-ops/launch-catalog.ts` та `apps/web/src/team/launches/preparation.ts`; frozen child не розподіляє картинки вдруге. Refs: FR-001 FR-002 FR-014 FR-022 SC-001 SC-009. Deps: T013 T008.

- [x] T016 [US1] Переробити всі refresh/growth/manual/scheduled/retry/non-video шляхи у `supabase/functions/catalog-updater/worker.ts`, `index.ts`, `claim-preparation.ts`: historical refreshImages більше не пропускає complete global selection. Refs: FR-002 FR-022 FR-023 SC-009. Deps: T013.

- [x] T017 [US1] Зберегти factual pairing при refreshTexts=false та явний conflict у `supabase/functions/_shared/catalog-image-rows.ts`/updater, перевірити sparse/ambiguous набір у `tests/catalog-global-update.test.ts` без fake facts/legacy fallback. Refs: FR-004 FR-005 FR-022 SC-002 SC-003. Deps: T016.

- [x] T018 [US1] Пройти full producer/replay parity у `tests/catalog-image-launch-resources.test.ts`, `tests/catalog-image-end-to-end.test.ts`, `tests/catalog-updater-parity.test.ts`; зафіксувати actual catalog outcome і no row-level network у fixtures. Refs: FR-003 FR-014 FR-022 FR-026 AD-002 AD-009 SC-001 SC-009. Deps: T014 T015 T016 T017.

## Phase 4: US2 — оператор і готові aliases

Independent test: operator import mixed valid/duplicate/bad batch, ordinary user refused, прямий Worker GET тих самих байтів.

- [x] T019 [US2] Написати failing operator/alias/delivery tests у `tests/catalog-global-operator.test.ts` та `tests/catalog-global-delivery.test.ts`, включно wrong env/token/method/foreign upstream і no private permissions. Refs: FR-003 FR-006 FR-007 FR-008 FR-026 FR-027 SC-003 SC-011. Deps: T010 T009.

- [x] T020 [US2] Реалізувати authenticated operator import/manifest/cancel/retry та named-secret background entry у `supabase/functions/catalog-global-images/{index,handler,worker}.ts` через045 byte/lease/bounds seams; T0 не активується імпортом. Refs: FR-003 FR-006 FR-007 FR-008 FR-024 AD-001 AD-002 AD-003. Deps: T019 T006.

- [x] T021 [P] [US2] Розширити `supabase/functions/_shared/r2-catalog-images.ts` trusted canonical g1 namespace/create-only/readback; global dedup не читає приватні hashes, no ordinary browser final write grant. Refs: FR-003 FR-007 FR-008 FR-026. Deps: T019.

- [x] T022 [P] [US2] Реалізувати pure alias token codec у `packages/shared/src/team/catalog-global-alias.ts` і read-only serving у `apps/catalog-image-delivery/src/index.ts`: HMAC/env/version validation, canonical nonrecursive fetch/stream, bounded GET/HEAD, cache/no URL logs. Refs: FR-003 FR-015 FR-026 FR-027 AD-006 SC-014. Deps: T019 T009.

- [x] T023 [US2] Реалізувати current+2 alias preparation/proof та serving-health jobs у `supabase/functions/catalog-global-images/worker.ts` і pool migration; matching asset/config/environment, bounded claims, no false ready. Review invariant: Reuse old closed-generation alias via immutable identity proof + fresh asset/config/key health; no per-alias daily GET. Refs: FR-003 FR-007 FR-024 FR-025 FR-027 FR-029 AD-002 AD-007. Deps: T020 T021 T022.

- [x] T024 [US2] Створити isolated-only provider checker `scripts/verify-catalog-global-provider.mjs`: direct bytes/MIME/nosniff, ready series, cache HIT/MISS/origin, no recursive route, browser/anonymous acceptance, refs у `specs/052-shared-white-images/validation/`. Refs: FR-003 FR-026 FR-027 FR-036 SC-014 AD-008. Deps: T023.

- [x] T025 [US2] Створити bounded authenticated operator tool `scripts/catalog-global-operator.mjs` та `docs/CATALOG_IMAGES.md` workflow: local/beta defaults, exact target confirmation, credentials не в args/artifacts; звичайний status тільки через read-only analytics. Refs: FR-006 FR-007 FR-008 FR-024 FR-036. Deps: T020 T024.

## Phase 5: US3 — точний підтверджений облік

Independent test: issued401 vs confirmed менше/рівно401,4999→5000→5001, exact replay і team deletion.

- [x] T026 [P] [US3] Написати failing once-only confirmation/replay tests у `tests/catalog-global-confirmation.test.ts`: duplicate rows/rounds, lost reply, cancel/unknown, no telemetry dependency. Refs: FR-008 FR-009 FR-010 FR-011 FR-012 FR-013 FR-014 SC-004 SC-005. Deps: T010 T012.

- [x] T027 [P] [US3] Написати реальні concurrent-connection сценарії у `tests/catalog-global-confirmation-postgres.test.ts` та ізольовані SQL fixtures: одна pair/slot, increments не губляться,5000 не блокує. Refs: FR-008 FR-009 FR-012 FR-014 SC-004 SC-005 SC-006. Deps: T010 T012.

- [x] T028 [US3] Реалізувати pair receipts/aggregate increments у completion RPC pool migration та canonical create/updater finish у `supabase/functions/drive-ops/catalog-durable.ts`/`catalog-updater/worker.ts`; one batch, trusted provider proof, bigint decimal output. Refs: FR-008 FR-009 FR-010 FR-012 FR-013 FR-014 SC-004 SC-005 SC-006. Deps: T026 T027 T018.

- [x] T029 [US3] Реалізувати unknown accounting reconciliation у `supabase/functions/_shared/catalog-global-images.ts` та background worker: позитивна звірка без нового каталогу/recipe/slot, bounded retries, explicit pending. Refs: FR-009 FR-014 FR-015 FR-016 AD-003 AD-007 SC-006 SC-008. Deps: T028.

- [x] T030 [US3] Зберегти знеособлений aggregate й pair tombstones при team/account delete у pool migration; tests у `tests/catalog-global-confirmation.test.ts` доводять no reset/no reattachment/no PII retention. Refs: FR-008 FR-009 FR-011 FR-016 FR-021 AD-006 SC-004 SC-011. Deps: T028 T029.

## Phase 6: US4 — read-only статус

Independent test: summary/list/image/cleanup з truthful scopes і producer→CLI coverage.

- [x] T031 [P] [US4] Написати failing status/pagination/as-of/privacy tests у `tests/catalog-global-diagnostics.test.ts`: issued/confirmed separate,0/4999/5000/5001, current vs historical_unknown, cursor revision. Review invariant: Test read-only tuple fingerprint, deterministic sort/cursorTTL60s, changes between pages and at most one restart then explicit partial. Refs: FR-017 FR-018 FR-019 FR-020 FR-021 FR-035 SC-007 SC-008 SC-011. Deps: T010.

- [x] T032 [US4] Додати narrowly granted analytics projections у pool/cutover migrations та allowlisted schema detection у `scripts/analytics/schema.ts`; SELECT-only grants без broad private tables/service credentials. Refs: FR-017 FR-018 FR-019 FR-020 FR-021 FR-035 AD-006 SC-011. Deps: T031 T005.

- [x] T033 [US4] Реалізувати `scripts/analytics/global-images.ts` і routing/types у `scripts/analytics/{cli,types,queries}.ts`: summary/image/list/cleanup, bigint decimal, filters/cursor_stale, fixed read snapshot і unchanged envelope. Review invariant: Use status-visible tuple SHA256 revision computed read-only; no global writable revision row, max(seq) assumption or snapshot-store writes. Refs: FR-017 FR-018 FR-019 FR-020 FR-035 SC-007 SC-008. Deps: T032.

- [x] T034 [US4] Інтегрувати global diagnosis у `scripts/analytics/{catalog-images,investigate,coverage-registry,code-map}.ts`: stage ownership, retired boundaries старих settings/prompt capabilities, evidence/fact/hypothesis/insufficient. Refs: AD-001 AD-002 AD-003 AD-004 AD-005 AD-007 AD-008 AD-011. Deps: T033 T007.

- [x] T035 [US4] Підключити server/client producers і privacy-safe receipts до lifecycle для import/allocation/update/cutover/cleanup у global Edge та `apps/web/src/team/catalog-updater/analytics.ts`; no diagnostics failure affects product counters. Refs: AD-001 AD-002 AD-003 AD-006 AD-007 AD-009 AD-010 AD-011. Deps: T034 T028.

- [x] T036 [US4] Перевірити end-to-end sanitizer→stored projection→inspect/investigate/audit у `tests/catalog-global-diagnostics.test.ts`, `tests/analytics-code-map.test.ts` і coverage tests на success/failure/cancel/interruption/missing/lag; fixtures outputs зберегти у validation. Refs: AD-004 AD-005 AD-006 AD-007 AD-008 AD-009 AD-010 AD-011 SC-010 SC-011. Deps: T035.

## Phase 7: US5 — одночасний обов’язковий перехід

Independent test: T0 UI/API/server fence, всі updates global, old-client reload, не зламати restitch/ціни.

- [x] T037 [US5] Написати failing UI/old-payload regressions у `tests/catalog-global-cutover.test.ts` і `tests/product-catalog-settings-section.test.tsx`, з private-ready dependencies, mixed payload і untouched restitch controls. Refs: FR-002 FR-022 FR-023 FR-030 FR-031 SC-009 SC-016. Deps: T010.

- [x] T038 [P] [US5] Прибрати private image subtree/summary dependence у `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx` і workspace settings; Launch/Create readiness тільки global. Залишити text/price/schedule/video/restitch. Refs: FR-002 FR-022 FR-023 FR-031 SC-001 SC-016. Deps: T037 T015.

- [x] T039 [P] [US5] Прибрати refreshImages/source controls із `apps/web/src/team/catalog-updater/{CatalogDefaultsEditor,CatalogProfileEditor,CatalogBulkEditor,CatalogIconControls,CatalogBulkUndo}.tsx`, `useCatalogInlineChanges.ts` і `profilePatchMatches.ts`, залишити історичні facts без керування. Refs: FR-002 FR-022 FR-023 FR-031 SC-016. Deps: T037 T016.

- [x] T040 [US5] Оновити `apps/web/src/api/{team,team-catalog-images}.ts`, shared updater/settings contracts і locales: contract3 не надсилає obsolete fields, unrelated text/price saves працюють; не видаляти переклади restitch за prefix. Refs: FR-002 FR-021 FR-022 FR-031 SC-016. Deps: T038 T039 T003.

- [x] T041 [US5] Додати epoch/retired RPC fences та mixed-payload atomic refusal у `supabase/migrations/20261208100100_catalog_global_cutover.sql`, `catalog-images/handler.ts` і global readiness; закрити old reads/import grants/pool revoke для звичайних callers. Refs: FR-002 FR-022 FR-030 FR-031 FR-032 SC-016. Deps: T040 T006.

- [x] T042 [US5] Реалізувати prepare→drain/reconcile→activate CAS, immutable T0/deadline/manifest digest та legacy admission fence у cutover migration й `scripts/lib/release/catalog-global-cutover.mjs`; old unknown blocks activation, не post-T0 allocation. Review invariant: Fence and positively reconcile already claimed purge/DELETE/CDN-purge I/O before final manifest/T0; deletion unknown blocks activation. Refs: FR-030 FR-031 FR-032 FR-036 AD-011 SC-017. Deps: T041 T023 T028.

- [x] T043 [US5] Охопити late writes/grants і unstarted/unknown checkpoints у `drive-ops/{catalog-durable,launch-catalog,index}.ts`, `catalog-updater/{worker,index,claim-preparation}.ts` та global worker: no old output afterT0, exact resume або pre-write replan. Refs: FR-014 FR-022 FR-030 FR-031 FR-032 AD-011 SC-009 SC-017. Deps: T042 T018.

- [x] T044 [US5] Додати source/config/Worker/route/probe evidence до trusted full-release preparation й read-only check у `scripts/lib/release/catalog-global-cutover.mjs`, release runner integration та `docs/PRODUCTION.md`; next deploy не активуєT0, no manual wrangler/mini bypass. Review invariant: Require policy-aware archived prior rollback build; if absent prepare separately validated compatibility-baseline release before T0, never execute production here. Refs: FR-027 FR-030 FR-036 SC-010 SC-017. Deps: T024 T042.

- [x] T045 [US5] Підключити stale-client reload/upgrade barrier до чинної app capability/session revalidation у `apps/web/src/api/team-catalog-images.ts` і workspace entry; old/offline UI перевіряє policy до роботи, без нового recurring polling. Refs: FR-023 FR-030 FR-031 SC-016. Deps: T041 T038 T039.

- [x] T046 [US5] Пройти T0 matrix у `tests/catalog-global-cutover.test.ts`, `tests/launch-catalog-preparation.test.ts`, updater/browser fixtures: all producers, false flags, old mixed API, failed migration, late callbacks, unaffected features. Refs: FR-022 FR-023 FR-030 FR-031 FR-032 FR-036 AD-011 SC-009 SC-016 SC-017. Deps: T043 T044 T045.

## Phase 8: US6 — ротація й швидкість

Independent test:401issued, чужий unknown не блокує,100/200batch deadlines і справжній benchmark.

- [x] T047 [US6] Написати failing slot/latency/foreign-unknown tests у `tests/catalog-global-allocation.test.ts` і `tests/catalog-global-allocation-postgres.test.ts`:199/200/201,401, duplicate intent/pair і busy/not-ready candidates. Review invariant: Test old pair after24h/rotation/config change, required rare bucket outside first sample and concurrent same-pair exact issued delta. Refs: FR-012 FR-014 FR-025 FR-028 FR-029 SC-013 SC-015. Deps: T010 T012.

- [x] T048 [US6] Оптимізувати allocator у `supabase/migrations/20261208100000_catalog_global_pool.sql`: bounded random candidate sample, UUID-ordered SKIP LOCKED, lock50ms/statement750ms/caller1s, all-or-nothing400rows, no global advisory/no inline waiting. Review invariant: Use indexed garment/color bucket random cyclic lookup; bounded exhaustion is unavailable, not proven pairing conflict. Refs: FR-004 FR-005 FR-024 FR-028 FR-029 SC-012 SC-015. Deps: T047 T012.

- [x] T049 [US6] Завершити monotonic issued_seq/series logic та immutable exact replay у `supabase/migrations/20261208100000_catalog_global_pool.sql` і `supabase/functions/_shared/catalog-global-images.ts`: slot не повертається післяdurable failure, confirmed окремо; one request/recipe atomic across rows. Review invariant: Recheck existing pair AFTER image lock and BEFORE issued_seq increment; no second burned slot for the same pair. Refs: FR-008 FR-009 FR-014 FR-025 FR-026 FR-028 SC-004 SC-013. Deps: T048 T028.

- [x] T050 [US6] Перевірити й налаштувати background ready-ahead/probe scheduler у `supabase/functions/catalog-global-images/worker.ts` і cron migration:current+2, actual feasible probe interval/freshness, revision changes, no preparation in create. Review invariant: Asset content proof24h, immutable alias identity proof, serving-health120s/probe<=60s using existing supported cron seam. Refs: FR-003 FR-024 FR-027 FR-029 AD-007 SC-012 SC-015. Deps: T049 T023.

- [x] T051 [US6] Додати batch network-count/byte-work assertions і fast unavailable/unknown wrappers у `tests/catalog-creation-performance.test.ts`, `tests/catalog-global-allocation.test.ts` та global adapter; no per-row GET/RPC, no hidden recipe substitution післяtimeout. Refs: FR-003 FR-005 FR-014 FR-028 FR-029 AD-010 SC-012 SC-015. Deps: T050.

- [x] T052 [US6] Створити reproducible `scripts/benchmark-catalog-global.mjs` на owned disposable PostgreSQL schema-only seam; rows100/200,samples≥100,concurrency1/10,2000ready seeds, outputs p50/p95/p99/calls/source digest без credentials; lock/deadline/config budgets і unmeasured scopes записати поряд зі звітом. Refs: FR-024 FR-028 FR-029 SC-015 AD-010. Deps: T051 T010.

- [x] T053 [US6] Виконати disposable DB benchmark послідовно nice15; authenticated hosted Edge/e2e cohort залишається release acceptance T067; зафіксувати source/config-bound звіт у `specs/052-shared-white-images/validation/benchmark.json`, cold/rotation/busy/exhausted/unknown окремо; виправити невиконані targets, не знижувати мовчки. Refs: FR-024 FR-027 FR-028 FR-029 SC-012 SC-014 SC-015. Deps: T052.

- [x] T054 [US6] Закрити timeout/restart/foreign-unknown regression та розбіжності receipts у `tests/catalog-global-allocation-postgres.test.ts` і global adapter; p95 цілі відділити від граничної1sвідмови й зовнішнього provider часу. Refs: FR-005 FR-014 FR-015 FR-028 FR-029 AD-010 SC-006 SC-013 SC-015. Deps: T053 T029.

## Phase 9: US7 —30-day retirement cleanup

Independent test: clockT0/day29/day30, manifests survive deletion, scoped verified purge й truthful CLI.

- [x] T055 [US7] Написати failing retention/cleanup tests у `tests/catalog-global-retirement.test.ts` і `supabase/tests/database/catalog-global-retirement.test.sql`:deadline,hold,team cascade,protected controls,unknown DELETE/purge й quota once. Review invariant: Include Drive-only/no-R2 metadata targets, pre-T0 claimed deletion late reply, owner transfer during grace, zero-object complete predicate. Refs: FR-030 FR-032 FR-033 FR-034 FR-035 SC-017 SC-018. Deps: T010 T042.

- [x] T056 [US7] Додати `supabase/migrations/20261208100200_catalog_global_retirement.sql`: policy_retirement eligibility/manifest ownership,immutable delete_after,tombstones без team cascade; не masquerade під orphan і не DROP schema. Review invariant: Typed object_purge/metadata_unlink; complete only after all kinds terminal and no ownership/receipt unknown. Refs: FR-009 FR-030 FR-032 FR-033 FR-034 FR-036 SC-017 SC-018. Deps: T055 T042.

- [x] T057 [US7] Оновити before-team-delete/legacy revoke/orphan fences у retirement migration й `catalog-images/handler.ts`: retained hold30days має пріоритет, no new late grants/commits, зберігається attribution й manifest. Refs: FR-030 FR-031 FR-032 FR-034 SC-017. Deps: T056 T043.

- [x] T058 [US7] Розширити `supabase/functions/catalog-images/worker.ts` і trusted purge adapter для reason policy_retirement:claim/fence→origin delete/readback→CDN purge→finish; import disabled не блокує cleanup,8attempts/15min,quota credit once after verified. Review invariant: Credit current authoritative charged-ledger owner after transfer via stable ledger identity; manifest original owner audit-only. Refs: FR-024 FR-032 FR-033 FR-034 AD-011 SC-018. Deps: T057 T021.

- [x] T059 [US7] Реалізувати post-verified old image settings/source/pool unlink у `supabase/migrations/20261208100200_catalog_global_retirement.sql`: зберегти texts/prices й sanitized tombstone, originals/permissions/global/video/restitch untouched; oldrefs не продовжують retention. Review invariant: Metadata-only refs unlink at deadline without provider DELETE/receipt; external_untouched terminal independent of physical deletion. Refs: FR-002 FR-032 FR-033 FR-034 FR-036 SC-018. Deps: T058.

- [x] T060 [US7] Підключити cleanup stages/overdue/backlog/external_untouched до `scripts/analytics/global-images.ts`, projections і journal producer у cleanup worker; end-to-end tests у `tests/catalog-global-diagnostics.test.ts`. Review invariant: External-only counts derive from metadata manifest entries; cleanup_complete rejects any blocked/unknown child. Refs: FR-019 FR-020 FR-035 AD-004 AD-005 AD-007 AD-011 SC-008 SC-018. Deps: T059 T036.

- [x] T061 [US7] Розширити `scripts/verify-catalog-global-provider.mjs` scoped beta retirement fixtures:beforedeadline GET,afterdeadline DELETE/readback/purge,unknown reply/restart і unchanged protected objects; не customer IDs і не production backdating. Refs: FR-032 FR-033 FR-034 FR-036 SC-014 SC-017 SC-018. Deps: T060 T024.

- [x] T062 [US7] Перевірити exact clock/paused catalog/30-day hold і owner status у `tests/catalog-global-retirement.test.ts`, `tests/catalog-image-retention.test.ts`, `tests/catalog-image-revoke.test.ts` та real isolated PostgreSQL concurrency scenario. Review invariant: Cover owner transfer+team delete+duplicate finish and Drive-only space metadata_unlinked with original permissions unchanged. Refs: FR-030 FR-032 FR-033 FR-034 FR-035 SC-017 SC-018. Deps: T061.

- [x] T063 [US7] Додати rollback/deadline/schema-compatibility regressions у `tests/catalog-global-cutover.test.ts` і canonical release tests: old1.3.0 acceptance не розширюється, no schema DROP, no restored private writes/timer reset/claim deleted-byte recovery. Refs: FR-030 FR-031 FR-036 SC-016 SC-017 SC-018. Deps: T062 T044.

## Phase 10: Polish and acceptance

Повний cutover потребує всіх stories; проходження документації не замінює release evidence.

- [x] T064 Оновити `docs/CATALOG_IMAGES.md`, `docs/ANALYTICS_CLI.md`, design inventory/privacy documentation та `AGENTS.md` CLI table під global-only/retired30days; sync CLAUDE pointer лише якщо змінюється його роль, не дублювати guide. Refs: FR-002 FR-017 FR-022 FR-031 FR-034 FR-035. Deps: T063 T036.

- [ ] T065 Побудувати shared, відформатувати touched files, зареєструвати нові modules у `coverage-critical.json` без зниження floors, пройти single-worker touched regressions і `nice -n 15 npm run verify`; виправити gate failures, зберегти single `verification-result.json` та sanitized feature evidence. Refs: FR-024 FR-036 AD-009 SC-010 SC-011. Deps: T064 T054.

- [ ] T066 Пройти disposable DB/concurrency та `nice -n 15 npm run verify:release`, включно new Worker build/typecheck й package compatibility, безparallelheavychildren; не зупиняти чужі app/verification. Refs: FR-024 FR-027 FR-036 SC-010 SC-012 SC-013 SC-015 SC-017 SC-018. Deps: T065.

- [ ] T067 Перед окремо запланованим релізом пройти real authenticated beta hosted/installed macOS/Windows матрицю, authenticated Edge/e2e overhead cohort, canonical origin/cache fanout і scoped real-provider retirement та control Meta import за `specs/052-shared-white-images/quickstart.md`; зберегти exact-source/config/platform evidence, unsupported/missing results явно block readiness. Refs: FR-023 FR-027 FR-030 FR-036 AD-008 AD-009 AD-011 SC-010 SC-014 SC-016 SC-017 SC-018. Deps: T066.

- [ ] T068 Включити measured performance/provider/cutover/diagnostic acceptance verdict у `scripts/verify-all.mjs` і normal release proof collector; документувати critical gaps у `specs/052-shared-white-images/validation/acceptance.md`, не relabel local tests як user success. Refs: FR-024 FR-027 FR-029 FR-036 AD-005 AD-009 AD-010 AD-011 SC-010 SC-012 SC-014 SC-015. Deps: T053 T066. External readiness remains conditional on T067.

- [ ] T069 Повторно звірити spec/plan/contracts/tasks і runtime coverage, закрити всіcritical/high findings у `specs/052-shared-white-images/analysis.md`; завершити implementation без production activation, release лише за окремим validated intent. Refs: FR-001 FR-036 AD-005 AD-009 SC-010. Deps: T068. T067 remains an explicit future activation prerequisite, not permission to publish from this branch.

## Dependencies and execution order

SetupT001–003 → FoundationT004–010 → independent isolated story slices. US1T011–018 uses synthetic ready pool; production depends also on US2T019–025. US3T026–030 adds proven accounting; US4T031–036 observes it. US5T037–046 prepares but never activates incomplete cutover. US6T047–054 completes nonblocking performance. US7T055–063 completes bounded retention/purge. T064–069 require allstories. Explicit task dependencies win over prose phase order; no later prerequisite/cycle is allowed.

Conceptual graph: Foundation → {US1,US2,US3-tests,US4-tests,US5-tests}; US1+US2+US3 → US4/US5 integration; US1+US2+US3 → US6; US5+US4+US2 → US7; all → full acceptance. Немає production MVP лише зUS1: settings removal, global coverage,30day cleanup іdiagnostics обов’язкові разом.

## Parallel opportunities per story

- US1: T014 standalone durable path іT015 Launch path післяT013/T008 мають різні основні файли; shared-contract edits уже завершені.
- US2: T021 R2 adapter іT022 delivery Worker післяT019 можуть виконуватися незалежно; T023 очікує обидві.
- US3: T026 unit confirmation tests іT027 real PostgreSQL tests післяT012 — різні файли; T028 починається після обох.
- US4: status parser fixtures уT031 можна готувати паралельно з CLI-independent event coverage fixtures, але T032–036 змінюють спільні projections/registry й виконуються послідовно.
- US5: T038 workspace images іT039 updater controls післяT037, до спільного API/locales taskT040; restitch regression виконується перед видаленням shared keys.
- US6: batch benchmark scenarios можна авторувати поряд із allocation unit tests; SQL/adapter optimization іartifact-producing heavy commands послідовні, never parallel heavy children.
- US7: controlled-clock fixture сценарії й isolated provider fixture manifest можна готувати незалежно; purge/schema changes іactualprovider probes за явним порядкомT055–063.

## Implementation strategy

Спочатку inactive foundation й fixture-only US1/US2, далі exact counters, reporting, UI/server fences і fast allocator, потім retirement. Кожна історія має власний independent test, однак T0 відсутній до повного acceptance. Засвідчена підготовка в beta/next не є дозволом на production promotion/activation. Після релізу потрібні read-only global status/audit/investigate підтвердження effect, не автоматичні повідомлення або cleanup вручну.

## Implementation evidence notes (2026-11-12)

- Source work stays in `feature/052-shared-white-images`, worktree `/Users/daynero/RiderProjects/AffSupport-052`, base `a7e30bca`. The owner excludes this feature from the nearest release; no merge, push, production activation or cleanup is part of this implementation.
- T008/T014/T015/T018: shared v3 SQL identity/freeze/bind + durable/Launch seams; existing `launch-catalog`, Launch resource/parity and updater suites are extended rather than duplicating generators. `catalog-global-end-to-end.test.ts` runs real handler→SQL→worker→HMAC delivery→200-row recipe→once-only confirmation with only provider transport replaced.
- T011/T017/T046: complete100/200-row false-flag and partial-set regressions live in `catalog-updater-worker.test.ts`; facts/guards in `catalog-global-create.test.ts`; UI in `catalog-global-settings.test.tsx`; T0/API settings in `catalog-global-cutover.test.ts`.
- T029/T035/T036: canonical registration/success reconciliation triggers own receipts; same-intent replay never allocates anew after unknown delivery. Server journal feeds narrow projections, inspect, owned investigation and audit. Actual anonymous/Meta delivery remains unobservable without independent evidence and is never inferred from allocation.
- T024/T061 are implemented tools, not completed real-provider acceptance: bounded read-only delivery and retirement-before/after probes leave origin DELETE/CDN-purge/quota/browser/platform receipts explicitly unverified. SQL/native and controlled transport tests cover positive/unknown/duplicate outcomes. T067 remains unchecked until a future explicitly planned release provides real isolated evidence.
- T048/T052/T053: full100-sample cohorts,2000ready images, concurrency1/10 passed with no allocation failures. `validation/benchmark.json` binds pool SQL digest; policy fixture is beta/fixture/epoch1,2000ready unclassified images,current+2 aliases,24h asset proof/fresh120s health. Declared budgets: lock50ms,bounded loop750ms,caller1s,max400rows. DB timings exclude transport; lock wait distributions and complete catalog overhead are unmeasured.
- T044/T063: optional full-release preflight validates bound acceptance and compatible current/rollback archives; operator HTTP cannot mint the service-only permit. Read-only source collector/recorder seam and infrastructure runbook exist; this branch does not provision or publish a Worker. Missing infrastructure/platform proof blocks T0.
- Final source implements all seven stories. T065/T066/T068/T069 remain pending final acceptance/sign-off because the canonical suite reproduces an inherited bundle gate failure on a clean exact-base checkout; no budget is raised. Passing final groups: static15/15, build5/5, e2e8/8, environment2/2; focused170passed with2explicit DB prerequisites separately covered in native DB. Supplemental coverage84.09% passes unchanged floors but is not a green final canonical suite. See validation/acceptance.md and bundle-comparison.json. External T067 remains future work, consistent with the owner's release exclusion.
