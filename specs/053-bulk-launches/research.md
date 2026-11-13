# Research decisions

## Durable generation orchestration (owner supersedes browser-local admission)
Decision: trusted Edge preparation plus one service-only atomic batch acceptance RPC. Store immutable batch membership and deterministic child request identities, isolate each acceptance/refusal in SQL subtransactions, and reuse existing durable generation/native execution. Google/source byte proof remains mandatory before execution effects. Noncatalog work publishes through its existing deterministic commit path after authoritative source validation. Alternative rejected: localStorage queue, a new browser admission scheduler, or forging caller JWT claims for service reads.

## Automatic background ownership
Decision: one existing workspace preparation owner performs status/secure native enroll → authenticated delegation → native confirm, with actor fences at every await. Coalesce setup in native across tabs; make same-ticket cloud delegation/confirmation idempotent. Previously user-disabled installations enroll on next eligible connection. Security retirement and revoked membership stay terminal; transient outages retry automatically. Alternative rejected: toggling a DB flag without durable OS credentials or enrolling on every mount.

## Native fairness and restart
Decision: fair paced set claims, silence reconciliation and quiescent same-installation background restart adoption with fresh epoch. Preserve registered outputs, consumed execution fences and unknown uploads. Probe again after hourly retry budget expires, even without restart. Alternative rejected: reassigning an active upload, resetting backoff on reboot, or allowing one uncertain oldest set to monopolize every claim.

## Reuse media caches, harden ownership
Decision: verified content-keyed source/inspection/body caches with grouped source locality and bounded admission. Existing warm sequential launches already benefit; no invented N-fold claim. PreparedBodyCache has single-flight but lacks independently canceled waiters and safe eviction ownership. Pin/materialize the body through pipeline completion; deduplicate inspection. Final variants remain separate.

## Progressive results
Decision: distinct pending-result view using launchNamingPreview; authoritative reservation projected from durable catalog intent checkpoint. Alternative rejected: fake LaunchRevision, guessed final name, prematurely usable URL. Old committed result must not masquerade as current pending work. Early campaign copy is session-local until confirmed revision exists.

## Chronology and state
Decision: server creation-time cursor ordering; keep planned launch date separate. Add bounded progress snapshot in list projection, no N+1 reads. Never infer ready from existence of an old result if a new attempt failed; missing legacy hasResult stays unknown.

## Design and controls
Decision: explicit semantic status badges, time, persistent copy/check affordance, direct SelectionBar actions, existing checkbox/marquee plus scoped shortcuts. Keep editable elements, native text selection and overlay key handling intact. Timed copy receipt has no redundant reopen action.

### T050 canonical rename impact
Existing result edits only modify revision overrides; ordinary provider rename is blocked by `private.guard_launch_output_operation` for launch-referenced outputs. Reuse material operation authority with a narrow explicitly admitted catalog rename, preserving all other guards and active generation exact-name proof. Drive v3 does not provide this codebase's verified conditional mutation seam; reuse v2 ETag authority. Add canonical name projection and confirmed alias history, retain immutable revision/catalog binding snapshots. Existing generic rename tail mints a new key and can treat unresolved fulfilled operations as success, so the new shared control must use stable key/readback and require confirmed completion.
