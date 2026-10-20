# Data model: unified accounts

Design additions below are prospective. Existing money values/events remain authoritative. Names of migration files use a fresh timestamp after the actual implementation baseline.

## Existing and added entities

| Entity | Fields / key | Invariant |
| --- | --- | --- |
| `team_accounts` | existing ID/team/name; add `sort_rank`, own `archived_at`, `lifecycle_version` | Archive is not deletion; social own state never overwrites child state |
| `team_account_agents` | existing stable `id`, mutable external `agent_id`, `account_id`; add rank, own archive/version | Color/lifecycle/order use stable ID; historical finance remains independent |
| `team_account_order_scopes` (new) | team, scope kind, parent key, version | One social scope/team and one RK scope/social; full order includes archived members; contiguous nonnegative ranks after transaction |
| `team_account_content_revisions` (new) | team/entity kind/ID, monotonic finance revision, membership revision | Bumped transactionally by every money/placement/membership mutation; independent of order revision |
| `team_account_lifecycle_events` (new) | event ID, team, entity kind/ID, archived/restored, server timestamp, actor, request ID, version | Append-only, unique entity/version; derive intervals, never overwrite old archive date on restore |
| `team_account_parent_history` (new) | agent ID, social ID, starts_at, ends_at, provenance | Track parent membership for lifecycle only; current finance rehome still owns historic money |
| `team_account_preferences` (new) | team, user, agent ID, `name_color` 0–7, version | Own-user access plus current membership, default 0; private decoration survives rename/move |
| `team_account_mutation_receipts` (new) | team, actor, request UUID, operation ID, operation kind, payload digest, canonical result | Same key/payload replays; different payload rejects; not analytics. Request payloads never contain finance amounts/2FA; finance writes retain their existing ledger |
| `team_account_workspace_signals` (new) | team, monotonic revision, change-kind | One upserted revision row per team (not unbounded event-per-write log), content-free member-only read; one workspace subscription owner |
| Existing finance values/events/requests | agent/date/metric, nullable cents, placement ID, version, request ID | Null means cleared/absent, zero means explicit; amount calculations unchanged |
| Finance snapshot v2 | v1 fields + lifecycle/visibility provenance, ranked identities, coverage and context | Additive separate parser; v1 compatibility retained until consumer cutover |
| `FinanceDraft` (client) | team/user/agent/date/metric/currency, raw text, zone, base value/version/placement, request ID, status/error | Full draft outside row lifecycle; removing a view never removes dirty data |

Lifecycle tables must not expose external account names, money or 2FA in Realtime events. Private preference invalidation uses own-user RLS through the same subscription owner. Cache keys include user/session/team and read scope; clear all sensitive cached state on logout/membership loss. Never reuse another user's decoration from a team-only cache.

## Temporal semantics

Inputs: server timestamps, validated request timezone, inclusive report dates, own lifecycle intervals and actual parent membership intervals. Keep `created_at` separate from `placement.starts_on`: existing backdating deliberately starts placements before creation. An explicit non-null finance value is visible on its stored date even before creation.

For each calendar date D:

1. Explicit non-null balance/topup/spend for D makes a historical financial row visible regardless of archive state (including zero). A null-cleared field/audit event does not.
2. Otherwise show presence when the entity was active on D under own and then-parent lifecycle. A transition to effectively archived on D suppresses empty presence for that day unless a later effective restore on D leaves it active. Current-active newly created/restored entities appear immediately; future creation never populates older empty days.
3. Parent archive is an effective transition for its children, without creating child-owned archive events. Multiple events within a day use timestamp order and the last effective state that day. Past active days remain present; archived gaps remain absent.
4. A parent membership change may alter effective activity; record it separately while grouping historical financial rows according to the existing finance rehome contract. Do not infer lifecycle membership from rewritten finance placements.
5. Range/month membership is the union of visible dates, with finance totals from values in range only. No balance summation across days; preserve existing balance display. Empty archived groups are hidden; a group with historical rows is rendered once.
6. `reportRange` and `editRange` differ for morning UI. Auxiliary yesterday fields do not affect today's membership or totals. An archived object with only yesterday data disappears from today's ordinary rows but remains reachable via history.

No new carry-forward logic is introduced. If a future producer adds derived values, provenance must exclude them from explicit-data retention.

### Baseline / migration

Seed ranks once using existing unfiltered name order for socials and free-first/natural-agent order within social, with stable-ID ties. Seed lifecycle as active from actual creation for surviving existing objects; no claim of historical archive before feature availability. Seed parent-history from available authoritative transfer evidence; if earlier membership cannot be proven, mark that interval `baseline_unknown` and do not invent archive transitions in it. Existing finance projection remains authoritative and explicit values are never hidden by uncertain lifecycle. Unknown empty historical presence is surfaced as incomplete coverage, not a fabricated active row.

New creates append under the same scope lock used by reorder. Archive/restore leaves ranks unchanged but bumps eligibility/scope version to invalidate an ongoing drag. Financial writes alone do not bump ordering version. Permanent deletion remains a separate existing command subject to existing finance/history guards; it cannot be a shortcut around archive or delete lifecycle needed by retained references.

## Archive-preflight revision source

`team_account_content_revisions` keeps per-RK and per-social finance/membership counters. Every successful set, clear, undo, legacy import and historical correction increments the affected RK and its current social finance revision in the same transaction; multi-field writes increment once per affected scope. Rehome increments RK plus both source/destination social finance/membership revisions. Add/delete/move child updates membership revisions. Archive preflight token binds entity identity, own/parent lifecycle version, membership revision and finance revision. It is compared under the same locks at archive commit; changing data then reverting values still increments revision and conflicts. No hashing of amounts or client-supplied count proves freshness. Unrelated money writes elsewhere do not conflict.

After current authorization checks, an existing successful same-key/same-payload receipt is replayed before checking whether a new write is now allowed by archive state; this resolves a lost pre-archive response without creating new work. It does not bump revisions again. Old RPC overloads must enter guarded internal implementations, not bypass these counters. Schema tests enumerate every mutation from the baseline inventory and prove its counter/invalidation effect.

## Transactions and races

Use one lock order across participating RPCs: team/social order scopes and parent socials by stable ID, then agents by stable ID, then finance/placement rows. All archive, restore, create child, move, new run, task assignment and launch acceptance functions must obey this protocol. Account parent changes cannot occur between lifecycle validation and write.

- **Reorder:** expected scope revision + moved ID + anchor + relation; validate membership and permission; atomic insert/rank rewrite + revision + receipt. Hidden members retain relative order. Only active items are direct draggable targets; archived/historical slots remain in the full sequence.
- **Archive social:** lock parent and current membership; verify expected lifecycle/membership/finance-revision token; set parent state once + event + receipt + signal. No partial child loop and no child flags rewritten.
- **Archive RK:** lock parent + agent; verify own version and finance token; update only own lifecycle. Idempotent no-op returns current state.
- **Restore:** new event/version, same IDs/ranks. Restore child under archived parent returns `PARENT_ARCHIVED`; UI offers explicit parent restoration separately. Undo archive is version-checked restore, never deletion of history.
- **Finance write race:** normal intent requires effective active at write acceptance; already accepted financial transaction commits coherently before archive lock. After archive, explicit `historical_correction` intent with editor permission may write; old RPC signatures default to normal and cannot bypass the guard. CAS/version/placement/replay still apply.
- **Archive after drafts:** independently confirmed saves may survive even if later save fails. Then archive is not submitted. After all settle, freeze affected local fields and capture draft-generation/identity token; obtain fresh archive-preflight token; final CAS rejects concurrent money/membership change so user can review and repeat. Release field freeze on every terminal/cancel/error path; a changed auth/team/draft generation invalidates orchestration before sending archive. A response after unmount is reconciled in the original context and must not populate a new user/team cache.
- **Accepted launch:** archive does not modify its snapshot or recovery reads. New acceptance (including stale draft/duplicate action with a new key) rejects inactive source. Same successful acceptance key replays its original result.

## Draft state and lifetime

`clean → dirty → pending → confirmed|failed|unknown`. Unknown resolves by receipt/postcondition before retry; new edit after a pending write retains separate intended text. Save callbacks are controller-owned, not references to mounted fields. Social folding, filters, sorting and archived historical rendering cannot unmount the draft owner. Scope switch/logout explicitly resolves or discards drafts and clears memory, not background-saves against another user/team.

Persist dates/zone at edit start. Midnight refresh updates “today” label but cannot relabel dirty fields; keep the old dated context until save/discard. Enter advances within visible rows of the current social after validation; at last row it remains there, never jumps into another social. Labels/financial controls do not trigger drag.

## Permissions

| Action | Viewer member | Editor member | Nonmember |
| --- | --- | --- | --- |
| Active/history/archive read | Existing read permissions, including financial visibility | Yes | Denied |
| Order/archive/restore/finance/run writes | Denied | Yes, existing role checks and CAS | Denied |
| Own decoration | Yes | Yes | Denied |
| Other user's decoration | Denied | Denied, including owner role unless same user | Denied |

Every new table: RLS enabled, revoke default grants, narrow allowed columns; mutation functions use explicit checks, empty search path, fully qualified names. Replay checks cannot return results after membership revocation. Read-only analytics never queries private preference or money tables for this feature.
