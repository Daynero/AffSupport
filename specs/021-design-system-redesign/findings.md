# Findings — 021 design system redesign

Two kinds of note. **Behaviour** is something the migration walked past: a real
defect or a rough edge that is not this feature's job to fix (FR-037), recorded
here as a candidate for a follow-up. **System** is something the migration
learned about the design system itself.

## Behaviour (candidates for a follow-up feature)

| # | Where | What | Why it is not fixed here |
|---|-------|------|--------------------------|
| B1 | `apps/web/src/transcription/TranscriptTextModal.tsx` | One file holds the transcript viewer, its player, its editor and its export. It is the largest component in the product and the hardest to change. | Splitting it is a refactor with its own risk; 021 touched only what the migration needed (T065). |
| B2 | Explorer — `useFolderPage` | A folder's rows are paged at a hundred at a time and the shell holds one copy. A 500-row folder pages four times on the way to the bottom. | Virtualisation is a performance feature, not a design one. |
| B3 | 2FA table | The row menus opened below the fold on the last two rows; a CSS rule flipped them by hand. The rule is gone (the shared popover measures), but the table still renders every row with no windowing. | Same as B2. |
| B4 | `TaskDateFilter` | A half-made range is abandoned when the popover closes. That is now stated in one place rather than three, but whether abandoning is the right answer — as against keeping the start — was never decided by anyone. | A product question, not a design-system one. |
| B5 | Toasts | `ToastTone` gained `warning`, which the region already rendered and the type did not admit. Nothing in the product raises one yet. | Deciding which failures are warnings rather than errors is a content pass. |

## System (what the migration taught the system)

| # | What | Consequence |
|---|------|-------------|
| S1 | The class floor inverts the cost of a migration. Pre-021 class names re-expressed in tokens and loaded *before* `styles.css` mean a screen's migration is deleting its own rules, not rewriting the screen. | Every group's "delete the orphaned CSS" step is the work, and it is safe: the floor catches whatever the deletion uncovers. |
| S2 | The inventory started narrower than the product. `DropdownMenu` could not hold a heading, a radio answer or a menu that asks more than one question; `Popover` could not place itself. Sixteen screens kept their own copies because of it. | The right move was to widen the inventory until the copies were redundant, then delete them — not to force the screens into a narrower vocabulary. |
| S3 | Two dialog implementations meant two open stacks, and Escape could reach a surface that was not the top one. | `useDialogBehaviour` is the only implementation. A surface inside another surface no longer needs `stopPropagation` to survive Escape; the stack settles it. |
| S4 | Every bar in the product grew by animating `width`. Invisible on one; plainly visible on a queue of forty. | `--fill-ratio` and `scaleX()`, set through one helper, and a linter rule that fails on a transition of any property that forces layout. |
| S5 | `styles.css` held the tag palettes and the two gradients — data, sitting in a screen stylesheet because there was no token layer when they were written. | The token layer is the only file in the product that names a colour, and the exemption list is empty. |
| S6 | A popover that opens a dialog must not close when the dialog is pressed. The row menu learned this the hard way (closing cancelled the move it had just been asked for) and had written the rule locally. | The rule is a property of `Popover` now, so no future menu has to rediscover it. |

## Proving SC-009 (T160)

SC-009 asks that a new screen can be built from the inventory alone. The closest
thing to a proof this feature produced without writing a throwaway screen: the
five picto groups of the compressor's settings panel, the explorer's sort and
kind menus, the 2FA notebook's two menus and the admin dashboard's four empty
states were all rebuilt from inventory components with **no new token and no new
component variant** — only two additions to an existing component's props
(`MenuItem.checked`, `RadioOption.className`), both of which express something
the product already did rather than something new.
