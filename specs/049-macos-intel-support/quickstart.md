# Validation guide: Intel Mac support

The target-aware source commands and diagnostic CLI below are implemented. Intel physical/native testing is first-user feedback; mandatory static qualification and public Apple trust remain prerequisites. No production release command is authorised here.

## Prerequisites

Clean candidate checkout; fresh shared build; approved Intel and ARM input manifests with digests/sources/licenses; ARM native beta host and Windows hosted control; no Intel hardware required for static qualification; local beta Supabase; real beta auth/entitlement. Trust acceptance requires 048 prerequisites and implementation. Record hardware/OS/CPU baseline and package bytes without secrets/raw user paths.

Missing pinned browser/engine, ARM/Windows evidence or applicable trust blocks the relevant gate. Intel physical/native testing is deferred to first-user feedback. Do not upgrade a skip into a pass or use translation as physical Intel proof.

## Static and focused regressions

```bash
npm run build -w @video-compressor/shared
npx vitest run tests/macos-target.test.ts tests/macos-package-target.test.ts tests/macos-artifact-selection.test.ts tests/macos-beta-target-proof.test.ts tests/analytics-agent-architecture.test.ts --maxWorkers=1
npm run verify
```

The listed tests exercise the implemented boundaries. Expected: unsupported target rejected before writes; mixed browser/helper/engine architecture, wrong OS baseline, wrong digest/source, stale/wrong-target proof, absent Intel artifact all fail explicitly. ARM/Windows and historical-manifest controls pass. Run full `npm run verify:release` before a release candidate; local disposable DB gate needs running local Supabase. One heavy process at a time under admission/nice 15.

## Development and beta packages

With pinned target inputs staged:

```bash
npm run package:dev:dmg -- --arch=x64
npm run beta:doctor
npm run beta:package -- --arch=x64
```

Use separate ARM package with `--arch=arm64` sequentially. Packaging must not delete another target's outputs. Dev artifacts stay under `release/dev/`, beta under its isolated root; same flavor preserves product identity. `beta:doctor` readiness and existing canonical beta preparation must pass before packaging. An incompatible target host can inspect/cross-build but must not issue runtime-pass proof. Runtime verification on the matching Intel host uses the target package through the extended canonical `npm run beta:verify -- --arch=x64`; aggregate ARM/Intel beta proofs and the existing Windows hosted validation/installer proof at promotion, not by copying a record. Windows keeps its own pipeline; the macOS `.app` verifier cannot certify Windows.

On Intel test clean launch with no developer tools; real auth/entitlement; single-instance/Finder picker integration; compression/stitch/restitch/transcription fast+quality; landing preview/optimization and team background render. Force bundled browser/engines, deny access to host fallback caches. Check actual outputs plus visible UI result, cancel during work, power 20% and 100%, busy handling, settings/models retained across same-target reinstall. Repeat minimum/newer OS; record exact cases, versions and outcomes.

## Download, update and release fixtures

Use verified manifest fixtures for three artifacts, historical two-artifact channel, absent Intel, invalid signature/digest, unpinned URL and wrong-target candidate. Exercise every inventoried download/update surface for Intel/ARM/Windows, unknown/legacy and browser mismatch. User selection remains available; update never switches runtime target. If 048 native capability is absent, expect manual installer handoff; if present, run its same-target A→B/recovery/trust acceptance for Intel. No deployment or real stable mutation to test these contracts.

Inject wrong source, config, target, hardware or package seal in each beta proof; missing Intel proof must block final promotion. Read-only fixture runs verify old trusted channel separately and all three new final artifacts. Mini fixtures refuse agent/shared candidate changes and any incomplete/mismatched packaged baseline; Windows and ARM assets are preserved.

## Diagnostics

Run isolated producer→guard→storage→CLI regressions for healthy/failure/cancel/interruption/retry/missing/delayed cases. Commands below apply only to existing authorised read-only observations, never synthetic writes to production:

```bash
npm run analytics -- investigate <subject-id> --period 30d --json
npm run analytics -- inspect <attempt-id> --json
npm run analytics -- audit --period 30d --json
npm run analytics -- cohorts --cohort-by agent-architecture --json
```

Pin `--as-of <iso>` when comparing observations. Browser and native architecture must remain distinct, Windows x64 excluded from Intel Mac counts; missing boot/result/joins remain explicit insufficient. Beta emits no production analytics. Attach privacy-safe local artifacts for pre-agent failures; CLI does not claim remote OS rejection from absent events.

## Completion

Attach the three-target qualification matrix (native ARM, static Intel, hosted Windows) and all applicable trust checks. Run format on touched artifacts, `npm run verify`, and full release checks at implementation acceptance. Public Intel launch remains blocked until FR-010/011/013 are met; local package success is not production activation.

## Implemented input and proof workflow (2026-11-07)

`--arch=arm64|x64` works for Mac/dev/beta/DMG packaging and verification. Intel roots are `release/x64/`, `release/dev/x64/`, `release/beta/x64/`; ARM defaults stay compatible. Packaging refuses a running same-flavor app.

Build pinned Intel CPU engines with `SOTY_INTEL_BUILD_CACHE=/absolute/dedicated/cache nice -n 15 bash scripts/build-intel-inputs.sh`. The recipe verifies upstream hashes, builds one worker at a time and stages immutable runtime inputs. Node 22.23.4 preserves macOS 13.0; FFmpeg/FFprobe and Whisper are portable static builds. Full license texts, corresponding sources and the recipe accompany the runtime. Supply the Playwright-pinned Intel revision through `SOTY_CHROMIUM_SOURCE_ROOT` (basename `chromium_headless_shell-1234`). Alternatively stage reviewed files with `npm run runtime:mac -- --arch=x64 --inputs=/absolute/inputs.json`; see [input-inventory.md](input-inventory.md).

Dev cross-verification performs static payload, identity, dependency and signature checks without executing an incompatible target. ARM beta runtime verification remains native. Intel beta verification records static qualification with runtime/hardware unverified. Each beta record binds source, build ID, public config, metadata, agent payload and web payload. Intel `hardware-acceptance.json` is optional post-release evidence; it must contain actual observations if collected. Never manufacture these records or reuse ARM evidence.

The full runner handles ARM, Intel and Windows sequentially. New signed manifests use platform set version 2; historical manifests keep their authenticated set. Windows hosted proof binds source/run and smoke/final installer digests. `release/beta/platform-baseline.json` binds all platform proofs to signed channel bytes for subsequent mini releases. Production still requires actual Apple trust and the existing explicit activation gates.

For local startup fallback use `npm run analytics -- startup /absolute/native-startup.json --json`; it is bounded, sanitized and does not query/write production.

After packaging Soty Dev, run `npm run build:web` before production CSP or canonical verification. Dev packaging intentionally leaves the isolated Dev web bundle in `apps/web/dist`; production CSP checks require the production bundle. Keep `release/acceptance` inside the real worktree: only heavy target-specific `release/dev/x64` and `release/inputs/x64` caches may be symlinked to the dedicated external volume.

On this host the running local source stack is `affsupport037`, while `supabase/config.toml` names `wishly`. Use `SOTY_TEST_DB_SOURCE_PROJECT=affsupport037 npm run test:db` (or the same environment prefix on canonical verification) to select schema/role definitions only. This does not migrate, reset or copy rows from the running stack.

Use `npm run beta:verify -- --arch=x64` for static Intel qualification after packaging. It never launches x64 code and writes schema 3 under `intel-user-feedback-v1`. See [release-policy.md](release-policy.md) for first-user feedback and unchanged release gates.
