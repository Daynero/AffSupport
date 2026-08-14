import { isRecord, normalizeTeamFreeText } from './contract.js';
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

export interface TeamTaskPatch {
  title?: string;
  note?: string | null;
  assigneeId?: string | null;
  status?: TeamTaskStatus;
  progressMax?: number;
  progressValue?: number;
  expectedUpdatedAt?: string;
}

export function parseTeamTaskPatch(value: unknown): TeamTaskPatch | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length < 1 ||
    !hasOnlyKeys(value, [
      'title',
      'note',
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
      const note = normalizeTeamFreeText(value.note, 2_000);
      if (!note) return null;
      output.note = note;
    }
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
  availability: TeamTaskAttachmentAvailability;
  previewState: 'ready' | 'pending' | 'unavailable';
  position: number;
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
      'availability',
      'previewState',
      'position'
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
    value.position < 0
  ) {
    return null;
  }
  return {
    id: value.id,
    taskId: value.taskId,
    materialId: value.materialId,
    name: value.name,
    category: value.category as MaterialCategory | null,
    availability: value.availability as TeamTaskAttachmentAvailability,
    previewState: value.previewState as TeamTaskAttachmentSummary['previewState'],
    position: value.position
  };
}
