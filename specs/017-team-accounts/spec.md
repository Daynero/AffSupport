# Feature Specification: Team Accounts

**Feature Branch**: `011-team-workspace-rework` (delivered on the rework branch; own spec number 017)

**Created**: 2026-09-05

**Status**: Implemented (parts 1 and 2)

**Input**: User description: "будемо покращувати командний режим, візуал весь на тобі, орієнтуйся на компресор мені там дизайн подобається, а так загалом роби зручно і гарно, не перегружено чисто але зрозуміло, крч ти краще знаєш як. що до функціоналу, я хочу вкладку нову Аккаунти, там хочу функціональну табличку для моніторінгу поточних запусків, заміток і прочого. як я бачу як буду нею користуватись. там можна створити аккаунт(це по факту соціальні акки до яких будуть привʼязані агенти) фактично це просто поле з назвою, наприклад я називаю його v31 в середену я кладу агенти, заносити я хочу повний айді, але відображатись мають тільки останні 3 цифри. але якщо захочу копіювати то повний копіюється. і буде така вже вкладеність а біля кожного агента буде ще полевоно або порожнє, і тоді агент підсвічується трохи зеленим типу він порожній(нема запусків на ньому) або ніяк якщо там прописан якийсь запуск, наприклад Pro Caps | TR 02/09. там є фільтра щоб побачити тільки порожні аккаунти(тоді заповнені просто зникають) або навпаки подивитись тільки запущені. все стильно, зручно редагувати, не вибивається з общого дизайну. а тепер трохи контекста на майбутнє щоб ти закладав коли будеш створювати ці спписки. всі введені аккаунти будуть формувати теги, які ми потім добавимо в таски, в тасках буде щось типу добавити аккаунт, фільтр чи всі чи порожні, обираєш назву типу v31 далі обираєш акк наприклад 434 і він в таску вішає тег [v31-434]."

## Overview

A fourth destination in a space, beside Explorer, Tasks and Members: **Accounts**.
It is the board a media buyer keeps of the social accounts the space runs from
and the agents inside each one — which agent is free, and what is running on
the rest. One row per agent; the free ones washed green; a run written in
place and cleared in one press.

The shape is deliberately the one the compressor and the 2FA wallet already
use: a `team-panel` with an eyebrow and a primary action; a toolbar row that
holds search on the left and pill filters on the right; a framed list with
quiet row actions that come up on hover; an inline editor that keeps the row's
height. Nothing here invents a control the product does not already have.

## Decisions taken without asking (and why)

| Decision                                                                 | Why                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two tables (`team_accounts`, `team_account_agents`), select-only RLS, writes behind RPCs | The exact shape of `team_tasks` / `team_task_attachments`; a child row anchored on `(account_id, team_id)` cannot drift into another space. |
| An agent carries any number of *runs* (`team_agent_runs`); "free" = no runs | The first model was one note per agent; in use an agent carries several launches at once (owner: "тут може бути не один запуск"). Runs are rows with their own pencil, bin and plus; the note column was migrated into first runs and dropped. |
| Account names unique per space, case-insensitively                       | The tag a task will carry, `[v31-434]`, must resolve to exactly one account; `V31` and `v31` are the same thing to the people typing them.                    |
| Brackets refused in names                                                | They would break the tag's own delimiters.                                                                                                                    |
| Agent id is a single token (no inner whitespace), ≤ 64 chars             | Two things pasted are two things; the list should refuse rather than silently join them.                                                                       |
| An agent is shown as `v31-434` — the account's name and the last three characters of the id — everywhere: the accounts list, the picker, and the tags on tasks; a press copies the full id | Asked for verbatim (three characters, full copy). The bare tail `…434` was dropped after the owner tried it: with a social account named by digits, nothing said which was which. The owner then asked for no brackets ("просто v3-287", and none once a tag is chosen), so the bracketed form `[v31-434]` remains only as the shared text form for pasting outside the app. |
| One card per social account — an icon and the name, nothing more; agents under column captions (Agent / Run / Tasks) | The owner found the flat list "dumped in a pile": the card is the boundary and the columns line the rows up. A "Social account" caption was tried and removed on the owner's word: the icon says it. |
| "Free" filter drops accounts with no free agents (and "Running" mirrors); an account with no agents at all stays under "Free" | Asked for verbatim: the question is "where can I start", and an account with nowhere to start is noise — but an empty account is the emptiest place there is. |
| The green wash is a rail and a tint, nothing else                          | Asked for "трохи зеленим"; a pill beside it said the same thing twice and cost a column.                                                                        |
| One editor at a time; a switch over unsaved typing is refused with a hint  | Silently discarding a half-typed run is the one loss this list must not inflict; Enter/Escape are one key away.                                                |
| Freeing an agent (clearing every run) and deleting one run both get Undo   | One press each, and the text erased is not on screen to retype.                                                                                                |
| Hovering an agent chip shows the account, the full id and the runs         | Asked for verbatim ("при наведенні пиши повну назву і повний айді").                                                                                           |
| Card and account surfaces are layered like the compressor's settings panel: violet-tinted head on a violet outline, rows on a lighter surface, amber dot for running, green for free | The owner found the first dark version monolithic ("монолітні кольори складно розрізняти"); the compressor's panel was the named reference. |
| Chip counts follow the search                                              | The chips answer "how many of these are free"; a total for rows not on screen is a different question.                                                        |
| Pressing the run cell edits only the run; the pencil edits both fields   | Writing down what started is the reason the list is opened; it should not cost a trip through the id field.                                                   |
| An eraser action frees a busy agent in one press                          | The second most common thing after writing a run is ending it.                                                                                                 |
| Naming an account opens its first agent editor immediately; saving an agent reopens an empty editor | The next thing after naming an account is always putting an agent in it, and agents go in several at a time; Escape is the way to stop.        |
| The account being edited stays on screen whatever the filter says         | Under "Free", an account named a moment ago has no agents and would vanish before its first one could be typed.                                              |
| Delete confirms for both accounts and agents                              | The 2FA wallet confirms; an account takes its agents with it, and an agent's id is not on screen to re-type.                                                   |
| Filters live in component state, not the URL                             | Same precedent as the task status filter; a share link to "the free ones" is not a use anyone described.                                                        |
| Fold state per account is a browser convenience (`localStorage`)          | Not data: a missing value means "all open".                                                                                                                    |
| No audit rows for account/agent changes                                   | These are working notes, not lifecycle events of the space; extending the audit key whitelist for them would be ceremony without a reader.                     |
| No paging                                                                 | Tens of accounts, a few agents each; one round trip returns everything nested.                                                                                 |
| Realtime on both tables, own channel, 300 ms coalescing                   | Same as tasks. A teammate marking a run should appear without a refresh.                                                                                      |
| Account names may contain spaces; the tag is then `[Main BM-117]`           | The tag is a label people read, not a token anything parses; forcing `Main_BM` would make the list uglier to fix a problem tasks do not have.                  |
| Row buttons carry the agent's tail in their accessible name (`Delete agent …434`) | Eight rows of identically named buttons are eight identical announcements to a screen reader.                                                                  |
| Closing an editor hands focus back to what opened it                      | Focus dropped on the page after every Enter is how keyboard users lose their place in a list.                                                                   |
| `teamAccountTag(name, id)` lives in the shared contract now               | The user said tags come next, in tasks; building the tag in one place means the two surfaces cannot disagree about its shape.                                   |

## User Scenarios & Testing

### User Story 1 — See what is free (Priority: P1)

A buyer opens Accounts and presses **Free**. Every account that has no free
agent disappears; the ones that do show only their free agents, washed green.
The counts on the chips say how many agents are free, running, and in all.

**Acceptance**: with `v31` (one busy, one free), `v3` (one busy) and `v12`
(empty), pressing Free leaves only `v31` with one row; pressing Running leaves
`v3` and `v31` with one row each.

### User Story 2 — Write down a run (Priority: P1)

A buyer presses the run cell of a free agent, types `Keto | PL 05/09`, presses
Enter. The row loses its green wash and shows the run. Later, one press on the
eraser frees it again and a toast says which agent is free.

### User Story 3 — Put an account and its agents in (Priority: P2)

**Add account** opens a name row at the top of the list. Enter saves and opens
the agent editor inside the new account with the caret in the id field. A
duplicate name is explained in the row without losing the typing. An id with a
space is refused before the server is asked.

### User Story 4 — Hand an id over (Priority: P2)

Pressing the id tail copies the full id; the mark on the button turns into a
check for a moment. If the clipboard refuses, the full id is revealed in place
and a toast says so, so it can still be selected by hand.

### User Story 5 — A viewer looks, an editor acts (Priority: P3)

A viewer sees the list and can copy ids; every control that writes is absent,
and the server refuses writes from a viewer regardless.

## Requirements

- **FR-001** Accounts is a section of a space at `/team/<id>/accounts`, a tab beside Tasks.
- **FR-002** An account has a name (1–40 chars, no brackets), unique per space case-insensitively.
- **FR-003** An agent has a full id (1–64 chars, single token) unique within its account, and an optional run note (≤ 120 chars); a blank note is no note.
- **FR-004** The list shows the last three characters of an id; a press copies the whole id.
- **FR-005** A free agent (null note) is visibly marked; a running one is plain.
- **FR-006** Filters: All / Free / Running, with counts; Free and Running drop accounts with nothing to show.
- **FR-007** Search matches account name (keeps all agents) or agent id / run (keeps matching agents).
- **FR-008** Inline editing for account names and agents; Enter saves, Escape cancels; errors are named in the row.
- **FR-009** Viewers read; editors write; the server enforces both through `private.can`.
- **FR-010** Changes by teammates appear live.

## Contracts

- Migration: `supabase/migrations/20260905100000_team_accounts.sql` (rollback note in `ROLLBACK.md`).
- RPCs: `list_team_accounts`, `create_team_account`, `rename_team_account`, `delete_team_account`, `add_team_account_agent`, `update_team_account_agent`, `delete_team_account_agent`.
- Shared: `packages/shared/src/team/accounts.ts` — normalizers, parsers, `teamAgentIdSuffix`, `teamAccountTag`, `filterTeamAccounts`, `countTeamAccounts`, `sortTeamAccounts`.
- Web: `apps/web/src/team/accounts/` (`AccountSpace`, `AccountGroup`, `AgentRow`, `useAccounts`), styles in `apps/web/src/styles/team-accounts.css`.
- Tests: `tests/team-accounts-contract.test.ts`, `tests/team-accounts-sql.test.ts` (PGlite, every migration applied), `tests/team-accounts.test.tsx`.

## Part 2 — Accounts inside tasks (2026-09-05)

**Input**: "Давай продумуй щоб в тасках це вже було інтегровано зручно."

A task carries zero or more agents as tags — `[v31-434]` — and the tag shows,
live, whether that agent is free. From the task you pick the account and then
the agents (with a Free/All switch), write the run onto an agent (prefilled
with the task's title), free it, or take the tag off. The task list narrows to
one account or one agent from a pill in the filter row, and the Accounts tab
links into that narrowed list ("2 tasks" on an agent row, on an account head).

### Decisions

| Decision                                                              | Why                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A link table (`team_task_agents`); the tag text is derived at read time | A rename follows everywhere; deleting an agent removes its tag from every task (cascade). No snapshot to go stale.                                     |
| Tags are written at once, not staged with the form                    | A tag is a fact about the task, like its status (also immediate); staging it with the title would make "mark the run" wait for Save.                     |
| Writing a run from a task is a press, never automatic                 | Asked for verbatim: tasks are also edits and re-cuts; only the person closing one knows it was a launch. The title is the prefill, not the decision.     |
| The picker is the attachment picker's dialog, stripped to one title line with the Free/All switch, a thin "← Accounts / v3" crumb inside an account, rows, one primary button | The owner found the first version wordy ("забагато води"): the eyebrow, the hint and the framed path row went. |
| The task card is one strip of chrome (status · account chips · date), a thin scale, then the task: title and the brief in full colour, clamped to seven lines with a measured "More" that unfolds it in place; footer with attachments and assignee | The owner asked to see more of the task itself. The board is used for three things — glance (what runs where, how far, since when), read the brief without opening it, nudge (status, scale) — and the old card spent three rows of chrome before a four-line muted brief. Chips past the second fold into "+N". |
| In the editor the Accounts row sits directly under the status row          | Asked for verbatim ("акаунт перемісти під статуси"): what the task is on comes before what it is called.                                                        |
| `list_team_tasks` gained `p_agent` / `p_account` and an `agents` column | One round trip for the list with its tags; the scope filters server-side like status does, so a large space is not downloaded to hide most of it.      |
| The scope lives in the address (`?agent=`, `?account=`)               | It is how the Accounts tab links into the list, and Back widens it again; agent wins over account when both are present.                                 |
| `list_team_accounts` reports `task_count` per agent                   | The Accounts tab shows "2 tasks" and links; the account head sums them.                                                                                  |
| Tagging twice is idempotent (`on conflict do nothing`)                | A double press, or two people pressing, is not an error anyone should read.                                                                              |
| Removing a tag from a task leaves the agent's run as it is             | The run is the agent's fact, written on purpose; untagging a task says the task is no longer about that agent, not that the launch ended. Freeing is its own press. |
| Tagging does not bump the task's `updated_at`                         | It is not part of the form's optimistic-concurrency check, so a tag and a retitle by two people do not collide.                                          |

### Contracts (part 2)

- Migrations: `supabase/migrations/20260905120000_team_task_agents.sql`, `20260905140000_team_agent_runs.sql` (runs as rows; `note` dropped).
- RPCs (runs): `add_team_agent_run`, `update_team_agent_run`, `delete_team_agent_run`, `clear_team_agent_runs`; `add_team_account_agent` / `update_team_account_agent` return the agent as JSON with its runs.
- RPCs: `attach_team_task_agent`, `detach_team_task_agent`; `list_team_tasks(…, p_agent, p_account)` now returns `agents jsonb`; `get_team_task` carries `agents`; `list_team_accounts` carries `task_count`.
- Shared: `TeamTaskAgentTag`, `parseTeamTaskAgentTags`, `teamTaskAgentTagLabel`; `TeamTaskSummary.agents`; `TeamAccountAgentSummary.taskCount`.
- Web: `apps/web/src/team/tasks/{TaskAgentTags,TaskAccountPicker,TaskAccountFilter}.tsx`; `useTasks` scope; routes `agentId` / `accountId`.
- Tests: `tests/team-task-accounts.test.tsx`, additions in `tests/team-accounts-sql.test.ts`, `tests/team-accounts-contract.test.ts`, `tests/team-routes.test.ts`.

## Out of scope (next)

- Marking a run automatically when a task is done — deliberately not (see decisions above).
- A tag on a task that survives its agent's deletion (a snapshot): not wanted; the tag is the agent.
