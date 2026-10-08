# Contract: Repair provider and independent validation

**Version**: 1 | **Status**: Proposed, implementation feasibility gate required

## Provider registration

Explicit install registers absolute Codex executable/version/schema digest, managed-auth requirement, permissions profile/policy digest and validated capability receipt. Intent/model may name target, never executable/argv. Provider uses stdio local child, not desktop shared socket.

Health methods initialize/initialized/account-read/protocol introspection do not start model turns. Require ChatGPT managed auth; API-key/provider fallback rejected. Model/effort inherit the owner's available configured choice unless owner config explicitly sets another; no silent upgrade or parallel model agents.

Generated installed schema is authority for actual request shapes. Docs-only experimental field is not assumed supported. No copying auth.json or displaying tokens. Capability smoke must prove restricted READ/WRITE/network tools, live usage, interruption and closed-chat completion; missing capability→not ready.

## Controller/provider interface

```text
health() -> ready | unavailable(code)
claim(jobId, executionId, claimGeneration) -> owned | existing | conflict
startRepair(validatedJob, policy) -> accepted(threadId, turnId) | denied(code)
observe(executionId) -> state/activity/usage
queryResult(executionId) -> pending | validatedResultClaim | unavailable
interrupt(executionId, reason) -> stopping | stopped | unknown
acknowledgeResult(executionId, resultDigest) -> recorded
```

Exactly one atomic execution claim/job. Mark intent-to-start durably before sending turn request; persist acknowledged thread/turn immediately. If request acceptance is lost, recover/query identifiable thread/turn before any second turn. Якщо відповідність не можна довести — AGENT_EXECUTION_AMBIGUOUS і blocked repair, не дубльований agent. Provider receipt ≠ active turn; actual start notification establishes running.

## Input/output

Input bounded redacted diagnostic≤16 KiB/100 lines, IDs/inputDigest/generation, allowed paths/actions, forbidden production effects, attempts/budgets, opaque evidence refs. No entire release history, raw secrets або unchanged polling responses. Additional reads адресні й policy-scoped.

Structured result за [data-model](../data-model.md): outcome repaired/cannot_repair/needs_owner, repairKind, patch ref/digest/changed paths, bounded notes, gate suggestions. JSON outputSchema constraints недостатні самі: parser additionally validates IDs, enums, refs, digest і scope.

Legacy bridge protocol v1 remains receipt/query/acknowledge; mapping refused→cannot_repair, needs_owner→needs_owner; accepts old handoff cannotRepair/needsExternalDecision only in migration adapter. New execution state stored separately. Acknowledged jobs result query має свій schedule, не тільки delivery_pending loop.

## Approval/tool boundary

Agent editing limited to repaired checkout; tools deny secret/auth/original checkout/runtime READ, except curated source/dependency roots. Allow only validated local actions under immutable job policy; no blanket acceptForSession, no dangerous bypass flags. Network permission is default denied; access expansion only closed registered purposes, never arbitrary destinations.

Heavy test/build approval routes to a fixed job-scoped gate broker which takes canonical admission and executes registered argv. A request not representable as a registered local action is declined; agent may submit patch for independent validation instead. Dynamic tools are not required. Production effects cannot be approved for the repair thread.

Canary tests must demonstrate actual restrictions, including model-tool file read pathways, subprocess/patch tools, symlinks, auth storage and network. Prompt instructions alone fail acceptance.

## Result application

1. Check task still active, cancellation/generation/input fences match.
2. Verify patch ownership/digest/path scope and absence of secret/log pollution.
3. Classify shipping-source/environment/runner-only changes; model label alone insufficient.
4. Compute invalidated evidence dependency closure.
5. Run affected canonical gates through shared admission.
6. Runner/environment repair resumes only if shipping inputs unchanged/proven and runbook permits.
7. Shipping-source repair before publication creates new accepted run ID/SHA under same task; redo exact-SHA gates.
8. After publication new product bytes require explicitly authorized new-version successor, else one owner blocker. Never retag/replace assets.

Only canonical final acceptance completes task. Repaired result acknowledgement merely confirms receipt; cannot grant gate success.

## Budgets and failures

3 started turns/normalized cause, 6/task. 80k total tokens/attempt, 300k/task; active turn time 20/90 min. Counter survives new SHA/raw error variants. Network delivery retries before start do not charge repair attempt; failed/interrupted started turns do. Unknown turn acceptance retains reservation pending reconciliation.

Live cumulative usage dedupe, input/cached/reasoning reported separately, no double counting. Cap interrupt on observed threshold; record in-flight overshoot; next turn denied. Unknown usage fail accounting/capability, not 0. No background model turn for scheduled checks.

Delivery backoff starts 30 с doubles to 5 хв; result schedule similarly bounded with jitter; respects quota reset signal when available. Max delivery outage window 30 хв then AGENT_UNAVAILABLE owner blocker, no repeated identical owner messages. Reset can automatically restore availability only for unchanged non-owner-decision failure.

Policy/capability/quota/MFA failures preserve job/artifacts and create one concrete blocker. Late completion after cancel is archived, never applied. Provider exit requires ownership check before retry/adopt.
