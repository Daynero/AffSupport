import { useEffect, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';

export interface MaterialBrowserClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

export function MaterialBrowser({
  teamId,
  client,
  revision = 0,
  syncLabel
}: {
  teamId: string;
  client: MaterialBrowserClient;
  revision?: number;
  syncLabel?: string | null;
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
        setMaterials(value.filter(material => material.teamId === teamId));
        setError(null);
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
  }, [client, parentId, revision, t, teamId]);

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
              <span>
                <span aria-hidden="true">{material.kind === 'shortcut' ? '↗' : '▤'}</span>{' '}
                {material.name}
              </span>
            )}
            {material.category && <small>{material.category}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}
