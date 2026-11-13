# Research decisions

## Reuse generation orchestration
Decision: existing `useLaunchGeneration` per admitted item. Rationale: CAS save, stable intent, uncertain reply reconciliation, native foreground authority and legacy restitch already exist. Alternative rejected: direct Promise.all of generate RPC bypasses lifecycle fences. Accepted work survives closing detail; unsubmitted batch work does not survive page closure.

## Reuse media caches, harden ownership
Decision: verified content-keyed source/inspection/body caches with grouped source locality and bounded admission. Existing warm sequential launches already benefit; no invented N-fold claim. PreparedBodyCache has single-flight but lacks independently canceled waiters and safe eviction ownership. Pin/materialize the body through pipeline completion; deduplicate inspection. Final variants remain separate.

## Progressive results
Decision: distinct pending-result view using launchNamingPreview; authoritative reservation projected from durable catalog intent checkpoint. Alternative rejected: fake LaunchRevision, guessed final name, prematurely usable URL. Old committed result must not masquerade as current pending work. Early campaign copy is session-local until confirmed revision exists.

## Chronology and state
Decision: server creation-time cursor ordering; keep planned launch date separate. Add bounded progress snapshot in list projection, no N+1 reads. Never infer ready from existence of an old result if a new attempt failed; missing legacy hasResult stays unknown.

## Design and controls
Decision: explicit semantic status badges, time, persistent copy/check affordance, direct SelectionBar actions, existing checkbox/marquee plus scoped shortcuts. Keep editable elements, native text selection and overlay key handling intact. Timed copy receipt has no redundant reopen action.
