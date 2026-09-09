import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { teamTaskDate } from '@video-compressor/shared';
import type {
  TeamTaskAgentTag,
  TeamTaskAttachmentSummary,
  TeamTaskLabel,
  TeamTaskLabelRef,
  TeamTaskPatch,
  TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  attachTaskMaterialsInChunks,
  TaskAttachmentPicker,
  type TaskAttachmentCandidate,
  type TaskAttachmentPickerClient
} from './TaskAttachmentPicker';
import { TaskAttachmentTile, type TaskAttachmentPreviewClient } from './TaskAttachmentTile';
import { useTeam } from '../TeamContext';
import { buildTeamRoute } from '../routes';
import { navigateTo } from '../../lib/navigation';
import { useRestitchDelivery } from '../restitch/useRestitchDelivery';
import { RestitchDeliveryNotices } from '../restitch/RestitchDeliveryNotices';
import { TaskProgressScale } from './TaskProgressScale';
import { TaskStatusControl } from './TaskStatusControl';
import { TaskAgentTagsEditor, type TaskAgentTagsClient } from './TaskAgentTags';
import { TaskLabelsEditor, type TaskLabelsEditorClient } from './TaskLabelsEditor';
import { TaskDateField } from './TaskDateField';
import { useToasts } from '../../components/toast';
import { uploadTeamFile } from '../catalog/material-actions-client';
import { classifyMaterial } from '@video-compressor/shared';
import { teamErrorMessageFor } from '../errors';

export interface TaskEditorClient
  extends
    TaskAttachmentPickerClient,
    TaskAttachmentPreviewClient,
    TaskAgentTagsClient,
    TaskLabelsEditorClient {
  getTask(input: {
    teamId: string;
    taskId: string;
    attachmentCursor?: number | null;
    attachmentPageSize?: number;
  }): Promise<{ task: TeamTaskSummary; attachments: TeamTaskAttachmentSummary[] }>;
  updateTask(teamId: string, taskId: string, patch: TeamTaskPatch): Promise<TeamTaskSummary>;
  detachTaskMaterial(teamId: string, taskId: string, materialId: string): Promise<boolean>;
  /** The space's one folder for dropped files; made on first use (011). */
  ensureTaskDropFolder?: (
    teamId: string
  ) => Promise<{ folderId: string; materialId: string; name: string; created: boolean }>;
  uploadFile?: (input: {
    teamId: string;
    destinationFolderId: string | null;
    file: File;
    conflictMode: 'cancel' | 'keep_both';
    replaceMaterialId: string | null;
    versionOfMaterialId: string | null;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
  }) => Promise<{ materialId: string | null }>;
}

const defaultClient: TaskEditorClient = { ...teamApi, uploadFile: uploadTeamFile };
const TASK_PROGRESS_MAX = 10_000;

/**
 * A browser may discard a background tab and recreate the page when it is
 * restored. Keeping an unsaved form only in React state made that lifecycle
 * look like somebody had chosen to discard their work. This tab-local draft
 * survives a discard/reload, without claiming it was saved to the team.
 */
const TASK_DRAFT_STORAGE_PREFIX = 'soty.team-task-draft.v1:';

type TaskFormDraft = Pick<
  TeamTaskSummary,
  'title' | 'note' | 'assigneeId' | 'dateOn' | 'progressMax' | 'progressValue'
>;

function taskDraftKey(teamId: string, taskId: string): string {
  return `${TASK_DRAFT_STORAGE_PREFIX}${teamId}:${taskId}`;
}

function readTaskFormDraft(teamId: string, task: TeamTaskSummary): TaskFormDraft | null {
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(taskDraftKey(teamId, task.id)) ?? ''
    );
    if (!value || typeof value !== 'object') return null;
    const draft = value as Partial<TaskFormDraft>;
    if (
      typeof draft.title !== 'string' ||
      (draft.note !== null && typeof draft.note !== 'string') ||
      (draft.assigneeId !== null && typeof draft.assigneeId !== 'string') ||
      (draft.dateOn !== null && typeof draft.dateOn !== 'string') ||
      !Number.isInteger(draft.progressMax) ||
      !Number.isInteger(draft.progressValue)
    ) {
      return null;
    }
    return {
      title: draft.title,
      note: draft.note,
      assigneeId: draft.assigneeId,
      dateOn: draft.dateOn,
      progressMax: draft.progressMax as number,
      progressValue: draft.progressValue as number
    };
  } catch {
    return null;
  }
}

function writeTaskFormDraft(teamId: string, taskId: string, draft: TaskFormDraft): void {
  try {
    window.sessionStorage.setItem(taskDraftKey(teamId, taskId), JSON.stringify(draft));
  } catch {
    // Storage is a recovery aid; private-mode restrictions must not block editing.
  }
}

function clearTaskFormDraft(teamId: string, taskId: string): void {
  try {
    window.sessionStorage.removeItem(taskDraftKey(teamId, taskId));
  } catch {
    // The editor remains fully usable when browser storage is unavailable.
  }
}

function uniqueAttachments(
  current: TeamTaskAttachmentSummary[],
  incoming: TeamTaskAttachmentSummary[]
) {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.position - right.position);
}

/**
 * What a drop actually holds: loose files, and folders to walk into.
 *
 * `webkitGetAsEntry()` is only valid while the drop event is being handled,
 * which is why this is read synchronously and the walking happens after.
 * Without it a folder is indistinguishable from a zero-byte file.
 */
function droppedEntries(data: DataTransfer): {
  files: File[];
  folders: FileSystemDirectoryEntry[];
} {
  const files: File[] = [];
  const folders: FileSystemDirectoryEntry[] = [];
  const items = Array.from(data.items ?? []);
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      folders.push(entry as FileSystemDirectoryEntry);
      continue;
    }
    const file = item.getAsFile?.() ?? null;
    if (file) files.push(file);
  }
  // A browser that hands over no items at all still hands over files.
  if (items.length === 0) files.push(...Array.from(data.files));
  return { files, folders };
}

/** One directory's children, read to the end — the API pages them. */
function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const step = () =>
      reader.readEntries(batch => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, reject);
    step();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => entry.file(resolve, () => resolve(null)));
}

/** A drop of files, rather than a row being dragged from the explorer. */
function canDrop(event: { dataTransfer: DataTransfer | null }): boolean {
  return Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'));
}

function draftAttachment(
  taskId: string,
  material: TaskAttachmentCandidate,
  position: number
): TeamTaskAttachmentSummary {
  return {
    id: `draft:${material.id}`,
    taskId,
    materialId: material.id,
    name: material.name,
    category: material.category,
    availability: 'ready',
    previewState:
      material.previewState === 'unavailable'
        ? 'unavailable'
        : material.previewState === 'pending'
          ? 'pending'
          : 'ready',
    position,
    // A draft has no Drive revision to hand: the material came from the picker,
    // which lists summaries. It is the key to the re-stitch cache, so a
    // download from a draft attachment inspects the file itself, once.
    driveVersion: null
  };
}

export function TaskEditor({
  teamId,
  task: initialTask,
  members,
  canEdit,
  client = defaultClient,
  labels = [],
  onClose,
  onChanged,
  onTagsChange,
  onLabelsChange,
  onDelete
}: {
  teamId: string;
  task: TeamTaskSummary;
  members: TeamMemberSummary[];
  canEdit: boolean;
  client?: TaskEditorClient;
  /** The space's tag dictionary (018), for the picker. */
  labels?: readonly TeamTaskLabel[];
  onClose: () => void;
  onChanged: (task: TeamTaskSummary) => void;
  /** The tags changed (017) — written at once, unlike the staged form. */
  onTagsChange?: (tags: TeamTaskAgentTag[]) => void;
  /** The team's own tags changed (018), also written at once. */
  onLabelsChange?: (labels: TeamTaskLabelRef[]) => void;
  /** Deletes the task; absent when the viewer may not. */
  onDelete?: (task: TeamTaskSummary) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push, update } = useToasts();
  const { can } = useTeam();
  /**
   * A re-stitched download of an attached video, from this editor. The same
   * delivery the explorer runs — one at a time, the folder remembered per
   * space, the preparation record shared — so a video reached through a task
   * costs no more than the same video reached through the file list.
   */
  const restitch = useRestitchDelivery(teamId);
  /*
   * A space with no re-stitch defaults is not a failure: the notice offers the
   * way in, and the settings live over the file list. Leaving the editor for
   * them loses nothing — the delivery remembers what was asked for and the
   * shell resumes it once the settings close.
   */
  const openRestitchSettings = () => {
    const href = buildTeamRoute({
      spaceId: teamId,
      section: 'explorer',
      query: { settings: true }
    });
    onClose();
    navigateTo(href);
  };
  const deliverRestitched = (attachment: TeamTaskAttachmentSummary) => {
    void restitch
      .deliver({
        materialId: attachment.materialId,
        fileName: attachment.name,
        driveVersion: attachment.driveVersion
      })
      .catch(() => {
        // The delivery reports its own outcome through the notices below.
      });
  };
  const [restoredDraft] = useState(() => readTaskFormDraft(teamId, initialTask));
  const [task, setTask] = useState(initialTask);
  const [title, setTitle] = useState(restoredDraft?.title ?? initialTask.title);
  const [note, setNote] = useState(restoredDraft?.note ?? initialTask.note ?? '');
  const [status, setStatus] = useState(initialTask.status);
  const [assigneeId, setAssigneeId] = useState(
    restoredDraft?.assigneeId ?? initialTask.assigneeId ?? ''
  );
  /** The day the task is for; null is "the day it was created". */
  const [dateOn, setDateOn] = useState<string | null>(restoredDraft?.dateOn ?? initialTask.dateOn);
  const [progressMax, setProgressMax] = useState(
    restoredDraft?.progressMax ?? initialTask.progressMax
  );
  const [progressMaxInput, setProgressMaxInput] = useState(
    String(restoredDraft?.progressMax ?? initialTask.progressMax)
  );
  const [progressValue, setProgressValue] = useState(
    restoredDraft?.progressValue ?? initialTask.progressValue
  );
  const [persistedAttachments, setPersistedAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [detachedMaterialIds, setDetachedMaterialIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * What went wrong last, if anything: reading the task, or writing it.
   *
   * One boolean said "could not save your last changes" for both, so a failed
   * *read* — a re-read while a big upload was using the connection, say —
   * accused the person of losing edits they had not made. The upload itself
   * reports through its own tile and toast.
   */
  const [error, setError] = useState<'read' | 'write' | null>(null);
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The account-wide default for a new task's Maximum. When the field differs
  // from it, a small save control offers to make the current value the default.
  const [defaultMax, setDefaultMax] = useState<number | null>(null);
  const [savingDefaultMax, setSavingDefaultMax] = useState(false);

  useEffect(() => {
    let active = true;
    void teamApi
      .getTaskProgressMaxDefault()
      .then(value => {
        if (active) setDefaultMax(value);
      })
      .catch(() => {
        if (active) setDefaultMax(null);
      });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Refresh the form from the server's copy — but never over typing. The
   * first read resolves after the editor opens, and a person who started on
   * the title at once had it wiped by a slow round trip. Each field is
   * replaced only while it still holds the value the editor opened with;
   * anything edited in the meantime stays.
   */
  const hydrateTask = (next: TeamTaskSummary) => {
    setTask(next);
    setTitle(current => (current === initialTask.title ? next.title : current));
    setNote(current => (current === (initialTask.note ?? '') ? (next.note ?? '') : current));
    setStatus(current => (current === initialTask.status ? next.status : current));
    setAssigneeId(current =>
      current === (initialTask.assigneeId ?? '') ? (next.assigneeId ?? '') : current
    );
    setDateOn(current => (current === initialTask.dateOn ? next.dateOn : current));
    setProgressMax(current => (current === initialTask.progressMax ? next.progressMax : current));
    setProgressMaxInput(current =>
      current === String(initialTask.progressMax) ? String(next.progressMax) : current
    );
    setProgressValue(current =>
      current === initialTask.progressValue ? next.progressValue : current
    );
  };

  const load = useCallback(
    async ({
      hydrate = false,
      resetAttachmentDraft = false,
      quiet = false
    }: { hydrate?: boolean; resetAttachmentDraft?: boolean; quiet?: boolean } = {}) => {
      // A quiet read is a re-read behind an unchanged screen: the settle loop
      // below runs several of them, and each one flashing "Loading…" over a
      // dialog somebody is typing in would be worse than the stale word it is
      // replacing.
      if (!quiet) setLoading(true);
      try {
        const value = await client.getTask({ teamId, taskId: task.id, attachmentPageSize: 50 });
        if (hydrate) hydrateTask(value.task);
        else setTask(value.task);
        if (resetAttachmentDraft) {
          setPersistedAttachments(value.attachments);
          setDraftAttachments([]);
          setDetachedMaterialIds(new Set());
        } else {
          setPersistedAttachments(current => uniqueAttachments(current, value.attachments));
        }
        setError(null);
      } catch {
        setError('read');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [client, task.id, teamId]
  );

  useEffect(() => {
    void load({ hydrate: true, resetAttachmentDraft: true });
  }, [load]);

  const visibleAttachments = useMemo(
    () => [
      ...persistedAttachments.filter(attachment => !detachedMaterialIds.has(attachment.materialId)),
      ...draftAttachments
    ],
    [detachedMaterialIds, draftAttachments, persistedAttachments]
  );
  const visibleMaterialIds = useMemo(
    () => new Set(visibleAttachments.map(attachment => attachment.materialId)),
    [visibleAttachments]
  );
  /**
   * The server keeps working after an upload lands.
   *
   * A .zip is stored as an archive and only *becomes* a landing once the
   * inspection has looked inside it; a picture gets its thumbnail a moment
   * later. The tile that appeared at upload time knows none of that, so it sat
   * there saying "Archive · preview unavailable" for a landing the space had
   * already recognised — and only a reopened dialog ever showed otherwise.
   * This re-reads, quietly and a few times, while anything is still unsettled.
   */
  const unsettled = visibleAttachments.some(
    attachment =>
      !attachment.id.startsWith('draft:') &&
      (attachment.previewState === 'pending' || attachment.category === 'archive')
  );
  const settleAttempts = useRef(0);
  useEffect(() => {
    if (!unsettled) {
      settleAttempts.current = 0;
      return;
    }
    if (settleAttempts.current >= 6) return;
    const timer = window.setTimeout(() => {
      settleAttempts.current += 1;
      void load({ quiet: true });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [load, unsettled, persistedAttachments]);

  const attachmentCount = Math.max(
    0,
    task.attachmentCount - detachedMaterialIds.size + draftAttachments.length
  );
  const formDirty =
    title !== task.title ||
    note !== (task.note ?? '') ||
    assigneeId !== (task.assigneeId ?? '') ||
    dateOn !== task.dateOn ||
    progressMax !== task.progressMax ||
    progressValue !== task.progressValue;
  const attachmentDirty = draftAttachments.length > 0 || detachedMaterialIds.size > 0;
  // Status has an immediate server write and therefore intentionally does not make this dirty.
  const hasUnsavedChanges = canEdit && (formDirty || attachmentDirty);

  useEffect(() => {
    if (!canEdit || !formDirty) return;
    writeTaskFormDraft(teamId, task.id, {
      title,
      note: note || null,
      assigneeId: assigneeId || null,
      dateOn,
      progressMax,
      progressValue
    });
  }, [
    assigneeId,
    canEdit,
    dateOn,
    formDirty,
    note,
    progressMax,
    progressValue,
    task.id,
    teamId,
    title
  ]);

  const loadMore = async () => {
    const cursor = persistedAttachments.at(-1)?.position;
    if (cursor === undefined) return;
    setLoadingMore(true);
    try {
      const value = await client.getTask({
        teamId,
        taskId: task.id,
        attachmentCursor: cursor,
        attachmentPageSize: 50
      });
      setPersistedAttachments(current => uniqueAttachments(current, value.attachments));
      setError(null);
    } catch {
      setError('read');
    } finally {
      setLoadingMore(false);
    }
  };

  const addAttachments = (materials: TaskAttachmentCandidate[]) => {
    const persistedIds = new Set(persistedAttachments.map(attachment => attachment.materialId));
    const reattachedIds = new Set(
      materials.filter(item => persistedIds.has(item.id)).map(item => item.id)
    );
    if (reattachedIds.size > 0) {
      setDetachedMaterialIds(current => {
        const next = new Set(current);
        for (const id of reattachedIds) next.delete(id);
        return next;
      });
    }
    setDraftAttachments(current => {
      const known = new Set([...persistedIds, ...current.map(attachment => attachment.materialId)]);
      const additions = materials.filter(material => !known.has(material.id));
      if (additions.length === 0) return current;
      const position = Math.max(
        -1,
        ...persistedAttachments.map(attachment => attachment.position),
        ...current.map(attachment => attachment.position)
      );
      return [
        ...current,
        ...additions.map((material, index) =>
          draftAttachment(task.id, material, position + index + 1)
        )
      ];
    });
  };

  /**
   * Files dropped on the attachment area.
   *
   * They go to one folder in the space's root — the same one for every task,
   * made on first use — because "which folder does this screenshot belong in?"
   * is a question with no useful answer, and the task's own list is what gives
   * the file its meaning. Each upload is attached the moment it lands, so a
   * long drop fills the grid as it goes rather than at the end.
   */
  const [dropping, setDropping] = useState(false);
  /**
   * What is in flight, in order, with how far each has got.
   *
   * A tile per file, not a number in a corner: a video takes half a minute
   * through the relay, and for that half minute the only honest answer to
   * "is this working?" is the file's own name with a bar under it. The count
   * alone left a person watching a dialog that looked idle.
   */
  const [uploads, setUploads] = useState<
    { id: string; name: string; sent: number; total: number }[]
  >([]);
  const dropDepth = useRef(0);

  /** How many files one drop may carry: a mis-drop of a home folder is not a task. */
  const MAX_DROPPED_FILES = 200;

  const uploadDropped = async (
    files: File[],
    folders: FileSystemDirectoryEntry[] = []
  ): Promise<void> => {
    if ((files.length === 0 && folders.length === 0) || !canEdit || !can('upload')) return;
    /*
     * The seam is for tests; the real screens hand this editor the shared
     * `teamApi`, which is a different object from `defaultClient` — so a drop
     * did nothing at all on every screen that passes its own client. The
     * fallback is the production path, not a nicety.
     */
    const ensureFolder = client.ensureTaskDropFolder ?? teamApi.ensureTaskDropFolder;
    const sendFile = client.uploadFile ?? uploadTeamFile;

    let root: { materialId: string };
    try {
      root = await ensureFolder(teamId);
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      return;
    }

    /** Sends one file into a folder and returns the material it became. */
    const sendOne = async (file: File, destinationMaterialId: string): Promise<string | null> => {
      const tracking = {
        id: `${Date.now()}:${file.name}:${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        sent: 0,
        total: file.size
      };
      setUploads(current => [...current, tracking]);
      const notice = push({
        tone: 'info',
        sticky: true,
        text: t('teamTaskAttachmentUploading', { name: file.name })
      });
      try {
        const uploaded = await sendFile({
          teamId,
          destinationFolderId: destinationMaterialId,
          file,
          conflictMode: 'keep_both',
          replaceMaterialId: null,
          versionOfMaterialId: null,
          onProgress: (sent, total) =>
            setUploads(current =>
              current.map(item => (item.id === tracking.id ? { ...item, sent, total } : item))
            )
        });
        if (!uploaded.materialId) throw new Error('INVALID_RESPONSE');
        update(notice, {
          tone: 'success',
          sticky: false,
          text: t('teamTaskAttachmentUploaded', { name: file.name })
        });
        return uploaded.materialId;
      } catch (cause) {
        update(notice, {
          tone: 'error',
          sticky: false,
          text: t('teamTaskAttachmentUploadFailed', {
            name: file.name,
            reason: teamErrorMessageFor(cause, t)
          })
        });
        return null;
      } finally {
        setUploads(current => current.filter(item => item.id !== tracking.id));
      }
    };

    /** Writes the link and puts the tile on screen, as a real attachment. */
    const attachOne = async (input: {
      materialId: string;
      name: string;
      category: TeamTaskAttachmentSummary['category'];
      kind?: TeamTaskAttachmentSummary['kind'];
    }) => {
      const attached = await attachTaskMaterialsInChunks({
        client,
        teamId,
        taskId: task.id,
        materialIds: [input.materialId]
      });
      if (attached.rejected.length > 0) {
        push({
          tone: 'error',
          text: t('teamTaskAttachmentUploadFailed', {
            name: input.name,
            reason: attached.rejected[0]?.code ?? 'REJECTED'
          })
        });
        return;
      }
      setPersistedAttachments(current =>
        uniqueAttachments(current, [
          {
            id: `${task.id}:${input.materialId}`,
            taskId: task.id,
            materialId: input.materialId,
            name: input.name,
            category: input.category,
            kind: input.kind ?? 'file',
            availability: 'ready',
            previewState: 'pending',
            position: current.length,
            driveVersion: null
          }
        ])
      );
      setTask(current => ({ ...current, attachmentCount: current.attachmentCount + 1 }));
      // A drop that worked clears whatever the last failure was saying: an
      // error line left over from a re-read that timed out during the upload
      // is exactly the thing that made a working upload look broken.
      setError(null);
    };

    const fileCategory = (file: File) =>
      classifyMaterial({
        kind: 'file',
        mimeType: file.type || null,
        fileExtension: file.name.includes('.') ? (file.name.split('.').pop() ?? null) : null
      }).category ?? null;

    /*
     * A dropped folder stays a folder.
     *
     * A landing is a tree of files that only works whole, so flattening it into
     * the drawer would deliver something that no longer opens. The tree is
     * rebuilt under the drop folder — one Drive folder per directory — and the
     * *folder* is what the task gets attached, as one tile rather than fifty.
     */
    const copyFolder = async (
      directory: FileSystemDirectoryEntry,
      parentMaterialId: string,
      budget: { left: number }
    ): Promise<void> => {
      const made = await ensureFolder(teamId, { name: directory.name, parentMaterialId });
      const children = await readEntries(directory.createReader());
      for (const child of children) {
        if (budget.left <= 0) return;
        if (child.isDirectory) {
          await copyFolder(child as FileSystemDirectoryEntry, made.materialId, budget);
          continue;
        }
        const file = await entryFile(child as FileSystemFileEntry);
        if (!file) continue;
        budget.left -= 1;
        await sendOne(file, made.materialId);
      }
      if (parentMaterialId === root.materialId) {
        await attachOne({
          materialId: made.materialId,
          name: made.name,
          category: null,
          kind: 'folder'
        });
      }
    };

    const budget = { left: MAX_DROPPED_FILES };
    for (const folder of folders) {
      try {
        await copyFolder(folder, root.materialId, budget);
      } catch (cause) {
        push({
          tone: 'error',
          text: t('teamTaskAttachmentUploadFailed', {
            name: folder.name,
            reason: teamErrorMessageFor(cause, t)
          })
        });
      }
    }
    for (const file of files) {
      if (budget.left <= 0) {
        push({
          tone: 'error',
          text: t('teamTaskAttachmentDropTooMany', { count: MAX_DROPPED_FILES })
        });
        break;
      }
      budget.left -= 1;
      const materialId = await sendOne(file, root.materialId);
      if (materialId) {
        await attachOne({ materialId, name: file.name, category: fileCategory(file) });
      }
    }
    if (budget.left <= 0 && folders.length > 0) {
      push({
        tone: 'error',
        text: t('teamTaskAttachmentDropTooMany', { count: MAX_DROPPED_FILES })
      });
    }
  };

  /**
   * Detaching is staged, not written — the change lands when the task is saved.
   * The toast makes that reversibility visible, which is what the confirmation
   * dialog was standing in for; a dialog guarding a staged, undoable change was
   * friction charged twice over (finding R3, FR-028).
   */
  const stageDetach = (attachment: TeamTaskAttachmentSummary) => {
    if (attachment.id.startsWith('draft:')) {
      setDraftAttachments(current =>
        current.filter(candidate => candidate.materialId !== attachment.materialId)
      );
      push({
        tone: 'info',
        text: t('teamToastAttachmentDetached', { name: attachment.name }),
        action: {
          label: t('teamUndo'),
          run: () =>
            setDraftAttachments(current =>
              current.some(candidate => candidate.materialId === attachment.materialId)
                ? current
                : [...current, attachment]
            )
        }
      });
      return;
    }
    setDetachedMaterialIds(current => new Set(current).add(attachment.materialId));
    push({
      tone: 'info',
      text: t('teamToastAttachmentDetached', { name: attachment.name }),
      action: {
        label: t('teamUndo'),
        run: () =>
          setDetachedMaterialIds(current => {
            const next = new Set(current);
            next.delete(attachment.materialId);
            return next;
          })
      }
    });
  };

  const updateProgressMax = (raw: string) => {
    setProgressMaxInput(raw);
    if (!/^\d+$/u.test(raw)) return;
    const normalized = Math.min(TASK_PROGRESS_MAX, Math.max(1, Number(raw)));
    /*
     * The value moves with the scale rather than being cut down to fit it: 90
     * of 100 becomes 9 of 10, which is the same progress said in a different
     * unit. Clamping instead reported the task as finished — 10 of 10 — for
     * the sake of a change that was about the unit, not the work.
     */
    setProgressValue(current => {
      const previous = Math.max(1, progressMax);
      const scaled = Math.round((current / previous) * normalized);
      return Math.min(normalized, Math.max(0, scaled));
    });
    setProgressMax(normalized);
    if (String(normalized) !== raw) setProgressMaxInput(String(normalized));
  };

  const save = async () => {
    if (!canEdit || saving || savingStatus) return;
    setSaving(true);
    setError(null);
    try {
      let updated = task;
      if (formDirty) {
        const response = await client.updateTask(teamId, task.id, {
          title,
          note: note || null,
          assigneeId: assigneeId || null,
          dateOn,
          progressMax,
          progressValue,
          expectedUpdatedAt: task.updatedAt
        });
        // The update RPC returns the physical row, while attachmentCount is
        // derived by the read RPC. Keep the known count while this editor stays open.
        updated = { ...response, attachmentCount: task.attachmentCount, agents: task.agents };
        setTask(updated);
      }
      if (draftAttachments.length > 0) {
        const result = await attachTaskMaterialsInChunks({
          client,
          teamId,
          taskId: task.id,
          materialIds: draftAttachments.map(attachment => attachment.materialId)
        });
        if (result.rejected.length > 0) throw new Error('ATTACHMENT_REJECTED');
      }
      for (const materialId of detachedMaterialIds) {
        await client.detachTaskMaterial(teamId, task.id, materialId);
      }
      onChanged({ ...updated, attachmentCount });
      clearTaskFormDraft(teamId, task.id);
      onClose();
    } catch {
      setError('write');
    } finally {
      setSaving(false);
    }
  };

  const saveFromSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  const saveStatus = async (next: TeamTaskSummary['status']) => {
    if (!canEdit || next === status || savingStatus || saving) return;
    const previousTask = task;
    const previousStatus = status;
    setStatus(next);
    setSavingStatus(true);
    setError(null);
    try {
      const response = await client.updateTask(teamId, task.id, {
        status: next,
        expectedUpdatedAt: previousTask.updatedAt
      });
      const updated = {
        ...response,
        attachmentCount: previousTask.attachmentCount,
        agents: previousTask.agents
      };
      setTask(updated);
      // Preserve a locally edited scale; otherwise reflect automatic completion progress.
      setProgressMax(current =>
        current === previousTask.progressMax ? updated.progressMax : current
      );
      setProgressValue(current =>
        current === previousTask.progressValue ? updated.progressValue : current
      );
      onChanged({ ...updated, attachmentCount: task.attachmentCount });
    } catch {
      setStatus(previousStatus);
      setError('write');
    } finally {
      setSavingStatus(false);
    }
  };

  const requestClose = () => {
    if (hasUnsavedChanges) {
      setShowUnsavedPrompt(true);
      return;
    }
    onClose();
  };

  const discardAndClose = () => {
    clearTaskFormDraft(teamId, task.id);
    onClose();
  };

  return (
    <>
      <Modal
        labelledBy="team-task-editor-title"
        onClose={requestClose}
        closeLabel={t('teamCancel')}
        initialFocus="#team-task-title"
        size="lg"
      >
        <div className="team-task-editor">
          <form className="team-dialog-form" onSubmit={saveFromSubmit}>
            <h2 id="team-task-editor-title">{t('teamTaskEditTitle')}</h2>
            <section className="team-task-editor-status" aria-labelledby="team-task-status-title">
              <span id="team-task-status-title">{t('teamTaskStatus')}</span>
              <TaskStatusControl
                value={status}
                disabled={!canEdit || saving || savingStatus}
                onChange={next => void saveStatus(next)}
              />
              {/* The date the task is for, where the card shows it: at the end
                  of the status line. It saves with the form, like the title. */}
              <TaskDateField
                value={teamTaskDate({ dateOn, createdAt: task.createdAt })}
                isCustom={dateOn !== null}
                createdOn={teamTaskDate({ dateOn: null, createdAt: task.createdAt })}
                disabled={!canEdit}
                onChange={setDateOn}
              />
            </section>
            {/* The accounts this task is about (017). Written at once, like
                status: a tag is a fact about the task, not a draft of one. */}
            <TaskAgentTagsEditor
              teamId={teamId}
              taskId={task.id}
              taskTitle={title}
              tags={task.agents}
              canEdit={canEdit}
              client={client}
              onTagsChange={agents => {
                setTask(current => ({ ...current, agents }));
                onTagsChange?.(agents);
              }}
            />
            {/* The team's own tags (018), from the dictionary in settings. */}
            <TaskLabelsEditor
              teamId={teamId}
              taskId={task.id}
              labels={task.labels}
              available={labels}
              canEdit={canEdit}
              client={client}
              onLabelsChange={next => {
                setTask(current => ({ ...current, labels: next }));
                onLabelsChange?.(next);
              }}
            />
            <label>
              <span>{t('teamTaskTitle')}</span>
              <input
                id="team-task-title"
                value={title}
                maxLength={160}
                required
                disabled={!canEdit}
                /* A brand-new task opens with a stand-in name; selecting it
                   means the first thing typed replaces it instead of landing
                   after it. */
                onFocus={event => {
                  if (event.target.value === t('teamTaskUntitled')) event.target.select();
                }}
                onChange={event => setTitle(event.target.value)}
              />
            </label>
            <div className="team-task-editor-meta">
              <label className="team-task-assignee-field">
                <span>{t('teamTaskAssignee')}</span>
                <select
                  value={assigneeId}
                  disabled={!canEdit}
                  onChange={event => setAssigneeId(event.target.value)}
                >
                  <option value="">{t('teamTaskUnassigned')}</option>
                  {members.map(member => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName ?? member.email ?? member.userId}
                    </option>
                  ))}
                </select>
              </label>
              <label className="team-task-progress-max-field">
                <span>{t('teamTaskProgressMax')}</span>
                <div className="team-task-progress-max-input">
                  <input
                    inputMode="numeric"
                    type="number"
                    min={1}
                    max={TASK_PROGRESS_MAX}
                    value={progressMaxInput}
                    disabled={!canEdit}
                    onChange={event => updateProgressMax(event.target.value)}
                    onBlur={() => {
                      if (!/^\d+$/u.test(progressMaxInput))
                        setProgressMaxInput(String(progressMax));
                    }}
                  />
                  {canEdit && defaultMax !== null && progressMax !== defaultMax && (
                    <button
                      type="button"
                      className="team-task-progress-max-save"
                      disabled={savingDefaultMax}
                      title={t('teamTaskProgressMaxSaveDefault')}
                      aria-label={t('teamTaskProgressMaxSaveDefault')}
                      onClick={async () => {
                        setSavingDefaultMax(true);
                        try {
                          await teamApi.setTaskProgressMaxDefault(progressMax);
                          setDefaultMax(progressMax);
                          push({ tone: 'success', text: t('teamTaskProgressMaxSaved') });
                        } catch {
                          push({ tone: 'error', text: t('teamTaskAttachmentActionFailed') });
                        } finally {
                          setSavingDefaultMax(false);
                        }
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path
                          d="M5 3h11l3 3v15H5z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M8 3v6h7V3M8 21v-6h8v6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </label>
            </div>
            <TaskProgressScale
              value={progressValue}
              max={progressMax}
              disabled={!canEdit}
              label={t('teamTaskProgressScale')}
              onChange={setProgressValue}
            />
            <label>
              <span>{t('teamTaskDescription')}</span>
              <textarea
                className="team-task-description-input"
                rows={12}
                value={note}
                maxLength={2_000}
                disabled={!canEdit}
                onChange={event => setNote(event.target.value)}
              />
            </label>
            {error && (
              <p className="team-inline-error">
                {t(error === 'read' ? 'teamTaskReadFailed' : 'teamTaskSaveFailed')}
              </p>
            )}
            {canEdit && (
              <div className="team-dialog-actions">
                <Button type="submit" variant="primary" loading={saving} disabled={savingStatus}>
                  {t('teamTaskSave')}
                </Button>
                {/* Deleting a task was the one lifecycle step with no way to
                    take it — a finished or mistaken task stayed on the board
                    forever (finding R1). */}
                {onDelete && (
                  <Button type="button" variant="danger" onClick={() => setConfirmingDelete(true)}>
                    {t('teamTaskDelete')}
                  </Button>
                )}
              </div>
            )}
          </form>

          <RestitchDeliveryNotices
            states={restitch.states}
            onConfigure={can('manage_metadata') ? openRestitchSettings : null}
          />
          {/* The whole section takes a drop, not a small strip inside it: a
              person aims at "the attachments", and a target the size of the
              thing it is named after cannot be missed. */}
          <section
            className={`team-task-attachments${dropping ? ' is-dropping' : ''}`}
            aria-labelledby="team-task-attachments-title"
            onDragEnter={event => {
              if (!canDrop(event)) return;
              event.preventDefault();
              dropDepth.current += 1;
              setDropping(true);
            }}
            onDragOver={event => {
              if (!canDrop(event)) return;
              // Without this the browser opens the file instead, which loses
              // the task and everything typed into it.
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={() => {
              // Counted, not toggled: dragging over a tile inside the section
              // fires `leave` for the section itself.
              dropDepth.current = Math.max(0, dropDepth.current - 1);
              if (dropDepth.current === 0) setDropping(false);
            }}
            onDrop={event => {
              if (!canDrop(event)) return;
              event.preventDefault();
              dropDepth.current = 0;
              setDropping(false);
              // Read synchronously: `webkitGetAsEntry` is only valid for the
              // duration of the event, and it is the only way to tell a folder
              // from a file before trying to send it.
              /*
               * Entries, not `files`: a folder is in `files` too, as a
               * zero-byte record that would upload as an empty file of that
               * name. The entries are the only way to walk into it, and they
               * are only valid for the length of this event.
               */
              const dropped = droppedEntries(event.dataTransfer);
              void uploadDropped(dropped.files, dropped.folders);
            }}
          >
            <div className="team-task-attachments-heading">
              <div>
                <h3 id="team-task-attachments-title">{t('teamTaskAttachments')}</h3>
                <p>
                  {canEdit && can('upload')
                    ? t('teamTaskAttachmentsDropHint')
                    : t('teamTaskAttachmentsHint')}
                </p>
              </div>
              <span>{t('teamTaskAttachmentsCount', { count: attachmentCount })}</span>
            </div>

            {loading && <p aria-live="polite">{t('teamTaskLoadingAttachments')}</p>}
            <div className="team-task-attachment-grid">
              {visibleAttachments.map(attachment => (
                <TaskAttachmentTile
                  key={attachment.id}
                  teamId={teamId}
                  attachment={attachment}
                  client={client}
                  isDraft={attachment.id.startsWith('draft:')}
                  onDetach={canEdit ? () => stageDetach(attachment) : undefined}
                  onDownloadRestitched={
                    can('download') ? () => deliverRestitched(attachment) : undefined
                  }
                  restitching={restitch.states[attachment.materialId]?.kind === 'running'}
                />
              ))}
              {uploads.map(item => (
                <div key={item.id} className="team-task-attachment is-uploading">
                  <div className="team-task-attachment-preview">
                    <span className="team-task-attachment-fallback">
                      {t('teamTaskAttachmentUploadingShare', {
                        percent: item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0
                      })}
                    </span>
                  </div>
                  <div className="team-task-attachment-caption">
                    <div className="team-task-attachment-caption-heading">
                      <div>
                        <strong title={item.name}>{item.name}</strong>
                        <small>{t('teamTaskAttachmentUploadingLabel')}</small>
                      </div>
                    </div>
                    <span
                      className="team-task-attachment-progress"
                      role="progressbar"
                      aria-label={t('teamTaskAttachmentUploading', { name: item.name })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={
                        item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0
                      }
                    >
                      <span
                        style={{
                          width: `${item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0}%`
                        }}
                      />
                    </span>
                  </div>
                </div>
              ))}
              {canEdit && (
                <TaskAttachmentPicker
                  teamId={teamId}
                  client={client}
                  attachedMaterialIds={visibleMaterialIds}
                  onAdd={addAttachments}
                />
              )}
            </div>
            {persistedAttachments.length < task.attachmentCount && (
              <Button
                type="button"
                variant="secondary"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                {t('teamTaskLoadMoreAttachments')}
              </Button>
            )}
          </section>
        </div>
      </Modal>
      {showUnsavedPrompt && (
        <Modal
          nested
          labelledBy="team-task-unsaved-title"
          onClose={() => setShowUnsavedPrompt(false)}
          closeLabel={t('teamCancel')}
          size="sm"
        >
          <div className="team-task-unsaved-confirmation">
            <h2 id="team-task-unsaved-title">{t('teamTaskUnsavedTitle')}</h2>
            <p>{t('teamTaskUnsavedDescription')}</p>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={discardAndClose}>
                {t('teamTaskCloseWithoutSaving')}
              </Button>
              <Button type="button" variant="primary" loading={saving} onClick={() => void save()}>
                {t('teamTaskSave')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {confirmingDelete && onDelete && (
        <Modal
          nested
          labelledBy="team-task-delete-title"
          onClose={() => setConfirmingDelete(false)}
          size="sm"
        >
          <div className="team-task-unsaved-confirmation">
            <h2 id="team-task-delete-title">{t('teamTaskDeleteConfirmTitle')}</h2>
            {/* Names what goes and what stays: the files stay. */}
            <p>{t('teamTaskDeleteConfirmBody')}</p>
            <div className="team-dialog-actions">
              <Button
                type="button"
                variant="danger"
                loading={deleting}
                onClick={() => {
                  setDeleting(true);
                  void onDelete(task).finally(() => setDeleting(false));
                }}
              >
                {t('teamTaskDelete')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                {t('teamCancel')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
