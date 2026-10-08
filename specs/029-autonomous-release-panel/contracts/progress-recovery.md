# Contract: Progress, observations, recovery and finality

**Version**: 1 | **Status**: Proposed

## Source of truth

Canonical worker journal — only execution/effect receipts. Existing `{schemaVersion, runId, sequence, previousDigest, type, payload, timestamp, digest}` shape preserved. Controller task journal owns task/repair transitions; single writer for each. Normalize `event.payload` for metrics rather than expecting top-level duration/step fields. UI projections are recomputable caches, not proof.

Worker observations ephemeral: owner generation, PID/start/boot, last heartbeat, current process identity, last activity, optional native progress. Heartbeat every≤10 с. Unknown process data does not mean healthy or dead. Controller heartbeat never refreshes worker freshness.

## Progress formula

Freeze candidate applicable plan from STEP_IDS and verified backend plan before work. For included steps weights>0; excluded steps carry proof/reason and no denominator weight. Weight source: calibrated profile estimate, historical median last 10 validated matching-profile durations, fallback=1 low confidence. Frozen weights do not change mid-candidate.

```text
confirmedRatio = sum(weight of currently valid completed steps) / sum(included weights)
displayPercent = floor(100 * confirmedRatio), capped at 99 while not final-accepted
final canonical acceptance -> 100
```

Native command percent separately nullable; unknown command percent stays unknown. Time/heartbeat/logs do not increment formula. Repair attempt adds no completed weight. Changed evidence/new candidate may regress percentage; publish regressionReason/candidateOrdinal before rendering new percentage. Historical estimate не означає точний прогноз часу завершення.

## Liveness/stall

Observation stale at 30 с без worker heartbeat independent від execution state. Heartbeat + silent command→alive/activity unknown, not completed/stalled automatically. Stall suspicion requires process observations and deadline policy; no log-silence-only termination. Canonical timeout/interruption rules retained, noninterruptible publish/sign/backend/deploy reconciled before cancellation/retry.

Active time measured monotonic with sleep detection; suspend/offline/resource wait tracked separately. Repair reasoning deadline excludes system sleep; missing required resource readings beyond 60 с exposes diagnostic and triggers bounded recovery instead of endless admission wait. Impossible reservation discovered before work is configuration issue, not automatic reserve reduction.

## Ownership/recovery

- Target lock across run IDs plus existing run lock; validated registered target hash, not arbitrary path.
- PID/startMarker/bootId probe determines ownership. Missing heartbeat alone never frees lock.
- Same alive owner→adopt/query; proven absent→reclaim + generation bump; ambiguous→block writes.
- On controller restart reconcile task intent, journal hashes, candidate refs, worker/processes, repair claims and external effects before resuming.
- Controller uses shared canonical reconcile/start operation, not snapshot-only resume or reinitializing accepted identity.
- Partial journal tail quarantined by existing recovery rule; interior corruption blocks writes.
- Lost dispatch/upload/migration response→read remote actual result; matching/provenAbsent/ambiguous classification before repeat.
- Cancellation durable fence wins over delayed worker/provider result. Explicit resume of cancelled work requires new authorized request; no automatic restart from cancelled.

## Resource seam

Heavy worker commands and brokered repair checks share existing release admission. No parallel second build slot, no independent process suspender. Agent reasoning/network/panel does not consume build slot. Safe cancellation tracks only owned children; production/user tools not killed to free resources. Platform-specific changes inside product agent remain in its platform seam; operational scripts do not expand product OS exception lists.

## Completion/retention

Only canonical live_verify plus required branch/artifact/backend/beta evidence yields task completed/100%. Failed summary delivery does not rewind release; summary has own delivery state. Report includes active/wait/repair time, completed source/manifest SHA, version/artifact links, repair attempts, token known/partial/unknown.

30-day retention for journals/diagnostics/usage/results/capability proofs; no automatic cleanup unfinished task. Cleanup may delete only owned paths not needed for recovery; no tag/asset deletion. Panel/log/agent diagnostic all redacted before persistent write; raw model reasoning never becomes UI progress.
