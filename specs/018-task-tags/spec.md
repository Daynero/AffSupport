# Feature Specification: Task Tags

**Feature Branch**: `011-team-workspace-rework` (delivered on the rework branch; own spec number 018)

**Created**: 2026-09-06

**Status**: Implemented

**Input**: User description: "в тасках треба розробити теги, які можна навіщувати і сортувати по ним. в налаштуваннях командного режима зроби вкладку з тегами і там можна було створювати і видаляти теги. а в тасках їх можна вішати і потім фільтрувати і сортувати по тегам теж щоб можна було."

## Overview

A space keeps a small dictionary of **tags** — "UGC", "Hot", "Needs review" —
made in its settings, hung on tasks from the task itself, and used by the board
to filter and to order.

Three surfaces, one object:

- **Settings → Tags.** The dictionary: a name and a colour each, how many tasks
  carry it, a pencil and a bin. This is the only place a tag is created or
  deleted.
- **The task editor.** A row of chips with a × each and one "+ Tag" that opens
  the dictionary. A tag is written the moment it is pressed.
- **The board.** A tag filter pill beside the dates, accounts and statuses, and
  a two-press control that orders the cards by tag instead of by date.

Deliberately _not_ the agent tags of 017. Those are derived from an account and
an agent id and cannot be typed; these are free text a team invents for itself.
They share the chip's shape and nothing else — the colour is what tells them
apart at a glance, on a card that may carry both.

## Decisions taken without asking (and why)

| Decision                                                                                             | Why                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two tables (`team_task_labels`, `team_task_label_links`), select-only RLS, writes behind RPCs        | The exact shape of `team_accounts` / `team_task_agents`. A link anchored on `(id, team_id)` cannot drift into another space.                                                                                        |
| Named `labels` in the code, "tags" on screen                                                         | `team_task_agents` already holds the thing the interface calls an agent tag. One vocabulary per table is what keeps the two features from renaming each other's rows.                                               |
| A tag is a name **and** a colour, from a closed palette of nine                                      | A chip has one job — to be recognised across a board without being read. Free hex can produce an invisible chip, and a palette is a design decision that has to hold in both themes.                                |
| Creation lives only in settings; the picker cannot invent a tag                                      | Asked for verbatim. It is also what stops a dictionary holding "UGC", "ugc " and "UCG" — a picker that can type is a picker that will.                                                                              |
| Names unique per space, case-insensitively; up to 24 characters                                      | Two tags that read the same are one tag to the people pressing them. 24 is what still fits three chips across a card.                                                                                               |
| Sixty tags per space                                                                                 | Past that the tag is not what needs fixing. It also bounds the list every task read joins against.                                                                                                                  |
| Names are read live; nothing is snapshotted onto a task                                              | A rename must reach every card at once, exactly as an account rename does in 017.                                                                                                                                   |
| The filter keeps a task carrying **any** of the chosen tags                                          | The filter is opened to gather work ("everything hot or urgent"), not to intersect it. An "all of" filter is a second control answering a question nobody asked yet.                                                |
| Ordering by tag is server-side, with the untagged last                                               | A board ordered on the client lies the moment it pages: the fifty rows on screen are not the fifty the order would have chosen. The untagged sink because a board ordered by tag is opened to read the tagged work. |
| A task's tag for ordering is its first one in natural order                                          | `teamTaskLabelKey` in the shared contract and `private.team_task_label_key` in SQL are the same rule, so a page merged on the client cannot reshuffle itself against the server's page.                             |
| Tagging does not bump the task's `updated_at` and takes no part in its concurrency check             | Same as 017: two people can tag and retitle at once without one of them being told the task moved.                                                                                                                  |
| Tagging is idempotent                                                                                | A double press, or a second person's press, is not an error anyone should have to read.                                                                                                                             |
| Taking a tag off a task offers Undo; deleting a tag from the dictionary confirms first               | One press each way. The chip is not on screen to find again, and a delete reaches every task carrying it.                                                                                                           |
| The delete confirmation names the count ("comes off 4 tasks")                                        | "Are you sure?" is not information. The count is the only thing that makes the answer different for two different tags.                                                                                             |
| New tags are offered the colour the space uses least                                                 | A dictionary built by pressing Enter nine times should be nine colours, not nine purple ones.                                                                                                                       |
| The assignee filter names a person **or** "nobody yet", as two arguments rather than a sentinel uuid | A uuid cannot express "no one", and a magic id is a rule every later caller has to know. "Nobody yet" is a pile a stand-up is held over, not the absence of a filter.                                               |
| The board's progress scales can be put away with one eye, remembered per space in `localStorage`     | Some teams run on the scale and some never touch it; for the second kind it is a bar of colour under every title. Not data — a missing value means the scales are shown, as the board has always done.              |
| Filters and the order live in component state, not the URL                                           | Same precedent as the status filter and the account scope.                                                                                                                                                          |
| The tag filter and the order control appear only once the space has tags                             | A control that can only say "none" is a control in the way.                                                                                                                                                         |
| Realtime on both tables, folded into the existing task and dictionary channels                       | A teammate renaming a tag must reach everyone's board; a teammate tagging a task must move the count in settings.                                                                                                   |
| Row fields carry the row's name in their accessible name (`Name: Hot`)                               | Eight fields all called "Name" are eight identical announcements to a screen reader — the finding 017 recorded for its row buttons.                                                                                 |
| No audit rows for tag changes                                                                        | Working notes, not lifecycle events of the space — the same call 017 made for accounts.                                                                                                                             |

## User Scenarios

### User Story 1 — Make the dictionary (P1)

A space owner opens Settings → Tags, types "UGC", picks a colour, presses Add,
and repeats. The field empties and keeps its place; the next colour offered is
one the space has not used.

**Acceptance**: the tag appears in the list with "0 tasks" beside it; a second
tag named "ugc" is refused as a duplicate; a blank name is refused with a reason.

### User Story 2 — Hang tags on a task (P1)

Someone opens a task, presses "+ Tag", and presses two tags in the popover. The
chips appear on the task at once and on its card behind it. A × on a chip takes
it off, with an Undo in the toast.

**Acceptance**: each press writes immediately; closing the editor with Escape
keeps the tags; a viewer sees the chips and neither the × nor "+ Tag".

### User Story 3 — Find and group the tagged work (P1)

On the board, the tag pill narrows the list to "Hot" (or "Hot" and "UGC"
together), and "By tag" reorders what is left so each tag's cards sit together,
newest first inside each tag, with the untagged at the end.

**Acceptance**: the narrowed list is asked of the server, so "Load more" pages
inside the filter; the order pages without losing or repeating a task.

### User Story 4 — Retire a tag (P2)

A tag that stopped meaning anything is deleted in settings. The confirmation
says how many tasks it comes off. The tasks stay; only the tag goes.

**Acceptance**: after the delete the tag is gone from every card without a
reload, and no task is deleted with it.

## What was built

| Layer      | Where                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database   | `supabase/migrations/20260906200000_tasks_carry_tags.sql`                                                                                                     |
| Contract   | `packages/shared/src/team/task-labels.ts`, plus `labels` on `TeamTaskSummary` and `compareTeamTasksByLabel` in `tasks.ts`                                     |
| API client | `listTaskLabels`, `createTaskLabel`, `updateTaskLabel`, `deleteTaskLabel`, `attachTaskLabel`, `detachTaskLabel` in `api/team.ts`                              |
| Settings   | `team/labels/TaskLabelsSection.tsx`, `team/labels/useTaskLabels.ts`, a Tags tab in `SpaceSettings`                                                            |
| Chips      | `team/labels/TaskLabelChip.tsx`, `team/labels/TaskLabelMenu.tsx`                                                                                              |
| Tasks      | `team/tasks/TaskLabelsEditor.tsx`, `TaskLabelFilter.tsx`, `TaskSortControl.tsx`, `TaskAssigneeFilter.tsx`, and `labelIds` / `sort` / `assignee` in `useTasks` |
| Styles     | the tag palette in `styles.css`, the chips, popover and dictionary list in `styles/team-tasks.css`                                                            |
| Tests      | `tests/team-task-tags-sql.test.ts` (12), `tests/team-task-tags.test.tsx` (13)                                                                                 |
