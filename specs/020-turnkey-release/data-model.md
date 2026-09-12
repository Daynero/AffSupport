# Data model

Version 1 schemas validate all external/persisted data as unknown. No secret values or low-entropy secret hashes persisted.

## ReleaseIntent

runId UUID; repository identity; target account/project/origin bindings; sourceSha full object ID; exact version OR bump enum; notes digest OR deterministic commit-list rule; platforms macos-arm64/windows-x64; optional tracked backend-plan digest; immutable resource-profile snapshot; optional deadline; createdAt. Resolved digest binds every step. Reject unknown fields/arbitrary command strings.

## ReleaseRun

intentDigest, runnerRevision, sourceSha, releaseSha nullable until freeze, manifestSha nullable until manifest commit, ownedWorktree, state FR-036, currentStep, generation, ownerIdentity, timestamps, publicationState none/partial/complete, active/resourceWait/remoteWait/sleep timings, evidence refs.
Manifest commit is release descendant with only allowed stable manifest diff. No source mutation after publication.

## StepDefinition / Attempt

Definition: id, dependency IDs, adapter enum, fingerprint recipe, gate mode, resource estimates, timeout, interruption policy, retry classification.
Attempt: id/ordinal, lease, input fingerprint, process identity, effectId, timestamps, active duration, discriminated result, evidence refs. Existing success revalidated, not trusted from done flag.

## Journal / Snapshot

Event: schemaVersion, runId, sequence, previousDigest, digest, typed cleaned payload, timestamp. Prepare effect and flush before external write; record observation and verify before dependents. Snapshot temporary-write/sync/atomic rename records applied sequence.
Recovery replays validated events; torn tail quarantined, interior corruption blocks. Hash chain detects damage, not malicious authorization.

## Ownership / Lease

Lock spans repository/environment across versions on single maintainer host. Owner: PID+creation identity+boot identity, service job label, generation, children identities. Supervisor retains owned tree; resume cannot replace live owner/children. Remote drift still checked, local lock not distributed.
Heavy lease inherited by nested substeps; reservations track incremental remaining growth, not RSS already subtracted from available RAM. Resident services retain reservations until owned shutdown.

## ResourceSample / Profile

Sample: observedAt, bootId, wholeMachineCpu, availableBytes, pressure enum, swapUsedBytes, thermal enum, disk bytes per output volume, nullable validity/reason. First CPU interval invalid. Unknown mandatory signals wait.
Profile: 5s interval, 30s stability, 50% CPU ceiling, RAM reserve max(1GiB,15%), disk reserve 5GiB, swap growth max128MiB/window, maxHeavy1, class estimates. Bad/stale/sleep samples reset window.

## Evidence / ExternalEffect

Evidence: SHA, environment, gate/runner revision, public config digest, input/tool/artifact digests, package dirty-at-build, check outcomes, observedAt.
Effect: id, target, kind, correlation, source SHA, nonsecret request digest, remote ID, result unknown/absent/matching/conflicting, evidence.
Unknown → reconciling; proven absence permits policy retry; ambiguous/conflicting blocks. No published evidence invalidation into rebuild instruction.

## BackendChange

Tracked path/content digest, migration/function enum, project, position before-readiness/before-web, dependencies, typed checks, compatibleWithPrevious true, recovery document. Pending remote set exactly matches intent. Partial nontransactional unknown state blocks, no guessed rollback.

## Diagnostic / Metrics

Fingerprint(step+input+stable error), redacted subject/excerpt, evidence/log refs, publicationState, resumePredicate, delivery acknowledgment. One packet per unresolved fingerprint.
Handoff count separate from actual AI calls; model tokens nullable with accounting evidence. Baseline scenario identity required for comparisons.

## Transitions

Public states per FR-036. Restarted running → reconciling. Verified step → next ready. Wait clocks independent; explicit overall deadline → cancelling, then cancelled if external state known, otherwise blocked. completed immutable; repeated resume returns evidence. blocked requires changed predicate. Prepublication source repair uses new linked intent; old intent never edited.

## Added boundary entities (2026-09-09)

TargetBinding: production/sandbox kind, pinned public destination identities, artifact origin, public key fingerprint and configuration digest; no private values. All effect targets reference one validated binding.

LeaseSession: host-wide lock identity, run generation, private socket endpoint, registered child identities and parent/substep leases; capability remains ephemeral, not journaled. Lost heartbeat marks uncertain ownership, never automatic resource release.

HandoffJob: stable jobId/fingerprint, delivery_pending/accepted/running/repaired/cannotRepair/needsExternalDecision, bridge identity, acceptance receipt, repair reference. Model job count differs from transport retries. Bridge dedupe state durable across restarts.

MigrationReceipt: prepared/observed stages, project/version/source digest, baseline history identity, source SHA, transaction class, vetted pre/post outcomes. Adopted baseline requires authoritative external evidence; unknown source provenance is explicit blocking state.

ProbeInstallation: executable digest, source provenance, supported architecture and protocol; verified before start, no release-time compilation.
