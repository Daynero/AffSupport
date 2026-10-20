# Accounts contracts

Prospective RPC names are explicit design choices; reuse existing helpers internally. Typed wrappers parse unknown data in shared modules. Existing finance money representation and membership checks stay unchanged.

## Reads

- `list_team_accounts(p_team)` remains the active-assignment projection for old callers: omit own/parent archived rows, return ranks. Existing task/launch history uses IDs/snapshots, not this active-only list.
- New `get_team_accounts_overview(p_team,p_from,p_to,p_timezone)` returns ordered social/RK identities, own/effective state, lifecycle coverage, manual runs, linked launch summaries by stable ID, unmatched records with reason, scope revisions and readable results. No external credentials or launch source payloads. Permission rules for 2FA remain on the existing guarded seam; overview must not broaden exposure.
- Extended `get_team_agent_finance_v2(p_team,p_from,p_to,p_timezone)` returns schemaVersion 2 with existing fields, placement/rehome grouping and temporal metadata needed by the shared visibility predicate. Retain `get_team_agent_finance` v1 for compatibility during cutover. Both expose all authorized finance records, never active-picker-filtered data.
- Account overview and finance may load independently. Each read is internally consistent, tagged with generation/context; a stale period response is ignored. Missing source produces explicit unavailable/partial state, not zero. A mismatched identity remains unmatched pending bounded reread. Financial totals/copy/export require complete financial snapshot and are not blocked merely by failed launch metadata.
- New `list_team_account_archive(p_team,p_cursor,p_limit,p_query)` returns own archived socials and RK plus effectively parent-archived RK, explicit reason/restore eligibility, stable cursor. Cap page size 100; own/parent reason is not a duplicate entity. Scope, dates and filters never silently hide archive search results.
- New `get_team_account_mutation(p_team,p_request_id)` returns authorized receipt or not-found. Not-found after uncertain response is not proof of rollback; repeat same idempotency key/payload under lock if appropriate.

Launch overview must follow all bounded pages needed for the displayed scope; incomplete fetch returns `coverage:partial` and a load-more/retry action. No join by name, tail or mutable external ID. Manual runs and 035 launches remain different objects.

## Shared mutation envelope

All new mutations accept request UUID, expected revision(s), team and stable entity IDs; return `operationId`, request ID, canonical result and new revision. Duplicate key/payload replays once; altered payload returns `REQUEST_REPLAY_MISMATCH`. Server rechecks membership/required role before replay; a confirmed same-payload result replays before new-write archive checks, so a lost response to an already successful pre-archive write remains recoverable. A new key never inherits that exception. Client distinguishes pending, confirmed, failed and unknown transport outcome. Errors extend the existing closed team error union and code map; no unbounded server text is telemetry.

### `reorder_team_accounts`

Input: scope (`socials` or `agents`), parent ID for agents, moved ID, anchor ID, relation before/after, expected scope version, request ID. Both IDs belong to same full scope; no client array replaces hidden members. No-op returns canonical order with no effective write. Conflict returns current scope version/order; show canonical result and offer explicit repeat. A filtered example A,H,B,C with hidden H and C before B becomes A,H,C,B.

Ranks do not imply active status. The server validates active drag eligibility but retains archived membership slots. Cross-parent drag is rejected; the separate existing move RPC appends destination rank and invalidates both scopes.

### Archive preflight and mutation

`get_team_account_archive_preflight`: team/entity kind/ID → lifecycle version, membership revision, finance revision token from transactional `team_account_content_revisions` over affected subtree, counts, current eligibility. Token binds entity plus own/parent lifecycle, finance and membership revisions as defined in data-model.md; writes, clear/undo/import/rehome all bump relevant counters, replay does not. It exposes no hidden user drafts; only the initiating client's lifted store can settle its own drafts. Other users' already-saved data is protected by the server token.

`set_team_account_archived`: team/entity kind/ID, desired own state, expected lifecycle version, expected archive-preflight token (on archive), request ID → canonical own/effective state, server timestamp, revisions, receipt. Apply parent-level archive atomically without setting child-own flags. Restore under inactive parent returns `PARENT_ARCHIVED`; restore already-active own state is an idempotent no-op. Conflict refreshes and requires review; never silently archives after new financial data arrives. Archive can proceed despite old run notes; it is not an external stop command.

UI orchestration: collect all affected dirty records (both dates, hidden/collapsed), ask save-and-archive/discard/cancel. Save all requested records through existing finance seam; any failed/unknown response stops archive. Confirmed saves remain. Then freeze affected local inputs, pin draft-generation plus auth/team context, preflight and CAS. Changed generation/context cancels before submission; late results cannot repopulate a different session. Always release field freeze on failure/cancel; no row is hidden while new local edits can still appear. Archived row with current-day data stays visibly marked; no-data row disappears only after confirmed result. Undo creates version-checked restore. There is no physical delete in this flow.

### Finance correction intent

Extend the existing finance set/clear/bulk/undo entry points with a typed `normal | historical_correction` intent, preserving old signatures or default normal wrappers. Existing date restrictions, field version, expected placement, amount bounds and request replay remain. Normal rejects own/parent archived entity at acceptance. Historical correction requires editor and explicit dated history UI, never implicit reuse of stale open editor. Clear/undo/legacy import must obey the same lifecycle checks and preserve audit; don't guard only the single-field setter.

### `set_team_account_name_color`

Input: team, agent ID, desired enum 0–7, expected version, request UUID. User is derived from auth, never accepted as arbitrary target. Read/write only own preferences while a member; view-only member allowed. Return canonical enum/version. Rapid clicks increment local intent synchronously, serialize writes, ignore stale responses; after conflict show canonical state and allow explicit retry. No optimistic success toast before persistence; a failed write offers retry without changing business fields. Preference lifecycle is independent of archived active state and survives restore.

## UI controller contract

`AccountSpace` owns unified context and draft/reorder providers. Existing `AccountGroup`, `AgentRow`, finance fields/toolbars/drawers reuse adapters, not duplicate logic. New components are registered/composed through existing UI inventory patterns.

Draft key: user/team/agent/date/metric/currency. Display instance/focus identity is separate: a historical projection can show a RK in more than one context without duplicating its draft/write. Each cell has raw value, base field and placement versions, edit timezone, request ID and status. Controller supports `validate`, `saveSubset`, `discardSubset`, `getAffectedDrafts`; returned outcomes are per cell. Copy waits for relevant pending/dirty topups, rereads confirmed values and uses full selected-day report regardless of fold/filter. Offer save/cancel rather than silently copying an incomplete draft list; clipboard refusal keeps existing manual-copy fallback.

Reorder state: idle → holding → dragging → pending-save → confirmed|failed|unknown. Holding movement beyond tolerance cancels. Drag snapshot stores full version, visible IDs, collapsed-by-ID map, focus and viewport anchor. Temporary collapse never overwrites persisted fold preference. Data updates during dragging cancel only when they invalidate current scope membership/eligibility/order. Unrelated finance value update does not. Historical rows are not drag targets. Overlay stays anchored through compacting groups; restore fold on every exit including unmount/error; no stale click changes decoration.

## Stable error categories

Map to existing codes where semantically identical, otherwise extend shared closed lists and tests: order/lifecycle version conflict, scope membership changed, archived entity, parent archived, historical-correction-required, replay mismatch, permission denied, invalid input, missing entity, result unknown, source unavailable. The final exact enum spellings are declared once in shared contracts during foundation, and map to source plus UI locations. Unknown external errors remain explicit unknown rather than guessed codes.
