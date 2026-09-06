# Feature Specification: Agent money, agent tags, and the copy-out

**Feature Branch**: `011-team-workspace-rework` (delivered on the rework branch; own spec number 019)

**Created**: 2026-09-06

**Status**: Implemented

**Input**: User description: "для агентів добав два поля правруч від завдань невеличкий інпут на 4 символи, крихітний підпис залишок грошей. і поряд праворуч інпут на 4 символи з підписом додати. але шоб +- були і по 50 добавляло. в самому низу таблиці було 2 кнопки скопіювати з назвами і скопіювати з ID. А ще додати тег агентів, в налаштуваннях тегів зробити як інший набір агенських тегів… Скопіювати з назвами формує стовбчик сортований по соцам… Якщо це копіювати з айді то тут сортування по тегам… І ще кнопка очистити всі гроші"

## Overview

One job, done end to end in the Accounts table: a media buyer walks the list,
writes what each agent has left and what to top it up with, and then copies the
day's top-ups out — twice, for two readers.

- **The money.** A `Money` column between the runs and the row's buttons: two
  four-character fields with tiny captions, _Left_ and _Add_. The top-up has −
  and + beside it and moves in fifties.
- **The agent tags.** A second set in the space's tag dictionary, made in
  Settings → Tags beside the task tags, hung on an agent next to its name.
- **The copy-out.** Under the list: _Copy with names_ (grouped by social
  account), _Copy with IDs_ (grouped by agent tag), and one eraser for each
  figure — _Clear the top-ups_ and _Clear what is left_ — both undoable. Both lists carry full ids under their headings — where the
  money is moved, an ad account is its id.

## Decisions taken without asking (and why)

| Decision                                                                                              | Why                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One dictionary with a `scope` (`team_task_labels` renamed to `team_labels`), not a second table       | The two sets are the same object — a name, a colour, a space, a case-insensitive unique name — and a second table would have meant a second copy of every function. Nothing had shipped against the old name.                                                                |
| A name may exist in both sets at once                                                                 | "Hot" on a task and "Hot" on an agent are different things a team may well want; uniqueness is per set.                                                                                                                                                                      |
| Sixty tags per set, not sixty in total                                                                | The sets are read in different places and neither should be able to crowd the other out.                                                                                                                                                                                     |
| A tag's set is fixed at birth — no moving between sets                                                | Moving one would take it off everything it is on: a delete wearing an edit's clothes.                                                                                                                                                                                        |
| Money is whole units in two `integer` columns, 0–9999                                                 | Four characters is the field the owner asked for; these figures are read at a glance and never computed with, so cents would be precision nobody types.                                                                                                                      |
| Both figures are written together, on blur or Enter                                                   | A write per keystroke is a round trip per digit. The pair is one small row, and "which of them changed" is not worth a patch grammar.                                                                                                                                        |
| ± steps by fifty and snaps to it: a typed 30 becomes 50, not 80                                       | The step is the unit a person tops up in; snapping is what makes two presses land on a round figure however the field was left.                                                                                                                                              |
| Empty steps up to 50, and 50 steps down to empty                                                      | The same gesture starts a top-up and takes it back, so nothing needs clearing by hand.                                                                                                                                                                                       |
| A refused figure puts the fields back to the last agreed pair                                         | A field holding something that was never saved is the one state a person cannot see is wrong.                                                                                                                                                                                |
| Both copied lists leave out every agent with no top-up                                                | Asked for verbatim. The list is the day's work, not the space's inventory.                                                                                                                                                                                                   |
| "Copy with IDs" lists an agent under each of its tags, and untagged agents last under a plain heading | An agent with two tags is one payment per reader; an untagged agent still has money waiting, and a list that silently loses it is worse than one with an extra heading.                                                                                                      |
| Both copied lists carry the agent's full id; only the heading differs                                 | Asked for after the first cut shipped the on-screen label under the account name: both lists are pasted where the money is moved, and there an ad account is its id. The heading is the whole difference — the account it belongs to, or the tag it is paid in a batch with. |
| The list builders live in the shared contract, not the component                                      | They are the only part of the feature nobody can check by eye — a list that drops a row costs somebody a top-up — so they are unit-tested without a browser.                                                                                                                 |
| "Clear the top-ups" returns what they were, and the toast puts them back                              | Same shape as clearing every run marker (017). One press, and the figures it erased are not on screen to retype.                                                                                                                                                             |
| The clear reads the figures _before_ the update rather than from `RETURNING`                          | `RETURNING` hands back the row as written — the nulls — so an undo built on it would restore nothing and say it had. This is asserted in the SQL tests.                                                                                                                      |
| Each figure has its own eraser, and each says what it took                                            | They go stale for different reasons: a top-up once it is paid, a balance when a round ends and last round's numbers are noise. One button for both would always be clearing something somebody still wanted.                                                                 |
| Balances survive the top-up clear; only the top-ups go                                                | "What it has" is a fact about the account; "what to add" is this round's decision.                                                                                                                                                                                           |
| The agent's tag chips sit next to its name, and the "+" is invisible until the row is reached         | The tag is read with the agent; a column of dashed circles down an untagged list is work waiting for nobody.                                                                                                                                                                 |
| The money column is a real grid track, and the narrow layouts give it a row of its own                | The table's columns are one grid shared by the captions and every row; a cell that floats would break the one thing that makes the captions printable once.                                                                                                                  |

## User Scenarios

### User Story 1 — Write the round (P1)

A buyer opens Accounts, types `320` in _Left_ on an agent, presses + twice, and
moves on. Both figures are saved when the field is left; the second press turns
`50` into `100`.

**Acceptance**: the figure survives a reload; a teammate sees it without one; a
five-digit figure is refused and the field goes back to what was saved.

### User Story 2 — Group the agents (P1)

In Settings → Tags the buyer makes `#2` in _Agent tags_, then hangs it on the
agents that belong to that batch, from the accounts list.

**Acceptance**: the tag appears next to the agent's name; the dictionary says
how many agents carry it; a task tag cannot be hung on an agent.

### User Story 3 — Hand the round over (P1)

At the bottom of the list, _Copy with names_ puts the day's top-ups on the
clipboard grouped by social account; _Copy with IDs_ puts the same top-ups
grouped by agent tag, with full ids. Once they are paid, _Clear the top-ups_
empties every _Add_ field, with an Undo in the toast.

**Acceptance**: neither list contains an agent with no top-up; the count on the
footer matches what was copied; the undo restores every figure.

## What was built

| Layer      | Where                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Database   | `supabase/migrations/20260906220000_agents_carry_money_and_tags.sql`, `20260906230000_the_balances_can_be_cleared_too.sql`                    |
| Contract   | `packages/shared/src/team/accounts.ts` (money normalizers, the step, both list builders) and `task-labels.ts` (the scope)                     |
| API client | `setAgentMoney`, `clearAgentTopups`, `attachAgentLabel`, `detachAgentLabel`, and the generic label RPCs in `api/team.ts`                      |
| Accounts   | `team/accounts/AgentMoney.tsx`, `AgentLabels.tsx`, the footer in `AccountSpace.tsx`, the money column in `styles/team-accounts.css`           |
| Settings   | `TaskLabelsSection` gained a `scope`; the Tags tab shows both sets                                                                            |
| Tests      | `tests/team-agent-money-sql.test.ts` (6), the copy-out and money cases in `tests/team-accounts-contract.test.ts` and `team-accounts.test.tsx` |
