# Resumed video integrity — 2026-11-14

Integration follow-up on `integration/next-release-2026-11-13`. No production publication or migration is authorized by this document. Source beta remains separate from packaged acceptance.

## Reproduced failures

The third server audit handoff reproduced two critical cases, then the integration agent repeated both with 15 existing cases passing: a same-size source replacement after partial upload yielded a mixed public file and `ready`; three bounded verification invocations reread the same prefix and never finished. The initial transferred test patch had a fixture initialization defect; it was corrected before this evidence. See ignored `scratchpad/manual-beta-20261114/r2-integrity-before-corrected.log` and the audit round3 manifest. The green handoff separately delays staging deletion until ready acknowledgement.

## Required behavior

- A ready copy must match one frozen, trusted source checksum, including across process boundaries and equal-size input replacement. An absent checksum must be resolved only against the original publication source identity. An unverifiable source stays unready; no random probe can substitute for full integrity.
- Verification must durably advance across bounded invocations. A lost checkpoint acknowledgement, stale lease, changed manifest or changed staging object must never skip bytes or feed a prefix twice.
- Healthy durable progress does not consume a failure retry budget. No-op renewals, observations or budget yields do not reset failures.
- A ready acknowledgement loss cannot destroy reconciliation input. Staging-only cleanup is durable and cannot delete public output. Cleanup retries do not undo a confirmed ready result.
- Read-only diagnosis identifies the last proven verification prefix, full source-proof status, unknown ready acknowledgement and cleanup obligation without exposing checksums, media, provider object IDs, URLs or credentials.

## Implementation plan and consistency analysis

Reuse staged readback for a rolling MD5 comparison with the immutable Drive MD5. Serialize a versioned bounded state (four uint32 words, byte count and at most 63 buffered bytes) in private checkpoint storage. Digest a clone; snapshots remain resumable. Checkpoint binding includes copy identity, frozen source checksum, staging ETag and exact ordered manifest fingerprint. Every advancement uses an active fence and expected previous cursor; authoritative reload resolves an unknown reply.

Use conditional S3 reads and source-conditional promotion against the same staging ETag. Verify exact range/length before accepting bytes. Public probes compare against that proven staging object, so deleting the original after successful copying does not invalidate a complete proof. Drive v3 If-Match is not assumed to pin its media. If the snapshot has no MD5, read metadata and verify its content-v1 identity, or explicitly strict-v1 identity with the original Drive revision, before freezing a valid checksum. Never replace an existing checksum.

Add service-only RPCs and a private checkpoint plus separate staging-cleanup obligation. Ready enforces the complete proof server-side, not only a worker boolean. Initialize old pending copies with an empty proof; never treat old partial evidence as complete. Reset consecutive attempts only with durable upload/checkpoint advancement. Cleanup is idempotent, generation-bound and staging-only, including when ready committed but its acknowledgement was lost.

The existing general purge path removes both staging and public objects; it must not be reused for ready staging cleanup. The final promotion/probe phase also needs a budget boundary, preserving the completed checkpoint for later claims. Rollout must drain/fence legacy invocations before new publication qualification: a DB guard alone cannot cancel a provider request already signed by an old worker. No deployed rollout is performed here.

## Tasks

- [x] Reproduce both failures in integration and review the plan against lease, source, retry and cleanup contracts with the audit agent.
- [x] Implement bounded MD5 snapshots and staging conditional identity guards with reference-digest and malformed-state regressions.
- [x] Add additive service-only fenced checkpoint/source-binding/ready/cleanup contracts and disposable database fence/CAS regressions (native full-chain gate remains below).
- [x] Wire worker resume, full digest, healthy progress, finalization and cleanup; pass both original reproductions.
- [x] Verify lost acknowledgements, stale fence, changed staging/manifest, missing checksum and source deletion; extend diagnosis and privacy coverage.
- [ ] Run exact combined release verification; update beta only through canonical local migration and owned source sync. Preserve old failed/interrupted evidence.

## Provider and cleanup boundary review

Official R2 documentation confirms source-conditional CopyObject, strong conditional reads and create-only multipart completion. The implementation sends `x-amz-copy-source-if-match` on promotion and `If-None-Match: *` on completion. See [extensions](https://developers.cloudflare.com/r2/api/s3/extensions/) and [conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/). No atomic conditional DeleteObject capability was established. Staging cleanup therefore uses a never-reused copy-generation key and a ready-only obligation, with an ETag mismatch refusing cleanup; HEAD then DELETE is explicitly not claimed as CAS. Public bytes are never removed by this queue. Legacy in-flight writes require the documented drain before rollout.

Initial focused protocol run: 63 checks in five files passed, including the two original reproductions, snapshot reference vectors, lost checkpoint and ready acknowledgements, source disappearance, changed staging and SQL fences. The added producer-to-view-to-read-only-CLI test also passed, along with the capability registry checks (14 total, overlapping scope). New verification projections preserve historical and reply-delivery unknowns and exclude hash states, checksums, media and provider keys. These are development checks, not final combined-source or live-provider qualification.

The first combined release run passed static gates but failed its first suite shard. The new private tables lacked the shared task-reference triggers, which correctly disabled workspace cleanup admission. Both now participate in the existing fence; no exception was added. The investigation privacy guard also rejected a slash in static explanatory prose; the text was corrected without weakening the guard. A further integration check found that an isolated staging-cleanup obligation was absent from the scheduler's work predicate. The sweep now discovers it, respecting active leases, backoff and completion. Producer-to-diagnosis tests assert the actual privacy guard. All seven affected suites passed on repeat (75 tests), including original workspace cleanup, material sharing and replacement regressions. Failed combined evidence is retained; final qualification remains pending.
