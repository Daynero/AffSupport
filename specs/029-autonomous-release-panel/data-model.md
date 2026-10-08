# Data Model: Task, candidate, repair and observations

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Records schemaVersion=1; parsed input unknown до validation. UUID/SHA/digest/enum validation, filenames від hash validated identity. Paths canonicalized й allowlisted; model input не визначає executable.

## ReleaseTask

taskId, repositoryId, registered targetId/targetKind, immutable policyDigest/intentRef, originSessionRef nullable, candidateRunIds, activeRunId, state, repairPolicy, budgetLedger, successorPolicy, revision/timestamps, blocker nullable, finalReportRef nullable.

State: preparing→executing→completed; executing→waiting_agent→repairing→validating_repair→executing. Active state→needs_owner або cancelling→cancelled. Після needs_owner тільки перевірена зміна передумови/дозволу; cancelled не відновлюється автоматично. Exactly one active candidate/target.

## CandidateRun

Existing canonical snapshot + taskId/parentRunId/candidateOrdinal/replacementReason, frozen applicablePlan, workerGeneration. runId/sourceSha/version/target immutable; manifestSha окремо. completedSteps/evidenceRefs тільки із canonical validated receipts. publicationState receipt-derived, не за словами агента.

Shipping SHA change→new run ID. Manifest-only commit→new exact-SHA beta proof без production binary rebuild. Source repair після публікації→authorized new-version successor або owner blocker.

## StepPlan, StepAttempt, Evidence

- StepPlan: registry stepId/dependencies, included, exclusionEvidenceRef, weight>0, weightSource=profile/history/fallback, profileDigest. Frozen/candidate.
- StepAttempt: attemptId/runId/generation/stepId, inputDigest, startedAt/finishedAt, active/wait duration, status, native commandPercent nullable, errorRef.
- Evidence: gateId, input/environment digests, source/manifest SHA, result/receiptRef, valid або invalidated reason.

Heartbeat/log не є evidence. Changed inputs/environment інвалідують залежні результати до progress calculation.

## RepairJob and execution

| Field                                 | Invariant                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| jobId/taskId/runId                    | Durable job, budget belongs to task                                                                             |
| fingerprint                           | Exact diagnostic/input identity                                                                                 |
| causeKey                              | Normalized gate/tool/path/error category; no volatile SHA/timestamp                                             |
| diagnosticRef/digest                  | Redacted max 16 KiB / 100 lines                                                                                 |
| allowedPaths/actions/forbiddenEffects | Job-scoped immutable policy                                                                                     |
| state                                 | queued/delivery_pending/received/claimed/agent_running/result_ready/revalidating/resolved/needs_owner/cancelled |
| executionId/claimGeneration           | Atomic claim + fencing; one editor                                                                              |
| ownerIdentity                         | PID/startMarker/bootId/provider session                                                                         |
| providerVersion/threadId/turnId       | Explicit IDs, never latest-session guessing                                                                     |
| deliveryAttempts/nextDeliveryAt       | Transport counter ≠ model attempt counter                                                                       |
| repairOrdinal/causeOrdinal            | Started model turns charge 3/6 budgets                                                                          |
| resultRef/revalidationRequired        | repaired claim never means gate passed                                                                          |

Receipt не означає active turn. Acknowledged/claimed jobs мають result collection schedule. Lost response→query/adopt before retry. Late result після cancel fence записується для audit без apply/resume.

## RepairResult

schemaVersion/taskId/jobId/executionId/inputDigest/generation; outcome repaired/cannot_repair/needs_owner; repairKind runner/environment/product_source/none; patchRef/digest/changedPaths; proposedSourceSha nullable; notes≤4000 chars; closed gate suggestions; usageRef/completedAt.

Controller verifies diff/paths/SHA, не довіряє model identity. Legacy mapping: repaired→repaired; refused/cannotRepair→cannot_repair; needs_owner/needsExternalDecision→needs_owner. Unknown rejected, raw legacy audit preserved.

## Observation and PanelSnapshot

taskId/runId/candidateOrdinal/revision/journalSequence/serverEpoch; presentationState/canonicalState; reasonCode/nextAction/nextCheckAt; progress counts/weights/percent/confidence/regressionReason; currentStep labelKey/start/activeTime/nativePercent nullable; executor generation/lastHeartbeat/alive/activity; observation connected/stale/unavailable; safe repair summary/ordinal; correlated remote ID/URL/state; metrics and token known/partial/unknown.

Worker heartbeat independent від server/agent lease. Server може жити, коли worker dead. Ephemeral signals мають timestamps; durable work receipts у canonical journal.

## UsageLedger

Raw snapshots keyed execution/thread/turn/usageRevision. Cumulative totals dedupe; latest thread totals мінус verified baseline, не сума всіх notifications. Provider total не додається ще раз до input/cached/reasoning breakdown. Regressed/invalid values→accounting fault. Missing failed-turn usage=partial/unknown.

Categories: preparation/repair/owner_response/final_summary; monitoring enforced 0 invocations. Caps 80k/attempt, 300k/task; active time 20/90 min. In-flight overshoot recorded, next turn denied. Failed/interrupted started turn counts; no-model transport retries don't.

## Storage/ownership

```text
release/automation/
├── controller/owner.json + ephemeral health/session capability
├── targets/<target-hash>/owner.json
├── tasks/<taskId>/task.json + task-journal.ndjson + final-report.json
├── <runId>/journal.ndjson + snapshot.json + journal-state.json
├── <runId>/handoff/<fingerprint>.json
├── bridge/<job-hash>.json
├── repairs/<executionId>/claim.json + result.json + usage.json
└── panel/<build-id>/... static assets
```

One writer/journal; atomic create/rename/fsync for durable mutation, generation fence. Directory 0700/files 0600. PID-only not ownership proof; boot/start probes before adoption. Symlink traversal rejected. Torn tail quarantine follows existing rule; interior corruption fail-closed. Sessions and journal records never served as arbitrary files.

## Retention

Durable journals/results/redacted diagnostics/usage/capability evidence≥30 days. Active task and required recovery inputs never automatically cleaned. Bounded ephemeral buffers; model reasoning not panel telemetry. Cleanup тільки owned validated paths із audit receipt.
