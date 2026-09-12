# US4 bounded diagnostics and handoff — recorded results

Recorded 2026-09-12 on the development host (MacBookAir10,1, 16 GiB, macOS 26.6.2).

`npx vitest run tests/release-runner-diagnostics.test.ts
tests/release-runner-handoff.test.ts tests/release-runner-metrics.test.ts` —
8 passed, 0 failed.

## Zero-model paths

| Path                       | Model invocations | Evidence                                                                                                                                 |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Normal release progress    | 0                 | The runner imports no model client; `scripts/lib/release/` contains no network call to one. Progress reporting reads the local snapshot. |
| Bridge health check        | 0                 | `bridgeHealth()` spawns the registered executable with the fixed argument `--release-bridge-health` and compares one exact reply string. |
| Preflight dependency check | 0                 | `installedDependencies()` digests the probe and health-checks the bridge; neither reads a prompt.                                        |
| Transport outage retry     | 0                 | Delivery retries are a backoff timer over a durable record; no call is made except to the bridge.                                        |

## Transient versus deterministic failure

| Scenario                                 | Handoffs          | Recorded behaviour                                                                                                                                                                     |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport outage, bridge reachable later | 1 job, 2 attempts | First attempt fails, record stays `delivery_pending` with `lastError: BRIDGE_UNAVAILABLE`; backoff 30 s → 5 min ceiling; the retry asks about the job rather than submitting it again. |
| Same failure enqueued twice              | 1 job             | Identity is the failure fingerprint, so a second enqueue returns the first job — a second repair is never started.                                                                     |
| Reply lost after the bridge accepted     | 1 job             | The record is marked submitted _before_ the call, so the retry is `query`, not `submit`. The bridge answered `repaired` and the record carries `revalidationRequired: true`.           |
| Bridge cannot decide                     | 1 job             | State `needs_external_decision`; nothing claims autonomous completion.                                                                                                                 |

## Bounds

| Limit          | Enforced                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Success report | 20 lines / 8 KiB                                                                                  |
| Failure report | 100 lines / 16 KiB                                                                                |
| Secrets        | Redacted before disk and before any handoff payload exists, including split tokens and PEM bodies |
| Bridge reply   | 64 KiB cap, 30 s timeout, killed on breach                                                        |

## Token accounting

`releaseMetrics()` reports `handoffs` and `modelTokens` separately, and
`modelTokens` stays `null` unless a real `model_usage` event supplies a number.
A handoff is a delivered request, never evidence that a model ran.

**No token-saving claim is made here.** The ≥90 % reduction in SC-006 needs a
same-scenario manual baseline, which is T064 and remains open for the reason in
`validation/blockers.md`.

## Still open

A protocol seam with a fake consumer is not a completed handoff feature. The
contract smoke against an actually registered, functioning bridge (terminal
closed, job accepted, response lost, bridge restarted, same job recovered, gate
rerun) is part of T061/T062 and cannot run on this host: no bridge is registered.
`scripts/release-acceptance.mjs` fails closed on exactly that.
