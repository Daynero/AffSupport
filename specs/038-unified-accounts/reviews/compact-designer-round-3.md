# Compact accounts — independent designer, round 3

Freeze `5ec8f4d77dc06e839660768aa49a23525baf1b3281eecf3e344266ae9bb68923`. **Score: 9.7/10** across responsive scope; desktop remains9.9.

The phone action row is now horizontal and30 px high. Untagged free RK rows are97.22 px; the tagged row123.22, and one-run row151.40. Financial input content remains82 px.

One phone clipping defect remains: a busy RK has FOUR frequent actions (Add run, Release, Grip, More). Their actual group width is140 px while the track reserves only three actions. Table clientWidth324 and scrollWidth358:34 px of content is clipped by overflow-x:hidden. Reserve sufficient space for all four actions or move one into More at phone widths. Document width itself remains390.

Fresh own tab466 loaded promptly; old HMR-stalled453 was closed without data changes. Evidence `scratchpad/038/compact-designer-390-r3.png`; actual geometry measured through read-only DOM inspection. Viewport reset1384×666, no fixture writes, no runtime/test authorship.
