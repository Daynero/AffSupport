import { useCallback, useState } from 'react';
import type { TeamPermissions } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { selectNativeDirectory } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { uploadTeamFile } from '../catalog/material-actions-client';
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
  WorkspaceUploadRequest
} from './WorkspaceOperationsProvider';
import { confirmWorkspaceCatalog, findFolderConflicts } from './catalogPostcondition';
import type { useExplorer } from './ExplorerProvider';
import type { useFolderPage } from './useFolderPage';
import type { UploadFile } from './ExplorerDropZone';
import type { ExplorerShellClient } from './ExplorerShell';

/**
 * Files into the open folder, out of `ExplorerShell` (070, FR-001): a drop or a pick of loose
 * files, a dropped or picked folder through the space's upload groups, and the one name
 * collision the upload is waiting on — and a new, empty folder.
 */
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
  onFolderCreated
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
          await uploadTeamFile({
            teamId,
            destinationFolderId: fileDestination,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            // Replacing is a new version of the file already there: it keeps
            // its place, its tags and what came before it.
            versionOfMaterialId: choice === 'replace' && clash ? clash.id : null
          });
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
    },
    [changed, currentFolderId, page.rows, permissions?.upload, push, t, teamId, update]
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
                  : t('teamExplorerUploadIncomplete')
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
      currentFolderId,
      client,
      dismiss,
      explorer,
      nodeOf,
      onChanged,
      onRetryComplete,
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

  return { upload, uploadDrop, pickFolder, createFolder, uploading, conflict };
}
