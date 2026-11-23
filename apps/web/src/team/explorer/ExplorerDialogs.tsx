import type { TeamMaterialRow } from '@video-compressor/shared';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute, type TeamRouteQuery } from '../routes';
import type { LibraryBatchScope } from '../library/ProcessLibraryDialog';
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import { ProductCatalogMenuDialog } from '../product-catalog/ProductCatalogMenuDialog';
import { RestitchDeliveryNotices } from '../restitch/RestitchDeliveryNotices';
import type { RestitchDeliveryState } from '../restitch/useRestitchDelivery';
import { CreateFolderDialog } from './CreateFolderDialog';
import { FolderScopeDialog, scopeIdsOf, type ProcessableFolder } from './FolderScopeDialog';
import {
  TeamCompressorDialog,
  type CompressPlan,
  type CompressPlanItem
} from './TeamCompressorDialog';
import {
  UploadConflictDialog,
  type UploadConflictChoice,
  type UploadConflictRequest
} from './UploadConflictDialog';
import type { ExplorerShellClient } from './ExplorerShell';

/** A folder's subtree being read, and what the answer is for. */
export type ExplorerFolderScope = {
  folder: ProcessableFolder;
  intent: 'process' | 'compress';
};

/**
 * Every window the explorer opens, out of `ExplorerShell` (070, FR-001). Each one is a modal
 * in its own portal, so rendering them together — after the corner panels rather than either
 * side of them — moves nothing on the page. The re-stitch notices draw nothing inline; they
 * speak through toasts.
 */
export function ExplorerDialogs({
  teamId,
  client,
  query,
  currentFolderId,
  compressing,
  onCompressing,
  onRunCompress,
  folderScope,
  onFolderScope,
  onProcessSelection,
  conflict,
  creatingFolder,
  onCreateFolder,
  onCloseCreateFolder,
  restitchStates,
  catalogFor,
  onCloseCatalog,
  onChanged,
  processing,
  onCloseProcessing
}: {
  teamId: string;
  client: ExplorerShellClient;
  query: TeamRouteQuery;
  currentFolderId: string | null;
  compressing: CompressPlanItem[] | null;
  onCompressing: (items: CompressPlanItem[] | null) => void;
  onRunCompress: (plan: CompressPlan) => void;
  folderScope: ExplorerFolderScope | null;
  onFolderScope: (scope: ExplorerFolderScope | null) => void;
  onProcessSelection?: (materialIds: string[], scope?: LibraryBatchScope) => void;
  conflict: {
    request: UploadConflictRequest;
    settle: (choice: UploadConflictChoice, forRest: boolean) => void;
  } | null;
  creatingFolder: boolean;
  onCreateFolder: (name: string) => Promise<void>;
  onCloseCreateFolder: () => void;
  restitchStates: Record<string, RestitchDeliveryState>;
  catalogFor: TeamMaterialRow | null;
  onCloseCatalog: () => void;
  onChanged: () => void;
  processing: { row: TeamMaterialRow } | null;
  onCloseProcessing: () => void;
}) {
  return (
    <>
      {compressing && (
        <TeamCompressorDialog
          teamId={teamId}
          items={compressing}
          client={client}
          onRun={onRunCompress}
          onClose={() => onCompressing(null)}
        />
      )}
      {folderScope && (
        <FolderScopeDialog
          teamId={teamId}
          folder={folderScope.folder}
          intent={folderScope.intent}
          client={client}
          onResolved={result => {
            const { folder, intent } = folderScope;
            onFolderScope(null);
            if (intent === 'compress') {
              if (result.videos.length === 0) return;
              onCompressing(
                result.videos.map(video => ({
                  id: video.id,
                  name: video.name,
                  folderId: video.parentFolderId ?? folder.driveFileId
                }))
              );
              return;
            }
            const ids = scopeIdsOf(result);
            /* An empty scope is not a small batch: with no ids the server reads
               the request as the whole space, so a folder that yielded nothing
               would quietly start everything. */
            if (ids.length === 0) return;
            onProcessSelection?.(ids, {
              kind: 'folder',
              name: folder.name,
              // The walk counts the folder it started from; a folder with five
              // subfolders was reporting six.
              folders: Math.max(0, result.foldersVisited - 1),
              files: ids.length,
              // Separately, because the window's "already done" line is about
              // videos with a transcript, and one video is exactly one
              // transcription job.
              videos: result.videos.length,
              landingIds: result.landings.map(landing => landing.id)
            });
          }}
          onClose={() => onFolderScope(null)}
        />
      )}
      {/* 015 — the running deliveries speak for themselves; nothing is rendered inline. */}
      {conflict && <UploadConflictDialog request={conflict.request} onChoose={conflict.settle} />}
      {creatingFolder && (
        <CreateFolderDialog onCreate={onCreateFolder} onClose={onCloseCreateFolder} />
      )}
      <RestitchDeliveryNotices
        states={restitchStates}
        onConfigure={() =>
          navigateTo(
            buildTeamRoute({
              spaceId: teamId,
              section: 'explorer',
              query: { ...query, settings: true }
            })
          )
        }
      />
      {catalogFor && (
        <ProductCatalogMenuDialog
          teamId={teamId}
          video={{
            id: catalogFor.id,
            name: catalogFor.name,
            parentFolderId: catalogFor.parentFolderId
          }}
          onClose={onCloseCatalog}
          onChanged={onChanged}
        />
      )}
      {processing && (
        <MaterialProcessFlow
          teamId={teamId}
          material={{
            id: processing.row.id,
            name: processing.row.name,
            category: processing.row.category
          }}
          destinationFolderId={processing.row.parentFolderId ?? currentFolderId ?? null}
          browseClient={client}
          onClose={onCloseProcessing}
        />
      )}
    </>
  );
}
