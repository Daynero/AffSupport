# Implementation acceptance checkpoint

> Current owner policy (2026-11-07): [intel-user-feedback-v1](release-policy.md). Physical/native Intel tests are post-release user feedback, not a publication prerequisite. Earlier hardware-blocking checkpoints below are historical; no unexecuted case is marked passed. ARM native beta, Windows hosted, static Intel seals/signatures and applicable Apple trust remain required.

Date: 2026-11-07. Branch `049-macos-intel-support`, isolated worktree `AffSupport-049-intel`, base `59524e4b`.

| Boundary                                                   | Evidence                                                                                                                                     | Status                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Portable Intel engines                                     | Pinned Node 22.23.4, static FFmpeg/FFprobe 7.1.1/x264 and Whisper 1.9.1; immutable input provenance                                          | Built and statically verified                       |
| Complete Intel app                                         | Launcher, Finder extension, four engines and five Chromium native files                                                                      | All 11 native files passed static inspection        |
| Dev installer                                              | Intel ZIP + DMG; 85 dependency packages, signatures, identity/isolation                                                                      | Built; complete static verifier passed              |
| Target resolver / CPU policy / native identity             | Focused regression suites; resolver/signature/update notice: 22 passing tests                                                                | Source regressions passed                           |
| Three-platform runner / historical channel / mini baseline | Proof and runner fixtures, including immutable partial-publication readback                                                                  | Source regressions passed; no real publication      |
| Native diagnosis                                           | Compiled native missing/foreign/interrupted startup faults and actual local CLI; typed producer/guard/PGlite/CLI; PostgreSQL migration tests | Source fixtures passed; physical user journeys open |
| Physical Intel minimum/newer macOS                         | No host established                                                                                                                          | User-feedback follow-up; not a pre-release blocker  |
| Apple public trust / native updater                        | Public team/signing/notarization evidence unavailable; 048 updater absent at base                                                            | Not executed; manual handoff only                   |
| Packaged ARM / Windows controls                            | No release workflow dispatch or unrelated app interruption                                                                                   | Not executed                                        |

Artifact and exact SHA-256 are recorded in [acceptance-intel.md](acceptance-intel.md). Cross-build validation does not prove native user success. No production changes, tag, release, migration application or deployment.

## Final verification

- `npm run format`: passed.
- Changed shell syntax and `git diff --check`: passed.
- `nice -n 15 zsh scripts/verify-dev-package.sh --arch=x64`: passed static verification, explicitly leaves native execution unproven.
- Focused acceptance root/target/input/native-startup rerun: 4 files, 27 tests passed. The acceptance root remains physically inside the worktree; only target-specific heavy caches are external.
- Release build/e2e phase: shared/web/agent builds, release/team contracts, browser accessibility and browser CSP all passed. Initial database phase selected nonexistent default `wishly`; the explicit local source rerun is recorded below.
- `SOTY_TEST_DB_SOURCE_PROJECT=affsupport037 npm run test:db`: full migration replay and 47 pgTAP files / 1077 assertions passed. The following isolated Auth integration could not start because the source Auth container is absent. The canonical database command therefore remains failed, with SQL acceptance independently proven. Disposable database cleanup completed.
- Release environment phase: blocked by absent `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SITE_URL`, `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_PROJECT_NUMBER` in this isolated worktree. No deployment configuration or authentication bypass was invented.
- Earlier complete-command attempts are retained in the external logs: fast stopped on the Dev-versus-production CSP bundle mismatch (corrected and real CSP rerun passed); release coverage stopped at the external acceptance-root layout (corrected; actual acceptance CLI rerun passed). The coverage run reported 5157 passed / 1 failed / 34 skipped and 5 of 8 shards, so it is not full-suite or complete-coverage evidence.
- Full-command and subsequent focused outcomes are recorded separately below.

Final Intel artifact: `release/dev/x64/Soty-Dev-1.3.3-dev.59524e4b.dirty.20261107111118-macOS-x64.dmg`, SHA-256 `8a918132d5f2ebf23fdf48c4cd2db1aef006110ee2fa661cad40b3ffb6ffcd9c`. Canonical `package:dev:dmg -- --arch=x64` returned 0 and completed all static checks. The command also produced the matching ZIP; no native execution acceptance was inferred on the ARM build host.

The final fast aggregate returned failure after 4/8 shards: 4200 passed, 7 failed, 28 skipped; all 13 static gates passed. Failures were in `team-invitation-link` and `translation-retirement-reader`; an immediate single-worker rerun passed both files / all 12 tests. This does not prove the aggregate failure cause or constitute a green full suite. The aggregate report is retained as `verification-fast-final-before-native-fix.json`.

A subsequent production-method native regression reproduced stale readiness attribution, then passed after matching current captured UUID, health UUID and a live child. Final focused source validation: 8 files / 71 native, policy, identity, analytics, governor and graphics tests; 2 files / 14 launcher tests, all passed. The Intel DMG is rebuilt after this fix; remaining previously unexecuted suite shards are tracked separately.

The remaining shard selections ran sequentially with the same unit project and one worker: shard 6 reported 1273 passed / 3 failed / 2 skipped; shard 7 reported 1228 passed / 1 failed / 9 skipped; shard 8 reported 994 passed / 4 failed / 5 skipped. All eight selections have therefore been exercised across separate runs, not as one complete green aggregate or complete coverage report.

The remaining feature failures were corrected: six new fixtures now use the repository retrying temporary-directory helper; account/onboarding tests require explicit targets and unavailable states rather than a guessed ARM URL; analytics delivery asserts explicit unknown native identity. A valid three-target onboarding fixture additionally proves actual Intel/ARM/Windows links. A known package target now remains binding even when runtime architecture is absent. Native readiness retains its existing timeout when correlation is unproven. Both boundary regressions were observed failing before the source fixes.

The commercial cutover scenario replays the database migration chain and repeatedly exceeded its default 5-second limit (measured about 8 seconds); it now uses the same existing 120-second fixture budget as the preceding full-replay scenario in that file. The retention scenario likewise includes cold PGlite startup and now uses the existing transfer-grant fixture's 30-second budget. SQL assertions and global runner timeouts are unchanged. These are local test budgets, not release-gate exemptions.

Final complete-source static validation: `npm run verify -- --gates=static` returned 0, all 13 gates passed (240 seconds), including all project/test/script typechecks. Raw official report: `verification-static-complete-source.json` in the external logs directory. This is explicitly a static group result, not a full fast/release aggregate pass.

After the boundary fixes, 13 focused files / 64 tests passed; only the retention cold-start budget failed in that 14-file run. After aligning that local budget, retention plus the associated grant adversarial suite passed 2 files / 21 tests. The earlier commercial replay now completed all real assertions (about 8 seconds for the cutover scenario). No global timeout, database assertion or release proof was bypassed.

Final complete-source `package:dev:dmg -- --arch=x64` returned 0. The rebuilt 193,677,881-byte DMG includes both final boundary fixes and passed all 11 native-file, 85 dependency, target-browser, identity, isolation and signature checks. SHA-256: `8a918132d5f2ebf23fdf48c4cd2db1aef006110ee2fa661cad40b3ffb6ffcd9c`. This is a development cross-build; physical Intel runtime and public Apple trust remain unproven.

Final identity-separation regression: the actual onboarding click and typed analytics producer first failed because installer intent was stored as native package metadata. After introducing `installer_target`, deriving native fields only from captured health context and adding separate CLI request projections, 7 files / 79 tests passed. This includes actual producer→guard→storage→cohort and actual inspect query; fresh Intel requests remain unknown native identity with no successful terminal. The new forward-only guard migration passed complete PostgreSQL replay and all 47 pgTAP files / 1081 assertions. The downstream Auth fixture still cannot start from the unavailable local source Auth container, so the overall DB command is not a pass.

The last installer-intent source revision passed all 13 official static gates (311 seconds), recorded in `verification-static-installer-intent.json`. Its canonical Intel Dev rebuild returned 0 and produced the final artifact above, including distinct requested/observed target properties. Complete static verification again passed 11 native files, 85 dependencies, the target browser, identity/isolation and signatures.

Final production web rebuild after the last Dev package returned 0 (`final-production-web-installer-intent.log`), so the worktree no longer contains the Dev web bundle. The final DMG SHA-256 was independently recomputed and matches its receipt. All package paths, byte size and digest above refer to the last installer-intent source, not an earlier development checkpoint.

Final real-browser CSP smoke after restoring the production bundle passed both tests: the application loaded with no policy violation and an injected inline script was refused. Final structural recheck: 18/18 requirements mapped; 33 unique sequential tasks; 28 completed and T012/T017/T030/T031/T033 explicitly open. No post-implementation hooks are configured. Hardware access has not been established; no physical acceptance is inferred from silence or a cross-build.

## Owner-ratified user-feedback update

No Intel hardware or native Intel beta record is required for publication. Schema-3 static qualification binds exact bytes/source/config and explicitly records native runtime/hardware as unverified. Per-target source/signature/architecture checks and all three final artifacts remain mandatory. Mini baselines bind the qualification level, preventing static evidence from being relabelled native. The actual signed x86_64 fixture was inspected without executing target code and without hardware-acceptance.json; 8 files / 93 regression tests passed. No production action occurred. T012/T017/T030 are post-release feedback; T031/T033 retain pre-release automated/environment/trust work.

The read-only mini-release prerequisite report no longer lists hardware-acceptance.json as required. Its required Intel verification/provenance and full platform baseline remain. Existing native runtime checks for the unchanged ARM package still execute; Intel static qualification is retained by the mode-bound sealed baseline.

Final owner-policy focused verification: 10 files / 107 tests passed (`user-feedback-final-tests.log`), including an actual SDK-built x64 fixture and proof generation with no target execution. Intel physical testing remains a post-release user-feedback follow-up, not a pre-release prerequisite.

Final canonical static verification: `npm run verify -- --gates=static` passed all 13 gates in 262 seconds, including formatting, lint, project/test/script types, design, localization, configuration, CSP and dependency audit. This result does not claim native Intel execution or a complete release aggregate.
