import { useEffect, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import type { TeamPermissions } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';
import { CopyDriveLinkButton } from '../library/CopyDriveLinkButton';
import { MediaActionIcon } from '../library/mediaActionIcons';
import {
  encodeTaskMaterialDrag,
  TASK_MATERIAL_DRAG_TYPE,
  type TaskMaterialDragItem
} from '../tasks/task-drag';
import { MaterialRowMenu } from './MaterialRowMenu';

export interface MaterialBrowserClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

export function MaterialBrowser({
  teamId,
  client,
  revision = 0,
  syncLabel,
  folderId = null,
  onFolderChange,
  permissions = null,
  onLoaded,
  onChanged,
  onCreateTask,
  onPreview,
  taskDragSelection
}: {
  teamId: string;
  client: MaterialBrowserClient;
  revision?: number;
  syncLabel?: string | null;
  /**
   * The folder the address says is open. Only one level is addressable, so a
   * restored position shows a generic way back to the top rather than a
   * breadcrumb it cannot reconstruct.
   */
  folderId?: string | null;
  /** Reports each move through the tree so the address can follow it. */
  onFolderChange?: (folderId: string | null) => void;
  /**
   * Enables the per-row actions menu. Without permissions there is nothing to
   * offer, so the menu is absent rather than empty.
   */
  permissions?: TeamPermissions | null;
  /** Reports the count of items in the currently viewed folder after each load. */
  onLoaded?: (count: number) => void;
  /** Re-read the folder after a row action changed something in it. */
  onChanged?: () => void;
  /** Convenient reverse flow: create and immediately open a task for this stable material. */
  onCreateTask?: (material: { id: string; name: string }) => void;
  /** Opens the same safe viewer used by catalog search for a file in the tree. */
  onPreview?: (material: TeamMaterialSummary) => void;
  taskDragSelection?: {
    selectedIds: ReadonlySet<string>;
    onChange: (selectedIds: Set<string>) => void;
  };
}) {
  const { t } = useI18n();
  const [path, setPath] = useState<{ id: string; name: string }[]>(() =>
    folderId ? [{ id: folderId, name: '' }] : []
  );
  const [materials, setMaterials] = useState<TeamMaterialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const parentId = path.at(-1)?.id ?? null;

  useEffect(() => {
    setPath([]);
  }, [teamId]);

  // Follow the address when it moves under us — a Back press, or a link opened
  // into an already-mounted browser. Comparing against the current position
  // keeps this from fighting the click handlers that caused the change.
  useEffect(() => {
    setPath(current => {
      const currentId = current.at(-1)?.id ?? null;
      if (currentId === folderId) return current;
      return folderId ? [{ id: folderId, name: '' }] : [];
    });
  }, [folderId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .listMaterials(teamId, parentId)
      .then(value => {
        if (!active) return;
        const visible = value.filter(material => material.teamId === teamId);
        setMaterials(visible);
        setError(null);
        onLoaded?.(visible.length);
      })
      .catch(() => {
        if (active) setError(t('teamLoadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, onLoaded, parentId, revision, t, teamId]);

  return (
    <section className="team-panel team-material-browser" aria-labelledby="team-materials-title">
      <div className="team-panel-heading">
        <h2 id="team-materials-title">{t('teamMaterials')}</h2>
        {syncLabel && <small>{syncLabel}</small>}
      </div>
      {path.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            const next = path.slice(0, -1);
            setPath(next);
            onFolderChange?.(next.at(-1)?.id ?? null);
          }}
        >
          ← {path.length === 1 ? t('teamMaterialsBack') : path.at(-2)?.name}
        </Button>
      )}
      {loading && <p aria-live="polite">…</p>}
      {error && <p className="team-inline-error">{error}</p>}
      {!loading && !error && materials.length === 0 && <p>{t('teamMaterialsEmpty')}</p>}
      <ul className="team-material-list">
        {materials.map(material => (
          <li key={material.id}>
            {material.kind === 'folder' ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  const id = material.providerId ?? material.id;
                  setPath(current => [...current, { id, name: material.name }]);
                  onFolderChange?.(id);
                }}
              >
                <span aria-hidden="true">📁</span> {material.name}
              </Button>
            ) : (
              <>
                <span
                  draggable={Boolean(taskDragSelection)}
                  onDragStart={event => {
                    if (!taskDragSelection) return;
                    const ids = taskDragSelection.selectedIds.has(material.id)
                      ? [...taskDragSelection.selectedIds]
                      : [material.id];
                    const items: TaskMaterialDragItem[] = materials
                      .filter(
                        candidate => candidate.kind !== 'folder' && ids.includes(candidate.id)
                      )
                      .map(candidate => ({
                        id: candidate.id,
                        name: candidate.name,
                        category: candidate.category,
                        previewState: candidate.previewState
                      }));
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(
                      TASK_MATERIAL_DRAG_TYPE,
                      encodeTaskMaterialDrag(items)
                    );
                  }}
                >
                  {taskDragSelection && (
                    <input
                      type="checkbox"
                      checked={taskDragSelection.selectedIds.has(material.id)}
                      aria-label={t('teamTaskSelectMedia', { name: material.name })}
                      onChange={event => {
                        const next = new Set(taskDragSelection.selectedIds);
                        if (event.target.checked) next.add(material.id);
                        else next.delete(material.id);
                        taskDragSelection.onChange(next);
                      }}
                    />
                  )}
                  <span aria-hidden="true">{material.kind === 'shortcut' ? '↗' : '▤'}</span>{' '}
                  {material.name}
                </span>
                <div className="team-material-row-actions">
                  {onPreview && material.kind === 'file' && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="team-media-action is-preview"
                      aria-label={t('teamCatalogPreviewFor', { name: material.name })}
                      onClick={() => onPreview(material)}
                    >
                      <MediaActionIcon kind="preview" />
                      <span>{t('teamCatalogPreview')}</span>
                    </Button>
                  )}
                  <CopyDriveLinkButton
                    teamId={material.teamId}
                    materialId={material.id}
                    name={material.name}
                  />
                  {onCreateTask && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="team-media-action is-task"
                      onClick={() => onCreateTask({ id: material.id, name: material.name })}
                    >
                      <MediaActionIcon kind="task" />
                      <span>{t('creativeLibraryCreateTask')}</span>
                    </Button>
                  )}
                  {/* File management belongs where the files are. Until now it
                      lived only in the search results, so managing a file meant
                      first finding a way to search for it (finding F1). */}
                  {permissions && (
                    <MaterialRowMenu
                      teamId={material.teamId}
                      material={material}
                      permissions={permissions}
                      browseClient={client}
                      onChanged={onChanged ?? (() => undefined)}
                      destinationFolderId={parentId}
                      replaceMaterialId={material.id}
                    />
                  )}
                </div>
              </>
            )}
            {material.category && <small>{material.category}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}
