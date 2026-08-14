import { useEffect, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';
import { TASK_MATERIAL_DRAG_TYPE } from '../tasks/task-drag';

export interface MaterialBrowserClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

export function MaterialBrowser({
  teamId,
  client,
  revision = 0,
  syncLabel,
  onLoaded,
  onCreateTask,
  taskDragSelection
}: {
  teamId: string;
  client: MaterialBrowserClient;
  revision?: number;
  syncLabel?: string | null;
  /** Reports the count of items in the currently viewed folder after each load. */
  onLoaded?: (count: number) => void;
  /** Convenient reverse flow: create and immediately open a task for this stable material. */
  onCreateTask?: (material: { id: string; name: string }) => void;
  taskDragSelection?: {
    selectedIds: ReadonlySet<string>;
    onChange: (selectedIds: Set<string>) => void;
  };
}) {
  const { t } = useI18n();
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [materials, setMaterials] = useState<TeamMaterialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const parentId = path.at(-1)?.id ?? null;

  useEffect(() => {
    setPath([]);
  }, [teamId]);

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
          onClick={() => setPath(current => current.slice(0, -1))}
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
                onClick={() =>
                  setPath(current => [
                    ...current,
                    { id: material.providerId ?? material.id, name: material.name }
                  ])
                }
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
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(TASK_MATERIAL_DRAG_TYPE, JSON.stringify(ids));
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
                {onCreateTask && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onCreateTask({ id: material.id, name: material.name })}
                  >
                    {t('creativeLibraryCreateTask')}
                  </Button>
                )}
              </>
            )}
            {material.category && <small>{material.category}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}
