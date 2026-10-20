# Independent interaction review — round 7, middle-social fix

**Superseded for acceptance by round 8:** an additional actual native-wheel boundary check found a reachable blank tail during capture and revised the interaction score to 9.4/10. The starting-neighbor and cancellation observations below remain valid evidence.

Final application hash **`36010b798cea217f50dfb94782395c34cf04aa8245d5f8519faa2561ea77048c`**. Real local beta, Chrome 1384 × 666, synthetic 50-social/500-RK team, no runtime/CSS edits during this review. Reviewer made no runtime/test or stored rank/finance changes.

**Score: 9.9/10.** The actual deep-scroll missing-neighbor defect from round 6 is fixed. Earlier RK pointer/keyboard evidence remains applicable; this round directly verifies the changed social viewport anchor behavior.

## Actual native hold at the same deep-scroll position

Before capture, g25 is again at **y=416.125**, table scrollTop **34867**, pageY **234**, all **50** socials expanded. A native hold at `(700,440)` was measured approximately **750 ms** into a 4000 ms hold.

The captured full social source remains under its grab point at **x=62.5234375, y=415.125, width=1258.953125, height=54.1953125**. Source grab origin is **50.63544859940675% 45.898803517370624%**, corresponding to the actual pointer point inside that rectangle. All RK bodies temporarily fold (mounted rows=0).

The inner table now correctly moves to **scrollTop=1451**, revealing compact neighboring socials around the captured source: **g23 y=283.796875, g24 y=349.9921875, g26 y=482.3828125, g27 y=548.578125**, plus part of g22. g25's library flow placeholder is at y=416.1875. The previous empty far-scrolled canvas is gone; targets exist immediately above and below the captured source.

After release without movement: **drag=0**, tableTop **34867**, pageY **234**, g25 **y=416.125**, all **50** expanded states restored, and all **50** sections contain exactly one heading.

## Actual middle-social keyboard movement and Escape

Activate the same g25 keyboard handle with Space, wait for actual capture, then press ArrowDown. The live operation announces **position 25 of 50 → position 26 of 50**. The reviewer observes the adjacent g26 insertion and intact visible social source. Native Escape then announces cancellation.

After cancellation settles: **drag=0**, tableTop **34867**, pageY **234**, g25 **y=416.125**, all **50** socials expanded and every section has exactly one heading. This is actual Escape cancellation after movement, separate from the native pointer release-without-movement check.

## Evidence provenance and screenshot timing

The [before/during/after JSON](../../../scratchpad/038/compact-middle-social-fixed-proof.json) contains the actual in-flight read-only DOM measurement and the final keyboard cancellation outcome. It is the direct evidence for nearby targets during the native hold.

The screenshot call was submitted after the in-flight DOM read while the held-click promise was pending, but the screenshot backend returned an image showing restored run content. The designer independently spotted this discrepancy. It is therefore **not presented as an in-flight hold screenshot**; it has been renamed [restored context](../../../scratchpad/038/compact-middle-social-restored-context.png). The DOM measurement and separate keyboard observations are not inferred from that screenshot.

The isolated review tab was closed after checking zero active captures. No viewport override was used and no stored rank changes were requested. Quantitative FPS, physical touch and other platform/browser behavior remain unverified.
