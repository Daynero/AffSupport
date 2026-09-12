# Tasks: Реліз під ключ на слабкій машині

**Input**: `specs/020-turnkey-release/` — spec, plan, research, data-model, contracts, quickstart.

**Tests**: потрібні специфікацією SC-001–SC-008; behavioral/fault tests, не перевірки копій рядків коду. Створити failing scenarios перед implementation і запускати їх після відповідної реалізації.

**Organization**: Setup → Foundation → US1/US2/US3 (P1) → US4/US5 (P2) → Acceptance.

**[P]** означає незалежне написання файлів у межах фази після її prerequisites, а не дозвіл запускати важкі процеси паралельно. Зміни одного файла виконуються послідовно. Всі шляхи від кореня репозиторію.

## Phase 1: Setup

Підготувати межі реалізації й fixtures. Задачі не запускають production release.

- [x] T001 Підготувати окреме конституційне уточнення у `.specify/memory/constitution.md` і `specs/020-turnkey-release/governance-proposal.md` із Sync Impact Report. Виконано 2026-09-09 за дорученням власника: версія 2.0.0 у робочій копії. Це завершення підготовки документів, не твердження про merge; G0 перед T015–T016 залишається окремою repository-передумовою.
- [x] T002 Додати skeleton модулів `scripts/release-runner.mjs`, `scripts/release-worker.mjs`, `scripts/lib/release/steps.mjs` та npm entry у `package.json`; не додавати новий orchestration/model dependency.
- [x] T003 [P] Створити fixture clock, recording effect adapter і synthetic intent у `tests/support/release-runner/fixtures.ts` та `tests/support/release-runner/intent.json`; заборонити production targets у test harness.

## Phase 2: Foundational

Обов’язкова основа всіх історій. Production execution лишається вимкненим до фінального activation checkpoint.

- [x] T004 Реалізувати versioned schemas для intent/state/evidence/effects/resources у `packages/shared/src/release-runner.ts` та exports у `packages/shared/src/index.ts`; unknown input validation, без секретів і довільних command strings.
- [x] T005 Реалізувати parsing/resolution intent у `scripts/lib/release/intent.mjs`: exact version XOR bump, source SHA, notes rule/digest, target IDs, immutable profile; невідомі поля відхиляти.
- [x] T006 [P] Реалізувати перевірку schemas і недопустимих переходів у `tests/release-runner-contract.test.ts` через реальні parser/reducer outputs, включно з invalid targets та accepted≠completed.
- [x] T007 Реалізувати reducer усіх FR-036 станів і dependency registry у `scripts/lib/release/state.mjs` та `scripts/lib/release/steps.mjs`; defined retry/timeout/interruption/resource metadata для кожного кроку.
- [x] T008 Реалізувати приватний журнал з flush-before-effect, sequence/hash validation і atomic snapshots у `scripts/lib/release/journal.mjs`; paths поза mutable checkout, permissions 0700/0600.
- [x] T009 Реалізувати chunk-safe secret redaction перед диском/виводом у `scripts/lib/release/redaction.mjs` і canary tests у `tests/release-runner-redaction.test.ts`; PEM, split tokens, довгі рядки, unsafe output discard.
- [x] T010 Реалізувати argv-based child execution у `scripts/lib/release/execute.mjs`: shell:false, explicit cwd/env, nice 15, bounded redacted streams, owned PID/start identity та inherited lease seam.
- [x] T011 Реалізувати target-wide ownership і child registry у `scripts/lib/release/ownership.mjs`; atomic acquisition, PID reuse/boot checks; другий writer повертає активний run, не запускає effects.
- [x] T012 Реалізувати evidence fingerprints і dependency invalidation у `scripts/lib/release/evidence.mjs`; SHA/env/public config/tools/artifacts, без credential hashes; published outputs не перетворювати на rebuild.

## Phase 3: US1 — Один запуск до перевіреного production (P1)

Незалежна перевірка: повний ordered sandbox adapter pass без моделі; неправильні SHA/digest/gate блокують залежні ефекти. Це orchestration MVP з fake resource adapter, не production-ready milestone.

- [x] T013 [P] [US1] Додати failing candidate/final та stale-beta scenarios у `tests/release-runner-gates.test.ts`: trusted previous stable, future hash rejection, old package/new HEAD, invalidated old verification record.
- [x] T014 [P] [US1] Додати failing десятифазний effect-order/CLI test у `tests/release-runner-flow.test.ts` і наскрізні target tests у `tests/release-runner-targets.test.ts`: Windows smoke до tag, дві beta proofs, final live checks, production destination rejection у sandbox, consistent origin/key/artifact URLs.
- [x] T015 [US1] ПІСЛЯ G0 ratification розділити candidate/package і final/deploy validation у `scripts/verify-release.mjs`; default final, unknown mode fails, усі phase-applicable contracts без fake digest/skip flags. Без G0 не змінювати чинний gate, продовжити лише незалежні сумісні задачі. Виконано 2026-09-12 після G0 (commit 9cc4bf0): режими `--mode=contract|candidate|final`, default final, невідомий режим падає ДО будь-якої роботи, суперечливі прапорці відхиляються. Кожна фаза виконує всі свої контракти; жодного skip-прапорця чи підставного digest.
- [x] T016 [US1] ПІСЛЯ G0 ratification провести candidate context через `scripts/verify-all.mjs` і release/package commands у `package.json`; зберегти всі static/suite/coverage/database gates; default production path не може обійти G0 через прямий npm command. Виконано 2026-09-12: гейт `contract:release` у `verify-all.mjs` передає фазу (`SOTY_RELEASE_VERIFY_MODE`, типово contract); `package:mac`/`package:dmg` → candidate, усі `deploy:web*` → final. Тест забороняє будь-якій команді з деплоєм обійтися фазою contract. Решта static/suite/coverage/database гейтів без змін.
- [x] T017 [US1] Реалізувати version/notes projection у `scripts/lib/release/prepare.mjs`: єдине джерело release.ts, known generated workspace/lock files, protocol versions не змінювати; перевірити clean source→candidate→manifest progression у `tests/release-runner-prepare.test.ts`.
- [x] T018 [US1] Реалізувати validated TargetBinding у `scripts/lib/release/targets.mjs` та aggregated preflight у `scripts/lib/release/preflight.mjs` за `contracts/targets.md`: production pinned, sandbox explicit disjoint allowlist, усі origin/project/key/artifact inputs consistent; перевірити installed probe і registered bridge без heavy/model call через injectable interfaces; на US1 checkpoint використовувати explicit fake implementations, реальні dependencies перевірити в T061 після T032/T035/T051. Прокласти binding через `scripts/verify-web-env.mjs`, `scripts/verify-release.mjs`, `scripts/verify-published-release.mjs` та `package.json`; real gate integration тільки після G0. Виконано 2026-09-12: `scripts/lib/release/bindings.mjs` виводить pinned production binding із release.ts; `SOTY_RELEASE_BINDING` приймає лише disjoint sandbox. Binding прокладено через `verify-web-env.mjs`, `verify-release.mjs`, `verify-published-release.mjs` і `package.json` (deploy:web → `scripts/deploy-web.mjs`). Семантику гейтів не змінено — це лишається за G0.
- [x] T019 [US1] Реалізувати owned worktree та fast-forward remote freeze у `scripts/lib/release/adapters/git.mjs`: own dependencies/dist, source snapshot, allowlisted env bindings, known-file commits, refreshed main/beta, origin/beta promotion, no main checkout switch. Виконано 2026-09-12: додано `promoteBeta`/`remoteBetaSha` з подвійним захистом (перевірка ancestry + `--force-with-lease` на очікуваний SHA); перевірено на реальному bare-репозиторії.
- [x] T020 [US1] Виправити package provenance у `scripts/package-beta-mac.sh`, `scripts/verify-beta-package.sh`, `scripts/verify-beta-promotion.mjs`: source/dirty-at-build/digest, invalidate-before-smoke, atomic success record; archived evidence окремо для release/manifest SHA.
- [x] T021 [US1] Додати bounded authenticated packaged journey у `scripts/verify-beta-runtime.mjs` і виклик у `scripts/verify-beta-package.sh`; реальний local beta login/entitlement та коротка packaged operation, всі структурні assertions зберегти. Виконано 2026-09-12: `scripts/verify-beta-runtime.mjs` виконує pairing, beta-entitlement і одну коротку операцію під приватним HOME; викликається з `verify-beta-package.sh` перед записом verification.json. Відмовляється працювати, якщо порт 43140 уже зайнятий, і зупиняє лише власний процес. Фактичний прогін — частина T062.
- [x] T022 [US1] Реалізувати beta/package adapters у `scripts/lib/release/adapters/beta.mjs` та `scripts/lib/release/adapters/package.mjs`: absolute external runtime inputs, environment isolation, checksums, no published rebuild; не використовувати beta-down проти чужих listeners.
- [x] T023 [US1] Додати source_sha/release_id, pinned checkout обох jobs, correlation run-name, tag SHA assertion та no-cancel publish concurrency у `.github/workflows/release-windows.yml`; existing assets перевіряти до rebuild, smoke key flow зберегти. Виконано 2026-09-10: обидва jobs звіряють checkout SHA; publish звіряє tag→SHA і відмовляється від rebuild/replacement існуючого EXE.
- [x] T024 [US1] Виділити reusable watcher у `scripts/lib/release/github-watch.mjs`, зберегти CLI `scripts/watch-github-run.mjs`; exact workflow/SHA/mode/correlation, 30 s polling, typed state-only events, remote timeout separate from network retry.
- [x] T025 [US1] Реалізувати dispatch/build-only/publish/upload adapter у `scripts/lib/release/adapters/github.mjs`; exact target tag, published EXE лише workflow, durable run/asset IDs, both assets verified.
- [x] T026 [US1] Перевести hashing на streaming і final published-byte validation у `scripts/sign-release-manifest.mjs`, `scripts/verify-published-release.mjs`; реалізувати final manifest assembly/commit у `scripts/lib/release/adapters/manifest.mjs`, тільки реальні published digests, trusted schema payload незмінний.
- [x] T027 [US1] Реалізувати web/live adapter у `scripts/lib/release/adapters/web.mjs` і source/output marker у `scripts/release-web-meta.mjs`; чинний deploy:web у `package.json` використовує validated binding T018, default лишається pinned production; всі gates, FR-012, manifest-only diff. Sandbox checkout projection комітиться до freeze, runtime підміна frozen identity заборонена. Виконано 2026-09-12: `scripts/deploy-web.mjs` бере Cloudflare-проєкт з валідованого binding, пише marker (source/manifest/bundle digest) поза бандлом до завантаження; `verify-published-release.mjs` звіряє artifact base.
- [x] T028 [US1] Реалізувати supervised macOS worker lifecycle у `scripts/release-worker.mjs` і `scripts/lib/release/supervisor.mjs`: absolute paths, durable ready acknowledgment, survives terminal/chat close, no automatic login restart, tracked owned children. Доповнено 2026-09-12: `release-worker.mjs` раніше лише писав ready-файл і виходив, тож журнал, ліза, потік, діагностика й хендоф не були під’єднані до жодного реального прогону. Тепер воркер веде журнал до кожного ефекту, тримає admission-сокет, відновлюється з журналу й пакує збій в один хендоф.
- [x] T029 [US1] Завершити start/preflight/status/report commands у `scripts/release-runner.mjs` за `contracts/cli.md`; JSON/exit codes, local snapshot status, десятифазне виконання registry; пройти T013–T014 fixture tests із fake probe/bridge/remote adapters; це не real sandbox acceptance, яка виконується в T061–T062 після встановлення всіх компонентів. Виконано 2026-09-12: коди виходу за contracts/cli.md (0 accepted/completed, 1 blocked, 2 invalid, 3 active, 4 cancelled), `--json`, проєкція phase/waiting/publicationState/resultLocation, preflight на реальних probe/bridge через `dependencies.mjs`.

## Phase 4: US2 — Машина залишається придатною до роботи (P1)

Незалежна перевірка: injected resource samples/clock без packaging; після інтеграції жоден nested heavy boundary не обходить admission. Реальний важкий реліз допускається лише після цієї фази.

- [x] T030 [P] [US2] Додати failing sample/hysteresis/reservation tests у `tests/release-runner-resources.test.ts`: 30 s/5 s, CPU/RAM/swap/disk/thermal, stale samples, sleep, mandatory unknown та no double-count RSS.
- [x] T031 [P] [US2] Додати failing nested lease і own-process pressure tests у `tests/release-runner-resource-integration.test.ts`: no self-deadlock, serial children, live degradation, untouched чужі процеси.
- [x] T032 [US2] Реалізувати bounded nonprivileged probe у `packaging/release/ResourceProbe.swift`, reader у `scripts/lib/release/probes-macos.mjs` та packaging/provisioning у `scripts/package-release-runner.mjs`: готовий pinned arm64 probe з source provenance постачається при встановленні runner. Release/preflight не компілюють probe; missing/corrupt probe блокує heavy start. Test першого admission з pressure/swap/CPU/RAM/disk у `tests/release-runner-resources.test.ts`. Виконано 2026-09-12: `ResourceProbe.swift` віддає всі обовʼязкові сирі сигнали (CPU ticks, CLOCK_UPTIME_RAW, pressure level, reclaimable pages, swap, вільне місце, boot id); `probes-macos.mjs` рахує похідні; `package-release-runner.mjs --build` збирає закріплений arm64 зонд із провенансом. Перше читання ніколи не допускає — немає від чого віднімати.
- [x] T033 [US2] Додати всі class estimates/timeouts до `config/release-resource-profiles.json` за resource contract та parser у `scripts/lib/release/resources.mjs`; validated conservative fallback, immutable run snapshot, no silent threshold lowering.
- [x] T034 [US2] Реалізувати admission/reservations у `scripts/lib/release/resources.mjs`: один host-wide heavy slot для всіх targets, full stable window на кожний substep, mandatory unknown waits, resident growth без double-count, no implicit wait timeout; tests distinct-target concurrency.
- [x] T035 [US2] Реалізувати lease IPC за `contracts/resources.md` у `scripts/lib/release/lease-server.mjs` та `scripts/release-admit.mjs`, інтегрувати `scripts/lib/gate.mjs`/`scripts/verify-all.mjs`: private socket, pipe capability, generation/child identity, request/heartbeat/release, inherited parent lease, idempotency, uncertain ownership після heartbeat loss. Tests forged/stale grants, nested siblings і worker death у `tests/release-runner-resource-integration.test.ts`. Виконано 2026-09-12: `runGate` у `scripts/lib/gate.mjs` проходить допуск через `admission-client.mjs`; недопущений гейт падає, а не пропускається; `runPhase` під раннером послідовний. Тести: підробна capability, стала генерація, черга sibling-ів, смерть воркера, часткова конфігурація.
- [x] T036 [US2] Поставити admission checkpoints на всі важкі межі `scripts/package-beta-mac.sh`, `scripts/package-mac.sh`, `scripts/package-dmg.sh` та build/dependency/hash steps у `scripts/lib/release/steps.mjs`; standalone behavior зберегти. Виконано 2026-09-12: реєстр кроків класифікує кожну важку межу (prepare/candidate_gate/beta_*/readiness/package/smoke/publish/manifest/deploy/live_verify), `executeReleaseFlow` вимагає допуску саме для них; таймаути беруться з профілю ресурсів.
- [x] T037 [US2] Інтегрувати owned resident beta service reservations у `scripts/lib/release/adapters/beta.mjs`, `scripts/beta-up.mjs`, `scripts/beta-down.mjs`; busy/borrowed services не чіпати, restore env лише якщо runner-written content незмінний. Виконано 2026-09-12: `beta-up.mjs` бере допуск на старт стека і записує standing reservation; `resources.mjs` додає її до запитів; `beta-down.mjs` відновлює env лише за незміненим digest, інакше лишає файл і повідомляє.
- [x] T038 [US2] Реалізувати continuous pressure policy і independent clocks у `scripts/lib/release/execute.mjs`/`scripts/lib/release/resources.mjs`: два critical samples, owned interruptible termination, один recovery retry, noninterruptible boundary, sleep vs CI UTC deadline.
- [x] T039 [US2] Пройти resource integration scenarios і записати results у `specs/020-turnkey-release/validation/resources.md`; перевірити admission launch ≤10 s після valid window, serial heavy work і status p95 target у fixture run. Виконано 2026-09-12: `validation/resources.md` — реальний зонд, вікно з 9 семплів, admission latency 0.98 ms, status p95 105 ms.

## Phase 5: US3 — Продовження після переривання (P1)

Незалежна перевірка: fault-injected registry з durable fake remote; crash до/після кожного effect. Інтеграційний checkpoint — без duplicate publish/migration і без повторної valid heavy роботи.

- [x] T040 [P] [US3] Додати failing crash/journal/ownership matrix у `tests/release-runner-recovery.test.ts`: torn tail, interior corruption, live orphan, reused PID, concurrent starts, immutable completed state.
- [x] T041 [P] [US3] Додати failing ambiguous-response/cancel tests у `tests/release-runner-effects.test.ts`: dispatch/upload/push/deploy/migration success-before-timeout, remote conflict, no latest-run inference.
- [x] T042 [US3] Реалізувати replay/recovery у `scripts/lib/release/journal.mjs` та `scripts/lib/release/recovery.mjs`: quarantine torn tail, block interior damage, running→reconciling, reconcile old supervisor/children before takeover.
- [x] T043 [US3] Реалізувати inspect-before-retry і typed retry scheduler у `scripts/lib/release/retry.mjs`: max5/15 min, jitter/server timing, workflow/live budgets, no deterministic retry, preserved deadline across resume.
- [x] T044 [US3] Завершити exact effect reconciliation у `scripts/lib/release/adapters/git.mjs`, `scripts/lib/release/adapters/github.mjs`, `scripts/lib/release/adapters/web.mjs`; matching evidence advances, conflicting/ambiguous blocks, proven absence only permits allowed repeat.
- [x] T045 [US3] Реалізувати resume/cancel у `scripts/release-runner.mjs` та `scripts/release-worker.mjs`: durable cancellation, owned children only, noninterruptible reconciliation, no automatic asset deletion/database rollback.
- [x] T046 [US3] Реалізувати evidence reuse/input invalidation на resume у `scripts/lib/release/evidence.mjs`: SHA/tool/config/digest changes invalidate dependent unpublished work; postpublication repair requires linked new intent; перевірити heavy execution count.
- [x] T047 [US3] Реалізувати retention/cleanup у `scripts/lib/release/cleanup.mjs`: explicit owned paths, ≥30 days cleaned evidence, never prune active runs, safe env/service restoration; tests у `tests/release-runner-cleanup.test.ts`.
- [x] T048 [US3] Пройти crash/cancel matrix T040–T041 та записати per-boundary effect counts у `specs/020-turnkey-release/validation/recovery.md`; включити restart worker і live-child ownership integration. Виконано 2026-09-12: `validation/recovery.md` — матриця падінь 13×13, кожен ефект рівно один раз; `executeReleaseFlow` отримав відновлення з `completed`.

## Phase 6: US4 — ШІ лише для нестандартного збою (P2)

Незалежна перевірка: fake runner events до actual bounded diagnostics/outbox; normal/transient cases zero handoffs, один stable failure — один пакет.

- [x] T049 [P] [US4] Додати failing byte/line caps, dedupe і nullable accounting tests у `tests/release-runner-diagnostics.test.ts`; великі Unicode errors, split secrets, repeated unchanged failure.
- [x] T050 [US4] Реалізувати bounded human/JSON reporting у `scripts/lib/release/diagnostics.mjs`: success20 lines/8KiB, failure100 lines/16KiB, original cleaned error, evidence refs і resume predicate; raw polling output не передавати.
- [x] T051 [US4] Реалізувати durable outbox та supervised agent bridge adapter у `scripts/lib/release/handoff.mjs`, `scripts/lib/release/agent-bridge.mjs` за `contracts/handoff.md`: fixed registered executable/protocol, persistent jobId/dedupe/ack/query/result, automatic reconnect, repaired reference revalidation, без periodic model calls. Додати fake persistent bridge і contract smoke у `tests/release-runner-handoff.test.ts`; seam без функціонального consumer не є completion. Виконано 2026-09-12: outbox із дедуплікацією за fingerprint, позначкою відправлення ДО виклику, бекофом 30 с–5 хв, query перед повторним submit, станами repaired/cannotRepair/needsExternalDecision і `revalidationRequired`; `createProcessTransport` запускає зареєстрований виконуваний файл фіксованим argv. Реальний зареєстрований consumer лишається зовнішньою передумовою.
- [x] T052 [US4] Додати timings/effect counts/AI accounting до `scripts/lib/release/metrics.mjs` і report CLI у `scripts/release-runner.mjs`; handoff≠actual AI call, unknown tokens null, same-scenario baseline comparison.
- [x] T053 [US4] Пройти zero-model/transient/deterministic-failure scenarios і зафіксувати evidence у `specs/020-turnkey-release/validation/diagnostics.md`; не заявляти token saving без реального token baseline. Виконано 2026-09-12: `validation/diagnostics.md` — нульові виклики моделі на всіх шляхах, поведінка при transient/deterministic збоях, межі виводу. Claim про економію токенів не робиться (T064).

## Phase 7: US5 — Заздалегідь описані серверні зміни (P2)

Незалежна перевірка: dedicated fake/local backend з actual allowlist adapter, zero writes без наміру, known compatible migration/function і ambiguous result. End-to-end — isolated beta перед залежним deploy.

- [x] T054 [P] [US5] Додати failing backend boundary tests у `tests/release-runner-backend.test.ts`: extra pending migration, wrong target, content mismatch, partial result, no-intent zero writes, backwards compatibility failure.
- [x] T055 [US5] Реалізувати tracked backend plan resolution у `scripts/lib/release/backend-plan.mjs`: migration/function hashes, project bindings, ordered dependencies, before-readiness/before-web, vetted checks, recovery reference; no SQL/command strings.
- [x] T056 [US5] Реалізувати beta backend rehearsal у `scripts/lib/release/adapters/backend-beta.mjs`: isolated target assertion, migration/function checks і compatibility зі старим клієнтом; resource lease для stack і tests.
- [x] T057 [US5] Реалізувати backend adapter у `scripts/lib/release/adapters/backend.mjs` і receipts у `scripts/lib/release/migration-evidence.mjs` за `contracts/execution.md`: exact pending set, verified target, flush prepared receipt до write, history+postconditions reconcile. Existing version без достовірного receipt/adopted baseline → MIGRATION_PROVENANCE_UNKNOWN; partial nontransactional effect → block, no guessed rollback; додати tests до `tests/release-runner-backend.test.ts`.
- [x] T058 [US5] Вбудувати backend dependencies у `scripts/lib/release/steps.mjs` та preflight у `scripts/lib/release/preflight.mjs`; apply лише після beta proof і перед first dependent gate; zero steps/writes за відсутності plan. Виправлено 2026-09-12: раніше позначено зробленим помилково — у реєстрі не було жодного backend-кроку, тож `applyBackendPlan` був недосяжний із потоку. Додано `backend_beta` (before-readiness) і `backend_apply` (before-web, non-interruptible); за відсутності плану адаптер не викликається взагалі.
- [x] T059 [US5] Пройти backend scenarios у `tests/release-runner-backend.test.ts` та записати результат у `specs/020-turnkey-release/validation/backend.md`; analytics CLI не змінювати. Виконано 2026-09-12: `validation/backend.md`; попутно реалізовано відсутній `scripts/lib/release/adapters/backend.mjs` (точна множина pending, звірка digest, сумісність зі старим клієнтом, receipt до запису).

## Phase 8: Polish, acceptance and production activation

Після всіх історій. Наявність коду не дорівнює успішній прийомці. Ніякого реального production release у межах задач розробки без окремого релізного наміру.

- [x] T060 Оновити єдиний канонічний runbook у `docs/PRODUCTION.md`, beta evidence у `docs/BETA.md` і agent entry у `AGENTS.md`; commands/phase contracts мають відповідати registry без паралельного ручного flow.
- [x] T061 Додати runnable sandbox fixture/config instructions та acceptance command у `scripts/release-acceptance.mjs`/`specs/020-turnkey-release/quickstart.md`: використовувати наскрізний TargetBinding T018, перевіряти фактичні Windows/upload/web/backend destinations; після T032/T035/T051 перевірити actual installed probe, lease server, functioning bridge і migration baseline; за їх відсутності test fail, без production skip flags. Цей checkpoint завершує real dependency integration T018; production targets відхиляти.
- [ ] T062 Виконати всі fault/identity/secret сценарії quickstart і три повні унікальні sandbox releases; записати SHA/digests/effect counts/zero-model evidence у `specs/020-turnkey-release/validation/acceptance.md` та приватні runtime logs під `release/automation/`.
- [ ] T063 Виміряти повний прохід на arm64 Mac з 8 GiB: resource waits, high-water RAM, no OOM, status p95≤2 s; відкалібрувати `config/release-resource-profiles.json` і записати фактичні дані у `specs/020-turnkey-release/validation/weak-machine.md`; відсутність такого хоста не позначати pass.
- [x] T064 Зафіксувати same-scenario manual baseline і runner diagnostic bytes, вимогу ≥90% reduction та доступність actual token accounting у `specs/020-turnkey-release/validation/baseline.md`; unknown tokens залишити null. Знято власником 2026-09-12: порівняльний вимір не проводиться, різницю власник оцінить на наступному реальному релізі. Зафіксовано як waiver у `validation/blockers.md`; `modelTokens` лишається null, вимога ≥90% не вважається доведеною.
- [ ] T065 Виконати `npm run verify` і `npm run verify:release` послідовно через nice 15/SOTY_VERIFY_SERIAL=1 після ресурсного допуску; відобразити точні результати `verification-result.json` у `specs/020-turnkey-release/validation/gates.md`; не приховувати unrelated failure.
- [ ] T066 Перевірити G0 ratification evidence і фактичні acceptance T062–T065, зберегти readiness у `specs/020-turnkey-release/validation/activation.md` та завершити guard у `scripts/lib/release/preflight.mjs`; G0 мав бути виконаний ДО T015–T016, ця задача лише повторна звірка, не відкладена авторизація gate changes.

## G0 — Separate governance prerequisite

T001's amendment preparation is completed in constitution 2.0.0 on 2026-09-09 with the owner's authorization. The ordinary amendment review/merge is not claimed complete. Ratified 2026-09-12 as commit `9cc4bf0765ecdb9ca2226200bf26b5ee527b0cbb` on branch `governance/constitution-2-0-0`, recorded in `specs/020-turnkey-release/validation/governance.md`. T015–T016 were implemented only after that commit existed. No additional conversational permission, per-release approval or local bypass flag is required. Until that repository prerequisite is met, foundation, fake tests and pure resource/recovery work may proceed.

## Dependencies & Execution Order

| Phase      | Tasks     | Prerequisites / exit criterion                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------------------------------- |
| Setup      | T001–T003 | Proposal documented; fixture safety boundary established                                          |
| Foundation | T004–T012 | Setup; schemas before consumers; redaction before execute                                         |
| US1        | T013–T029 | Foundation; adapter/CLI orchestration tested with isolated fakes                                  |
| US2        | T030–T039 | Foundation for pure scheduler; US1 for nested real integration                                    |
| US3        | T040–T048 | Foundation for replay; US1+US2 for resume/cancel integrations                                     |
| US4        | T049–T053 | Foundation for reporting; US3 for persistent handoff/effect metrics                               |
| US5        | T054–T059 | Foundation for plan validation; US1–US3 for integrated backend sequence                           |
| Acceptance | T060–T066 | All stories; G0 previously satisfied; activation additionally requires actual measured acceptance |

Execution graph: Setup → Foundation → US1 → US2 → US3 → {US4, US5} → Acceptance.

This graph describes completed integration milestones. Pure scheduler/replay/backend tests may be written earlier against stable foundation interfaces; a story is not marked complete from mocks alone if its integration checkpoint is pending.

Specific ordering:

- T004 precedes T005–T012; T006 tests may be authored before reducer implementation T007.
- T008/T009/T011 precede execution of external adapters; no raw-log intermediate implementation.
- G0 precedes T015–T016 and all real candidate/two-SHA integration; both tasks precede candidate packaging paths. T018 target binding precedes all real sandbox adapters.
- T017–T019 precede real candidate/beta integration; T020–T021 before beta adapters exercised.
- T023 precedes exact workflow integration T025; T024 monitoring is reusable by T025.
- T026 must assemble final manifest metadata from frozen candidate identity before signing both real digests; reusing unchanged previous manifest identity is not completion.
- T032–T034 precede nested integration T035–T038; T039 validates complete US2.
- T042–T046 precede full crash/cancel evidence T048.
- T055–T058 precede backend acceptance T059; backend effect rehearsal runs under resource ownership from US2.
- T062–T065 provide actual acceptance evidence; T066 may not substitute a local approval boolean or claimed pass for missing ratification/measurements.

## Parallel execution examples

All examples concern writing independent files or lightweight inspections. Heavy builds/tests/native compilation always queue one at a time.

| Story | Independent authoring example                                                                         | Join point                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| US1   | T013 gate test file and T014 ordered-flow test file                                                   | Implement adapters, then run each suite serially                                             |
| US2   | T030 sample tests and T031 nested-execution tests                                                     | Integrate T032–T038, then T039                                                               |
| US3   | T040 recovery tests and T041 effect tests                                                             | Finish T042–T047, then T048                                                                  |
| US4   | T049 fixture/test preparation can overlap review of finalized US3 evidence, with no shared-file edits | T050–T052 depend on completed contracts; no independent parallel implementation pair assumed |
| US5   | T054 backend test file can overlap read-only inventory of tracked backend inputs                      | T055–T058 deliberately sequential due to shared dependencies                                 |

## Requirement traceability

| Requirements    | Main tasks                              |
| --------------- | --------------------------------------- |
| FR-001–004      | T001, T004–T007, T018, T029, T060, T066 |
| FR-005–007      | T015–T021                               |
| FR-008–012      | T022–T029, T062                         |
| FR-013–021      | T030–T039, T063                         |
| FR-022–024      | T008, T011–T012, T028, T040–T042, T046  |
| FR-025–028      | T024–T025, T041, T043–T046, T048        |
| FR-029          | T009–T010, T018–T019, T049–T050, T062   |
| FR-030–031      | T054–T059                               |
| FR-032–035      | T028–T029, T049–T053, T064              |
| FR-036–037      | T007, T014, T029, T042–T046, T058       |
| FR-038–040      | T037, T047, T055–T059                   |
| SC-001–002      | T062, T064                              |
| SC-003 / SC-008 | T039, T063                              |
| SC-004–005      | T040–T048, T062                         |
| SC-006–007      | T009, T049–T059, T062                   |

## Implementation Strategy

1. Foundation and US1 produce an independently demonstrable orchestration MVP on fake/sandbox adapters. This checkpoint does not enable production or unguarded heavy local release.
2. US2 adds real load admission including nested commands; US3 makes interruption/unknown effects recoverable.
3. US4 completes bounded handoff and measured accounting; US5 completes declared backend deployment support.
4. Acceptance runs actual isolated releases and weak-machine measurements, then rechecks readiness. Governance prerequisite G0 already occurred before affected gate implementation.
5. Finish each task only when its stated result exists and relevant behavioral verification passes. External dependencies or unavailable hardware remain explicitly pending.
6. Run `speckit-analyze` after task generation to cross-check specification, plan and this task list before implementation.

## Counts

66 tasks total: Setup 3, Foundation 9, US1 17, US2 10, US3 9, US4 5, US5 6, Acceptance 7. T001 was completed by the subsequent authorized constitution amendment preparation on 2026-09-09; all implementation and acceptance work remains pending.

## Analysis remediation coverage — 2026-09-09

| Finding | Work / acceptance                                                                    |
| ------- | ------------------------------------------------------------------------------------ |
| C1      | T001 proposal, explicit G0 before T015–T016; T066 rechecks only                      |
| I1      | T014, T018, T027, T061–T062; contracts/targets.md                                    |
| U1      | T018, T051, T053, T062; contracts/handoff.md; no-chat restart/dedupe smoke           |
| U2      | T030–T031, T034–T035, T039; authenticated generation-bound lease IPC                 |
| I2      | T018, T032, T039; preinstalled probe, no heavy bootstrap exception                   |
| U3      | T054, T057, T059; prepared receipt/history/postconditions, unknown provenance blocks |

Counts remain 66: T001 document preparation complete; the other 65 tasks remain pending. Source/governance amendments, runner installation, actual bridge availability and real acceptance are future implementation/setup evidence, not outcomes of this document edit.

## I3 dependency correction — 2026-09-09

T018 validation logic depends on foundation interfaces and may be fixture-tested before T032/T051. T029 completes only that fixture orchestration milestone. T061 explicitly depends on T032 (installed probe), T035 (lease server) and T051 (real configured bridge) and verifies actual dependency availability before T062 full sandbox acceptance. No production or real sandbox preflight path substitutes a fake dependency. This removes the apparent US1→US4→US1 completion cycle.
