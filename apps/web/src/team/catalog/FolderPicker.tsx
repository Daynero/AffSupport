import { useEffect, useId, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

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
  onClose
}: {
  teamId: string;
  client: FolderPickerClient;
  /** What the destination is for ("Move to…", "Save output in…"). */
  title: string;
  onSelect: (folder: { id: string; name: string }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  // The root has no material row of its own, so it is named rather than listed.
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<TeamMaterialSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const currentFolder = trail.at(-1) ?? null;

  useEffect(() => {
    let active = true;
    setFolders(null);
    setFailed(false);
    void client
      .listMaterials(teamId, currentFolder?.id ?? null)
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
  }, [client, currentFolder?.id, teamId]);

  return (
    <Modal labelledBy={titleId} size="sm" className="team-folder-picker" onClose={onClose}>
      <h3 id={titleId}>{title}</h3>

      <nav className="team-folder-picker-trail" aria-label={t('teamFolderPickerTrailLabel')}>
        <button type="button" onClick={() => setTrail([])}>
          {t('teamFolderPickerRoot')}
        </button>
        {trail.map((folder, index) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => setTrail(current => current.slice(0, index + 1))}
          >
            {folder.name}
          </button>
        ))}
      </nav>

      {folders === null && !failed && (
        <p className="ui-skeleton-label" aria-live="polite">
          {t('teamFolderPickerLoading')}
        </p>
      )}
      {failed && (
        <p className="team-inline-error" role="alert">
          {t('teamFolderPickerFailed')}
        </p>
      )}
      {folders !== null && folders.length === 0 && <p>{t('teamFolderPickerEmpty')}</p>}

      <ul className="team-folder-picker-list">
        {(folders ?? []).map(folder => (
          <li key={folder.id}>
            <button
              type="button"
              onClick={() =>
                setTrail(current => [
                  ...current,
                  { id: folder.providerId ?? folder.id, name: folder.name }
                ])
              }
            >
              <span aria-hidden="true">📁</span> {folder.name}
            </button>
          </li>
        ))}
      </ul>

      <div className="team-dialog-actions">
        <Button
          type="button"
          variant="primary"
          // The root itself is a legitimate destination, and it is the one place
          // the tree cannot offer as a row.
          onClick={() => onSelect(currentFolder ?? { id: 'root', name: t('teamFolderPickerRoot') })}
        >
          {currentFolder
            ? t('teamFolderPickerSelectNamed', { name: currentFolder.name })
            : t('teamFolderPickerSelectRoot')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamCancel')}
        </Button>
      </div>
    </Modal>
  );
}
