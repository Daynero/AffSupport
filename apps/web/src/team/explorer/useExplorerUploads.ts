import { useCallback, useRef, useState } from 'react';
import type { TeamPermissions } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { selectNativeDirectory } from '../../api/client';
import { useI18n, type TranslationKey } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { uploadTeamFile } from '../catalog/material-actions-client';
import { isR2Space } from '../../api/space-storage';
import type { UploadConflictChoice, UploadConflictRequest } from './UploadConflictDialog';
import {
  buildLocalManifest,
  buildNativeDirectoryManifest,
  type LocalDirectoryHandle,
  type LocalManifest,
  type LocalManifestSource
} from './localManifest';
import type {
  useOptionalWorkspaceOperations,
  WorkspaceOperationGroup,
  WorkspaceUploadRequest
} from './WorkspaceOperationsProvider';
import { confirmWorkspaceCatalog, findFolderConflicts } from './catalogPostcondition';
import type { useExplorer } from './ExplorerProvider';
import type { useFolderPage } from './useFolderPage';
import type { UploadFile } from './ExplorerDropZone';
import type { ExplorerShellClient } from './ExplorerShell';
import type { AgentQueueItem } from './useAgentQueue';
import {
  isVideoUpload,
  rememberVideoChoice,
  trimJobs,
  type UploadVideoChoice
} from './uploadVideoChoice';

/** The one question a drop with videos in it waits on (070): how many, and the answer. */
export interface UploadVideoQuestion {
  /** Which drop is asking; a new one is a new question, not the old one changed. */
  id: number;
  videos: number;
  /** `null` is Esc: the whole drop is called off, nothing goes up. */
  settle: (choice: UploadVideoChoice | null) => void;
}

/**
 * Files into the open folder, out of `ExplorerShell` (070, FR-001): a drop or a pick of loose
 * files, a dropped or picked folder through the space's upload groups, and the one name
 * collision the upload is waiting on — and a new, empty folder.
 */
/**
 * Why a whole upload failed, when every file failed for the same known reason (070 T069): a
 * Drive that answered 403 to each file said "check the result and try again" with no result
 * to check. A mixed or unknown failure keeps that sentence.
 */
function failedReason(
  group: { items: ReadonlyArray<{ state: string; errorCode: string | null }> },
  t: (key: TranslationKey) => string
): string {
  const codes = new Set(
    group.items.filter(item => item.state === 'failed').map(item => item.errorCode ?? '')
  );
  const [code] = [...codes];
  if (codes.size !== 1 || !code) return t('teamExplorerUploadIncomplete');
  const reason = teamErrorMessageFor({ code }, t);
  return reason === t('teamErrorUnknown') ? t('teamExplorerUploadIncomplete') : reason;
}

export function useExplorerUploads({
  teamId,
  client,
  currentFolderId,
  nodeOf,
  explorer,
  page,
  permissions,
  workspaceOperations,
  retryGroupId,
  onRetryComplete,
  onChanged,
  changed,
  onFolderCreated,
  canTrim = false,
  onTrimVideos
}: {
  teamId: string;
  client: ExplorerShellClient;
  currentFolderId: string | null;
  nodeOf: ReturnType<typeof useExplorer>['nodeOf'];
  explorer: ReturnType<typeof useExplorer>;
  page: ReturnType<typeof useFolderPage>;
  permissions: TeamPermissions | null;
  workspaceOperations: ReturnType<typeof useOptionalWorkspaceOperations>;
  retryGroupId?: string | null;
  onRetryComplete?: () => void;
  onChanged?: () => void;
  changed: () => void;
  /** The new-folder window closes once the folder exists. */
  onFolderCreated: () => void;
  /**
   * Whether the videos of a drop can have their stitching cut (070): the person may process
   * here and the local app can run the re-stitch. Without it there is one answer, and no
   * question is asked.
   */
  canTrim?: boolean;
  /** The trims a drop asked for, once its videos are in the space. */
  onTrimVideos?: (jobs: AgentQueueItem[]) => void;
}) {
  const { t } = useI18n();
  const { push, update, dismiss } = useToasts();
  /** How many files are still going up; the zone stays lit while any is. */
  const [uploading, setUploading] = useState(0);
  /**
   * The name collision the drop is waiting on, and the promise the upload loop
   * is parked on until it is answered. One at a time: a drop of ten files with
   * ten collisions asks once and offers to apply that answer to the rest.
   */
  const [conflict, setConflict] = useState<{
    request: UploadConflictRequest;
    settle: (choice: UploadConflictChoice, forRest: boolean) => void;
  } | null>(null);

  /** The question about the videos in a drop, while it waits for an answer (070). */
  const [videoQuestion, setVideoQuestion] = useState<UploadVideoQuestion | null>(null);
  /**
   * Asks once for the whole drop. No videos, or nothing but "original" possible: no question.
   * The answer is not kept as a rule (owner, 2026-11-24) — only as the highlighted choice.
   */
  /* A second drop while the first is still being asked about waits its turn, like the name
     collisions do: one question on screen, each answer for its own drop. */
  const questionTurn = useRef<Promise<unknown>>(Promise.resolve());
  const questionCount = useRef(0);
  const askAboutVideos = useCallback(
    (videos: number): Promise<UploadVideoChoice | null> => {
      if (videos === 0 || !canTrim || !onTrimVideos) return Promise.resolve('original');
      const asked = questionTurn.current.then(
        () =>
          new Promise<UploadVideoChoice | null>(resolve => {
            setVideoQuestion({
              id: ++questionCount.current,
              videos,
              settle: choice => {
                setVideoQuestion(null);
                if (choice) rememberVideoChoice(choice);
                resolve(choice);
              }
            });
          })
      );
      questionTurn.current = asked;
      return asked;
    },
    [canTrim, onTrimVideos]
  );

  /** Files dropped on the content area, or picked from the "Add files" input. */
  const upload = useCallback(
    async (files: FileList | File[] | UploadFile[]) => {
      const list: UploadFile[] = Array.from(files as ArrayLike<File | UploadFile>).map(item =>
        'file' in item
          ? (item as UploadFile)
          : {
              file: item as File,
              relativePath: (item as File).webkitRelativePath || (item as File).name
            }
      );
      if (list.length === 0 || !permissions?.upload) return;
      const videoChoice = await askAboutVideos(
        list.filter(item => isVideoUpload(item.file.name, item.file.type)).length
      );
      if (!videoChoice) return;
      const toTrim: { materialId: string; name: string; folderId: string | null }[] = [];
      // No folder open means the space root, which the server resolves from the
      // connection. Inferring it from the first top-level folder refused every
      // upload into an empty space — with a message about Drive being
      // unavailable, which it was not.
      const destination = currentFolderId;
      const folderCache = new Map<string, string>();
      const folderFor = async (relativePath: string) => {
        const parts = relativePath.split('/').filter(Boolean).slice(0, -1);
        let parent = destination;
        let key = '';
        for (const part of parts) {
          key = `${key}/${part}`;
          const cached = folderCache.get(key);
          if (cached) {
            parent = cached;
            continue;
          }
          const created = await teamApi.ensureUploadFolder(teamId, {
            name: part,
            parentMaterialId: parent
          });
          folderCache.set(key, created.materialId);
          parent = created.materialId;
        }
        return parent;
      };
      /*
       * Each file says it is being sent from the moment it is dropped.
       *
       * A drop used to do nothing visible: the highlight left with the pointer
       * and the next thing on screen was a message, seconds later, that said
       * only "try again in a moment". A person could not tell whether the drop
       * had even been taken. One notice per file now carries its whole life —
       * sent, landed, or refused with the reason and the file's own name — and
       * the zone stays lit while any of them is in flight.
       */
      /*
       * What the folder already holds, by name. The rows are already on screen,
       * so the question can be asked before a byte moves — and the material id
       * is right there, which is what makes "replace" a new version of that
       * file rather than a second one beside it.
       */
      const byName = new Map(page.rows.map(row => [row.name.toLocaleLowerCase(), row]));
      let forAll: UploadConflictChoice | null = null;
      setUploading(count => count + list.length);
      for (const [index, item] of list.entries()) {
        const file = item.file;
        let fileDestination: string | null;
        try {
          fileDestination = await folderFor(item.relativePath);
        } catch (cause) {
          setUploading(count => Math.max(0, count - 1));
          push({
            tone: 'error',
            text: t('teamExplorerUploadFailedFor', {
              name: file.name,
              reason: teamErrorMessageFor(cause, t)
            })
          });
          continue;
        }
        const clash = byName.get(file.name.toLocaleLowerCase());
        let choice: UploadConflictChoice = 'keep_both';
        if (clash) {
          choice =
            forAll ??
            (await new Promise<UploadConflictChoice>(resolve => {
              setConflict({
                request: {
                  fileName: file.name,
                  existingMaterialId: clash.id,
                  remaining: list.length - index - 1
                },
                settle: (answer, forRest) => {
                  if (forRest) forAll = answer;
                  setConflict(null);
                  resolve(answer);
                }
              });
            }));
        }
        if (choice === 'skip') {
          setUploading(count => Math.max(0, count - 1));
          push({ tone: 'info', text: t('teamExplorerUploadSkipped', { name: file.name }) });
          continue;
        }
        const notice = push({
          tone: 'info',
          sticky: true,
          text: t('teamExplorerUploading', { name: file.name })
        });
        try {
          const uploaded: unknown = await uploadTeamFile({
            teamId,
            destinationFolderId: fileDestination,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            // Replacing is a new version of the file already there: it keeps
            // its place, its tags and what came before it.
            versionOfMaterialId: choice === 'replace' && clash ? clash.id : null
          });
          const materialId = resultMaterialId(uploaded);
          if (videoChoice === 'trim' && materialId && isVideoUpload(file.name, file.type))
            toTrim.push({ materialId, name: file.name, folderId: fileDestination });
          update(notice, {
            tone: 'success',
            sticky: false,
            text: t('teamExplorerUploadedOne', { name: file.name })
          });
        } catch (cause) {
          update(notice, {
            tone: 'error',
            sticky: false,
            text: t('teamExplorerUploadFailedFor', {
              name: file.name,
              reason: teamErrorMessageFor(cause, t)
            })
          });
        } finally {
          setUploading(count => Math.max(0, count - 1));
          // Each file lands on its own: what has arrived is on screen before
          // the next one starts, rather than the whole drop appearing at the
          // end of the last transfer.
          changed();
        }
      }
      if (toTrim.length > 0) onTrimVideos?.(trimJobs(toTrim));
    },
    [
      askAboutVideos,
      changed,
      currentFolderId,
      onTrimVideos,
      page.rows,
      permissions?.upload,
      push,
      t,
      teamId,
      update
    ]
  );

  const uploadDrop = useCallback(
    async (sources: LocalManifestSource[], preparedManifest?: LocalManifest) => {
      if (!permissions?.upload || (sources.length === 0 && !preparedManifest)) return;
      if (!workspaceOperations) {
        if (preparedManifest) throw new Error('DIRECTORY_INTAKE_UNAVAILABLE');
        // Standalone Explorer instances retain their original upload path.
        const files = await Promise.all(
          sources
            .filter(
              (source): source is Extract<LocalManifestSource, { kind: 'file' }> =>
                source.kind === 'file'
            )
            .map(source => source.file)
        );
        await upload(files);
        return;
      }
      // Capture the destination before any asynchronous directory enumeration.
      const retryGroup = retryGroupId
        ? workspaceOperations.groups.find(group => group.id === retryGroupId)
        : null;
      if (retryGroupId && !retryGroup) {
        push({ tone: 'error', text: t('teamErrorUnknown') });
        return;
      }
      const destination = retryGroup?.destination ?? {
        driveFolderId: currentFolderId,
        materialId: currentFolderId ? (nodeOf(currentFolderId)?.id ?? null) : null
      };
      let forAll: UploadConflictChoice | null = null;
      let conflictQueue = Promise.resolve();
      const enumeration = new AbortController();
      setUploading(count => count + 1);
      const preparingToast = push({
        tone: 'info',
        sticky: true,
        text: t('teamOperationRunning'),
        stageLabel: t('teamWorkspaceStagePreparing'),
        progress: 'indeterminate',
        action: { label: t('teamOperationCancel'), run: () => enumeration.abort() }
      });
      let lastPreparationUpdate = 0;
      try {
        const manifest =
          preparedManifest ??
          (await buildLocalManifest(sources, {
            onProgress: counts => {
              const now = performance.now();
              if (counts.files + counts.directories > 1 && now - lastPreparationUpdate < 150)
                return;
              lastPreparationUpdate = now;
              update(preparingToast, {
                detail: t('teamWorkspaceDiscovered', {
                  files: counts.files,
                  folders: counts.directories
                })
              });
            },
            signal: enumeration.signal
          }));
        if (enumeration.signal.aborted || manifest.issues.some(issue => issue.code === 'CANCELED'))
          return;
        update(preparingToast, {
          detail: t('teamWorkspaceDiscovered', {
            files: manifest.totalFiles,
            folders: manifest.totalDirectories
          })
        });
        dismiss(preparingToast);
        /* A retry is the same files chosen again to finish an interrupted upload: it was
           asked about when it started, and asking again would only stand in its way. */
        const videoChoice = retryGroup
          ? 'original'
          : await askAboutVideos(
              manifest.entries.filter(
                entry => entry.kind === 'file' && isVideoUpload(entry.relativePath, entry.mimeType)
              ).length
            );
        if (!videoChoice) return;
        let remainingConflicts = manifest.totalFiles;
        const request: WorkspaceUploadRequest = {
          teamId,
          destination,
          manifest,
          findConflicts: (folderId, names) => findFolderConflicts(client, teamId, folderId, names),
          onConflict: async ({ name, existingMaterialId }) => {
            const previous = conflictQueue;
            let release!: () => void;
            conflictQueue = new Promise<void>(resolve => {
              release = resolve;
            });
            await previous;
            try {
              remainingConflicts = Math.max(0, remainingConflicts - 1);
              if (forAll) return forAll;
              return await new Promise<UploadConflictChoice>(resolve => {
                setConflict({
                  request: { fileName: name, existingMaterialId, remaining: remainingConflicts },
                  settle: (choice, rest) => {
                    if (rest) forAll = choice;
                    setConflict(null);
                    resolve(choice);
                  }
                });
              });
            } finally {
              release();
            }
          },
          confirmCatalog: async expected => {
            await confirmWorkspaceCatalog(client, teamId, expected);
            // The initiating view may have unmounted during the upload. Its
            // refresh is best-effort; the independent check above is the proof.
            await Promise.allSettled([page.reloadStrict(), explorer.refreshStrict()]);
            onChanged?.();
          }
        };
        const group = retryGroup
          ? await workspaceOperations.retryUploadGroup(retryGroup.id, request)
          : await workspaceOperations.startUploadGroup(request);
        if (retryGroup && group.state === 'succeeded') onRetryComplete?.();
        if (videoChoice === 'trim') {
          const toTrim = uploadedVideos(manifest, group, destination.driveFolderId);
          if (toTrim.length > 0) onTrimVideos?.(trimJobs(toTrim));
        }
        push({
          tone:
            group.state === 'succeeded'
              ? 'success'
              : group.state === 'partial' || group.state === 'canceled'
                ? 'warning'
                : 'error',
          text:
            group.state === 'succeeded'
              ? t('teamExplorerUploadedOne', { name: manifest.roots[0]?.name ?? '' })
              : group.state === 'partial'
                ? t('teamWorkspacePartial')
                : group.state === 'canceled'
                  ? t('teamWorkspaceCanceled')
                  : failedReason(group, t)
        });
      } catch (cause) {
        push({
          tone: 'error',
          text:
            retryGroup && cause instanceof Error && cause.message === 'RESELECTION_MISMATCH'
              ? t('teamWorkspaceReselectMismatch')
              : teamErrorMessageFor(cause, t)
        });
      } finally {
        dismiss(preparingToast);
        setUploading(count => Math.max(0, count - 1));
      }
    },
    [
      askAboutVideos,
      currentFolderId,
      client,
      dismiss,
      explorer,
      nodeOf,
      onChanged,
      onRetryComplete,
      onTrimVideos,
      page,
      permissions?.upload,
      push,
      retryGroupId,
      t,
      teamId,
      update,
      upload,
      workspaceOperations
    ]
  );

  const pickFolder = useCallback(async () => {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<unknown> })
      .showDirectoryPicker;
    if (!picker) {
      try {
        const selection = await selectNativeDirectory();
        if (selection.kind === 'selected')
          await uploadDrop([], buildNativeDirectoryManifest(selection));
      } catch {
        push({ tone: 'error', text: t('teamExplorerFolderUnsupported') });
      }
      return;
    }
    try {
      const handle = (await picker()) as LocalDirectoryHandle;
      await uploadDrop([{ kind: 'directory_handle', handle }]);
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError')
        push({ tone: 'error', text: t('teamExplorerFolderReadFailed') });
    }
  }, [push, t, uploadDrop]);

  const createFolder = useCallback(
    async (name: string) => {
      try {
        const parentMaterialId = currentFolderId ? nodeOf(currentFolderId)?.id : null;
        if (currentFolderId && !parentMaterialId) throw new Error('FOLDER_NOT_FOUND');
        // An R2 space makes the folder with `create_folder` (057, T029); Drive keeps its route.
        if (isR2Space(teamId)) await teamApi.createFolder(teamId, { name, parentMaterialId });
        else
          await teamApi.ensureUploadFolder(teamId, {
            name,
            parentMaterialId
          });
        onFolderCreated();
        changed();
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        throw cause;
      }
    },
    [changed, currentFolderId, nodeOf, onFolderCreated, push, t, teamId]
  );

  return { upload, uploadDrop, pickFolder, createFolder, uploading, conflict, videoQuestion };
}

function resultMaterialId(result: unknown): string | null {
  return typeof result === 'object' &&
    result !== null &&
    'materialId' in result &&
    typeof result.materialId === 'string'
    ? result.materialId
    : null;
}

/**
 * The videos of a finished upload group that are in the space, with the folder each landed
 * in: the drop's folder, or one the drop created on the way.
 */
function uploadedVideos(
  manifest: LocalManifest,
  group: Pick<WorkspaceOperationGroup, 'items'>,
  rootFolderId: string | null
): { materialId: string; name: string; folderId: string | null }[] {
  const items = new Map(group.items.map(item => [item.clientItemKey, item]));
  const videos: { materialId: string; name: string; folderId: string | null }[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file' || !isVideoUpload(entry.relativePath, entry.mimeType)) continue;
    const item = items.get(entry.clientItemKey);
    if (!item || item.state !== 'succeeded' || !item.resultMaterialId) continue;
    const folderId =
      entry.parentKey === null
        ? rootFolderId
        : (items.get(entry.parentKey)?.resultFolderId ?? null);
    videos.push({
      materialId: item.resultMaterialId,
      name: entry.relativePath.split('/').at(-1) ?? entry.relativePath,
      folderId
    });
  }
  return videos;
}
