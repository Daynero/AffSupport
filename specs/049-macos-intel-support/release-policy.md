# Intel release acceptance policy

Owner decision, 2026-11-07: no physical Intel test machine is available; first Intel users will exercise the runtime, as with user-led Windows feedback. This decision supersedes earlier requirements that physical Intel macOS 13.0/newer acceptance or a native Intel packaged-beta run must precede publication. It does not mark those tests passed and does not authorise production activation.

The source policy ID is `intel-user-feedback-v1` in `scripts/lib/release/platform-evidence.mjs`. It is a versioned acceptance rule, not an environment switch that skips arbitrary gates.

## Before release

- ARM keeps real exact-source packaged-beta authentication, entitlement and operation verification. Windows keeps its hosted validate/install/use and final-installer evidence.
- Intel requires its own clean exact-source/config/build/metadata/agent/web seals, recursive x86_64 Mach-O/deployment/dependency checks, pinned target engines/browser and signature integrity. `beta:verify -- --arch=x64` performs static qualification without launching target executables, opening the app, or requiring a native Intel host.
- New candidates still require ARM Mac, Intel Mac and Windows assets, verified immutable hashes, signed-channel validation and the existing Apple public-trust checks. Dev auth never becomes beta auth.
- Intel production package/DMG verification inspects the target bundle and signatures without running x64 code. A running production app need not be stopped for static Intel inspection.
- Missing/stale/wrong-source/config/target/payload/signature evidence still blocks. A failed beta verification removes that target's old record.

## Evidence levels

Intel static qualification uses schema 3 in `release/beta/x64/verification.json`: `verificationMode=static-cross-build`, `acceptancePolicy=intel-user-feedback-v1`, `runtimeStatus=unverified`, `hardwareStatus=unverified`, target architecture `x64`, signature integrity and native-file count. Minimum OS verification is load-command inspection only. The record contains no claimed runtime architecture, physical host, virtualization observation or executed macOS version.

Schema 2 continues to mean an actual native run; it is required for ARM and accepted when genuine Intel native evidence exists. An optional complete hardware report can be validated separately, but `hardware-acceptance.json` is not a release prerequisite. Translation/static inspection must never be renamed physical success.

The mini-release platform baseline retains the verification mode and policy together with the exact proof digest. Static Intel evidence cannot be relabelled native or replace an ARM proof. Historical native baselines remain valid under their recorded level.

## First-user feedback

Physical runtime scenarios from `INTEL_ACCEPTANCE_CASES` are post-release follow-up, not a pre-release hardware checklist: real auth, compression, stitch/restitch, both transcription modes, landing tools, team rendering, Finder, cancellation, 20/100% power, retained data and single instance. Record only observed outcomes; no feedback remains unknown, not passed.

Use the existing read-only CLI: `cohorts --cohort-by agent-architecture`, `updates`, `errors`, `investigate <email>` and `inspect <id>` with `--json` and pinned `--as-of` when comparing. Mac x64 describes a runtime and may be translated; do not infer physical Intel. `installer_target` is request intent, not an installed native identity. Before server startup, use the bounded local startup journal and `analytics startup <file> --json`. Do not collect content, raw paths, secrets or hardware serials.

User reports ship through the normal fix/regression/release path. Do not contact users, publish, move tags, replace assets, hot-patch production or roll back automatically merely because this policy exists.
