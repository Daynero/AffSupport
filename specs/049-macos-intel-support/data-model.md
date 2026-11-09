# Data model: Intel platform support

No new product table or independent data directory. Existing identity/caches persist.

| Entity             | Required fields                                                                                                                               | Validation / relationships                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Target descriptor  | release platform, runtime arch, Mach-O arch, Swift target, artifact name                                                                      | Closed mapping from shared public target; no arbitrary strings/paths/commands                                                        |
| Platform artifact  | version, buildId, sourceSha, flavor, target, immutable URL, SHA-256, package seal, trust evidence reference                                   | One per required platform per release; distinct target paths; digest checked against final bytes                                     |
| Runtime identity   | installationId, agentInstanceId, platform, runtimeArch, product/build                                                                         | OS/arch sourced at native seam; browser identity independent; physical host/translation unknown unless directly observed             |
| Acceptance proof   | sourceSha, environment/config identity, target, package digest/seal, runtimeArch, physical hardware/OS evidence, scenario outcomes, timestamp | Matching target/source/bytes mandatory; translated execution cannot satisfy physical Intel proof; missing test stays blocked/skipped |
| Diagnostic attempt | flowId, attemptId, optional runId, installation/instance, target/build, stage, outcome/reason, source, occurred/received time                 | Opaque IDs only; bounded closed values; unknown fields stay unknown; correlations only with evidence                                 |

`product/build` are shared across target artifacts. Each target proof can coexist without overwriting another; aggregate readiness is derived only after every required proof is valid: separate ARM native and Intel static-qualified records and the source/installer-bound Windows hosted validation proof. No macOS beta record substitutes for Windows execution. Source equality does not establish package equality.

Packaging state: input validation → target staging → native inspection → sealed artifact → runtime acceptance → trust acceptance → eligible. Eligibility uses the owner-ratified proof level: Intel static qualification is accepted with runtime/hardware unverified; other required gates remain mandatory. Cross-build static checks are evidence only of that stage.

Attempt state: choice/request → boot → link/auth → readiness → operation accepted → terminal → result visible. Failure/cancel may terminate supported stages; missing terminal is interrupted/unknown. Recovery creates a new attempt linked to original evidence. `result_visible` requires a matching rendered result, not just exit code. Update stages are delegated to 048; manual handoff does not imply installation.

Retention and storage quotas reuse current diagnostics policy. Extending analytics columns requires a forward-only migration, generated types and RLS/privacy verification; bounded existing safe props are preferred. Legacy rows are not backfilled with inferred architecture.

## Implemented proof formats

Mac beta verification schema 2 binds `target`, `sourceRevision`, `buildId`, `publicConfigDigest`, `packageDigest` (release metadata bytes), `packagePayloadDigest` (agent/native resources), `webPayloadDigest`, native runtime architecture, physical host, virtualization, macOS version, clean source and ISO verification time. Metadata architecture/target and observed build must agree. Manifest-only descendants can reuse sealed binaries with fresh exact-source verification; other source changes refuse reuse.

Optional complete Intel hardware schema 1 requires two matching physical/nontranslated/nonvirtualized x64 observations: macOS 13.0 and a newer supported major, with every `INTEL_ACCEPTANCE_CASES` result passed. Windows schema 1 binds hosted workflow run, exact source, smoke installer digest, final installer digest and successful validate/install-use-uninstall/production package results. No Windows macOS-beta record exists.

The complete platform baseline binds both distinct Mac source/agent/web/proof digests and Windows evidence to exact signed-channel bytes. Mini candidates retain this baseline and do not rebuild native payloads. Historical authenticated channels retain their original set; platform set version 2 requires ARM Mac, Intel Mac and Windows.

Installer request intent uses the closed `installer_target` property. Observed `package_target`, native architecture and startup UUID come only from captured native health context. CLI exposes `requested_installer_targets` separately from installed identity; an installer click never establishes installation, native hardware or result delivery. Guard extension is forward-only in `20261207190000_agent_native_identity_analytics.sql` (single migration, renumbered after 047 by review-claude.md); no table/RPC shape or generated database types change.

Intel static qualification schema 3 is authoritative under [release-policy.md](release-policy.md): exact source/config/build/package/agent/web digests, target x64, native-file count, signature integrity and static deployment inspection; runtimeStatus/hardwareStatus remain unverified. Runtime architecture, physical host, virtualization and executed OS are absent. It cannot satisfy an ARM native proof. Platform/mini baselines bind verificationMode and acceptancePolicy alongside the proof digest.
