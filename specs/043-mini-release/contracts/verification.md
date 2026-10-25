> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](../spec.md). This artifact does not expand the current implementation scope.

# Contract: verification, evidence and diagnostics

## Common profile

Mini verification використовує чинний `scripts/verify-all.mjs` reporting path і machine-readable result, а не окремий набір shell bypass. Додається versioned impact profile, який не змінює значення `fast`/`release` і не приймає довільне skip/approved. Seed shared rebuild, static gates, fast regression suite та protected candidate checks обов'язкові. Build тільки changed surfaces; DB change додає isolated migration/role/data upgrade, function change додає actual serving/version, web adds exact-byte browser checks. Agent packaging і Windows dispatch відсутні за конструкцією.

Impact selector, policy digest і required check IDs зв'язуються admission. Кожен gate має timeout і той самий success/failure output cap/envelope, result artifact зберігається у run store. Optional/unsupported не означає PASS. Checks, які перевіряють нову поведінку, не кешуються.

## Evidence reuse policy

- Trusted immutable agent package equivalence: archive+unpacked manifest+embedded revision+inputs/toolchain/contracts; rehash перед use, cached computation лише content-addressed. Нові sha/config/policy/provenance → invalidate.
- Immutable compile/test facts: reuse лише matching full input/runner/toolchain/policy/config/dependency digest і максимум 24 h. Fast suite нового кандидата, candidate/browser journey, transition rehearsal й postdeploy result завжди виконуються заново.
- Remote target/binding/active versions/migration history: fresh на preflight, безпосередньо перед write та finalization; never persistent cache authorization. Artifact download availability/provenance freshness не більше 15 min до first write, із pinning immutable digest.
- Admission максимум 30 min, до першого write мають бути чинні всі proofs. Після partial effect recovery не втрачає receipts: expiry блокує наступні writes до revalidation і не дозволяє повторити unknown effect.
- Evidence generated trusted installed runner/verifier; candidate build/test/native browser виконується під окремою OS identity за [executor contract](executor.md), без доступу до host keys/checkout/credential sockets/trusted store. Env cleanup і worktree не замінюють OS boundary. Protected verifier/policy updates — separate operational enrollment, не self-approved mini.

## Package equivalence and candidate browser proof

Current beta verification record не є reusable full payload proof. Новий record бере revision з packaged embedded metadata й independently matches expected baseline; hashes cover actual agent/runtime/tools/dependencies, не тільки release.json. Allowlisted environment differences: beta identity/origin/port/key material references/packaged metadata fields за versioned policy. Byte-identical agent JS/tools/dependencies required; native launcher — окрема environment-derived wrapper equivalence, а не exception для довільних machine bytes. Trusted enrollment build record містить exact `packaging/Launcher.swift` template digest, renderer digest, compiler/SDK/target/flags/signing inputs, parsed substitutions, rendered-source digest і final binary hash для production та beta wrapper. Rendered AST/source поза closed substitutions рівні; обидва binary hashes мають належати цим заздалегідь довіреним build records. Wildcard exclusion всього wrapper заборонений. Legacy beta strip/re-sign Node executable без exact payload proof blocked; enrollment може підготувати перевірену пару один раз поза mini, не змінюючи published assets або agent version. Mini ніколи не компілює/пакує launcher. Відсутня valid beta artifact → prerequisite enrollment, без mini rebuilding.

Реальні auth, pairing, entitlement rejection/acceptance й completed delivered local operation перевіряються з candidate web на unchanged packaged agent. Вимірюється саме browser-visible result; старий bundled web або прямий API success недостатні. Finite versioned matrix за [support contract](support-matrix.md) має exact platform/package/version/capabilities, oldest/current cohort і fresh-vs-reused check selection; native proof окремий від portable contract tests. Обов'язковий unsupported native case → blocked, не мовчазний skip.

Beta/public production конфігурації дають різні bundles; beta proof не attests production bundle. Two admissions і конкретний порядок:

1. До будь-яких writes `mini_verify` доводить isolated transition/role/data compatibility, candidate beta browser journey, exact production artifact/config/integrity та previous-client availability. Створюється **prewrite admission** для exact backward-compatible backend plan; production journey, якому потрібна нова схема, ще NOT_RUN, не PASS.
2. `mini_backend_apply` застосовує лише цей план; old web залишається active. Якщо його контроль/ціль не підтверджені — partial/unknown, без активації вебу.
3. `mini_activation_verify` запускає exact production-config candidate у disposable Playwright context під canonical production origin. Trusted host-side route broker підміняє **лише статичні index/assets із frozen manifest** через `route.fulfill` незмінними bytes і перевіреними MIME/CSP/hosting headers; URL, JS і build-time endpoints не переписуються. У context вимкнено service workers/cache; невідома static asset request відхиляється, щоб не змішати старі ресурси. Auth/backend/agent requests не mock і не fulfill: вони йдуть до already-applied bound services через scoped network proxy. Тому allowlisted origin агентів залишається canonical; нового remote preview deploy чи дозволу preview origin не потрібно. Runtime read controls використовують дозволені сутності; write control потребує bound synthetic namespace/account, allowed operations і cleanup у release intent. Відсутня така авторизація → blocked. Це доводить точні candidate bytes/конфігурацію/поведінку, але не CDN/TLS serving: реальний canonical fetch без route broker обов’язковий у `mini_live_verify` після активації. Broker і header mapper входять у trusted verifier digest та мають integration fixtures; кандидат не може змінити routing.
4. Тільки після actual visible result утворюється **activation admission**, яке зв’язує prewrite proof, postapply state й preview proof. `mini_deploy` активує ті самі bytes; `mini_live_verify` перевіряє canonical origin, control result та unchanged channel. Response-loss resume спочатку re-observes backend state й preview input fingerprints; candidate не активується за старим admission.

Web-only пропускає backend apply, але проходить preview/control на current backend. Backend-only не створює web preview й доводить current-client/function control у `mini_activation_verify`. Відсутня авторизація потрібного synthetic control чи safe exact-byte broker → blocked, без вимоги власнику повторно підтверджувати вже дозволений scope і без вигаданого runtime proof. Це не потребує застосувати schema навмання до перевірки сумісності: ізольований доказ і prewrite admission уже отримані.

## Required acceptance inventory

Harness `specs/043-mini-release/acceptance/cases.json` містить щонайменше такі 24 distinct cases зі spec IDs, prerequisites, real/mocked scope, expected outcome, proof refs та NOT_RUN/BLOCKED reason:

| Cases                                                                                                                | Expected proof                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| E01 web fix; E02 backend-only; E03 web+nullable column; E04 isolated table                                           | eligible, same agent artifacts/channel       |
| E05 shared web-only pure/type change; E06 web-only lockfile                                                          | protected agent fingerprints unchanged       |
| E07 agent runtime; E08 tool contract; E09 agent dependency; E10 unresolved dynamic import                            | requires-full або insufficient before writes |
| E11 dropped used column; E12 RPC changed signature; E13 mandatory/rewrite column; E14 destructive DML                | separate procedure/blocked                   |
| E15 RLS leak; E16 legitimate old role broken; E17 same-name unsafe function replacement                              | compatibility denial                         |
| E18 unknown SQL grammar; E19 wrong linked target/endpoint; E20 extra pending migration                               | refusal before writes                        |
| E21 applied migration edited; E22 modified beta payload; E23 stale/foreign evidence; E24 unprovable initial baseline | refusal before writes                        |

Додаткові faults: commit response lost, function partial apply, web upload response lost, DB budget exhaustion, prepared receipt crash, cancel during apply, old-worker fence, controller/direct race, full/mini/backend/recovery race, tampered archive, wrong binding, changed channel, unknown/deferred evidence, stale browser assets, unsaved draft, previous client reads new row, queued job completion, later full release after two mini runs. Міграції перевіряються на реальному disposable Postgres; mocks не доводять lock/transaction semantics.

## Analytics contract

`VITE_WEB_BUILD_ID` формується trusted build metadata, не `PRODUCT_VERSION` fallback для release. Єдина `apps/web/src/build-identity.ts` годує analytics і support; source/config identity не містить власного outputDigest. Existing `web_build_id` column/envelope підтримується, legacy rows unknown/legacy, не relabelled.

Backend source/provider identity міститься у authoritative deployment receipts. Exact request attribution потребує provider version/explicit response identity, інакше CLI показує hypothesis/unknown із часовим scope. Для core diagnostics lookup joins використовує private local deployment receipts + SELECT-only analytics, ніколи write credentials або raw service access. `investigate/inspect/cohorts/audit` зберігають existing envelope, --as-of, period, lag, bounded limits і privacy.

Capability inventory містить міні-реліз stages/outcomes, supported cohorts і safe evidence fallback. End-to-end tests inject typed production-like signal → sanitizer/transport/storage → CLI query+read-only journal join; dropped/rejected/delayed event і missing identity лишають unknown. Beta test capture не надсилається як production analytics. No event content/secrets/paths/raw provider bodies у exports.

## Measurement and readiness

Timing runs: окремі 10 web + 10 compatible backend/DB контрольних релізів на погодженій sandbox цілі, плюс recovery trials. Відлік від прийнятого `start` до confirmed visible result включає checks/rehearsal/provider time; setup/enrollment окремо. Усі attempts, timeouts, provider failures і sample sizes збережені; p50/p95 та частка within budget, без cherry-picking. Fresh-tab ≤2 min й active draft/local-run preservation обов'язкові.

Діагностичний control: reviewer отримує тільки runId/operationId і за ≤2 min відновлює stage, identities, uncertainty/recovery через read-only interface. Синтетичний успіх не доводить production-user ефект. Readiness ready/blocked/insufficient; критичний NOT_RUN/unknown не дозволяє production GO. Full legacy tests і contract fixtures доводять незмінність full semantics.
