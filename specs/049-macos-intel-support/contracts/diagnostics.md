# Intel diagnostic contract

## Identity and correlations

Keep browser `architecture` semantics unchanged. Add or reuse explicit bounded native `agent_architecture` (arm64|x64|unknown), package target (macos-arm64|macos-x64|windows-x64|unknown) and product/build identity through typed contracts. Physical host/translation evidence is separate and may be unknown. Do not infer native architecture from user-agent, macOS alone or artifact click. The implemented event properties are `properties.agent_architecture`, `properties.package_target` and UUID-only `properties.native_startup_id`; client, SQL guard and CLI projection share these meanings.

Use existing flow/attempt/run IDs and installation/agent instance envelopes; new retry gets its own attempt. Download without native correlation remains unjoined. No raw path, file/user content, credentials, command line or provider payload. Codes are closed shared enums plus code-map entries. Signals retain existing retention/size bounds; unavailable collection never changes product success.

## Stage and evidence matrix

| Journey                  | Required proof                                                                                      | Failure/cancel/recovery                                                      | Missing evidence treatment                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Choose/download          | user choice, requested verified target                                                              | unavailable/wrong target; explicit cancel if observed                        | click does not prove bytes, install or native boot                             |
| Startup/link/auth        | native boot identity, handshake and auth/entitlement stage                                          | engine/startup code; new boot instance after restart                         | no boot = insufficient; OS rejection needs safe local evidence                 |
| Tool execution           | readiness → accepted/run → terminal → matching result visible                                       | spawn/CPU/timeout code, explicit cancellation, interrupted attempt and retry | terminal without visibility = delivery unknown; GPU metric null is not failure |
| Installer handoff/update | selected same-target build, handoff or 048 native stages, target boot/readiness and UI confirmation | inherited 048 cancel/recovery codes, missing candidate                       | handoff is not installation; no native capability means manual flow            |

## CLI and coverage

Extend `cohorts --cohort-by agent-architecture` additively. Buckets arm64/x64/unknown refer to observed runtime, not guaranteed physical hardware; preserve platform/build breakdown so Windows x64 is not counted as Intel Mac. `investigate`, `inspect`, `audit` preserve `{ok, command, generated_at, period, data}` and fact/hypothesis/insufficient semantics, time pinning, delivery lag, truncation and explicit blind spots. Missing producer remains unsupported/unknown, never zero.

Register target journeys in `scripts/analytics/coverage-registry.ts`, add each new code to `packages/shared/src/types.ts` and `scripts/analytics/code-map.ts`, update CLI documentation. Existing browser architecture rows retain historical meaning. Query only through read-only CLI, parameter binding and SQL guard; no ad-hoc production SQL.

## Verification boundary

Tests must send real typed producer signals through sanitizer/ingestion and storage projection into CLI query/diagnosis fixtures. Cover each matrix row with healthy/missing/failure evidence and ARM/Windows controls, delayed delivery, retry and mismatched identity. Beta production analytics remains disabled: use privacy-safe local package/runtime evidence and isolated transport/storage fixtures. Test permission/privacy rejection and code-map completeness. An emitted event or a mocked final CLI response alone is insufficient.

## Implemented local fallback

Health exposes optional `architecture`, `packageTarget` and `nativeStartupId`. Architecture comes from the native runtime seam; package target comes from installed metadata matched to its build ID; startup ID comes from the launcher UUID. Browser architecture retains its existing meaning. Physical host/translation identity is confined to acceptance evidence and may not be inferred from a macOS x64 runtime cohort.

The launcher writes `native-startup.json` in its flavor-specific application support directory: at most 32 records and 32 KiB, owner-only permissions. Records contain `schemaVersion`, UUID `attemptId`, integer `timeMs`, closed `stage`/`code`, compile architecture and bounded build ID. No paths, exception text, user content or credentials enter this journal. Codes/stages are `MACOS_STARTUP_CODES` / `MACOS_STARTUP_STAGES` in shared types.

The diagnostics route includes sanitized evidence when the Mac server is available. `analytics startup <file> --json` reads an exported local file without a database connection; it preserves period/as-of, returns last proven stage/outcome, explicit insufficient history and code locations. `STARTUP_READY` proves server readiness. Result visibility, auth success and installer completion require their separate signals. A download click carrying a currently connected startup ID does not join a future install or cross-device boot. Before any launcher record exists the cause remains insufficient; OS rejection is not inferred.

Readiness is recorded only for a live launched child whose health UUID matches the current captured startup attempt. Responses from a previous attempt, missing/foreign UUID and a terminated child cannot set the attempt ready. The regression compiles and executes the production Swift readiness method rather than substituting a final diagnostic response.

`installer_target` is a closed requested-artifact field, separate from observed `package_target`. The browser analytics service discards caller-supplied native identity and derives it only from the captured health context. Fresh download clicks carry no native identity. Inspect exposes `requested_installer_targets` separately; investigate uses the same explicit request list. A real producer/guard/storage/cohort fixture and an actual inspect query verify that a requested Intel installer remains unknown native hardware and has no successful terminal. Onboarding tests verify the actual click property. Disabled-option intent is unobserved; it must not be inferred as a click.
