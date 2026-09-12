# CLI contract — proposed

Not implemented commands yet:

```text
npm run release -- preflight --intent <absolute-json-path> [--json]
npm run release -- start --intent <absolute-json-path> [--json]
npm run release -- status <run-id> [--json]
npm run release -- resume <run-id> [--json]
npm run release -- cancel <run-id> [--json]
npm run release -- report <run-id> [--json]
```

preflight performs light reads only; may save local report but never install/build/mutate branches/services. Heavy prerequisites reported as scheduled work. start resolves intent, locks target and acknowledges supervised worker durably before returning. Accepted does not mean completed. status/report read snapshot without network.

Envelope: `{schemaVersion:1,ok,command,runId,state,generatedAt,data,error}`. Error null or `{code,subject,resumePredicate,diagnosticRef}`. data carries phase, nextCheckAt, wait reason, timing categories, publication state and result location.

start/resume exit0 accepted; report exit0 only completed, exit3 active/waiting, exit1 blocked, exit4 cancelled. Invalid input/preflight failure exit2. status exit0 means readable; inspect state. Outputs bounded per FR-033; references replace raw log expansions.

Codes: INTENT_INVALID, TARGET_MISMATCH, ACCESS_UNAVAILABLE, RELEASE_CONFLICT, JOURNAL_CORRUPT, EFFECT_AMBIGUOUS, INPUT_CHANGED, BETA_EVIDENCE_INVALID, GATE_FAILED, POLICY_UNRATIFIED. Resource wait is a normal state, not failure.

Intent names vetted target/profile bindings, not secrets or executable strings. A configured supervised agent bridge is required for unattended failure handling, as defined in contracts/handoff.md. It reads durable handoff outbox and acknowledges unique fingerprint once. Runner has no model dependency and never wakes model for unchanged progress. Consumer cannot mark gate passed or mutate frozen identity.

Preflight validates bridge registration/identity/configuration and current availability. If unavailable before start, report AGENT_BRIDGE_UNAVAILABLE without starting heavy work. If lost mid-release, healthy deterministic phases may continue; a failure requiring repair blocks and delivery retries automatically. No model is invoked for heartbeat/status checks.
