# Feature Specification: The team workspace on HeroUI

**Feature Branch**: `024-heroui-workspace`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "I want everything in the team workspace built on HeroUI components, customised to look like Soty. Use ready-made components as much as possible. Bring over the calendar I liked. But go deep: analyse every corner of the team workspace, ask yourself how it could be more convenient and more beautiful, ask whether it is comfortable for the user and what flow they walk through. One example of the failure we tried to fix today: a task is created, a video is attached to it, and I — as the person doing the task — open it and need to make a catalog out of that video. There was no button to go to the video or to make the catalog right there. So I had to close the task, go to the explorer, find the video, make the catalog there, come back to the task, and so on. Today we added 'show in explorer', which helped a bit, but I still should have been able to make that catalog straight from the task. Going to the explorer only to make a catalog and then coming back is stupid. And that is only one example. I want to convey the way of thinking: put yourself in the place of the user, of the person who creates tasks, of the person who performs them, and of someone working solo who does all of it for themselves. And not only about tasks — think through the work flow, why these tools exist at all and how to use them quickly and comfortably. Above all it must look clean and gorgeous, with no wasted movements. Everything must read cleanly, the elements that are really needed must catch the eye, and there must be none of this chaos of piles of buttons and piles of captions where you do not understand what to grab or what to press. If some logic is heavily overloaded, then we hide it in a way that separates responsibilities, so that there is no total overload with assorted chaos."

---

## Why this feature exists

The team workspace works. It is also, measured against its own design rules, in a state
its authors did not choose:

- **A third of the buttons in team mode are not buttons of the design system.** 104 raw
  `<button>` against 224 `Button`/`IconButton`; 34 raw `<input>`, 11 raw `<select>`, and a
  hand-written 42-cell calendar rendered twice in two different files.
- **The same object looks like two different objects depending on the door you came through.**
  A video in a folder has a thumbnail, a share button, a colour tag and a detail pane. The
  same video in search results has none of them. The same video attached to a task has six
  unlabelled icons and cannot be catalogued, transcribed, compressed, renamed, moved or tagged
  at all.
- **A menu can carry eleven ungrouped items** with the destructive one flush against the rest;
  meanwhile "download" appears in four places under three names, and "process" in five variants
  behind three different dialogs.
- **Doing the obvious next thing means leaving.** Catalog, transcript, compression, rename,
  move, tag, colour, re-stitch settings, creating a tag, inviting a member — all of them are
  somewhere else, and getting there closes what you were doing. The owner's own example: making
  a catalog out of a video attached to a task costs a round trip through the explorer, and the
  task's staged edits do not survive it.
- **Two save models live in one dialog with nothing marking the line.** In the task editor,
  status, progress, agent tags, team tags and dropped uploads write immediately; title, note,
  assignee, date, maximum and picked attachments wait for a Save button. Neither is wrong; both
  in one screen is.
- **Keyboard work is invisible.** `/`, ⌘C/⌘X/⌘V, Delete, Space-to-select, arrow navigation all
  exist and are named nowhere on screen. There is no command palette and no right-click menu in
  a product whose main screen is a file manager.
- **Two generations of the same control are imported side by side.** Sibling files in the
  accounts screen take `Button` from the pre-redesign shim and from the current inventory, and
  one file spells the same button both ways. Three header chips are three different elements.
  Two menu implementations and two dialog implementations coexist, one of them hand-rolling
  roving focus that the other already provides.
- **Things are shown that cannot be acted on.** Tag chips carry counts and lead nowhere. The
  Free/Busy column states what the toolbar one row above filters by, and is not clickable. An
  agent's full identifier exists only inside a hover tooltip, out of reach of touch and keyboard.
  A revoked invitation still reads "Sent". A disconnected local app is announced by a badge you
  cannot press. The history stops at fifty entries with no way to ask for more.
- **Failures are sometimes silent.** A space preference that fails to save keeps the value on
  screen and says nothing.

None of this is a bug report. It is the shape of a workspace that grew a screen at a time. This
feature re-lays it on one foundation — **HeroUI v3**, a React Aria + Tailwind v4 component
library, themed to Soty — and, while every screen is being touched anyway, fixes the flows the
screens were forcing.

The library is the means. The end is: **fewer things on screen, each one obviously the right
one, and the next step always available where you are standing.**

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Finish the job where you are standing (Priority: P1)

Someone doing a task opens it, sees the video attached to it, and does to that video anything
the product can do to a video — make its catalog, transcribe it, compress it, copy its link,
download the re-stitched copy, rename it, move it, tag it, open its folder — without the task
closing and without going anywhere.

The same is true in reverse and everywhere else: a material found by search, a material in a
folder, a material in the catalog updater's list, a material on a task — one object, one set of
actions, one appearance.

**Why this priority**: This is the owner's stated example and the deepest structural complaint.
It is also the one change that pays off on every screen at once, because it replaces N bespoke
action rows with one shared surface.

**Independent Test**: Attach a video to a task, open the task, create its product catalog from
the attachment, and confirm the task is still open, still holding its unsaved text, and now
shows the catalog on the attachment.

**Acceptance Scenarios**:

1. **Given** a task with a video attachment, **When** the performer opens the attachment's
   actions, **Then** they see the same grouped action set the explorer offers for that video,
   with the actions that cannot apply here absent rather than present-and-dead.
2. **Given** that action set, **When** they choose "Product catalog", **Then** the catalog
   dialog opens over the task, and on success the attachment shows that it now has a catalog
   with "Open" and "Copy link" available directly.
3. **Given** unsaved text in the task's note, **When** they run any material action from an
   attachment, **Then** nothing is lost and no "unsaved changes" prompt appears.
4. **Given** a video with no catalog and a disconnected Drive, **When** they open the actions,
   **Then** "Product catalog" explains in one line why it cannot run now, rather than being an
   inert grey item.
5. **Given** a search result, a folder row, a grid tile and a task attachment for the *same*
   file, **When** each one's actions are opened, **Then** the action list, its order, its
   grouping and its wording are identical.

---

### User Story 2 - One vocabulary of controls, and it is beautiful (Priority: P1)

Every control in the team workspace is a component of the design system, and the design system
is HeroUI wearing Soty's skin: Soty's colours, radii, type ramp, motion and dark theme, on
HeroUI's behaviour and accessibility.

**Why this priority**: It is the foundation the rest stands on, and it is the half of the
request that is about how the product *looks*. Nothing else can be built cleanly while a third
of the controls are hand-rolled.

**Independent Test**: Open `/design`, see every HeroUI-backed component in every Soty variant,
size and state, in both themes; then open the workspace and find no control whose appearance
disagrees with it.

**Acceptance Scenarios**:

1. **Given** the workspace in light and dark themes, **When** any screen is inspected, **Then**
   every button, field, menu, dialog, chip, badge, table, tab, tooltip and calendar comes from
   the inventory, and none of them declares a colour, radius, type step or duration of its own.
2. **Given** two controls with the same role on different screens, **When** they are compared,
   **Then** they are identical — same size, same colour role, same focus ring, same motion.
3. **Given** the dark theme, **When** it is toggled, **Then** the cross-fade still runs, nothing
   flashes white, and no surface loses contrast.
4. **Given** a keyboard, **When** any menu, dialog, calendar, table or tab strip is used,
   **Then** it behaves as its ARIA pattern promises: arrows move, Escape closes the top surface
   only, focus returns to the trigger, and no focus ring is missing.
5. **Given** the product at 390 px wide, **When** every team screen is walked, **Then** nothing
   overflows horizontally and no control falls below its minimum touch size.

---

### User Story 3 - A task you can actually work in (Priority: P1)

The task editor stops being one long form with two save models. It becomes a working surface:
what the task *is* on one side, what the task *is about* — its materials, its accounts, its
tags — on the other, with attachments above the fold and every change saved as it is made.

**Why this priority**: Tasks are where the performer lives. The editor is the densest screen in
the product and the one the owner's example runs through.

**Independent Test**: Open a task, change its title, status, assignee, date, progress and note,
attach a file, detach another, and never press a Save button; reload and find everything as
left.

**Acceptance Scenarios**:

1. **Given** the task editor, **When** any field changes, **Then** it is saved without a Save
   button, a quiet indicator says so, and a failure says so louder with a retry.
2. **Given** the editor, **When** it is opened, **Then** the task's materials are visible
   without scrolling.
3. **Given** the editor, **When** a material is picked from the picker or dropped onto it,
   **Then** both behave the same way — attached at once, undoable from a toast.
4. **Given** the editor, **When** it is closed by any means, **Then** nothing is discarded and
   no prompt is needed.
5. **Given** an attachment whose file is trashed or missing, **When** it is shown, **Then** it
   says which, in words, and offers the action that fixes it.
6. **Given** a task with no tag dictionary yet or no other members yet, **When** the tag or
   assignee control is opened, **Then** it offers to create the tag or invite the member from
   there, instead of pointing at Settings.

---

### User Story 4 - Dates behave like a calendar (Priority: P2)

Every date in the product — the task's date, the board's date filter, any range — is picked on
one real calendar: HeroUI's, themed to Soty, with a range mode, a month and year jump, keyboard
navigation, locale-correct week start, and no half-made range silently abandoned.

**Why this priority**: The owner named the calendar specifically. It is also the single largest
block of hand-rolled UI in the tasks area — 42 raw day buttons, twice, in two files with
different behaviour.

**Independent Test**: Filter the board to a range across a month boundary using only the
keyboard, then set a task's date from the editor, and find the same calendar both times.

**Acceptance Scenarios**:

1. **Given** the board's date filter, **When** the calendar opens, **Then** it is HeroUI's
   calendar in Soty's colours, with the quick ranges beside it rather than competing with it.
2. **Given** a half-picked range, **When** the popover is dismissed, **Then** the behaviour is
   stated on screen before it happens, and the same everywhere.
3. **Given** the calendar, **When** it is driven from the keyboard, **Then** arrows move by day,
   PageUp/PageDown by month, Home/End to the week's ends, and the focused day is always visible.
4. **Given** a task date and the filter, **When** both are opened, **Then** they are the same
   component with the same shortcuts.

---

### User Story 5 - One file, one identity (Priority: P2)

A material has one detail surface, and it is the same whether it was reached from a folder, from
search, from a task or from the updater: preview, facts, its companions (catalog, transcript,
re-stitched copy), and its actions.

**Why this priority**: It removes the search-versus-folder split, gives search a preview it
never had, and is what makes US1's "identical actions" visible rather than merely true.

**Independent Test**: Find a video by search, open its detail surface, read its facts and its
catalog state, act on it, and never learn which folder it is in unless you ask.

**Acceptance Scenarios**:

1. **Given** a search result, **When** it is opened, **Then** the same detail surface appears as
   for a folder row, including the thumbnail, the tag, the companions and the actions.
2. **Given** a material with a catalog and a transcript, **When** its detail surface is open,
   **Then** both are shown as companions with their own actions, not buried in a menu.
3. **Given** the detail surface, **When** "Show in folder" is used, **Then** the explorer opens
   on that folder with the file selected — and from a task, the task stays open behind it.

---

### User Story 6 - Actions you can find without hunting (Priority: P2)

The product tells you what it can do: grouped menus with the dangerous item apart from the safe
ones, a right-click menu where a file manager should have one, a command palette on ⌘K that
reaches any space, folder, file, task or account and runs the common actions, and one place that
lists the keyboard shortcuts.

**Why this priority**: It is the direct answer to "a pile of buttons you do not know what to
grab". Grouping and hiding are the same act done well.

**Independent Test**: With the keyboard only, open the palette, jump to a named task, and change
its status.

**Acceptance Scenarios**:

1. **Given** any material menu, **When** it is opened, **Then** its items are grouped under
   headings by intent (open / get / make / organise / remove), destructive last and visually
   separated, each with an icon, and no group longer than it needs to be.
2. **Given** the explorer, **When** a row or tile is right-clicked, **Then** the same grouped
   menu opens at the pointer, and the browser menu does not.
3. **Given** anywhere in the workspace, **When** ⌘K / Ctrl+K is pressed, **Then** a palette
   opens that searches spaces, folders, materials, tasks and accounts, and offers the actions
   available for what is highlighted.
4. **Given** the workspace, **When** the shortcut sheet is opened, **Then** every shortcut the
   product binds is listed, grouped, with its scope.
5. **Given** a narrow window, **When** any toolbar or selection bar is shown, **Then** actions
   collapse into a labelled overflow menu rather than becoming unlabelled icons.

---

### User Story 7 - The chrome stops throwing you out (Priority: P2)

Opening space settings, the catalog updater or the trash from Tasks, Accounts or Members does
not move you to the explorer. Every dialog that is worth returning to is addressable, and
closing one puts you back exactly where you were.

**Why this priority**: It is a small change with a large felt effect, and it removes one of the
few places where the product actively loses your position.

**Independent Test**: From the Tasks tab, open space settings, close it, and still be on Tasks
with the same filters and the same scroll position.

**Acceptance Scenarios**:

1. **Given** any section, **When** settings / the updater / the trash is opened, **Then** the
   section does not change, and closing returns to it.
2. **Given** any section, **When** the trash is wanted, **Then** it is reachable without first
   going to the explorer.
3. **Given** a dialog that carries state worth sharing or restoring, **When** the page is
   reloaded, **Then** it reopens.
4. **Given** Members, **When** it is reached from the tab and from the settings dialog,
   **Then** there is one screen, not two that differ.

---

### User Story 8 - Accounts, agents and members read as one calm table (Priority: P3)

The accounts area — the densest data screen in the product — is rebuilt on the inventory's table
with real column semantics, and the actions on a row follow the same grammar as everywhere else.
Everything it shows can be acted on, and everything it hides can be found.

**Why this priority**: It is large and self-contained, and it is the screen with the most
bespoke CSS per square pixel. It can ship last without blocking anything.

**Independent Test**: Filter, fold, edit a value inline and act on a row using only the
keyboard, in both themes, at 390 px and at 1440 px.

**Acceptance Scenarios**:

1. **Given** the accounts table, **When** it is rendered, **Then** it is the inventory's table
   in its dense size, with sticky headers and no cell that disappears out of its column when a
   group folds.
2. **Given** a row, **When** its actions are opened, **Then** they follow the same grouped
   grammar as a material's, from the shared menu rather than a hand-rolled one.
3. **Given** an account or agent, **When** the tasks it is tagged in are wanted, **Then** one
   action goes there — and from a task's agent chip, one action comes back.
4. **Given** an account head or a group row, **When** it is used from the keyboard, **Then** it
   folds and unfolds like any other disclosure, and every identifier it shows can be selected or
   copied without a hover.
5. **Given** a tag chip carrying a count, **When** it is pressed, **Then** it filters to what it
   counted.
6. **Given** the Free/Busy state and the colour markers, **When** either is pressed, **Then** it
   filters by that value, the same way the toolbar does.
7. **Given** an invitation, **When** it has been revoked, accepted or has expired, **Then** the
   row says which, and the actions still available match that state.
8. **Given** the space history, **When** it reaches its page, **Then** more can be asked for.
9. **Given** a money figure, **When** it is shown, **Then** it carries its currency, in one
   format used everywhere money appears.
10. **Given** a read-only member, **When** they want to copy a list they are allowed to read,
    **Then** they can.

---

### User Story 9 - Quiet by default (Priority: P3)

The workspace is calm: one primary action per surface, words where a colour alone would be a
guess, empty and error states that carry the action that fixes them, motion that never animates
layout, and density that reads at a glance.

**Why this priority**: It is the connective tissue of "clean and gorgeous". It is stated last
because it is verified across every screen the earlier stories touch.

**Independent Test**: Walk every team screen in both themes and find exactly one primary button
per surface, no state told by colour alone, and no empty state that is only a sentence.

**Acceptance Scenarios**:

1. **Given** any team surface, **When** it is rendered, **Then** it carries at most one primary
   action, and that action sits at the end of the reading order.
2. **Given** any state shown by colour, **When** it is read, **Then** a word or an icon says the
   same thing.
3. **Given** any empty, loading, error or no-permission state, **When** it appears, **Then** it
   is the shared pattern and, where a fix exists, it carries it.
4. **Given** reduced-motion preference, **When** the workspace is used, **Then** every transition
   collapses and only the spinner keeps turning, slower.

---

### Edge Cases

- **A material that cannot take an action here.** Rather than a disabled item, the action is
  absent when the object can never take it (a folder cannot be catalogued) and present with a
  one-line reason when the situation is temporary (Drive disconnected, agent not running, no
  permission).
- **The local agent is not running.** Every action that needs it says so in the same words, in
  the same place, with the same way to fix it — and the actions that do not need it are not
  dimmed alongside them.
- **An action started from a task whose material has since been trashed.** The action fails into
  the material's own state, and the attachment shows "in the trash" with "restore" rather than a
  generic failure.
- **Two tabs open on the same task or folder.** Live updates keep arriving; an autosaved field
  that lost a race says so and offers to take the newer value, rather than silently snapping
  back.
- **A very long file name, a 500-row folder, a task with 200 attachments.** Names truncate in
  their column rather than widening it; long lists page or virtualise; no layout is decided by
  its widest child.
- **Someone with read-only permission.** Sees the same surfaces with the actions they cannot
  take absent, and one explanation of why, once — not a screen of dimmed controls.
- **The workspace at 390 px.** Every pane that cannot fit becomes a sheet or a drawer; nothing
  becomes an unlabelled icon row.
- **A theme switch mid-flight.** Open dialogs, menus and calendars re-theme without closing.
- **Right-click on a selection of many.** The menu acts on the selection, and says how many.

---

## Requirements *(mandatory)*

### Functional Requirements — foundation

- **FR-001**: The web app MUST adopt HeroUI v3 (`@heroui/react`, `@heroui/styles`) with Tailwind
  CSS v4 through the first-party Vite plugin, on the existing React 19 / Vite 8 stack, with every
  dependency pinned to an exact version.
- **FR-002**: Soty's existing design tokens MUST remain the single source of every colour,
  radius, type step, duration, shadow and z-layer. HeroUI's theme variables MUST be defined from
  those tokens, in the one file that is allowed to carry values, so the library wears Soty's skin
  rather than Soty adopting the library's.
- **FR-003**: Theme switching MUST keep working through `data-theme` on the document element,
  including the pre-paint theme commit and the cross-fade; HeroUI's own dark convention MUST be
  bridged to it rather than replacing it.
- **FR-004**: Tailwind's reset MUST NOT disturb the screens that have not been migrated yet;
  layers MUST be ordered so that the existing global stylesheet and the new utility layer can
  coexist for the whole of the migration.
- **FR-005**: The component inventory at `apps/web/src/components/ui/` MUST keep its public API —
  the `color` × `variant` × `size` prop vocabulary, component names and prop names — while its
  implementation moves onto HeroUI, so that screens migrate by behaviour and not by rename, and
  the screens outside the team workspace keep working untouched.
- **FR-006**: Each inventory component MUST keep emitting its semantic marker classes
  (`ui-<name>`, `ui-<name>--<variant>`, `ui-color-<role>`, `is-<state>`) alongside the library's
  own classes, so the "one role, one appearance" contract stays mechanically checkable.
- **FR-007**: Raw values MUST remain impossible to introduce. In addition to the existing CSS
  gate, a new check MUST fail on a Tailwind utility that carries a literal value (an arbitrary
  value in brackets, or a palette step that is not a Soty role) written in application code.
- **FR-008**: `/design` MUST show every inventory component in every variant, size and state in
  both themes, and MUST additionally show the new patterns this feature introduces (the material
  action surface, the material detail surface, the command palette, the calendar).
- **FR-009**: The download budget MUST be measured before and after, and the baseline re-set
  deliberately with the difference explained, including the CSS removed in exchange.
- **FR-010**: Principle VI of the constitution MUST be amended before this work is merged,
  because it currently requires one global stylesheet and `className` strings against it. The
  amendment MUST state what replaces it: the token layer as the only source of values, the
  inventory as the only source of controls, and the utility layer as the only way to write new
  style.
- **FR-011**: The third-party notices MUST record the new dependency tree and its licences.

### Functional Requirements — the material action surface (US1, US5, US6)

- **FR-012**: There MUST be exactly one definition of what can be done to a material, expressed
  once and rendered everywhere: folder row, grid tile, search result, detail surface, task
  attachment, updater row, selection bar.
- **FR-013**: That definition MUST take the material and its context and answer, per action:
  available, unavailable-with-reason, or not-applicable. Not-applicable actions MUST be absent;
  unavailable ones MUST carry their reason in one line.
- **FR-014**: Actions MUST be grouped by intent, in a fixed order, with headings: **Open**
  (open, preview, show in folder), **Get** (copy link, share, download, download re-stitched),
  **Make** (product catalog, transcript, compress, process, regenerate preview), **Organise**
  (rename, move, colour tag, create task from it), **Remove** (trash, restore, detach).
- **FR-015**: The destructive group MUST be separated and last, and MUST never be the default
  focus of a menu.
- **FR-016**: The two or three actions a surface uses most MUST be available without opening a
  menu; the rest MUST live behind one overflow. No surface may carry more than four inline
  actions.
- **FR-017**: Every action MUST report its outcome exactly once, through the one toast channel,
  with machine codes mapped to human sentences by the existing single mapper.
- **FR-018**: A reversible destructive action MUST offer Undo instead of a confirmation; an
  irreversible one MUST confirm with a verb naming the consequence.
- **FR-019**: Running an action from inside another surface (a task, the updater) MUST NOT close
  or reset that surface.
- **FR-020**: A material's companions — its product catalog, its transcript, its re-stitched copy
  — MUST be visible on the material itself wherever it appears, with their own direct actions.
- **FR-021**: The explorer MUST offer the same grouped menu on right-click, acting on the
  selection when the pointer is over a selected row.

### Functional Requirements — the material detail surface (US5)

- **FR-022**: There MUST be one detail surface for a material, reached identically from folder,
  search, task and updater, showing: preview, name, kind, size, dates, folder, colour tag,
  companions, and the full action set.
- **FR-023**: Search results MUST use it, so that a search result and a folder row are the same
  object with the same affordances.
- **FR-024**: Opening it MUST NOT lose the surface it was opened from.

### Functional Requirements — tasks (US3)

- **FR-025**: The task editor MUST have one save model: every change is written as it is made,
  with a quiet saved indicator, an explicit failure with retry, and no Save button, no unsaved-
  changes prompt and no staged state.
- **FR-026**: Attachments MUST be visible without scrolling, and MUST carry the full material
  action set through the shared surface.
- **FR-027**: Picking and dropping MUST produce identical results; the picker MUST attach on
  confirm.
- **FR-028**: Detaching MUST be undoable from a toast and MUST NOT be confused with trashing;
  the two MUST be worded so the difference is obvious.
- **FR-029**: An attachment MUST state its availability in words when it is not ready — trashed,
  missing, unavailable, still uploading — and MUST offer the action that resolves it.
- **FR-030**: The editor MUST be laid out as two responsibilities side by side on a wide screen
  and stacked on a narrow one: the task's own fields, and the things the task points at
  (materials, accounts, tags).
- **FR-031**: Creating a tag and inviting a member MUST be possible from the controls that need
  them, without leaving the task.
- **FR-032**: The board MUST allow acting on more than one task at a time for the operations
  that are safe in bulk (status, assignee, tag, delete-with-undo).
- **FR-033**: Task cards MUST carry the actions that do not require the editor, behind one
  overflow, and MUST keep the whole card as the open target.
- **FR-034**: Every filter, sort and view preference on the board MUST persist per space, in one
  mechanism, including the ones that currently use their own storage key.
- **FR-035**: A control MUST NOT appear and disappear with unrelated state; where sorting by tag
  is impossible because no tags exist, the control MUST be present and explain itself.

### Functional Requirements — dates (US4)

- **FR-036**: All date and date-range entry MUST use the library's calendar, themed to Soty, with
  one behaviour for a half-made range, stated on screen.
- **FR-037**: The calendar MUST support keyboard navigation by day, week, month and year, and
  MUST respect the locale's first day of week.
- **FR-038**: Quick ranges MUST sit beside the calendar as presets rather than as a competing row
  of buttons, and MUST stay relative — "today" stays today across a reload.

### Functional Requirements — explorer and search (US5, US6)

- **FR-039**: Opening a row MUST be consistent between list and grid; a single interaction MUST
  mean the same thing in both.
- **FR-040**: The two selections — the focused row and the checked set — MUST be visually
  distinct and the checked set MUST say, always, how much of it is out of view.
- **FR-041**: The explorer's process, compress and transcript entries MUST be unified into the
  one "Make" group, with the scope (this file / this folder / the selection / the whole space)
  chosen inside one dialog rather than by which door was used.
- **FR-042**: Search MUST keep the detail surface and MUST NOT be mutually exclusive with it.
- **FR-043**: Rows, tiles and results MUST all offer the colour tag and the share action, or none
  of them MUST.
- **FR-044**: A folder's rows MUST remain usable at 500 rows; the list MUST not degrade into
  repeated manual paging.

### Functional Requirements — chrome and navigation (US7)

- **FR-045**: Space settings, the catalog updater and the trash MUST open over the current
  section and return to it.
- **FR-046**: The trash MUST be reachable from every section.
- **FR-047**: Members MUST exist once.
- **FR-048**: Creating a space MUST be reachable from inside a space.
- **FR-049**: Leaving a space and transferring ownership MUST be reachable from one place, with
  each naming the other.
- **FR-050**: A dialog whose state is worth restoring MUST be addressable; the rest MUST NOT be.
- **FR-051**: The tab strip MUST behave as one pattern; two tab strips on screen MUST NOT differ
  in their keyboard behaviour.
- **FR-052**: The three status chips in the header MUST be one component with one shape and one
  interaction, differing only in what they report.

### Functional Requirements — discoverability (US6)

- **FR-053**: A command palette MUST open on ⌘K / Ctrl+K anywhere in the workspace, search
  spaces, folders, materials, tasks and accounts, and offer the actions available for the
  highlighted result.
- **FR-054**: Every keyboard shortcut the product binds MUST be listed in one place reachable
  from the workspace, and MUST be named in the tooltip of the control it duplicates.
- **FR-055**: Copy, cut and paste of materials MUST also exist as menu items, not only as
  shortcuts.

### Functional Requirements — accounts and members (US8)

- **FR-056**: The accounts screen MUST be rebuilt on the inventory's table, keeping its density,
  its sticky header, its foldable money column and its inline editing, and MUST NOT lose a cell
  out of its column when a group folds.
- **FR-057**: Row actions MUST follow the same grouped grammar as a material's, from the shared
  menu; the hand-rolled agent menu and its module-level "one menu open" global MUST be deleted.
- **FR-058**: An account or agent MUST link to the tasks tagged with it, and a task's agent chip
  MUST link back to that agent in Accounts.
- **FR-059**: Every disclosure MUST be operable by keyboard and MUST describe honestly what it
  hides; a disclosure whose target is never hidden MUST stop claiming to be one.
- **FR-060**: An identifier MUST NOT live only in a hover tooltip; it MUST be selectable and
  copyable.
- **FR-061**: Anything that displays a count MUST be able to show what it counted.
- **FR-062**: A state that the toolbar can filter by MUST be filterable by pressing it in the
  row as well.
- **FR-063**: An invitation MUST state its own state — pending, revoked, accepted, expired — as
  a word, and MUST offer only the actions that state allows.
- **FR-064**: The space history MUST be pageable.
- **FR-065**: Money MUST be formatted one way across the product, with its currency.
- **FR-066**: An action that only reads MUST be available to anyone who may read.
- **FR-067**: Agent tags MUST be searchable and filterable wherever agents are listed.

### Functional Requirements — quality (US9, all)

- **FR-068**: Every surface MUST carry at most one primary action.
- **FR-069**: No state may be conveyed by colour alone.
- **FR-070**: Empty, loading, error and no-permission states MUST use the shared patterns and
  MUST carry the fixing action where one exists.
- **FR-071**: No transition may animate a property that forces layout; reduced motion MUST
  collapse every transition except the spinner.
- **FR-072**: Every team screen MUST be walked at 390 px and at 1440 px in both themes, and MUST
  not overflow horizontally.
- **FR-073**: The accessibility baseline MUST not regress; every interactive element MUST be
  reachable and operable by keyboard with a visible focus ring.
- **FR-074**: A dead control MUST be removed, not migrated. Anything the audit found unreachable
  MUST be either wired up or deleted, and the choice recorded.
- **FR-075**: CSS that a migrated screen no longer uses MUST be deleted in the same change that
  migrates it.

### Key Entities

- **Material action**: an intent that can be performed on a material — its identity, its group,
  its icon, its wording, whether it is destructive, and the rule that decides whether it is
  available, unavailable-with-reason, or not applicable in a given context.
- **Action context**: where the action is being offered from — the space, the caller's
  permissions, the open folder if any, whether the local agent is connected, whether storage is
  connected, and whether the caller is a surface that must survive the action.
- **Material detail**: the one description of a material shown to a person — preview, facts,
  colour tag, companions, actions.
- **Companion**: something derived from a material and living beside it — a product catalog, a
  transcript, a re-stitched copy — with its own state and its own actions.
- **Theme bridge**: the mapping from Soty's tokens to the library's theme variables, in both
  themes.
- **Command palette entry**: a thing that can be jumped to or acted upon by name.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Making a product catalog from a video attached to a task takes **one action from
  inside the task**, with zero screen changes and zero loss of task state. Today it takes at
  least six steps and loses staged edits.
- **SC-002**: The count of raw `<button>`, `<input>`, `<select>` and `<textarea>` elements in
  `apps/web/src/team/` reaches **zero**, from 104 / 34 / 11 / 2 today.
- **SC-003**: The action list offered for one material is **identical across all five surfaces**
  that show it, verified automatically rather than by eye.
- **SC-004**: No menu in the workspace presents more than **seven items without a heading**, and
  every menu with more than five items is grouped.
- **SC-005**: The task editor writes every change without a Save button, and the "unsaved
  changes" prompt is **deleted**.
- **SC-006**: Every date in the product is entered on **one** calendar component; the
  hand-written calendars are deleted.
- **SC-007**: Opening settings, the updater or the trash from any section returns to that
  section **100%** of the time.
- **SC-008**: A person can reach any space, folder, material, task or account by name in **at
  most three keystrokes plus the name**, through the palette.
- **SC-009**: Team-owned CSS shrinks by at least **60%** (from roughly 3,500 dedicated lines plus
  the team sections of the global sheet), and the global stylesheet loses every rule the migrated
  screens no longer use.
- **SC-010**: A screen the product does not have can be assembled from the inventory with **no
  new token and no new component variant**, as was proved for the previous design system.
- **SC-011**: Every team screen passes at 390 px with **no horizontal overflow** and at 1440 px
  with no orphaned column, in both themes.
- **SC-012**: The accessibility baseline shows **no new violations**.
- **SC-013**: First-load download weight is measured and the change is **stated and justified**,
  with the CSS removed counted against the library added.
- **SC-014**: Every gate in the one verification command passes on all three operating systems.

---

## Assumptions

- **HeroUI v3 is the library**, chosen by the owner after comparing it with shadcn/ui, Mantine
  and React Aria Components. It is MIT-licensed, built on React Aria and Tailwind v4, requires
  React 19 and no provider, and its theme is plain CSS variables — which is what makes Soty's
  token layer able to drive it.
- **Scope is the team workspace.** The foundation necessarily reaches the shared inventory, so
  the screens outside the workspace (compressor, transcription, stitcher, auth, landing viewer)
  inherit the new controls and are verified for visual and behavioural regression, but their
  flows are not redesigned here.
- **No backend change is required.** This is a web-only feature by construction: no migration, no
  edge function, no agent change, no shared-contract change. It must stay deployable by the
  web-only path.
- **The owner is the maintainer** who approves the constitutional amendment that this work
  requires.
- **The existing behaviours that are deliberate stay deliberate**: the URL is the truth about
  what is open; sections are mounted once and hidden rather than unmounted; trash offers Undo
  rather than a confirmation; a material's transcript follows it on rename, move and trash.
- **The known debts recorded by the previous design system** — the oversized transcript modal,
  unvirtualised long lists, the undecided half-range behaviour, the unused warning tone — are in
  scope for this feature only where a screen it touches is the one that carries them.
- **Ukrainian remains the product's language**; every new string goes through the existing
  compile-checked translation keys, and no key is left English-only.
