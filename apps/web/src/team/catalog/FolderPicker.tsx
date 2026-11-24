import { useEffect, useId, useState } from 'react';
import type { TeamFolderNode } from '@video-compressor/shared';
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
  /**
   * The space's folder tree, the one the explorer draws (070, phase 8). Preferred when present:
   * the materials list answers nothing for folders in a space indexed by folder pages, and the
   * picker said «Тут немає тек» at a root with three of them.
   */
  listFolderTree?: (teamId: string) => Promise<TeamFolderNode[]>;
}

type PickerFolder = { id: string; providerId?: string | null; name: string };

/** The children of a folder in the tree; at the root, every node whose parent is not in it. */
function childrenOf(nodes: readonly TeamFolderNode[], parent: string | null): PickerFolder[] {
  const known = new Set(nodes.map(node => node.driveFileId));
  return nodes
    .filter(node =>
      parent
        ? node.parentFolderId === parent
        : !node.parentFolderId || !known.has(node.parentFolderId)
    )
    .map(node => ({ id: node.id, providerId: node.driveFileId, name: node.name }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
  const [folders, setFolders] = useState<PickerFolder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const currentFolder = trail.at(-1) ?? null;

  useEffect(() => {
    let active = true;
    setFolders(null);
    setFailed(false);
    const parent = currentFolder?.providerId ?? null;
    const fromMaterials = () =>
      client
        .listMaterials(teamId, parent)
        .then(items =>
          items.filter(item => item.kind === 'folder' && item.teamId === teamId)
        ) as Promise<PickerFolder[]>;
    /* Both sources, joined: the tree knows folders of a space indexed by folder pages, the
       materials list knows folders it has rows for; either alone has missed some. */
    const read: Promise<PickerFolder[]> = client.listFolderTree
      ? Promise.allSettled([
          client.listFolderTree(teamId).then(nodes => childrenOf(nodes, parent)),
          fromMaterials()
        ]).then(([tree, materials]) => {
          if (tree.status === 'rejected' && materials.status === 'rejected') throw tree.reason;
          const joined = new Map<string, PickerFolder>();
          for (const result of [tree, materials])
            if (result.status === 'fulfilled')
              for (const folder of result.value)
                if (!joined.has(folder.providerId ?? folder.id))
                  joined.set(folder.providerId ?? folder.id, folder);
          return [...joined.values()].sort((left, right) => left.name.localeCompare(right.name));
        })
      : fromMaterials();
    void read
      .then(items => {
        if (active) setFolders(items);
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
