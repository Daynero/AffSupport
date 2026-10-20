# Implementation Plan: Єдина таблиця «Аккаунтів»

**Feature**: `038-unified-accounts` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)  
**Branch**: unchanged; feature identifier does not claim a new git branch. Active `.specify/feature.json` stays on 037.

## Summary

Replace the two Accounts tabs with the existing РК/run hierarchy plus finance cells. Lift dated drafts out of rows; retain existing USD ledger, CAS/replay, export and rehome semantics. Add shared persisted order, independent social/РК archive lifecycle, user-private decoration, library-based delayed reorder and agent-readable diagnostics. The daily workflow edits yesterday's spend beside today's values while today's reports stay strictly single-day.

## Technical Context

**Language/Version**: strict TypeScript 5.9, React 19, PostgreSQL migrations, Node 22.12–24 per package engines.  
**Primary Dependencies**: existing HeroUI 3/React Aria, token/Tailwind layer, Supabase; add `@dnd-kit/react@0.5.1` and `@dnd-kit/dom@0.5.1` (registry checked 2026-10-17; React 19 peer supported), not legacy core.  
**Storage**: existing accounts/agents/runs/finance placements/values/events; new lifecycle, membership-history, order scope, content-revision counters, private decoration and mutation receipts. No new financial ledger.  
**Testing**: single-worker Vitest, local Supabase SQL tests, real-browser layout/drag checks through existing Playwright tooling, analytics ingestion-to-CLI fixtures.  
**Target Platform**: supported web desktop/touch browsers; no local agent process/platform changes.  
**Performance Goals**: spec SC-004: 50 socials/500 РК/up to 5 runs, steady-state p95 frame ≤20 ms, no frame >50 ms; ≤50 ms feedback after hold threshold.  
**Constraints**: six stories, 24 FR, 8 AD, 10 SC; preserve all handoff inventory and finance privacy; no production effects; current timezone/rehome rules preserved.  
**Scale/Scope**: one unified view, two levels of shared order, two own archive states, per-user decoration, one lifted multi-date draft store.

## Constitution Check

Pre-research and post-design: **PASS for the proposed design**, subject to implementation proof; no exceptions requested.

| Principle                  | Design and acceptance gate                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I — Typed boundaries       | New parsers/unions in shared; schemaVersion for extended finance snapshot; opaque IDs and closed error codes; runtime boundary tests                             |
| II — Release identity      | No version/tag/manifest changes in this feature plan; rebuild shared for checks, production only through canonical runbook                                       |
| III — Least privilege      | New tables RLS + revoke-all/narrow grants; security-definer functions with empty search path, membership/role checks, private preferences; SQL adversarial tests |
| IV — Process orchestration | No agent subprocess changes; browser verification uses existing tool seam                                                                                        |
| V — Stable outcomes        | Structured canonical receipts, closed codes, request replay, unknown-response reconciliation; CLI maps each failure                                              |
| VI — UI/state discipline   | Inventory controls/tokens, one shared Realtime owner, no polling, lifted drafts, source generations, full i18n and focus handling                                |
| Analytics requirement      | Typed signal → SQL guard → stored event → read-only diagnosis → capability inventory; missing evidence stays explicit                                            |

## Project Structure

```text
specs/038-unified-accounts/
  spec.md, handoff.md, plan.md, research.md, data-model.md, tasks.md
  contracts/accounts.md, contracts/diagnostics.md
  quickstart.md, analysis.md, checklists/requirements.md
packages/shared/src/team/
  accounts.ts, agent-finance.ts, agent-finance-report.ts
  account-lifecycle.ts, account-order.ts, account-overview.ts   # new
  analytics.ts, transport.ts
apps/web/src/team/accounts/
  AccountSpace.tsx, AccountGroup.tsx, AgentRow.tsx, useAccounts.ts
  AccountReorderProvider.tsx, AccountArchiveDrawer.tsx         # new
  useAccountPreferences.ts                                   # new
  finance/useFinanceDrafts.ts                                # new
  finance/FinanceWorkspace.tsx, DailyFinanceFields.tsx, useAgentFinance.ts
apps/web/src/api/team.ts, team-finance.ts, launches.ts
apps/web/src/team/useTeamRealtime.ts
apps/web/src/team/tasks/TaskAccountPicker.tsx, TaskAccountFilter.tsx
apps/web/src/team/launches/                                  # active source selectors
apps/web/src/styles/tokens.css, team-accounts.css
supabase/migrations/                                        # append-only new files
supabase/functions/team-finance-export/handler.ts
supabase/functions/_shared/finance-workbook.ts
scripts/analytics/, scripts/check-accounts-layout.mjs
scripts/check-accounts-interactions.mjs                      # new browser verification
supabase/tests/database/, tests/
```

**Structure Decision:** Compose in the current AccountSpace rather than adding a parallel account application. Retire the tab branch and extract reusable finance logic; existing detail dialogs remain reachable. New file paths are deliberate additions, not claims that they already exist.

## Delivery phases

1. **Baseline / prototype:** Verify evolving workspace against handoff, enumerate all mutation/reader/ingestion seams and migration head. Prove delayed sortable behavior on real touch and keyboard. Record exact package versions and fixture/runner constraints.
2. **Foundation:** Typed read contracts, dated draft store, new order/lifecycle schema and private receipts, temporal visibility helper and permission tests. Extend existing finance projection additively; keep v1 callers safe until cutover. Centralize invalidation before new subscriptions.
3. **US1 unified table:** Preserve all inventory actions, period controls, runs/launch identity, partial-state handling and shared report/export paths. Existing source controls stay behind adapters until parity is proven, then remove tabs.
4. **US2 РК order → US3 social order:** Server-authoritative rank and anchor mutation, full-membership conflicts, library interaction, temporary folding keyed by ID, draft/focus/scroll restoration. US3 reuses US2 infrastructure.
5. **US5 archive:** Independent child/parent lifecycle, safe save-and-archive orchestration, active selection guards on reads and writes, rare archive drawer, historical corrections and restore. Reports and copy use temporal projection, never active picker projection.
6. **US6 daily entry (owner correction):** Three fields for the selected day only: balance, topup, spend. Prepare and validate a scoped snapshot before committing the day; retain input nodes, the visible row anchor and sufficient scroll canvas even when historical membership is shorter. Keep report/edit range separation, Enter navigation, midnight pinned drafts and clipboard completeness.
7. **US4 decoration:** User-private preference storage and UI, delayed name capture and click suppression, eight-state palette. No tags/filters/status effects.
8. **Integration:** Complete diagnostic lifecycle and consumer compatibility, property/privacy tests, real-browser performance and accessibility, full fast/release verification in isolated beta.

US1 can deliver a useful MVP after foundation. US2/US3 and US5 extend that view; US6 may be developed after US1 but its final acceptance depends on US5. US4 has lower priority. Shared AccountSpace/API/migration/analytics changes are serialized despite independent research/tests.

## Data and interaction boundaries

- Active list vs historical overview vs archive drawer are explicit scopes. All selectors reject inactive IDs server-side as well as hiding them; existing references/accepted launches retain resolution.
- Archive timestamp is server UTC; visibility projects it using the same validated timezone as the finance request. Historical value date is never reinterpreted. Backdated explicit values can predate creation.
- Current rehome transfer remains: all financial history follows destination. Lifecycle parent-membership history remains separately truthful and does not change transfer audit or financial grouping.
- Save-and-archive is staged: settle affected drafts, refresh aggregate revision, submit lifecycle CAS. A concurrent write after refresh causes conflict, never silent omission. Freeze affected local input for final preflight/CAS, pin auth/team/draft generation and release on every exit. Authorized successful receipt replay precedes new-write archive checks. Partial saves are preserved with per-cell status.
- Rank, lifecycle and finance revisions are distinct. Financial edits do not invalidate an unrelated reorder; membership/archive/delete invalidates relevant drag scope. Historical rows are not draggable; full rank set retains hidden/archive slots.
- New content-free `team_account_workspace_signals` integrates with `useTeamRealtime`; remove old account channel/event bridge. User preference changes use RLS user-scoped invalidation, not team-wide preference content.
- Shared calculations produce totals from reportRange; each daily table contains only its selected day. The owner correction supersedes the original horizontal-scroll layout: compact three-column finance fits the 1384 × 666 desktop, with no dates in column headings or repeated input labels. History and Archive live in More menus. Native dnd-kit feedback moves the full source row at its original dimensions and grab point.

## Migration and deployment compatibility

Append migrations after the actual repository head at implementation time; the suffixes in tasks are names, not reserved timestamps. Existing rows initialize ranks once and lifecycle baseline from known creation state. Preserve legacy finance deletion guards and old history; do not invent past archive events. Old clients must not bypass lifecycle by writing through old RPC signatures: guard existing entry points, with default normal-write intent; historical correction is explicit. Existing v1 finance consumers keep working until all first-party consumers move to the extended projection; do not silently relax parser validation. Release requires database gates and backward-compatibility checks, not deploying a migration from this planning turn.

## Validation / complexity tracking

See [quickstart.md](quickstart.md) and [contracts](contracts/accounts.md). No constitutional waiver. The complexity is necessary for data preservation across date boundaries and concurrent users; rank/lifecycle metadata is separate from existing money data to keep failure scope bounded. Any measured performance failure must be fixed before acceptance; virtualization is not a presumed dependency and must preserve drafts/keyboard/drag geometry if later needed.

## Final compact interaction integration

The library sortable and feedback source share the complete sibling element. For a social group, prepare only the picked group before source measurement; keyboard preparation occurs in the activation guard before the library scrolls/centers it, while pointer preparation waits for the500ms hold. Peers temporarily fold after capture. Default Feedback moves its own placeholder and keeps the complete source independent of transformed siblings. Actual browser review caught and corrected both nested-header ownership corruption and transformed-parent offsets; see the compact interaction reports. No custom collision/drag physics replaces the library.

The captured social viewport follows the same-ID in-flow Feedback placeholder, not the fixed source. During capture the minimum list canvas retains only the physical viewport height, so the actual collapsed groups bound scrolling and auto-scroll cannot enter a large empty tail. Restore the frozen expanded canvas before unfolding and applying the final anchor. These integration points were verified at the middle and end of the50-social/500-RK stress fixture, including actual wheel scrolling and Escape restoration.
