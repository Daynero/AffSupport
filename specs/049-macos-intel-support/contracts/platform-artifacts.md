# Platform, package and release contract

## Canonical names and command boundary

| Public release key | Node runtime | Mach-O | Swift target           | Distribution                            |
| ------------------ | ------------ | ------ | ---------------------- | --------------------------------------- |
| macos-arm64        | arm64        | arm64  | arm64-apple-macos13.0  | Soty-v{PRODUCT_VERSION}-macOS-arm64.dmg |
| macos-x64          | x64          | x86_64 | x86_64-apple-macos13.0 | Soty-v{PRODUCT_VERSION}-macOS-x64.dmg   |
| windows-x64        | x64          | PE x64 | existing Windows build | existing Windows artifact               |

Public names/version/URLs derive from `packages/shared/src/release.ts`; no copied version literals. Toolchain mapping helper consumes this identity. Implemented interface: `npm run package:dev:dmg -- --arch=x64`, `npm run beta:package -- --arch=x64`, and admitted full runner dispatch to mac packaging with `--arch=x64`. ARM accepts `--arch=arm64`; no-arg retains current ARM behavior. Reject other/duplicate/conflicting values before cleaning outputs. These options are implemented; native beta acceptance still requires a matching physical host. Every npm wrapper forwards target through all child packagers/verifiers.

Per-flavor target staging directories and immutable filenames must differ, including browser staging, generated Swift, `.app`, ZIP, DMG temp/mount work and seals. Same-flavor bundle ID, port, support directory and instance lock remain the same across architectures. Only one heavy child/mount mutation at once; refuse busy owned work instead of deleting another target's evidence. Packaging scripts must consume explicit app/output path rather than assume `release/Soty.app`.

All shipped Mach-O files must include the requested slice; universal dependencies are allowed only if their target slice passes the same checks. Check target slice deployment load commands, recursive dylib/framework resolution (system or in-bundle only), executable permissions, required engine/browser revision/digest and input provenance. Host-only build tools are not payload. Static check does not execute target binaries as a substitute for matching-host smoke.

## Download and update selection

Resolver input: verified manifest, optional connected agent runtime platform/arch, optional explicit visitor selection. Connected runtime identity wins for updating that installation. Unknown/legacy runtime returns architecture selection required, never implicit ARM. For fresh downloads explicit Intel/Apple Silicon choice is available; browser is only a hint. Return a discriminated available/unavailable/choice-required result; keep existing envelope callers compatible through adapters rather than a fake URL.

An available Intel result must reference a signature-verified pinned artifact from the correct release; predicted fallback URLs cannot become Intel availability. Old manifests without Intel return unavailable. Native updater receives only same-target candidates under 048; no arbitrary URL, cross-target or automatic translation migration. Until native capability is verified, show manual installer handoff.

## Promotion and historical channels

New Intel-enabled candidate platform set is ARM + Intel + Windows. Packaging identity, signed channel, trust evidence and final provider bytes must agree. Full runner intent/state/adoption/recovery and signing iteration cover the same canonical set. Proof key includes source/config/flavor/target/package bytes. One target proof cannot satisfy another. ARM requires native packaged-beta evidence; Intel requires exact-source/config/sealed-package schema-3 static qualification under intel-user-feedback-v1. Intel native/hardware execution is post-release feedback, not a prerequisite. Windows requires the existing hosted validate/install/use proof bound to source and final installer bytes; do not run the macOS beta verifier as Windows evidence or introduce a Windows beta product. Canonical exact-SHA beta gating still applies to the release candidate. Failed or unknown upload remains governed by existing reconciliation, never automatic asset replacement.

Previous stable manifest is checked against its authenticated historical artifacts, not the candidate required set. Do not inject synthetic Intel entry into old channels. Fresh shared build precedes consumers. Mini releases preserve current signed channel and unchanged complete package baseline; no shared/agent modifications admitted through mini. Manifest-only commits retain their existing fresh exact-SHA beta requirement without binary rebuild.

Apple trust requirements come from 048; each final Intel artifact must independently meet applicable signature/notarization/stapling acceptance; Intel runtime/install behavior is first-user feedback. 049 does not implement an alternate updater. Production activation/runbook remain mandatory and unauthorised by this design.

See [owner policy](../release-policy.md). Static Intel acceptance is never a native runtime pass; mini retains its exact qualification mode and policy.
