# Buyer review — round 2

Date: 2026-10-18. Independent buyer review, local beta workspace, dedicated Chrome tab 766198370. **Score: 88/100. Not accepted (>96 required).**

## Required fixes

1. **P1 — archived historical row is inaccessible to proper semantic interaction.** Archive `BUYER038-801` after saved today balance 101, topup 50, spend 5 and yesterday spend 11. Row correctly remains, but history and copy ID buttons are exposed as disabled. `isEnabled()` for `Історія · BUYER038 · 88003801` returns false; direct `disabled` attribute is null; ancestor `LI.team-agent-row.is-free` has `aria-disabled="true"`. Semantic click times out. Yesterday view repeats disabled history and fields, obstructing late historical correction without restore. Remove blanket inherited disabled semantics and retain explicit disabling of new business actions.
2. **P2 — active/free counters include archived RK.** After archive settles, today counters remain `Усі 7 / Вільні 7`; BUYER038 header remains `5 РК · 5 вільних`, despite one archived RK. Later designer-created RK increases total to 8, demonstrating these counters read all visible historical rows rather than active objects. Archived rows must remain in financial totals but not claim available capacity or appear under the free filter.

## Passed with real UI evidence

- Previous BUYER038 and RK88003801 persisted from round1. Four additional RK88003802–805 created promptly with success messages; initial finance fields safely disabled during snapshot lag, then enabled.
- Full five-RK morning pass: today balances 101–105; yesterday spend 11–15; today topups 50 and70 for RK801/803; today spend5 for801. No global date switch needed. Enter from first balance focused second balance.
- Shared Save completed. Today totals are spend5/topup120; yesterday view totals spend65, without mixing days.
- Clipboard was actually read: `2026-10-18 · USD`, BUYER038, `88003801 - $50`, `88003803 - $70`.
- Archive801 retained today's row with “В архіві”, preserved totals5/120, and clipboard still included both topups. Yesterday11 retained.
- Archive is behind secondary menu, has search and visible archive date. Restore801 succeeded.
- Keyboard reorder805: Space, ArrowUp, Enter moved it before804. “Порядок збережено” appeared. Refresh retained order801,802,803,805,804 and all20 finance field values (including distinct empty cells).
- Refresh after stable source worked; prior blank crash was reproduced with captured `useAuth must be used inside AuthProvider` during parent `build:shared` HMR. Parent stopped that verification process. This round does not count externally triggered HMR as a persistent finance data defect.

## Remaining evidence limits

Long-press pointer smoothness/performance, next-day archive boundary, explicit-zero vs no-data archive, two-client conflict/lost response, cascade restore independence and Excel content are not directly certified by this review. Round3 should focus on fixed archived accessibility/counts, no-data archive and group restore. Financial correctness and basic ordering have now been exercised instead of inferred from source.

No application source changed by reviewer. Final local test state: BUYER038 five RK, RK801 restored, manual order801/802/803/805/804, test amounts retained.
