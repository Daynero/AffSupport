# Independent interaction review — round 8, active drag scroll boundary

**Resolved by round 9** on application hash `7b457a1575537ecae15dd0d59e2c4eeb529660e54cb26c6aa2af04b95b91f927`; actual native-wheel retest clamps to final social targets and restores the interaction score to 9.9/10.

App hash `36010b798cea217f50dfb94782395c34cf04aa8245d5f8519faa2561ea77048c`, actual local beta Chrome 1384 × 666, 50-social/500-RK synthetic team. No runtime/test or stored data edits by reviewer.

**Revised score: 9.4/10.** This actual boundary check supersedes round 7's acceptance: starting neighbors are now correct, but the retained expanded canvas still permits scrolling far beyond all collapsed drop targets.

## Actual reproduction

1. Bring g25 into view with its real menu; close the menu. Before capture: tableTop=34867, pageY=234, g25 y=416.125.
2. Activate its real keyboard handle with Space and wait for actual capture. The fixed middle-list anchor now correctly exposes surrounding targets, at tableTop=1451.
3. Send a normal native wheel through the documented, available CDP API: `Input.dispatchMouseEvent`, type `mouseWheel`, x=950, y=500, deltaY=5000, deltaX=0. This succeeds on the fresh review binding; no denied API was bypassed.
4. Observe the still-active capture: tableTop becomes **6451**, scrollHeight **72800**, clientHeight **333**, and the last social heading is at **y=-2928.9296875**. The only visible heading is the fixed captured g25. **There are zero visible peer drop targets**, and the surrounding table is empty.

The screenshot was captured while keyboard capture remained active and shows the same empty viewport as the DOM measurement: [active blank-tail screenshot](../../../scratchpad/038/compact-drag-blank-tail.png), [actual before/during/after measurements](../../../scratchpad/038/compact-drag-blank-tail.json). Unlike the earlier timed held-click screenshot, there was no pending native click-release deadline in this capture.

The first immediate `Tab.scroll` attempt did not establish a changed viewport and is not counted as proof. The successful native wheel command and subsequent separate DOM read/screenshot above are the basis of this finding. Pointer auto-scroll itself was not separately measured; ordinary native scrolling while an operation is captured already establishes the reachable unusable tail.

## Cancellation integrity

Native Escape correctly announces cancellation. After settling: **drag=0**, tableTop **34867**, pageY **234**, g25 **y=416.125**, all **50** socials expanded and every section has exactly one header. There were no rank writes.

The required fix is to give an active folded social list its natural compact scroll range, while preserving the original expanded canvas/anchor for restoration. Root owns implementation; this reviewer made no runtime edits.
