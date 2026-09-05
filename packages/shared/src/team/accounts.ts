import { isRecord } from './contract.js';

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

/** One launch on an agent. */
export interface TeamAgentRun {
  id: string;
  note: string;
  createdAt: string;
}

export function parseTeamAgentRuns(value: unknown): TeamAgentRun[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const runs: TeamAgentRun[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { id, note, created_at } = raw;
    if (typeof id !== 'string' || typeof note !== 'string' || typeof created_at !== 'string') {
      return null;
    }
    // A blank run that slipped past the server is no run.
    if (note.trim() === '') continue;
    runs.push({ id, note, createdAt: created_at });
  }
  return runs;
}

export interface TeamAccountAgentSummary {
  id: string;
  accountId: string;
  teamId: string;
  agentId: string;
  /** The runs on this agent, oldest first; none means free. */
  runs: TeamAgentRun[];
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
  if (
    typeof id !== 'string' ||
    typeof account_id !== 'string' ||
    typeof team_id !== 'string' ||
    typeof agent_id !== 'string' ||
    parsedRuns === null ||
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

export type TeamAccountOccupancyFilter = 'all' | 'free' | 'busy';

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
  input: { occupancy: TeamAccountOccupancyFilter; search: string }
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
    kept.push(agents === account.agents ? account : { ...account, agents });
  }
  return kept;
}

export interface TeamAccountCounts {
  accounts: number;
  agents: number;
  free: number;
  busy: number;
}

export function countTeamAccounts(accounts: readonly TeamAccountSummary[]): TeamAccountCounts {
  let agents = 0;
  let free = 0;
  for (const account of accounts) {
    for (const agent of account.agents) {
      agents += 1;
      if (isTeamAgentFree(agent)) free += 1;
    }
  }
  return { accounts: accounts.length, agents, free, busy: agents - free };
}
