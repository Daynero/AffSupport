import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { InvitationPanel, type InvitationPanelClient } from '../members/InvitationPanel';
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  ErrorState,
  FormField,
  IconButton,
  Input,
  Progress,
  Select
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
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
import { useCoalescedWrite } from './useCoalescedWrite';
import { useTaskAutosave } from './useTaskAutosave';
import { TaskStatusControl } from './TaskStatusControl';
import { TaskAgentTagsEditor, type TaskAgentTagsClient } from './TaskAgentTags';
import { TaskLabelsEditor, type TaskLabelsEditorClient } from './TaskLabelsEditor';
import { TaskDateField } from './TaskDateField';
import { useToasts } from '../../components/toast';
import { uploadTeamFile } from '../catalog/material-actions-client';
import { classifyMaterial } from '@video-compressor/shared';
import { teamErrorMessageFor } from '../errors';
import { PermissionState, Textarea } from '../../components/ui/index';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { ProductCatalogMenuDialog } from '../product-catalog/ProductCatalogMenuDialog';
import { useOptionalSpaceAgentQueue } from '../processing/AgentQueueProvider';
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import {
  compressJobs,
  TeamCompressorDialog,
  type CompressPlanItem
} from '../explorer/TeamCompressorDialog';
import { attachResultToTask } from '../explorer/useAgentQueue';
import { onTaskAttachmentsChanged } from './taskAttachmentEvents';
import { spaceRouteFor } from '../SpaceSettingsLink';

export interface TaskEditorClient
  extends
    Partial<InvitationPanelClient>,
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
/** The assignee list's last line, which invites rather than assigns. */
const INVITE_OPTION = '__invite__';

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
  onLabelCreated,
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
  /** Raised when a tag is created from inside this task (024). */
  onLabelCreated?: () => void;
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
    // Over the task, not instead of it (024, FR-079): the settings ride on the
    // address the task is on, and closing them comes back here.
    navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'restitch' }));
  };
  /*
   * "Show on Drive": the explorer opens the attachment's folder with the file selected. The folder
   * comes from the catalogue search, which knows every file's parent; a file it cannot find is
   * searched for across the space instead, so the button never leads nowhere.
   */
  /** Where an attachment lives, from the catalogue; `undefined` when it cannot be found. */
  const findParentFolder = async (
    attachment: TeamTaskAttachmentSummary
  ): Promise<string | null | undefined> => {
    const stem = attachment.name.replace(/\.[^.]+$/u, '');
    let parentFolderId: string | null | undefined;
    for (const query of [attachment.name, stem]) {
      try {
        // The picker's client already knows how to search the space; reaching
        // past it to `teamApi` made this the one call in the editor a test
        // could not stand in for.
        const search = client.searchCatalog ?? teamApi.searchCatalog;
        const found = await search(teamId, { query, page: 1, pageSize: 100 });
        const hit = found.items.find(item => item.id === attachment.materialId);
        if (hit) {
          parentFolderId = hit.parentFolderId ?? null;
          break;
        }
      } catch {
        break;
      }
    }
    return parentFolderId;
  };
  const revealAttachment = async (attachment: TeamTaskAttachmentSummary) => {
    const parentFolderId = await findParentFolder(attachment);
    // Not `onClose()`: closing the editor writes its own address first, and the
    // reveal's would land on top of it — so Back came out at the task list
    // rather than at the task somebody was in the middle of. Changing the
    // address is enough to close the dialog, and leaves the task one Back away.
    navigateTo(
      buildTeamRoute({
        spaceId: teamId,
        section: 'explorer',
        query:
          parentFolderId === undefined
            ? { q: attachment.name, scope: 'space', back: task.id }
            : { folderId: parentFolderId, itemId: attachment.materialId, back: task.id }
      })
    );
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
  const [task, setTask] = useState(initialTask);
  const [title, setTitle] = useState(initialTask.title);
  const [note, setNote] = useState(initialTask.note ?? '');
  const [status, setStatus] = useState(initialTask.status);
  const [assigneeId, setAssigneeId] = useState(initialTask.assigneeId ?? '');
  /** The day the task is for; null is "the day it was created". */
  const [dateOn, setDateOn] = useState<string | null>(initialTask.dateOn);
  const [progressMax, setProgressMax] = useState(initialTask.progressMax);
  const [progressMaxInput, setProgressMaxInput] = useState(String(initialTask.progressMax));
  const [progressValue, setProgressValue] = useState(initialTask.progressValue);
  const [persistedAttachments, setPersistedAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const editorMenuTrigger = useRef<HTMLButtonElement>(null);
  /**
   * The video whose product catalog is open over this task, if any.
   *
   * Mounted here rather than inside the tile because a popover unmounts the
   * moment it closes, and because this is the point of the whole thing: the
   * dialog opens *over* the task, the task keeps its state, and nobody has to
   * go to the explorer and come back.
   */
  const [catalogFor, setCatalogFor] = useState<{ id: string; name: string } | null>(null);
  /*
   * The rest of "Make", from the task (024, FR-076). Each opens over the editor
   * and hands its run to the space's queue carrying this task, so what comes
   * out lands back here — even if the editor has closed by then.
   */
  const spaceQueue = useOptionalSpaceAgentQueue()?.queue ?? null;
  const [compressing, setCompressing] = useState<CompressPlanItem | null>(null);
  const [processing, setProcessing] = useState<{
    material: { id: string; name: string; category: TeamTaskAttachmentSummary['category'] };
    folderId: string | null;
  } | null>(null);
  /** Bumped when a catalog is made here, so the tile's companions re-read. */
  const [companionsRevision, setCompanionsRevision] = useState(0);
  const { push: pushToast } = useToasts();
  /** The invite dialog, opened from the assignee field and closed back to it. */
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The space's default for a new task's Maximum. When the field differs from
  // it, someone who may change the space's settings is offered to make the
  // current value the default for every task anyone creates here.
  const [defaultMax, setDefaultMax] = useState<number | null>(null);
  const [savingDefaultMax, setSavingDefaultMax] = useState(false);

  useEffect(() => {
    let active = true;
    void teamApi
      .getTaskProgressMaxDefault(teamId)
      .then(value => {
        if (active) setDefaultMax(value);
      })
      .catch(() => {
        if (active) setDefaultMax(null);
      });
    return () => {
      active = false;
    };
  }, [teamId]);

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

  // A result made from this task arrived (or was taken off again).
  useEffect(
    () =>
      onTaskAttachmentsChanged(task.id, () => {
        void load({ quiet: true, resetAttachmentDraft: true });
        setCompanionsRevision(value => value + 1);
      }),
    [load, task.id]
  );

  // Everything on screen is on the task. There is no third state between
  // "attached" and "not attached" any more, which is what a staged attachment
  // was: a tile that looked exactly like the real thing and vanished if the
  // dialog was closed the wrong way.
  const visibleAttachments = persistedAttachments;
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

  const attachmentCount = persistedAttachments.length;

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

  /**
   * Picked or dragged in — attached, now.
   *
   * It used to be staged: the tile appeared, the task did not have the file,
   * and the two only agreed if the dialog was closed through Save. Dropping an
   * upload attached immediately in the same dialog, so picking and dropping
   * meant different things and only one of them survived a close.
   */
  const addAttachments = async (materials: TaskAttachmentCandidate[]) => {
    const known = new Set(persistedAttachments.map(attachment => attachment.materialId));
    const additions = materials.filter(material => !known.has(material.id));
    if (additions.length === 0) return;
    const position = Math.max(-1, ...persistedAttachments.map(item => item.position));
    // On screen first: the wait is the server's, and a tile that appears when
    // the request returns makes a good connection feel like a slow one.
    const optimistic = additions.map((material, index) =>
      draftAttachment(task.id, material, position + index + 1)
    );
    setPersistedAttachments(current => uniqueAttachments(current, optimistic));
    try {
      const result = await attachTaskMaterialsInChunks({
        client,
        teamId,
        taskId: task.id,
        materialIds: additions.map(material => material.id)
      });
      if (result.rejected.length > 0) throw new Error('ATTACHMENT_REJECTED');
      await load({ quiet: true });
      onChanged({ ...task, attachmentCount: persistedAttachments.length + additions.length });
    } catch (cause) {
      setPersistedAttachments(current =>
        current.filter(item => !optimistic.some(added => added.id === item.id))
      );
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    }
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
   * Detaching is written at once, and takeable back.
   *
   * It used to be staged until Save, which made the toast's Undo a promise
   * about a change that had not happened — and left the file attached if the
   * dialog was closed another way. The reversibility is real now: the Undo
   * re-attaches, which is the same guarantee trashing a file makes, and the
   * reason there is still no confirmation dialog in front of it (FR-028).
   */
  const detach = async (attachment: TeamTaskAttachmentSummary) => {
    setPersistedAttachments(current =>
      current.filter(item => item.materialId !== attachment.materialId)
    );
    try {
      await client.detachTaskMaterial(teamId, task.id, attachment.materialId);
      onChanged({ ...task, attachmentCount: Math.max(0, persistedAttachments.length - 1) });
    } catch (cause) {
      setPersistedAttachments(current => uniqueAttachments(current, [attachment]));
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      return;
    }
    push({
      tone: 'info',
      text: t('teamToastAttachmentDetached', { name: attachment.name }),
      action: {
        label: t('teamUndo'),
        run: () =>
          void addAttachments([
            {
              id: attachment.materialId,
              name: attachment.name,
              category: attachment.category,
              kind: attachment.kind
            } as TaskAttachmentCandidate
          ])
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

  /**
   * Every field writes itself (024).
   *
   * The version the write expects is the newest one this editor has seen, held
   * in a ref rather than read from state: two changes a keystroke apart would
   * otherwise both quote the version before the first, and the second would be
   * refused as a conflict with the reader's own edit.
   */
  const versionRef = useRef(task.updatedAt);
  versionRef.current = task.updatedAt;

  const autosave = useTaskAutosave({
    write: async patch => {
      const response = await client.updateTask(teamId, task.id, {
        ...patch,
        expectedUpdatedAt: versionRef.current
      });
      // The update RPC returns the physical row, while attachmentCount is
      // derived by the read RPC. Keep the known count while this editor stays open.
      return { ...response, attachmentCount: task.attachmentCount, agents: task.agents };
    },
    read: async () => {
      const value = await client.getTask({ teamId, taskId: task.id });
      return value?.task ?? null;
    },
    onSaved: updated => {
      setTask(updated);
      setError(null);
      onChanged(updated);
    }
  });

  /*
   * Progress is saved the moment it is let go, like the status. It carries the
   * scale it was set on, and is not held to the copy's `updatedAt`: one field,
   * last writer wins — a slider is not something two people argue over.
   */
  const progressWriter = useCoalescedWrite<{ progressValue: number; progressMax: number }>({
    write: async value => {
      const response = await client.updateTask(teamId, task.id, value);
      setTask(current => ({
        ...response,
        attachmentCount: current.attachmentCount,
        agents: current.agents
      }));
      onChanged({ ...response, attachmentCount, agents: task.agents });
    },
    onError: () => setError('write')
  });

  const saveStatus = async (next: TeamTaskSummary['status']) => {
    if (!canEdit || next === status || savingStatus) return;
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

  /**
   * Closing is just closing.
   *
   * There is nothing to lose on the way out any more, so the dialog that used
   * to stand in the door — "you have unsaved changes" — has nothing to ask.
   * Anything still waiting out the typing pause goes first.
   */
  const requestClose = () => {
    autosave.flush();
    onClose();
  };

  return (
    <>
      <Modal
        labelledBy="team-task-editor-title"
        onClose={requestClose}
        closeLabel={t('teamCancel')}
        initialFocus="#team-task-title"
        size="xl"
      >
        <div className="team-task-editor-frame">
          <div className="team-task-editor">
            <h2 id="team-task-editor-title" className="visually-hidden">
              {t('teamTaskEditTitle')}
            </h2>
            <form
              className="team-dialog-form team-task-editor-brief"
              // Nothing submits any more; Enter in a field must not reload the page.
              onSubmit={event => event.preventDefault()}
            >
              {/* A viewer sees a dialog of dead fields and no reason for it. The
                fields stay — reading them is the point — and the boundary is
                said once, at the top, in the product's own words (FR-004). */}
              {!canEdit && <PermissionState message={t('teamTaskReadOnly')} />}
              {/* The title and the editor's own receipt and menu share a line (024):
                  a row above the title held one "…" and pushed the task down a line
                  on a laptop screen. */}
              <div className="team-task-title-row">
                <FormField
                  className="team-task-title-field"
                  label={t('teamTaskTitle')}
                  htmlFor="team-task-title"
                >
                  <Input
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
                    onChange={event => {
                      setTitle(event.target.value);
                      if (canEdit) autosave.saveSoon({ title: event.target.value });
                    }}
                    onBlur={autosave.flush}
                  />
                </FormField>
                <div className="team-task-editor-heading">
                  {/* Quiet when it works, loud when it does not. A save that
                    succeeded is a receipt that fades; a save that failed keeps
                    the words on screen and offers the retry, because the one
                    thing worse than a spinner is silence over lost work. */}
                  {canEdit && autosave.state === 'saving' && (
                    <small className="team-task-saved" aria-live="polite">
                      {t('teamTaskSaving')}
                    </small>
                  )}
                  {canEdit && autosave.state === 'saved' && (
                    <small className="team-task-saved" aria-live="polite">
                      {t('teamTaskSaved')}
                    </small>
                  )}
                  {canEdit && autosave.state === 'failed' && (
                    <small className="team-task-save-failed" role="alert">
                      {t('teamTaskSaveFailed')}
                      <Button size="sm" color="error" variant="ghost" onClick={autosave.flush}>
                        {t('teamTaskRetrySave')}
                      </Button>
                    </small>
                  )}
                  {/* Deleting lives in the editor's own menu (024, FR-088): a red
                    button in the middle of the form was the loudest thing on a
                    screen about a brief. It still confirms — a task cannot be
                    given back whole, so an Undo would be a quieter lie (021, R3). */}
                  {canEdit && onDelete && (
                    <>
                      <IconButton
                        ref={editorMenuTrigger}
                        className="team-task-editor-menu"
                        size="sm"
                        variant="ghost"
                        label={t('teamTaskEditorMenu')}
                        onClick={() => setEditorMenuOpen(true)}
                      >
                        <MoreHorizontal
                          size={ICON_SIZE}
                          strokeWidth={ICON_STROKE}
                          aria-hidden="true"
                        />
                      </IconButton>
                      <DropdownMenu
                        open={editorMenuOpen}
                        onClose={() => setEditorMenuOpen(false)}
                        anchor={editorMenuTrigger}
                        label={t('teamTaskEditorMenu')}
                        items={[
                          {
                            id: 'delete',
                            label: t('teamTaskDelete'),
                            destructive: true,
                            icon: (
                              <Trash2
                                size={ICON_SIZE}
                                strokeWidth={ICON_STROKE}
                                aria-hidden="true"
                              />
                            ),
                            onSelect: () => setConfirmingDelete(true)
                          }
                        ]}
                      />
                    </>
                  )}
                </div>
              </div>
              {/* What the task is, read across one line (024, FR-085): its state,
                who has it, when it is for. */}
              <div className="team-task-editor-facts">
                <TaskStatusControl
                  adaptive
                  value={status}
                  disabled={!canEdit || savingStatus}
                  onChange={next => void saveStatus(next)}
                />
                {/* Always in the editor (the owner, 024, revising FR-089): hidden
                    in a space of one, the field looked lost rather than quiet —
                    and its last line is how the second person gets invited. */}
                <>
                  {/* Who has it: the select says "not assigned" by itself, so it needs no
                    caption beside it, and the person you want may not be in the space yet —
                    inviting them is the list's last line rather than a second button (024,
                    FR-031, US14). */}
                  <Select
                    id="team-task-assignee"
                    className="team-task-assignee-select"
                    aria-label={t('teamTaskAssignee')}
                    value={assigneeId}
                    disabled={!canEdit}
                    placeholder={t('teamTaskUnassigned')}
                    options={[
                      ...members.map(member => ({
                        value: member.userId,
                        label: member.displayName ?? member.email ?? member.userId
                      })),
                      ...(canEdit && can('manage_members') && client.createInvitation
                        ? [{ value: INVITE_OPTION, label: `+ ${t('teamTaskInviteSomeone')}` }]
                        : [])
                    ]}
                    onChange={next => {
                      if (next === INVITE_OPTION) {
                        setInviting(true);
                        return;
                      }
                      setAssigneeId(next);
                      if (canEdit) autosave.save({ assigneeId: next || null });
                    }}
                  />
                </>
                <TaskDateField
                  value={teamTaskDate({ dateOn, createdAt: task.createdAt })}
                  isCustom={dateOn !== null}
                  createdOn={teamTaskDate({ dateOn: null, createdAt: task.createdAt })}
                  disabled={!canEdit}
                  onChange={next => {
                    setDateOn(next);
                    if (canEdit) autosave.save({ dateOn: next });
                  }}
                />
              </div>
              <FormField
                className="team-task-brief-field"
                label={t('teamTaskDescription')}
                htmlFor="team-task-description"
              >
                <Textarea
                  id="team-task-description"
                  className="team-task-description-input"
                  placeholder={t('teamTaskDescriptionPlaceholder')}
                  // Short when the brief is short; it grows as it is written (FR-087).
                  rows={3}
                  value={note}
                  maxLength={2_000}
                  disabled={!canEdit}
                  onChange={event => {
                    setNote(event.target.value);
                    if (canEdit) autosave.saveSoon({ note: event.target.value || null });
                  }}
                  onBlur={autosave.flush}
                />
              </FormField>
              {/* Named where it stands, like Accounts and Tags below it: a
                  red bar with a "0" on it and no word read as an error, not
                  as "nothing done yet". */}
              <div
                className="team-task-editor-progress-group"
                role="group"
                aria-labelledby="team-task-progress-title"
              >
                <span id="team-task-progress-title" className="team-task-accounts-label">
                  {t('teamTaskProgressTitle')}
                </span>
                <div className="team-task-editor-progress">
                  <TaskProgressScale
                    value={progressValue}
                    max={progressMax}
                    disabled={!canEdit}
                    label={t('teamTaskProgressScale')}
                    onChange={setProgressValue}
                    onCommit={next => {
                      if (canEdit) progressWriter.send({ progressValue: next, progressMax });
                    }}
                  />
                  <FormField
                    className="team-task-progress-max-field"
                    label={t('teamTaskProgressMax')}
                    htmlFor="team-task-progress-max"
                  >
                    <div className="team-task-progress-max-input">
                      <Input
                        id="team-task-progress-max"
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
                      {canEdit &&
                        can('manage_metadata') &&
                        defaultMax !== null &&
                        progressMax !== defaultMax && (
                          <Button
                            className="team-task-progress-max-save"
                            size="sm"
                            color="neutral"
                            variant="ghost"
                            disabled={savingDefaultMax}
                            onClick={async () => {
                              setSavingDefaultMax(true);
                              try {
                                await teamApi.setTaskProgressMaxDefault(teamId, progressMax);
                                setDefaultMax(progressMax);
                                push({ tone: 'success', text: t('teamTaskProgressMaxSaved') });
                              } catch {
                                push({ tone: 'error', text: t('teamTaskAttachmentActionFailed') });
                              } finally {
                                setSavingDefaultMax(false);
                              }
                            }}
                          >
                            {t('teamTaskProgressMaxSaveDefault')}
                          </Button>
                        )}
                    </div>
                  </FormField>
                </div>
              </div>
              {error && (
                <ErrorState
                  message={t(error === 'read' ? 'teamTaskReadFailed' : 'teamTaskSaveFailed')}
                />
              )}
            </form>
            {/* What the task is about: its materials first, because they are the work. */}
            <div className="team-task-editor-work">
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
                    {/* Said while there is nothing yet; once there are files the
                    tiles and the picker speak for themselves (024, US14). */}
                    {visibleAttachments.length === 0 && (
                      <p>
                        {canEdit && can('upload')
                          ? t('teamTaskAttachmentsDropHint')
                          : t('teamTaskAttachmentsHint')}
                      </p>
                    )}
                  </div>
                  <Badge size="sm">
                    {t('teamTaskAttachmentsCount', { count: attachmentCount })}
                  </Badge>
                </div>

                {/* The shape of what is coming, so the list does not jump when it
                lands — and the sentence stays, because a bare shimmer is
                indistinguishable from a stuck screen. */}
                {loading && <LabeledSkeleton label="teamTaskLoadingAttachments" rows={2} />}
                <div className="team-task-attachment-grid">
                  {visibleAttachments.map(attachment => (
                    <TaskAttachmentTile
                      key={attachment.id}
                      teamId={teamId}
                      attachment={attachment}
                      client={client}
                      isDraft={attachment.id.startsWith('draft:')}
                      onDetach={canEdit ? () => void detach(attachment) : undefined}
                      onReveal={() => void revealAttachment(attachment)}
                      onDownloadRestitched={
                        can('download') ? () => deliverRestitched(attachment) : undefined
                      }
                      onProductCatalog={
                        attachment.category === 'video' && !attachment.id.startsWith('draft:')
                          ? () =>
                              setCatalogFor({
                                id: attachment.materialId,
                                name: attachment.name
                              })
                          : undefined
                      }
                      onTranscribe={
                        spaceQueue && attachment.category === 'video'
                          ? () =>
                              void findParentFolder(attachment).then(folderId =>
                                spaceQueue.enqueueTranscriptions([
                                  {
                                    id: attachment.materialId,
                                    name: attachment.name,
                                    folderId: folderId ?? null,
                                    attachTo: { taskId: task.id }
                                  }
                                ])
                              )
                          : undefined
                      }
                      onCompress={
                        spaceQueue && attachment.category === 'video'
                          ? () =>
                              void findParentFolder(attachment).then(folderId =>
                                setCompressing({
                                  id: attachment.materialId,
                                  name: attachment.name,
                                  folderId: folderId ?? null
                                })
                              )
                          : undefined
                      }
                      onProcess={() =>
                        void findParentFolder(attachment).then(folderId =>
                          setProcessing({
                            material: {
                              id: attachment.materialId,
                              name: attachment.name,
                              category: attachment.category
                            },
                            folderId: folderId ?? null
                          })
                        )
                      }
                      browseClient={client}
                      companionsRevision={companionsRevision}
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
                        <Progress
                          className="team-task-attachment-progress"
                          size="xs"
                          label={t('teamTaskAttachmentUploading', { name: item.name })}
                          value={item.total > 0 ? (item.sent / item.total) * 100 : 0}
                        />
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
                    color="neutral"
                    variant="outline"
                    loading={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {t('teamTaskLoadMoreAttachments')}
                  </Button>
                )}
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
                // A tag made from inside the task belongs to the space, so the
                // dictionary the board and the settings read has to learn it too.
                onLabelCreated={onLabelCreated}
              />
            </div>
          </div>
        </div>
      </Modal>
      {/* The one thing still worth a dialog: somebody else changed this task
          while you were changing it. Not a snap-back — the words you typed are
          still here, and you choose which version stands. */}
      {autosave.state === 'conflict' && (
        <Modal
          nested
          labelledBy="team-task-conflict-title"
          onClose={autosave.takeNewer}
          closeLabel={t('teamCancel')}
          size="sm"
        >
          <div className="team-task-conflict">
            <h2 id="team-task-conflict-title">{t('teamTaskConflictTitle')}</h2>
            <p>{t('teamTaskConflictDescription')}</p>
            {autosave.conflict && (
              <p className="team-task-conflict-newer">
                <strong>{autosave.conflict.title}</strong>
                {autosave.conflict.note ? <span>{autosave.conflict.note}</span> : null}
              </p>
            )}
            <div className="team-dialog-actions">
              <Button color="neutral" variant="ghost" onClick={autosave.takeNewer}>
                {t('teamTaskConflictTakeNewer')}
              </Button>
              <Button color="primary" variant="solid" onClick={autosave.overwrite}>
                {t('teamTaskConflictKeepMine')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {inviting && client.createInvitation && (
        <Modal
          nested
          labelledBy="team-task-invite-title"
          onClose={() => setInviting(false)}
          closeLabel={t('teamCancel')}
          size="md"
        >
          <div className="team-task-invite">
            <h2 id="team-task-invite-title">{t('teamTaskInviteSomeone')}</h2>
            <InvitationPanel
              teamId={teamId}
              client={client as unknown as InvitationPanelClient}
              canManage
            />
          </div>
        </Modal>
      )}
      {catalogFor && (
        <ProductCatalogMenuDialog
          teamId={teamId}
          video={catalogFor}
          onClose={() => setCatalogFor(null)}
          onChanged={() => setCompanionsRevision(value => value + 1)}
        />
      )}
      {compressing && spaceQueue && (
        <TeamCompressorDialog
          teamId={teamId}
          items={[compressing]}
          client={client}
          onRun={plan => spaceQueue.enqueue(compressJobs(plan, { taskId: task.id }))}
          onClose={() => setCompressing(null)}
        />
      )}
      {processing && (
        <MaterialProcessFlow
          teamId={teamId}
          material={{
            id: processing.material.id,
            name: processing.material.name,
            category: processing.material.category ?? 'other'
          }}
          destinationFolderId={processing.folderId}
          browseClient={client}
          onFinished={materialId =>
            void attachResultToTask({
              teamId,
              taskId: task.id,
              materialId,
              name: processing.material.name,
              push: pushToast,
              t
            })
          }
          onClose={() => setProcessing(null)}
        />
      )}
      {confirmingDelete && onDelete && (
        <ConfirmDialog
          nested
          title={t('teamTaskDeleteConfirmTitle')}
          /* Names what goes and what stays: the files stay. */
          body={t('teamTaskDeleteConfirmBody')}
          confirmLabel={t('teamTaskDelete')}
          cancelLabel={t('teamCancel')}
          busy={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setDeleting(true);
            void onDelete(task).finally(() => setDeleting(false));
          }}
        />
      )}
    </>
  );
}
