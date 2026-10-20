# Independent interaction review — round 6, middle-social scale case

**Resolved by round 7** on application hash `36010b798cea217f50dfb94782395c34cf04aa8245d5f8519faa2561ea77048c`; the actual middle-social retest restores the interaction score to 9.9/10.

App hash `2d721f61ae2f5089a8db19ca5bb0c2d453829da3a5b3730a9c4fafe39786693a`. Chrome 1384 × 666, actual local beta stress team (50 expanded socials, 500 RK). No runtime/test changes or stored ranks/financial mutations by reviewer.

**Revised score: 9.3/10.** This additional actual scale check exposes a previously untested defect and supersedes round 5's 9.9 acceptance for this source hash.

## Confirmed defect: no neighboring social targets after a deep-scroll capture

The reviewer used the actual g25 social menu to bring that social into view and closed the menu. Before capture:

- Inner table scrollTop **34867**, scrollHeight **71932**, outer pageY **234**.
- g25 header y **416.125**, x **62.5234375**, width **1258.953125**, height **53.1953125**.
- All **50** socials expanded.

Native pointer hold at `(700,440)`, measured approximately 750 ms into a 3500 ms hold, activates the actual drag. The captured source is correct and intact: x **62.5234375**, y **415.125**, width **1258.953125**, height **54.1953125**. All RK bodies fold (mounted RK count becomes zero).

However, the table retains **scrollTop=34867** and the list retains **min-height:71900.7px** while all compact social headers now occupy only the beginning of that canvas. The only header intersecting the visible table is g25's captured source/placeholder. **Zero other social headings are visible nearby**, leaving an empty canvas where the user needs targets for choosing a new position.

[Actual held screenshot](../../../scratchpad/038/compact-middle-social-hold.png) and [before/during/after DOM measurements](../../../scratchpad/038/compact-middle-social-proof.json).

## Release and data integrity

After release without movement, active drag count is **0**, all **50** expanded states return, all **50** social sections again contain exactly one header, and g25 returns to y **416.125** with tableTop **34867**, pageY **234**. No stored rank changes were requested. Thus restoration is correct; the defect is specifically the missing nearby drop targets during a deep-scroll social capture.

The earlier ordinary RK pointer translation and keyboard ownership fixes remain verified. A fix must position the collapsed flow around the captured social during dragging while preserving this exact release/cancel restoration.
