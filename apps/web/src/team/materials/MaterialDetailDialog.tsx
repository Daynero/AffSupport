import type { ReactNode } from 'react';
import { Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { MaterialCompanions } from './actions';
import { MaterialDetailCard, type DetailMaterial } from './MaterialDetailCard';

/**
 * The details card where a file is met away from the explorer (070, T025): a task's
 * attachment, a catalog in the updater. The same card the explorer's pane shows — the facts,
 * the rank, the catalog's facts, the tasks it is on, its note — over the surface that opened it,
 * so looking at a file does not mean leaving the task or the updater for its folder.
 */
export function MaterialDetailDialog({
  material,
  folderName,
  picture,
  nested = false,
  onClose,
  actions
}: {
  material: DetailMaterial;
  folderName?: string | null;
  picture?: string | null;
  /** Raised over another dialog (the updater is one). */
  nested?: boolean;
  onClose: () => void;
  actions?: (companions: MaterialCompanions | undefined, refresh: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('materialActionDetails')}
      size="sm"
      nested={nested}
      className="team-material-detail-dialog"
      onClose={onClose}
    >
      <MaterialDetailCard
        material={material}
        folderName={folderName}
        picture={picture}
        actions={actions}
      />
    </Modal>
  );
}
