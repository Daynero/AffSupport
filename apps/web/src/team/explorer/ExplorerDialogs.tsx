import type { TeamMaterialRow } from '@video-compressor/shared';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute, type TeamRouteQuery } from '../routes';
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import { ProductCatalogMenuDialog } from '../product-catalog/ProductCatalogMenuDialog';
import { RestitchDeliveryNotices } from '../restitch/RestitchDeliveryNotices';
import type { RestitchDeliveryState } from '../restitch/useRestitchDelivery';
import { CreateFolderDialog } from './CreateFolderDialog';
import { ProcessScopeDialog } from '../processing/ProcessScopeDialog';
import type { ProcessOrigin } from '../processing/processScope';
import type { CompressPlan } from './TeamCompressorDialog';
import {
  UploadConflictDialog,
  type UploadConflictChoice,
  type UploadConflictRequest
} from './UploadConflictDialog';
import type { ExplorerShellClient } from './ExplorerShell';

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
  compressOrigin,
  onCloseCompress,
  onRunCompress,
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
  /** The one compression dialog (070, T062), on the scope it was opened from. */
  compressOrigin: ProcessOrigin | null;
  onCloseCompress: () => void;
  onRunCompress: (plan: CompressPlan) => void;
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
      {compressOrigin && (
        <ProcessScopeDialog
          teamId={teamId}
          origin={compressOrigin}
          client={client}
          onCompress={onRunCompress}
          onClose={onCloseCompress}
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
          /* From a video's catalogs to every catalog of the space, and back (070, T057). */
          onOpenManager={() => {
            onCloseCatalog();
            navigateTo(
              buildTeamRoute({
                spaceId: teamId,
                section: 'explorer',
                query: { ...query, updater: true }
              })
            );
          }}
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
