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

## User Scenarios & Testing _(mandatory)_

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
5. **Given** a search result, a folder row, a grid tile and a task attachment for the _same_
   file, **When** each one's actions are opened, **Then** the action list, its order, its
   grouping and its wording are identical.

---

### User Story 2 - One vocabulary of controls, and it is beautiful (Priority: P1)

Every control in the team workspace is a component of the design system, and the design system
is HeroUI wearing Soty's skin: Soty's colours, radii, type ramp, motion and dark theme, on
HeroUI's behaviour and accessibility.

**Why this priority**: It is the foundation the rest stands on, and it is the half of the
request that is about how the product _looks_. Nothing else can be built cleanly while a third
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
what the task _is_ on one side, what the task _is about_ — its materials, its accounts, its
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

---

## The work, walked by the people who do it

_Added after the first beta walk (2026-09-16). The stories above say what each screen must be;
this part says what a person is trying to get done, counts the moves it takes today, and sets
the number it must take. It was written from the code and from the running beta, not from
memory — every "today" below was observed._

There are three people in a space, and often they are the same person:

- **The lead** creates tasks: picks the material, says what is wanted, hands it to someone.
- **The performer** opens a task, does the work on its materials, and hands back a result.
- **The solo buyer** is both, for themselves — and pays for every piece of team ceremony that
  assumes two people.

The tools exist for one reason: to turn a video into things a campaign needs — a catalog, a
transcript, a smaller copy, a re-stitched copy, a landing — fast, and to keep track of which of
them are done. Every screen is judged by that.

### Journey A — the performer turns an attached video into its deliverables

| Step                                  | Today (observed)                                                                                | Target                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Make the catalog                      | From the attachment's menu, over the task. Works.                                               | Same, one labelled action on the attachment        |
| Transcribe it                         | Not offered on a task. Close the task, find the video in Files, transcribe, reopen the task.    | One action on the attachment; the task stays open  |
| Compress / process it                 | Not offered on a task (`compress` has no handler anywhere; `process` only in Files and search). | One action on the attachment; the task stays open  |
| Put the result on the task            | Nothing does. Reopen the task → attach picker → search for the file that was just made.         | Automatic; the result appears under its source     |
| Settings missing (catalog, re-stitch) | The link closes the task and opens settings in Files.                                           | Settings open over the task; closing returns to it |
| Look at the file in its folder        | "Show in folder" closes the task; Back reopens it.                                              | Files opens with a visible way back to this task   |
| A transcript attached to the task     | Cannot be copied or edited from the task.                                                       | Copy text and edit text on the attachment          |
| A download that needs the local app   | Generic "action failed".                                                                        | Says so, and offers the local app's download       |

**Moves to take a video to catalog + transcript + compressed copy, all on the task:** today at
least 14 with three section changes; target **3 actions, zero section changes**.

### Journey B — the lead hands work over

| Step                                        | Today (observed)                                                                                        | Target                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| New task from a file in Files               | "Create task" switches to Tasks and opens the editor. Works.                                            | Same                                                                            |
| Add a file in Files to an **existing** task | Not possible from Files. Go to Tasks, open the task, attach picker, find the file.                      | "Add to task…" on the file and on the selection; stays in Files; toast opens it |
| Write the brief                             | Title, then status, assignee, a maximum, a slider, then a 12-row description; materials below the fold. | Title and brief first, materials in view, the numbers compact                   |
| Delete a task                               | A red button in the middle of the form.                                                                 | In the editor's own menu, with Undo                                             |

### Journey C — the solo buyer

| Step                     | Today (observed)                                                            | Target                                                                            |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Capture a to-do          | "Create task" makes an "Untitled" task and opens a full editor.             | Type the title in the board and press Enter; open it only if there is more to say |
| Assignee, invite prompts | Always shown: "Not assigned", "Invite someone", assignee filter.            | Absent while the space has one member; they appear with the second                |
| Leave an owned space     | Told to transfer ownership to "a member in the list above" — a list of one. | Told to invite someone first (fixed in this pass)                                 |

### Journey D — finding and acting, anywhere

| Step                                   | Today (observed)                                                                                    | Target                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Browse a folder with nothing selected  | A third of the width is a card saying "choose a file to see it here"; the list cuts its own column. | The list takes the width; the detail pane appears with a selection |
| Read the folder tree                   | Every folder icon on a line of its own above its name (fixed in this pass).                         | One line per folder                                                |
| Read the header over the hexagon field | Links with no ground vanish over a lit cell (fixed in this pass).                                   | Everything in the header on its own ground                         |
| Open the trash from Tasks              | Drawn under the board; its back button dead (fixed in this pass).                                   | The trash stands in for the section and returns to it              |

---

### User Story 10 - The performer's loop closes inside the task (Priority: P1)

Every deliverable the product can make from a video can be made from that video's attachment on
a task, over the task, and what is made comes back onto the task on its own.

**Why this priority**: It is the owner's example taken to its end. Making the catalog from the
task was the first half; the second half is that nothing made from a task's video should need
finding again.

**Independent Test**: On a task with a video, make its catalog, start its transcript and its
compressed copy from the attachment, and — without closing the task — see all three appear on
the task under the video.

**Acceptance Scenarios**:

1. **Given** a video attached to a task, **When** its actions are opened, **Then** "Make" offers
   the catalog, the transcript and processing (compress and the other tools), each running over
   the task.
2. **Given** a transcript or a processed copy started from a task's attachment, **When** it
   finishes, **Then** the output is attached to that task automatically, shown under its source,
   and a toast says so with a way to take it off.
3. **Given** a catalog made from a task's attachment, **When** it exists, **Then** the attachment
   shows it as a companion with Open and Copy link.
4. **Given** missing catalog or re-stitch settings, **When** the fix is followed from inside the
   task, **Then** the settings open over the task and closing them returns to the task.
5. **Given** "Show in folder" from a task, **When** Files opens, **Then** a return chip names the
   task and goes back to it in one press.
6. **Given** a transcript attached to a task, **When** its actions are opened, **Then** Copy text
   and Edit text are there.
7. **Given** a download that the browser cannot take, **When** it is pressed, **Then** the reason
   is said in words, and the local app's download is offered where it is available.

---

### User Story 11 - The lead hands work over in one motion (Priority: P1)

A lead working in Files can put a file — or everything selected — onto an existing task without
leaving Files, and a new task opens as a brief rather than a form.

**Why this priority**: Handing over is the other half of every task. Today the only way to add a
file to an existing task starts somewhere else.

**Independent Test**: Select three files in Files, add them to an existing task, stay in Files,
and open that task from the toast.

**Acceptance Scenarios**:

1. **Given** a file or a selection in Files or search, **When** "Add to task…" is chosen,
   **Then** a picker lists tasks by name with search, most recent first, and adding keeps you
   where you are.
2. **Given** the add succeeded, **When** the toast shows, **Then** it names the task and opens it
   on press.
3. **Given** a file already on that task, **When** it is added again, **Then** the toast says it
   was already there rather than failing.

---

### User Story 12 - A task reads as a brief, not a form (Priority: P1)

The editor puts first what a task is for: its title and its brief, then the materials it is about.
Numbers, dates and people sit in one compact line; the destructive action is in a menu; nothing
wraps into letters.

**Why this priority**: The beta walk found the editor squeezed: the status control broken into
vertical letters, two columns crammed into a dialog too narrow for them, the materials heading
wrapping mid-word, a red delete button in the middle of the form, and the materials below a
twelve-row text box.

**Independent Test**: Open a task at 1440 px and at 390 px, in both themes; read title, status,
assignee, date, brief and materials without scrolling at 1440 px, and find no control whose text
wraps inside itself.

**Acceptance Scenarios**:

1. **Given** the editor on a wide screen, **When** it opens, **Then** the brief is on the left and
   the work — materials, accounts, tags — is on the right, each column wide enough for its content.
2. **Given** the editor narrower than both columns need, **When** it opens, **Then** it is one
   column with materials directly after the brief — decided by the editor's own width, not the
   window's.
3. **Given** the status control, **When** it has less room than its labels need, **Then** it
   becomes a select, and never breaks a word.
4. **Given** the brief, **When** it is short, **Then** the field is short, and it grows as it is
   written.
5. **Given** the maximum and the progress, **When** they are shown, **Then** they are one compact
   row.
6. **Given** deleting a task, **When** it is wanted, **Then** it is in the editor's menu and
   confirms, naming what goes.

---

### User Story 13 - Solo is not a smaller team (Priority: P2)

A space with one member shows no team ceremony, and a to-do is captured by typing its title.

**Why this priority**: The solo buyer is the most common person in the product today and pays for
every control that assumes a second one.

**Independent Test**: In a one-member space, add three tasks from the board by typing and pressing
Enter, open one, and find no assignee, invite or assignee-filter control anywhere.

**Acceptance Scenarios**:

1. **Given** a one-member space, **When** the board and the editor are shown, **Then** the
   assignee control, the invite prompt and the assignee filter are absent.
2. **Given** a second member joins, **When** the board is shown, **Then** they appear, without a
   reload.
3. **Given** the board, **When** a title is typed into its quick-add field and Enter pressed,
   **Then** the task is created in place and focus stays in the field for the next one.

---

### User Story 14 - Calm at rest (Priority: P1)

A screen at rest shows what it is for. Detail appears with a selection, secondary information on
request, and a state with nothing in it shows one invitation instead of empty controls.

**Why this priority**: It is the owner's "no chaos" asked of every screen, and the beta walk found
it broken in the places people spend the most time.

**Independent Test**: Open Files with nothing selected, Accounts with no accounts, and the header
over a lit hexagon; count primary buttons, empty controls and unreadable text — all zero.

**Acceptance Scenarios**:

1. **Given** Files with nothing selected, **When** it is shown, **Then** there is no detail pane,
   and the listing takes its width; selecting a file brings the pane in.
2. **Given** any section with no data at all, **When** it is shown, **Then** its toolbar filters
   and zero counts are not, and exactly one primary action invites the first item.
3. **Given** a row, **When** it carries a secondary fact ("opens in Google Drive"), **Then** the
   fact is an icon with its text on hover and focus, not a second line under the row.
4. **Given** folder tiles in the grid, **When** they are shown, **Then** they are compact and do
   not repeat "Folder" under a folder icon.
5. **Given** anything drawn over the hexagon field, **When** it is read, **Then** it sits on its
   own ground.
6. **Given** the header, **When** nothing needs attention, **Then** it shows the space, the
   sections and one "Space" menu (trash, catalog updater, settings, shortcuts) beside a visible
   search trigger for the palette — and a status chip appears only when storage, the updater, a
   batch or the connection has something to say.
7. **Given** any one screen, **When** the same action is reachable twice on it (share beside
   "…", transcribe as a button and in the menu, a heading repeated by its only child), **Then**
   one of the two is gone.

#### What each screen shows at rest

Measured by a read of every surface (counts assume an owner, a ready space, a wide window).
"At rest" is what is on screen before anything is selected, hovered or opened.

| Surface          | Today at rest                                                                                      | At rest after                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Header           | eyebrow repeating the title, storage chip, three links, four tabs; wraps                           | space switcher, four tabs, palette trigger, "Space" menu; chips only when they report something                     |
| Files toolbar    | Search, Add files, Process — three equal secondaries, no primary; view toggle icon-only            | Add files primary; Search and Process quieter; view toggle labelled in its tooltip                                  |
| Files row / tile | ~10 elements, a Share icon beside a "…" that also shares, "opens in Google Drive" on a second line | name, kind icon, size, date, tag dot, "…" — the Drive note as an icon; folders compact, no "Folder" caption         |
| Files pane       | a third of the width saying "choose a file"                                                        | absent until a selection                                                                                            |
| Board            | ~13 controls above the cards; active filters stated three times; icon-only progress toggle         | quick-add, search, one Filters button whose chips are the only statement of what is active; status as one segmented |
| Board, empty     | two primary "Create task" buttons                                                                  | one                                                                                                                 |
| Task editor      | ~17 controls; delete mid-form; hint paragraph; icon-only save-default; 5 icons per attachment tile | brief, compact numbers line, materials in view; delete in the menu; 2 inline actions + "…" per tile                 |
| Accounts, empty  | two primary "Add account" buttons over zero-count filters                                          | one invitation, no filters                                                                                          |
| Accounts row     | 12+ controls, captions "Balance / Top-up" on every row under a "Money" header                      | identity, state, run, money, one primary action, "…"; captions once, in the header                                  |
| Members          | "Members" heading twice; three bordered buttons per member                                         | one heading; Edit + "…" (remove, transfer)                                                                          |
| Detail pane      | 4 inline icons + "…" + a second Transcribe button                                                  | one transcribe, companions with their own actions, 3 inline + "…"                                                   |
| Updater          | 4 icon buttons per row; four facts per meta line; three notes in the footer                        | "…" per row; two facts; notes behind one hint                                                                       |

---

### Edge Cases

- **A result lands after the task was closed.** It is still attached: the link between a run and
  its task belongs to the space's queue, not to the editor that started it.
- **A result lands after its task was deleted.** It stays where it was written and nothing is
  attached; no error is raised for a task nobody can see.
- **The same run is attached twice** (a reload during finalize). Attaching is idempotent; the
  second attempt reports "already attached" silently.
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

## Requirements _(mandatory)_

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

### Functional Requirements — the performer's loop (US10)

- **FR-076**: A task attachment MUST offer every "Make" action that applies to its material —
  product catalog, transcript, process (compress and the other tools) — and each MUST run over
  the task without closing it.
- **FR-077**: The local agent's queue MUST belong to the space, not to Files, so a run started
  from a task survives the task closing and a section change.
- **FR-078**: A run started from a task's attachment MUST carry that task, and on completion its
  output material MUST be attached to the task — idempotently, silently on "already attached",
  and not at all if the task is gone — with a toast offering to take it off.
- **FR-079**: The settings a "Make" action needs MUST open over the surface it was started from,
  and closing them MUST return there.
- **FR-080**: "Show in folder" from a task MUST leave a return affordance in Files naming the task.
- **FR-081**: A transcript attachment MUST offer Copy text and Edit text.
- **FR-082**: A download refused to the browser MUST say why in words and, where the local app can
  take it, offer that.

### Functional Requirements — handing over (US11)

- **FR-083**: "Add to task…" MUST exist for a material and for a selection, in Files and in
  search, and MUST NOT change section.
- **FR-084**: The task picker MUST search by name, list the most recently changed first, and
  report "already attached" as information, not as failure.

### Functional Requirements — the editor as a brief (US12)

- **FR-085**: The editor MUST lay out by its own width: two columns (brief | work) when both fit,
  one column with materials straight after the brief when they do not.
- **FR-086**: No control's label MUST wrap inside the control; a segmented control without room
  MUST become a select.
- **FR-087**: The brief field MUST size to its content.
- **FR-088**: Deleting a task MUST live in the editor's menu and MUST confirm with a verb naming
  the consequence. (Undo was specified and withdrawn: a task cannot be re-created with its
  attachments, accounts and progress, and 021 finding R3 already chose a confirmation over an undo
  that silently restores less.)

### Functional Requirements — solo (US13)

- **FR-089**: While a space has one member, the board's assignee filter MUST be absent, and MUST
  appear live when a second member arrives. (Revised by the owner: the editor's assignee field
  stays in a space of one — hidden, it read as lost, and it is where the second person is invited.)
- **FR-090**: The board MUST offer a quick-add field that creates a task from its title on Enter
  and keeps focus for the next.

### Functional Requirements — calm at rest (US14)

- **FR-091**: Files MUST NOT reserve space for the detail pane while nothing is selected.
- **FR-092**: A section with no data MUST show its empty state alone — no filters, no zero counts,
  one primary action.
- **FR-093**: The same action MUST NOT be reachable twice from one screen at rest.
- **FR-094**: The header MUST show status chips only while they report something that is not the
  healthy default, and MUST collect the space's utilities in one menu beside a visible palette
  trigger.
- **FR-095**: A secondary fact about a row MUST be an icon with its words on hover and focus, not
  a second line.
- **FR-096**: A caption that repeats a column header or a heading MUST be removed.
- **FR-097**: A destructive or rarely used row action MUST live in the row's menu, not as a
  bordered button on every row.

### Functional Requirements — catalog variations (US15)

The owner runs one video on several ad accounts, each with its own tracking link, so one video
needs several catalogs. On Meta each catalog is named after the video — `IN 40_v1_catalog` — so
the name must be the same in the sheet, in the product and on Meta, and copying it must be one
press. Variations must not pile up: removing one is one action and leaves nothing behind.

- **FR-098**: A video MUST be able to hold any number of live product catalogs ("variations").
  Creating one never replaces or refuses because of another.
- **FR-099**: A catalog sheet MUST be named `<video name without extension>_v<N>_catalog`, where N
  is the variation's number. N is the next number after the highest this video ever used, so a
  removed `v2` is never handed out again (its name may still be live on Meta). A catalog made
  before variations existed is variation 1 and keeps its name until it is re-created.
- **FR-100**: Re-creating a variation MUST keep its number and replace only that variation.
- **FR-101**: A video's catalogs MUST open as one list — name, product count, the link's host —
  where each row copies its name, copies its link and opens the sheet in one press, and keeps
  re-create and remove in its menu. "New variation" is on the same screen and prefills the
  product count of the last one.
- **FR-102**: Removing a variation MUST move its sheet to the trash (restorable from the trash,
  where it comes back as the same variation) and take it off the list at once.
- **FR-103**: After a catalog is created, the result MUST show its name with a copy button beside
  it, next to copy link and open.
- **FR-104**: From a task's video, "Catalog" MUST be one press on the tile: with no catalog it opens
  the form; with catalogs it opens the list — without leaving the task.
- **FR-105**: Renaming, moving or trashing a video MUST carry every variation along, each renamed
  to the new name with its own number.
- **FR-106**: The catalog updater MUST name each row by its catalog's name, so two variations of
  one video are two distinguishable rows.

### Functional Requirements — the catalog updater per catalog (US16)

- **FR-107**: Each catalog MUST carry its own update interval (every hour, day, week, or N hours up
  to 720) or be off; choosing it saves it, with no separate Start, Save or Stop.
- **FR-108**: Every catalog row MUST offer "Update now", which opens an update this minute whether
  or not the catalog is scheduled, and a scheduled catalog's next run moves one interval from then.
- **FR-109**: A row MUST say when its catalog updates next, and that an update is under way.
- **FR-110**: Ticking catalogs MUST offer the same two controls — interval and update now — for all
  of them at once.

### Functional Requirements — a note on a file (US17)

- **FR-111**: Every file MUST be able to carry a note of up to 4000 characters, line breaks kept,
  stored as Soty's own metadata beside GEO, language, offer and tags. Nothing is written to Google
  Drive, so a note never changes the file's version, its transcript or an in-flight download.
- **FR-112**: The details card MUST show the note under the file's facts and let someone with
  `manage_metadata` edit it in place (⌘↵ saves, Esc cancels); with no note it offers "Add a note",
  and to someone who may not write one it shows nothing.
- **FR-113**: "Note" MUST be an action in the registry, so every file menu — row, search result,
  task attachment — opens the same editor, read-only for whoever may only view.
- **FR-114**: Search MUST find a file by a word of its note, and the result MUST show the note.
- **FR-115**: A file downloaded through Soty carries no note and no other Soty metadata, silently.

### Functional Requirements — a space, not a team (US18)

- **FR-116**: The product MUST call the object a space in every string, in both languages; "team" /
  «команда» appear nowhere in the interface, the invitation email included. The glossary test
  enforces it over every key.
- **FR-117**: A space MUST be renamable by its owner from the space's settings; names stay unique
  among the owner's spaces.
- **FR-118**: Creating a space MUST offer a suggested name, so the first step is one press; a
  suggested name left as it was becomes the chosen folder's name once the folder is connected.
- **FR-119**: The `/team` address stays until Google's brand verification completes; moving it to
  `/space` with redirects is deferred, because page addresses are frozen during verification.

### Functional Requirements — the audit round (US19)

- **FR-120**: One attached file MUST count once; a draft tile gives way to the saved row.
- **FR-121**: Every place a file is chosen or shown beside same-named files (⌘K, the task file
  picker, a task's attachment tile) MUST say its folder path; the picker opens in the folder of
  the task's files.
- **FR-122**: ⌘K MUST focus its field on open and offer recently opened tasks, files, folders and
  accounts on an empty field.
- **FR-123**: Creating a task from files MUST keep the person in Files, with a toast to open the
  task; "Back to the task" MUST survive folder moves.
- **FR-124**: The history MUST record task creation, status and assignee changes, attached files
  and agents, and launches added or removed.
- **FR-125**: The history MUST be a panel from the Space menu: day groups, one line per event,
  badges only for problems, folded repeats, area filters and Mine, and paging.
- **FR-126**: Launching on an agent from a task MUST be one clearly named action that moves a
  to-do task into progress; today's runs show their time; an agent counts only open tasks.
- **FR-127**: The catalog form MUST show the name the catalog will have, with a copy, before it
  is made; a file's card MUST list the tasks it is on.

### Functional Requirements — catalog pools (US20)

- **FR-128**: A space's catalog pictures MUST be chosen from the space — single images and folders
  (subfolders included) — and each catalog row MUST get its own picture, shared by link and
  written as a direct image URL.
- **FR-129**: A space MUST keep a pool of product names (4–6 words) and descriptions (10–100 words),
  generated in English for clothing only (the settings say so), listable, editable field by field,
  and regenerable after a confirmation; up to 1000.
- **FR-130**: Each row's price MUST be a random whole dollar amount in the space's range (9–30 by
  default).
- **FR-131**: Pictures and texts MUST be drawn without repeats until the pool is spent, then from
  all again, across catalogs and updates.
- **FR-132**: The catalog updater MUST offer "Refresh the pictures at every update", on by default.
- **FR-133**: The single title, description and picture link MUST remain as optional fallbacks for
  an empty pool.

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

## Success Criteria _(mandatory)_

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
- **SC-015**: Taking a task's video to catalog + transcript + processed copy, all attached to the
  task, takes **3 actions and zero section changes** (today: 14+ moves, three section changes).
- **SC-016**: Adding a file in Files to an existing task takes **2 actions** and leaves you in Files
  (today: impossible from Files).
- **SC-017**: A solo space shows **zero** assignee or invite controls on the board and the editor.
- **SC-018**: Every surface in the "at rest" table carries **at most one primary action** and **no
  action reachable twice**, checked by a test over the rendered surfaces.
- **SC-019**: At 1440 px the editor shows title, status, assignee, date, brief and the first row of
  materials **without scrolling**; at 390 px **no control label wraps inside its control**.

- **SC-020**: A second catalog for the same video, with a different link, takes **3 actions** from
  a task (Catalog → New variation → Create) and its name is on the clipboard in **1 more**.
- **SC-021**: A note is added to a selected file in **2 actions** (Add a note → type → ⌘↵) and is
  visible in the card and in search without a reload.

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
