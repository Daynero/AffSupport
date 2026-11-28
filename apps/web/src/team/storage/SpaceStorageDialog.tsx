import { Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { StorageMeterPanel } from './StorageMeterPanel';
import type { StorageItemTarget } from './StorageItemsList';

/** Where a thing of the list opens: its folder in the explorer, on it (or the trash). */
export function storageItemRoute(teamId: string, item: StorageItemTarget): string {
  return buildTeamRoute({
    spaceId: teamId,
    section: 'explorer',
    query: item.trashed
      ? { trash: true }
      : {
          ...(item.parentFolderId ? { folderId: item.parentFolderId } : {}),
          itemId: item.id
        }
  });
}

/**
 * 057 T057: the memory panel of an R2 space over the page, at the address the space's state
 * already uses for its storage detail (`storage=1`) — so a warning anywhere can send a person
 * here, and a reload in the middle keeps it open.
 */
export function SpaceStorageDialog({
  teamId,
  open,
  onClose,
  canDelete
}: {
  teamId: string;
  open: boolean;
  onClose: () => void;
  canDelete: boolean;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('spaceStorageTitle')}
      size="lg"
      className="space-storage-dialog"
    >
      <StorageMeterPanel
        teamId={teamId}
        canDelete={canDelete}
        onOpenItem={item => navigateTo(storageItemRoute(teamId, item))}
      />
    </Modal>
  );
}
