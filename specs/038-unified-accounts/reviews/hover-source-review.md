# Hover correction — independent source review

Reviewer: `/root/hover_audit`. Source-only inspection; no browser interaction,
runtime edits, fixture writes or test execution by this reviewer.

## Initial findings

1. **Confirmed remaining cascade defect.** The legacy `@media (max-width:
1000px)` rule sets `.team-account-head:not(.is-editing)` to `display:
flex`. The new unified selector changes `grid-template-columns`, but does
   not declare `display: grid`. Its two-column and phone single-column layouts
   therefore do not apply below 1000 px. Declare `display: grid` in the unified
   non-editing header rule, then verify 1000, 768 and 390 px.
2. **Unverified sizing risk.** The new run grid reserves intrinsic columns for
   age and both edit/delete controls. Near the 769–1000 px range the parent
   six-track table can give the run column less width than those controls need.
   Because the parent now has `overflow: visible`, inspect this range with long
   relative ages and a busy RK. This is a source-derived concern, not a claimed
   browser reproduction.

## Corrected causes

- Removing the opaque sticky title addresses the rectangular SOC overlay.
- Giving SOC actions their own intrinsic track addresses their old 128 px
  overflow instead of hiding metadata with a higher z-index.
- The ellipsis selector now matches the actual `.team-agent-run-text` element;
  the full note remains available through its `title`.
- Hidden run actions remain in layout, so hover only reveals opacity and color.
- Keeping focus outlines visible and removing frequent hover transitions follow
  the repository design rules.

## Required runtime checks

Hover and keyboard-focus SOC with 2FA, long name and tags; busy RK with four row
actions; long run notes and relative ages; viewer rows without run controls;
phone action wrapping; pointer down/hold and Escape after hovering. Confirm
finance/input bounds and row geometry before/after hover rather than inferring
stability from CSS alone.

Initial acceptance score was withheld until the confirmed cascade defect was
fixed and the sizing concern checked.

## Follow-up source review

Reviewed application source freeze
`d87305a9f3ba8c5454b0261ca725d34d3e713bdeeff12cab04ede6392c7eeed8`.

- The unified non-editing SOC header now explicitly declares `display: grid`;
  its more specific selector overrides the legacy tablet `display: flex`.
  The later phone rule changes the track count while preserving grid display,
  and assigns the actions to the following row.
- The narrower RK layout now starts at 1000 px. It places status and run notes
  on the second row, retaining the status while giving notes a substantially
  wider track than the previous six-column layout. The original narrow-track
  concern has been addressed in the source; actual bounds remain a browser
  acceptance check.
- Run edit/delete buttons now explicitly use the 30 px token for both width
  and height, overriding the legacy 36 px width. SOC 2FA and add-RK controls
  use the same height.
- Editing-row selectors remain more specific than the ordinary responsive
  row selectors, so these changes preserve the existing inline editor areas.
- No hover rule changes a grid track, width, height, positioning or content
  presence. Controls reserve their space before their opacity changes;
  keyboard focus and touch reveal paths remain present.

No remaining blocking defect was found in this bounded source review.
**Source-quality score: 9.9/10.** This is not a browser, visual or interaction
score. Root owns the actual 1384/1000/800/390 px geometry and hover checks;
this reviewer did not operate or observe the live browser and makes no claim
that those checks passed.

## Archive and opaque drag follow-up

Current reviewed application source freeze:
`f55233dbed9aa59f418914ef87cfa32efa9ed1d19ec562d7adf184c6a8b9e346`.

The archived status class now takes priority in the React conditional over
free/busy. It retains the existing archived text and gives the status dot the
error token, so an archived RK does not acquire a green or amber dot merely
because its run collection is empty or nonempty. This changes presentation,
not archive persistence, totals or date visibility.

The drag selector targets the actual SOC section or RK row while the library
marks it as dragging or dropping. Its specificity is four class/attribute
components, which exceeds the legacy free-hover and even-row backgrounds
(three) and ordinary hover backgrounds (two). It therefore keeps a solid
surface through those states. The surface token resolves to opaque `#ffffff`
in light mode and `#1c1725` in dark mode; transparent run or heading washes
are composited over that solid source. Explicit opacity, isolation and shadow
apply to the complete source, without changing its dimensions, transform,
pointer activation or the library's drag physics.

No additional blocking source issue found. **Current source-quality score:
9.9/10.** This remains source-only evidence. Physical pointer/drop appearance
and the absence of translucency in the live browser require the designated
UI review; this reviewer did not run it.

## Plain names, color bands and removal of visible grips

Reviewed the subsequent working-tree changes in `AgentRow`, `AccountGroup`,
`AccountReorderProvider`, `AgentIdentity` and the account styles. This follow-up
is source-only and supersedes the earlier mention of visible drag grips.

Visible six-dot controls are removed. The pointer sensor still registers the
whole source element, keeps the 500 ms activation constraint, excludes normal
interactive controls, and permits the name decoration target. The hidden handle
remains registered. Inspection of the installed dnd-kit keyboard sensor confirms
that its keydown listener binds to that hidden handle, so Space on an ordinary
More button keeps its native menu action. Keyboard ordering is provided through
the More menu and Alt+Arrow shortcuts instead.

The audit found a real disabled-action gap: the hook's direct `move` method did
not check its local disabled flag, and the SOC shortcut did not check sorting
availability. Root fixed both guards and added a missing-item check before
selecting an adjacent anchor. I re-read those fixes. Archived or locally
disabled items now cannot use that direct action, and removed items cannot be
mistaken for the position before the first sibling. Two regression cases were
added to `team-accounts-order.test.tsx` by this reviewer; they assert that those
attempts emit neither a reorder mutation nor a captured signal. They were not
executed by this reviewer while root's test run was active.

`AgentIdentity` now renders the plain full formatted name without a suffix pill
or search mark. Existing callers match its narrowed props. Personal decoration
uses solid palette tokens across the identity cell and rail, with contrast ink;
its pseudo-element ignores pointer events. Physical appearance and hover/drop
geometry of this band remain the designated browser reviewer's responsibility.

No additional blocking source defect found after the guards were corrected.
**Source-quality score remains 9.9/10**, not a claim of a fresh visual score.

## Final hold-progress and center-collision source review

Reviewed source freeze:
`426a5a9cc2393932da7b39aabf58d39d8b8e57516fb67b93fd0941ef1a7c3be3`.

The progress constraint subclasses the installed library's Delay constraint
and preserves its actual 500 ms / 5 px activation rules. It presents the grab
point on pointerdown and clears it from both activation and abort, then calls
the corresponding parent method. Release, excess movement and controller
abort therefore use the library's existing cancellation lifecycle rather than
an independent progress timer. The portal is decorative, ignores pointer
events, and unmounts with the provider. Its state contains only ephemeral
viewport coordinates, with no persistence or added analytics payload.

The pointer exclusion/ownership guards remain intact, as do the local disabled
action guard, missing-order-item guard and provider permission guards. Holding
finance, edit or ordinary menu controls cannot start the hold constraint through
this pointer sensor. The progress component does not change sorting authority.

The final collision detector uses only full source and target shape centers.
It has no pointer-intersection fallback and does not mutate drag shape, source
dimensions or grab offset. The mirrored tall/short geometry tests cover the
center-distance decision independently of pointer location. They do not claim
continuous live pointer trajectory or animation performance.

The SOC More button now uses the ref-capable inventory component, so its anchor
ref reaches the actual button without the legacy component's type mismatch.
The change preserves the menu and shortcut handlers.

I independently read root's `scratchpad/038/hold-center-browser.json`, not the
live browser. It records a 24 px ring before capture, a complete 103 px tall RK,
an opaque folded SOC source, and cancellation returning to zero captured rows,
zero grips, zero ring and no horizontal overflow. Its provenance explicitly
states that the last component-type correction did not change hold, collision,
palette or drag-source behavior. This artifact is root-captured evidence, not
an additional browser test executed by me.

No new blocking source defect found. **Final source-quality score: 9.9/10.**
No heavy checks or UI actions were run by this reviewer in this final pass.

### Final component API adjustment

Final reviewed application hash:
`fab2cab1a425123766d098e695f7e8941027fa5a509b5dae782c6dd8e06b65d0`.
The ref-capable SOC More component remains in place. Its Alt+Arrow handler now
lives on the DOM header's `onKeyDownCapture`, rather than passing an unsupported
keyboard prop to the inventory button. I read the final handler: it requires
sorting enabled, an unarchived SOC, an element inside the designated keyboard
trigger, Alt, and an up/down arrow. The button no longer has a duplicate handler,
so this does not dispatch the move twice. Other header controls do not meet the
trigger guard. More remains gated by edit permission, with the previously
reviewed hook/provider guards still present.

I also inspected the actual More-button shortcut regression in
`tests/team-account-social-order.test.tsx`; root reports its 10-test file and
the web build passed. These are root-run results, not commands repeated by this
reviewer. No additional source blocker found; **source-quality score remains
9.9/10**. No UI or heavy command was used in this last pass.

## Expanded SOC restoration after the drop animation

Read-only follow-up of the working-tree provider and `afterAccountDrop` helper;
the preceding source hash predates this additional correction.

The social remains active and folded after `dragend` until the actual source
loses its library-owned dragging, dropping and popover attributes. Inspection
of the installed default Feedback cleanup confirms that it removes those
attributes, resets its fixed-size styles and finalizes placeholder placement
synchronously. MutationObserver callbacks run after that cleanup, so the
restore callback cannot expand the section inside Feedback's old fixed box.
The helper also restores when the observed source is removed, disconnects after
completion, and suppresses callbacks when disposed during provider unmount.

Keeping `active` through settlement intentionally preserves the fold context.
The separate `finishingSocial` flag stops a successful reorder's data revision
from being treated as a fresh cancellation during that interval. Normal
cancellation still uses the same eventual Feedback cleanup path. Starting a
new accepted drag disposes the previous observer before replacing its state.

The canvas snapshot now saves its original inline minimum height before the
preparation freeze; repeated preparation does not overwrite that original.
On restoration, the heading offset is constrained below the table captions,
and the original minimum height is reinstated instead of leaving the expanded
height as a permanent blank canvas.

I read the four helper regressions for delayed cleanup, source removal,
disposal and absent Feedback. No additional blocking race was found in this
default-Feedback lifecycle. **Source-quality score: 9.9/10**, with actual upward
drop appearance and restored geometry still requiring root's browser check.
No UI action or heavy command was run for this follow-up.
