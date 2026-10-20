# Independent interaction review — round 5

**Superseded for final acceptance by round 6:** the later actual deep-scroll middle-social check found missing nearby drop targets and revised the interaction score to 9.3/10. The observations below remain historical evidence, not current unconditional acceptance.

App freeze `b330a0350a23072527cefa870bf0ce9855ce826802d99bec5d226b0f0d25642e`, Chrome real beta, synthetic 50-social/500-RK team. Runtime/CSS remained frozen throughout. This reviewer authored no runtime or test changes.

**Score: 9.9/10 for the actual available UI interaction scope.** All runtime defects reproduced in rounds 2–4 are fixed in this retest. This score is an interaction review, not certification of continuous pointer frame rate, physical touch or other browser/platform behavior.

## Rechecked fixes

- After actual keyboard activation has completed, the captured social has centered origin `50% 50%` and its full collapsed source is visible at the expected x. One ArrowDown announces **position 2 of 50**, instead of position 30. The source remains **1258.953125 × 54.1953125 px**. The normal library insertion transition is visible and the source no longer receives a doubled parent offset.
- Escape announces cancellation. After the library's cancel animation settles, drag source count is zero, table scrollTop returns to **0**, and every social section has exactly one heading. The first header is at y=307 with window scrollY=205.5, matching the position established by native keyboard focus before capture. The old heading ownership corruption and huge table scroll jump are absent.
- Actual RK Space activation lifts the original **LI, 1258.953125 × 218.796875 px**, retaining all five long run descriptions and all three inputs. One ArrowDown announces **position 2 of 10**. Escape restores the original first RK `4f37fdac-8945-4c5b-bd5c-941ca6d3de87`, normal section ownership and no active capture.
- Final real native pointer hold at `(700,365)` was measured after approximately 700 ms of a 2200 ms hold. Before capture the social header was x=62.5234375, y=341.5, width=1258.953125, height=53.1953125. Captured full section was x=62.5234375, y=341.0546875, width=1258.953125, height=54.1953125 (header plus border). Original text remained intact; all RK bodies temporarily folded. Grab origin `50.63544859940675% 44.176824790718165%` corresponds to the actual press point. [Actual held-source screenshot](../../../scratchpad/038/compact-final-social-hold.png).
- Release without movement announces unchanged order and restores content. No stored rank or financial mutation was made.

## Phone evidence for the designer

At **390 × 844**, the synthetic five-run busy RK with four action buttons fits its table:

- Document clientWidth/scrollWidth **390/390**; table **324/324**.
- Action cell x=251, width=98, height=64. All four controls are 30 × 30, at x=259/293 and y=589.1953125/623.1953125, within the cell and table.
- Three actual input interiors are **82 px** wide, under the single selected-day finance headings. No date or repeated input label is printed into the row.

Artifacts: [phone screenshot](../../../scratchpad/038/compact-phone-busy-final.png), [actual DOM geometry](../../../scratchpad/038/compact-phone-busy-final.json). This reviewer captured them; the designer must independently inspect the artifacts and state that provenance.

## Explicit limits and cleanup

Raw CDP pointer commands were denied by the browser bridge. Immediate native drag did not satisfy the 500 ms activation delay; held-click plus native drag/wheel did not establish a measurable continuous pointer translation. Those attempts are not reported as successful continuous pointer tests. No quantitative FPS, physical touch or Windows/WebKit claim is made. The actual native hold/grab geometry and actual keyboard insertion/cancellation evidence above are separate, verified observations.

Temporary viewport was reset to **1384 × 666**. Final actual DOM check: zero active captures, first RK unchanged, one header per social section. Isolated review tab 766198456 was closed. User tabs and live financial data were untouched.

## Addendum — independent assessment of root's additional pointer capture

After this review, root supplied an additional real pointer trace on the **same application hash**, captured in a fresh browser binding where documented CDP mouse input was available. This reviewer independently read and checked [the captured JSON](../../../scratchpad/038/compact-final-pointer-proof.json); this is assessment of root's evidence, not another UI session performed by this reviewer.

The measured ordinary RK source preserves **1258.953125 × 44 px** and three inputs throughout. Its x moves from **62.5234375 to 122.5234375**, exactly **+60 px**, matching root's reported six 10 px native pointer steps. Its subsequent y moves from **441.890625 to 485.890625**, exactly **+44 px**, matching the reported vertical pointer movement. Initial grab offset is **787.4765625 px horizontally and 22 px vertically**; unchanged source dimensions and the matching translations support preservation of that grab offset.

The adjacent row has a measured intermediate position: y **485.890625 → 468.9897766113281 → 441.890625**. This is **−16.900848388671875 px** at the intermediate sample and **−44 px** at rest. The timestamp interval to the intermediate sample is **105 ms**, despite its descriptive phase name `vertical-60ms`; the settled sample is **362 ms** after the initial sample. These observations support an animated neighboring insertion rather than an instantaneous final-position jump. Three samples do not establish a frame-rate or continuous-frame smoothness certificate.

Root reports native Escape followed by mouse release. The recorded final state has **zero active drags**, the source rectangle exactly restored, all **seven social groups with one header each**, three inputs, table scrollTop=0 and pageY=234. The JSON does not record the starting pageY, so this addendum does not infer an independent before/after outer-page scroll equality from it.

This additional evidence closes the earlier unverified **actual pointer translation and intermediate neighboring movement** observations for an ordinary desktop RK on this source hash. Physical touch, quantitative FPS and other browser/platform behavior remain unverified. The score remains **9.9/10**.

## Final source applicability — search canvas correction

Final application hash: **`2d721f61ae2f5089a8db19ca5bb0c2d453829da3a5b3730a9c4fafe39786693a`**, verified against the current source manifest. This reviewer independently inspected the additional `AccountSpace` layout effect and its focused search regression test; no additional browser session was performed for this assessment.

The correction clears the retained list/surface minimum heights and resets the inner table to its top when **search, occupancy or marker** changes. This is appropriate for a newly filtered result set: it prevents a previous day's retained scroll canvas from leaving matching rows above the clipped viewport. The effect is limited to the unified Accounts surface, runs after the filtered DOM is committed and before paint, and deliberately does **not** depend on selected date, drag state or presentation preferences. A Today/Yesterday change with unchanged filters therefore does not acquire a new scroll reset from this correction.

The focused regression recreates retained heights and table scrollTop=371, changes search, then checks scrollTop=0, removal of both retained heights and the expected two matching rows. Root reports **86/86** targeted tests passing after this correction; this reviewer did not rerun that command. The previously captured drag-provider/CSS behavior is unchanged by this narrowly scoped filter correction, so its hold geometry, pointer translation, adjacent insertion and cancellation evidence remains applicable. The final interaction assessment remains **9.9/10**, with the same explicit FPS/touch/platform limits above. Buyer's separate actual search retest supplies the browser evidence for the new search behavior.
