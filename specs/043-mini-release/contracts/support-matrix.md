> Historical full-scope design, deferred by the owner’s 3–4h MVP decision. Active requirements: [spec.md](../spec.md). This artifact does not expand the current implementation scope.

# Contract: finite supported-agent matrix and reuse selector

Policy artifact `config/mini-release-support.json` містить schemaVersion, policy digest і explicit finite cohort definitions. Trusted enrollment materializes точні signed package/embedded-input fingerprints у приватну `support-matrix.json`, а admission pin її digest; не вводити вигадані package hashes у committed defaults. Відсутній enrollment → конкретний blocked prerequisite.

Кожна cohort: platform, signed release manifest/artifact digest, embedded source/runtime/wrapper-equivalence refs, protocol/core/tool/capability fingerprints, host/browser class, oldest/current representative role, supported journeys, required/fresh/reusable check IDs і evidence refs. Поточний signed stable включений на обох required platforms. Для кожного ще підтримуваного distinct protocol/tool/capability behavior class включений найстаріший supported representative із signed release inventory. Support inventory затверджується як versioned policy; аналітична відсутність старих користувачів не викидає підтримувану cohort автоматично. Зміна support cutoff є окремим явним рішенням, не mini optimization.

Selector правила:

- Static styles/text або hosted-only behavior без drift agent-facing seam fingerprints: candidate browser checks свіжі, portable protocol/contract checks свіжі; package boot/native capability facts можна reuse, якщо package/runtime/wrapper/host-OS/config fingerprints і attestation scope незмінні. Immutable native baseline evidence не має щоденного штучного expiry; fresh actual package/host identity re-observed. Це відрізняється від 24h cap generic compile/test facts.
- Зміна native file input/dialog integration, auth/pairing/entitlement, API wrappers/wire validators, job lifecycle/recovery, OS-dependent behavior або newly exercised optional capability: новий candidate-specific native journey обов'язковий на кожній affected cohort/platform. Старий browser journey не reusable.
- Незмінені local journeys не виконуються повторно лише через новий web SHA; reuse record називає exact fact і чому input closure незмінний. Type/shared ambiguity лишає unknown, не exemption.
- Нова поведінка вебу та changed backend role/data transition завжди перевіряються заново. Native Windows відсутній для required affected class → BLOCKED із exact missing check, а не portable PASS. Pure CSS candidate не вимагає нової ручної Windows-сесії за valid immutable native baseline proof.

Package equality розділяє byte-identical agent JS/tools/dependencies та environment-derived native launcher. Для wrapper потрібний trusted enrollment record: source template/renderer/compiler/SDK/target/flags/signing identities, точні environment substitutions, rendered-source digest і final binary hash обох artifacts. Rendered code поза дозволеними substitutions рівний. Unknown signing/strip/byte transform або відсутнє походження → blocked; весь launcher не виключається з proof. Запис sourceSha із HEAD під час verify не приймається.

Matrix tests: current+oldest cohort coverage на обох platforms, unknown capability, missing native attestation, invalid wrapper provenance, CSS reuse positive control та API/native behavior change mandatory rerun. Усі selected/excluded cases з поясненням входять до candidate report і acceptance timing denominator.
