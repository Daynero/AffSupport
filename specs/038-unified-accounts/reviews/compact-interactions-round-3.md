# Independent interaction review — round 3

Stable app freeze `9c111aab…`, Chrome 1384 × 666, real beta, synthetic stress team. Root explicitly held all runtime/CSS edits for this clean reproduction. One reload repaired the former malformed DOM before testing. No runtime/test edits or stored data mutations by reviewer.

**Score: 8.0/10. Social section ownership is repaired, but the captured social header is displaced during movement.**

Using the first social's real keyboard activator, press Space then ArrowDown. The neighboring section now moves as a semantic unit. However, the active full header disappears below the visible table instead of following its intended position:

- Library variables: `--dnd-left: 62.5234375px; --dnd-top: 307px; --dnd-translate: 0px 65.6953125px 0`.
- Actual captured header rectangle: **x=125.046875, y=615, width=1258.953125, height=53.1953125**.
- The expected x is 62.5234375, with y approximately 372.6953125 for this requested step. The parent offset appears to be added again. This places the source below the table's clipping edge; the screenshot shows an empty insertion gap.

The actual source retains its original text and exact dimensions, but its position is wrong. [Screenshot](../../../scratchpad/038/compact-interactions-split-source-displaced.png).

Escape now announces cancellation and restores one heading per section (`1, 1, 1`), the original section order and table scrollTop=0. The outer page is at 205.5 after Playwright focuses the keyboard handle into view, before capture; that is distinct from the old table scrollTop=2063.5 corruption. The old zero/two-header ownership issue is no longer reproduced in this clean run.

The earlier attempt during CSS HMR was inconclusive and is not the basis of this finding. This is a stable-source actual native keyboard reproduction. Actual continuous pointer tracking remains unverified because raw CDP input is denied by the bridge and immediate native drag does not satisfy the 500 ms activation delay.
