# Resource admission contract

One outer heavy lease, inherited by nested substeps that recheck load without reacquiring outer lock. Lightweight status/probes/remote waiting can overlap. Downloads/hashing/native compile/stack startup are heavy boundaries.

## Signals and stability

5s samples; CPU cumulative differences, native available-memory/pressure/swap/thermal, destination-volume free space. A prebuilt nonprivileged arm64 helper shipped with the runner returns typed bounded JSON; no sudo/GUI dependency. Its executable digest and source provenance are checked at installation and preflight. No runtime compilation: missing or mismatched helper is PROBE_UNAVAILABLE and blocks before any heavy step. All mandatory pressure/swap/memory/CPU/disk readings are required immediately; no reduced bootstrap exemption.

30s continuous valid window; reset on gap>10s, bad reading or sleep/boot change. CPU≤50%; memory pressure normal; swap growth≤128MiB; thermal not serious/critical. RAM next peak + max(1GiB,15%physical) + unconsumed reservations; disk new temporary bytes +5GiB each volume. Unknown thermal allowed serial; unknown mandatory signals waits.

## Initial estimates (calibrate, not measured facts)

| Class                    | Incremental RAM | Temporary disk                        | Timeout / interruption                     |
| ------------------------ | --------------- | ------------------------------------- | ------------------------------------------ |
| Shared compile           | 1GiB            | 1GiB                                  | 3min / owned terminate                     |
| Dependency install       | 2GiB            | fallback6GiB or3×known installed size | 15min / owned terminate                    |
| Serial tests             | 3GiB            | 2GiB                                  | existing gate timeout / owned terminate    |
| Web/agent/native build   | 3GiB            | 4GiB                                  | existing timeout or15min / owned terminate |
| Beta stack               | 3GiB resident   | 8GiB                                  | startup15min; reservation until shutdown   |
| Package/archive          | 2GiB            | 3×staged inputs                       | 45min / finish mounted-DMG boundary        |
| Hash/download            | 256MiB          | full download plus partial allowance  | 30min / owned terminate                    |
| Unknown registered heavy | 4GiB            | 10GiB                                 | explicit bounded timeout required          |

Track high-water observations; raise estimate to observed peak+20%; reductions require checked-in calibrated revision. Never lower thresholds automatically because host busy.

Available RAM already includes resident stack consumption: reserve only remaining possible growth, not RSS twice. Stop owned idle stack before nondependent builds if necessary, never borrowed/busy service. Stack-dependent smoke may need further memory reduction to pass8GiB target.

Bad sample closes new admission. Fixed compiler workers cannot resize live; serial config at launch. Critical memory pressure two consecutive samples terminates only interruptible owned step; one automatic resource-recovery retry maximum, then diagnostic. Noninterruptible boundary bounded and reconciled first. Ordinary pre-start wait unlimited unless explicit overall deadline.

nice15, SOTY_VERIFY_SERIAL=1, one test worker/no file parallelism. Nested heavy shell boundaries use inherited admission wrapper. No second PowerGovernor suspend controller. Resource status changes don't invoke model every sample.

## Lease IPC protocol

The worker is the sole admission authority. It owns a Unix-domain socket in the private run directory (0700 directory, 0600 socket). A host-wide heavy lock spans runs/targets on the same PC, in addition to per-target writer locks: two independent target runs may not each start a heavy build.

Wrappers send bounded versioned messages: {version:1, requestId, runId, generation, parentLeaseId, stepId, childIdentity, operation}. Operations: request, heartbeat, release. Worker returns waiting(reason,nextCheckAt), granted(leaseId,substepId,generation), or denied(code). The caller authenticates with an ephemeral per-run capability passed through an inherited pipe, never argv/logs/journal. Worker validates registered child PID/start identity, parent relationship, registered step and generation; arbitrary callers/commands rejected.

A parent owns the outer lease but waits while its one admitted child substep runs. Nested request inherits the outer lease, never reacquires it; siblings queue, no recursive deadlock. Each child admission requires a fresh full stable window. Release is idempotent by requestId/substep; parent cannot start its next heavy segment until child completion is recorded.

Heartbeat every 5 s; after 15 s without heartbeat, mark ownership uncertain, not free. Worker must reconcile actual owned process tree and supervisor before releasing host reservation. Socket loss or worker death: wrappers do not start any new heavy child; active noninterruptible work follows its boundary policy. Resume increments generation only after old worker/children are reconciled; old grants cannot be reused. Tests include forged/replayed capability, concurrent different-target runs, lost reply, stale release, sibling requests, nested depth and worker death.
