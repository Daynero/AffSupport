# Trust integration — 2026-11-06

> Current owner policy (2026-11-07): [intel-user-feedback-v1](release-policy.md). Physical/native Intel tests are post-release user feedback, not a publication prerequisite. Earlier hardware-blocking checkpoints below are historical; no unexecuted case is marked passed. ARM native beta, Windows hosted, static Intel seals/signatures and applicable Apple trust remain required.

048 remains an untracked documentation feature in the original worktree, not implemented source at the isolated base `59524e4b`. Current `package-mac.sh`, dev and beta use ad-hoc `codesign --sign -`; no notarization/stapling or native transactional installer capability is proven. `ReleaseUpdateNotice` and LocalAppDialog perform browser installer handoff. Agent update pending/draining is not evidence of trusted native install.

049 must preserve manual installer handoff and same-runtime target selection. Do not introduce a second updater or advertise automatic install. Apple Developer signing material, applicable 048 implementation, per-target trust/clean install and A→B recovery acceptance are prerequisites for public Intel launch. They do not prevent implementing local target-aware packages, resolver or diagnostics. No trust gate is waived and no release is authorised.
