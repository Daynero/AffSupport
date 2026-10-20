# Independent interaction review — round 9, bounded social drag canvas

Final application hash **`7b457a1575537ecae15dd0d59e2c4eeb529660e54cb26c6aa2af04b95b91f927`**. Actual local beta, Chrome 1384 × 666, synthetic 50-social/500-RK team. Full runtime freeze during the review; this reviewer made no runtime/test changes or stored rank/financial mutations.

**Score: 9.9/10.** Both additional scale defects are fixed: middle capture exposes neighboring targets, and scrolling cannot enter the old empty expanded canvas while socials are folded.

## Native pointer capture preserves the middle-social position

Start: tableTop **34867**, pageY **234**, g25 header **y=416.125**. Actual native hold at `(700,440)`, measured approximately 750 ms into a 3000 ms hold:

- Captured original full social source **x=62.5234375, y=415.125, width=1258.953125, height=54.1953125**.
- Grab origin remains **50.63544859940675% 45.898803517370624%**, matching the original pointer point.
- All RK bodies fold (rows=0), and neighboring g23/g24/g26/g27 remain visible around the source.
- The active list minimum height is now **333 px**, table scrollHeight **3328**, clientHeight **333**, tableTop **1451**. The 71900 px expanded minimum height no longer defines the active drag's scroll range.

## Actual native wheel reaches final targets without a blank tail

After a separate real keyboard activation, native CDP wheel `deltaY=5000` at `(950,500)` is applied exactly as in the failing round 8 reproduction. The active table clamps to **scrollTop=2994**, scrollHeight **3328**, clientHeight **333**. Capture remains active and the visible peer targets are **g46, g47, g48, g49 and g50**, plus part of g45. The last heading g50 is at **y=528.0703125**, inside the table viewport. The captured source remains visible at y=416.125. There is no scrollable blank tail beyond the final social.

This screenshot was captured during a persistent keyboard capture, with no pending held-click deadline: [active bounded-tail screenshot](../../../scratchpad/038/compact-drag-bounded-tail.png). [Actual before/hold/wheel/after JSON](../../../scratchpad/038/compact-drag-bounded-tail.json).

## Exact cancellation restoration

Native Escape announces cancellation. After settling: **drag=0**, tableTop **34867**, pageY **234**, g25 header **y=416.125**, all **50** expanded states restored and all **50** sections contain exactly one header. The expanded view returns exactly, with no rank write.

The isolated review tab was closed after cancellation; no viewport override was used. Earlier ordinary RK pointer translation and keyboard adjacent-insertion evidence remains applicable. Quantitative FPS, physical touch and other platforms/browsers remain unverified; this score does not certify those untested environments.
