import type { Dispatch, SetStateAction } from 'react';
import type { TeamPermissions } from '@video-compressor/shared';
import type { CatalogRegistryRow } from '../../api/team';
import { ConfirmDialog } from '../../components/ui/index';
import { catalogDeleteConfirmKey, useI18n } from '../../i18n';
import { CatalogPublicationDialog } from '../product-catalog/CatalogPublicationDialog';
import { LazyCatalogRenameDialog } from '../product-catalog/LazyCatalogRenameDialog.js';
import { LazyCatalogVideoReplacementDialog } from '../product-catalog/LazyCatalogVideoReplacementDialog';
import { ProductCatalogMenuDialog } from '../product-catalog/ProductCatalogMenuDialog';
import type { useCatalogVideoR2Team } from '../product-catalog/useCatalogVideoR2Team';
import { CatalogVideoVariationsDialog } from './CatalogVideoVariationsDialog';
import type { useCatalogInlineChanges } from './useCatalogInlineChanges';
import type { useCatalogRegistry } from './useCatalogUpdater';

type Setter<T> = Dispatch<SetStateAction<T>>;

/**
 * The manager's smaller windows — replacing a video, renaming, video variations, publication,
 * the video's own catalogs, and the three questions it asks (discard a draft, run what can be
 * run, delete) — out of the dialog (070, T056).
 */
export interface CatalogUpdaterSideDialogsProps {
  teamId: string;
  registry: ReturnType<typeof useCatalogRegistry>;
  onChanged?: () => void;
  permissions: TeamPermissions | null | undefined;
  mayRun: boolean;
  clockOffsetMs: number;
  inline: ReturnType<typeof useCatalogInlineChanges>;
  busyIds: ReadonlySet<string>;
  rowsById: ReadonlyMap<string, CatalogRegistryRow>;
  videoR2: ReturnType<typeof useCatalogVideoR2Team>;
  replaceVideoCatalogId: string | null;
  setReplaceVideoCatalogId: Setter<string | null>;
  renameRow: CatalogRegistryRow | null;
  setRenameRow: Setter<CatalogRegistryRow | null>;
  renameOpen: boolean;
  setRenameOpen: Setter<boolean>;
  discardAction: (() => void) | null;
  setDiscardAction: Setter<(() => void) | null>;
  closeUncertain: boolean;
  setEditorDirty: Setter<boolean>;
  excludedRuns: string[] | null;
  setExcludedRuns: Setter<string[] | null>;
  updateNow: (ids: string[]) => void;
  videoVariationsRow: CatalogRegistryRow | null;
  setVideoVariationsRow: Setter<CatalogRegistryRow | null>;
  publicationCatalogId: string | null;
  setPublicationCatalogId: Setter<string | null>;
  videoCatalogsRow: CatalogRegistryRow | null;
  setVideoCatalogsRow: Setter<CatalogRegistryRow | null>;
  confirmDelete: string[];
  setConfirmDelete: Setter<string[]>;
  deleteSelected: () => Promise<void>;
}

export function CatalogUpdaterSideDialogs({
  busyIds,
  closeUncertain,
  confirmDelete,
  deleteSelected,
  discardAction,
  excludedRuns,
  inline,
  mayRun,
  onChanged,
  permissions,
  publicationCatalogId,
  registry,
  renameOpen,
  renameRow,
  replaceVideoCatalogId,
  rowsById,
  setConfirmDelete,
  setDiscardAction,
  setEditorDirty,
  setExcludedRuns,
  setPublicationCatalogId,
  setRenameOpen,
  setRenameRow,
  setReplaceVideoCatalogId,
  setVideoCatalogsRow,
  setVideoVariationsRow,
  teamId,
  updateNow,
  clockOffsetMs,
  videoCatalogsRow,
  videoR2,
  videoVariationsRow
}: CatalogUpdaterSideDialogsProps) {
  const { t, language } = useI18n();
  return (
    <>
      {replaceVideoCatalogId && (
        <LazyCatalogVideoReplacementDialog
          teamId={teamId}
          catalogId={replaceVideoCatalogId}
          open={Boolean(replaceVideoCatalogId)}
          revision={registry.lastLoadedAt}
          disabled={!permissions?.edit || !mayRun}
          onClose={() => setReplaceVideoCatalogId(null)}
          onChanged={() => {
            registry.reload();
            onChanged?.();
          }}
        />
      )}
      {renameRow && (
        <LazyCatalogRenameDialog
          teamId={teamId}
          materialId={renameRow.catalogId}
          currentName={renameRow.name}
          open={renameOpen}
          disabled={!permissions?.edit}
          surface="catalog_manager"
          onClose={() => setRenameOpen(false)}
          onRenamed={name => {
            setRenameRow(row => (row ? { ...row, name } : row));
            registry.reload();
          }}
        />
      )}
      {discardAction && (
        <ConfirmDialog
          nested
          title={t(
            closeUncertain ? 'catalogUpdaterUncertainCloseTitle' : 'catalogUpdaterDiscardTitle'
          )}
          body={t(
            closeUncertain ? 'catalogUpdaterUncertainCloseBody' : 'catalogUpdaterDiscardBody'
          )}
          confirmLabel={t(closeUncertain ? 'catalogUpdaterClose' : 'catalogUpdaterDiscard')}
          cancelLabel={t('catalogUpdaterKeepEditing')}
          onCancel={() => setDiscardAction(null)}
          onConfirm={() => {
            const action = discardAction;
            setDiscardAction(null);
            setEditorDirty(false);
            action();
          }}
        />
      )}
      {excludedRuns && (
        <ConfirmDialog
          nested
          title={t('catalogIconsExcluded')}
          body={excludedRuns
            .filter(
              id =>
                inline.blocked(id) ||
                busyIds.has(id) ||
                rowsById.get(id)?.updatePending ||
                rowsById.get(id)?.profile?.reconciliationRequired
            )
            .map(
              id =>
                `${rowsById.get(id)?.name}: ${inline.blocked(id) || busyIds.has(id) ? t('catalogIconsPendingRun') : rowsById.get(id)?.updatePending ? t('catalogUpdaterUpdatingNow') : t('catalogUpdaterReconciliationHold')}`
            )
            .join('; ')}
          confirmLabel={t('catalogIconsRunReady')}
          cancelLabel={t('catalogUpdaterClose')}
          onCancel={() => setExcludedRuns(null)}
          onConfirm={() => {
            const ids = excludedRuns.filter(
              id =>
                !inline.blocked(id) &&
                !busyIds.has(id) &&
                !rowsById.get(id)?.updatePending &&
                !rowsById.get(id)?.profile?.reconciliationRequired
            );
            setExcludedRuns(null);
            if (ids.length) void updateNow(ids);
          }}
        />
      )}
      {videoVariationsRow && (
        <CatalogVideoVariationsDialog
          teamId={teamId}
          row={videoVariationsRow}
          onClose={() => setVideoVariationsRow(null)}
          onChanged={registry.reload}
        />
      )}
      {publicationCatalogId && (
        <CatalogPublicationDialog
          teamId={teamId}
          catalogId={publicationCatalogId}
          clockOffsetMs={clockOffsetMs}
          onClose={() => setPublicationCatalogId(null)}
          onChanged={registry.reload}
        />
      )}
      {/* The catalog's video and its other catalogs (070, T057), over the manager; their
          "Менеджер каталогів" comes back here. */}
      {videoCatalogsRow && (
        <ProductCatalogMenuDialog
          teamId={teamId}
          video={{
            id: videoCatalogsRow.videoId,
            name: videoCatalogsRow.videoName,
            parentFolderId: videoCatalogsRow.folderDriveId
          }}
          onClose={() => setVideoCatalogsRow(null)}
          onOpenManager={() => setVideoCatalogsRow(null)}
          onChanged={() => {
            registry.reload();
            onChanged?.();
          }}
        />
      )}
      {confirmDelete.length > 0 && (
        <ConfirmDialog
          nested
          title={t('catalogUpdaterDeleteSelected')}
          body={[
            t(catalogDeleteConfirmKey(language, confirmDelete.length), {
              count: confirmDelete.length
            }),
            confirmDelete.some(id => videoR2.row(id).enabled)
              ? t('catalogVideoR2DeleteWarning')
              : null,
            confirmDelete.some(id => rowsById.get(id)?.driveConnection?.state === 'detached')
              ? t('catalogDeleteDetachedNote')
              : null
          ]
            .filter(Boolean)
            .join(' ')}
          confirmLabel={t('catalogUpdaterDeleteSelected')}
          cancelLabel={t('teamCancel')}
          busy={busyIds.size > 0}
          onCancel={() => setConfirmDelete([])}
          onConfirm={() => void deleteSelected()}
        />
      )}
    </>
  );
}
