# Independent interaction review — round 4

App freeze `2108b372a767aa0b2363e39864ccc1480d7c0cb6da598662ad2fbdf4200ad1f2`. Chrome, real beta, 1384 × 666, unchanged synthetic stress data. Full runtime/CSS freeze was held throughout. No runtime/test changes or stored ranks/finance edits by reviewer.

**Score: 9.0/10. Prior DOM ownership and cancellation damage are fixed; keyboard social movement still skips many positions.**

## Fixed and verified

- Sortable and Feedback now own the entire semantic social section. Escape after an actual social movement restores exactly one heading per section, original section order, table scrollTop=0 and window scrollY=0. The original first three heading positions return exactly to 512.5, 2766.6640625 and 4152.859375.
- Real native pointer hold at `(700,540)` gives full source width **1258.953125**, collapsed section height **54.1953125** (header 53.1953125 plus 1 px border), x **62.5234375**, y **511.9765625**. Its original text is intact, all RK bodies temporarily fold and table scroll remains 0.
- The source keeps original grab origin `50.63544859940675% 51.69628432956381%`. The former doubled parent x/y displacement is absent during pointer capture.

## Blocking keyboard defect

Clean first-social Space activation unexpectedly sets table scrollTop to **1939** and captures at `--dnd-top: -1447.5654281098546px`, transform origin `50% 2106.5428109854606%`. One ArrowDown then places the social at **position 30 of 50**, confirmed by the library live announcement and visible neighboring `g30`, instead of adjacent position 2.

The likely remaining cause is an activation point or keyboard scrolling calculation taken from the expanded full section before synchronous collapse. This is an actual keyboard interaction defect, not a failed synthetic pointer script. Escape cleanly restores the original view and ownership.

## Remaining input limits

Native held click followed by documented native Tab.drag was attempted. The in-flight read 80 ms after the drag call still showed zero translate; subsequent release is not sufficient evidence that pointer-follow translation occurred. No claim of continuous pointer movement, sibling FPS or touch certification is made. Raw CDP remains unavailable and was not bypassed.
