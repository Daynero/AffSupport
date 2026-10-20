# Variable-height RK sorting: installed-library research

Researcher: `/root/hover_audit`. Read-only implementation inspection; no UI
operation, implementation edits or tests executed for this investigation.

## Cause and supported seam

Installed dnd-kit version is 0.5.1. In
`node_modules/@dnd-kit/collision/dist/index.js`, default collision detection
first uses pointer intersection (high priority), then shape intersection.
This makes thresholds depend on where the pointer grabbed a tall row.

`useSortable` accepts `collisionDetector` through `SortableInput` /
`DroppableInput`. Each droppable calls that detector after the collision
observer has filtered disabled and incompatible targets. The sortable's
existing optimistic plugin handles DOM movement, transitions, cancellation
and indices independently of the detector.

## Important built-in caveats

- `closestCenter` first calls default collision detection; it is not a pure
  center-distance algorithm in this installed version.
- `directionBiased` uses shape-center distance while moving, but falls back to
  default collision detection when `position.direction` is null. It therefore
  does not satisfy a strict requirement of no pointer-based fallback.
- Collision results with equal priority and type sort by descending value.
  The standard center-distance score is reciprocal distance.

## Minimal recommendation

Use the official per-sortable collision detector seam with a small, pure
closest-center detector: read `dragOperation.shape.current.center` and
`droppable.shape.center`; return null if either shape is unavailable; otherwise
return their reciprocal Euclidean distance with `CollisionType.Collision` and
`CollisionPriority.Normal`. Represent exact coincidence as positive infinity,
which sorts above any finite distance. Do not consult pointer coordinates or
fall back to default detection.

This changes target selection only. Keep the full source, source dimensions,
pointer grab offset, pointer activation, feedback, existing transition and
optimistic sorting plugin unchanged.

The standard closest-center threshold is the boundary between the source
placeholder's center and its neighbor's center. It is not the claim that the
dragged center must reach the neighbor's center. For adjacent 200 px and 44 px
rows, the center spacing is 122 px and the boundary is 61 px away. Mirroring
the arrangement gives the same 61 px travel upward. A different pointer grab
offset cannot change this decision. DOM reordering updates the placeholder
center and naturally provides hysteresis after the swap.

## Meaningful regression cases

1. Same full-row shape at different pointer grab offsets yields the same target.
2. Mirrored tall/short layouts cross their respective center-distance boundaries
   after equal positive/negative displacement.
3. Just-before and just-after each boundary produce the expected sibling.
4. Null direction at initial capture remains center-based.
5. Missing source or target shape returns no collision; exact coincident
   centers remain the strongest valid collision.

Follow those detector tests with actual tall-row dragging in both directions,
including cancellation and release. Unit geometry does not certify the live
feedback trajectory or animation.
