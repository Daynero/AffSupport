# Tasks: Швидкий міні-реліз без оновлення агента

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts](contracts/), [quickstart.md](quickstart.md).

**Status**: implementation started; T006 completed as a timed test-only task. Remaining tasks are pending. New mini contract regressions are deliberately RED until T007–T009; production is not authorized.

**Tests**: обов’язкові за spec AD-007 та SC-003–008; спершу failing regression, потім implementation. Один heavy process/worker одночасно, `nice -n 15` для важких локальних команд.

**Format**: `- [ ] Tnnn [P?] [USn?] ... exact/path`. `[P]` означає independent files/fixtures у межах уже відкритої фази; dependencies попередніх фаз залишаються.

## Phase 1: Setup

**Purpose**: зафіксувати межі й acceptance inputs; жодних production-записів. Наявні продуктові незакомічені правки не включаються у реалізацію 043.

- [ ] T001 Зафіксувати inventory поточних runner/backend/beta/analytics seams, trusted runner/source snapshots і protected agent inputs у `specs/043-mini-release/research.md`; описати baseline enrollment gaps та single-authority prerequisite.
- [ ] T002 Підготувати окремий явний draft amendment із Sync Impact Report у `.specify/memory/constitution.md` та синхронні зміни release/beta sections `AGENTS.md`, `docs/PRODUCTION.md`, `docs/BETA.md` за `specs/043-mini-release/contracts/governance.md`; не оголошувати ratification чи production GO.
- [ ] T003 [P] Створити machine-readable 24-case inventory, old/new client/data/role/fault/native/timing variants і expected proof IDs у `specs/043-mini-release/acceptance/cases.json` відповідно до `contracts/verification.md`.
- [ ] T004 Визначити versioned conservative policy, expiry, DB budgets, single-authority prerequisite та protected check IDs у `config/mini-release-policy.json`; повний policy digest входить в admission.
- [ ] T005 Створити `scripts/lib/release/mini/executor.mjs` та failing OS-isolation self-tests за `specs/043-mini-release/contracts/executor.md`: dedicated verifier UID, private HOME, exported source/deps, denied host keys/store, kernel default-deny PF egress для UID з єдиним loopback inspection proxy, effective-ruleset digest і direct socket/IPv4/IPv6/DNS/QUIC canaries; enrollment prerequisites explicit, no automatic elevation.

---

## Phase 2: Foundational prerequisites

**Purpose**: спільна identity/ownership/registry основа. Блокує story implementation до завершення T017. Production activation залишається closed незалежно від local test success.

- [x] T006 Додати failing boundary/registry/state/resume fixtures для full v1 та mini v2 у `tests/mini-release-contract.test.ts`, включно з unknown keys, no version/bump, foreign steps та intent digest drift.
- [ ] T007 Розширити typed data-only boundary у `packages/shared/src/release-runner.ts` і validators у `scripts/lib/release/mini/contracts.mjs`, `scripts/lib/release/intent.mjs`; full v1 default лишається сумісним.
- [ ] T008 Додати selected registry та shared dependency/completion checks у `scripts/lib/release/steps.mjs`, `scripts/lib/release/flow.mjs`, `scripts/lib/release/state.mjs`, `scripts/lib/release/recovery.mjs`; відхиляти чужі/непослідовні completed receipts.
- [ ] T009 Зберігати frozen intent/binding/change-plan digests і selected mode через CLI/worker/status/panel у `scripts/release-runner.mjs`, `scripts/release-worker.mjs`, `scripts/lib/release/store.mjs`, `scripts/lib/release/progress.mjs`; усунути environment identity drift і зробити resume реальним supervised continuation.
- [ ] T010 Додати tests direct/controller/full/mini/backend/recovery races, PID/boot reuse, stale generation та uncertain in-flight effects у `tests/mini-release-ownership.test.ts`.
- [ ] T011 Інтегрувати canonical target claim і controller-to-worker delegation у `scripts/lib/release/target-ownership.mjs`, `scripts/lib/release/controller.mjs`, `scripts/lib/release/controller-runner.mjs`, `scripts/release-runner.mjs`, `scripts/release-worker.mjs`; store/cwd override не створює другий lock namespace, unknown in-flight write блокує takeover.
- [ ] T012 Додати приватний target-shared artifact/evidence/baseline store з atomic/fsync/CAS, retention і active-reference protection у `scripts/lib/release/mini/baseline.mjs`, `scripts/lib/release/mini/artifacts.mjs`; worktree cleanup не видаляє receipts.
- [ ] T013 Реалізувати read-only baseline discovery/import із provider observations, signed channel, immutable source lineage і legacy-receipt refusal у `scripts/lib/release/mini/baseline.mjs`; неопізнаний current state повертає BASELINE_UNPROVEN. У baseline включити normalized live schemaDefinitionDigest, щоб виявляти ручний catalog drift.
- [ ] T014 Реалізувати operator `release mini --source <ref> --target <id> [--prepare-only]` і `--recover-web` у `scripts/release-runner.mjs`, `tests/mini-release-cli.test.ts`: auto read-only discovery/UUID/digests/frozen intent, no manual hashes або test-harness dependency, existing supervised start/guards.
- [ ] T015 Реалізувати feature-specific activation у `scripts/lib/release/activation.mjs` і всіх write entrypoints: ratified mini policy/runner digest + live sandbox proof + existing G0/042; single trusted authority prerequisites explicit, без version-string або dry-run bypass.
- [ ] T016 Додати common mini impact profile до `scripts/verify-all.mjs` та validators/check selection у `scripts/verify-mini-release.mjs`; зберегти fast/release meanings, єдиний result envelope/caps/timeouts та обов’язкову fast suite, без arbitrary skip.
- [ ] T017 Провести foundation non-regression у `tests/release-runner-contract.test.ts`, `tests/release-runner-flow.test.ts`, `tests/release-controller-runner.test.ts`, `tests/mini-release-contract.test.ts`; зафіксувати prerequisites checkpoint у `specs/043-mini-release/quickstart.md`.

---

## Phase 3: User Story 1 — Web hotfix (P1)

**Goal**: новий exact web candidate зі старим packaged agent за один запуск. **Independent Test**: web-only sandbox control; zero packaging/version/channel changes, new visible result, active draft/local job preserved. MVP означає локальну демонстрацію; production потребує всіх safety/recovery/diagnostics stories.

- [ ] T018 [P] [US1] Додати failing exact-byte build/upload та no packaging fixtures у `tests/mini-release-web.test.ts`; source/config/bundle/manifest tampering і backend-only no-web variants.
- [ ] T019 [P] [US1] Додати failing full package payload/provenance/equivalence та candidate-vs-bundled-web fixtures у `tests/mini-release-beta.test.ts`; старий verification.json не приймається як новий proof. Окремі fixtures для environment-derived native wrapper provenance, unmatched strip/re-sign і wildcard executable exclusions.
- [ ] T020 [US1] Створити trusted package-equivalence verifier у `scripts/lib/release/mini/evidence.mjs`; покрити archive/payload/tools/runtime/dependency hashes, embedded source revision та narrow environment differences; no rebuild fallback. Agent JS/tools/deps byte-identical; native wrapper equivalence лише за paired trusted template/rendered-source/compiler/SDK/flags/signing/substitution/binary build records із contracts/support-matrix.md.
- [ ] T021 [US1] Посилити provenance producers у `scripts/verify-beta-package.sh` та `scripts/verify-beta-runtime.mjs`: брати revision з package metadata, хешувати actual payload і відокремлювати agent-only runtime proof від candidate web proof; old records versioned/blocked для mini.
- [ ] T022 [US1] Створити one-time native-wrapper enrollment producer у `scripts/package-beta-mac.sh`, `scripts/render-launcher.mjs`, `scripts/lib/release/mini/evidence.mjs`: exact template/rendered-source/toolchain/SDK/signing/substitution і paired binary hashes; no wildcard executable exclusions або launcher rebuild у mini, unknown legacy pair blocked.
- [ ] T023 [US1] Реалізувати finite signed-baseline inventory й selector у `config/mini-release-support.json`, `scripts/lib/release/mini/evidence.mjs`, `tests/mini-release-support.test.ts` за `specs/043-mini-release/contracts/support-matrix.md`: current/oldest cohorts, affected seams, CSS native reuse і mandatory reruns.
- [ ] T024 [US1] Побудувати changed-surface artifacts один раз у frozen worktree через `scripts/lib/release/mini/artifacts.mjs`; canonical manifests, source/config/toolchain digests, stable bytes та preupload archive; заборонити symlink escape/missing-extra files.
- [ ] T025 [US1] Створити `apps/web/src/build-identity.ts`, узгодити `apps/web/vite.config.ts` і `apps/web/src/vite-env.d.ts`; trusted independent webBuildId embedded before hashing, outputDigest тільки outside bundle.
- [ ] T026 [US1] Зібрати mini step adapter у `scripts/lib/release/mini/adapter.mjs` та підключити до `scripts/release-worker.mjs`; selected steps не можуть викликати package/publish/sign або `npm run deploy:web` rebuild chain.
- [ ] T027 [US1] Реалізувати candidate beta browser journey і prewrite exact production artifact/config proof у `scripts/lib/release/mini/rehearsal.mjs`, `tests/mini-release-browser.test.ts`; real auth/pairing/entitlement, actual visible result на unchanged agent, zero unauthorized production side effects. Цей крок формує лише prewrite admission: новий DB-dependent production control NOT_RUN до backend apply; жодної вимоги виконати його до появи схеми.
- [ ] T028 [US1] Реалізувати postbackend/preactivation exact-byte preview у `scripts/lib/release/mini/preview.mjs`, `scripts/lib/release/mini/adapter.mjs`, `tests/mini-release-browser.test.ts`: trusted static-only route.fulfill під canonical origin, real auth/backend/agent requests, scoped synthetic controls та CSP/header proof; E03 потребує нової схеми, failure не активує web.
- [ ] T029 [US1] Розділити guarded upload і build у `scripts/deploy-web.mjs`, `scripts/lib/release/adapters/web.mjs`, `scripts/release-web-meta.mjs`; mini only admits exact artifact, provider deployment ID/run correlation, full legacy deploy retains gates.
- [ ] T030 [US1] Реалізувати web current-state reconciliation/live hashes/control-readback і freshness/cache checks у `scripts/lib/release/mini/adapter.mjs`; accepted upload не є completed, response loss не запускає duplicate upload.
- [ ] T031 [US1] Підключити candidate-specific mini admission до `scripts/verify-beta-promotion.mjs` лише через verified policy-bound record; жодного stale-SHA exception або weakening full package/final gates.
- [ ] T032 [US1] Довести active draft/ongoing local job preservation і fresh-tab new asset identity у `tests/mini-release-browser.test.ts`; reuse чинного browser/state seams без нового recurring polling або примусового reload.

---

## Phase 4: User Story 2 — Compatible backend / DB (P1)

**Goal**: backend-only і web+backend transitions з old/new клієнтами. **Independent Test**: disposable DB + actual local edge serving; old/new rows/RPCs/roles/jobs коректні на кожному проміжному етапі. Залежить від foundation; combined web activation використовує US1.

- [ ] T033 [P] [US2] Додати failing SQL grammar/budget/signature/permission/destructive cases у `tests/mini-release-policy.test.ts`, включно з comments/dollar quoting/dynamic bodies, not-null rewrite, drop/recreate same name та unsupported nontransactional SQL. Policy забороняє SQL обходити transaction/deadline GUC.
- [ ] T034 [P] [US2] Додати failing real disposable upgrade/old-new-data/RLS/COMMIT-response-loss/budget scenarios у `tests/mini-release-database.test.ts`; mocks не доводять PostgreSQL transaction/lock semantics. Додати real multi-statement тест, де кожен statement коротший max, але сума перевищує absolute transaction/global budget: rollback schema+ledger, без перезапуску бюджету.
- [ ] T035 [US2] Реалізувати conservative bounded statement policy у `scripts/lib/release/mini/policy.mjs`; reuse `scripts/lib/release/migration-compat.mjs` лише як додатковий screening, unsupported grammar/semantics не auto-safe.
- [ ] T036 [US2] Розширити exact backend plan/dependency closure у `scripts/lib/release/backend-scan.mjs`, `scripts/lib/release/backend-plan.mjs` для mini evidence/check/recovery digests без weakening full boundary; включити resolved imports/shared functions і explicit empty plan.
- [ ] T037 [US2] Реалізувати independent current function-body/provider-version/schema-history observations у `scripts/lib/release/adapters/supabase-backend.mjs`, `scripts/lib/release/mini/baseline.mjs`; normalized body manifests не плутають source digest з slug ACTIVE. Порівнювати normalized schemaDefinitionDigest, а не лише history row.
- [ ] T038 [US2] Додати dedicated release DB credential metadata/format/target checks у `config/environments.json`, `scripts/verify-production-config.mjs`, `scripts/lib/release/mini/db-executor.mjs`; analytics URL/role і неправильний TLS/project endpoint відхиляються, секрети не потрапляють до build/logs.
- [ ] T039 [US2] Реалізувати transactional mini migration executor у `scripts/lib/release/mini/db-executor.mjs` на наявному pg: verified SET LOCAL lock/statement budgets, atomic reviewed SQL+Supabase-compatible migration history, 120s total boundary, no db push --linked або nontransactional fallback. За contracts/migration-history.md statement array і tuple генерує pinned vendor CLI у disposable rehearsal; supported ledger schema перевіряється до writes. Absolute transaction 30s/apply120s deadlines з 5s reserve зменшують server-side timeout перед кожним statement/history/COMMIT, не лише перед новою транзакцією.
- [ ] T040 [US2] Додати blocking real vendor interop у `tests/mini-release-ledger.test.ts`: pinned CLI generates tuple, mini applies A, CLI list/dry-run/full planner бачить applied A, CLI реально застосовує наступну full migration B без replay/repair; rollback row absent та source/schema drift rejected за `specs/043-mini-release/contracts/migration-history.md`.
- [ ] T041 [US2] Побудувати disposable baseline-schema/function-source replay й synthetic old/new fixtures у `scripts/lib/release/mini/rehearsal.mjs`; transition candidate до кожного проміжного стану, scoped cleanup без production rows або dump. Pinned official CLI формує canonical source-bound version/name/ordered-statements tuple і schema adapter fingerprint для того самого reviewed SQL.
- [ ] T042 [US2] Реалізувати actual function-serving/role/data/old-RPC/background-job postconditions у `scripts/lib/release/mini/rehearsal.mjs`, `scripts/lib/release/adapters/backend-beta.mjs`; directory exists/history present не proof.
- [ ] T043 [US2] Посилити mini path у `scripts/lib/release/adapters/backend.mjs`: exact pending recheck, immutable history/digests і fsync batch/per-transaction prepared receipt до effects; preserve full legacy contract.
- [ ] T044 [US2] Додати observation після exception/timeout/unknown COMMIT у `scripts/lib/release/adapters/backend.mjs`, `scripts/lib/release/mini/db-executor.mjs`; matching adopt/proven absent bounded retry/conflict stop, history+postconditions proof обов’язковий.
- [ ] T045 [US2] Підключити mini rehearsal/apply/function exact version до `scripts/lib/release/mini/adapter.mjs` у dependency order; backend-only не змінює web, previous web працює після partial apply. Порядок: prewrite admission → backend apply/postconditions → mini_activation_verify → activation admission → web activation; previous web active під час перевірки.
- [ ] T046 [US2] Інтегрувати independent surface receipts/CAS baselines у `scripts/lib/release/mini/baseline.mjs`, `scripts/plan-backend-release.mjs`, `scripts/lib/release/step-adapter.mjs`; later full release не повторює applied migrations і не затирає новіший web непомітно.
- [ ] T047 [US2] Підключити `scripts/apply-backend-plan.mjs` до shared authority/target-claim/activation/identity guards; не залишати standalone write bypass і додати full/mini/standalone regression у `tests/mini-release-backend.test.ts`.

---

## Phase 5: User Story 3 — Reject unsafe / unknown changes (P1)

**Goal**: deterministic eligibility із exact missing proof; full release не стартує автоматично. **Independent Test**: 24-case eligibility suite; жодний небезпечний/недоведений кандидат не доходить до production writes. Hard safety rejection є foundation для будь-якого demo; ця story завершує повний adversarial набір.

- [ ] T048 [P] [US3] Додати compiler-graph/re-export/module-side-effect/type-only/generated-schema/dynamic-import та web-only lockfile fixtures у `tests/mini-release-impact.test.ts`.
- [ ] T049 [US3] Реалізувати protected input fingerprints, TypeScript-resolved runtime/declaration/contract closure і conservative unresolved fallback у `scripts/lib/release/mini/impact.mjs`; no blanket shared/path-only allowlist або tree-shaking assumption. Affected native seam fingerprints живлять finite cohort selector за contracts/support-matrix.md.
- [ ] T050 [US3] Реалізувати full agent-source lineage й independent surface diff, dependency/config/toolchain drift та protected automation self-change rejection у `scripts/lib/release/mini/impact.mjs`, `scripts/lib/release/mini/adapter.mjs`.
- [ ] T051 [US3] Реалізувати evidence expiry/reuse/invalidation у `scripts/lib/release/mini/evidence.mjs`; fresh new candidate checks, 24h generic compile/test-fact cap, 30min admission, 15min artifact availability; remote state re-observed перед writes. Immutable native baseline facts мають окремий reuse predicate за contracts/support-matrix.md, без штучного 24h expiry; 24h лишається для generic test/compile evidence.
- [ ] T052 [US3] Зв’язати eligible/requires-full/requires-separate/insufficient з closed codes/recovery hints у `scripts/lib/release/mini/policy.mjs`, `scripts/lib/release/mini/diagnostics.mjs`; author compatible boolean не admission.
- [ ] T053 [US3] Ізолювати candidate build/tests від production write env/files через `scripts/lib/release/adapters/git-worktree.mjs`, `scripts/lib/release/mini/adapter.mjs`; trusted installed verifier не замінюється кандидатом; додати hostile-build/secret-redaction tests у `tests/mini-release-security.test.ts`. Використати справжній separate OS UID/executor із contracts/executor.md: actual denied читання original absolute secret canary/HOME/symlink/child/fd, denied trusted-store write і management egress; env/worktree-only isolation не proof.
- [ ] T054 [US3] Прогнати всі eligibility cases E01–E24 з `specs/043-mini-release/acceptance/cases.json` через `tests/mini-release-policy.test.ts`, `tests/mini-release-impact.test.ts`; для unknowns жодного synthetic PASS.
- [ ] T055 [US3] Довести TOCTOU identity/digest/prewrite checks і active-target drift rejection у `tests/mini-release-security.test.ts`, `tests/mini-release-backend.test.ts`; explicit single-authority scope, no claim remote CAS якщо provider не підтримує.

---

## Phase 6: User Story 4 — Resume and explicit recovery (P1)

**Goal**: safe continuation після partial effect і exact web recovery без data loss. **Independent Test**: terminate/response-lost faults, controlled takeover, current-channel-compatible archive і нові записи; жодного automatic rollback. Залежить від US1/US2 external effect observations.

- [ ] T056 [P] [US4] Додати failing boundary fault/cancel/resume/recovery cases у `tests/mini-release-recovery.test.ts`, включно з pending provider effect і crash до/після receipt. Додати backend-applied/activation-preview-failed, expired prewrite admission та unknown COMMIT boundaries.
- [ ] T057 [US4] Реалізувати journal-based completed-step validation та external observation перед resume у `scripts/lib/release/recovery.mjs`, `scripts/lib/release/mini/recovery.mjs`; unknown effect блокує replay і takeover.
- [ ] T058 [US4] Зберігати observed in-flight result навіть після cancel та припиняти наступні writes на safe boundary у `scripts/release-worker.mjs`, `scripts/lib/release/mini/adapter.mjs`; cancellation не видається за applied DB reversal.
- [ ] T059 [US4] Підключити explicit recover-web operation до `scripts/rollback-web.mjs`, `scripts/lib/release/mini/recovery.mjs`; перевіряти flat bindingId/full binding, current channel, current schema/function compatibility і exact archived bytes.
- [ ] T060 [US4] Виконувати recovery через shared claim/admission/provider observation/live verify, додавати new history/baseline receipt у `scripts/rollback-web.mjs`, `scripts/lib/release/mini/baseline.mjs`; жодного patch архіву чи rebuild.
- [ ] T061 [US4] Додати plan-bound function return/forward-fix recovery descriptors і new-data compatibility checks у `scripts/lib/release/mini/recovery.mjs`, `tests/mini-release-backend.test.ts`; no destructive DB rollback/backup overwrite.
- [ ] T062 [US4] Покрити ambiguous provider response, partial function rollout і changed canonical deployment у `tests/mini-release-web.test.ts`, `tests/mini-release-recovery.test.ts`; upload success не final success.
- [ ] T063 [US4] Довести повне/mini/backend/recovery mutual exclusion та controller→worker continuation без self-conflict у `tests/mini-release-ownership.test.ts`; непридатний single-authority prerequisite → blocked.
- [ ] T064 [US4] Довести data preservation, old-client reading new rows, archive retention та next baseline після recovery у `tests/mini-release-database.test.ts`, `tests/mini-release-recovery.test.ts`.
- [ ] T065 [US4] Оновити authoritative recovery інструкції `docs/PRODUCTION.md`, `docs/BETA.md`, `specs/043-mini-release/quickstart.md`: exact artifacts, no automatic rollback, partial/unknown handling і окремий server forward-fix intent.

---

## Phase 7: User Story 5 — Agent-readable diagnosis (P2)

**Goal**: відрізняти кілька mini builds на одному агенті та доводити доставлений результат. **Independent Test**: два розгортання, mixed success/failure/missing signals; report/SELECT-only CLI відновлюють правильні identities та uncertainty. Обов’язково до production acceptance.

- [ ] T066 [P] [US5] Додати failing identity/outcome/privacy/missing-delayed-signal regressions у `tests/mini-release-diagnostics.test.ts` і `tests/mini-release-analytics.test.ts`.
- [ ] T067 [US5] Підключити єдину trusted web identity до `apps/web/src/analytics/service.ts`, `apps/web/src/support/diagnostics-bundle.ts`; release без VITE_WEB_BUILD_ID блокується, legacy observations не переписуються.
- [ ] T068 [US5] Реалізувати normalized stage/outcome/effect/latency/recovery projection у `scripts/lib/release/mini/diagnostics.mjs`, `scripts/release-runner.mjs`, `scripts/lib/release/metrics.mjs`, `scripts/lib/release/progress.mjs`; keep envelope, selected mode status і control-vs-user distinction.
- [ ] T069 [US5] Додати read-only deployment-receipt resolver та version-aware joins у `scripts/analytics/deployments.ts`, `scripts/analytics/investigate.ts`, `scripts/analytics/queries.ts`; backend request version без authoritative evidence лишається unknown/hypothesis, --as-of і lag зберігаються.
- [ ] T070 [US5] Оновити typed identity/sanitization/code-map seams у `scripts/analytics/types.ts`, `scripts/analytics/schema.ts`, `scripts/analytics/sanitize.ts`, `scripts/analytics/code-map.ts`; новий signal тільки через closed typed producer/guard, SELECT-only роль/guard незмінні.
- [ ] T071 [US5] Додати mini journey inventory/unsupported producers/safe fallback до `scripts/analytics/coverage-registry.ts`; критичний missing proof блокує readiness, відсутність реального трафіку не стає success чи технічною deployment failure.
- [ ] T072 [US5] Довести producer→sanitizer/transport→stored evidence→CLI plus read-only journal join у `tests/mini-release-analytics.test.ts`, `tests/analytics-code-map.test.ts`; missing identity, rejected/delayed terminal, wrong environment, secret canaries і expiry.
- [ ] T073 [US5] Документувати version-aware `investigate/inspect/cohorts/audit`, release report і honest unknowns у `docs/ANALYTICS_CLI.md`, `specs/043-mini-release/quickstart.md`; жодного ad-hoc SQL або production writer для diagnosis.

---

## Phase 8: Polish, acceptance and final verification

**Purpose**: звести всі stories і отримати чесний readiness verdict; local unit pass не замінює hosted/native/performance proof.

- [ ] T074 Створити acceptance harness `specs/043-mini-release/acceptance/run.mjs`: read-only inventory за замовчуванням, live execution тільки за bound authorized sandbox intent, evidence provenance та NOT_RUN/BLOCKED замість skip-as-pass.
- [ ] T075 Виконати E01–E24 і fault/role/data matrix на disposable/local sandbox та записати references у `specs/043-mini-release/acceptance/report.json`; scope mocks/native/hosted розрізняється.
- [ ] T076 Пройти macOS/Windows supported-agent matrix на незмінних proven packages і candidate web через `specs/043-mini-release/acceptance/run.mjs`; недоступна обов’язкова native cohort лишає BLOCKED із конкретною передумовою. Matrix finite/versioned за config/mini-release-support.json: current/oldest representatives; CSS reuse positive control, fresh native checks для changed seams, missing affected native proof BLOCKED.
- [ ] T077 На окремо дозволеній live sandbox цілі виконати щонайменше web-only, compatible backend/DB і interruption/recovery runs та provider/live-byte proofs у `specs/043-mini-release/acceptance/report.json`; production credentials не використовувати.
- [ ] T078 Виміряти 10 web+10 backend releases, recovery≤5m, freshness≤2m, diagnostics≤2m і active-work preservation через `specs/043-mini-release/acceptance/run.mjs`; усі failures/timeouts зберегти, resource estimates чинних classes звірити у `config/release-resource-profiles.json` без послаблення gates.
- [ ] T079 Звірити full-release/legacy deploy/backend/rollback non-regression й виконати relevant tests single-worker, `npm run verify`, `npm run verify:release` де є prerequisites; machine-readable results прив’язати до exact source snapshot у `specs/043-mini-release/acceptance/report.json`.
- [ ] T080 Перевірити activation відмови до ratification/policy/implementation/sandbox proofs і G0/042 GO у `tests/mini-release-activation.test.ts`; узгодити `docs/PRODUCTION.md`, `.specify/memory/constitution.md`, `AGENTS.md` без fabricated approvals.
- [ ] T081 Звести FR/AD/SC→task→evidence coverage та два незалежні reviews у `specs/043-mini-release/reviews/closure.md`; усунути всі реалізаційні findings, не оголошувати непроведений acceptance PASS.
- [ ] T082 Оновити `specs/043-mini-release/tasks.md` тільки за фактично виконаними tasks і опублікувати ready/blocked/insufficient verdict у `specs/043-mini-release/acceptance/report.json`; actual production release залишається окремою авторизованою дією.

---

## Dependencies & Execution Order

Setup T001–T005 → Foundation T006–T017 → story phases. US1 T018–T032; US2 T033–T047; US3 T048–T055; US4 T056–T065; US5 T066–T073; final T074–T082.

US1 потребує foundation плюс hard-rejection policy/impact/evidence isolation (T035, T049–T053) до будь-якого live demo. Тому US3 safety-core виконується одразу після foundation, до US1 activation; його повний adversarial acceptance T054–T055 може завершуватися після story wiring. US2 backend rehearsal можна реалізувати після foundation незалежно від web upload, combined release залежить від US1. US4 recovery залежить від зовнішніх observations US1/US2. US5 identity producer T025/T067 потрібний для candidate proof, final CLI diagnosis залежить від receipts. Жодна production story не shipping без completed safety/recovery/diagnostics prerequisites та acceptance.

Рекомендований порядок implementation: T001–T017 → T033–T035 → T048–T053 → T018–T027 → T029–T032 → T036–T047 → T028 → T054–T065 → T066–T082. T028 пишеться/перевіряється після backend adapter; для web-only його backend dependency not-applicable. T040 спершу додає failing interop regression, T041/T044 доводять його green; DB activation до green заборонена. У межах цієї послідовності tests T019 перед T020, T034 перед T039 та graph T048 перед T049. Це dependency graph, а не дозвіл завершувати незалежні runtime tasks у planning.

Для T016 profile selector чернетка policy T004 достатня; final impact-dependent admission додається T049–T052. Для T015 activation tests спочатку deny-by-default; positive ratification evidence тільки final acceptance. T009 використовує typed contracts T007 та selected registry T008. T011 завершується до будь-якого external-effect task.

## Parallel Examples

- US1: T018 web fixtures і T019 beta fixtures — різні файли після foundation; production writes не виконуються.
- US2: T033 SQL-policy fixtures і T034 disposable-DB test design — незалежні файли; actual heavy DB runs послідовні.
- US3: T048 impact fixtures можна писати паралельно з US2 policy fixtures; T049 implementation лише після T048.
- US4: T056 recovery fixtures після effect contracts можуть готуватися поруч із US5 diagnostic fixtures, без спільного runtime code edit.
- US5: T066 diagnostic fixtures незалежні від US4 test files; T067 producer та T069 CLI joins не редагують ті самі файли, але integration T072 чекає обох.

## Implementation Strategy

1. Foundation і deny-by-default safety-core перед live effects; dirty host tree зберігається, candidate isolated.
2. Web-only MVP демонструється на ізольованій цілі, без packaging, із actual packaged-agent candidate proof. Це не ранній production release без інших P1 guarantees.
3. Backend-only/combined changes додаються з bounded transaction executor та old/new/role proof; unknown scope блокується.
4. Recovery й diagnostics завершуються до integrated acceptance; shared target authority та current baselines перевіряються на кожному write path.
5. Локальні, native, hosted і timing результати зберігаються окремо; external prerequisites не створюються без authorization. Production mini activation лишається closed до всіх потрібних proofs.

## Review remediation dependencies

T005 isolation setup до candidate execution; T014 operator path після baseline discovery T013. T022 native-wrapper provenance й T023 finite matrix до runtime/reuse admission. T028 postbackend preview залежить від T045 backend apply та T027 prewrite proof. T040 ledger interoperability блокує DB activation. Це не optional polish: combined demo запускається лише з цими доказами. T074 harness default inventory; live запуск лише з explicit sandbox intent/scope.

## Requirements Coverage

| Requirement | Tasks                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| FR-001      | T007, T008, T009, T026, T045                                                                         |
| FR-002      | T008, T018, T024, T029, T031, T054                                                                   |
| FR-003      | T020, T021, T022, T023, T024, T025, T027, T067                                                       |
| FR-004      | T007, T009, T014, T026, T068                                                                         |
| FR-005      | T004, T035, T049, T050, T051, T052, T053, T054, T055                                                 |
| FR-006      | T012, T013, T037, T038, T049, T050                                                                   |
| FR-007      | T004, T035, T049, T050, T054                                                                         |
| FR-008      | T048, T049, T050, T054                                                                               |
| FR-009      | T023, T027, T028, T041, T042, T046, T064                                                             |
| FR-010      | T036, T037, T038, T039, T040, T043, T044, T055                                                       |
| FR-011      | T033, T034, T035, T039, T040, T041, T042                                                             |
| FR-012      | T033, T035, T039, T054                                                                               |
| FR-013      | T034, T035, T041, T042, T053                                                                         |
| FR-014      | T034, T041, T042, T045                                                                               |
| FR-015      | T016, T017, T027, T041, T042, T079                                                                   |
| FR-016      | T019, T020, T021, T022, T023, T027, T031, T051                                                       |
| FR-017      | T020, T023, T027, T051, T076                                                                         |
| FR-018      | T005, T024, T027, T028, T029, T030, T038, T053                                                       |
| FR-019      | T012, T020, T051, T078                                                                               |
| FR-020      | T005, T009, T010, T011, T014, T015, T026, T047, T059, T060                                           |
| FR-021      | T009, T043, T044, T056, T057, T058                                                                   |
| FR-022      | T010, T011, T047, T058, T063                                                                         |
| FR-023      | T030, T038, T042, T045, T068                                                                         |
| FR-024      | T024, T056, T059, T060, T061, T064                                                                   |
| FR-025      | T044, T056, T057, T058, T059, T060, T061, T062, T065                                                 |
| FR-026      | T046, T060, T064                                                                                     |
| FR-027      | T052, T068, T069, T070, T071, T072, T073                                                             |
| AD-001      | T007, T025, T028, T067, T068, T069                                                                   |
| AD-002      | T008, T009, T056, T057, T058, T068                                                                   |
| AD-003      | T030, T038, T044, T062, T069                                                                         |
| AD-004      | T068, T069, T070, T072, T073                                                                         |
| AD-005      | T003, T071, T074, T075, T076, T077, T081                                                             |
| AD-006      | T012, T053, T066, T070, T072                                                                         |
| AD-007      | T066, T072, T074, T075, T076, T077                                                                   |
| SC-001      | T018, T019, T020, T021, T022, T023, T024, T025, T026, T027, T028, T029, T030, T031, T032, T076, T077 |
| SC-002      | T016, T051, T074, T078                                                                               |
| SC-003      | T003, T033, T034, T035, T040, T048, T049, T050, T051, T052, T053, T054, T055, T074, T075             |
| SC-004      | T028, T034, T040, T041, T042, T043, T044, T045, T064, T075, T076, T077                               |
| SC-005      | T010, T011, T044, T056, T057, T058, T059, T060, T061, T062, T063, T064, T075, T076, T077             |
| SC-006      | T059, T060, T061, T064, T078                                                                         |
| SC-007      | T030, T032, T078                                                                                     |
| SC-008      | T066, T067, T068, T069, T070, T071, T072, T073, T074, T078                                           |

## Task Counts

82 tasks: setup 5, foundation 12, US1 15, US2 15, US3 8, US4 10, US5 8, final 9. Parallel opportunities — tests у різних файлах; heavy execution ніколи не parallel. Усі 27 FR, 7 AD та 8 buildable SC мають task coverage. Checkboxes стають completed тільки за фактичним виконанням implementation/acceptance, не після написання плану.
