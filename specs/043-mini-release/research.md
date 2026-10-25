> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](spec.md). This artifact does not expand the current implementation scope.

# Research: mini-release 043

**Date**: 2026-10-25. Read-only repository inspection плюс два незалежних research reviewers; поточні механізми не оголошуються доказом готовності.

## R1 — Extend one runner; preserve full mode

**Decision**: schema-v1/full залишається сумісною; schema-v2 mini має власну selected registry, immutable intent digest, target-wide claim та звичайний supervised worker/status/report.

**Rationale**: `intent.mjs` зараз вимагає version XOR bump, `steps/flow/state.mjs` і status hardcode full steps. Resume порівнює лише частину identity, environment підставляє backend plan. `controller` має target claim, direct runner його не має; потрібне делегування, не подвійний lock.

**Alternatives**: другий mini script дублює gates; fake completed packaging steps створюють неправдиві докази. Обидва відхилені.

## R2 — Separate current surface baseline from agent tag

**Decision**: target-shared store з independent web/function/schema observations та незмінним agent baseline; read-only bootstrap, невідома база блокується.

**Rationale**: багато mini releases мають один agent tag. Worktrees прибираються; поточні archive/history локальні для cwd. Старий receipt не доводить актуальний стан цілі або точний function body.

**Alternatives**: `git describe`/останній commit/довільний JSON baseline відхилені як недостатня ідентичність.

## R3 — Agent package provenance must be stronger

**Decision**: actual archive/payload manifest, embedded revision і dependency/tool fingerprints; allowlisted beta environment differences та candidate-specific browser journey на незмінному packaged agent.

**Rationale**: `verify-beta-package.sh` обчислює поточний packageDigest із `release.json`, sourceRevision бере з HEAD під час verify. Це не повний payload digest і не доказ походження. `verify-beta-runtime.mjs` direct API compression не доводить роботу нового candidate web.

**Alternatives**: дозволити старий verification.json або переписати sourceRevision — відхилено. Перепаковування кожного beta commit не відповідає меті. Якщо provenance unavailable — blocked до окремого перевіреного enrollment, а не fabricated pass.

## R4 — Prove shared/dependency independence

**Decision**: compiler resolution + emitted runtime/module evaluation/declaration/contract fingerprints, conservative unknown. Вже встановлений TypeScript compiler API; жодного нового graph сервісу.

**Rationale**: agent імпортує shared root, а root має re-exports. Простий path allowlist або tree-shaking припущення не доводять відсутність runtime side effects і wire/schema впливу. Web-only lockfile change допускається лише за незмінного resolved agent closure.

**Alternatives**: blanket shared block безпечний як fallback, але не основний критерій; blanket shared allow небезпечний. Непідтримувані constructs залишаються blocked.

## R5 — Database policy is a bounded proof, not SQL regex

**Decision**: restricted statement grammar + exact migration set, postconditions, role/data tests і upgrade rehearsal від deployed baseline; lock 2 s / statement 30 s / total 120 s.

**Rationale**: `migration-compat.mjs` не аналізує повну семантику, constraints, DML, permissions чи lock cost; recreated function name не доводить сумісність signature. Backend adapter повертає true для функцій, history presence як postconditions і ACTIVE як function proof. DB CLI працює через `--linked`; його child timeout не гарантує зупинки запиту в БД. Mini writes виконуються наявним `pg` через окремий pinned release connection, із `SET LOCAL` deadlines і atomic migration+history transaction. Ніяких analytics credentials або `db push --linked` для mini writes; nontransactional SQL у першій policy unsupported. Підтримка Supabase history shape перевіряється на повному isolated replay.

**Alternatives**: повний SQL semantic verifier занадто великий для scope; ручний compatible boolean ненадійний. Unsupported grammar/semantics → окрема процедура. Старий механізм можна перевикористати як screening, не як authorization.

## R6 — Exact external identity and reconciliation

**Decision**: prepared effects до запису; source/bundle manifests; provider observations; reconcile exception/timeouts; archive before upload; no blind replay.

**Rationale**: нинішній deploy архівує після успіху й не зберігає provider deployment ID; rollback має flat/nested binding mismatch та не додає нової history receipt.

Cloudflare документує list/get deployments, deployment IDs і canonical deployment; адаптер може використати ці read-only observations для reconciliation, але вони самі не доводять усі завантажені байти. Потрібні origin file hashes і локальний exact manifest. [Cloudflare Pages API](https://developers.cloudflare.com/api/resources/pages/), [deployment model](https://developers.cloudflare.com/api/typescript/resources/pages/).

Supabase документує читання function body за project ref і slug. Design використовує завантажений body плюс provider version та normalized file manifest для перевірки складу; format/normalization перевіряються adapter fixtures. Якщо provider transform не дозволяє довести відповідність, це unknown, а не digest match за slug. [Supabase Management API](https://supabase.com/docs/reference/api/v1-get-a-function-body).

**Alternatives**: slug ACTIVE, provider upload exit 0 або marker sourceSha як єдиний proof — відхилені.

## R7 — Common verification reporting and independent deployment IDs

**Decision**: impact profile через чинний `verify-all.mjs` з одним reporting path; обов'язкова fast suite, changed builds, runtime та DB checks. Cache лише за повним input digest і чинністю, з invalidation; release builds агентів виключені зі selected profile.

**Rationale**: новий runner не має переписувати двадцять npm commands. `VITE_WEB_REVISION` існує, але analytics/support читають `VITE_WEB_BUILD_ID || PRODUCT_VERSION`; без явного build ID різні mini releases зливаються. Existing `web_build_id` column і CLI придатні для web cohorts без нової таблиці.

**Alternatives**: продуктова версія як web ID або нова агентна версія для analytics — відхилені. Backend version без authoritative evidence лишається unknown.

## R8 — Governance is an explicit prerequisite

**Decision**: draft amendment у contracts, окремий ratification task; feature-specific production activation перевіряє ratified policy digest + exact implementation + live sandbox evidence. Наявні G0/042 gates зберігаються.

**Rationale**: чинні документи вимагають new exact-SHA packaged-beta й unchanged shared inputs. Рядок версії constitution та старі unrelated sandbox runs не доводять acceptance нового mini mode.

**Alternatives**: silent gate weakening або «hotfix=true» bypass відхилені. Цей planning request не є production authorization.

## Decisions tightened after independent reviews

- Combined rollout: separate prewrite/activation admission; isolated compatibility до writes, exact production artifact control після compatible backend apply й до activation. Trusted static-only Playwright routing під canonical origin виконує unchanged bytes без нового agent origin або remote preview deploy. Live CDN/TLS serving доводиться після activation окремо.
- Executor: separate OS verification identity та kernel-denied host keys/checkout/store, scoped network proxy; env/worktree-only isolation відхилено. Preflight closed без налаштованої boundary.
- Native wrappers: byte equality agent JS/tools/deps окрема від template/compiler/substitution/binary provenance environment-derived launcher; legacy payload transforms не виключаються wildcard. One-time enrollment outside mini, no published asset replacement.
- Ledger: exact vendor-generated tuple із pinned CLI disposable rehearsal, schema adapter, atomic source-bound SQL+tuple, real mini→CLI/full interop; unknown vendor schema blocked. Не заявляється checksum column, якого немає.
- Deadlines: absolute transaction/global budget, remaining timeout перед кожним statement/history/COMMIT; multi-statement real regression, no per-statement budget reset.
- Finite support selector: current/oldest behavior cohorts, immutable native reuse для unchanged seams, new native proof лише affected behavior; unsupported required cohort explicit blocked.
- Operator: normal `release mini --source --target`, automatic read-only draft/digests, optional prepare-only; harness не prerequisite normal operation.
- Baseline schema fingerprint: normalized live definitions доповнюють history, тому manual catalog drift не ховається за незмінними migration IDs.
