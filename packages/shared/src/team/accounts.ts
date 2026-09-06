import { isRecord } from './contract.js';
import { parseTeamTaskLabelRefs, type TeamTaskLabelRef } from './task-labels.js';

/**
 * Team accounts (017): the social accounts a space runs its campaigns from,
 * each holding the agents attached to it. An agent carries any number of
 * *runs* — "Pro Caps | TR 02/09" — and an agent with none is free.
 *
 * The contract is deliberately small: names, ids and run notes are text, and
 * the one derived fact — free or busy — is a function of the runs alone, so
 * the list, the filter and the tag a task carries all agree by construction
 * rather than by convention.
 */

export const TEAM_ACCOUNT_NAME_MAX = 40;
export const TEAM_AGENT_ID_MAX = 64;
export const TEAM_AGENT_NOTE_MAX = 120;
/** How many trailing characters of an agent id the list shows. */
export const TEAM_AGENT_ID_VISIBLE_SUFFIX = 3;

/**
 * An account name, or null when the value is not one. Whitespace is collapsed
 * and the ends trimmed; the result is what the tag `[name-suffix]` will carry,
 * so brackets are refused — they would break the tag's own delimiters.
 */
export function normalizeTeamAccountName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > TEAM_ACCOUNT_NAME_MAX) return null;
  if (/[[\]]/u.test(name)) return null;
  return name;
}

/**
 * An agent id, or null. Ids are tokens: any inner whitespace means two things
 * were pasted, not one, and is refused rather than silently joined.
 */
export function normalizeTeamAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.normalize('NFC').trim();
  if (id.length < 1 || id.length > TEAM_AGENT_ID_MAX) return null;
  if (/\s/u.test(id)) return null;
  return id;
}

/**
 * A run's note, or null when blank. Returns `undefined` for a value that is
 * not a note at all (too long, not text), so a caller can tell "nothing
 * typed" from "refused".
 */
export function normalizeTeamAgentNote(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const note = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (note.length === 0) return null;
  if (note.length > TEAM_AGENT_NOTE_MAX) return undefined;
  return note;
}

/** The part of an id the list shows: the last three characters, or all of a shorter one. */
export function teamAgentIdSuffix(agentId: string): string {
  return agentId.slice(-TEAM_AGENT_ID_VISIBLE_SUFFIX);
}

/**
 * How an agent is named wherever agents are listed: `v31-434` — the account
 * and the tail of the id, so an ad account never reads like a second social
 * account however its id happens to end.
 */
export function teamAgentLabel(accountName: string, agentId: string): string {
  return `${accountName}-${teamAgentIdSuffix(agentId)}`;
}

/**
 * The bracketed form, `[v31-434]` — the way the owner first wrote the tag, and
 * the form for pasting into text outside the app. On screen the tag is the
 * bare label: the owner asked for no brackets once a tag is chosen.
 */
export function teamAccountTag(accountName: string, agentId: string): string {
  return `[${teamAgentLabel(accountName, agentId)}]`;
}

/**
 * How a run is marked. Three colours and unmarked, and the product does not
 * say what any of them means: the team's own reading of green is the only one
 * that would ever be right.
 */
export type TeamAgentRunMarker = 'green' | 'amber' | 'red';

export const TEAM_AGENT_RUN_MARKERS: readonly TeamAgentRunMarker[] = ['green', 'amber', 'red'];

export function isTeamAgentRunMarker(value: unknown): value is TeamAgentRunMarker {
  return value === 'green' || value === 'amber' || value === 'red';
}

/**
 * The next marker a press lands on: unmarked → green → amber → red →
 * unmarked. One gesture, no menu, and four presses always return the run to
 * where it started — which is what makes marking safe to try.
 */
export function nextTeamAgentRunMarker(
  current: TeamAgentRunMarker | null
): TeamAgentRunMarker | null {
  if (current === null) return 'green';
  const index = TEAM_AGENT_RUN_MARKERS.indexOf(current);
  return TEAM_AGENT_RUN_MARKERS[index + 1] ?? null;
}

/** What a run carried before its marker was cleared, so an undo can put it back. */
export interface TeamAgentRunMarkerSnapshot {
  runId: string;
  marker: TeamAgentRunMarker;
}

export function parseTeamAgentRunMarkerSnapshots(
  value: unknown
): TeamAgentRunMarkerSnapshot[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const snapshots: TeamAgentRunMarkerSnapshot[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { run_id, marker } = raw;
    if (typeof run_id !== 'string' || !isTeamAgentRunMarker(marker)) return null;
    snapshots.push({ runId: run_id, marker });
  }
  return snapshots;
}

/** One launch on an agent. */
export interface TeamAgentRun {
  id: string;
  note: string;
  /** Green, amber, red — or null when the run carries no marker. */
  marker: TeamAgentRunMarker | null;
  createdAt: string;
}

export function parseTeamAgentRuns(value: unknown): TeamAgentRun[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const runs: TeamAgentRun[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { id, note, marker, created_at } = raw;
    if (typeof id !== 'string' || typeof note !== 'string' || typeof created_at !== 'string') {
      return null;
    }
    // An unknown marker is read as none rather than refusing the whole list:
    // a colour this build does not know is a run it can still show.
    if (note.trim() === '') continue;
    runs.push({
      id,
      note,
      marker: isTeamAgentRunMarker(marker) ? marker : null,
      createdAt: created_at
    });
  }
  return runs;
}

/** How much a top-up moves per press of + or − (019). */
export const TEAM_AGENT_TOPUP_STEP = 50;
/** The largest figure four characters can hold, which is the field's width. */
export const TEAM_AGENT_AMOUNT_MAX = 9_999;

/**
 * A figure typed into one of the money fields, or null when the field is
 * empty. Whole units only — these are read at a glance and never computed
 * with — and `undefined` for a value that is not a figure at all, so a caller
 * can tell "cleared" from "refused".
 */
export function normalizeTeamAgentAmount(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > TEAM_AGENT_AMOUNT_MAX) return undefined;
    return value;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return null;
  if (!/^\d{1,4}$/u.test(text)) return undefined;
  const amount = Number(text);
  return amount <= TEAM_AGENT_AMOUNT_MAX ? amount : undefined;
}

/**
 * The figure a press of + or − lands on: a step up or down, kept inside the
 * field's range, and snapped to the step so a typed 30 becomes 50 rather than
 * 80. Empty steps up to 50 and down to nothing, which is how a top-up is both
 * started and taken back.
 */
export function stepTeamAgentTopup(current: number | null, direction: 1 | -1): number | null {
  const step = TEAM_AGENT_TOPUP_STEP;
  if (current === null) return direction === 1 ? step : null;
  const next =
    direction === 1
      ? Math.floor(current / step) * step + step
      : Math.ceil(current / step) * step - step;
  if (next <= 0) return null;
  return Math.min(next, Math.floor(TEAM_AGENT_AMOUNT_MAX / step) * step);
}

export interface TeamAccountAgentSummary {
  id: string;
  accountId: string;
  teamId: string;
  agentId: string;
  /** The runs on this agent, oldest first; none means free. */
  runs: TeamAgentRun[];
  /** The agent tags hung on it (019), in natural order by name. */
  labels: TeamTaskLabelRef[];
  /** What the agent has left, in whole units; null when nobody has said. */
  balance: number | null;
  /** What to add to it; null is nothing to add. */
  topup: number | null;
  /** How many tasks carry this agent's tag. */
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * An agent as a task sees it: enough to draw the tag and say what is running
 * on the agent right now. `id` is the link row; `agentRowId` the agent.
 */
export interface TeamTaskAgentTag {
  id: string;
  agentRowId: string;
  accountId: string;
  accountName: string;
  agentId: string;
  runs: TeamAgentRun[];
}

export function parseTeamTaskAgentTag(value: unknown): TeamTaskAgentTag | null {
  if (!isRecord(value)) return null;
  const { id, agent_row_id, account_id, account_name, agent_id, runs } = value;
  const parsedRuns = parseTeamAgentRuns(runs);
  if (
    typeof id !== 'string' ||
    typeof agent_row_id !== 'string' ||
    typeof account_id !== 'string' ||
    typeof account_name !== 'string' ||
    typeof agent_id !== 'string' ||
    parsedRuns === null
  ) {
    return null;
  }
  return {
    id,
    agentRowId: agent_row_id,
    accountId: account_id,
    accountName: account_name,
    agentId: agent_id,
    runs: parsedRuns
  };
}

/** The tags a task row carries, or null when the payload is not a list of them. */
export function parseTeamTaskAgentTags(value: unknown): TeamTaskAgentTag[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const tags: TeamTaskAgentTag[] = [];
  for (const raw of value) {
    const tag = parseTeamTaskAgentTag(raw);
    if (!tag) return null;
    tags.push(tag);
  }
  return tags;
}

/**
 * Tags in the order the accounts list uses — natural, by account then agent —
 * rather than the bytewise order the database hands back (`v12` before `v3`).
 */
export function sortTeamTaskAgentTags(tags: readonly TeamTaskAgentTag[]): TeamTaskAgentTag[] {
  return [...tags].sort((left, right) =>
    teamTaskAgentTagLabel(left).localeCompare(teamTaskAgentTagLabel(right), undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

/** The text of a tag as a task shows it: `v31-434`, the same as the accounts list. */
export function teamTaskAgentTagLabel(tag: Pick<TeamTaskAgentTag, 'accountName' | 'agentId'>) {
  return teamAgentLabel(tag.accountName, tag.agentId);
}

export interface TeamAccountSummary {
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  agents: TeamAccountAgentSummary[];
}

export function isTeamAgentFree(agent: { runs: readonly TeamAgentRun[] }): boolean {
  return agent.runs.length === 0;
}

/** The runs as one line — for a tooltip, a search, a compact cell. */
export function teamAgentRunsSummary(agent: { runs: readonly TeamAgentRun[] }): string {
  return agent.runs.map(run => run.note).join(' · ');
}

export function parseTeamAccountAgent(value: unknown): TeamAccountAgentSummary | null {
  if (!isRecord(value)) return null;
  const { id, account_id, team_id, agent_id, runs, task_count, created_at, updated_at } = value;
  const parsedRuns = parseTeamAgentRuns(runs);
  const labels = parseTeamTaskLabelRefs(value.labels);
  const balance = normalizeTeamAgentAmount(value.balance);
  const topup = normalizeTeamAgentAmount(value.topup);
  if (
    typeof id !== 'string' ||
    typeof account_id !== 'string' ||
    typeof team_id !== 'string' ||
    typeof agent_id !== 'string' ||
    parsedRuns === null ||
    labels === null ||
    balance === undefined ||
    topup === undefined ||
    (task_count !== undefined && (typeof task_count !== 'number' || task_count < 0)) ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  return {
    id,
    accountId: account_id,
    teamId: team_id,
    agentId: agent_id,
    runs: parsedRuns,
    labels,
    balance,
    topup,
    // A bare row (from a write RPC) carries no count; the list does.
    taskCount: typeof task_count === 'number' ? task_count : 0,
    createdAt: created_at,
    updatedAt: updated_at
  };
}

/**
 * One account with its agents, as `list_team_accounts` returns it: the agents
 * arrive nested as JSON so the whole list is one round trip.
 */
export function parseTeamAccount(value: unknown): TeamAccountSummary | null {
  if (!isRecord(value)) return null;
  const { id, team_id, name, created_at, updated_at, agents } = value;
  if (
    typeof id !== 'string' ||
    typeof team_id !== 'string' ||
    typeof name !== 'string' ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  const rawAgents = agents === null || agents === undefined ? [] : agents;
  if (!Array.isArray(rawAgents)) return null;
  const parsed: TeamAccountAgentSummary[] = [];
  for (const raw of rawAgents) {
    const agent = parseTeamAccountAgent(raw);
    if (!agent || agent.accountId !== id) return null;
    parsed.push(agent);
  }
  return {
    id,
    teamId: team_id,
    name,
    createdAt: created_at,
    updatedAt: updated_at,
    agents: parsed
  };
}

/**
 * Accounts in the order a person scans them: natural, so `v3` sits before
 * `v31` and after `v2`, and case does not scatter them.
 */
export function sortTeamAccounts<T extends { name: string }>(accounts: readonly T[]): T[] {
  return [...accounts].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * The agents of an account in the order the list reads them: the free ones
 * first, because "where can I start something" is the question the tab is
 * opened with and a free agent found by eye is one filter press saved; then
 * naturally by id, so two reads of the same account never disagree.
 */
export function sortTeamAgents<T extends { agentId: string; runs: readonly TeamAgentRun[] }>(
  agents: readonly T[]
): T[] {
  return [...agents].sort((left, right) => {
    const free = Number(right.runs.length === 0) - Number(left.runs.length === 0);
    if (free !== 0) return free;
    return left.agentId.localeCompare(right.agentId, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
}

export type TeamAccountOccupancyFilter = 'all' | 'free' | 'busy';

/** The marker filter: every agent, or only those carrying a run of one colour. */
export type TeamAccountMarkerFilter = 'all' | TeamAgentRunMarker;

/** Whether any run on the agent carries this marker. */
export function teamAgentHasMarker(
  agent: { runs: readonly TeamAgentRun[] },
  marker: TeamAgentRunMarker
): boolean {
  return agent.runs.some(run => run.marker === marker);
}

/**
 * The list a filter leaves on screen. `free` keeps only free agents — and
 * drops an account with none of them, which is the point of the filter: the
 * question it answers is "where can I start something", and an account with
 * nowhere to start is noise. An account with no agents at all stays under
 * `free`: it is the emptiest thing there is, and hiding it would hide the
 * place the next agent goes. `busy` is the mirror image and drops it. A
 * search term keeps an account whose name matches whole, or only the agents
 * whose id or any run match otherwise.
 */
export function filterTeamAccounts(
  accounts: readonly TeamAccountSummary[],
  input: {
    occupancy: TeamAccountOccupancyFilter;
    search: string;
    /** A colour keeps only the agents carrying a run marked with it. */
    marker?: TeamAccountMarkerFilter;
  }
): TeamAccountSummary[] {
  const term = input.search.normalize('NFC').trim().toLocaleLowerCase();
  const kept: TeamAccountSummary[] = [];
  for (const account of accounts) {
    const nameMatches = term === '' || account.name.toLocaleLowerCase().includes(term);
    let agents = account.agents;
    if (!nameMatches) {
      agents = agents.filter(
        agent =>
          agent.agentId.toLocaleLowerCase().includes(term) ||
          agent.runs.some(run => run.note.toLocaleLowerCase().includes(term))
      );
      if (agents.length === 0) continue;
    }
    if (input.occupancy !== 'all') {
      const wantFree = input.occupancy === 'free';
      const emptyAccount = account.agents.length === 0 && nameMatches;
      agents = agents.filter(agent => isTeamAgentFree(agent) === wantFree);
      if (agents.length === 0 && !(wantFree && emptyAccount)) continue;
    }
    /* A colour is asked of the runs themselves, so an account with none of
       them leaves the screen entirely — a marker filter showing accounts that
       cannot answer it is the noise the occupancy filter already refuses. */
    if (input.marker !== undefined && input.marker !== 'all') {
      const marker = input.marker;
      agents = agents.filter(agent => teamAgentHasMarker(agent, marker));
      if (agents.length === 0) continue;
    }
    kept.push({ ...account, agents: sortTeamAgents(agents) });
  }
  return kept;
}

export interface TeamAccountCounts {
  accounts: number;
  agents: number;
  free: number;
  busy: number;
  /**
   * Agents, not runs: the number on a marker chip is how many rows pressing it
   * leaves on screen, which is the only figure a filter chip can promise.
   */
  markers: Record<TeamAgentRunMarker, number>;
}

export function countTeamAccounts(accounts: readonly TeamAccountSummary[]): TeamAccountCounts {
  let agents = 0;
  let free = 0;
  const markers: Record<TeamAgentRunMarker, number> = { green: 0, amber: 0, red: 0 };
  for (const account of accounts) {
    for (const agent of account.agents) {
      agents += 1;
      if (isTeamAgentFree(agent)) free += 1;
      for (const marker of TEAM_AGENT_RUN_MARKERS) {
        if (teamAgentHasMarker(agent, marker)) markers[marker] += 1;
      }
    }
  }
  return { accounts: accounts.length, agents, free, busy: agents - free, markers };
}

/**
 * The two lists the accounts table copies out (019).
 *
 * Both answer the same question — "who gets topped up, and by how much" — for
 * two different readers, so they are built here rather than in the component:
 * a media buyer reads the first one and checks it against the board, and the
 * second one goes to whoever actually moves the money, who knows the agents by
 * id and sorts the work by the tag on them.
 *
 * An agent with no top-up is in neither list. That is the whole point of the
 * button: the list is the day's work, not the space's inventory.
 */

/** `$50` — the one shape a figure takes in a copied list. */
export function teamAgentAmountText(amount: number): string {
  return `$${amount}`;
}

function copiedGroup(heading: string, lines: readonly string[]): string {
  return [heading, ...lines].join('\n');
}

/**
 * By social account: the account's name, then the full id of each of its
 * agents and the figure.
 *
 * The ids, not the labels the list shows on screen. Both copies are pasted
 * where the money is actually moved, and there an ad account is its id; what
 * separates the two lists is how the work is grouped — under the account it
 * belongs to, or under the tag it is paid in a batch with — and nothing else.
 */
export function buildTeamAgentTopupListByAccount(accounts: readonly TeamAccountSummary[]): string {
  const groups: string[] = [];
  for (const account of sortTeamAccounts(accounts)) {
    const lines = account.agents
      .filter(agent => agent.topup !== null)
      .sort((left, right) =>
        left.agentId.localeCompare(right.agentId, undefined, { numeric: true })
      )
      .map(agent => `${agent.agentId} - ${teamAgentAmountText(agent.topup!)}`);
    if (lines.length > 0) groups.push(copiedGroup(account.name, lines));
  }
  return groups.join('\n\n');
}

/**
 * By agent tag: the tag, then the agents' full ids under it. An agent carrying
 * two tags is in both groups — it is one payment per tag's reader, and leaving
 * it out of the second would be the quieter of the two mistakes only if
 * anybody could tell it had happened.
 *
 * `untaggedHeading` names the group for agents that carry no tag at all. They
 * are listed last rather than dropped: they have money waiting the same as the
 * rest, and a list that silently loses them is worse than one with a plain
 * heading in it.
 */
export function buildTeamAgentTopupListByLabel(
  accounts: readonly TeamAccountSummary[],
  untaggedHeading: string
): string {
  const byLabel = new Map<string, { name: string; lines: string[] }>();
  const untagged: string[] = [];
  const rows = accounts
    .flatMap(account => account.agents)
    .filter(agent => agent.topup !== null)
    .sort((left, right) => left.agentId.localeCompare(right.agentId, undefined, { numeric: true }));

  for (const agent of rows) {
    const line = `${agent.agentId} - ${teamAgentAmountText(agent.topup!)}`;
    if (agent.labels.length === 0) {
      untagged.push(line);
      continue;
    }
    for (const label of agent.labels) {
      const group = byLabel.get(label.id) ?? { name: label.name, lines: [] };
      group.lines.push(line);
      byLabel.set(label.id, group);
    }
  }

  const groups = [...byLabel.values()]
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    )
    .map(group => copiedGroup(group.name, group.lines));
  if (untagged.length > 0) groups.push(copiedGroup(untaggedHeading, untagged));
  return groups.join('\n\n');
}

/** How many agents a copy would list, for the button's own count. */
export function countTeamAgentTopups(accounts: readonly TeamAccountSummary[]): number {
  return accounts.reduce(
    (total, account) => total + account.agents.filter(agent => agent.topup !== null).length,
    0
  );
}

/** What a figure was before it was cleared, so an undo can put it back. */
export interface TeamAgentTopupSnapshot {
  agentRowId: string;
  topup: number;
}

export interface TeamAgentBalanceSnapshot {
  agentRowId: string;
  balance: number;
}

export function parseTeamAgentBalanceSnapshots(value: unknown): TeamAgentBalanceSnapshot[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const snapshots: TeamAgentBalanceSnapshot[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { agent_row_id, balance } = raw;
    if (typeof agent_row_id !== 'string' || typeof balance !== 'number') return null;
    snapshots.push({ agentRowId: agent_row_id, balance });
  }
  return snapshots;
}

/** How many agents carry a balance, for the button that would clear them. */
export function countTeamAgentBalances(accounts: readonly TeamAccountSummary[]): number {
  return accounts.reduce(
    (total, account) => total + account.agents.filter(agent => agent.balance !== null).length,
    0
  );
}

export function parseTeamAgentTopupSnapshots(value: unknown): TeamAgentTopupSnapshot[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const snapshots: TeamAgentTopupSnapshot[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { agent_row_id, topup } = raw;
    if (typeof agent_row_id !== 'string' || typeof topup !== 'number') return null;
    snapshots.push({ agentRowId: agent_row_id, topup });
  }
  return snapshots;
}
