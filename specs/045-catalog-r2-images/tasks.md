# Tasks: R2-зображення каталогів

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contract](./contracts/catalog-images.md), [guide](./image-guide.md), [quickstart](./quickstart.md).

**Status**: feature implementation and authenticated source-beta import/Drive/reuse/create/update/Launch acceptance completed in the isolated worktree; latest full verifier passed 14/14 gates (8057 total tests, 45 explicit skips, 2440 seconds). Provider HTTP/CDN 30/30 and Chrome CORS/expiry 9/9 passed. Canonical disposable DB verification passed 41 SQL files/995 assertions, 2 real Auth tests and 31 native concurrency tests. Hosted, packaged/platform/old-client and importer gates remain open. The initial 56 tasks plus 3 acceptance-hardening tasks total 59: 53 checked and the original 6 mixed acceptance items unchecked. Migration1560 has 8 passing targeted regressions and was applied only to the owned local beta; its same-intent live revoke/purge passed with anonymous404 and the original pool preserved. Checkbox evidence is recorded in validation.md. Тести обов'язкові за acceptance/031, особливо для publication, isolation, recovery і діагностики. [P] — лише незалежні файли після prerequisites; heavy checks послідовні, nice 15, один worker.

## Phase 1: Setup

- [x] T001 Зафіксувати feature-only checkout, поточні чужі зміни, reserved migration slots і runtime/deployment input inventory у `specs/045-catalog-r2-images/validation.md`; не переносити чужий worktree diff, не запускати production provisioning. FR-001/016; Q22.
- [x] T002 Додати вузький public-catalog-images виняток у `docs/NO_SERVER_MEDIA_PLAN.md` та всі uk/en privacy/terms твердження у `apps/web/src/pages/legal-content.ts`; описати public intent, retention, revocation і межі source/uploader deletion до enable. FR-018/022; SC-005.
- [ ] T003 Закріпити exact Deno-compatible S3 client/presigner dependencies у новому `supabase/functions/catalog-images/deno.json` і function lock; описати environment-isolated staging/public buckets, custom domain, secrets, CORS, negative-cache/purge, response-header transform для nosniff та environment-scoped zone/CDN permissions і quotas у `docs/CATALOG_IMAGES.md`. Додати `[functions.catalog-images] verify_jwt=false` до `supabase/config.toml`, explicit handler user-JWT vs named-secret routes і local/hosted parity; реальний cron без JWT має пройти, anonymous/browser worker — відхилені. Prove SDK conditional PUT/presign у sandbox; credentials не комітити. FR-001/016/021; Q08/18/22.

## Phase 2: Foundation (blocks feature integration)

- [x] T004 [P] Написати boundary/768 vocabulary/unknown+ambiguous normal-mode тести у `tests/catalog-image-classification.test.ts` і contract guards у `tests/catalog-image-contract.test.ts`; прив'язати до `image-guide.md` без копіювання несумісних словників. FR-024/030; SC-010/014.
- [x] T005 Реалізувати канонічний vocabulary, discriminated image/import/classification contracts, limits і guards у `packages/shared/src/team/catalog-images.ts`, exports у `packages/shared/src/team/index.ts`/`packages/shared/src/index.ts`; TeamErrorCode additions у `packages/shared/src/team/transport.ts`; окремо analytics failure registry у `packages/shared/src/types.ts`, exhaustive `_shared/errors.ts`/`apps/web/src/team/errors.ts` mapping і guards/locales/code-map parity. Побудувати shared та пройти T004. FR-004/016/024/030; AD-003; SC-005/010.
- [x] T006 [P] Написати SQL isolation/idempotency/quota/lease/retention тести у `supabase/tests/database/catalog-r2-images.test.sql` і `tests/catalog-image-schema.test.ts`: anon/view-only/cross-tenant/service-only, stale fence, same key mismatch, retained source deletion. FR-003/004/012–014/016/022; Q07/09/12/16/18.
- [x] T007 Створити additive schema/RLS/narrow grants/import+entry+publication+pool+use+purge tables та versioned RPC у `supabase/migrations/20261206150000_catalog_r2_images.sql`; уникнути legacy FK cascade, atomic reservations і team rollout fields; regenerate `apps/web/src/lib/database.types.ts`. Пройти T006. FR-003–004/010/012–016/022; SC-003–005.
- [x] T008 Реалізувати DB claim/renew/fencing, named-secret cron dispatch, global/team concurrency, status derivation та stable journal у `supabase/migrations/20261206150000_catalog_r2_images.sql`, `supabase/functions/catalog-images/worker.ts` і `_shared/catalog-images.ts`; один file/invocation та nonblocking isolate-local heavy-work semaphore до claim/buffer; busy requeue без lease/необмеженої черги; 3 attempts включно з початковою (retry delays 1/5 min), bounded read-only unknown reconciliation до 8×15min, explicit unknown state. FR-005/013–014/021; AD-001–003.
- [x] T009 Реалізувати S3 adapter зі staging-only grant, bounded reads, create-only final PUT, positive hash readback і очищеними errors у `supabase/functions/_shared/r2-catalog-images.ts`; додати provider injection для tests, no credential/public-key leaks. FR-006/008/014/016; SC-001/003/005.

## Phase 3: US1 — Import, classify and publish (P1)

**Independent test**: Q01–04/07–11/16/18; обидва джерела без агента, named/unclassified success, недоступні/пошкоджені failure, готові результати переживають reload.

- [ ] T010 [P] [US1] Написати route/auth/manifest/continuation/local-without-Drive/idempotency тести у `tests/catalog-image-import.test.ts`; для Drive — root/permissions/source-version changes й partial enumeration; реальний gateway secret-only cron, anonymous worker denial, reload без job ID і два abandoned jobs/24h expiry. FR-002–003/010/023–024; SC-008/011/014.
- [x] T011 [P] [US1] Написати verification/publication adversarial тести у `tests/catalog-image-publication.test.ts`: staging overwrite, negative HEAD during unknown PUT, 412 adopt/conflict, public mismatch, commit failed, revoked epoch/stale lease, max bytes/dimensions/animation/orientation. FR-004–006/008/014/016–017; SC-001/003/005.
- [x] T012 [US1] Реалізувати `supabase/functions/catalog-images/index.ts`/`handler.ts`: typed routes contract, `authorizeCaller`, per-route manage_metadata, local no-OAuth path, control body/entry limits, idempotency/revision checks. FR-002–003/016/023; пройти T010 route cases.
- [x] T013 [US1] Реалізувати paged manifest/seal/grant/delivered і bounded staging reconciliation у `supabase/functions/catalog-images/handler.ts`; grant quotas/expiry, source hint не authority, paginated current-import discovery після reload без job ID, reselect та same-key retry; collecting/waiting-source expiry24h, exactly-once reservation release, staged/ready preservation і unknown quarantine. FR-005/010/014/021/023; SC-003/008/011; Q01/09/11/18.
- [x] T014 [US1] Реалізувати bounded Drive enumeration/download через чинні credential/live-ancestry/canDownload seams у `supabase/functions/catalog-images/worker.ts`; frozen version before/after read, overlap dedup, source cursor/continuation, без додаткового Drive upload/permission mutation. FR-002–003/010/021; Q02/16.
- [x] T015 [US1] Реалізувати bounded actual-byte container/MIME/dimensions/static/orientation/SHA validation у `supabase/functions/_shared/catalog-image-validation.ts`; один input buffer, жодного full decode/reencode/AI, явні межі доказу. FR-017/021; Q08/19.
- [x] T016 [US1] Реалізувати classify→team dedup→persist candidate→conditional publish→origin/public readback→atomic ready dictionary у `supabase/functions/catalog-images/worker.ts`; publish того самого verified buffer, no mutable re-copy, no ready before commit, generic normal success. FR-004–008/014/024–026; SC-001/003/010–011/014; пройти T011.
- [x] T017 [US1] Реалізувати scoped idempotent retry/cancel/status/lease recovery у `supabase/functions/catalog-images/handler.ts`/`worker.ts`; new attempt retains source identity, ready retained, unknown reconciled, lost actor authority fences commit. FR-005/010/014; Q09–11.
- [x] T018 [P] [US1] Написати import/drop/touch/keyboard/partial/reselect tests у `tests/catalog-image-import-ui.test.tsx` та API guard tests у `tests/catalog-image-api.test.ts`; unknown naming показується normal random mode, не upload error. FR-002/005/023–024; SC-008/011/014.
- [x] T019 [US1] Додати typed API wrappers/guards у `apps/web/src/api/team-catalog-images.ts`, делегування в `apps/web/src/api/team.ts`; не створювати другий global API client. FR-002/005/016/023; Q01/03/16.
- [x] T020 [US1] Реалізувати `apps/web/src/team/product-catalog/CatalogImageImport.tsx` і `useCatalogImageImport.ts`, підключити в `ProductCatalogSettingsSection.tsx`: два джерела, одна CTA, bounded queue/2 PUT, normal classification summary, справжні local progress counters. FR-002/005/023/027; SC-008/011/014; пройти T018.
- [x] T021 [US1] Зареєструвати safe status invalidation у `apps/web/src/team/useTeamRealtime.ts` та reread/reconnect/foreground/race handling у `useCatalogImageImport.ts`; snapshot/status pages ≤100, expired terminal/count окремо від provider failure, no recurring polling/duplicate channel, local files не persist. FR-005/021/025; Q11/20.
- [x] T022 [US1] Додати uk/en stage/result/normal-random/permission/reselection/quota/actionable text-pairing-conflict localization у `apps/web/src/locales/uk.ts` та `en.ts`; синхронізувати error UI зі stable codes. FR-005/023–024; AD-003; SC-005/014.

## Phase 4: US2 — Reuse and correct selection (P1)

**Independent test**: Q05–06; frozen ready dictionary fixture, no new upload; all matched/unclassified/mixed paths у create/refresh/grow і no-repeat concurrent rounds.

- [x] T023 [P] [US2] Написати SQL draw/concurrent-round/frozen-selection tests у `tests/catalog-image-selection.test.ts` і `supabase/tests/database/catalog-r2-images.test.sql`; усі ready active entries беруть участь, removed/revoked — ні. FR-007/009/025; SC-002/013–014.
- [x] T024 [P] [US2] Розширити create/refresh/grow/refreshTexts=false/sparse/random-only регресії у `tests/product-catalog-handler.test.ts`, `tests/catalog-updater-worker.test.ts` і `tests/product-details.test.ts`; не обмежуватись initial create: unknown custom title, conflicting multiple garment/color tokens, exact200/9999 та +1 length, усі чотири комбінації refresh flags, growth; unsafe rewrite дає IMAGE_TEXT_PAIRING_CONFLICT до external write й зберігає old catalog. FR-007/009/025; SC-002/004/013–014.
- [x] T025 [US2] Реалізувати `service_draw_product_catalog_images_v2`, v2 no-repeat history та issued-use reservations у `supabase/migrations/20261206150000_catalog_r2_images.sql`; зберегти v1 RPC result shape та per-team lock, пройти T023. FR-007/009/011–012/025; SC-002/003/013.
- [x] T026 [US2] Додати common URL/classification/pairing helper у `supabase/functions/_shared/product-catalog.ts` та `_shared/catalog-images.ts`; matched факти vs unclassified випадковість, deterministic token-only correction при refreshTexts=false за contract; unknown/ambiguous/overflow — IMAGE_TEXT_PAIRING_CONFLICT без catalog write, canonical factual fallback лише для create/growth/дозволеного text refresh. FR-007/009/025; SC-013–014.
- [x] T027 [US2] Інтегрувати v2 draw/readiness/sharing у `supabase/functions/drive-ops/index.ts` та `product-catalog.ts`; R2 не проходить `ensureAnyoneReader`, не підміняти driveFileId; reserve/finalize image use around catalog readback. FR-007/009/011/025; SC-002/004/013.
- [x] T028 [US2] Додати v2 frozen image checkpoint та legacy reader у `supabase/functions/drive-ops/catalog-durable.ts`; malformed/cross-team/revoked identities reject, unknown outcome retry не redraw. FR-008–011/014–015; SC-003/004; Q09/14.
- [x] T029 [US2] Інтегрувати v2 projection, refresh/grow та row facts/use receipts у `supabase/functions/catalog-updater/index.ts` і `worker.ts`; preserve previous working catalog on failure, пройти T024 у всіх прапорцях. FR-007/009/011/025; SC-002/004/013–014.
- [x] T030 [US2] Замінити незалежні garment/color sets на actual-pair inventory у `apps/web/src/team/product-catalog/apparelTexts.ts` і generator call у `ProductCatalogSettingsSection.tsx`; unclassified-only зберігає generic clothing generation. Розширити `tests/apparel-texts.test.ts`. FR-025/027; SC-013–014.
- [x] T031 [US2] Реалізувати dictionary/inventory keyset+revision APIs і authorized UI reads у `supabase/functions/catalog-images/handler.ts` та `apps/web/src/api/team-catalog-images.ts`; exact totals/hasMore, no legacy 500-name truncation. FR-019/021/025; Q20.

## Phase 5: US3 — Migration, compatibility and retention (P1)

**Independent test**: Q10–14/22 із legacy catalog fixture; failed migration не змінює чинні URL, source/uploader deletion не видаляє видані bytes.

- [x] T032 [P] [US3] Написати migration/version/legacy checkpoint/rollback tests у `tests/catalog-image-compatibility.test.ts`, including Launch generation reuse у `tests/launch-state.test.ts`; нові v1 requests на v2 team відхиляються before IO. FR-010–011/015; SC-003/004/008.
- [x] T033 [P] [US3] Написати delete owner/transfer/uploader/draft team/source/pool removal/unknown purge race tests у `tests/catalog-image-retention.test.ts` і `tests/delete-account-team.test.ts`; tombstone survives cascade; deterministic cleanup-first/adoption-first row-lock/fence races не видаляють adopted ready URL. FR-012–013/022; SC-004/005; Q12–13.
- [x] T034 [US3] Реалізувати owner-triggered current pool import і migration progress/partial/retry у `CatalogImageImport.tsx`/`supabase/functions/catalog-images/handler.ts`; no premature catalog rewrite/Drive sharing revoke, explicit unsupported legacy entries. FR-010–011/017; SC-004.
- [x] T035 [US3] Додати version negotiation/legacy mutation gate у `supabase/functions/drive-ops/product-catalog.ts`, `_shared/catalog-images.ts` і legacy settings RPC у новій міграції; Охопити всі producers: `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx`, `apps/web/src/api/team.ts`, server builder `supabase/functions/drive-ops/launch-catalog.ts`; fresh uses v2 після CAS team admission/ready pool, retry бере persisted version, не current flag. Старі in-flight завершуються за persisted legacy checkpoint. FR-011/015; Q14/22.
- [x] T036 [US3] Реалізувати pre-cascade durable purge tombstones та draft-team guard у `supabase/migrations/20261206150000_catalog_r2_images.sql`, uploader anonymization/revoke pending jobs у `supabase/functions/delete-account/handler.ts`; current owner transfer rule зберегти. FR-012–013/022; пройти T033.
- [x] T037 [US3] Реалізувати cleanup/revoke/reconcile worker у `supabase/functions/catalog-images/worker.ts` та `r2-catalog-images.ts`: expiry+grace, live-use proof, unknown late writes, staging lifecycle safety, origin deletion+own-CDN purge receipts. Спільний publication row-lock/CAS fence для cleanup/adopt/reuse/ready/use-reservation; orphan purging заборонений при lease/use/pending commit/unknown write. No automatic deletion of ready issued copies. FR-012–014/022; Q09/12–13.
- [x] T038 [US3] Додати pool removal/explicit revoke з чинним confirm-impact pattern у `CatalogImageImport.tsx` і API; removal не deletion, revoke показує pending/unknown, помилкове cache-erasure success заборонене. FR-012/022; SC-004/005.
- [x] T039 [US3] Документувати additive rollout/imports-off/selection-off та backward snapshot readers у `docs/PRODUCTION.md`, `docs/BETA.md`, `docs/CATALOG_IMAGES.md`; exact full beta/release requirement, no mini bypass. FR-015–016/018; Q22.

## Phase 6: US4 — Agent-readable diagnosis and costs (P1)

**Independent test**: Q17; synthetic success/failure/unknown/delayed evidence пояснюється через CLI без provider payloads чи dashboard, random-mode не дає false failure.

- [x] T040 [P] [US4] Написати producer→projection→CLI/privacy/missing evidence tests у `tests/catalog-image-diagnostics.test.ts`, також code-map/schema guards у `tests/analytics-code-map.test.ts` і `tests/analytics-schema-compat.test.ts`. FR-019; AD-001–009; SC-005–006.
- [x] T041 [US4] Створити safe analytics views/grants у `supabase/migrations/20261206151000_catalog_r2_diagnostics.sql`: read-only роль, joined stages/use receipts/purge states, retention/privacy, no raw names/URLs/hashes. FR-019; AD-004–006; SC-005–006.
- [x] T042 [US4] Додати typed unsampled critical signals і sanitized DB journal emission у `supabase/functions/catalog-images/worker.ts`, `_shared/catalog-images.ts` та UI import seam; correlation/recovery/delivery-lag, diagnostics failure не змінює product outcome. AD-001–003/005/007–009; SC-006.
- [x] T043 [US4] Додати bounded command/query module `scripts/analytics/catalog-images.ts`, command у `cli.ts`, schema/queries/types integration; `--period`, `--as-of`, cursor/limit, freshness/lag/unsupported/unknown та existing envelope. FR-019; AD-004/006; SC-006.
- [x] T044 [US4] Інтегрувати import/publication/use findings у `scripts/analytics/investigate.ts`, `catalog-updates.ts`, `coverage-registry.ts`, `code-map.ts`, `schema.ts`, `queries.ts`; capability ready лише за доказом end-to-end coverage, not event-only. AD-003–009; SC-006; пройти T040.
- [x] T045 [US4] Додати observed-vs-estimated storage/reuse/origin/cache coverage у `scripts/analytics/catalog-images.ts`; unsupported provider billing не нуль. Зберегти та відтворити сценарний `specs/045-catalog-r2-images/cost-model.py`/`cost-estimate.json` і уточнити staging/verification one-time overhead у `research.md`. FR-019–020; SC-007.
- [x] T046 [US4] Оновити `docs/ANALYTICS_CLI.md` прикладами import/user/catalog diagnosis, explicit blind spots (external generation, visual truth, Meta ingestion, billing/cache), retention і source freshness. FR-019; AD-004–006/008; SC-006.

## Phase 7: US5 — Human help and copy prompt (P1)

**Independent test**: Q15 і точний текст guide; click/keyboard copy або manual fallback, random behavior зрозумілий, external AI не викликається.

- [x] T047 [P] [US5] Написати copy/clipboard-failure/manual-fallback/keyboard/help wording tests у `tests/catalog-image-prompt.test.tsx`; додати prompt-vocabulary parity до `tests/catalog-image-classification.test.ts`. FR-027–030; SC-010/012/014.
- [x] T048 [US5] Винести повний versioned prompt і help content із `image-guide.md` у `apps/web/src/team/product-catalog/catalogImagePrompt.ts` та uk/en locales; не розширювати словник неузгодженими aliases, no private data in prompt. FR-027/029–030; SC-010/012.
- [x] T049 [US5] Інтегрувати коротку людську підказку і текстову «Скопіювати промпт» дію в `CatalogImageImport.tsx`: no expanded long block, accessible success/manual fallback; normal random images пояснені явно. FR-027–030; SC-012/014; пройти T047.
- [x] T050 [US5] Додати prompt intent/result/version signals до чинного typed analytics seam у `catalogImagePrompt.ts`/UI і code-map/registry; без clipboard/prompt text, no inferred external-generation failure; розширити `tests/catalog-image-diagnostics.test.ts`. AD-008–009; SC-005/012.

## Phase 8: Cross-cutting acceptance and release readiness

- [x] T051 Виконати single-worker targeted suites усіх story phases і isolated DB pgTAP, потім `npm run verify`; реальні commands/results записати в `specs/045-catalog-r2-images/validation.md`, failed gate виправляти адресно. FR-016/021; AD-007/009; SC-001–014.
- [ ] T052 Виміряти resource worst cases/Q19 та 25k dictionary/1000-drop Q20 у sandbox за `quickstart.md`; CPU≤1.5s/invocation, aggregate isolate memory≤192MB при concurrent 50MB requests та busy requeue, p95≤2s, concurrency/quotas/staging overage/retry limits. Зберегти evidence в `validation.md`; missing/failing measurement блокує product readiness. FR-021; SC-008/011.
- [ ] T053 Виконати реальні R2 browser CORS/presign/replay/conditional-write/public GET/own-CDN purge/late-write checks Q08–13/18, real response-header transform/nosniff та cron без user JWT, cleanup/adoption races і outside-browser credential abuse cases; sanitized evidence у `validation.md`, не запускати на production. FR-006/008/014/016–017/022; SC-001/003–005.
- [ ] T054 Пройти isolated beta keyboard/touch/light/dark/macOS/Windows/old-client та local-no-agent matrix Q01–22; `npm run verify:release`, exact-SHA packaged-beta за `docs/BETA.md`. Візуальний QA з token inventory, без production analytics. SC-001–014; AD-007/009.
- [ ] T055 Підтвердити anonymous readback усіх підтримуваних форматів і окремо реальний імпорт контрольного фіда цільовим зовнішнім імпортером; зафіксувати scope/обмеження/непідтверджені випадки в `validation.md`. Не видавати GET або mock за Meta acceptance. FR-017; AD-006; SC-009.
- [x] T056 Повторити cross-artifact readiness/coverage audit у `specs/045-catalog-r2-images/analysis.md`, синхронізувати docs/contract/tasks і final feature-only diff; позначити product ready/blocked/insufficient за реальними доказами. Production activation залишається окремою явною дією за канонічним runbook. FR-001–030; AD-001–009; SC-001–014.

## Acceptance hardening discovered in the real source beta

- [x] T057 Make all real local Functions boot with the shared declaration graph, and preserve verified loopback/project ownership across canonical reset. `supabase/functions/_shared/deno-type-dependencies.ts`, `auth.ts`, `errors.ts`, `scripts/beta-reset.mjs`, `scripts/lib/beta-reset-stack.mjs`, `scripts/lib/beta-loopback-network.mjs`, `tests/beta-reset-guard.test.ts`, `docs/BETA.md`. Evidence: all 16 boot probes, 44 safety/network regressions, actual 376-migration reset/seed, 7/7 gateway matrix and full verifier.
- [x] T058 Display each failed image's existing localized cause beside its filename; keep normal random ready images free of alerts. `CatalogImageImport.tsx`, `tests/catalog-image-import-ui.test.tsx`. Evidence: three added failed/partial/random regressions in the full verifier and actual after-fix Chrome rendering of content-invalid/classification-conflict.
- [x] T059 Repair actual PostgreSQL revoke alias binding and promote existing future/completed orphan purge rows for explicit revocation and team deletion, preserving authorization, replay, fences, uncertainty and holds. Additive `20261206156000_catalog_r2_revoke_purge.sql`, `tests/catalog-image-revoke.test.ts`, native `catalog-r2-images.test.sql`. Eight targeted regressions and the complete canonical native chain pass; the controlled incremental application to the owned local beta is complete. Canonical restart preserved connected profile identity. Reconciled same-intent revoke, exact memoized replay, actual cleanup journal and anonymous404 all passed; the original three-image pool retains exact bytes and URLs.

## Dependencies & execution order

- T001→T002/T003. Foundation: T004→T005; T006→T007→T008; T009 після T003+T005. Schema/SDK contracts узгоджуються до story work.
- US1 T010/T011 після foundation; T012→T013, T014/T015→T016→T017; T018→T019→T020→T021/T022. T016 залежить від T009/013/014/015. US1 complete тільки після відповідних tests.
- US2 T023/T024 можуть готуватися на fixtures після foundation; T025→T026→T027/T028/T029, T030/T031. Реальна інтеграція потребує ready publication US1; shared-file edits виконувати послідовно.
- US3 T032/T033 незалежні tests після foundation; T034 потребує US1, T035 потребує US2 checkpoint, T036→T037→T038; T039 після D1–D12 implementation alignment.
- US4 T040 можна створити на fixtures після foundation; T041→T042→T043→T044→T045/T046. Реальний coverage verdict після всіх producers/stories, не лише SQL fixture.
- US5 T047→T048→T049→T050 після T005; UI integration T049 після T020. Shared locales/registry edits узгоджувати з US1/US4 послідовно.
- Final T051→T052→T053→T054→T055→T056. Не починати heavy child паралельно з чужим packaging/verification; працюючі apps не зупиняти.

## Parallel examples per story

| Story | Незалежна робота після prerequisites                       | Послідовна інтеграція            |
| ----- | ---------------------------------------------------------- | -------------------------------- |
| US1   | T010 routes tests + T011 publication tests + T018 UI tests | T012–017 і T019–022              |
| US2   | T023 SQL selection + T024 handler/worker tests             | T025–031, common files serial    |
| US3   | T032 compatibility tests + T033 retention tests            | T034–039                         |
| US4   | T040 diagnostic fixtures поруч із US1 UI work              | T041–046 і shared registry edits |
| US5   | T047 prompt tests поруч із US1 worker work                 | T048–050 після UI seam           |

Це можливості паралельної розробки, не дозвіл запускати кілька heavy check processes.

## Requirement coverage

| Requirements   | Tasks                                       |
| -------------- | ------------------------------------------- |
| FR-001/018     | T001–003/T039                               |
| FR-002/023     | T010/T012–014/T018–022                      |
| FR-003/016     | T005–009/T010–012/T036/T041/T053            |
| FR-004/008/026 | T006–009/T011/T016/T023/T028                |
| FR-005         | T008/T010–022                               |
| FR-006/017     | T009/T011/T015–016/T053/T055                |
| FR-007/009/025 | T023–031                                    |
| FR-010/011     | T013–014/T017/T028/T032/T034–035            |
| FR-012/013/022 | T006–008/T033/T036–038                      |
| FR-014/015     | T008–009/T011/T017/T028/T032/T035/T037/T039 |
| FR-019/020     | T040–046                                    |
| FR-021         | T003/T008/T013–015/T021/T031/T052           |
| FR-024/030     | T004–005/T010/T016/T047–049                 |
| FR-027/028/029 | T047–050                                    |
| AD-001–009     | T008/T040–046/T050–056                      |
| SC-001–005     | T006/T011/T016/T023–029/T032–038/T051/T053  |
| SC-006–009     | T040–046/T051/T054–055                      |
| SC-010–014     | T004/T018/T023–024/T030/T047–050/T051/T054  |

## Implementation strategy

Initial backlog: 56 tasks; setup 3, foundation 6, US1 13, US2 9, US3 8, US4 7, US5 4, final 6. Acceptance hardening adds T057–T059, for 59 total. Функціональний preview — US1+US5 після foundation. Production MVP включає всі п'ять P1 stories, особливо retention/compatibility/diagnostics; upload-only demo не є готовим релізом. Власник явно авторизував реалізацію після документів і незалежного review. Checkboxes позначаються лише за фактичними доказами; production activation не входить до цієї авторизації.

## Implementation evidence notes

- Checked items within T001–T050 have code plus local unit/SQL/native/browser evidence; T003/T010 retain the explicit remaining evidence below. New files may implement a task under a more focused name (catalog-image-rows.ts, drive-sources.ts, catalog-image-adoption-postgres.test.ts). T007 uses the canonical generated database-types/compat seam. T036 uses database membership/account FK and pre-cascade triggers rather than duplicating account-deletion orchestration in the handler; native retention proof covers the real deletion path.
- T003 remains unchecked for actual hosted secret-only dispatch; pinned SDK, config, lock, docs, Deno checks and real R2 streaming conditional PUT are now verified.
- T010 remains unchecked for the explicitly required hosted gateway/cron proof. Local route/auth and actual Drive orchestration/SQL recovery tests pass; mocks do not attest gateway configuration.
- T011 local adversarial coverage includes actual worker with real adapter plus independently generated format fixtures; live provider cases remain T053.
- T023/T024/T028/T029/T032 now additionally validate retained outgoing row identities when image refresh is disabled, atomic complete/reconcile guards, malformed revision, inactive historical membership and text-only revoked-image refusal.
- T040–044 include pool_added/pool_removed authoritative history, typed remove/revoke result visibility, exact catalog:update image-code mappings and missing/old-schema behavior.
- T052 local50MB reference found/fixed an SDK copying defect; the hosted aggregate-isolate and scale measurements are still missing. T054 now includes authenticated source-beta Chrome import/reuse/Drive/create/update/Launch and actual OS-clipboard acceptance; packaged-beta/platform/old-client acceptance remains unverified.

- Earlier verification stopped on bundle budgets. The owner resolved the scope with an explicit bounded allocation; budget tests pass. T051 is complete: the latest full verifier passed14/14gates, 8012passed and45explicitly skipped tests (8057total) in2440seconds. The later1560 regressions passed8/8 separately, followed by the canonical DB chain with995assertions. See validation.md and bundle-budget-comparison.json.

- The urgent follow-up completed T035 with actual SQL Launch resource-freeze/planners, the reserved canonical child identity, R2-aware preflight and preexisting accepted-v1/no-child compatibility. Its six SQL cases and earlier focused56tests pass; actual source-beta Launch creation and Sheet readback also passed. T056 records the current verdict: local implementation, actual R2 provider proof and the stated authenticated source-beta journeys are verified; remaining hosted/resource/release/importer acceptance is unverified.

- Current status: 53/59tasks checked. The original six mixed acceptance items remain unchecked:T003,T010,T052,T053,T054,T055; T059 is complete after actual same-intent revoke/purge readback. On2026-10-27 the owner activated R2 and confirmed domain/token setup. Actual adapter/CDN30/30 and Chrome9/9 staging CORS/expiry probes passed with all probe objects cleaned; authenticated source-beta results are in validation.md. The earlier missing-profile/occupied036-port blocker is historical: the idle036stack was canonically stopped with volumes/state preserved, and owned045beta reset/seed and actual local gateway/cron passed. Hosted gateway/resource, late-write/provider-race, packaged/platform/old-client, elapsed schedule and actual importer evidence remain separate gates. Two fresh beta-delta reviews each scored98/100. No production release is authorized by these checkboxes.
