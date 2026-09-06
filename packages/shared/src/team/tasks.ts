import { isRecord, normalizeTeamFreeText } from './contract.js';
import type { TeamTaskAgentTag } from './accounts.js';
import { teamTaskLabelKey, type TeamTaskLabelRef, type TeamTaskSort } from './task-labels.js';
import { MATERIAL_CATEGORIES, type MaterialCategory } from './material-category.js';

/** Lightweight team task, progress, date-filter and attachment contracts. */

export const TEAM_TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const TEAM_TASK_PROGRESS_MAX = 10_000;
export const LIBRARY_ATTACH_MUTATION_BATCH_MAX = 100;
export const TEAM_TASK_PAGE_SIZE_MAX = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

/**
 * A task's description keeps its lines. `normalizeTeamFreeText` folds every
 * run of whitespace into one space — right for a title, wrong for a note that
 * someone laid out as a column of facts (offer, geo, budget, one per line).
 * Here only the spaces *within* a line are folded; line breaks stay, runs of
 * blank lines are capped at one blank line, and the ends are trimmed.
 */
export function normalizeTeamTaskNote(value: unknown, maxLength = 2_000): string | null {
  if (typeof value !== 'string') return null;
  const note = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return note.length >= 1 && note.length <= maxLength ? note : null;
}

/** A calendar day as the wire carries it: `YYYY-MM-DD`, and a real date. */
export function isTeamTaskDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return false;
  // Rejects the 31st of a 30-day month and a 29 February outside a leap year.
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The day a task is *for*: its own date when someone set one, the day it was
 * created otherwise. One helper, so the card, the editor and any later
 * grouping cannot disagree about which date a task shows.
 */
export function teamTaskDate(task: Pick<TeamTaskSummary, 'dateOn' | 'createdAt'>): string {
  if (task.dateOn) return task.dateOn;
  const created = new Date(task.createdAt);
  const year = created.getFullYear();
  const month = String(created.getMonth() + 1).padStart(2, '0');
  const day = String(created.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Newest first by the date a task is *for*, the same order the list RPC
 * returns. Two tasks on one day fall back to when they were made, so a page
 * merged on the client cannot reshuffle itself against the server's page.
 */
export function compareTeamTasksByDate(
  left: Pick<TeamTaskSummary, 'dateOn' | 'createdAt' | 'id'>,
  right: Pick<TeamTaskSummary, 'dateOn' | 'createdAt' | 'id'>
): number {
  const leftDay = teamTaskDate(left);
  const rightDay = teamTaskDate(right);
  if (leftDay !== rightDay) return leftDay < rightDay ? 1 : -1;
  const byCreated = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * By tag, then by date. A task's tag is its first one in natural order; the
 * ones carrying none fall to the end rather than to the front, because a board
 * ordered by tag is opened to read the tagged work.
 */
export function compareTeamTasksByLabel(
  left: Pick<TeamTaskSummary, 'dateOn' | 'createdAt' | 'id' | 'labels'>,
  right: Pick<TeamTaskSummary, 'dateOn' | 'createdAt' | 'id' | 'labels'>
): number {
  const leftKey = teamTaskLabelKey(left);
  const rightKey = teamTaskLabelKey(right);
  if (leftKey === null || rightKey === null) {
    if (leftKey !== rightKey) return leftKey === null ? 1 : -1;
  } else if (leftKey !== rightKey) {
    return leftKey.localeCompare(rightKey, undefined, { numeric: true, sensitivity: 'base' });
  }
  return compareTeamTasksByDate(left, right);
}

/** The comparator the board is currently ordered by. */
export function teamTaskComparator(sort: TeamTaskSort) {
  return sort === 'label' ? compareTeamTasksByLabel : compareTeamTasksByDate;
}

export interface TeamTaskPatch {
  title?: string;
  note?: string | null;
  assigneeId?: string | null;
  status?: TeamTaskStatus;
  progressMax?: number;
  progressValue?: number;
  /** The day the task is for; null puts it back to the day it was created. */
  dateOn?: string | null;
  expectedUpdatedAt?: string;
}

export function parseTeamTaskPatch(value: unknown): TeamTaskPatch | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length < 1 ||
    !hasOnlyKeys(value, [
      'title',
      'note',
      'dateOn',
      'assigneeId',
      'status',
      'progressMax',
      'progressValue',
      'expectedUpdatedAt'
    ])
  ) {
    return null;
  }

  const output: TeamTaskPatch = {};
  if ('title' in value) {
    const title = normalizeTeamFreeText(value.title, 160);
    if (!title) return null;
    output.title = title;
  }
  if ('note' in value) {
    if (value.note === null || value.note === '') {
      output.note = null;
    } else {
      const note = normalizeTeamTaskNote(value.note, 2_000);
      if (!note) return null;
      output.note = note;
    }
  }
  if ('dateOn' in value) {
    if (value.dateOn === null) output.dateOn = null;
    else if (isTeamTaskDate(value.dateOn)) output.dateOn = value.dateOn;
    else return null;
  }
  if ('assigneeId' in value) {
    if (value.assigneeId !== null && !isUuid(value.assigneeId)) return null;
    output.assigneeId = value.assigneeId;
  }
  if ('status' in value) {
    if (
      typeof value.status !== 'string' ||
      !(TEAM_TASK_STATUSES as readonly string[]).includes(value.status)
    ) {
      return null;
    }
    output.status = value.status as TeamTaskStatus;
  }
  if ('progressMax' in value) {
    if (
      typeof value.progressMax !== 'number' ||
      !Number.isInteger(value.progressMax) ||
      value.progressMax < 1 ||
      value.progressMax > TEAM_TASK_PROGRESS_MAX
    ) {
      return null;
    }
    output.progressMax = value.progressMax;
  }
  if ('progressValue' in value) {
    if (
      typeof value.progressValue !== 'number' ||
      !Number.isInteger(value.progressValue) ||
      value.progressValue < 0 ||
      value.progressValue > TEAM_TASK_PROGRESS_MAX
    ) {
      return null;
    }
    output.progressValue = value.progressValue;
  }
  if (
    output.progressMax !== undefined &&
    output.progressValue !== undefined &&
    output.progressValue > output.progressMax
  ) {
    return null;
  }
  if ('expectedUpdatedAt' in value) {
    if (
      typeof value.expectedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    ) {
      return null;
    }
    output.expectedUpdatedAt = value.expectedUpdatedAt;
  }
  return output;
}

export interface TeamTaskProgressState {
  status: TeamTaskStatus;
  progressMax: number;
  progressValue: number;
  progressManuallySet: boolean;
}

export function applyTaskProgressPatch(
  current: TeamTaskProgressState,
  patch: Pick<TeamTaskPatch, 'status' | 'progressMax' | 'progressValue'>
): TeamTaskProgressState {
  if (
    !(TEAM_TASK_STATUSES as readonly string[]).includes(current.status) ||
    !Number.isInteger(current.progressMax) ||
    current.progressMax < 1 ||
    current.progressMax > TEAM_TASK_PROGRESS_MAX ||
    !Number.isInteger(current.progressValue) ||
    current.progressValue < 0 ||
    current.progressValue > current.progressMax ||
    typeof current.progressManuallySet !== 'boolean'
  ) {
    throw new Error('INVALID_INPUT');
  }

  const status = patch.status ?? current.status;
  const progressMax = patch.progressMax ?? current.progressMax;
  const explicitValue = patch.progressValue !== undefined;
  let progressValue = explicitValue ? patch.progressValue! : current.progressValue;
  const progressManuallySet = current.progressManuallySet || explicitValue;

  if (
    !(TEAM_TASK_STATUSES as readonly string[]).includes(status) ||
    !Number.isInteger(progressMax) ||
    progressMax < 1 ||
    progressMax > TEAM_TASK_PROGRESS_MAX ||
    !Number.isInteger(progressValue) ||
    progressValue < 0 ||
    progressValue > progressMax
  ) {
    throw new Error('INVALID_INPUT');
  }

  if (status === 'done' && !progressManuallySet) progressValue = progressMax;
  return { status, progressMax, progressValue, progressManuallySet };
}

export interface TaskAttachmentMutation {
  teamId: string;
  taskId: string;
  materialIds: string[];
}

export function parseTaskAttachmentMutation(value: unknown): TaskAttachmentMutation | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['teamId', 'taskId', 'materialIds']) ||
    !isUuid(value.teamId) ||
    !isUuid(value.taskId) ||
    !Array.isArray(value.materialIds) ||
    value.materialIds.length < 1 ||
    value.materialIds.length > LIBRARY_ATTACH_MUTATION_BATCH_MAX
  ) {
    return null;
  }
  const materialIds: string[] = [];
  const seen = new Set<string>();
  for (const materialId of value.materialIds) {
    if (!isUuid(materialId)) return null;
    if (!seen.has(materialId)) {
      seen.add(materialId);
      materialIds.push(materialId);
    }
  }
  return { teamId: value.teamId, taskId: value.taskId, materialIds };
}

export interface TaskDayBounds {
  from: string;
  to: string;
}

export function localTaskDayBounds(localDate: string): TaskDayBounds {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (!match) throw new Error('INVALID_INPUT');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const from = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (from.getFullYear() !== year || from.getMonth() !== month - 1 || from.getDate() !== day) {
    throw new Error('INVALID_INPUT');
  }
  const to = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export interface TeamTaskSummary extends TeamTaskProgressState {
  id: string;
  teamId: string;
  title: string;
  note: string | null;
  assigneeId: string | null;
  assigneeLabelSnapshot: string | null;
  attachmentCount: number;
  /** The agents this task is tagged with (017): `[v31-434]`, with their live state. */
  agents: TeamTaskAgentTag[];
  /** The tags the team hung on it (018), in natural order by name. */
  labels: TeamTaskLabelRef[];
  /** The day the task is for; null means the day it was created. */
  dateOn: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type TeamTaskAttachmentAvailability = 'ready' | 'trashed' | 'missing' | 'unavailable';

export interface TeamTaskAttachmentSummary {
  id: string;
  taskId: string;
  materialId: string;
  name: string;
  category: MaterialCategory | null;
  /**
   * Whether the attachment is a folder. A dropped folder is attached as
   * itself — one tile for a landing rather than fifty for its files — and
   * every folder's category is null, so without this the tile said "File".
   */
  kind?: 'file' | 'folder' | 'shortcut';
  availability: TeamTaskAttachmentAvailability;
  previewState: 'ready' | 'pending' | 'unavailable';
  position: number;
  /**
   * The Drive revision of the file behind the attachment, when the server knew
   * one. It is the invalidation key of the re-stitch preparation cache, so a
   * download started from a task can reuse what a download started from the
   * explorer already worked out. A draft attachment — one the task has not
   * saved yet — has none, and simply pays the inspection once.
   */
  driveVersion: string | null;
}

export function parseTeamTaskAttachmentSummary(value: unknown): TeamTaskAttachmentSummary | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'taskId',
      'materialId',
      'name',
      'category',
      'kind',
      'availability',
      'previewState',
      'position',
      'driveVersion'
    ]) ||
    !isUuid(value.id) ||
    !isUuid(value.taskId) ||
    !isUuid(value.materialId) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 512 ||
    (value.category !== null &&
      (typeof value.category !== 'string' ||
        !(MATERIAL_CATEGORIES as readonly string[]).includes(value.category))) ||
    !['ready', 'trashed', 'missing', 'unavailable'].includes(value.availability as string) ||
    !['ready', 'pending', 'unavailable'].includes(value.previewState as string) ||
    typeof value.position !== 'number' ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0 ||
    (value.driveVersion !== null &&
      value.driveVersion !== undefined &&
      typeof value.driveVersion !== 'string')
  ) {
    return null;
  }
  return {
    id: value.id,
    taskId: value.taskId,
    materialId: value.materialId,
    name: value.name,
    category: value.category as MaterialCategory | null,
    // Absent from an older server: everything then reads as a file, which is
    // what it was before folders could be attached at all.
    kind:
      value.kind === 'folder' || value.kind === 'shortcut' || value.kind === 'file'
        ? value.kind
        : undefined,
    availability: value.availability as TeamTaskAttachmentAvailability,
    previewState: value.previewState as TeamTaskAttachmentSummary['previewState'],
    position: value.position,
    // Absent from an older server; the download simply does its own inspecting.
    driveVersion: typeof value.driveVersion === 'string' ? value.driveVersion : null
  };
}
