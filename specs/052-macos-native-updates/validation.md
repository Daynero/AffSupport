# Bounded development validation — 2026-11-12

The owner authorized independent testing without disturbing parallel agents and explicitly excluded this feature from the next release. Validation ran against uncommitted changes on `feature/macos-trusted-updates` in the isolated `macos-trusted-updates` worktree; the owner subsequently requested that snapshot be committed and pushed for later continuation. No release, production deployment, migration, installed-app launch or packaged upgrade was performed.

## Executed evidence

| Check                                                                                         | Result                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused updater/client/UI/workload/diagnostic regressions                                     | **119 passed**, no skips or failures                                                                                                                                      |
| Impact regressions: analytics, persistence/recovery, power, routes and release compatibility  | Initial run: 686 passed, one code-map assertion failed, two opt-in CPU benchmarks skipped. The failed file was fixed and re-run successfully in a 25-test correction run. |
| Combined distinct test instances after that correction                                        | **803 passed, 2 skipped, 0 unresolved failures across 82 files**; overlapping runs counted once                                                                           |
| Shared build; agent, web, Soty Review and scripts TypeScript                                  | Passed                                                                                                                                                                    |
| Focused updater/test TypeScript                                                               | Passed with a 1536 MiB Node heap                                                                                                                                          |
| Full lint and formatting; design tokens, Tailwind, styles, i18n, environment registry and CSP | Passed                                                                                                                                                                    |
| Syntax of five modified packaging/signing shell scripts                                       | Passed                                                                                                                                                                    |
| Native store/recovery/readiness probe                                                         | **13 checks passed**, actual isolated native execution                                                                                                                    |
| Launcher + Swift updater + Objective-C driver + pinned Sparkle                                | Compiled and linked for **ARM64 and x86_64**; neither app was executed or Developer ID signed/notarized                                                                   |

[validation.json](validation.json) contains the exact run counts, gate durations, source fingerprint and limitations. Original local reports are retained under ignored `scratchpad/native-updates-validation/`; the initial failed impact report has not been relabeled as a pass. These checks are not a successful `npm run verify` result.

## Fixes found during validation

- Export native update contracts through both shared package entry points and keep the snapshot out of the unsupported analytics context.
- Use bounded Web Stream readers compatible with all project compiler libraries. Failed reads cancel their stream and release the reader; oversized/truncated downloads leave no incomplete cache file.
- Bind native diagnostic category/code as SQL parameters while retaining the strict read-only query guard.
- Keep foreground work busy until its terminal vault write finishes. Update flush awaits those writes and rechecks fault state; a held-write regression proves it cannot report idle prematurely.
- Point diagnostic code-map entries at product producers and the web forwarder.
- Reset inherited native-update environment authority before the launcher explicitly enables its qualified host.

## Resource isolation

Workspace package links and build output belong to this worktree; dependency source, other worktrees' source, installed Soty and the shared beta environment were left alone. The initial dependency farm exposed shared tool-cache symlinks; before final confirmation, `.vite`, `.cache` and `.vite-temp` were replaced with local directories without changing or clearing their former targets. Earlier tool-cache writes are not excluded. Commands used `nice 15`, one Vitest worker and bounded thread pools/heaps. Monitoring could terminate only its own command group on insufficient host headroom. An early overlap between our web typecheck and focused tests led to adding a private gate lock for all subsequent commands. No foreign processes were signaled.

The two skipped tests require `SOTY_POWER_LOAD` and deliberately load multiple tools at 40% and 70% CPU limits. They were left disabled during parallel work. The full test-tree TypeScript check exceeded its own 768/1536 MiB heap limits; the focused check passed. No further full-tree heap increase was attempted.

## Remaining acceptance

Only about 2 GiB remained on the shared volume while other agents were active. Full installers, beta services, notarization and interactive A→B→C tests were therefore not started. The following remain open:

- Overall verify, actual signed/stapled Soty package trust and clean-host acceptance.
- Hosted/local UI upgrades, interruptions/reboots, all-tool workload preservation, SDK helper registration before heavy extraction and CPU-budget compliance.
- Twenty controlled latency samples and live receipt→web→database→read-only CLI delivery, including missing/delayed signals.
- Intel runtime/hardware and Windows installer evidence. Intel compilation is static cross-target evidence only.

No qualification record or packaged-success claim was created. T004, T012, T025, T029, T032 and T033 remain open, together with other tasks whose full acceptance exceeds the checks above.
