# Selected-day creation and financial tooltip cleanup

New SOC/RK creation uses the selected financial day and timezone as its effective start. Physical created_at remains the true audit timestamp. Explicit effective birth is respected by overview, day/month UI, placements, history, copied/exported finance and mutation guards. An older newly created child extends an explicitly dated parent; receiving an older RK by transfer never retrodates a SOC to the RK original birth, and transfer before destination birth is rejected. Legacy undated records and financial history remain unchanged.

An earlier SOC remains visible as empty before its first future-born RK. Historical archive/restore gaps and same-day-data retention remain. The typed API checks the canonical returned date, and creation refreshes finance so its fields are usable immediately.

Removed obvious finance summary title tooltips and the redundant timezone title. Screen-reader labels retain period/currency context.

## Validation completed

- Final focused UI/shared/API/diagnostic/period run:30/30 PASS. Includes yesterday creation, day-before hiding, next-day visibility, editable fields after finance refresh, empty parent before first RK, safe diagnostics through sanitizer/CLI interpretation, timezone boundary and prebirth copy/export rejection.
- Isolated SQL: birth migration1/1 PASS; finance values7/7 PASS; transfer7/7 PASS after updating its obsolete expectation to assert rejection before a newly explicit parent birth, then valid-date exactly-once move replay. Legacy original values/history/placements/audits are unchanged across migration.
- Shared build: PASS after replacing a callback lookup with the already-validated placement Map (TypeScript narrowing fix; behavior unchanged).
- Independent source review found and closed3 missed cases: transfer-parent retrodate, RK timezone and empty SOC with future-born first child.

## Existing local beta

Applied only20261202146000 to verified127.0.0.1:54322 Beta Workspace. No reset, production or release operations. Existing rows were fingerprinted inside the migration transaction, excluding only the newly added nullable columns; all original account/RK/run/placement/history/finance values matched before/after. Migration and history record committed atomically.

Actual UI created DEMO-START-1018 with RK demo_start_1017_01 while viewing2026-10-17: all3 finance fields enabled on17th; neither SOC nor RK exists in16th view; both appear on18th. Reload then17th view still shows the RK. Canonical database proof: SOC/RK/placement/parent-history starts all17th, physical SOC/RK creation audit days18th. Added no financial sample values. Returned test view to Today and original search.

Evidence: scratchpad/038/birth-{browser-proof,canonical-proof}.json, birth-yesterday-reloaded.png, birth-local-apply.log. Monthly financial cells in actual DOM have no title attributes while accessible labels retain period/currency.

## Diagnostic scope

Existing retained_action flows carry only account_day=today/previous/historical through requested/accepted/applied or failure; no raw calendar date, name, monetary value or entity ID is added. CLI diagnoses retain this bucket and distinguish accepted-but-not-visible evidence. Literal historical dates deliberately remain unobservable from analytics; exact-day claims require authorized canonical state inspection or a local reproduction, never inference from the bucket.

## Final build and verification scope

- Fresh `npm run build:web`: PASS (`scratchpad/038/birth-build-web.log`).
- Fresh built-asset budget: 4/4 PASS, no threshold changes (`birth-performance-budget.log`).
- Canonical static run passed product/scripts type checks and other static gates, but initially failed new test typings; corrected test typings then direct `typecheck:tests` PASS. Original result preserved in `verification-birth-static-first.json`.
- Canonical suite ran shards 1 and 2, then stopped on two regressions: the deliberate 500ms long-press threshold was incorrectly classified as a visual transition by the old token test; a metadata fixture created an RK with the new today default but searched for it in January. Explicitly assert the long-press threshold separately and date the January fixture creation explicitly. Both corrected files: 7/7 PASS (`birth-suite-regression-retry.log`). Shards 3–8 were not run; the whole suite is not claimed green. Original failed canonical result remains in root `verification-result.json`; focused passing results do not overwrite it.
- `git diff --check`: PASS.
- Final source manifest: `effective-birth-source-manifest.json`; application SHA-256 `4d48175a7f7011507ea364dcba844902117fe9605925a198fb933ed777c7c209`. Independent source review predates only these test corrections; product source unchanged afterward.

Earlier reports retain their original source/time scope. No production deployment, commit, push or reset was performed.
