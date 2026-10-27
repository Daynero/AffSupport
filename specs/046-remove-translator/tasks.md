# Tasks: Повне видалення перекладача

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/retirement.md](contracts/retirement.md),
[quickstart.md](quickstart.md), [scope-audit.md](scope-audit.md).

**Tests**: обов’язкові поведінкові регресії за spec AD-008 і SC-001–SC-009.
Відмітки нижче відображають реалізацію та наявні докази; release acceptance
ведеться окремо в T048–T051 і `reviews/acceptance.md`. Фактичне розміщення
регресій і відхилення від запланованих filenames описані в implementation notes.
Один heavy child за раз, nice15, single worker. Production дії не авторизовані.

## Phase 1 — Setup

- [x] T001 Перевірити поточний source baseline/dirty tree, останні RPC definitions і вільні filenames `supabase/migrations/20261207090000_retire_translation.sql`, `supabase/migrations/20261207091000_translation_retirement_diagnostics.sql`; за колізії узгоджено перенумерувати всі посилання; записати baseline і known bundle-budget failure в `specs/046-remove-translator/reviews/acceptance.md`, актуалізувати `scope-audit.md` (FR-025, SC-001).
- [x] T002 Підготувати sanitized old-state/document/library/process/grant fixtures у `tests/support/translation-retirement.ts` та `tests/fixtures/translation-retirement-upgrade.sql`: ready/partial/corrupt, усі старі стани, original-only/translation-only, старий grant і дві API версії; seed старих DB rows до feature migration, не обходити нові guards; не містити production content/credentials (FR-012–FR-018, AD-007).

## Phase 2 — Foundational seams

**Checkpoint**: спільні helper алгоритми й типові межі готові без видалення джерельної поведінки.

- [x] T003 Додати regression для unchanged lexical splitting у `tests/whisper-chunks.test.ts`, `tests/transcription-words.test.ts`, перенести потрібні helpers з `apps/agent/src/translation/segmentation.ts` у `apps/agent/src/transcription/segmentation.ts` і змінити імпорти Whisper/document store без зміни тексту/таймінгів (FR-002, FR-023).
- [x] T004 [P] Закріпити source-only range/pointer/scroll поведінку в `tests/transcription-selection-dom.test.ts`, `tests/transcription-viewer-hooks.test.tsx`; винести helpers у `apps/web/src/transcription/text-ranges.ts`, `useTranscriptSelection.ts`, `useTranscriptScroll.ts` і відв’язати `selection-dom.ts` від bilingual alignment зі збереженням оригіналу (FR-003, FR-023).
- [x] T005 Розділити active й historical contracts у `packages/shared/src/types.ts`, `lifecycle.ts`, `team/library-processing.ts`, `team/creative-library.ts`, `team/transport.ts`: original-only DTO/active kinds, inert legacy literals/errors, FEATURE_RETIRED; оновити exports, `supabase/functions/_shared/errors.ts` (409/nonretryable) і additive DB error catalog у `20261207090000_retire_translation.sql`, не переписувати applied seeds; rebuild shared і адаптувати `tests/creative-library-contract.test.ts`, `tests/agent-error-codes.test.ts` (FR-014, FR-016, FR-022, AD-003, AD-005).
- [x] T006 Додати reciprocal API regression у `tests/connection.test.ts`, `tests/release.test.ts`, `tests/auth-routing-security.test.ts`; змінити тільки protocol/tool revisions у `packages/shared/src/release.ts` на API6/min6/max6/transcription6, перевірити `apps/web/src/connection.ts`, `api/client.ts` не надсилають tool requests для API5↔6; не змінювати product version/manifest (FR-018, SC-005, SC-007).

T003 і T004 допускають паралельні правки лише після T002; T005 після них,
T006 після T005. Buildable integration усіх споживачів завершується story phases,
проміжні commits не є deployable product.

## Phase 3 — US1: original-only транскрибатор (P1)

**Independent Test**: clean/upgrade audio+video → original view/copy/TXT/SRT/VTT,
Hindi/Urdu без pivot, source selection/playback, no model download/spawn.

- [x] T007 [US1] Написати failing original-only regressions у `tests/transcription-retirement.test.ts`, `tests/transcription-document.test.ts`, `tests/transcription-store.test.ts`: old fields не виходять у DTO, немає autostart/download, core corruption refused; інвертувати corrupt-translation rejection у `tests/transcription-reliability.test.ts` та running-translation restart у `tests/transcription-quality.test.ts` (FR-001–FR-007, FR-014, SC-002, SC-004).
- [x] T008 [US1] У `apps/agent/src/queue/transcription-store.ts` і `transcription/document-store.ts` нормалізувати settings/job/document explicit whitelist, відкинути translation summary/payload/source та historical PIVOT_UNAVAILABLE незалежно від пошкодження; зберегти core validation, atomic save і valid originals без disk sweep (FR-012–FR-014, SC-004, SC-009).
- [x] T009 [US1] Прибрати translator/aligner bootstrap з `apps/agent/src/index.ts`, translation coordination/download/cache/pump/busy/holds з `queue/transcription-queue.ts`, видалити `queue/translation-coordinator.ts` і translation-only `apps/agent/src/translation/` після T003; зберегти Whisper/media-preview/probe cleanup, readiness і cancel/shutdown (FR-001, FR-005, FR-006, FR-013, FR-022, FR-024, SC-002, SC-009).
- [x] T010 [US1] Прибрати pivot option/pass/-tr/englishText/Words/progress/result і buildTranslationSourceSegments з `apps/agent/src/whisper/transcriber.ts`, `queue/transcription-queue.ts`, `transcription/document-store.ts`; адаптувати `tests/transcription-language-probe.test.ts`, `tests/transcription-quality.test.ts`, `tests/transcription-reliability.test.ts` для повного source progress і підтримки Hindi/Urdu (FR-002, FR-007, FR-023, SC-002).
- [x] T011 [US1] У `apps/agent/src/transcription/routes.ts` залишити lightweight authenticated FEATURE_RETIRED tombstones замість execution routes; live retired/mixed settings patch відхиляти атомарно; видалити retired wrappers у `apps/web/src/api/client.ts`, додати нейтральне відображення FEATURE_RETIRED у `apps/web/src/transcription/errors.ts`, `apps/web/src/team/errors.ts` без назви фічі, зберегти оригінальні endpoints і додати route tests у `tests/transcription-retirement.test.ts` (FR-004–FR-006, FR-016–FR-018, AD-003, SC-005).
- [x] T012 [US1] Спростити `apps/web/src/transcription/TranscriptionPage.tsx`, `TranscriptionRow.tsx`, `TranscriptionSettingsPanel.tsx`, `ModelGate.tsx` до speech/original-only; видалити GemmaConsent/TranslatorNotice/TranslationElapsed, target-language sync і всі auto/row/bulk install/translate/cancel paths; оновити `tests/transcription-page.test.tsx`, `tests/transcription-row-language.test.tsx` (FR-001, FR-005, FR-019, SC-001, SC-002).
- [x] T013 [US1] Перевести `apps/web/src/transcription/TranscriptTextModal.tsx` на source-only seams T004, прибрати target column/mirror/semantic alignment/useTranslationFollow та translation-only hooks; зберегти search/karaoke/pointer selection/centerActiveWord; оновити `tests/transcription-modal.test.tsx`, `tests/transcription-player.test.tsx` (FR-003, FR-023, SC-006, SC-007).
- [x] T014 [US1] Прибрати translation/both з `apps/web/src/transcription/ExportMenu.tsx`, `TranscriptionCopyMenu.tsx`, `copy.ts`, `export.ts`, `document-cache.ts`; видалити специфічний bilingual media move/save у `apps/agent/src/transcription/export.ts` та queue; зберегти original TXT/SRT/VTT/copy; оновити `tests/transcription-copy.test.ts`, `tests/transcription-export.test.ts`, `tests/transcription-menus.test.tsx` (FR-004, FR-012, SC-006).
- [x] T015 [US1] Замість tests, що вимагають живого перекладача, залишити negative retirement/original regressions у `tests/transcription-retirement.test.ts`; адаптувати `tests/transcription-housekeeping.test.ts`, `tests/lifecycle-wellformed.test.ts`, `tests/lifecycle-transitions.test.ts`, `tests/stop-all.test.ts`, `tests/stop-leaves-nothing-running.test.ts`, `tests/power-spawn-coverage.test.ts`, `tests/power-timeout-scaling.test.ts`; перевірити нуль translator processes/downloads, без пропуску source coverage (FR-006, FR-022–FR-024, SC-002, SC-007, SC-009).

## Phase 4 — US2: обробка простору без перекладів (P1)

**Independent Test**: single/selection/folder/space dry scan і commit, null/default
kinds, repeat/source change, failure/cancel/reconnect — лише active робота й коректні totals.

- [x] T016 [US2] Додати failing scan/claim/transition/totals regressions до `supabase/tests/database/translation-retirement.test.sql` і `tests/creative-library-processing.test.ts` для чотирьох scopes, null/default/mixed kinds, dry/commit, ready rows, expiry/cancel/fail/heartbeat/retry/late accept, mixed active+retired bulk retry (active count, без abort) і cross-team denial (FR-008, FR-009, FR-015–FR-017, SC-003, SC-005).
- [x] T017 [US2] У `supabase/migrations/20261207090000_retire_translation.sql` перевизначити останні scan/claim/heartbeat/cancel/fail/retry/service_accept_library_result; додати active-kind/new-write/transition guards, виключити translation із null/default/dry counts і expiry; bulk scoped retry пропускає її без відмови чинним роботам, explicit retired commands відхиляє; відмовляти stored retired kind до mutation/success replay; зберегти scope/auth/lease/source/idempotency (FR-001, FR-008, FR-009, FR-016, FR-017, SC-003, SC-005).
- [x] T018 [US2] Адаптувати active scan/claim parsers/DTO у `apps/web/src/api/team.ts`, `packages/shared/src/team/library-processing.ts`; прибрати translation created/missing/ready із чинних denominators, old response extras можуть бути лише проігноровані; оновити `tests/creative-library-contract.test.ts`, `tests/creative-library-processing.test.ts` (FR-008, FR-009, FR-014, SC-003).
- [x] T019 [US2] Прибрати translation delegate/targetLanguage/output/wait/fingerprint/action у `apps/agent/src/team-bridge/process.ts`, `team-bridge/library.ts`; залишити source transcription і чинні transfer/cancel semantics; доповнити `tests/creative-library-agent.test.ts` відмовою старому kind (FR-001, FR-008, FR-016, FR-022, FR-024, SC-003, SC-005).
- [x] T020 [US2] Прибрати translation default/chosen/supported kinds, scan counts, unsupported/deferred labels і progress із `apps/web/src/team/library/LibraryProcessingProvider.tsx`, `ProcessLibraryDialog.tsx`; original/landing/preview не змінюють scope або результатів через видалення; оновити `tests/creative-library-processing-ui.test.tsx`, `tests/team-batch-scope.test.tsx` (FR-008, FR-009, FR-019, FR-024, SC-003).
- [x] T021 [US2] Закрити new translation contribution append і active totals у `20261207090000_retire_translation.sql`, shared contribution parsers і чинних UI consumers; зберегти historical records без переобліку, ready/retired не входять у active batch totals; оновити `tests/creative-library-contributions.test.ts` (FR-009, FR-016, AD-005, SC-003).
- [x] T022 [US2] Перевірити в `tests/creative-library-processing-ui.test.tsx`, `tests/creative-library-processing.test.ts` partial/failure/cancel/retry/lost-finalize/reconnect і batch progress, не прирівнювати локальний compute до registered result; записати результат у `specs/046-remove-translator/reviews/acceptance.md` (FR-009, FR-024, AD-002, AD-006, SC-003, SC-007).

## Phase 5 — US3: оригінальний текст на всіх поверхнях (P1)

**Independent Test**: original+legacy translation, тільки legacy translation і
original companion без library result через preview/catalog/tasks/search/actions.

- [x] T023 [US3] Додати failing regressions у `tests/team-preview-transcript.test.tsx`, `tests/creative-library-sidecars.test.tsx` і `supabase/tests/database/translation-retirement.test.sql`: original-only selection, translation-only не original, transcript-companion fallback і різні права (FR-010–FR-012, SC-006).
- [x] T024 [US3] У `20261207090000_retire_translation.sql` змінити останній list_video_text_variants original-only зі збереженням актуальної sourceVersion і original-companion fallback; `apps/web/src/api/team.ts`/shared parser мають нормалізувати історичні extra variants без підміни тексту (FR-010, FR-011, FR-014, SC-006).
- [x] T025 [US3] Прибрати preferred-translation/variant chooser з `apps/web/src/team/library/VideoTextActions.tsx`; перевірити й оновити всі consumers у `team/explorer/PreviewPane.tsx`, `team/catalog/MaterialResults.tsx`, `useMaterialActions.ts`, `team/materials/actions.ts`, `team/tasks/TaskAttachmentTile.tsx`, `team/workspace/WorkspaceShell.tsx` — view/copy/retranscribe тільки original (FR-010, FR-011, FR-019, SC-006).
- [x] T026 [US3] У `tests/material-action-registry.test.ts`, `tests/team-preview-transcript.test.tsx`, `tests/creative-library-tasks.test.tsx`, `tests/creative-library-sidecars.test.tsx` підтвердити ті самі дії через search/results/details/tasks/context menus, original absence й permission refusal; жодного legacy fallback як original (FR-010–FR-012, FR-024, SC-006, SC-007).

## Phase 6 — US4: безпечний перехід старих робіт і дозволів (P1)

**Independent Test**: persisted states + valid old grants, усі RPC transitions й
дві справжні DB sessions; старі файли/links незмінні, нова публікація fenced.

- [x] T027 [US4] Написати failing old-intent/grant/upload regressions у `tests/translation-retirement-server.test.ts`, `tests/process-output-upload.test.ts`, `tests/process-output-ownership-sql.test.ts` для process_input, output/start/finalize, browser upload/finalize, already-succeeded readback і прямого SQL service finalize (FR-015–FR-017, SC-004, SC-005).
- [x] T028 [US4] У `20261207090000_retire_translation.sql` в одній транзакції з guards припинити pending/leased/running/failed/stale requirements, leased/running attempts і pending/running translation operations через canceled/FEATURE_RETIRED/finished_at; відкликати input/finalize grants; ready/succeeded/files/contributions не видаляти, повтор ідемпотентний (FR-012, FR-015, FR-017, SC-004, SC-005).
- [x] T029 [US4] Прибрати translation new-start rule в `supabase/functions/drive-ops/index.ts`, додати stored-intent guards до process input, output start/finalize, browser upload finalize і generated-text cache **до** provider I/O; адаптувати `supabase/functions/library-ops/handler.ts` без довіри до відсутнього kind у body; зберегти existing ownership/adoption fences (FR-001, FR-016, FR-017, SC-005).
- [x] T030 [US4] У `20261207090000_retire_translation.sql` закрити останні service process intent/grant consume/prepare/start/finalize_uploaded_material та result/contribution adoption межі на stored translation tool; new-write guards мають відмовляти stale Edge, succeeded replay лише незмінний historical readback; зберегти auth/tenant/source/lease (FR-016, FR-017, FR-024, SC-005).
- [x] T031 [US4] Зберегти private legacy companion role parse у `supabase/functions/_shared/library.ts` і group snapshots; перевірити move/share/copy/trash/restore у `tests/creative-library-placement.test.ts`, `tests/creative-library-sharing.test.ts`, `tests/creative-library-sidecars.test.tsx`, `tests/creative-library-security.test.ts` без видалення/перейменування provider-файлів (FR-012, FR-023, FR-024, SC-004, SC-007).
- [x] T032 [US4] Завершити current-schema pgTAP у `supabase/tests/database/translation-retirement.test.sql` через `npm run test:db`; створити feature-only `scripts/test-translation-retirement-upgrade.mjs` і `tests/translation-retirement-upgrade-postgres.test.ts`: власний owned loopback disposable PG (1 CPU/512MiB, scheduler off, schema/roles-only/no passwords or rows з локального source), canonical prefix → `tests/fixtures/translation-retirement-upgrade.sql` → feature tail → upgrade assertions. Дві свіжі prefix fixtures перевіряють retirement↔finalize у протилежному порядку deterministic barriers, плюс idempotent transition/expiry/heartbeat/fail/cancel. Guard-ів не вимикати; універсальний runner не змінювати; reuse `scripts/lib/supabase-schema-baseline.mjs`, `scripts/lib/disposable-auth.mjs`, `tests/support/disposable-postgres.ts`, cleanup тільки own target на success/failure/signal, remote URLs refused і missing prerequisites = explicit failure. Регенерувати `apps/web/src/lib/database.types.ts` через `npm run types:supabase:local`; recovery notes у `supabase/migrations/ROLLBACK.md` без down/data delete (FR-014–FR-018, SC-004, SC-005).
- [x] T033 [US4] Перевірити clean/no-model/installed/partial-model upgrade, restart/import/retry, API5↔6 та no tool requests у `tests/transcription-retirement.test.ts`, `tests/connection.test.ts`, `tests/stop-leaves-nothing-running.test.ts`; artifacts лишаються інертними, original/preview/power cleanup працюють (FR-013, FR-014, FR-018, FR-024, SC-004, SC-007, SC-009).

## Phase 7 — US5: нуль продуктових згадок (P1)

**Independent Test**: uk/en × light/dark × normal/empty/loading/error/disconnected,
keyboard/touch, first-run й два packaged clients; user content не цензурується.

- [x] T034 [US5] Прибрати translation-only locale keys/copy у `apps/web/src/locales/uk.ts`, `en.ts`, descriptions `HomePage.tsx`, `lib/tool-registry.ts`, `pages/legal-content.ts`, `team/tariffs/SpaceShowcase.tsx`; нейтралізувати старі system action labels у `team/workspace/HistoryDialog.tsx`, `team/members/TeamAuditPanel.tsx` і contribution consumers без зміни збережених фактів/names/content (FR-019, FR-020, FR-023, SC-001).
- [x] T035 [US5] Видалити translation-only selectors/layout у `apps/web/src/styles/transcription.css`, `styles.css`, `styles/team-tasks.css` і demo fixtures у `apps/soty-review/src/screens/transcription/TranscriptionReview.tsx`; source-only layout без пустої колонки й зайвих spacers, тільки чинні tokens (FR-003, FR-019, FR-020, SC-001, SC-006).
- [x] T036 [P] [US5] Узгодити `README.md`, `THIRD_PARTY_NOTICES.md`, `packaging/licenses/`, актуальні `docs/WINDOWS.md`, `docs/TRANSCRIPTION_RELIABILITY_PLAN.md`, env examples/registry і product help з відсутністю фічі; прибрати виключно retired TRANSLATION_/ALIGNMENT_/cache options; історичні releases/applied migrations й локалізацію не переписувати (FR-019–FR-023, SC-001).
- [x] T037 [US5] Прибрати translation-only artifacts/notices/assertions із `scripts/package-mac.sh`, `package-dev-mac.sh`, `package-beta-mac.sh`, `verify-package.sh`, `verify-dev-package.sh`, `stage-windows-runtime.mjs`, `verify-windows-package.mjs`, `windows-smoke.mjs` та пов’язаних inputs; чинні speech/інших tools payloads зберегти (FR-005, FR-021, FR-024, SC-001, SC-007).
- [x] T038 [US5] Додати source/UI/package negative checks у `tests/translation-retirement-surfaces.test.tsx`, оновити `tests/i18n.test.ts`, `tests/branding.test.ts`, `tests/loading-skeletons.test.tsx`; виконати browser matrix з `quickstart.md`, перевірити accessible names/empty/error/disconnected і no network/spawn без видалення користувацьких слів (FR-019–FR-025, SC-001, SC-002, SC-007).

## Phase 8 — US6: наскрізна діагностика (P2, обов’язкова до release)

**Independent Test**: producer fixtures → sanitizer/storage → CLI inspect/investigate/audit
для original success/refusal/cancel/recovery/retirement та missing/late evidence.

- [x] T039 [US6] Написати failing coverage regressions у `tests/translation-retirement-diagnostics.test.ts` і `tests/analytics-coverage-registry.test.ts`: distinct attempt correlation, saved≠visible, retired current vs historical unknown, rejected без fictitious start, missing schema/as-of/truncation/privacy (AD-001–AD-008, SC-008).
- [x] T040 [US6] У `packages/shared/src/types.ts`, `apps/agent/src/server/diagnostics-log.ts`, `transcription/routes.ts`, `queue/transcription-queue.ts`, `team-bridge/process.ts` додати bounded closed transcription journal/stages і attempt IDs за контрактом (≤12 records/attempt, stage deduplication, reserved saved/terminal, bounded omission marker/count, existing ring bounds), apiVersion6 provenance, FEATURE_RETIRED refusal; без content/progress ticks/inventory (AD-001–AD-003, AD-006, AD-007).
- [x] T041 [US6] У `apps/web/src/analytics/events.ts`, `analytics/tools.ts`, `analytics/errors.ts`, `transcription/TranscriptionPage.tsx`, `TranscriptTextModal.tsx`, `team/library/LibraryProcessingProvider.tsx` додати потрібні closed discriminators й original/save/visible/batch correlation, completion тільки за підтвердженим наслідком; existing lifecycle counts не дублювати, transport/SSE/Realtime не множити (AD-001–AD-003, AD-006–AD-008, SC-008).
- [x] T042 [US6] Створити `supabase/migrations/20261207091000_translation_retirement_diagnostics.sql`: restricted content-free analytics_translation_retirement view, вузькі SELECT grants, за потреби additive allowlist guard для нових typed event/journal fields; перевірити DB privacy/roles/unknown codes і фактичне збереження сигналів у `supabase/tests/database/translation-retirement.test.sql` (AD-003, AD-004, AD-006–AD-008).
- [x] T043 [US6] Додати bounded schema-aware reader `scripts/analytics/library-retirement.ts`, schema/types і joins у `queries.ts`, `investigate.ts`; підтримати inspect/investigate/audit, bound period/as-of/default100/max500/truncated, unknown actor та missing projection без ad-hoc SQL/envelope reshaping; оновити `tests/analytics-schema-compat.test.ts` (AD-003–AD-008, SC-008).
- [x] T044 [US6] У `scripts/analytics/coverage-registry.ts`, `types.ts`, `queries.ts` відділити current retired-for-API6 від historical producer coverage; старі/невідомі версії не рахувати новими або нульовими, cutover date не виводити з migration filename; оновити `tests/analytics-coverage-registry.test.ts`, `tests/translation-retirement-diagnostics.test.ts` і всі status consumers (AD-004–AD-006, SC-008).
- [x] T045 [US6] У `scripts/analytics/code-map.ts`, historical shared error catalog, `apps/web/src/analytics/errors.ts`, `supabase/functions/_shared/errors.ts` завершити FEATURE_RETIRED mapping і читання historical TRANSLATION_FAILED/TRANSLATOR_UNAVAILABLE без deleted file links; `tests/analytics-code-map.test.ts`, `tests/analytics-error-codes.test.ts` й DB catalog не допускають unknown drift (AD-003, AD-005, AD-007, SC-008).
- [x] T046 [US6] У `tests/translation-retirement-diagnostics.test.ts`, `tests/transcription-coverage.test.ts`, `tests/process-output-diagnostics.test.ts` прогнати справжній produced payload через sanitizers, storage fixture/SQL і CLI readers до finding для success/failure/cancel/interruption/retry/retirement/missing/late і багатовіконного recovery понад проміжний бюджет (saved/terminal не губляться); перевірити no secrets/content, зафіксувати beta telemetry-disabled межу в `reviews/acceptance.md` (AD-001–AD-008, SC-008).

## Phase 9 — Cross-cutting acceptance

- [x] T047 Повторити повний residual import/text/SQL/package/env пошук за `specs/046-remove-translator/scope-audit.md`, пояснити кожний залишок по суті (localization/history/inert reader/shared helper), перевірити uppercase SQL definitions і generic grants; записати `specs/046-remove-translator/reviews/residuals.md`; unexplained executable/visible остатки блокують приймання (FR-001, FR-019–FR-025, SC-001).
- [x] T048 Виконати focused single-worker suites з `specs/046-remove-translator/quickstart.md`, shared/agent/web builds і static checks; виправити feature regressions без ослаблення gates, зберегти результати/skip reasons у `reviews/acceptance.md` (FR-002, FR-023, FR-024, SC-007).
- [x] T049 Послідовно виконати `nice -n 15 npm run verify` і `nice -n 15 npm run verify:release`, перевірити `verification-result.json`; зафіксувати actual failures/prerequisites в `reviews/acceptance.md`, не приховувати known bundle-budget baseline й не піднімати ліміт (FR-024, SC-007, SC-008).
- [ ] T050 Пройти local exact-candidate packaged beta і macOS/Windows install/use/upgrade/package smoke за `docs/BETA.md`, `docs/WINDOWS.md`, `quickstart.md`; no translator assets/dependencies/download/spawn, retained original quality/exports/tasks і correct mixed-version block; заповнити `reviews/acceptance.md` фактичними SHA/platform/build/evidence, без production activation (FR-005, FR-006, FR-018, FR-021, FR-024, SC-001–SC-009).
- [x] T051 Звірити фактичну реалізацію з `spec.md`, `plan.md`, `tasks.md`, `contracts/retirement.md` та всіма SC, внести тільки доведені відмітки виконання, оновити `checklists/requirements.md`, `reviews/acceptance.md` і список genuinely unobservable stages; немає прихованої фічі, cleaner або втрати файлів; невиконані critical gates не називати release-ready (FR-012, FR-013, FR-025, AD-006–AD-008, SC-001–SC-009).

## Dependencies & execution order

1. T001 → T002 → T003/T004 → T005 → T006.
2. US1 T007–T015 після foundation; tests до відповідних змін. T009 після T008/T003,
   T013 після T004/T012, T014 після T013. Завершити оригінальний local pipeline.
3. US2 T016–T022 після foundation та US1: спочатку server regression/writer guards,
   потім agent/UI integration. T017 → T018/T019 → T020 → T021 → T022.
4. US3 T023–T026 після US2 DTO/SQL: failing tests → RPC → UI → усі consumers.
5. US4 T027–T033 після US2/US3; T028/T030 доповнюють **той самий** файл міграції
   T017/T021/T024 і не паралеляться з ними. T028 → T029 → T030 → T031 → T032/T033.
   До T032 не вважати authoritative server retirement завершеним.
6. US5 T034–T038 після US1/US3/US4; T036 можна правити поруч із T035, бо файли різні,
   але закінчити до packaging T037/T038. Повторний full search — T047.
7. US6 T039–T046 після стабілізації всіх execution/DTO seams; T040 → T041 → T042 →
   T043 → T044/T045 → T046. Shared/types/registry файли не редагувати конкурентно.
8. T047 → T048 → T049 → T050 → T051. Важкі перевірки завжди послідовні,
   missing prerequisites залишають відповідний gate непідтвердженим.

## Parallel opportunities

Позначка [P] — лише можливість окремих правок, не команда запускати додаткових агентів
чи важкі процеси. За замовчуванням виконувати послідовно.

- Foundation: T004 (web source helpers) поряд з T003 (agent lexical helpers).
- US1: після підготовки source seam можна незалежно дослідити copy/export tests T014
  і local document tests T007; реалізація йде за наведеним порядком через shared consumers.
- US2: T019 agent delegate та T018 API parsers мають різні файли після T017;
  не починати T020 до узгодження обох.
- US3: surface regression для tasks/search і SQL fallback fixtures можна готувати
  окремо всередині T023; T024/T025/T026 послідовні.
- US4: приватні group-file fixtures T031 та mixed-version fixtures T033 не мають
  спільних файлів, але серверну міграцію T028/T030 не паралелити.
- US5: T036 docs/licenses поруч із T035 styles/demo; T037 packaging читає готові notices.
- US6: code-map regression T045 і reader fixture сценарії T039 можна дослідити окремо;
  спільні event/type/registry mutations виконувати послідовно.

## Implementation strategy

Перший локально перевірюваний increment — US1 після foundation. Це **не** MVP для
публікації: owner вимагає повної ліквідації, тож усі US1–US6 і cross-cutting gates
обов’язкові. Незалежні тести історій не означають незалежний deploy змінених контрактів.
Серверний cutover має атомарні fences до прийняття нової роботи; production порядок
визначає чинний runbook, не довільні deploy commands із задач.

Чекати додаткового підтвердження для виправлення знайденої прогалини документів не
потрібно: owner це вже авторизував. Реалізація/production та відмітки actual PASS
не випливають із самого створення plan/tasks/analysis.

## Implementation notes — 2026-10-27

- T027: native stored-intent/grant/late-finalizer regressions consolidated in
  `translation-retirement-upgrade-postgres.test.ts` and existing process-output
  suites, instead of a duplicate `translation-retirement-server.test.ts`.
- T032: both real-session cutover orderings ran on disposable previous-schema
  fixtures. Canonical DB types generated against the owned clone. Nullable
  generated RPC inputs remain in the existing `database.compat.ts` seam.
- T037: added `clean-agent-dist.mjs` to agent build: tsc otherwise ships orphan
  JS from deleted source. It empties only repository dist; user models untouched.
- T039–T046: end-to-end native producer/sanitizer/SQL/CLI assertions reside in
  `agent-journal-ingest.test.ts`, `translation-retirement-reader.test.ts` and
  `translation-retirement-diagnostics.test.ts`; no new polling/transport.
  `library-original-visibility.test.tsx` covers accepted-attempt provenance,
  render-before-visible, clipboard-before-copied, and unknown legacy provenance.
- T038: source/locale/package negative checks and 8 Chromium component/theme/locale/
  width fixtures complete. Full packaged platform matrix remains T050; remaining
  empty/error/disconnected/touch acceptance is not inferred from screenshots.
- Checkmarks on source tasks do not claim exact-candidate beta/Windows readiness.
  Final canonical suite/build evidence is recorded in acceptance, including failures.

## Verification disposition

- T049 executed both canonical forms. Their failures remain recorded; this is not
  a green full-suite/release claim. Retirement regressions were repaired and their
  affected suites rerun successfully. Remaining shards ran independently.
- T038 remains partially unverified for the complete manual empty/error/disconnected/
  keyboard/touch/browser matrix; negative source/UI/package tests and8 Chromium
  theme/locale/width fixtures are proven. T050 exact-candidate native macOS/Windows
  packaging remains unproven (beta ports occupied; Windows unavailable).
- T051 reconciliation complete: source implemented; no production activation,
  cleanup of user models/files, version bump or stable-manifest rewrite. Release
  readiness remains blocked by the documented acceptance gaps and existing budget.

### T038 follow-up

Complete local component/page matrix:56 cases covering7 states ×2 locales ×2
themes ×2 widths, real page/CSS with fixture context/API, keyboard focus and
mobile expand/help touch smoke. No errors/retired requests/labels. Hindi modal
matrix separately proves source-only text and tooltip contrast. Earlier partial
T038 notes above are superseded by this evidence. Native packaged clients and
full host-shell acceptance remain explicitly under T050.
