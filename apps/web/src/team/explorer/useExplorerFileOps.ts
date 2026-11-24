import { useCallback, useMemo } from 'react';
import type {
  TeamMaterialRow,
  TeamMaterialTagColor,
  TeamPermissions
} from '@video-compressor/shared';
import { teamApi, TeamApiError } from '../../api/team';
import { downloadTeamFileWithAgent } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { handoffBrowserDownload } from '../materials/browser-download';
import { createRestoreBatch } from '../materials/restore-batch';
import { captureCatalogMutationOwner } from '../catalog-updater/captureCatalogMutationOwner';
import { trashMaterialWithTail, type TailClient } from '../materials/tail';
import type { MaterialActionsClient } from '../catalog/material-actions-client';
import { moveWorkspaceMaterials } from './moveCoordinator';
import type { useOptionalWorkspaceOperations } from './WorkspaceOperationsProvider';
import type { useExplorer } from './ExplorerProvider';
import type { useFolderPage } from './useFolderPage';
import type { ExplorerShellClient } from './ExplorerShell';

/**
 * What the bin needs of a thing: a folder row or a search result (070, T024). A folder's provider
 * id, when there is one, keeps a file inside a folder that goes too from being trashed twice.
 */
export type TrashableMaterial = Pick<TeamMaterialRow, 'id' | 'name' | 'category'> & {
  kind: string;
  parentFolderId?: string | null;
  driveFileId?: string;
};

/**
 * What the explorer does to files it already has, out of `ExplorerShell` (070, FR-001): the
 * tail client every file operation goes through, a drag onto a folder, saving an original to
 * this computer, the trash with its way back, and a tag's colour.
 */
export function useExplorerFileOps({
  teamId,
  actionsClient,
  page,
  currentFolderId,
  permissions,
  workspaceOperations,
  changed,
  clearSelection,
  select,
  nodeOf,
  pathTo,
  client,
  canTag
}: {
  teamId: string;
  actionsClient: MaterialActionsClient;
  page: ReturnType<typeof useFolderPage>;
  currentFolderId: string | null;
  permissions: TeamPermissions | null;
  workspaceOperations: ReturnType<typeof useOptionalWorkspaceOperations>;
  changed: () => void;
  clearSelection: () => void;
  select: ReturnType<typeof useExplorer>['select'];
  nodeOf: ReturnType<typeof useExplorer>['nodeOf'];
  pathTo: ReturnType<typeof useExplorer>['pathTo'];
  client: ExplorerShellClient;
  /** The space's owner, and storage that takes writes (011). */
  canTag: boolean;
}) {
  const { t } = useI18n();
  const { push, update, dismiss } = useToasts();
  /*
   * Every file operation in this screen goes through the tail module, and it
   * needs exactly these four. Built once so a drag, a paste, a menu and a
   * delete cannot drift apart in what they remember to carry.
   */
  const tailClient = useMemo<TailClient>(
    () => ({
      copyMaterial: input => teamApi.copyMaterial(input),
      moveMaterial: input => actionsClient.moveMaterial(input),
      renameMaterial: input => actionsClient.renameMaterial(input),
      trashMaterial: input => actionsClient.trashMaterial(input)
    }),
    [actionsClient]
  );

  /** What the tail module needs to know about a row the drag only names by id. */
  const rowFor = useCallback(
    (materialId: string) => {
      const row = page.rows.find(candidate => candidate.id === materialId);
      return {
        id: materialId,
        name: row?.name ?? '',
        category: row?.category ?? null,
        sourceFolderId: row?.parentFolderId ?? currentFolderId ?? null
      };
    },
    [currentFolderId, page.rows]
  );

  /** A drag onto a folder in the tree: move, and offer the way back (FR-026). */
  const moveTo = useCallback(
    async (folderDriveId: string, materialIds: string[]) => {
      if (!permissions?.edit) return;
      const previous = currentFolderId ?? null;
      const progressToast = push({
        tone: 'info',
        sticky: true,
        progress: 'indeterminate',
        text: t('teamExplorerPastingMove', { done: 0, total: materialIds.length })
      });
      const outcome = await moveWorkspaceMaterials({
        teamId,
        items: materialIds.map(rowFor),
        destinationFolderId: folderDriveId,
        conflictMode: 'keep_both',
        client: tailClient,
        onProgress: state =>
          update(progressToast, {
            progress: state.progress,
            text: t('teamExplorerPastingMove', { done: state.completed, total: state.total })
          })
      });
      dismiss(progressToast);
      if (outcome.error) {
        push({ tone: 'error', text: teamErrorMessageFor(outcome.error, t) });
        if (outcome.completed > 0) changed();
        return;
      }
      changed();
      clearSelection();
      const target = nodeOf(folderDriveId)?.name ?? t('teamExplorerRootLabel');
      push({
        tone: 'success',
        text: `${t('teamToastMoved')} → ${target}`,
        ...(previous !== null
          ? {
              action: {
                label: t('teamExplorerMovedUndo'),
                run: () => void moveTo(previous, materialIds)
              }
            }
          : {})
      });
    },
    [
      changed,
      clearSelection,
      currentFolderId,
      dismiss,
      nodeOf,
      permissions?.edit,
      push,
      rowFor,
      t,
      tailClient,
      teamId,
      update
    ]
  );

  /** Where a drop can land; nothing is draggable for a reader who may not move files. */
  const dropMaterials = useMemo(
    () =>
      permissions?.edit ? (folder: string, ids: string[]) => void moveTo(folder, ids) : undefined,
    [moveTo, permissions?.edit]
  );

  /**
   * The original, saved to this computer.
   *
   * The same two doors the row menu already uses: the paired app when the cloud says the file
   * is its business, the browser otherwise. Repeated here rather than reached for through the
   * row menu's hook, because the card is not a row and has no menu to borrow from.
   */
  const downloadOriginal = useCallback(
    async (row: TeamMaterialRow) => {
      try {
        const grant = await teamApi.requestDownload(teamId, row.id, 'browser').catch(cause => {
          if (cause instanceof TeamApiError && cause.code === 'AGENT_REQUIRED') {
            return teamApi.requestDownload(teamId, row.id, 'agent');
          }
          throw cause;
        });
        if (grant.kind === 'agent') {
          await downloadTeamFileWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: row.name
          });
          push({ tone: 'success', text: t('teamRestitchDelivered', { name: row.name }) });
          return;
        }
        handoffBrowserDownload(grant.rangeUrl, row.name);
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
    },
    [push, t, teamId]
  );

  /*
   * A trashed video takes its transcript with it, without asking (owner,
   * 2026-09-02). 012 asked the question because a transcript might have been
   * shared; it never is — each video owns one, and a copy gets its own — so the
   * question only stood between a person and the tidy-up they had already
   * asked for. Both files are recoverable from the trash.
   */
  /** Rows going to the trash from the keyboard or the selection bar, with the way back. */
  const trashRows = useCallback(
    async (rows: readonly TrashableMaterial[]) => {
      if (!permissions?.delete) return;
      if (workspaceOperations?.bulkTrash) {
        await workspaceOperations.bulkTrash
          .start(rows, tailClient)
          .catch(cause => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }));
        return;
      }
      const owner = captureCatalogMutationOwner(() => true);
      if (!owner.current()) return;
      const trashed: string[] = [];
      const selectedFolders = new Set(
        rows.flatMap(row => (row.kind === 'folder' && row.driveFileId ? [row.driveFileId] : []))
      );
      for (const row of rows) {
        if (
          row.parentFolderId &&
          pathTo(row.parentFolderId).some(folder => selectedFolders.has(folder.driveFileId))
        )
          continue;
        try {
          // The transcript goes with its video, here as everywhere else.
          if (!owner.current()) return;
          await trashMaterialWithTail({
            owner,
            teamId,
            material: { id: row.id, name: row.name, category: row.category },
            client: tailClient
          });
          if (!owner.current()) return;
          trashed.push(row.id);
        } catch (cause) {
          if (!owner.current()) return;
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          continue;
        }
      }
      if (trashed.length === 0) return;
      select(null);
      clearSelection();
      changed();
      const restore = createRestoreBatch({
        materialIds: trashed,
        current: owner.current,
        restore: (materialId, idempotencyKey) =>
          actionsClient.restoreMaterial({ teamId, materialId, idempotencyKey, ...owner.options() }),
        failed: cause => {
          changed();
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        },
        completed: () => {
          changed();
          push({ tone: 'success', text: t('teamToastRestored') });
        }
      });
      push({
        tone: 'success',
        text:
          trashed.length === 1
            ? t('teamToastTrashed')
            : t('teamExplorerTrashedCount', { count: trashed.length }),
        action: { label: t('teamUndo'), run: () => void restore.run() }
      });
    },
    [
      actionsClient,
      workspaceOperations,
      changed,
      clearSelection,
      permissions?.delete,
      pathTo,
      push,
      select,
      t,
      tailClient,
      teamId
    ]
  );

  /**
   * Painted first, written after: a dot that waits for a round trip before it
   * changes reads as a press that did not land, and this is the cheapest write
   * on the screen. A refusal puts the old colour back and says so.
   */
  const setTag = useCallback(
    async (row: TeamMaterialRow, color: TeamMaterialTagColor | null) => {
      if (!client.setMaterialTag) return;
      const previous = row.tagColor ?? null;
      page.patchRow(row.id, { tagColor: color });
      try {
        await client.setMaterialTag({ teamId, materialId: row.id, color });
      } catch (cause) {
        page.patchRow(row.id, { tagColor: previous });
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      }
    },
    [client, page, push, t, teamId]
  );
  const tagging = canTag ? { canTag: true as const, onSetTag: setTag } : undefined;

  return { tailClient, dropMaterials, downloadOriginal, trashRows, tagging };
}
