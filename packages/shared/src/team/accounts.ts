import { validFinanceDate } from './agent-finance.js';
import { isRecord } from './contract.js';
import type { TeamAccountNameColor } from './account-lifecycle.js';
import { parseTeamTaskLabelRefs, type TeamTaskLabelRef } from './task-labels.js';
import {
  convertKeyboardLayout,
  countSearchLetters,
  matchesSearchTerms,
  searchTerms
} from './text-search.js';

/**
 * Team accounts (017): the social accounts a space runs its campaigns from,
 * each holding the agents attached to it. An agent carries any number of
 * manual holds — "Pro Caps | TR 02/09" — alongside current Launch assignments.
 *
 * The contract is deliberately small: names, ids and run notes are text, and
 * current availability combines manual holds and authoritative Launch assignments, so
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

export interface TeamAccountWorkspaceMetadata {
  /** Effective first reporting day, independent of the audit timestamp. */
  startsOn?: string;
  sortRank?: number;
  archivedAt?: string | null;
  lifecycleVersion?: string;
  nameColor?: TeamAccountNameColor;
  nameColorVersion?: string;
}

export type TeamAgentAvailabilityStatus = 'free' | 'busy' | 'unknown';
export interface TeamAgentAvailability {
  status: TeamAgentAvailabilityStatus;
  assignmentCount: number;
  legacyCount: number;
}

export interface TeamAccountAgentSummary extends TeamAccountWorkspaceMetadata {
  id: string;
  accountId: string;
  teamId: string;
  agentId: string;
  /** Manual holds, oldest first; Launch assignments are counted separately. */
  availability?: TeamAgentAvailability;
  runs: TeamAgentRun[];
  /** The agent tags hung on it (019), in natural order by name. */
  labels: TeamTaskLabelRef[];
  /** What the agent has left, in whole units; null when nobody has said. */
  balance: number | null;
  /** What to add to it; null is nothing to add. */
  topup: number | null;
  /** How many tasks carry this agent's tag. */
  taskCount: number;
  /** Open tasks attached under the current social account. */
  accountTaskCount?: number;
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
  availability?: TeamAgentAvailability;
}

export function parseTeamTaskAgentTag(value: unknown): TeamTaskAgentTag | null {
  if (!isRecord(value)) return null;
  const { id, agent_row_id, account_id, account_name, agent_id, runs } = value;
  const parsedRuns = parseTeamAgentRuns(runs);
  const availability =
    value.availability === undefined
      ? { status: 'unknown' as const, assignmentCount: 0, legacyCount: 0 }
      : parseTeamAgentAvailability(value.availability);
  if (
    typeof id !== 'string' ||
    typeof agent_row_id !== 'string' ||
    typeof account_id !== 'string' ||
    typeof account_name !== 'string' ||
    typeof agent_id !== 'string' ||
    parsedRuns === null ||
    availability === null
  ) {
    return null;
  }
  return {
    id,
    agentRowId: agent_row_id,
    accountId: account_id,
    accountName: account_name,
    agentId: agent_id,
    runs: parsedRuns,
    availability
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

export interface TeamAccountSummary extends TeamAccountWorkspaceMetadata {
  /** Distinct open tasks historically attached under this social account. */
  taskCount?: number;
  id: string;
  teamId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  agents: TeamAccountAgentSummary[];
}

/** Missing wire authority is unknown; in-memory legacy fixtures retain their old contract. */
export function getTeamAgentAvailability(agent: {
  runs: readonly TeamAgentRun[];
  availability?: TeamAgentAvailability;
}): TeamAgentAvailabilityStatus {
  if (agent.runs.length > 0 || (agent.availability?.assignmentCount ?? 0) > 0) return 'busy';
  if (!agent.availability) return 'free';
  if (agent.availability.status === 'busy') return 'busy';
  if (agent.availability.legacyCount > 0 || agent.availability.status === 'unknown')
    return 'unknown';
  return 'free';
}

export function isTeamAgentFree(agent: {
  runs: readonly TeamAgentRun[];
  availability?: TeamAgentAvailability;
}): boolean {
  return getTeamAgentAvailability(agent) === 'free';
}

export function parseTeamAgentAvailability(value: unknown): TeamAgentAvailability | null {
  if (
    !isRecord(value) ||
    !['free', 'busy', 'unknown'].includes(String(value.status)) ||
    typeof value.assignmentCount !== 'number' ||
    !Number.isSafeInteger(value.assignmentCount) ||
    value.assignmentCount < 0 ||
    typeof value.legacyCount !== 'number' ||
    !Number.isSafeInteger(value.legacyCount) ||
    value.legacyCount < 0 ||
    (value.status === 'free' && (value.assignmentCount !== 0 || value.legacyCount !== 0)) ||
    (value.status === 'unknown' && value.assignmentCount !== 0)
  )
    return null;
  return {
    status: value.status as TeamAgentAvailabilityStatus,
    assignmentCount: value.assignmentCount,
    legacyCount: value.legacyCount
  };
}

/** The runs as one line — for a tooltip, a search, a compact cell. */
export function teamAgentRunsSummary(agent: { runs: readonly TeamAgentRun[] }): string {
  return agent.runs.map(run => run.note).join(' · ');
}

export function parseTeamAccountAgent(value: unknown): TeamAccountAgentSummary | null {
  if (!isRecord(value)) return null;
  const { id, account_id, team_id, agent_id, runs, task_count, created_at, updated_at } = value;
  const metadata = parseWorkspaceMetadata(value);
  if (!metadata) return null;
  const parsedRuns = parseTeamAgentRuns(runs);
  const availability =
    value.availability === undefined
      ? { status: 'unknown' as const, assignmentCount: 0, legacyCount: 0 }
      : parseTeamAgentAvailability(value.availability);
  const labels = parseTeamTaskLabelRefs(value.labels);
  const balance = normalizeTeamAgentAmount(value.balance);
  const topup = normalizeTeamAgentAmount(value.topup);
  if (
    typeof id !== 'string' ||
    typeof account_id !== 'string' ||
    typeof team_id !== 'string' ||
    typeof agent_id !== 'string' ||
    parsedRuns === null ||
    availability === null ||
    labels === null ||
    balance === undefined ||
    topup === undefined ||
    (task_count !== undefined && (typeof task_count !== 'number' || task_count < 0)) ||
    (value.account_task_count !== undefined &&
      (typeof value.account_task_count !== 'number' || value.account_task_count < 0)) ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  return {
    ...metadata,
    id,
    accountId: account_id,
    teamId: team_id,
    agentId: agent_id,
    runs: parsedRuns,
    availability,
    labels,
    balance,
    topup,
    // A bare row (from a write RPC) carries no count; the list does.
    taskCount: typeof task_count === 'number' ? task_count : 0,
    ...(typeof value.account_task_count === 'number'
      ? { accountTaskCount: value.account_task_count }
      : {}),
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
  const metadata = parseWorkspaceMetadata(value);
  if (!metadata) return null;
  const { id, team_id, name, created_at, updated_at, agents } = value;
  if (
    typeof id !== 'string' ||
    typeof team_id !== 'string' ||
    typeof name !== 'string' ||
    typeof created_at !== 'string' ||
    (value.task_count !== undefined &&
      (typeof value.task_count !== 'number' || value.task_count < 0)) ||
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
    ...metadata,
    id,
    teamId: team_id,
    name,
    createdAt: created_at,
    updatedAt: updated_at,
    ...(typeof value.task_count === 'number' ? { taskCount: value.task_count } : {}),
    agents: parsed
  };
}

/**
 * Accounts in the order a person scans them: natural, so `v3` sits before
 * `v31` and after `v2`, and case does not scatter them.
 */
export function sortTeamAccounts<T extends { name: string; sortRank?: number }>(
  accounts: readonly T[]
): T[] {
  return [...accounts].sort(
    (left, right) =>
      (left.sortRank !== undefined && right.sortRank !== undefined
        ? left.sortRank - right.sortRank
        : 0) ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * The agents of an account in the order the list reads them: the free ones
 * first, because "where can I start something" is the question the tab is
 * opened with and a free agent found by eye is one filter press saved; then
 * naturally by id, so two reads of the same account never disagree.
 */
export function sortTeamAgents<
  T extends { agentId: string; runs: readonly TeamAgentRun[]; sortRank?: number }
>(agents: readonly T[]): T[] {
  return [...agents].sort((left, right) => {
    if (left.sortRank !== undefined && right.sortRank !== undefined)
      return left.sortRank - right.sortRank;
    const free = Number(isTeamAgentFree(right)) - Number(isTeamAgentFree(left));
    if (free !== 0) return free;
    return left.agentId.localeCompare(right.agentId, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
}

export type TeamAccountOccupancyFilter = 'all' | 'free' | 'busy' | 'unknown';

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
  const kept = filterTeamAccountsBy(accounts, input, searchTerms(input.search));
  /* Nothing for the words as typed: the same keys on the other keyboard layout
     ("rtnj" for "кето") get one more try, the way the file search does. */
  if (kept.length > 0 || countSearchLetters(input.search) < 3) return kept;
  const swapped = convertKeyboardLayout(input.search);
  return swapped ? filterTeamAccountsBy(accounts, input, searchTerms(swapped)) : kept;
}

function filterTeamAccountsBy(
  accounts: readonly TeamAccountSummary[],
  input: { occupancy: TeamAccountOccupancyFilter; marker?: TeamAccountMarkerFilter },
  terms: readonly string[]
): TeamAccountSummary[] {
  const kept: TeamAccountSummary[] = [];
  for (const account of accounts) {
    const activeOnly =
      input.occupancy !== 'all' || (input.marker !== undefined && input.marker !== 'all');
    if (activeOnly && account.archivedAt) continue;
    // Every word has to be found, in any order (search rework, 2026-10).
    const nameMatches = matchesSearchTerms(account.name, terms);
    let agents = activeOnly ? account.agents.filter(agent => !agent.archivedAt) : account.agents;
    const emptyActiveAccount = activeOnly && agents.length === 0;
    if (!nameMatches) {
      agents = agents.filter(agent =>
        matchesSearchTerms([account.name, agent.agentId, ...agent.runs.map(run => run.note)], terms)
      );
      if (agents.length === 0) continue;
    }
    if (input.occupancy !== 'all') {
      const wantFree = input.occupancy === 'free';
      const emptyAccount = emptyActiveAccount && nameMatches;
      agents = agents.filter(agent => getTeamAgentAvailability(agent) === input.occupancy);
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
  /** Missing authority is separate from both free and busy. Omitted when zero. */
  unknown?: number;
  /**
   * Agents, not runs: the number on a marker chip is how many rows pressing it
   * leaves on screen, which is the only figure a filter chip can promise.
   */
  markers: Record<TeamAgentRunMarker, number>;
}

export function countTeamAccounts(accounts: readonly TeamAccountSummary[]): TeamAccountCounts {
  let activeAccounts = 0;
  let agents = 0;
  let free = 0;
  let busy = 0;
  let unknown = 0;
  const markers: Record<TeamAgentRunMarker, number> = { green: 0, amber: 0, red: 0 };
  for (const account of accounts) {
    if (account.archivedAt) continue;
    activeAccounts += 1;
    for (const agent of account.agents) {
      if (agent.archivedAt) continue;
      agents += 1;
      const availability = getTeamAgentAvailability(agent);
      if (availability === 'free') free += 1;
      else if (availability === 'busy') busy += 1;
      else unknown += 1;
      for (const marker of TEAM_AGENT_RUN_MARKERS) {
        if (teamAgentHasMarker(agent, marker)) markers[marker] += 1;
      }
    }
  }
  return { accounts: activeAccounts, agents, free, busy, ...(unknown ? { unknown } : {}), markers };
}

function parseWorkspaceMetadata(
  value: Record<string, unknown>
): TeamAccountWorkspaceMetadata | null {
  if (
    (value.starts_on !== undefined &&
      value.starts_on !== null &&
      !validFinanceDate(value.starts_on)) ||
    (value.sort_rank !== undefined &&
      (typeof value.sort_rank !== 'number' ||
        !Number.isSafeInteger(value.sort_rank) ||
        value.sort_rank < 0)) ||
    (value.archived_at !== undefined &&
      value.archived_at !== null &&
      (typeof value.archived_at !== 'string' || !Number.isFinite(Date.parse(value.archived_at)))) ||
    (value.lifecycle_version !== undefined && !validWorkspaceVersion(value.lifecycle_version)) ||
    (value.name_color !== undefined &&
      (typeof value.name_color !== 'number' ||
        !Number.isInteger(value.name_color) ||
        value.name_color < 0 ||
        value.name_color > 7)) ||
    (value.name_color_version !== undefined && !validWorkspaceVersion(value.name_color_version))
  )
    return null;
  return {
    ...(typeof value.starts_on === 'string' ? { startsOn: value.starts_on } : {}),
    ...(typeof value.sort_rank === 'number' ? { sortRank: value.sort_rank } : {}),
    ...(value.archived_at === null || typeof value.archived_at === 'string'
      ? { archivedAt: value.archived_at }
      : {}),
    ...(value.lifecycle_version !== undefined
      ? { lifecycleVersion: String(value.lifecycle_version) }
      : {}),
    ...(typeof value.name_color === 'number'
      ? { nameColor: value.name_color as TeamAccountNameColor }
      : {}),
    ...(value.name_color_version !== undefined
      ? { nameColorVersion: String(value.name_color_version) }
      : {})
  };
}

/** Composite row RPCs encode bigint as JSON numbers; overview encodes text. */
function validWorkspaceVersion(value: unknown): boolean {
  return (
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}
