# US2 resource admission — recorded results

Recorded 2026-09-12 on the development host (MacBookAir10,1 — Apple M1, 16 GiB
physical, macOS 26.6.2).
Everything below is an observed run, not a restatement of the contract.

## Installed probe

| Property          | Value                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Executable        | `release/automation/probe/ResourceProbe`                                  |
| Build target      | `arm64-apple-macos13` (pinned; `swiftc -O`)                               |
| Executable digest | `47aa3daf85d97a9c…` (rebuilt after the available-memory correction below) |
| Source digest     | `daac3048da694730a33932d5893b5eeef2044da1be99658a738086ef81c07215`        |
| Provisioned by    | `node scripts/package-release-runner.mjs --build <destination>`           |

The probe reports raw counters only — cumulative CPU ticks, `CLOCK_UPTIME_RAW`,
`kern.memorystatus_vm_pressure_level`, reclaimable pages, `vm.swapusage`, volume
free space, thermal state, boot identity. Every rate is a difference computed by
`scripts/lib/release/probes-macos.mjs`.

## Sampled window against the real probe

Nine samples at the profile's 5 s interval (40 s span):

| Observation                                    | Result                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| First sample admissible                        | No — `RESOURCE_SIGNAL_UNKNOWN` (CPU and swap growth are differences; there is nothing to subtract from)                       |
| Last sample                                    | `cpuPercent` 19.41, `pressure` normal, `swapGrowthBytes` 0, `availableBytes` 4.30 GB, `diskFreeBytes` 26.1 GB, `thermal` fair |
| `stableWindow` over the final seven samples    | true; all seven verdicts `ok`                                                                                                 |
| `request({resourceClass: 'serial_tests'})`     | `RESOURCE_WAIT`                                                                                                               |
| Decision latency once the window was evaluated | 0.98 ms (target ≤ 10 s)                                                                                                       |

The wait is the correct answer and worth recording precisely: the window is
healthy, but with the `serial_tests` reservation (3 GiB) added to the 1 GiB floor,
the earliest samples in the window showed only 4.09 GB available. Admission is
refused because the _reservation_ does not fit, not because the machine is
unhealthy. This is the weak-machine behaviour the feature exists for.

## Status latency

20 consecutive `node scripts/release-runner.mjs status <run-id>` invocations
against a real snapshot, no network: **p95 = 105 ms** (target ≤ 2 s). The command
reads the local snapshot only.

## Scenario results

`npx vitest run tests/release-runner-resources.test.ts
tests/release-runner-resource-integration.test.ts
tests/release-admission-shell.test.ts` — 14 passed, 0 failed.

| Scenario                                                                                | Result                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Every registered heavy class has a bounded profile                                      | pass                                                             |
| 30 s window required; unknown pressure never admitted                                   | pass                                                             |
| Stale/sleep samples reset the window; resident RSS not subtracted twice                 | pass                                                             |
| Two critical samples terminate only owned interruptible work                            | pass                                                             |
| First probe reading cannot admit; admission only once every mandatory signal is derived | pass                                                             |
| Incomplete reading treated as unknown; slept machine detected                           | pass                                                             |
| Swap growth measured across the window, not between neighbours                          | pass                                                             |
| Independent runs serialized; one child inherits its parent lease                        | pass                                                             |
| Forged capability, stale generation, sibling queueing, worker death                     | pass                                                             |
| No managed child spawns without a grant                                                 | pass                                                             |
| A verification gate waits for the host-wide slot and frees it afterwards                | pass (5.1 s, one poll on the server's own `nextCheckAt` cadence) |
| A gate fails closed when admission is configured but incomplete                         | pass                                                             |
| Standalone packaging unchanged with no socket; partial runner config fails closed       | pass                                                             |

## Still open

SC-003/SC-008 numbers for an arm64 Mac with **8 GiB** remain T063: this host has
16 GiB, and its measurements must not be presented as that target's. The figures
above are labelled with the host they came from for exactly that reason.

## First dry run of the assembled runner — 2026-09-12

`SOTY_RELEASE_DRY_RUN=1 node scripts/release-runner.mjs start --intent …`, with
the beta stack running and the installed probe in use. This is the first time
the sequence has executed as one thing.

| Step             | What happened                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `start`          | Accepted in under a second; the supervised worker acknowledged durably and the command returned. |
| `preflight`      | Light, unadmitted, passed in 175 ms.                                                             |
| `prepare`        | Waited ~35 s for the first complete 30 s window, then ran in 1.2 s.                              |
| `candidate_gate` | Waited indefinitely; `RESOURCE_INSUFFICIENT`.                                                    |
| `cancel`         | Returned `cancelled`; no effect was left half-done.                                              |

The indefinite wait is correct behaviour and the most useful thing this run
produced. `candidate_gate` is class `serial_tests`, which reserves 3 GiB on top
of the 1 GiB floor — 4.29 GB. The machine had **3.06 GB** available, most of the
rest held by the running beta stack. The runner refused to start a full test
suite next to it rather than pushing the machine into swap.

Two consequences worth acting on:

- **Operationally**: stop the beta stack before starting a release, or expect to
  wait. The contract allows stopping an _owned idle_ stack automatically; this
  beta was started by the owner, so the runner correctly would not touch it.
- **For T063**: the 3 GiB `serial_tests` figure is the contract's initial
  estimate, not a measurement. It may well be too conservative — a single-worker
  vitest run is typically smaller. Calibrating it is exactly what T063 is for,
  and until then this class will be the first thing to block on a busy machine.

A gap this run exposed and closed: the worker never consulted the resource
scheduler at all. The lease server was running for child commands, but the
worker's own heavy steps were ungated, so none of the admission work was
reachable at runtime. `scripts/lib/release/worker-admission.mjs` now samples the
installed probe, adds any resident beta reservation, gates every heavy step, and
records each wait in the journal and the snapshot `status` reads.

## Calibration — measured 2026-09-12

The contract's initial figures were explicitly "calibrate, not measured facts",
and the dry run above showed why that matters: `serial_tests` reserved 3 GiB and
blocked a release on a machine with 3 GB free. Each class below was measured by
sampling the peak RSS of the command's own process group every 500 ms, on
MacBookAir10,1 (M1, 16 GiB, macOS 26.6.2), single worker.

| Class                    | Command                                     | Measured peak         | Was   | Now (peak + 20 %)    |
| ------------------------ | ------------------------------------------- | --------------------- | ----- | -------------------- |
| `shared_compile`         | `npm run build -w @video-compressor/shared` | 0.29 GiB / 1.2 s      | 1 GiB | 0.35 GiB             |
| `web_agent_native_build` | `npm run build`                             | 0.73 GiB / 10 s       | 3 GiB | 0.88 GiB             |
| `serial_tests`           | full `vitest run`, single fork              | 1.59 GiB / 8 min 11 s | 3 GiB | 1.91 GiB             |
| `package_archive`        | `npm run beta:package`                      | 0.67 GiB / 37 s       | 2 GiB | **2 GiB, unchanged** |
| `dependency_install`     | `npm install` (incremental)                 | 0.13 GiB / 2 s        | 2 GiB | **2 GiB, unchanged** |

Two estimates were deliberately not lowered. `package_archive` was measured on
_beta_ packaging; the production path additionally signs and mounts a disk
image, and lowering a reservation on the strength of a proxy would let a step
start that the machine cannot finish. `dependency_install` was only ever
observed repairing one missing package — a cold install was never measured.
`beta_stack`, `hash_download` and `unknown_registered_heavy` keep their original
guesses and are recorded as unmeasured in the profile's `calibration` block.

After calibration, with 4.77 GB available, every measured class is admitted —
including `serial_tests`, which needs 3.12 GB against the earlier 4.29 GB.

This is a partial answer to T063, not a complete one: the target host is an
arm64 Mac with **8 GiB**, and these numbers come from a 16 GiB machine. They
make the estimates defensible rather than invented; the 8 GiB run still has to
happen.

## Repository defect found while measuring

`apps/web/node_modules/@vitejs/plugin-react` was an empty directory from an
interrupted install dated 9 September, so `npm run build:web` — and therefore
every release path through it — failed with `Cannot find module`. `npm install`
repaired it without touching `package-lock.json`. Nothing in feature 020 caused
this; it had been broken in the working tree for three days.

## Correction — available memory was undercounted, 2026-09-12

The owner questioned a reported 2.27 GiB free on a machine macOS itself called
52 % free, and was right to. The probe computed
`free - speculative + purgeable + external`, which is wrong twice:

- `external_page_count` counts file-backed pages wherever they live, _including
  the active ones a running program is using_, so memory in use was counted as
  spare.
- `inactive` was left out entirely — the largest reclaimable pool on macOS, 3.9
  GiB at the time of the reading.

The two errors partly cancelled, which is why the figure looked plausible while
being both too low overall and composed of the wrong things. On the same machine
seconds apart: old formula 2.27 GiB, corrected 4.14 GiB, `vm_stat` arithmetic
`(free − speculative) + inactive + purgeable` = 4.14 GiB.

The consequence was real rather than cosmetic: admission is gated on this
number, so the runner waited for memory it already had. The measured class
reservations in the table above are unaffected — those are peak process RSS,
measured independently of this figure — but the earlier note that
`candidate_gate` could not be admitted against "3.06 GB available" was based on
the wrong denominator and should be read as a demonstration of the gate
refusing, not as a measurement of the machine.

The probe now also reports `inactiveBytes`, `wiredBytes` and `compressedBytes`
so a wait can be explained from the record instead of guessed at.
