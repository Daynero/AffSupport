# Implementation Plan: Швидкий міні-реліз без оновлення агента

**Branch**: git `main`, не змінювалася; feature context `043-mini-release` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Input**: `specs/043-mini-release/spec.md`

## Summary

Додати режим `mini` у чинний release runner. Він заморожує незалежні бази вебу/сервера та випущених агентів, доводить сумісність кандидата, перевіряє нові байти й застосовує лише потрібні поверхні. Версії, теги, assets та signed manifest агентів незмінні. Доступні web-only, backend-only, web+backend та explicit web recovery. Жодного packaging, Windows dispatch чи підписання manifest у mini registry.

Це план реалізації, а не виконаний флоу. Поточний запит завершується планом, tasks, двома незалежними аналізами та виправленням знайдених прогалин. Runtime-код і production у цьому етапі не змінюються.

## Technical Context

**Language/Version**: Node.js 22.12–24, ESM `.mjs` для релізу; TypeScript strict для серіалізованих контрактів, web і analytics; SQL для ізольованого приймання БД.

**Primary Dependencies**: чинні release runner/worker/controller, journal, target ownership, worktree, resource admission, `verify-all`, TypeScript compiler API із наявної залежності, Vite, Vitest, наявний `pg`, Supabase CLI/Management API та Cloudflare Pages API. Нових npm dependencies не потрібно; SQL-класифікатор підтримує вузьку граматику з відмовою для решти.

**Storage**: приватні fsync/atomic JSON/NDJSON у чинному runner root, спільний target store поза видаленими worktrees; ізольована disposable БД для rehearsal. Нової production-таблиці для релізів не потрібно.

**Testing**: регресії в `tests/mini-release-*.test.ts`, існуючі release/beta/backend/analytics тести, одночасно один worker; disposable PostgreSQL/локальна beta та browser journey. Portable contract tests не видаються за native runtime PASS.

**Target Platform**: macOS release host; сумісність клієнтів macOS arm64 і Windows x64; web у підтримуваних браузерах; чинні Cloudflare/Supabase цілі.

**Project Type**: розширення існуючого CLI/worker з діагностичними web/backend seams.

**Performance Goals**: SC-002: 9/10 web releases до 10 хв, backend/DB до 15 хв; recovery до 5 хв; свіжа вкладка до 2 хв. Час включає gates і rehearsal. Не досягнутий бюджет не дозволяє пропустити safety gate.

**Constraints**: жодних production-записів під час планування/аналізу; чинні G0/042 blockers; реальні auth/entitlement; нуль installer rebuild/version bump; bounded diagnostics; одна важка локальна команда; незмінність exact bytes, цілі та intent на resume.

**Scale/Scope**: один керований письменник на ціль для full/mini/recovery/backend apply; кілька міні-релізів між випусками агента; мінімум 20 eligibility fixtures і 10+10 timing runs. Масові backfill, rotation секретів та provider consent поза автоматичним scope.

## Constitution Check

| Principle / gate                           | Before research                                | After design / implementation obligation                                                                                                              |
| ------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Typed contracts and boundary validation | PASS: невідомі входи звужуються                | versioned mini intent/evidence, closed outcomes, validators + hostile-input tests                                                                     |
| II. Release/protocol single source         | PASS для дослідження; поточні gates не змінено | незмінні signed manifest/agent metadata; mini activation залежить від окремої ратифікації запропонованої зміни [governance](contracts/governance.md)  |
| III. Least privilege                       | PASS                                           | read-only observations/analytics; write credentials лише у release adapter; RLS/role regressions; sandbox disjointness                                |
| IV. Resources/processes                    | PASS                                           | існуючі execute/admission/timeouts; worker fencing; жодного spawn з продуктового agent-коду                                                           |
| V. Stable error conventions                | PASS                                           | чинний release envelope; closed mini codes; unknown зовнішнього ефекту не перетворюється на retry                                                     |
| VI. Frontend/state                         | PASS                                           | reuse analytics/support seams; без нового polling, UI або reload активної роботи                                                                      |
| Verification / governance                  | PASS для design                                | `npm run verify` і релевантні release gates; mini profile через той самий aggregator; runtime production до ратифікації та sandbox acceptance BLOCKED |

Конфлікт з чинною вимогою exact-SHA packaged-beta для нового веб-коміту та unchanged shared inputs не приховується. Дизайн не послаблює full-release правила. Окремий draft amendment готується поза analyze, а production mini activation відмовляє до перевіреної ратифікації саме mini-політики. Наявна перевірка рядка `2.0.0` та старі sandbox runs цього не доводять.

## Project Structure

### Documentation (this feature)

```text
specs/043-mini-release/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── mini-release.md
│   ├── verification.md
│   ├── governance.md
│   ├── executor.md
│   ├── migration-history.md
│   └── support-matrix.md
├── tasks.md
└── reviews/                 # independent reports and remediation ledger
```

### Source Code (repository root; planned paths)

```text
packages/shared/src/release-runner.ts
scripts/release-runner.mjs
scripts/release-worker.mjs
scripts/lib/release/{intent,steps,flow,state,recovery,store,activation}.mjs
scripts/lib/release/{target-ownership,controller,controller-runner}.mjs
scripts/lib/release/mini/
  {contracts,baseline,impact,policy,evidence,artifacts,adapter,rehearsal,preview,db-executor,history,executor,recovery,diagnostics}.mjs
scripts/lib/release/adapters/{backend,supabase-backend,web}.mjs
scripts/{deploy-web,rollback-web,verify-beta-promotion,verify-all,release-web-meta}.mjs
scripts/{verify-beta-package.sh,verify-beta-runtime.mjs}
apps/web/{vite.config.ts,src/vite-env.d.ts}
apps/web/src/{analytics/service.ts,support/diagnostics-bundle.ts,build-identity.ts}
scripts/analytics/{deployments,coverage-registry,investigate,queries,schema,sanitize,types,code-map}.ts
config/{mini-release-policy,mini-release-support}.json
tests/mini-release-*.test.ts
scripts/verify-mini-release.mjs
specs/043-mini-release/acceptance/{cases.json,run.mjs} # harness + generated local evidence refs
```

**Structure Decision**: оркестрація залишається у чинному worker. `mini/` містить окремі перевірювані policy/evidence helpers, не другий runner. Наявні `deploy:web*` залишають повні guards; mini adapter викликає exact-byte uploader після власного повного admission, а не rebuild-команду `npm run deploy:web`.

## Phase 0 — Research decisions

Рішення та перевірені обмеження наведені у [research.md](research.md). Ключові: actual payload hashes замість поточного `release.json` digest; independent surface baselines; semantic shared impact із fail-closed fallback; restricted SQL grammar + runtime/role proof; provider observations + live bytes; target-wide fencing з делегуванням controller→worker; exact candidate beta journey без пакування агента.

## Phase 1 — Design and execution architecture

1. **Immutable identity and baseline**: schema-v1 full intent незмінний; schema-v2 mini intent містить mode, operation, exact commit, target/binding, agent/surface baseline, policy та change-plan digests. Операторська команда `release mini --source <ref> --target <id>` формує draft шляхом read-only discovery, генерує UUID/digests і передає його в existing start; `--prepare-only` повертає reviewable intent без effects; `start` заморожує його й worker перевіряє повний digest. Environment не змінює план/ціль після acceptance. Baseline береться з незалежної поточної observation та перевірених receipts, не з останнього tag або локального HEAD.
2. **Bootstrap and missing baseline**: importer читає live signed manifest, authenticated provider identity, доступні exact assets і source lineage; зіставляє з архівом/receipt. Старі receipts без exact identity не підвищуються до proof. Якщо початковий веб/сервер неможливо довести, preflight повертає `BASELINE_UNPROVEN` і конкретно відсутній доказ; звичайний реліз або контрольована окрема baseline attestation потрібні до першого mini. Ручний `compatible=true` не замінює доказу.
3. **Selected registry**: full зберігає поточні steps. Mini registry: `mini_preflight → mini_checks → mini_rehearse → mini_build → mini_verify → mini_backend_apply → mini_activation_verify → mini_deploy → mini_live_verify → mini_finalize`. Backend-only не будує/деплоїть веб; web-only не запускає DB rehearsal/apply. Кожна незастосовність має receipt із причиною. State, dependency validation, journal recovery, status, panel projection і metrics використовують одну selected registry; completed IDs з чужого режиму або невалідним порядком відхиляються.
4. **Concurrency and isolation**: operational prerequisite — один trusted release host/write authority для цілі; інші CI/manual deploy credentials не можуть писати паралельно. Це явна довірена передумова, не гарантія local lock проти адміністраторського втручання на іншій машині. Якщо її немає, mini writes blocked до окремого shared remote lease design. Provider APIs не вважаються remote CAS за замовчуванням. Unknown in-flight command від попереднього процесу блокує takeover до reconciliation. Worker утримує target claim і machine admission; controller делегує worker право тим самим fencing token, а не конкурує з ним. Direct CLI проходить той самий activation/claim шлях. Старий worker не може писати після takeover. Backend-only apply і web recovery теж використовують claim; старі ручні entrypoints відмовляють за активного claim. Lock root стабільний для worktrees/CLI/controller; journal store override не створює другий write-lock namespace.
5. **Agent independence**: compare всі agent/package/runtime/config/protocol inputs з agent baseline, а changed web/backend — зі своїми deployed commits. Hard-reject агентного виконання, packaging, contract requirements та agent dependency graph drift. Для shared/lockfile web-only винятку compiler-based analysis включає runtime module evaluation, type use на agent-facing межах, re-exports, generated schemas та package resolution; зіставляються reachable emitted runtime і relevant declaration/contract fingerprints з trusted baseline. Type-only або unreachable/pure web change допустима лише за рівних захищених fingerprints. Dynamic import/eval/unresolved resolution/side effects або невідомий генератор → unknown/blocked. Shadow compile для аналізу допустима; installer packaging заборонений.
6. **Bounded DB policy**: exact plan включає dependency closure функцій, immutable migration contents і concrete fixture/check IDs. Вузький tokenizer/statement grammar розпізнає additive cases, коментарі, quoted/dollar strings; unsupported SQL блокується. Нові nullable columns без rewrite defaults та isolated new objects можуть бути eligible; indexes мають окремий transaction/lock proof. RLS/functions дозволені лише зі старими/новими role+data contract tests; regex і авторське `compatibleWithPrevious` не є proof. Стандартні межі: lock wait ≤2 s, statement ≤30 s, total DB apply ≤120 s; перевищення потребує іншого bounded plan або окремої процедури, не аварійного skip.
7. **Rehearsal**: disposable DB/локальний edge runtime відтворюють підтверджену baseline schema/functions із source manifests, синтетичними old/new rows і queued jobs. Перехід candidate перевіряється на кожному проміжному етапі; role isolation, old-client requests, new data under previous client, background work, function version та postconditions обов'язкові. Official pinned Supabase CLI у disposable rehearsal генерує canonical migration history tuples для exact source; формат і CLI interop визначає [migration history contract](contracts/migration-history.md). Повторний базовий snapshot може кешуватися за повним digest, але новий transition і protected cases не перевикористовуються.
8. **Frozen candidate and beta reuse**: build один раз на поверхню/config; canonical file manifest виключає self-hash. Beta-agent archive та actual unpacked payload перевіряються за package source metadata, tools/runtime/dependency hashes; Byte-identical agent JS/tools/dependencies перевіряються окремо від environment-derived native wrapper. Для wrapper required trusted build record зв’язує exact template/rendered-source/toolchain/signing inputs і конкретні підстановки з hashes обох готових binaries; жодного wildcard exclusion executable. Legacy stripped/re-signed payload без matching provenance не приймається. [Support matrix](contracts/support-matrix.md) визначає обов’язкові cohorts і reuse selector. Немає відповідності published agent inputs — blocked, не rebuild. Новий browser journey працює саме з candidate web, real auth/pairing/entitlement і reuse packaged agent; direct API compression зі старим bundled web не достатня. До writes production-config artifact проходить exact-byte/config/static proof; Залежний від нового backend critical journey виконується у `mini_activation_verify` після apply й до web activation через trusted Playwright static route broker: exact frozen index/assets виконуються під canonical origin, реальні auth/backend/agent requests не підміняються. CDN/TLS serving доводиться окремо після activation. Для web-only він використовує чинний backend; backend-only замість browser preview проходить current-client control. На цій межі provisional prewrite admission перетворюється на activation admission. Тестова конфігурація не підмінює production proof; докладно [verification](contracts/verification.md).
9. **External effects**: archive candidate і previous recovery artifact до upload поза worktree; append+fsync prepared receipt до кожного ефекту. Mini DB executor використовує наявний `pg` з окремим release credential і pinned TLS endpoint цілі; analytics connection заборонений. Він звіряє project/database identity, immutable history/checksums і exact pending set безпосередньо перед кожною транзакцією, виконує `SET LOCAL lock_timeout/statement_timeout`, reviewed transactional statements і запис Supabase-compatible migration history атомарно. CLI `db push --linked` не використовується для mini writes, оскільки його child timeout не доводить DB-level deadline. Nontransactional SQL, включно з concurrent indexes, у першому mini policy відхиляється. Після exception/timeout спочатку observe, а не blind retry; Absolute 120 s apply deadline і 30 s transaction deadline зменшують server-side timeout перед кожним statement за remaining budget, з резервом history/COMMIT/observation; після вичерпання нові statements/transactions не починаються, unknown COMMIT звіряється. Бюджет не скидається на наступному statement. Деталі та ledger compatibility — [migration history contract](contracts/migration-history.md). Function identity зв'язує provider version із downloaded body normalized manifest і локальним digest; ACTIVE недостатньо. Web deploy receipt має provider deployment ID/correlation, output manifest та verified origin hashes. Втрачена відповідь — list/get/canonical observation; неоднозначність блокує наступний запис.
10. **Activation and recovery**: backend precedes web, previous client залишається сумісним. Smoke звіряє canonical deployment, signed channel та видимий результат; failure лишає partial state. Explicit recovery intent обирає archive із тим самим current manifest і доведеною сумісністю з поточною схемою, робить exact-byte upload та новий receipt/history update. Архів з іншим manifest не редагується. Міграції forward-only; response unknown/cancel не видається за rollback.
11. **Diagnostics and next release**: trusted `webBuildId = web:<full sourceSha>:<publicConfigDigest prefix>` передається у build, analytics і support; outputDigest зберігається поза bundle, щоб уникнути self-reference. Function/source identity береться з release receipts; request-level backend attribution допускається лише за незалежно отриманим provider version/response revision. Часова кореляція — hypothesis/unknown. Existing analytics envelope/SELECT guard незмінні; schema migration лише якщо наявного typed seam недостатньо, з окремим guard acceptance. Новий full release читає target receipts перед плануванням backend/web.

## Verification and delivery phases

- Phase A: governance proposal та typed contracts; production activation closed до ratification/acceptance.
- Phase B: deterministic policy, provenance, baselines, selected registry і fencing; read-only preflight.
- Phase C: US1 candidate verification/exact upload; US2 transition rehearsal і backend reconciliation; US3 adversarial admission; US4 resume/recovery; US5 diagnosis.
- Phase D: незалежні regression/fault cases, sandbox acceptance, timing cohorts та full-release non-regression; лише потім production readiness verdict. Candidate build/tests/native browser запускаються під окремою OS verification identity із приватним HOME та kernel-enforced deny доступу до production keys, host checkout і trusted store. Trusted launcher передає лише exported source/dependency snapshot та per-run outputs, обмежує мережу через default-deny macOS PF per-UID rules (IPv4/IPv6 TCP/UDP/DNS/QUIC), дозволяючи лише trusted loopback inspection proxy; ruleset/proxy digests і bypass self-tests входять у executor proof;; worktree/env cleanup не є security boundary. Якщо OS isolation не налаштована, mini preflight blocked. Докладно [executor contract](contracts/executor.md); beta credentials ізольовані. Trusted runner/verifier revision не береться з кандидата без окремої перевіреної інсталяції. Зміна власних policy/runner guards не є звичайним продуктовим mini candidate. Web-only MVP демонструється локально, але safety/diagnostic stories не є необов'язковими для production.

Всі buildable FR/AD/SC пов'язуються із tasks. Acceptance harness зберігає NOT_RUN/BLOCKED чесно; переносні тести не доводять native або hosted сценарії.

## Complexity Tracking

| Proposed governance change                                               | Why needed                                                               | Simpler alternative rejected because                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Окремий mini admission з reuse packaged agent та proven shared exception | Exact new web candidate перевіряється без повторного installer packaging | Скасування beta check або blanket shared allowlist втрачає proof; незмінний повний флоу не виконує вимогу швидкості |

Це pending amendment, не вже надане виключення. Реалізація може бути підготовлена та перевірена в sandbox із production activation closed; чинна constitution не змінюється у read-only analyze.
