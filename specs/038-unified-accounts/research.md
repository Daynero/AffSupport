# Research: Єдина таблиця «Аккаунтів»

**Date**: 2026-10-17. Code baseline: `4c392f63` plus current workspace. This is source inspection, not production observation. User requirements: [spec.md](spec.md). No unresolved design clarification blocks the plan; personal decoration remains the documented default.

## R1 — Preserve the finance contract

**Decision:** Keep USD, nullable decimal strings, BigInt calculations, field CAS, request replay and existing export formats. Separate `editRange` (yesterday through today) from `reportRange` (selected period). Morning fields reuse the same writes as other finance fields.

**Evidence:** `packages/shared/src/team/agent-finance.ts`, `agent-finance-report.ts`, `apps/web/src/api/team-finance.ts`, `finance/FinanceWorkspace.tsx`. `buildFinanceReport` totals the entire supplied snapshot: a two-day fetch cannot be passed directly into today's totals. No carry-forward producer was found; do not add one. Null-cleared values remain distinct from explicit `0.00`.

**Alternative rejected:** A second finance ledger or local arithmetic in table rows; both allow divergence from export.

## R2 — Timezone and transfer are existing product rules

**Decision:** Preserve `useFinancePeriod`'s selected/browser timezone. Every read/write includes the validated timezone; server archive timestamps are projected to calendar days in that same view context. Do not invent a workspace timezone setting. Two clients with different zones may see different boundary-day membership; equal date/zone must give equal results. Persist draft date/zone until resolved, including midnight/DST changes.

**Evidence:** `finance/useFinancePeriod.ts`, `private.finance_today` in foundation migration. Latest `supabase/migrations/20261125110000_team_agent_transfer_rehome.sql` moves all historic finance ownership to the destination social. Preserve this rule; old placement-segment ownership is not the current product contract. Launch source snapshots stay historical and are not rewritten to imitate finance grouping.

**Alternative rejected:** Change timezone or transfer semantics as part of a UI merge. This would silently change the user's bookkeeping.

## R3 — Archive lifecycle is independent of finance placement

**Decision:** Store own archived state/version on both levels and immutable lifecycle events. Effective activity is own-active AND parent-active. Parent archive does not rewrite each child's own state. Never close/delete finance placements because of archive. Preserve timestamped parent-membership history for lifecycle evaluation across moves without reversing financial rehome.

**Evidence:** `20261009100000_team_agent_finance_backdating.sql` deliberately permits finance before creation using a year-0001 placement; that date cannot be an activity start. Current finance delete guards reject deletion of finance-bearing entities; archive must not invoke deletion. Historical values exist independently of current active selection.

**Decision:** A reusable temporal predicate includes explicit non-null values even before creation, and otherwise includes actual active days, excluding an archive day unless it has explicit values. Repeated archive/restore uses intervals; same-day restore makes the entity active again. A later archive that day again requires explicit values. Boundary rules are in data-model.md.

**Alternative rejected:** One `archived_at` flag on socials or filtering `list_team_accounts` everywhere. Neither can reconstruct past activity or keep historical financial rows.

## R4 — Drafts and archive-after-save

**Decision:** Lift drafts above rows to `useFinanceDrafts.ts`, key by team/agent/date/metric, pin placement/version/timezone/request ID. UI mounts cannot own unsaved money. Save-and-archive first settles the exact draft set; failed/unknown fields block archive, confirmed fields remain saved. Final archive CAS verifies lifecycle, membership and finance revision to catch concurrent new data; only lifecycle change is atomic, not all prior independent saves.

**Evidence:** `FinanceWorkspace.tsx` currently keys registered saves by agent/metric; `DailyFinanceFields.tsx` owns local draft state. Reusing this unchanged makes yesterday/today spend collide and collapse lose typing. Existing set/clear/undo functions already provide CAS/replay and must remain the write seam.

**Alternative rejected:** Optimistically hide a row and asynchronously save its values; it loses recoverability.

## R5 — Ordering must replace every display re-sort

**Decision:** Integer ranks with scope versions and canonical full membership, including archived items. Reorder takes moved ID plus before/after anchor, not a filtered replacement list. Server locks scope, validates same parent and version, removes/inserts once, rewrites ranks atomically. New items append; cross-social move remains separate, locks source/destination, appends in destination and preserves rehome behavior.

**Evidence:** `packages/shared/src/team/accounts.ts` sorts socials by natural name and agents free-first; both `useAccounts.ts` and `AccountSpace.tsx` repeat sorting; `filterTeamAccounts` sorts too. Finance report has another natural sort. One-time migration matches current full unfiltered order with deterministic ID tie-break, including free-first for РК. Later busy/free changes cannot affect rank.

**Alternative rejected:** Local array order, fractional rank without conflict control, or submitting only visible filtered IDs.

## R6 — Interaction engine

**Decision:** Use the current `@dnd-kit/react` + `@dnd-kit/dom` family for sortable lists, isolated in `AccountReorderProvider.tsx`; pin both to 0.5.1 and commit lockfile during setup (npm registry checked 2026-10-17; React 19 peer supported). Use one delay constraint (500 ms / 5 px) for all pointing types, library overlay, explicit same-scope eligibility and separate keyboard command. No home-grown drag engine. A small prototype acceptance gate proves real touch scrolling, name-button long press and social-collapse geometry before table integration.

Official references inspected 2026-10-17: [sensors](https://dndkit.com/react/guides/sensors/), [sortable state](https://dndkit.com/react/guides/sortable-state-management/), [quickstart](https://dndkit.com/react/quickstart/). Sensors support delay, keyboard and prevention of interactive activation; multiple activation constraints are alternatives, so adding a distance constraint would bypass the requested hold. Explicitly allow the name-decoration control for pointer holding while retaining keyboard color activation; exclude all other interactive descendants. Prototype must reject globally disabling touch scroll.

**Alternatives:** Legacy dnd-kit docs from handoff are behavioral references only. Existing React Aria DnD provides accessible reorder but a custom whole-row hold/collapse interaction would require more adaptation; use React Aria controls/focus with the dedicated sortable engine. No dependency is installed by this planning task.

## R7 — One owner for subscriptions

**Decision:** Extend `useTeamRealtime.ts` with a content-free accounts workspace invalidation signal. Consolidate existing accounts/finance/labels invalidation into that owner; remove the `useAccounts` private channel and browser-event bridge once all consumers use revisions. Preferences get user-scoped invalidation on the same owner, never team-broadcast values. Reconnect/foreground rereads and events during reads schedule one bounded follow-up; stale reads cannot overwrite writes or drafts.

**Evidence:** `useAccounts.ts` currently owns a separate channel and emits `soty:accounts-finance`; `useAgentFinance.ts` listens. `useTeamRealtime.ts` owns operations/catalog/launch subscriptions. Extending the divergent channel would violate the constitution's single-owner requirement.

## R8 — Stable launch joins and active selection

**Decision:** Join manual runs and 035 launches by internal `agentRowId` only, distinguish the two in UI; no name/suffix inference. Current config/source snapshot already has stable IDs. Fetch all needed pages of related summaries or report explicit partial coverage, never a complete-looking first page. Do not expose generation secrets/provider payloads in overview.

**Evidence:** `packages/shared/src/team/launches.ts`, `apps/web/src/api/launches.ts`, `TaskAccountPicker.tsx`, `TaskAccountFilter.tsx`. Active picker reads and historical displays must be different projections. Mutation guards protect stale clients; accepted launch execution continues on its frozen snapshot after archive.

## R9 — Diagnostics is new work

**Decision:** Add bounded typed account-operation lifecycle events and code mappings through the existing producer, ingestion guard, sanitizers and read-only CLI. Do not call current coverage complete. Preserve unknown/missing proof as explicit findings.

**Evidence:** `scripts/analytics/coverage-registry.ts` marks `team.accounts_finance` unsupported by producer. Needed paths: `packages/shared/src/team/analytics.ts`, `apps/web/src/analytics/service.ts`, server ingest guard migrations, `scripts/analytics/{sanitize,queries,investigate,coverage-registry,code-map}.ts`.

**Alternative rejected:** Button-click-only telemetry or direct querying of financial amounts by analytics.

## R10 — Personal decoration and retained behavior

**Decision:** Persist user/team/agent preference, eight-value enum, version and replay. Viewer can change only their decoration while still a member. Serialize rapid clicks locally and save latest intended value with CAS; another session conflict rereads canonical value before explicit retry. No preference leaks to other members. Existing ID-copy icon stays separate.

**Evidence:** Current row already has a dedicated copy icon; `handoff.md` records the full inventory including 2FA, labels, markers, finance clear/undo/history/legacy import. Reuse their controls and actions. Decoration uses a data palette in tokens, not status roles.

## Implementation reconciliation — 2026-10-18

The planned migration responsibilities are consolidated into fresh migrations `20261202138000`, `20261202141000` and `20261202142000`. No applied baseline migration was rewritten. Latest mutation wrappers share scope/request/parent/agent locking, active-selection guards and finance revision triggers; old finance reads remain callable and v2 adds lifecycle provenance. Upgrade tests compare populated pre-038 counts, values and placement ownership.

The unified client seam is `apps/web/src/api/team-accounts-workspace.ts`, separate from the large legacy team API. Overview uses stable-ID launch summaries and explicit partial coverage; 2FA seeds continue through their existing dedicated authorized RPC. `list_team_accounts` remains the active picker projection, while the overview/finance-v2 readers retain historical references.

`@dnd-kit/react` and `@dnd-kit/dom` 0.5.1 are installed and locked. Accessibility belongs to a separate grip; `activatorElements` deliberately keeps whole-card pointer holding. This avoids inherited `aria-disabled` disabling archived history and copy controls. Runtime reviews confirmed the eight-state decoration cycle and localized keyboard ordering; browser-scale timing is a separate measured acceptance requirement.

Realtime has one subscription owner in `useTeamRealtime`. `TeamContext` coalesces workspace signals into revisions. The existing `soty:accounts-finance` compatibility notification remains dispatched by this owner so legacy finance consumers still refresh; the old independent Accounts channel was removed. This is an intentional compatibility adapter, not a second subscription or polling mechanism.

Actual consolidated regression paths are listed in quickstart.md. Test filenames may cover several planned task scenarios; no missing named test file is treated as evidence of a pass. Reviewer findings and exact scores live under `reviews/`.
