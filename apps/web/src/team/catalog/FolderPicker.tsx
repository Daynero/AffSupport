import { useEffect, useId, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import {
  Breadcrumb,
  Button,
  EmptyState,
  ErrorState,
  LoadingState
} from '../../components/ui/index';
import { ChevronRight, Folder } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

export interface FolderPickerClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

/**
 * Choose a destination folder by looking at the folders.
 *
 * Every destination in team mode used to be a text field expecting a raw Drive
 * id — a value nothing in the interface ever shows you, so the field was
 * unusable without leaving the app. This walks the same tree the Files browser
 * walks and hands back the id it found.
 */
export function FolderPicker({
  teamId,
  client,
  title,
  onSelect,
  onClose,
  nested = false,
  selectionId = 'provider',
  allowRoot = true
}: {
  teamId: string;
  client: FolderPickerClient;
  /** What the destination is for ("Move to…", "Save output in…"). */
  title: string;
  onSelect: (folder: { id: string; name: string }) => void;
  onClose: () => void;
  /** Raised over another dialog — the space settings, for one. */
  nested?: boolean;
  /** Most destinations need the Drive id; material-backed settings need Soty's row id. */
  selectionId?: 'material' | 'provider';
  /** Some sources require an actual material row; the space root has none. */
  allowRoot?: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  // The root has no material row of its own, so it is named rather than listed.
  const [trail, setTrail] = useState<{ materialId: string; providerId: string; name: string }[]>(
    []
  );
  const [folders, setFolders] = useState<TeamMaterialSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const currentFolder = trail.at(-1) ?? null;

  useEffect(() => {
    let active = true;
    setFolders(null);
    setFailed(false);
    void client
      .listMaterials(teamId, currentFolder?.providerId ?? null)
      .then(items => {
        if (!active) return;
        setFolders(items.filter(item => item.kind === 'folder' && item.teamId === teamId));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, currentFolder?.providerId, teamId]);

  return (
    <Modal
      labelledBy={titleId}
      size="sm"
      nested={nested}
      className="team-folder-picker"
      onClose={onClose}
    >
      <h2 id={titleId}>{title}</h2>

      {/* The way back up, as the inventory's breadcrumb (070, phase 8): it was a row of bare
          buttons with a "/" drawn between them in CSS. */}
      <Breadcrumb
        className="team-folder-picker-trail"
        label={t('teamFolderPickerTrailLabel')}
        items={[
          { id: 'root', label: t('teamFolderPickerRoot'), onSelect: () => setTrail([]) },
          ...trail.map((folder, index) => ({
            id: folder.materialId,
            label: folder.name,
            onSelect: () => setTrail(current => current.slice(0, index + 1))
          }))
        ]}
      />

      {folders === null && !failed && (
        <LoadingState count={3} label={t('teamFolderPickerLoading')} />
      )}
      {failed && <ErrorState className="team-inline-error" message={t('teamFolderPickerFailed')} />}
      {folders !== null && folders.length === 0 && (
        <EmptyState size="sm" title={t('teamFolderPickerEmpty')} />
      )}

      <ul className="team-folder-picker-list">
        {(folders ?? []).map(folder => (
          <li key={folder.id}>
            {/* A folder row opens the folder; the icon is the product's, not an emoji. */}
            <Button
              block
              color="neutral"
              variant="ghost"
              className="team-folder-picker-row"
              leading={<Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              trailing={
                <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              }
              onClick={() =>
                setTrail(current => [
                  ...current,
                  {
                    materialId: folder.id,
                    providerId: folder.providerId ?? folder.id,
                    name: folder.name
                  }
                ])
              }
            >
              {folder.name}
            </Button>
          </li>
        ))}
      </ul>

      <div className="team-dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamCancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!allowRoot && !currentFolder}
          // The root itself is a legitimate destination, and it is the one place
          // the tree cannot offer as a row.
          onClick={() => {
            if (!allowRoot && !currentFolder) return;
            onSelect(
              currentFolder
                ? {
                    id:
                      selectionId === 'material'
                        ? currentFolder.materialId
                        : currentFolder.providerId,
                    name: currentFolder.name
                  }
                : { id: 'root', name: t('teamFolderPickerRoot') }
            );
          }}
        >
          {currentFolder
            ? t('teamFolderPickerSelectNamed', { name: currentFolder.name })
            : t('teamFolderPickerSelectRoot')}
        </Button>
      </div>
    </Modal>
  );
}
