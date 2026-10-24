> **Current scope decision — 2026-10-24:** 036 is CLOSED for completed local implementation and verification. Remaining substantial acceptance obligations are OPEN in [042 Production Readiness](../042-production-readiness/spec.md), with exact mapping in [scope-transfer.json](scope-transfer.json). See [closure.md](closure.md). Earlier full-campaign requirements and NO_GO checkpoints below are retained as historical requirements/evidence for 042; no production GO or test PASS is inferred from this scope change.

### Current full local verification — 2026-10-24 13:04Z

Fresh `npm run verify:release` PASS: 22/22 gates, 7,374 passed tests and 41 explicitly skipped tests, 81.38% line coverage. All 3,134 input paths and bytes stayed unchanged during the 33m37s run. All eight shard reports are valid; all 843 test files have exactly one COLLECT/START/END. A separate completed-log lifecycle check passed 106 tests. Proof: `release/acceptance/acceptance-036-fresh-20261021/drive-followup/t180-current-full-release-proof.json`. This supersedes earlier local canonical failures, without rewriting their historical evidence.

Real two-user reconnect follow-up passed: B committed an owned folder while A was offline; A received it automatically after reconnect, then both observed cleanup. No precise latency claim. Proof: `drive-followup/two-user-reconnect-20261024.json`. This is scoped evidence, not complete managed fault acceptance.

Task accounting remains 99/182 closed, 83 open; full036 remains NO_GO. Hosted discovery found only the production project, which is excluded from testing; a separate hosted test-project configuration is still needed. Packaged acceptance and remaining isolated runtime/fault/load/adoption/backup work remain open. Native Windows remains owner-excluded. These report updates were made after the frozen verification run.

> Current implementation checkpoint:99/182tasks closed,83open. T099 focused execution milestone covers12explicit scopes across21–24October, without current-candidate adoption or original-case PASS. T175/T176 and applicable T173 remain complete. Native Windows is owner-excluded. Refresh the implementation order by prerequisites: retain T178 partial foundation → T180 explicit SQL/Auth/Functions/management binding → T181 isolated runtime/owned-lease groundwork → remaining T178 live fault consumers → T179 workloads/probes → T177 adoption/publication → T182 backup drill, then remaining live cases and final gates. The clock overlay is backend-global and native recovery claims team-wide work: do not run far-clock/crash faults on the retained owner beta merely because a namespace/descriptor is owned. Hosted configuration remains requested/unverified; no production fallback or paid resource is authorized. Current official suite exceeded its45minute budget; continuation found bundle limits now fixed by targeted checks. Fresh whole-candidate verification is still required.

> Рішення власника 2026-10-23: продовжувати до завершення всього доступного обсягу; нативну перевірку Windows виключено через відсутність реального пристрою. Канон виключення — [acceptance-policy.json](acceptance-policy.json), scope `native-windows-runtime`, case REG-017 і лише Windows-частини T059/T173. Це не PASS і не доказ Windows-сумісності. Unit/contract/build перевірки підтримуваних платформ та macOS multi-device залишаються обов’язковими. Інші зовнішні передумови й невиконані перевірки зберігають власний статус.

> Поточний пріоритет (оновлено 2026-10-22): автономно перевіряти все доступне. Вікно вибору тарифу оновлене, перевірене й прийняте власником; його дизайн і copy не змінювати. Бізнес-логіка тарифів лишається у scope. Drive-робота лише всередині підключеної папки; оригінали не змінювати/не видаляти, прибирати лише власні QA-дані. [two-user-focus.md](two-user-focus.md) — focused evidence, [owner-ui-checklist.md](owner-ui-checklist.md) — необов’язковий короткий огляд. Історичні 174 кейси не перетворювати на PASS/N/A; зовнішні блокери явні.

### Live beta clock integration — 2026-10-23 18:12Z

Retained beta is now schema361. Guarded incremental local application preserved tariff rows, Launch defaults, cleanup coverage, Drive binding, profile and pairing. Current runtime instance52791090-93a4-4e3c-8705-8094962cb01e; source/calendar CLI dependencies synchronized from static-validated ROOT files. Seventh controlled restart passed preservation checks. Production unchanged.

Actual CLI set/TTL/clear/repeated clear PASS with a1second overlay using the current instant: tariff day and rows unchanged; expiry fell back to real time and final overlay removal confirmed. Initial harness SQL-alias failure and missing W CLI dependencies were diagnosed before any set and corrected; retained first failure is private. Native far-shifted notice proof passed948pgTAP+29native tests; root test merged and all-test typesPASS. Chrome real-calendar smoke shows19November matching authenticated server endsOn2026-11-19/tariffToday2026-10-23, with connected Drive and agent. Owned tab closed; owner's tabs untouched. This is not far-shifted physical UI proof. T011/T012 remain open for remaining boundary acceptance; full ROOT canonical remainsFAIL from the unrelated30second setup timeout, despite unchanged6test rerunPASS.

Proofs: `t012-local-361-apply.json`, `ui-restart-seventh-20261023.json`, `t011-live-clock-cli-proof.json`, `t011-live-calendar-rpc.json`, `t011-live-calendar-ui.json`, `t011-native-notice-overlay-proof.json`.

### Current verification checkpoint — 2026-10-23 14:43Z

ROOT now contains the361st tariff-clock migration and31 selectively merged source/test files; retained beta remains schema360 with original profile, pairing and Drive preserved. Merged focused185tests/11filesPASS. The full ROOT `npm run verify` completed with13static gatesPASS, then suiteFAIL: `task-diagnostics.test.ts` beforeAll exceeded30s in shard2. All3099 input paths and bytes remained unchanged. Shards1/2 retain862+873passing tests; this is partial evidence, not a whole-suite PASS. An unchanged isolated rerun of task-diagnostics passed6tests in7.22s. Resource contention is a hypothesis, not a proven root cause; no further timeout change was made.

NEXT's previous complete disposable database run passed948pgTAP/39files plus28native tests and removed owned resources. A new native notice-overlay case is now running separately and is not yet counted. T011/T012 remain open for actual guarded CLI, overlay notice proof and physical UI effective-date agreement. Next order: finish native notice proof; reconcile merged source and docs; guarded preserve-profile local acceptance when it will not disrupt the owner's UI session; current full/release gates and whole-suite lifecycle reconciliation. Hosted load, Windows, backup and exact-SHA packaged acceptance remain unresolved. No production action is authorized or implied.

# Implementation Plan: прийомка перед продажами просторів

**Branch**: фактична Git-гілка `beta`; feature ID `036-production-acceptance`.
**Date**: 2026-10-20 | **Spec**: [spec.md](spec.md)
**Input**: 174 ручні кейси після v1.2.6, 2 Safari + Chrome, автоматичне відновлення після поновлення тарифу, місткість на 30–50 людей.
**Status**:2026-10-23: NO_GO for full036. 94/174 tasks closed (80 open). T014 mail capture is merged into ROOT with157related tests/staticPASS,925pgTAP/38files plus14existing native and5affected mail nativePASS on fresh360 schemas; live ROOT CLI verified and earlier synthetic capture/replay/cleanup preserved. T172 profile synchronization is complete; T173 process cleanup remains pending native Windows. Retained beta is schema360 with owner UI/profile/pairing/Drive preserved. T174 completed guarded migration, actual owned-file retention/final-detach trash, scheduled worker readback, SELECT-only diagnosis and own-task teardown. NEXT clock361 remains isolated for T011/T012 live clock/JWT/overlay acceptance. T016 source/artifact hooks are merged with15guard regressions and compatible exact local env alias; remaining fault/teardown/packaged checks stay open. Adoption, T170 current full canonical/release, hosted load, Windows, backup and packaged acceptance remain open.

## Поточний порядок виконання

1. Keep retained beta available for the owner's current Launch UI review. Do independent work in NEXT; preserve original profile, pairing, Drive root and approved tariff selection.
2. The combined361migration DB gate passed:948pgTAP and21native tests, including actual clock rollback/forward preserving nonempty Launch profiles. The independent Launch reference-fence fix is merged into ROOT with focused SQL/CLI proof and NEXT lint/types. T174 local migration360 and retained-beta acceptance are complete. Keep clock and live test overlays isolated until their remaining acceptance is complete.
3. T014 is integrated and verified in ROOT; keep its proved baseline behavior. Next run current canonical checks on integrated source, then complete isolated clock CLI/JWT/overlay and031diagnostic evidence plus T016 fault/teardown requirements. Preserve destination hashes during remaining NEXT merges; schedule live clock acceptance without disrupting the owner UI session.
4. Complete trusted adoption policy/dependency closure/history/report, required case variants and remaining two-user races. Run current canonical/release checks on a frozen integrated candidate.
5. Retain full174case/variant, hosted30/50load, backup/restore, native Windows and clean exact-SHA packaged requirements. Development evidence is not production acceptance or permission to deploy.

## Summary

Підготувати відтворювану приймальну кампанію, перевірити чинне автоматичне відновлення тарифно призупиненої роботи, виконати ручну регресію й виміряти ресурсний бюджет. Рішення про production ґрунтується на одному зафіксованому кандидатові, результатах кожного кейсу, реальних обмеженнях інфраструктури та exact-SHA packaged beta evidence.

Робота 034 T023–T029 є продуктовою залежністю 036, а не другим паралельним варіантом реалізації. Вона має один набір міграцій/контрактів/тестів. План 036 описує її інтеграцію з прийомкою. 034 закрито на 95467002 з локальними SQL/native/Drive/CLI доказами. Вони є development evidence, а не автоматичним PASS для 174 кейсів 036. Phase 2 нижче — контрольний список аудиту наявної реалізації; створювати її вдруге заборонено. Фактичні seams: team-recovery/handler.ts, recovery-worker.ts, recovery-journal.ts та міграції 20261205100000–20261206120000. Нові дефекти виправляти forward-only.

## Technical Context

**Language/Version**: TypeScript strict/ESM у наявних apps/shared; SQL migrations; `.mjs` для orchestration; Node 22 для локальних тестів (packaged runtime за чинним build contract).

**Primary Dependencies**: наявні React/HeroUI, Fastify agent, Supabase Postgres/Auth/Realtime/Functions, Google Drive, Vitest 3.2.7, PGlite та реальні SQL тести. Новий web framework або брокер черг не потрібні.

**Storage**: наявні team/catalog/job tables плюс мінімальний durable recovery state; локальні JSON/JSONL артефакти кампанії. Fixture credentials окремо від артефактів.

**Testing**: single-worker Vitest регресії; реальна локальна БД для concurrency/RLS; native Safari/Chrome ручні кейси; Windows і окремі агентні машини; авторизований load harness з отриманням результатів.

**Target Platform**: macOS з двома Safari profiles та Chrome, підтримуваний Windows agent, локальний beta stack; окремо ізольований hosted стенд для перевірки ресурсів Supabase.

**Project Type**: доповнення наявного web/agent/backend продукту та приймального tooling.

**Performance Goals**: recovery enqueue ≤60 с, перший каталог ≤5 хв за здорових залежностей; p95 live delivery ≤5 с, reconnect ≤15 с; p95 warmed list/search ≤2 с; ≥99% звичайних дій; 8 годин без втрат/дублів; ≥30% запас квот.

**Constraints**: немає production writes/load, немає dev-auth у beta, analytics лишається read-only, немає нового recurring client polling, старі застосовані міграції не переписуються. Не відновлювати ручні cancel/disable або роботу без актуальних прав.

**Scale/Scope**: 174 кейси, LOAD-01–10; 30/50 людей, 1/10/50 команд, 100 звичайних і 150 пікових вкладок; первинний та великий індекс за capacity-plan. Число людей не є одиницею DB connections або Realtime delivery.

## Constitution Check

Перевірено до дослідження та повторно після дизайну. **PASS для плану**; це не результат реалізації.

| Принцип              | Рішення й перевірка                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Typed boundaries  | Shared recovery DTO/closed codes; JSON campaign validator; unknown на межі, без довіри до клієнтської причини паузи                                                     |
| II. Release identity | Manifest base/candidate/schema, clean SHA для final, чинний packaged promotion gate; жодного version bump/deploy у цій фазі                                             |
| III. Least privilege | Server recovery перевіряє чинне членство/тариф; SQL security definer із порожнім search_path; fixture writer окремий від read-only CLI; production targets відхиляються |
| IV. Child resources  | Агент через power spawn/governor, hold/resumeForTermination і scaled deadlines; recovery не додає другого suspender                                                     |
| V. Stable contracts  | Доповнення чинних envelopes/RPC; backward-compatible optional поля та стабільні reason codes                                                                            |
| VI. UI/state         | Єдиний Realtime/SSE transport; authoritative reread після reconnect; компоненти й токени docs/DESIGN.md; без нового polling                                             |
| Analytics 031        | Correlated intent → accepted → start → terminal → delivered; blocked/partial/unknown явні; capability/code-map/CLI регресії                                             |
| Verification         | Немає прихованого PASS при відсутньому Drive/Windows/hosted; стандартні verify gates плюс campaign report                                                               |

## Project Structure

### Documentation (this feature)

```text
specs/036-production-acceptance/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── contracts/recovery.md
├── contracts/acceptance-tooling.md
├── manual-test-cases.md, runbook.md, capacity-plan.md
├── scope.md, execution-report.md, checklists/requirements.md
└── tasks.md  # історичні83 + discovered T084–T121; актуальний progress ledger
```

### Source Code (repository root)

```text
packages/shared/src/team/recovery.ts         # чинні typed DTO/credentials/budgets034
packages/shared/src/team/analytics.ts       # typed сигнали
apps/web/src/team/tariffs/                  # стан відновлення замість обов’язкової кнопки
apps/web/src/team/workspace/WorkspaceShell.tsx
apps/agent/src/team-bridge/                 # scoped background executor/checkpoint recovery
apps/agent/src/platform/platform.ts         # protected credential storage seam
supabase/functions/team-recovery/           # чинний034 scoped delegation/claim endpoint
supabase/migrations/                        # чинні034 recovery + additive036 membership fixes
supabase/functions/tariff-notices/           # reuse renderer; beta capture adapter
supabase/functions/catalog-updater/         # наявні bounded claims
scripts/acceptance/                         # реалізована local foundation; clock/fault/full LOAD pending
scripts/analytics/                          # розширення read-only діагностики
supabase/tests/database/, tests/            # SQL, contract, UI, agent, tooling regressions
release/acceptance/<campaign-id>/           # фактичні immutable runs/evidence, git-ignored
```

**Structure Decision**: використовувати існуючі seams. Recovery artifacts уже реалізовані034, local acceptance foundation —036. Реалізовані CLI commands наведено у quickstart; clock/fault/full LOAD/hosted/adoption залишаються planned. Конкретні інтерфейси наведено в contracts. На початку реалізації звірити вкладені AGENTS.md та актуальний diff; сторонні зміни не перезаписувати.

## Phase 0 — Scope, дослідження та фіксація рішення

1. Звірити HEAD/base v1.2.6, незакомічений Launches, окремо розгорнуті backend hotfixes. Оновити scope manifest; кожному файлу призначити конкретний case/gate або доказ виключення. Загального `REG` для остаточного freeze недостатньо.
2. Зберегти initial dirty manifest для дослідної кампанії; clean candidate визначити після виправлень. Немає автоматичного checkout/reset/commit чужої роботи.
3. Прийняти рішення [research.md](research.md): server-owned recovery, локальний clock overlay, capture без реальних листів, native Safari, окремий hosted target.
4. Зафіксувати доступність Drive fixture, Windows/другого агента і hosted стенду. Відсутність ресурсу не зупиняє розробку локальних засобів, але дає BLOCKED відповідним execution cases.

**Вихід**: уточнений scope, fixture schema, список доступних середовищ, дизайн без нерозв’язаних архітектурних питань.

## Phase 1 — Підготовка стенду й доказів

1. Перевірити реалізований local-only fixture writer поверх beta isolation guards: звичайні A/B/C/X, окремий Soty admin, W1/W2, плани/місця/ролі, контрольні дані. Стандартну beta fixture не видавати за платного власника.
2. Додати controlled tariff clock: одна доменна точка часу для всіх tariff access/notice paths; production повертає серверний час, заміна реалізації встановлюється лише локальним test overlay поза production migrations. Жодних клієнтських `now`/SQL session overrides, що може встановити користувач. Lease, JWT і worker timeout лишаються реальними.
3. Додати named fault fixtures для acceptance lost/status lost/429/expired cursor/worker interruption. Безпечний capture email використовує реальний renderer і dedup, але не мережеву доставку. Перевірити, що production build/конфігурація не приймає тестові перемикачі.
4. Перевірити реалізований loopback-only diagnostic capture: звичайна beta analytics лишається вимкненою (tests/beta-analytics.test.ts). Typed події проходять спільні validation/ingestion до test DB й читаються штатним CLI; це окремий test adapter, не VITE_ANALYTICS_ENABLED=true. Довести missing/delayed signals.
5. Перевірити реалізовані campaign manifest/result validators та завершити required-variant/adoption gaps; status append-only, evidence hashes, redaction, totals за 174 ID, N/A reasons, stale candidate rejection. CLI `report` не пише стандартний `verification-result.json` — стандартний verify лишається єдиним його власником.
6. Запустити SET та тест реальних прав прямими викликами як A/B/C. Native Safari профілі відкрити за runbook; harness не імітує Safari Chromium/WebKit-емуляцією.

**Вихід**: SET PASS, fixtures повторювані, негативні isolation guards PASS, жодної реальної розсилки.

## Phase 2 — Перевірка чинного автоматичного відновлення 034

Реалізація вже є в HEAD: `20261205100000`, `20261205110000`, `20261206100000`,
`20261206110000`, `20261206120000`, Edge broker та native worker. Ця фаза аудіює її
відповідність 036 і додає runtime evidence; вона не наказує повторно створювати ці компоненти.

1. Зіставити чинні SQL/handler/worker/UI/analytics tests із LIFE-023–036 та [recovery contract](contracts/recovery.md). Missing variant спершу відтворити failing regression; застосовані migrations не редагувати, gap fix — additive.
2. Перевірити atomic WorkspacePause/PauseItem capture-before-clear, blocked→allowed intent, monotonic epoch, expiry-before-cron, однаковий lock order stop/set/renew та fencing старого worker. One-off, paused interval і per-catalog settings зберігаються; manual generation/disable/cancel мають перевагу. Права завжди перечитуються.
3. Повторити two-session real PostgreSQL/Vault сценарії: renewal без UI, repeated renewal, mixed schedules, registration failure, source/output receipt fencing, bounded updater12/sync3 claims. Числові retry/probe/rotation budgets лишаються за contract:5 retries,≤10min/episode,≤3 automatic episodes/hour; queue≤60s і first start≤5min потребують нового runtime proof, не лише enqueue row.
4. Звірити чинні enrollment/delegate/redeem/rotate/revoke та claim/heartbeat/checkpoint/settle: paired ticket120s, rotation replay60s, окремі ClaimCredential/OperationCredential, current tenant/installation/member/process/source authority. Browser/service-role credentials не копіюються; browser ownership поступається native durable claim.
5. Перевірити journal/Keychain/DPAPI/capability та managed power lifecycle через existing platform/team-bridge seams. Невідомий checkpoint/output після restart не replay; offline agent/Drive дає правдиве waiting/partial, а не success. Native Windows evidence у036 лишається BLOCKED незалежно від виключення для034.
6. Перевірити existing truthful recovery UI і owner-only active-updater warnings; manual resume — fallback, normal renewal автоматичний. Reconnect перечитує authoritative state без нового polling. Mail capture через real renderer/dedup залежить від незавершеного adapter T014.
7. Повторити read-only `investigate`/`inspect`/`sync`/`audit` для last-proven-stage, terminal проти delivery, missing/delayed signals та bounded retention≥30d без видалення active/waiting dependencies. Оновити034 findings/ADMIN-TARIFFS лише доведеними новими фактами.

**Очікуваний вихід фази**: нові correlated LIFE/ACL/SYNC докази, diagnosable partial recovery,
числові SLO і explicit external blockers. Чинний development closure034 не є final acceptance PASS036.

## Phase 3 — Повна ручна кампанія

Порядок: SET → TEAM → ACL → TARIFF → LIFE → RO → SYNC → REG → LAUNCH → OBS. Виконувати кожен кейс на відомому fixture, писати фактичний результат і докази з трьох сесій. Поміняти ролі Safari↔Chrome для критичних потоків. Серверні заборони перевірити реальною особою, не service-role. Перевірка Drive/Windows із відсутньою залежністю — BLOCKED.

Кожен дефект: відтворення → failing regression → виправлення → targeted single-worker tests → повтор кейсу й залежних груп. Зміна SHA робить залежні докази stale; фінальна критична регресія виконується на зафіксованому чистому кандидатові. Незалежний P1 evidence переноситься лише через EvidenceAdoption (data-model §5a): immutable source PASS, reviewed dependency closure та однакові hashes/config/schema/fixtures. Foreign SHA без adoption відхиляється. Усі P0, tariff/security/recovery, LOAD/performance, backup, Windows credentials/recovery та packaged evidence виконуються заново; report розрізняє executed_pass/adopted_pass.

**Вихід**: усі 174 кейси мають результат; P0/P1 без FAIL/BLOCKED/NOT RUN, N/A обґрунтовано відсутністю функції у кандидатові.

## Phase 4 — Ресурси, довга робота й вибір плану

1. Реалізувати seeded authenticated load harness за contracts: 30/50 реальних test users, team actions + Realtime delivery; відкритий темп надходження, bounded concurrency, actual vs offered load, timeout та recovery latency включені у статистику. Метрики навантажувального комп’ютера збираються окремо. Native Safari A/B та Chrome C входять до 30/50 сесій; LOAD-02/03/04/06/07 вимірюють action→visible correct DOM для списку/пошуку (10 warmups, ≥100 measured attempts/action/browser/profile, timeout 15с врахований). API latency не підміняє SC-003 UI p95.
2. Виконати LOAD-01–10 з [capacity-plan.md](capacity-plan.md). Почати локально для correctness/cost ratios, далі на окремому hosted sandbox для квот. Стандартний local beta runner не розширювати до remote. До LOAD виконати окремий hosted prepare: verified allowlist, candidate migrations/Functions/web, Realtime/RLS/scheduler, test ingestion, actual synthetic worker/auth/agent smoke; immutable runtime-manifest та readiness ≤15 хв. Hosted verify перевіряє докази й identity read-only; немає готового runtime → BLOCKED.
3. Перед resource collection перевірити SQL та management targets окремо: management у поточному CLI бере active deployment binding, не ANALYTICS_DATABASE_URL. Додати explicit verified acceptance binding та reject mismatch. Read-only baseline/trend: physical DB, index/grants/history growth, CPU/IO/pool, Functions, Storage/egress, Realtime messages і sockets. Невідома метрика не стає нулем. Heavy aggregate scan лише start/end, не частий polling.
4. Розрахувати 30/90-day прогноз з idle, fan-out, onboarding та іншими споживачами квот. Перевірити 8 годин, reconnect burst та stop thresholds. Після stop підтвердити збереження даних і повернення черги, а не просто завершення генератора.
5. Free лише за ≥30% запасу всіх квот і backup/restore доказу. Якщо не проходить — мінімальний кандидат Pro+Micro, повторити профілі; compute upgrade обґрунтувати виміряним bottleneck. Не називати Pro гарантовано достатнім без повтору. Ціни/квоти звірити з офіційними джерелами на дату фактичного рішення.

**Вихід**: виміряна таблиця ресурсів, план/compute і кошторис із припущеннями, відновлення backup з RPO/RTO.

## Phase 5 — Фінальна готовність

На чистому SHA пройти `npm run verify`, `npm run verify:release`, Windows acceptance та packaged beta за канонічним runbook. Важкі команди послідовно. До звіту додати стандартний verification-result, artifact hashes, beta verification record, 174 case outcomes, LOAD evidence, backup proof, усі unknown/defects.

GO можливе лише при SC-001–007, FR-016 та відсутності S0/S1/критичних сліпих зон. Приймальна кампанія не випускає реліз і не замінює G0/sandbox evidence. Production виконується окремо за docs/PRODUCTION.md. Після продажів — запланований bounded read-only контроль перших 14 днів та хвиль 10/30/50 людей, без створення розкладу в цій фазі.

## Dependency and verification map

| Робота            | Залежить від                                 | Доказ                                   |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| Fixtures/evidence | Scope, target guards                         | SET, tooling safety tests               |
| Recovery backend  | Fixtures, failing regressions                | SQL races + LIFE + diagnostics          |
| Recovery UI/agent | Backend DTO/checkpoint                       | UI/agent tests + three-session delivery |
| Full manual       | Recovery, Drive, test accounts               | 174 outcomes                            |
| Load capacity     | Stable core, harness, isolated hosted target | LOAD-01–10, resource forecast           |
| Final go/no-go    | All above + Windows/backup                   | Clean SHA, canonical verification       |

## Complexity Tracking

Винятків із constitution не потрібно. Durable recovery record потрібен для restart/idempotency; один виклик UI не виконує вимогу без браузера. Окремі local fixture writer та read-only analytics мають різні повноваження за призначенням. Hosted sandbox — окрема перевірка ресурсу, не обхід local beta guard.

## Післяпроєктна перевірка

Виявлені під час research додаткові залежності включено: beta diagnostic capture, mail capture, management-target guard,
one-off round provenance та browser-independent scoped agent executor. Це не приховані припущення про наявні можливості.
Архітектура не потребує винятків із constitution; реалізація делегації включає security regressions та платформні gates.
Hook-файл `.specify/extensions.yml` відсутній: before/after plan hooks не застосовуються.
`setup-plan.sh` повернув logical BRANCH=036-production-acceptance з feature context; `git branch --show-current`
підтвердив фактичну `beta`. Гілку не перемикали. Це історичний результат planning workflow. Відтоді реалізацію розпочато; поточні результати та відкриті прогалини наведено в tasks.md і execution-report.md.

## Оновлений порядок виконання — 2026-10-20

1. Зберегти initial dirty snapshot; врахувати закомічені 035/037/038/041 та recovery 034.
2. Підняти наявний Colima/local beta без reset існуючих даних; створити scoped campaign fixtures.
3. Реалізувати відсутні acceptance validators/target guards/records/actors, потім capture та load accounting.
4. Повторно перевірити recovery tests і контракт проти 034; лише доведені прогалини стають implementation tasks.
5. Виконувати доступні Chrome/native browser сценарії та локальні права/тарифи; відсутні native profiles, hosted sandbox і Windows лишаються явними blockers відповідних доказів.
6. Завершити доступні перевірки й звіт. Exact-SHA packaging та release gates — окремий final milestone після clean candidate; поточна робота не деплоїть production.

Попередній дизайн recovery нижче/вище зберігає acceptance expectations, але не є інструкцією переписати чинний broker. Контракт 034 та фактичні typed seams звіряються перед кожною зміною.

## Фактичний інкремент 2026-10-21

Продуктові fixes кампанії: lifecycle нативного picker; authoritative membership invalidation
через bounded own-row signal, включно з removed-user RLS; account draft permission loss.
Додано restricted diagnostic projection і existing operation_* producer для access reread;
completion не оголошується DOM delivery. Нових recurring polls немає.
Свіжий стенд винесено в detached sibling worktree, project_id acceptance036; початкова wishly
DB і mutable Soty Beta state збережені. Старий стенд мав 13 migration gaps; їх не приховано
ручним replay/fake journal. Нова additive migration — 20261206130000. Local generated types
оновлено штатним generator (+60 lines). Vite patched без major migration.

Реалізовано development foundation, не всю прийомку: target/preflight/fixtures/actor boundaries,
immutable records/report, isolated typed capture, read-only diagnosis, synthetic media та API
calibration. Controlled tariff clock, named runtime faults, mail capture, full campaign adoption,
hosted load, 8-hour soak, backup/Drive/Windows і clean exact-SHA package лишаються відкритими.
Пороги SC не послаблюються. Знайдені regression tasks T084–103 доповнюють історичні 83.

Optional named variants тепер реалізовано окремим private variants manifest: SOLO має bound Solo workspace, PENDING — unbound grant, legacy — workspace без tariff за вже активного legacy rule. Global rule не змінюється. Reuse вимагає exact actor/membership/grant ownership. Cleanup підтримує лише доведений порожній graph, відключає app access до Auth deletion, checkpoint переживає втрачену HTTP відповідь; будь-який content/provider/unknown reference блокує clear. Це не доказ повного provider-aware teardown.

Local Realtime calibration доповнює API-only baseline: окремі п’ять Auth clients, три authorized
readbacks, два outsider listeners, bounded event coalescing і collector ledger. Під concurrent unit
verification burst5/s дав15 dropped/100; steady1/s —100 writes і300 deliveries без втрат, p95≈592ms.
Це protocol observations, не native latency, hosted quotas або повний load profile. Повторити baseline
без паралельного verify; required LOAD cases та8h soak залишаються відкритими.

## Поточний порядок після reboot і зміни пріоритету

1. Відновити існуючий acceptance036 runtime без reset; перевірити identity/fixtures після reboot. Перерваний canonical run лишається interrupted.
2. Першочергово виконати доступні F2-01–10 у двох незалежних A/B сесіях; role B змінюється послідовно. Не витрачати agent UI час на однокористувацький walkthrough.
3. F2-11/12 виконати лише з окремим дозволеним тестовим Drive; за його відсутності — конкретний BLOCKED. Синтетичний S лише готує тариф, не стає третьою браузерною сесією.
4. Failing regression → fix → affected repeat; автоматичні важкі gates послідовно. Не повторювати весь suite через втрату observation handle, доки не підтверджено terminal/interrupted стан.
5. Передати власнику короткий список екранів, focused report та залишкові blockers; відновити початковий mutable Beta state після завершення own runtime. Повний production verdict не виводиться з focused scope.

## Поточний стан — 2026-10-21, фінальна передача звуженого пріоритету

За уточненням власника ручні однокористувацькі екрани передано власнику; агент виконав F2-01–10, F2-11/12 заблоковані окремим Test Drive. Результат:10 PASS/2 BLOCKED/0 FAIL. Це пріоритет ручної перевірки, а не завершення всієї специфікації036. Короткий список10 вікон: owner-ui-checklist.md.

Фінальний172-file кандидат (dirty HEAD95467002ddc4cbfffa68090f7777f5f79f06edca) синхронізовано в isolated worktree та перевірено за SHA-256 перед/після обох canonical commands. `npm run verify`:14/14 PASS,6508 passed/17 skipped/0 failed (6525 total),1287s. `npm run verify:release`:22/22 PASS, той самий test count, coverage80.55%,1646s; включено збірки, contracts, isolated full-chain database, a11y та browser CSP. Baseline/floors не знижено. Перший172-file fast мав Launch copy5s timeout; isolated40/40 PASS(copy58ms), повтор без source/timeout змін PASS. Історичні FAIL/INTERRUPTED збережено.

T119 coverage gaps закриті canonical release. T120 закріплює caller/disk/frozen manifest identity та cleanup unpublished runs (53/53 focused); full EvidenceAdoption T006/T007 цим не реалізовано. T121 виправляє stale preview authority при origin/session change і pending clear, оновлює mounted URLs через pairing notification та повторно використовує typed connection diagnostics. Cache/observer/URL hook100% lines; producer→sanitizer→stored read-only diagnosis також перевірено. Native media visibility після reconnect лишається пунктом власника.

Обидві важкі команди виконано послідовно, serial gates/one worker/heap2048. Own agent/web OFF, DB-only verification window закрито; source roles unchanged, початковий Soty Beta inode збережено, ports43140/5175 вільні. ROOT/wishly не запускався й не мігрувався. Після перевірки змінюються лише status/docs, не перевірений продуктовий код.

Production verdict лишається NO_GO: original174-case catalog5 PASS/4 BLOCKED/165 NOT_RUN. Full adoption, clock/fault/mail capture, independent recovery audit mappings, full LOAD/hosted acceptance,8h soak, backup/Drive/Windows та clean exact-SHA package залишаються відкритими у tasks.md. Успішні canonical gates не замінюють ці докази. Production writes/deploy/releases, commits/tags/version changes не виконувалися.

Докази: release/acceptance/acceptance-036-20261020/verification.json; verify-subresource-final-retry-fast-{result,suite}-20261021.json; verify-full-release-subresource-final-{result,suite,coverage-summary}-20261021.json; final-verification-cleanup-audit-20261021.json. Frozen172 source manifest зберігає hashes саме перевіреного кандидата; пізніші documentation-only updates фіксуються окремо.

## Post-handoff audit increment

T024 зіставлено з75 canonical SQL passes; T026 доповнено6 tests-only variants,23/23 focused PASS/test typecheck PASS. Mapping у recovery-audit.md. Product/schema незмінні; цей tests-only increment не входить у historical frozen172 full gates, їхні counts не переписуються. T027 та решта відкритих задач не оголошуються завершеними.

## Зупинка за вказівкою власника —2026-10-21

За прямою вказівкою власника перевіряти лише двох користувачів і зупинитися: доступні F2-01–10 PASS, F2-11/12 BLOCKED(Test Drive). Single-user перевірки передано за owner-ui-checklist.md. Подальшу повну036 не продовжувати без нового запиту. T027 retry/backoff defect відтворено, незавершений increment збережено приватно й4 source/test files повернуто до pre-audit стану. Цей fix не застосований і не зарахований як завершений; продукт відповідає canonical172 PASS, T026 tests-only increment23/23 залишено. Повна036 NO_GO.

## FocusedUI поновлення за новим запитом власника —2026-10-21

Власник поновив ручну перевірку10 вікон. Це не поновлює широкий recovery-аудит і parkedT027. Доступні сценарії пройдено на isolatedacceptance036beta/realAuth. Виявлені5UIдефектів оформленоT122–126; виконано регресії й native retest, остаточнийfastverdict ще pending. Джерело поточних доказів:single-user-ui/report.json та ui-fix-source-freeze-final.json.

Native/Driveобмеження залишаються окремо: підключенийTestDrive для справжніх матеріалів, вкладень, каталогів іGenerate; керований nativepicker для локальноїобробки/results/cancel; reconnect із відкритим медіа. Розширені тарифні grant/plan/seats не зараховуються focusedUI. Showcasecopy-request підтверджено звичайним додатковимPENDINGactor і adminreadback; жодного зовнішнього повідомлення. Середовище зупинено, originalSotyBeta inode80094769 повернуто. Подальше повернення до beta вимагає нової ізоляції app-support, як у quickstart.

FocusedUI final: T122–126 завершено. Frozen10 source/test files ROOT=W незмінні після перевірок.13static gates PASS; перший повний suite FAIL2existinglaunch5stimeouts(793passed), незмінний focusedfile40/40PASS. Повтор лише affectedsuite gate: buildshared+suite2/2PASS,6519passed/17skipped/0failed,6536total,1299s. Initialfailure залишається окремим доказом, причина таймаутів не встановлена. Composed fastcheck evidence, не single fullrunPASS; coverage/release нового increment не вимірювались. NativeUI5fixes retestPASS, але partial/blockedwindows не прирівняно до повної036acceptance.

Artifacts:single-user-ui/report.json,summary.md,final-check-evidence.json,ui-fix-source-freeze-final.json,verify-third-result.json,launch-focused.log,verify-suite-retry-{result,suite,progress}.json/log і runtime-cleanup.json. ОригінальнийSotyBeta inode80094769 повторно звірено післяsuite; власні порти закрито,037 не чіпали. No production writes/releases/commits. ParkedT027 не застосована.

## Підключений Drive і тарифна вітрина — поточний прохід 2026-10-22

Новий дозвіл власника: тестувати самостійно всередині підключеного кореня, створювати й копіювати файли, видаляти лише власні; зберегти Google-сесію. Ізольований acceptance036 runtime активний, оригінальний Soty Beta inode80094769 збережено окремо. Попередній запис про зупинений стенд описує попередній прохід.

Власна QA-папка: `036 QA 2026-10-22 — створено агентом`. Пройдено upload MP4/PNG/ZIP/папки, preview/play, rename/copy/move/trash/restore, примітку й taskattachment; дві реальні локальні Auth-сесії підтвердили realtime rename/note/folder і межі ролей. C viewer відкрив готовий landing preview без локального агента. Catalog create/recreate, manual update та hourly schedule пройдено; тестовий schedule повернуто Off. Generate без каталогу і з каталогом пройдено. Синтетичне зображення каталогу — placeholder URL, тому приймання Meta не перевірене.

Виправлення: bounded reason для catalog WRONG_STATE; видимі SUB errors у розгорнутому accordion; ранній Stop, який міг пропустити late receipt у запуск агента; неправильний transcription indicator під час compression. Для Stop додано correlated workflow/run terminal і явні diagnostic blind spots. Перший native cancel помилково виглядав успішним, але файл з’явився пізніше: первинний PASS відкликано. Після виправлення раннє скасування підтверджене regression tests і read-only diagnose workflow; це не доказ повного mid-flight cleanup у Drive.

Тарифна вітрина отримала суцільну inventory surface, компактний hero, адаптивну сітку переваг і читабельний статус заявки; перевірено світлу й темну теми на поточному desktop viewport. У тарифній таблиці зменшено summary typography, заголовок переноситься, кнопки дій мають мінімальну ширину. Mobile viewport не зараховано.

Докази: `release/acceptance/acceptance-036-fresh-20261021/drive-ui/report.json`, `source-freeze.json`, `investigate-final.json`. 13 static gates PASS за152s після T132; повний suite ще виконується. Перерваний попередній suite збережено як ABORTED, він не PASS. Повна036 залишається NO_GO; parkedT027 не застосовується. Прод, stable manifest, migrations і релізи не змінювалися.

Додаткові T133–134: live view revoke залишав старі таблицю/відео; тепер authoritative view=false демонтує workspace,25focusedPASS і browser video/table/dialog=0. Уже виданий range grant після відкликання теж повертає PERMISSION_DENIED. Початкові editor defaults B відновлено. Sync власної підпапки завершився після закриття вкладки-ініціатора:6files,1folder,runCount1,error/cancel null; це не доказ двох різних admin requests.

Native destination picker виявив ще один Stop defect: agent download реєструвався після вибору папки, тому cancel повертав404, а дочірній діалог лишався. Реєстрація перенесена перед очікуванням; per-waiter AbortSignal закриває власний діалог macOS/Windows, але не діалог іншого активного waiter; TERM→KILL має межу й очищає таймери. UI чесно лишається choosing до agent progress, DOWNLOAD_CANCELED завершує workflow як cancelled.4RED regressions і2RED progress/diagnostic regressions збережені;89relatedPASS. Оновлений agent зібрано й запущено через official beta:down/up, local Auth/Google connection збережені. Native retest: choosing copy, cancel200, download499, own childgone, UIidle. 13static gates PASS127s на21-file freeze; повний suite ще виконується. Перервані раніші suites — ABORTED, не PASS.

Початковий профіль inode80094769 повторно звірено в preservedState; активний синтетичний профіль inode104616221 не підмінювався. Beta залишається активною для збереження підключення. Native destination chooser недоступний CUA для вибору теки; його скасування пройдено. Окрема authenticated local API integration зі своїм destination дала справжній перезашитий MP4 (власні video+PNG): перший кадр синій, H264/AAC320x180; source3.000s/output2.983s. Це core/API delivery proof, не повний UI chooser acceptance. Жодних production writes/releases.

T135 виявлено під час реальної browser оптимізації власного ZIP: macOS ditto додав AppleDouble/xattrs, а transport filename потрапив у folder prefix.2RED→58relatedPASS; zipDirectory лишається platform seam і не пакує resource/extended attributes, team landing worker використовує displayname landing. Діагностичне покриття лишає archive contents unobservable: сам terminal не доводить правильний ZIP чи економію байтів; потрібні synthetic archive/browser checks. Нова аналітика не збирає імен/шляхів/вмісту.

Тарифна вітрина додатково пройшла actual native Chrome widths777/496/406px, scrollWidth=viewport; wrapped email/CTA доступні після scroll. Вікно повернуто до1199x666(початково1200x666). Це responsive desktop proof, не мобільний OS smoke. Поточний25-file freeze ROOT=W; попередні fullsuite attempts були зупинені через знайдені defects і лишаються ABORTED. Фінальний прогін після T135 ще pending.

### Test profile isolation incident (T136)

Final T135 suite aborted after discovering existing optimizer tests write normal Soty landing settings. Observed file preserved privately; pre-test original unavailable, so no guessed restoration. Central Vitest env now assigns separate UUID profiles per project before imports; exact directories cleaned after workers finish. 21 focused tests pass, Main settings hash/mtime unchanged, no leftover verification profile. Full suite must be repeated; earlier aborted runs are not passes. Drive originals and preserved original Beta profile unaffected.

T136 recovery update: original Main process15865 had been running since18:48 before tests. Read-only landing/state retained actual active preferences; only imageQuality differed from incident disk. Rechecked live settings and incident SHA/mtime, atomically restored exact live preference object at23:36:49Z without restarting Main or Beta. Original JSON formatting unknown. Recovery evidence private; subsequent isolation monitoring uses restored baseline.

### Final Drive/UI increment result (T127–T136)

Browser pass complete with documented limits:41 scenarios; fixes and scoped evidence in `release/acceptance/acceptance-036-fresh-20261021/drive-ui/summary.md` and `report.json`. Final static13/13PASS108s; isolated full unit suite6541PASS+17explained skips,0fail,1593s. Coverage not measured; no release/package/production acceptance claimed. Source freeze28files stable and ROOT/acceptance worktree identical. All temporary verification UUID profiles cleaned. Main live preferences recovered and stable through the remaining suite; original Beta profile inode80094769 preserved, active synthetic inode104616221 retained. Beta/Google connection stays running; no production deployment or release.

Current remaining limits: native chooser completion, full mid-flight provider upload cleanup, two different admins starting sync concurrently, and broad036 Windows/hosted/load/backup/package evidence. F2-11 focused role/media cases PASS; F2-12 remains PARTIAL. Broad036 remains NO_GO. Optional owner review is three windows in owner-ui-checklist.md.

### Додатковий автономний прохід22жовтня — поточний checkpoint

Докази та відомі невиправлені дефекти: [drive-followup summary](../../release/acceptance/acceptance-036-fresh-20261021/drive-followup/summary.md). Два локальні виправлення: E5 no-warmup та packet-cadence proof для довгого held output. Real-model5PASS; bundled held-contract19PASS; system long-embedding2PASS; PostgreSQL834pgTAP+5tariffPASS у видаленому disposable container; shared budget2PASS; concurrent owner+admin sync API PASS з поверненням ролі B. T139 late-upload orphan та T143 bundled7.1.1 sparse/EXIF defects лишаються відкритими. Повторний повний canonical verifier ще виконується, PASS не заявлено. Старий6541PASS є історичним і не замінює перевірку нинішнього source snapshot. Full036 NO_GO.

### Поточна реалізація після відновлення22жовтня

T143 реалізовано: JPEG frame Display Matrix прибрана перед явним EXIF transform; standalone remux duration нормалізована за origin без зміни validation tolerance. Regression66PASS на shipping7.1.1 і66PASS на system9.0.1; beta source mirror оновлено, runtime ще pre-T143.

Наступний пріоритет T139: generic process upload не має durable ownership/cleanup path, який існує лише для launch restitch. Локальний settled fetch/ACK не доводить завершення Google PUT. Потрібне рішення з доведеною provider identity та current fenced service cleanup; не послаблювати revoked finalize grant, не видаляти за ім’ям/одним marker, не чіпати overwrite/original. Спершу failing adversarial/restart/lost-response regressions, потім additive implementation, local database replay і real own-folder retest. Full canonical verifier повторюється після фінальних source changes; попередній прогін перерваний reboot у shard8, не PASS.

### T139 — завершено SQL-основу, інтеграція триває

Міграція20261206134000 містить приватний ownership ledger, service-only prepare/start/claim/authorize/settle, operation outcome fence, захист індексації та privacy-limited projections. Фіксує новий provider ID/nonce/MD5 до effect; overwrite/original/published матеріали не підлягають cleanup. Невизначений404 лишається waiting/attention з finite24attempts/90slease. Покинута операція може перейти в unknown failure лише після captured handoff expiry за відсутності чинного finalize grant. Зареєстрований іншим явним шляхом матеріал захищений від cleanup і зберігає catalog readback; старий snapshot guard не змінений.

Докази:9PGlite ledger/reader cases,111relatedPASS у8files;347migrations на disposable real PostgreSQL,855pgTAP у30files (21new) +5tariff race/VaultPASS. Контейнер видалено, live acceptance DB не змінена. Reader показує фазу, attempts/deadlines та відсутність/зміну evidence без provider IDs/content/checksums. Типізований PROCESS_RESULT_UNCERTAIN, code-map, UI copy та inventory додані; inventory залишається pending_producer.

Не зараховано завершення T139: ще немає agent MD5/producer handshake, Edge integration, cleanup worker/scheduler, provider If-Match proof, справжньої multi-connection гонки та live own-folder cancel retest. Перед live migration пройти ці межі й final gates. Перший новий pgTAP adoption case мав невірний NULL snapshot у single-transaction fixture; виправлено лише test snapshot, failure log збережено.

T139 recovery checkpoint (2026-10-22): v2 same-response ownership/ETag client verified on a new
owned QA fixture, with conditional trash and confirmed readback. Worker core has 21 targeted
cases (76 related cases including client/provider/transfer); no scheduler or live migration yet.
Before enabling it, close the explicit concurrent-adoption gap across the database/provider
request, then wire protected Edge handoff/finalize and headless scheduling. User tariff commit
9dca022d is adopted and mirrored; the owner already tested that window.

T144 checkpoint (2026-10-22): actual parallel PostgreSQL proves both adoption/cleanup orders
and first identity capture versus an uncommitted material insert. Durable mutation reservation
survives uncertain provider replies and expired leases. Use tuple locks; per-file advisory locks
failed the existing 50k catalog fixture. Final SQL chain348 passes859 assertions/31files; three
race cases and five existing tariff cases pass. No live beta migration. Next T139 work remains
protected Edge start/finalize, privacy-safe reservation diagnosis, scheduler and live provider race.

Local cutover checkpoint (2026-10-22): through350, full866pgTAP/33files and8native casesPASS;
119main+34related checksPASS, test/script typechecks and lintPASS. Applied four guarded --local
migrations without resetting the authorized Drive connection. Official Beta restart succeeded;
actual protected upload finalized with the captured provider ID and old producer was refused.
The scheduled last-PUT/cancel proof exposed incremental ingestion bypass T145. Preserve that
registered output; validate351 then repeat on a fresh captured output, with a full minute-cadence
observation window. Pending351 source/native checks are not evidence that this bug is fixed live.

T145 acceptance checkpoint (2026-10-22):351 chain869pgTAP/34files+9nativePASS; 14ownership,
7replay,11safe-reader,19investigate,11codemap cases verified. Local351 applied without reset.
A fresh protected final-PUT/cancel race was automatically trashed by the minute-cadence worker
in one attempt; final operation stayed canceled with null result and revoked finalize refused.
Independent provider metadata and read-only CLI confirmed exact-target cleanup/no registration.
Earlier accidentally indexed fixture remains retained and its registration fence is explained by
the CLI. Full real-agent UI Stop/restart acceptance and canonical/lifecycle gates remain pending.

Actual-agent UI checkpoint (2026-10-22): T146 confirms real compression success, cancellation
while downloading and while processing, with matching local SSE/cloud terminal states and no
output handoff for canceled runs. T147 fixes two visible regressions discovered during that QA:
progress lived below the explorer table instead of a Modal; terminal readback discarded measured
agent progress. Shared Modal and localized stages now remain visible, and the last known progress
is retained while the authoritative state still determines outcome. Status-read errors can be
dismissed without implicit cancellation. 21targeted+24relatedPASS; test/project types and lintPASS.
Fresh UI cancel retained26percent; local handle removed, cloud canceled/resultnull, no provider
handoff. Next: restart/provider-adversarial acceptance and full canonical/lifecycle verification.

Current checkpoint 2026-10-22: T148 official Beta restart cleanup and T149 renamed/moved preservation passed through the ordinary dispatcher; independent provider and read-only CLI evidence confirmed. Owner-tested tariff redesign9dca022d is retained without repeated visual acceptance. T027 parked regression was revalidated against unchanged baseline hashes:10RED, restored fix then32worker/journal+61related=93PASS including HTTP-date and legacy deadline behavior. The initial current canonical run stopped at formatting (12staticPASS,3files formatting-only corrected). Full canonical remains pending on the refreshed source; no production-ready or exact-SHA claim.

Current checkpoint after frozen94 canonical: all13static gatesPASS, firstunitshard809PASS/2FAIL due to missing additive PROCESS_RESULT_UNCERTAIN SQL catalog. T151 adds a separate generated352 migration and process extension output; immutable applied base/account migrations are byte-unchanged.29focused contract/ownershipPASS;352local applied preserving auth/Drive. Full disposable database run is active, canonical/lifecycle rerun pending. T150 live same-size content modification preservation alsoPASS; ordinary scheduled cleanup retained attention without provider mutation.

T151 native follow-up:352migration chain passed869pgTAP/34files plus9native cases; disposable clone removed. A new full canonical run captures a fresh transition log; reconciliation is a later read-only run after completion. Migration catalog352 remains a fixed batch: normal generation refuses to overwrite a changed existing migration, while explicit temporary output permits fixture rendering.

Current frozen98 canonical attempt:13staticPASS; shards1–4 completed, shard5 stopped at2glossary failures from accepted tariff commercial wording. T152 updates only test/contract context for3exact reviewed keys; owner UI and copy unchanged.23focusedPASS. Transition log from this failed whole run is partial and cannot be reconciled as completed evidence. Before the next full run, resolve T037 durability gap identified by source audit; macOS native Keychain synthetic roundtrip/replacement/cleanup passed separately, Windows native remains unavailable.

T037 design update: local atomic rename alone does not prove power-loss persistence. The safety boundary is now a durable server execution reservation per operation, committed before the start acknowledgement. Existing checkpoint RPC producers share the same guard; no older Edge bypass. Lost acknowledgement/rewound accepted metadata is uncertain and cannot replay that operation.4RED→51focusedPASS;353 is not yet applied to local Beta. Before acceptance: actual PostgreSQL concurrent reservation, permission/expiry/terminal variants, privacy-safe agent-readable reservation evidence and guarded local cutover. Node/Apple storage documentation is recorded in the dedicated T037 proof; do not equate an fsync acknowledgement with physical power-loss testing.

Current T037 completion checkpoint:353chain877pgTAP/35files+10nativePASS and clone removed. Local353 applied without reset; official Beta restart rebuilt current source and retained browser session, connection and QA folder. Actual Edge first checkpoint accepted/repeat409; a real worker with synthetic accepted rewind blocked before processing (0calls), read-only investigate/inspect confirmed reservation/unknown execution/unknown delivery. Only own fixtures canceled/revoked, no provider writes. Local generated DB types refreshed with existing compatibility wrapper preserved; project typesPASS. T036/T037 development audit tasks closed; canonical/lifecycleT048 and wider036 remain open.

T155 ACL follow-up: actual local354 inspection found service-role DML on both new diagnostic views through Supabase public default grants.4RED prove metadata rights and actualDELETEwherefalse;355 explicitly revokes mutation, keepsSELECT. The isolated runner previously lost schema-scoped default ACLs onDROPpublic; it now restores exactly those schema definitions before replay. A real PGlite reset model verifies preservation, without application rows/role passwords.46relatedPASS; native355 with restored baseline and local role-denial checks pending. No production migration applied.

### Поточний checkpoint 2026-10-22: локальний355 і browser ownership

354 додає execution ledger до консервативного reference fence;355 закриває успадковані service-role DML права diagnostic views. Повний isolated355:885pgTAP/36files+10nativePASS, clone removed. Локальні354/355 застосовано безreset/auth/Drive changes; реальні SELECT дозволено, DELETE WHERE FALSE відхилено42501. Штатні read-only investigate/inspect після355 PASS, reservation не видається за execution/delivery.

Canonical T155 мав незмінні3001input hashes і13staticPASS, але зупинився уshard1 на PGlite setup10s іstitch inspect5s timeout;805PASS/6skip, повнийPASS не заявлено. Незмінений focused повтор28PASS за4.36s; timeout не підвищувався. Partial lifecycle log не є completed evidence.

T156:4нові ownership regressions відтворили відсутність re-read на reconnect/instance/storage/focus. Fix використовує існуючий connection lifecycle та event-only opaque pulse, без credentials/нового polling;19relatedPASS. Current13staticPASS179s; потрібен fullcanonical; actual multi-browser/native ownership acceptanceT039 лишається окремою. Owner-approved tariff showcase9dca022d не змінювався.

### T156 canonical іT157–158 — checkpoint2026-10-22

Незмінні3002ROOTinputs підтверджено. Canonical T156 пройшов5shards (4009PASS/17skip), уshard6:935PASS/1skip/1FAIL — stale showcase heading спричинив5s wait. Це відтворилося focused без навантаження, тому не класифікується machine-only timeout. T158 виправив тільки2stale tests під acceptedowner heading/plan choice, лишивши authorization denial;6UI+8entitlement=14PASS. Owner showcase не редагувався.

T1571RED→8PASS: новий valid subject тепер замінює старий entitlement навітьзіскорішимexpiry; same-subject expiry не скорочується. Specific2files перенесено післяbasehash verification, runtimeBeta ще не rebuild. Подальший actor binding/revocation фонового виконавця лишається openT034/T038; цейfixнеєйогодоказом. T047 retention draft виконується окремо наізольованіймоделі;6installedguards уже підтверджено, batch/runtimevariantsщеpending. Повторний повний прогін — післяпоточного recovery/identity batch, анепіслякожногодрібногокроку.

### Завершений локальний batch T157–159

98related+13staticPASS72s.356chain885pgTAP36filesPASS; native group11PASS after unchanged retry, clones removed. Local356 applied безreset зі збереженням auth/Drive; actualCLI aftercutoverPASS. T157/T159 development tasks closed, shared final acceptance remains open. Наступний пріоритет: довести failing reproduction та повний actor binding/revocation lifecycle T034/T038; коротший token різного subject fix сам по собі не вирішує цей контракт. Наступний fullcanonical післяпоточногобатчу, попереднійpartialLOG неreconcile якcomplete.

### Наступний блок: identity та durable revocation (T160–161)

Після T157 entitlement зберігає новий subject, але сам worker досі не має authoritative actor binding. Три unit regressions відтворені на реальному worker з synthetic network/process seams: mismatch при load, legacy metadata без actor, identity change під час pending claim. Це не live provider reproduction; жодних Drive операцій не запускалося.

Потрібні серверний actor у desktop receipt, обов'язковий verified native identity callback, journal binding і повторна перевірка перед side effects. Старий unsigned entitlement cache не можна використати як identity proof: підпис має перевірятися також після restart, у межах дозволеного grace. Legacy setup не вгадується. На зміні особи виконавець спершу припиняє нову роботу й зберігає revoking state; pending revocation переживає offline/restart, current/previous refresh може відкликати лише власну делегацію. In-flight enrollment/rotation/process cancellation і secret account separation мають окремі regressions. UI sign-out та accepted entitlement змінюють цей lifecycle; unknown server acknowledgement не перетворюється на success. T160–161 лишаються відкритими, поточні три тести очікувано RED до реалізації.

### T160–161: identity/server foundation implemented, worker still open

ROOT has a signed, bounded entitlement cache and `currentActorId()` that trusts only verified token claims within offline grace. Unsigned legacy cache retains existing license compatibility but never supplies a background actor. Accepted tokens serialize and publish identity only after private atomic cache publication. Restart tampering, grace expiry, simultaneous subjects, failed publication and16KiB limit are covered by entitlement17PASS.

Source migration357 returns the server actor on desktop redeem and adds desktop-only refresh retirement. A current or previous refresh can only retire its own delegation; actor/operation hints are ignored, only its unfinished process operations are canceled, their grants are revoked and canonical cancellation audit is retained. Delegation27/handler14 PASS; initial extra rate-limiter failure was fixture contamination, resolved only inside the new synthetic test group's setup/teardown. No product budget change. Agent typecheck and targeted lint PASS. Native357 and local cutover are not yet performed; running Beta remains356.

Next, require the verified actor in worker construction, persist authoritative binding and fail closed for unknown legacy registrations. Recheck after every async authorization boundary and immediately stop new work on native identity change. Save durable revoking/acknowledged metadata before removing the last protected handle; use distinct credential accounts per delegation so late writes cannot replace another actor's handle. Account-change preparation must stop/cancel and durably mark locally before publishing the next native identity, without blocking sign-in on a network revocation acknowledgement. Revocation retries run independently of tool entitlement, respect server backoff and never claim/process work. Offline, lost rotation reply, shutdown/restart, enrollment races, cancellation/output fences and stale logout must be tested. Cloud sign-out of an unrelated browser actor must not retire the active native actor. Old producer/setup compatibility needs an explicit upgrade path; a protocol marker alone is not actor proof. The three worker regressions remain RED and T160–161 remain open.

### Worker actor binding and durable retirement implemented — checkpoint2026-10-22

The original three worker failures now pass. The callback is mandatory in the native entrypoint, and the signed gate prepares old ownership before publishing the next identity. Setup first obtains a fresh signed entitlement, then validates the desktop server actor against the captured and current native actor. Actor binding, revoking state and positive acknowledgement are journal metadata; credentials remain in distinct protected accounts per delegation. Pending/in-flight enrollment has bounded cancellation flags, so a late redeem cannot undo explicit disable. Unknown identity waits locally and preserves the original checkpoint, while a different verified actor retires the old registration. Offline retirement and confirmed-retirement/secret-delete failure survive restart without claiming work. A newer actor's handle is not overwritten or removed while the older actor's retirement is pending.

114relatedPASS and41final worker/journal/identityPASS; agent/tests/web types and targeted lint PASS. This is source-level development evidence, not live native or two-browser acceptance. Current Beta remains356;357 and the new native source have not been deployed/mirrored. Before cutover, add fail-closed producer compatibility for old desktop/Edge code: a client-only actor check is insufficient if an old implementation can still claim or checkpoint. Version markers are compatibility fences, not actor attestation. Actor-scoped logout and truthful pending/confirmed retirement diagnosis still need implementation/regressions. After those, run native357 and current gates, rebuild isolated Beta, exercise synthetic sequential native actor handoff without provider operations, and repeat inspect/investigate. Native Windows and broader036 remain open.

T160–161 protocol/logout checkpoint (2026-10-22, source only): compatibility fence is GREEN: handler rejects missing/unsupported numeric protocol2 before RPC; forward357 rejects old redeem/claim/checkpoint callers even behind an older Edge. Disconnect remains a cleanup exception. A marker is compatibility evidence, never actor authority. Four protocol/worker files82PASS. Native gate now serializes actor-scoped logout with token acceptance, runs durable retirement preparation before clearing signed state, writes an atomic null cache, and does not clear a newer actor on stale logout. Cleanup compares the verified stored subject even after grace expiry. New paired `/api/entitlement/logout` requires allowed origin and session token while remaining entitlement-exempt. Gate3RED and native route3RED became GREEN; expired-subject cleanup is also covered. Latest7files112PASS. Agent typesPASS; other current checks recorded separately. Browser logout is NOT wired yet: define bounded durable retry when native is unreachable so cloud logout cannot silently leave a restartable old delegation. Retirement diagnostics/native357/live acceptance/full gates remain open. No runtime mirror, migration apply or provider write in this batch; owner-approved tariff UI untouched.

T161 browser lifecycle checkpoint (2026-10-22, source only, supersedes browser-not-wired note): explicit AuthContext logout and external SIGNED_OUT now publish a per-actor native retirement intent before discarding browser identity. A bounded32-entry metadata queue (actor UUID + random intent UUID only; no token/provider data) survives reload. A per-tab serialized publication lane plus shared revision fences token exchanges started before logout. Reconnect drains intents even if the initial health says entitled, re-reads health after retirement, and only then evaluates token exchange. Pending native cleanup blocks new identity publication; cloud signout itself is not held hostage to an unreachable native app. A newer same-actor intent cannot be deleted by an older acknowledgement. Disabled storage has only a bounded in-page fallback, explicitly unrecorded rather than durable.

Evidence:3 behavioral AuthProvider regressions RED→GREEN; original retirement test's first RED was missing-module import only, not a behavioral reproduction. Current6browserfiles40PASS including real ensureAgentEntitlement delayed exchange/retirement overlap, offline queue restart, retained other actors, signout event, reconnect order and fresh health. Browser/test TypeScript and targeted ESLint PASS. Follow-up7tests isolate module state per test. This is development evidence; no live native/Beta migration357/rebuild, provider writes, owner UI change or fullcanonical claim.

Remaining T161 blockers within implementable scope: a persisted browser retry is NOT sufficient if native starts headless and the browser never returns. Add authenticated server-side retirement scoped to the intended actor/installation before session destruction (or another proven server lifecycle seam), with canonical operation/grant fences and no effect on another actor. External SIGNED_OUT with no usable session must remain diagnosable unknown, not alleged server acknowledgement. Native pending/server-ack/local-cleanup stages and browser storage failure need complete privacy-safe CLI evidence. Cross-tab in-flight publication races, native rotation/enrollment, source357 PostgreSQL/live paired verification and final gates remain open. Do not close T160/T161 or broaden retirement to unrelated devices without checking the logout scope contract.

T161 scoped server logout checkpoint (2026-10-22, source only):3 behavioral database regressions RED→GREEN. Source357 now factors canonical per-delegation cancellation into a private owner-only helper. New authenticated `retire_team_recovery_installation(uuid)` derives actor solely from auth.uid(), retires only that actor on the selected installation, revokes bound unfinished-process grants, preserves terminal/unrelated operations and other actor/device delegations, deletes that scope's pending enrollments and is idempotent. Anonymous/helper execution is denied. Setup/redeem/installation logout share one actor+installation advisory lock before row locks, including the absent-row case, so the logout delegation snapshot cannot miss a redeem already racing with enrollment deletion. This still requires real multi-session PostgreSQL proof; model execution is not concurrency acceptance.

Native paired health advertises a non-secret installation selector; public health does not. Browser remembers the validated hint after paired health or setup and never guesses an installation when absent. Explicit logout calls the authenticated server RPC before destroying its session, while native durable retirement runs independently. The request uses a captured JWT, so a concurrent switch to another actor cannot redirect cleanup to that actor. Missing hint/session, refused/malformed receipt, timeout or missing RPC returns unconfirmed, not global retirement. Auth lookup itself is bounded:1RED timeout→GREEN without raising the test timeout; a late lookup after expiry cannot issue the request. External SIGNED_OUT attempts cleanup only with a still-matching usable session and otherwise remains unconfirmed.

Current10files121PASS after the shared SQL lock; agent/web/test TypeScript PASS, targeted lint recorded separately. Types include the draft RPC shape but authoritative local generation must follow the native357 cutover. ROOT source only, W/runtime still356; source357 has never been applied or mirrored. No provider writes, no production mutation, accepted tariff UI unchanged. Remaining: native357 and two-session grant/redeem/logout/rotation races, cross-tab publication, missing-session/failed-server retirement diagnostic coverage, durable pending/server-ack/local-cleanup read-only CLI evidence, upgrade UX and current full canonical/release checks. An unconfirmed cloud retirement does not prove that a headless old worker has stopped; no such acceptance is claimed. T160/T161 and broad036 remain open/NO_GO.

T161 native357 checkpoint (2026-10-22, supersedes native-not-run notes): complete ROOT357 chain replayed in a disposable real Supabase PostgreSQL clone using only schema/role definitions, no application rows or source passwords; scheduler disabled.36pgTAP files/885assertions PASS, plus14real native cases across4files PASS. Three new retirement cases use controlled open transactions and observed pg_stat_activity states, without timing sleeps: redeem-first→logout waits and retires the created delegation; logout-first→redeem waits then AUTH_REQUIRED on the removed ticket; another installation completes while the original transaction remains held. Current SQL hash matches the previously recorded357 source. The clone and volumes are removed (verified docker ps -a prefix empty); source acceptance036 and unrelated037 databases are unchanged. Current Beta/W remain356; no357 apply, source mirror, rebuild, provider action or production mutation.

A separate local persistence audit found2behavioral RED: an old blocked/permission_revoked checkpoint skipped saving a new revoking flag, and a failed first checkpoint save left memory equality that could skip the second durable preparation. Worker now saves even when the blocked checkpoint already matches, before allowing identity publication.66worker/journal/entitlement relatedPASS; current agent/test TypeScript and targeted lintPASS. This is failure/retry/restart development proof, not physical power-loss or Windows acceptance.

T160/T161 remain open. Next: native pending/server-ack/local-cleanup diagnostic stages and agent-readable correlation (do not equate browser receipt/local preparation with server acknowledgement), further delegate/rotation/cross-tab publication races and explicit upgrade UX, then coherent source mirror, guarded local357 cutover/rebuild and synthetic paired two-actor native QA. Current full canonical/release verification and broader036 requirements still pending; overall NO_GO. Proof: drive-followup/t161-native-retirement-proof.json.

### T162 / owner UI checkpoint — 2026-10-22

A two-module/shared-storage reproduction proved that a request already sent by tab A could restore its native actor after tab B received confirmed logout. The earlier in-page lane and storage revision only fenced work before send. The canonical run was canceled for this confirmed source defect, not observation timeout; two completed shards (1659PASS/8skip) are partial evidence only.

The native gate now checks a paired-only opaque revision inside the same serialized lane as identity publication and retirement. A fresh boot, a published different actor, and every actor-scoped logout (including nonmatching stale logout) invalidate outstanding revisions. Same-current-actor renewals preserve their revision. The revision selects ordering, never authority: pairing, origin, signature, private cache and durable ownership preparation remain required. Web drains pending retirement, captures the native revision before cloud issuance and submits it with the token. A local revision check after the reply prevents a stale success projection. The complete exchange keeps its six-second abort deadline. Older native without actor-bound recovery keeps legacy entitlement exchange; actor-bound native without the revision requires upgrade.

7new tests were RED, including a two-browser-module test through the actual native API; all7 became GREEN. One initial RED also covers absence of the new metadata contract, rather than a separate runtime defect.98related testsPASS before the broader repeat. New journal refusal has only a closed reason, no actor, signed token or revision; code-map and notable-journal mapping point to the origin. Live paired handoff/capture/CLI and current full gates remain open.

The owner explicitly requested removal of the Local operations header summary. Its entry and obsolete summary tests were removed; current batch progress and underlying processing continue through their existing path.9existing UI testsPASS; the Chrome QA workspace visibly no longer shows the summary. Owner-approved tariff selection files were not changed.

### T164 — native journal identity/boot attribution — 2026-10-22

Actual source-run Beta passed the signed X/W2→A native handoff in under two seconds: server actor binding, protected handle presence, durable old-actor retirement, stale X token refusal409, stale X logout preserving A, server revocation, actual Keychain absence and final signed A restore. No provider write or provider-connected W2 existed. The first harness preflight used a16-digit diagnostics cursor outside the API's15-digit limit; corrected only the private harness, not the product.

The subsequent real diagnostic capture failed before ingestion: the native entrypoint generated24hex characters but web forwarding and database ingestion require a UUID. The entrypoint also returned an ISO startedAt while the consumer only used numeric epochs to filter retained records. This was an actual producer/consumer gap, not repaired by inventing an adapter UUID.

The original boot creation was factored without changing behavior;7new forwarder/attribution regressions were RED. The real boot factory now returns a UUID plus the existing ISO timestamp. Forwarding requires the answering instance to match the captured one, parses ISO or numeric boot time, and forwards only records at/after that boot boundary. Unknown/malformed instance/start time remains unforwarded with no false cursor receipt. A missing/reset cursor no longer relabels a previous boot's tail; those records remain local with unknown original boot.124related/6filesPASS. Current types/static checks, rebuild and real capture/CLI repeat remain required; this is not automatic Beta analytics or broad036 closure.

### T164 verified runtime checkpoint — 2026-10-22T19:47Z

T164 candidate mirrored/rebuilt у W:268tests/21files та13static gatesPASS. Живий native boot UUID `3c94b07d-a869-42f3-8ac8-8eafb15ddc77`; повтор X/W2→A PASS, stale token409, stale logout preservesA, server revocation/actual Keychain cleanup і finalA restore підтверджені. Actual native journal→explicit local authenticated capture→existing SELECT-only ROOT CLI PASS:3retirement stages +1publication refusal,4accepted/0rejected; investigate повертає fact. Звичайна beta analytics вимкнена. Capture observed underA не доводить actorX attribution. Browser-only/session-loss, retained previous-boot provenance і full canonical/release/широка036 лишаються відкритими.

Web diagnostics response now declares ISO or numeric startedAt, matching the real producer. The first static attempt correctly failed this mismatch; after correction all13 static gates and268 related tests passed on3022 unchanged frozen inputs. Guarded mirror included28 runtime files and preserved the approved tariff window. Proofs: `t164-static-proof.json`, `t164-related-proof.json`, `t164-mirror-candidate.json`, `t161-paired-native-handoff.json`, `t161-native-journal-diagnosis.json`. These are development evidence, not exact-SHA promotion.

### T166 source checkpoint — retained journal provenance (2026-10-22)

Current Beta remains the verified T164 runtime. T166 is source-only and not yet accepted live. Newly produced records retain `agentInstanceId` plus per-boot `instanceSeq`; the local `seq` remains a monotonic file cursor, preserving031 persistence/rotation. This implements033 fresh sequence per boot on the ingestion wire without destroying local historical pagination. Legacy records are never assigned a fabricated producer. Malformed stored binding is refused.

Native history requires explicit `journal=bound-v1` and returns `journalProvenance=bound-v1`. The default response of a configured native journal includes only its current boot, so old web clients cannot relabel retained history. New web clients send contiguous producer groups under their original UUID and per-boot sequence, with at most five bounded fetch/send iterations; the physical cursor advances only after acknowledgement. Cursor v2 replays history that v1 clients may have skipped; server uniqueness handles duplicate delivery. No SQL migration or automatic beta analytics is introduced.

Initial producer tests2RED→GREEN and historical-forwarding1RED→GREEN.139related tests passed before the added native API opt-in and old-cursor migration regressions. Fresh related/static checks, actual native restart, real local capture→read-only CLI and full canonical/release remain pending. T166 remains unchecked; browser-only/actor attribution gaps stay explicit.

### T166 actual restart and product-forwarder checkpoint — 2026-10-22T20:02Z

30runtime files guarded-mirrored after184related/7files and13static gatesPASS on3023 unchanged inputs; W rebuilt using official beta down/up. Owner tariff window preserved; schema357 and profile inode104616221 unchanged. Real X/W2→A handoff repeated successfully, finalA restored, no provider writes. First T166 boot `ffd5eb68-ab71-42a4-a300-2b299082112f` produced3retirement stages carrying original boot/per-boot sequence. No server capture before restart. Official beta down/up then produced UUID `2e2911ec-6720-4bde-9804-7e93eac3f421`, with boot sequence1 and the prior3records intact.

The actual ROOT product forwarder (bundled only to run in Node with explicit local transport/auth adapters) delivered22real records, then replayed22duplicates after cursor clearing, rejected0 and created no duplicate rows. Each trigger retained the≤5fetch/send budget. Existing SELECT-only reader and ROOT CLI returned all3old-boot retirement records and a completed fact under the original boot; current boot seq1 was also confirmed. Native default response served only the current boot for old clients. Proof: `drive-followup/t166-retained-journal-live.json`. The first private harness preflight incorrectly expected paired health.ready; corrected to paired.ok plus public.ready/idle before any ingestion. Its failed result is retained.

Automatic Beta analytics stays disabled. Explicit test adapters do not prove unattended browser trigger delivery; observed-underA does not prove actorX attribution. Legacy unbound history remains unknown. Browser-only/session-loss diagnosis, full canonical/release and broad036 remain OPEN/NO_GO. Added explicit rotation/provenance and bound-history legacy exclusion regressions; current repeat and complete canonical pending.

Final T166 affected repeat:186tests/7filesPASS, including provenance across file rotation and legacy bound-page exclusion. Production source unchanged after the successful live mirror; only two test cases and planning records were added. Next is a fresh complete canonical fast verification, retaining shard diagnostics and whole-suite transition observations. No full result is claimed in advance.

### T168 correction — old/new web sequence identity (2026-10-22T20:16Z)

Read-only actual native inspection exposed a defect in T166 compatibility: default API returned physical seq637/638 while bound-history forwarder ingested those same current-boot records as seq1/2. The same semantic fact could therefore have two server uniqueness keys when old/new web coexist. Prior T166 actual-forwarder/restart proof remains valid for its tested path, but did not cover cross-version ingestion identity. T166 is reopened for this correction.

The complete canonical run was intentionally terminated for this confirmed defect, not an observation timeout: exact owned wrapper and5descendants verified, only owned descendants SIGTERM. Terminal wrapper exit1 retained shard1:839PASS/0fail/0skip, partial only. Proof: `t166-full-canceled-for-cross-client-defect.json`. Do not reconcile that incomplete transition log as a whole-suite result.

2native API/sequence regressions RED. Default API now filters/paginates in per-boot sequence and uses that same head for an empty page; explicit bound history keeps physical cursor plus original producer sequence. Current related/static/live old+new ingestion/replay repeat and a fresh full canonical remain pending. Beta still runs the pre-T168 candidate until guarded update.

### T168 live cross-client correction verified — 2026-10-22T20:23Z

186related/7files and13static gatesPASS on3023 unchanged frozen inputs, then guarded30file mirror and official Beta down/up. Current boot UUID `775b2ddf-49d6-4d1d-9460-785ed1a2e91e`; actual paired X/W2→A handoff repeatsPASS, finalA restored, protected handle removed, providerWrites0. Owner tariff window/profile/root/schema357 preserved.

Old-format API seq1 was explicitly delivered to the local ingestion RPC first. The actual current ROOT product forwarder then delivered bound history and replayed after cursor reset:18accepted,64duplicates,0rejected across bounded runs. Existing SELECT-only ROOT CLI proves exactly one current-boot seq1 fact and the original3retirement records still under producer UUIDffd5eb68. Current/old clients now share the same uniqueness key. Proof: `t168-retained-journal-live.json`; no fabricated metadata, no automatic beta analytics. This closes the narrow T166/T168 development correction; browser-only/session-loss/actor attribution, complete canonical/release and wider036 remain open.

Additional real browser-function tests (Node transport adapters, no native calls) passed missing/mismatched sessions, other-actor isolation, server revocation, repeated idempotent retirement and loss before write/after commit. A committed action with a lost reply remains client-unconfirmed until a successful retry. Own synthetic delegation cleanup confirmed. Proofs: `t167-browser-only-live.json`, `t167-browser-only-loss-live.json`. These prove function/server behavior, not physical-browser signout UI or complete diagnostic coverage. T167 remains required.

### T168 complete canonical checkpoint — 2026-10-22T21:02Z (local 2026-10-23)

The complete canonical fast verifier finished successfully:14/14gates,6873tests total =6847PASS+26conditional skips,0FAIL;2175seconds. All3023frozen input hashes and the complete Git input path set stayed unchanged. The dedicated wrapper ended0 and retained all8shard reports. Actual source-run Beta remainsT168, not an exact-SHA package or promotion record. The subsequent lifecycle reconciliation used the completed whole-suite log with REPORT set and LOG unset:106PASS. It did not append observations to the report it checked. T165 current-functional/full-fast verification is now satisfied; release form and broader036 acceptance remain open.

Proofs: `drive-followup/t168-full-proof.json`, `t168-full-canonical-result.json`, `t168-full-suite-details.json`, `t168-full-transition-reconciliation.log`. Conditional skips include signing/notarization, separately gated real media/translation/power and disposable PostgreSQL runs; they are not PASS/N/A. Current schema357 real PostgreSQL evidence remains separate from this fast command. New T167 work exists only in `/Users/daynero/RiderProjects/AffSupport-036-next`; it is not covered by these T168 results or mirrored into the running Beta. No production deployment/migration/release was performed.

### Isolated T167/T169 development checkpoint

T167 now has actor/attempt/time-bound receipt-to-browser terminal correlation:24related tests across3filesPASS after4new integration failures. Conflicting, malformed and truncated evidence remains unknown; native cleanup is never inferred. Its358migration remains disposable-only (919pgTAP+14nativePASS). No Beta cutover. Current isolated seed/static verification passed13/13gates in118seconds after restoring4external workspace dependency links; no new full verification is claimed.

T169 is open: old logout can erase a replacement session. The isolated provider generation fence passes10tests but an independent real-SDK synthetic transport proves the deeper session-deletion race remains. Fix the session ownership invariant and repeat acceptance before treating logout as safe. See the two new checkpoint JSON artifacts; T168 full evidence applies only to its frozen base.

### T169 isolated product coordination checkpoint

Shared cooperative session lane is implemented in NEXT across all6current interactive SDK writer routes; raw upstream dependency remains unchanged. Current auth SDK/provider/UI/handoff/architecture/code-map repeat:56PASS/6files. Current isolated seed/static:13/13PASS121seconds. Closed failure codes are shared and mapped. This is not complete diagnostic coverage: typed signal production, capture/ingestion/read-only CLI and session-loss blind spots remain acceptance work. Real SDK handoff/PKCE/ID-token/refresh interactions and physical two-tab proof remain open. CUA repeated native-pipe failure; Beta remains idle/readyT168/schema357. Guarded merge/cutover and full036 remain required.

### T169 pending OAuth intent and typed diagnostics increment

A real SDK regression proved that session identity alone missed a newer OAuth intent: A old logout removed the new PKCE verifier before B had a session (1RED/16PASS). A project-scoped opaque intent revision is now captured before retirement and compared under the shared lock. All current sign-in writers advance it; Google preparation/handoff publishes intent before its external asynchronous step, and local provider generation advances at intent start. Only one opaque revision is stored, never the owner session or credentials. Missing/corrupt/unwritable coordination state has a closed failure code. Current SDK/provider/UI/handoff/code-map/architecture run65PASS/6files, before observer wiring.

Typed logout observation is implemented: requested, acquisition and at most one SDK terminal through the actual ProductAnalytics actor fence. Loss or replacement of identity suppresses the late old-actor outcome instead of relabeling it. A mixed-actor inspect regression was1RED/2PASS; current CLI guards that capability's actor ownership and leaves ambiguous terminals/last-proven stage unknown. Current producer/CLI/audit/code-map related run24PASS/4files. This uses real typed wire production and real CLI SQL against in-process PostgreSQL, not actual beta collector acceptance. Current wider auth/audit/inspect/registry/T167 repeat81650 remains pending at this checkpoint. New static/full checks remain required. T169 stays open; beta/profile/root/schema357 unchanged.

### T169 actual guarded collector checkpoint

Current isolated related run114PASS/12files (47.07seconds); current seed/static13/13PASS119seconds after adding the closed flow discriminator to CapabilitySignal. Preserve initial type-check failure; no casts or weakened closed list were used.

Actual NEXT typed ProductAnalytics producer + the existing explicit dev/beta namespace capture + real fixture password authentication delivered6/6events to the running local collector,0dropped/0pending. Automatic beta analytics remains false; no local-dev-auth flag. SELECT-only NEXT CLI verified closed shared-state refusal with exact code location, superseded intent/cancelled boundary and a missing terminal after analytics identity replacement. Audit stays partial for that missing outcome. Existing local reader was verified read-only; profile guard and live boot preserved. No native requests, cloud logout or provider writes occurred. Node window/storage/lock and session-loss adapters are explicit; this is not a physical two-tab/Web Locks or real-user logout pass. Proof: `t169-logout-diagnostic-live.json`, plus selected source hashes. Schema remains357 and the running beta remainsT168; T167358receipt cutover, guarded merge and current full verification are still required. T169 remains open for broader/physical acceptance and old non-cooperating tab compatibility.

### ROOT source merged, runtime cutover still pending

Reconciliation found32safe owned deltas,2independently updated documents and1already-equal contract. Only the32safe files were atomically copied with prechecked source/target hashes. Owner tariff files and independent ROOT plan/tasks/report were preserved. ROOT contains the candidate now; running W beta remainsT168/schema357. T170 records the fresh merged verification requirement. Beta up alone cannot apply358; preserve the connected profile and inspect/prove a guarded local incremental path before any schema mutation. Never reset/reconnect implicitly.

ROOT merged seed/static is now13/13PASS135seconds, distinct from full/release verification still required byT170. W local history357/357matches repository with0mismatches; explicit local incremental CLI support was inspected read-only. No schema or runtime cutover has occurred. Preserve the connected profile and verify only the tested358migration is pending before proceeding.

### T170 beta358 cutover and actual receipt acceptance

Applied only tested migration358 through the pinned explicit-local CLI after verifying all357existing migration files/history matched and runtime idle. Migration hash matches disposable919pgTAP+14native proof. No reset/reconnect: connected Drive binding hash/count, profile/pairing, original retirement RPC and sweep body preserved; cleanup coverage remains verified. Six runtime files mirrored with base/source hash checks, six owner tariff files unchanged. Official beta down/up completed: new native UUID14d284e2-b54a-436a-b6df-75be244c1621, real entitlement enforced, new web lane module served and358schema retained.

Actual ROOT function + real synthetic X/W2 and A authentication/Edge/RPC + guarded typed capture delivered8/8events,0dropped. A cannot retire X; missing/mismatched sessions do not issue scoped requests; pre-write loss has no receipt; committed reply loss is server-confirmed/browser-unconfirmed; cached attempt preserves a fresh setup; matching/repeated receipts confirm; original numeric endpoint remains compatible. SELECT-only ROOT CLI proves these distinctions and excludes A's chosen attempt UUID colliding with X's actor ID. Own delegations cleaned; native/provider requests0 for this browser-function harness. No physical signout UI claim.

Native X→A handoff repeatedPASS on the new boot: server revocation, protected-handle removal and final A restoration confirmed, providerWrites0. Retained original-boot3records, current-boot seq1 old/new unique-key agreement and cursor-reset replay repeatPASS through actual forwarder/RPC/readonlyCLI. Public proofs: `t170-local-358-apply.json`, `t170-runtime-cutover.json`, `t167-observed-receipt-live.json`, `t170-paired-native-handoff-repeat.json`, `t170-retained-journal-repeat.json`.

A final inventory regression was RED: receipt-capable databases must not still claim browser server outcome is universally unobserved. Native cleanup remains unobserved separately; legacy missing projections retain the old explicit gap. Corrected query/inventory plus legacy investigation's explicit unavailable-receipt expectation:49PASS/4files. `docs/BETA.md` now documents the proven preserve-profile incremental path. Current full/release verification remains pending; T170 full canonical starts next on frozen current ROOT inputs. No production action or promotion.

### T170 terminal frozen full verification — 2026-10-22T23:56Z

Canonical fast verification finished successfully:14/14gates,6917PASS+26explicit skips=6943tests; all8retained shard reports have0fail/unknown/errors. Terminal validation proves all3042source inputs and the complete3043Git path set unchanged against the T170 freeze. Whole completed transition log reconciliation passed106tests with REPORT-only and LOG unset. Proof: `release/acceptance/acceptance-036-fresh-20261021/drive-followup/t170-full-proof.json`. This closes current fast/full evidence only; T170 remains open for relevant release-form/build/database contracts. T167/T169 physical two-tab and older non-cooperating tabs remain explicit limits. Broader036 verdict remains NO_GO; isolated NEXT adoption schema is excluded from this frozen result.

### Clock lifecycle and physical-browser checkpoint —2026-10-23 07:57Z

Clock cleanup now uses the same ordered namespace/global advisory locks as its setter. The fixture cleanup orchestrator restores real tariff time before deleting application or Auth fixtures, refuses foreign overlays before deletion and supports interrupted Auth cleanup retry without requiring already-deleted users. PG18 NOT NULL catalog entries are accepted only after exact required-column validation. Current combined related repeat17PASS/3files: PGlite teardown6, runner8 and actual cleanup orchestration3 (GoTrue/local-stack/private-receipt adapters). Native full attempt:942pgTAP PASS and20/21native PASS; initial rollback test setup used a text argument in a UUID position. The corrected focused native repeat replayed all359migrations in a fresh disposable database and passed7clock tests, including actual rollback/forward and synthetic row preservation. It did not rerun pgTAP or manufacture a full canonical result. Current static12/13PASS; format timeout retained; isolated affected-gate repeat PASS.

Physical Chrome: two newly owned local synthetic accounts, two incognito tabs. Signout propagated without reload; replacement login propagated. Onboarding completion did not refresh the sibling cached profile, which corrected after reload. Private window closed; main owner explorer remains connected and native actor A/profile/pairing preserved. This is ordinary shared-session behavior, not proof of delayed logout/pending OAuth or old non-cooperating-tab races. Public evidence: `browser-session-two-tab-proof.json`, `browser-session-profile-preservation.json`. No provider writes, membership grants, original-user mutations or production changes.

Current focused clock lifecycle proof: `clock-lifecycle-proof.json`;17related testsPASS and7native testsPASS. Static attempt12/13PASS with format timeout; affected format repeatPASS. No current full canonical PASS is claimed.

### T172 completed —2026-10-23

Profile synchronization now publishes only an opaque project-scoped invalidation; each recipient reads its own RLS profile, with10second abort, coalescing and activation fallback. Delayed reads and writes cannot overwrite a replacement actor or a completed local write; SDK SIGNED_OUT still permits its own logout cleanup. Initial3RED reproduced the stale sibling and old-actor overwrite. Final80related tests/8filesPASS; ROOT additive merge50tests/4filesPASS; NEXT web/all-test typechecks and targeted lint/formatPASS. Initial static timeout and two implementation errors remain recorded rather than erased. Source update and recipient refresh have independent typed, actor-fenced diagnostics; actual local collector7accepted/0dropped and SELECT-only CLI prove failures, recovery and explicit missing-terminal uncertainty.

Physical Chrome two-tab onboarding and name change/restoration passed without reload or second onboarding submit. Own private window closed; original A/native profile/pairing/Drive and schema358 preserved. Owner tariff files and concurrent ROOT launch-defaults registry retained. Proof: `t172-profile-sync-proof.json`. Full current canonical T170 and broader036 remain open. T173 records an independently observed verifier timeout orphan; this is not a diagnosis of prior machine freezes.

### User-requested current Launch UI beta restart — 2026-10-23

Mirrored14exact ROOT files for the latest Launch account selector/defaults UI and its shared/schema dependencies into retained beta, with private preimages and hash guards. Official beta:down/up completed; new boot6c8c5f7b-aa1f-4def-985a-22515212a65c. Guarded local migration up applied only20261206140000_launch_offer_defaults: beta now has359migrations. Profile inode, pairing and original Drive binding preserved; no reset or production change. Chrome original owner session visibly loads Explorer, Launch list and new form with account combobox and offer/workspace defaults. User is checking this UI; do not restart or change that live worktree while independent NEXT work can proceed. Proof:`ui-launch-restart-proof.json`.

The timestamp collision was resolved in NEXT: clock is20261206141000, following Launch359 and reference-fence360. Combined361 migration replay and actual rollback/forward are verified; retained beta remains359. T016 containment hooks have focused passing proof but remain unmerged and incomplete for full fault/capture lifecycle. T011/T012/T016 remain open; historical359clock-only proofs are not current combined-chain acceptance.

### T014 native contention checkpoint — 2026-10-23

NEXT now includes `tests/acceptance-mail-capture-postgres.test.ts` in the isolated database runner. Three real concurrent-session cases pass after correcting clone ownership to match observed local beta and asserting actual SKIP LOCKED semantics. The recording-failure case explicitly proves its callback was reached before rollback/reclaim. Preceding full database run passed948pgTAP/39files and21existing native/5files; the corrected mail file was rerun alone against a fresh full361 clone (3PASS), not represented as a repeated full canonical pass. Lint and all-test types pass. Proof:`t014-mail-native-proof.json`. Retained beta/data/Drive remain unchanged. Next: bound stalled filesystem capture, prove guarded live CLI/JWT/overlay and full notice/diagnostic variants before closingT014.

### T014 asynchronous recording timeout — 2026-10-23

Reproduced indefinite callback wait (RED after6500ms), then added5second per-record/30second recording-phase deadlines in NEXT. Timeout returns explicit captureUnconfirmed and prevents later callbacks/DB finishes before rollback. Late immutable artifact is safely verified on retry. Final98related tests/6files and4native PostgreSQL tests/1filePASS; native run uses fresh full361 schema clone, no source rows/passwords. Format/lint/isolation guard/scripts types/all-test typesPASS after correcting result shape and test-only callback annotations; failures retained. Proof:`t014-mail-deadline-proof.json`. No root code merge, live-beta restart/data/Drive mutation or production action. Next unresolved boundary: frozen event loop needs server-side lock timeout; uninterruptible OS IO may still retain CLI process despite released transaction. Live CLI/JWT/clock and full variants/diagnostics remain open, soT014 stays unchecked.

### T014 frozen-process DB protection — 2026-10-23

RED native reproduction blocked the entire Node event loop for17seconds. Added transaction-local PostgreSQL15second idle timeout; initial diagnostic test caught25P03 being delivered through rollback rather than an idle socket event, and both paths now preserve DATABASE_IDLE_TIMEOUT. Final5native casesPASS on fresh full361 schema clone,98related testsPASS, format/lint/source guard/scripts/all-test typesPASS. Backend disappearance and subsequent claims with attempts=1/sent_at=null prove server rollback and release, independently of JS timers. All disposable containers removed; retained beta/Drive and production unchanged. Proof:`t014-mail-process-stall-proof.json`. Remaining next boundary is CLI termination with uncancellable OS file IO, then guarded live CLI/JWT/clock and full notice/report acceptance. T014 remains open.

### T014 live CLI and seven-kind bilingual matrix — 2026-10-23

Retained beta359 accepted actual guarded NEXT mail-capture CLI without source migration/restart. One new synthetic X/W2 granted notice captured locally, skipped in DB with attempts1/sent_atnull; replay claimed0. Removed only the created UUID. Initial/final original notice digest, schema, clock absence and agent instance match. Private artifact hash and receipt retained. Added14 cases for all7kinds in both locales through actual SQL due/claim/finish and immutable redacted file/replay;112related tests and all static gatesPASS. Proof:`t014-mail-live-variants-proof.json`. No Drive or production access. Next scope audit should distinguish completed adapter work from T011/T012 overlay/JWT and T044 updater acceptance; avoid treating a baseline359 live capture as clock-overlay proof. Running-updater/report linkage, unverified OS-pending CLI termination and integrated/root merge remain open.

### T014/T044 producer and scope checkpoint — 2026-10-23

Added actual catalog companion plus authenticated updater save/stop fixture in disposable SQL. Four locale×running cases prove actual scheduled grace queue→claim→renderer→immutable file→skipped receipt, warning absent when stopped, and repeated scheduled producer dedup.113related tests/6files and all static checksPASS; no live DB/provider or production changes this checkpoint. Proof:`t014-mail-updater-proof.json`. Original adapter requirement mapping and next guarded ROOT integration dependencies are now explicit in `contracts/mail-capture-acceptance.md`; T014 stays open until ROOT integration is proven. Clock/JWT belongs toT011/T012, complete owner UI toT044, containment toT016 and full canonical/release toT048/T170. Unverified OS-level CLI termination remains a stated limit, not a claimed capability.


### T178 execution checkpoint — 2026-10-24

Current full-verification milestone T170 passed22/22release gates on a frozen3117-path snapshot, with7265passed/41skipped tests,81.37%coverage and completed module/transition-log reconciliation. That proof predates subsequent fault-tool follow-ups. No packaged/hosted/full036GO is implied.

Fault tooling now has pre-acceptance intent binding and distinct operation/scan-request authority; real Auth upload/status/scan response-loss/replay tests preserve the original profile/root and clear their fixture. Provider listing cursor injection matches the actual400/pageToken parser contract; changes-feed expiry remains unproved. A registered native fixture proves real RecoveryJournal checkpoint/crash/cold load and unrelated-process preservation, but cannot substitute for authenticated RecoveryWorker execution/lease/refencing. Next implement that closed resource/runtime binding and actual native/browser delivery seams; continue T180/T179/T181 dependencies without introducing production activation metadata or fake completion. Hosted target configuration remains requested and unverified; native Windows remains owner-excluded.
