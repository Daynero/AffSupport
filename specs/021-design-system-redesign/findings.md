# Findings — 021 design system redesign

Two kinds of note. **Behaviour** is something the migration walked past: a real
defect or a rough edge that is not this feature's job to fix (FR-037), recorded
here as a candidate for a follow-up. **System** is something the migration
learned about the design system itself.

## Behaviour (candidates for a follow-up feature)

| #   | Where                                                | What                                                                                                                                                                                                                | Why it is not fixed here                                                                         |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| B1  | `apps/web/src/transcription/TranscriptTextModal.tsx` | One file holds the transcript viewer, its player, its editor and its export. It is the largest component in the product and the hardest to change.                                                                  | Splitting it is a refactor with its own risk; 021 touched only what the migration needed (T065). |
| B2  | Explorer — `useFolderPage`                           | A folder's rows are paged at a hundred at a time and the shell holds one copy. A 500-row folder pages four times on the way to the bottom.                                                                          | Virtualisation is a performance feature, not a design one.                                       |
| B3  | 2FA table                                            | The row menus opened below the fold on the last two rows; a CSS rule flipped them by hand. The rule is gone (the shared popover measures), but the table still renders every row with no windowing.                 | Same as B2.                                                                                      |
| B4  | `TaskDateFilter`                                     | A half-made range is abandoned when the popover closes. That is now stated in one place rather than three, but whether abandoning is the right answer — as against keeping the start — was never decided by anyone. | A product question, not a design-system one.                                                     |
| B5  | Toasts                                               | `ToastTone` gained `warning`, which the region already rendered and the type did not admit. Nothing in the product raises one yet.                                                                                  | Deciding which failures are warnings rather than errors is a content pass.                       |

## System (what the migration taught the system)

| #   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Consequence                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The class floor inverts the cost of a migration. Pre-021 class names re-expressed in tokens and loaded _before_ `styles.css` mean a screen's migration is deleting its own rules, not rewriting the screen.                                                                                                                                                                                                                                          | Every group's "delete the orphaned CSS" step is the work, and it is safe: the floor catches whatever the deletion uncovers.                                                                                                                                                |
| S2  | The inventory started narrower than the product. `DropdownMenu` could not hold a heading, a radio answer or a menu that asks more than one question; `Popover` could not place itself. Sixteen screens kept their own copies because of it.                                                                                                                                                                                                          | The right move was to widen the inventory until the copies were redundant, then delete them — not to force the screens into a narrower vocabulary.                                                                                                                         |
| S3  | Two dialog implementations meant two open stacks, and Escape could reach a surface that was not the top one.                                                                                                                                                                                                                                                                                                                                         | `useDialogBehaviour` is the only implementation. A surface inside another surface no longer needs `stopPropagation` to survive Escape; the stack settles it.                                                                                                               |
| S4  | Every bar in the product grew by animating `width`. Invisible on one; plainly visible on a queue of forty.                                                                                                                                                                                                                                                                                                                                           | `--fill-ratio` and `scaleX()`, set through one helper, and a linter rule that fails on a transition of any property that forces layout.                                                                                                                                    |
| S5  | `styles.css` held the tag palettes and the two gradients — data, sitting in a screen stylesheet because there was no token layer when they were written.                                                                                                                                                                                                                                                                                             | The token layer is the only file in the product that names a colour, and the exemption list is empty.                                                                                                                                                                      |
| S6  | A popover that opens a dialog must not close when the dialog is pressed. The row menu learned this the hard way (closing cancelled the move it had just been asked for) and had written the rule locally.                                                                                                                                                                                                                                            | The rule is a property of `Popover` now, so no future menu has to rediscover it.                                                                                                                                                                                           |
| S7  | Renaming a control renames the selectors that lay it out. Every collapse ladder written against `.button` — the compressor toolbar's three stages, the card grids, the narrow-width widths — went dead the moment those buttons became `.ui-button`, and the screens looked fine at desktop width while losing 300px of horizontal scroll on a phone.                                                                                                | A screen's migration is not finished when its components change; it is finished when the rules that _position_ them have been followed to their last selector.                                                                                                             |
| S8  | Three of the product's screens cannot render without the local agent, so no width sweep had ever reached them. Every one of them was broken at 390 — and had been before this feature.                                                                                                                                                                                                                                                               | A stub agent on the dev server (`scratchpad/mock-agent.mjs`, session-local) is what made the compressor, the transcription page and the stitcher walkable at all. The finding is not the three bugs; it is that a screen nothing can open is a screen nothing has checked. |
| S9  | `width: auto` is not a shrinking width. An `<input>`'s auto width is intrinsic and ignores its flex parent: the transcription row's language field ran 85px past its own box under a long name, putting its chevron on its own last letter and its text under the figure beside it. The same shape in CSS Grid: an implied `auto` column sizes to its widest child's max-content, which is how one long file name made a card wider than the screen. | Where a box must give way, say so — `max-width: min(…, 100%)` on the control, `minmax(0, 1fr)` on the track. `min-width: 0` on the container does not do it.                                                                                                               |

## What the redesign cost to download

|                                    | Before (2026-09-07) | After    | Change               |
| ---------------------------------- | ------------------- | -------- | -------------------- |
| Shared chunk the document preloads | 81.6 kB             | 91.0 kB  | **+9.4 kB (+11.6%)** |
| All assets, gzipped                | 584.7 kB            | 605.5 kB | +20.8 kB (+3.6%)     |
| Entry chunk                        | 5.26 kB             | 5.38 kB  | +0.12 kB             |

The one number worth arguing about is the first. The inventory is imported by
every screen, so it lands in the chunk `index.html` preloads — it is paid for on
first paint, by everyone, whether or not the screen they opened uses it. That is
the shape of a design system: one copy of forty-five controls instead of a
bespoke one per screen, and the trade is a larger shared chunk against smaller
route chunks and far less duplicated CSS.

`performance-baseline.json` was re-ratcheted rather than the growth reduced,
because the growth is the feature working. It is recorded here so the next
person to read that file knows what moved it, and can disagree.

## Deliberate deviations from the task list

Three tasks named an inventory component the product's own version is better
at. Forcing the swap would have cost behaviour for the sake of a name, so it
was not made; each is recorded here instead, which is what FR-037 asks.

| Task | What it asked                                 | What was done, and why                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T114 | `AgentMoney` onto `InputNumber` with steppers | Left as it is. The accounts table is the product's density reference (`xs`), and this control is two four-character fields sharing one stepper column, with the caption over the field rather than over the field-and-its-presses — geometry the generic InputNumber does not have and should not grow. It reads tokens for every value it draws. |
| T123 | The audit log onto `Timeline`                 | Partly. The empty state and the outcome's colour role are the shared ones; the row itself stayed, because an audit line carries six things (action, subject, actor, outcome, detail, code) against Timeline's three, and flattening them would lose the column alignment that makes the log scannable.                                            |
| T113 | `AccountGroup`/`AgentRow` onto `Table` (`xs`) | Left as it is. The accounts table is a CSS grid whose cells stay in the grid and empty when the money column folds — taking them out slides every later cell one track left, which is the bug the fold shipped with. The inventory's Table has no equivalent, and giving it one for a single screen would be the wrong direction.                 |

## Proving SC-009 (T160)

A screen the product does not have — "Spend by account": a tab strip, a filter
row, a warning, a dense table with a progress column and a state badge per row,
a selection bar, a confirmation and an empty result — was written against the
inventory, rendered on the local server, photographed, and deleted.

**It needed no new token and no new component variant.** The only thing that
stopped it compiling was a prop it had to be given rather than one that was
missing: `Tabs` requires a `label`, because a tab strip is a navigation
landmark and an unnamed one is a defect. Two things it did _not_ need, which is
the more interesting half: no new colour (the three row states are `success`,
`warning`, `error`), and no new size (the table is `sm`, the chips `xs`, the
badges `sm` — every one of them a rung that already existed).

One artefact of the exercise reached the product: laying the screen out showed
that `.ds-page` stretched its last section to fill the viewport, because a grid
that is `min-height: 100dvh` without `align-content: start` does. Fixed.

The rest of the feature says the same thing at a larger scale: the five picto
groups of the compressor's settings panel, the explorer's sort and kind menus,
the 2FA notebook's two menus and the admin dashboard's four empty states were
all rebuilt from inventory components, with two additions to existing props
(`MenuItem.checked`, `RadioOption.className`) that express something the product
already did rather than something new.
