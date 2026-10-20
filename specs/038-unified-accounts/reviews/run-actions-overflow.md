# Run hover and action placement

Moved RK run actions between the run column and the financial columns; keyboard DOM order follows that placement. Existing responsive layouts are retained. Finance headings occupy the same tracks as fields and no longer inherit wide letter spacing. Status track is 112px, preventing Ukrainian busy text from overflowing into the run hover band.

Run names use opt-in overflow hints in InstantTips. Each hover measures current scroll/client width; fitting text shows no duplicate hint, clipped text retains the full name. Resizing and revealing actions cannot leave a cached overflow decision. No new journey or telemetry payload is introduced.

Validation: InstantTips and design token tests 8/8 PASS; table/finance run 59/60 PASS with the async finance Undo applied-signal assertion missing once, then that exact test PASS on retry (no weakening). Scoped ESLint, Prettier, token checker and diff whitespace clean. No full-suite green claim.

Actual beta at normal 1447px viewport: run starts 30.3px after status text ends; actions follow run with an 8px gap, finance follows actions with an 8px gap. Finance ends within row; all three heading scroll widths equal their 84px cells. Native mouse movement onto BUYER-R3 RUN produced no instant tooltip (name fully visible). Screenshot: scratchpad/038/run-actions-hover-fixed.png. Search restored to empty afterward; no financial or account data changed.
