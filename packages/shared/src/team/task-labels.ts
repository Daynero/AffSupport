import { isRecord } from './contract.js';

/**
 * Task tags (018): a space keeps a small dictionary of tags — "UGC", "Hot",
 * "Needs review" — created and deleted in the space's settings, and hung on
 * tasks from the task editor. The board then filters by them and can be
 * ordered by them.
 *
 * Deliberately *not* the agent tags of 017. Those are derived from an account
 * and an agent id and cannot be typed; these are free text the team invents
 * for itself. Both are chips on a card, so they share the chip's shape and
 * nothing else: the colour is what tells them apart at a glance.
 */

export const TEAM_TASK_LABEL_NAME_MAX = 24;
/** How many tags one space may hold. Past this the dictionary is the problem. */
export const TEAM_TASK_LABEL_MAX = 60;
/** How many tags the filter may ask for at once. */
export const TEAM_TASK_LABEL_FILTER_MAX = 20;

/**
 * The colours a tag can carry. A closed set, not free hex: the palette is a
 * design decision that has to hold in both themes, and a colour picker that
 * can produce `#fefefe` produces an invisible chip.
 */
export const TEAM_TASK_LABEL_COLORS = [
  'purple',
  'blue',
  'teal',
  'green',
  'honey',
  'orange',
  'red',
  'pink',
  'slate'
] as const;

export type TeamTaskLabelColor = (typeof TEAM_TASK_LABEL_COLORS)[number];

export const TEAM_TASK_LABEL_DEFAULT_COLOR: TeamTaskLabelColor = 'purple';

export function isTeamTaskLabelColor(value: unknown): value is TeamTaskLabelColor {
  return typeof value === 'string' && (TEAM_TASK_LABEL_COLORS as readonly string[]).includes(value);
}

/**
 * A tag's name, or null when the value is not one. Whitespace is collapsed and
 * the ends trimmed; the result is what a chip will carry, so it stays short
 * enough to sit on a card beside three others.
 */
export function normalizeTeamTaskLabelName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (name.length < 1 || name.length > TEAM_TASK_LABEL_NAME_MAX) return null;
  return name;
}

/**
 * Which set a tag belongs to (019). Tasks and agents keep separate
 * dictionaries — an agent tag like `#2` means nothing on a task — but they are
 * the same object otherwise, so one contract serves both.
 */
export const TEAM_LABEL_SCOPES = ['task', 'agent'] as const;
export type TeamLabelScope = (typeof TEAM_LABEL_SCOPES)[number];

export function isTeamLabelScope(value: unknown): value is TeamLabelScope {
  return value === 'task' || value === 'agent';
}

/** A tag as a task or an agent carries it: enough to draw the chip. */
export interface TeamTaskLabelRef {
  id: string;
  name: string;
  color: TeamTaskLabelColor;
}

/** A tag in the space's dictionary, as the settings tab lists it. */
export interface TeamTaskLabel extends TeamTaskLabelRef {
  teamId: string;
  scope: TeamLabelScope;
  /** How many tasks or agents carry this tag; what the delete confirmation names. */
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export function parseTeamTaskLabelRef(value: unknown): TeamTaskLabelRef | null {
  if (!isRecord(value)) return null;
  const { id, name, color } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || name.length < 1) return null;
  return {
    id,
    name,
    // A colour this build does not know is drawn in the neutral one rather
    // than refusing the whole row: an older client must still show the tag.
    color: isTeamTaskLabelColor(color) ? color : TEAM_TASK_LABEL_DEFAULT_COLOR
  };
}

/** The tags a task row carries, or null when the payload is not a list of them. */
export function parseTeamTaskLabelRefs(value: unknown): TeamTaskLabelRef[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const labels: TeamTaskLabelRef[] = [];
  for (const raw of value) {
    const label = parseTeamTaskLabelRef(raw);
    if (!label) return null;
    labels.push(label);
  }
  return labels;
}

export function parseTeamTaskLabel(value: unknown): TeamTaskLabel | null {
  if (!isRecord(value)) return null;
  const ref = parseTeamTaskLabelRef(value);
  const { team_id, task_count, usage_count, created_at, updated_at } = value;
  const count = usage_count ?? task_count;
  if (
    !ref ||
    typeof team_id !== 'string' ||
    (count !== undefined && count !== null && (typeof count !== 'number' || count < 0)) ||
    typeof created_at !== 'string' ||
    typeof updated_at !== 'string'
  ) {
    return null;
  }
  return {
    ...ref,
    teamId: team_id,
    // A tag from an older payload carries no set; it is a task tag, which is
    // the only kind that existed then.
    scope: isTeamLabelScope(value.scope) ? value.scope : 'task',
    // A bare row (from a write RPC) carries no count; the list does.
    taskCount: typeof count === 'number' ? count : 0,
    createdAt: created_at,
    updatedAt: updated_at
  };
}

/**
 * Tags in the order a person scans them: natural and case-insensitive, so
 * `UGC 2` sits after `UGC` and before `UGC 10`.
 */
export function sortTeamTaskLabels<T extends { name: string }>(labels: readonly T[]): T[] {
  return [...labels].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * The tag a task sorts under: its first one in natural order, or null when it
 * carries none. One helper, so the board's order and the server's cannot
 * disagree about which tag speaks for a task that has three.
 */
export function teamTaskLabelKey(task: { labels: readonly TeamTaskLabelRef[] }): string | null {
  let key: string | null = null;
  for (const label of task.labels) {
    const candidate = label.name.toLocaleLowerCase();
    if (key === null || candidate.localeCompare(key, undefined, { numeric: true }) < 0) {
      key = candidate;
    }
  }
  return key;
}

/**
 * The next colour to offer for a new tag: the one the space uses least, so a
 * dictionary built by pressing Enter nine times is nine different colours
 * rather than nine purple ones.
 */
export function nextTeamTaskLabelColor(
  labels: readonly { color: TeamTaskLabelColor }[]
): TeamTaskLabelColor {
  const used = new Map<TeamTaskLabelColor, number>(TEAM_TASK_LABEL_COLORS.map(color => [color, 0]));
  for (const label of labels) used.set(label.color, (used.get(label.color) ?? 0) + 1);
  let best: TeamTaskLabelColor = TEAM_TASK_LABEL_DEFAULT_COLOR;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of TEAM_TASK_LABEL_COLORS) {
    const count = used.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

/** How the board is ordered: by the date a task is for, or by its tag. */
export type TeamTaskSort = 'date' | 'label';

export function isTeamTaskSort(value: unknown): value is TeamTaskSort {
  return value === 'date' || value === 'label';
}
