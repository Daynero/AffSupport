import { useEffect, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import type { TeamPermissions } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';
import { CopyDriveLinkButton } from '../library/CopyDriveLinkButton';
import { MediaActionIcon } from '../library/mediaActionIcons';
import { MaterialRowMenu } from './MaterialRowMenu';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';

export interface MaterialBrowserClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

export function MaterialBrowser({
  teamId,
  client,
  revision = 0,
  folderId = null,
  onFolderChange,
  permissions = null,
  onLoaded,
  onChanged,
  onCreateTask,
  onPreview
}: {
  teamId: string;
  client: MaterialBrowserClient;
  revision?: number;
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
      {/* No sibling status line here any more: it was hardcoded from the Drive
          connection state, so it announced "catalog is up to date" over a banner
          that said the scan was still running (finding S4). The banner is the
          single source of sync truth. */}
      <div className="team-panel-heading">
        <h2 id="team-materials-title">{t('teamMaterials')}</h2>
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
      {loading && <LabeledSkeleton label="teamMaterialsLoading" rows={4} />}
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
                {/* The drag-and-drop selection this row used to advertise had no
                    consumer: nothing rendered the browser with a selection, and
                    the only drop target read a payload nothing produced. The
                    keyboard and drag model is out of scope for this pass, so the
                    plumbing goes rather than sitting there looking supported. */}
                <span>
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
