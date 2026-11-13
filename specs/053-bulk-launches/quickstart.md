# Acceptance guide

Work only in AffSupport-053. Install dependencies in this checkout; do not rebuild through another checkout's node_modules workspace symlinks. Run heavy commands with nice 15 and Vitest --maxWorkers=1 --no-file-parallelism.

The final durable/default-background implementation and exact local acceptance
are recorded in [reviews/owner-follow-up-validation.md](reviews/owner-follow-up-validation.md).
Earlier browser-local evidence below is historical; the durable section at the
end is the current acceptance contract.

1. Mixed launch fixture: draft, busy, ready, failed, partial, canceled; verify light/dark and narrow layout, keyboard selection/duplicate/archive, chronology across two pages.
2. Save four same-video drafts with five variations each. Select and Generate; inspect bounded dispatch and independent per-launch outcomes. Double click, reject one stale draft, stop queue and change team; no duplicate submissions.
3. Delay generation response: Results shows campaign names before completion; reserved catalog name when available; no pending link copy. Copy success remains visibly marked; denied clipboard does not mark.
4. Run cache regression with 20 compatible consumers, incompatible trim, cancellation and eviction; report cold/warm conditions separately. Native performance claims require actual timings, not only mocked call counts.
5. Diagnostic tests: producer/sanitizer/inspect retention and unknown evidence. Run npm run verify; record exact results and remaining runtime-only acceptance in reviews/validation.md.


## Unattended failure acceptance

The expanded fault matrix and exact evidence are in [reviews/resilience.md](reviews/resilience.md).
Reproduce the queue and shared-input faults without provider writes:

```bash
nice -n 15 npx vitest run tests/launch-batch-resilience.test.tsx tests/launch-batch-admission.test.tsx tests/restitch-multi-variation-reuse.test.ts --maxWorkers=1 --no-file-parallelism
```

The real batch and generation hook use a deterministic backend seam. Thirty-one batch
cases cover lost/late/stale receipts, long outages before and after save, removed sources,
provider refusal, hung reads, Stop during backoff/save, pending cancellation cleanup,
actor/permission fencing and fair slot reservation. Native cache tests use actual temporary
files for producer deletion and surviving consumers. The earlier browser-local evidence is historical. The owner now requires durable acceptance and continuation after full browser termination; the following acceptance supersedes that limitation.

## Durable/default-background acceptance
Submit ten drafts once, drop the acceptance response, close the browser and restart native Soty. Reopen under the same authorized actor: immutable batch receipt and canonical progress return automatically, with no duplicate generations. Delete one source, cancel one item and leave one upload outcome unknown; independently executable siblings finish. Test stale draft CAS, two tabs, same-key different payload, denied membership, old boot still alive, registered outputs retained, Retry-After and hourly cooldown without a restart. Prove SQL isolation in disposable PostgreSQL, native handoff with deterministic executors, and real browser layout separately; do not call mocked provider responses live-Google acceptance.

Start with old background setting off. Eligible authentication automatically establishes native credentials once. Concurrent tabs and lost confirm must not revoke working ownership. Logout/actor change/retirement at every await fences stale setup. Unsupported native reports update/connection state without a removed Settings toggle. Verify setup and batch outcomes through typed diagnostics/CLI, then run canonical verify and record exact source.
