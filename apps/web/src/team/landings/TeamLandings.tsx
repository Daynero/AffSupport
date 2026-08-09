import { useEffect, useMemo, useState } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  LandingGalleryItem
} from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { trackTeamLandingGalleryView, trackTeamLandingOpen } from '../../analytics/service';
import { useOptionalAgent } from '../../AgentContext';
import { MaterialPreview } from '../preview/MaterialPreview';
import { LandingGallery } from './LandingGallery';

export interface TeamLandingsClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
}

/**
 * Shared landings gallery for the entered space (feature 004, US1 + US2). Lists every landing
 * in the connected folder — a `category=landing` view over the existing catalog search, so team
 * isolation, permissions, and freshness come from the deployed 001 backend unchanged — and opens
 * any landing in the existing view-gated `MaterialPreview`. A shared render thumbnail (US3) is a
 * later enhancement; here the preview is produced live by the paired agent on open.
 */
export function TeamLandings({ teamId, client }: { teamId: string; client: TeamLandingsClient }) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const [response, setResponse] = useState<CatalogSearchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [previewing, setPreviewing] = useState<CatalogMaterialItem | null>(null);

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    setLoading(true);
    setError(false);
    void client
      .searchCatalog(teamId, { filters: { category: ['landing'] }, pageSize: 100 })
      .then(result => {
        if (!active) return;
        setResponse(result);
        trackTeamLandingGalleryView({
          itemCount: result.total,
          readyCount: result.items.length,
          durationMs: Date.now() - startedAt
        });
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const items = useMemo<LandingGalleryItem[]>(
    () =>
      (response?.items ?? []).map(material => ({
        material,
        isCandidate: material.classificationSource !== 'inspected_landing',
        tile: 'ready',
        canDownload: false,
        canEdit: false
      })),
    [response]
  );

  return (
    <section className="team-panel team-landings" aria-labelledby="team-landings-title">
      <div className="team-panel-heading">
        <h2 id="team-landings-title">{t('teamLandingsTitle')}</h2>
      </div>
      <LandingGallery
        items={items}
        loading={loading}
        error={error}
        freshness={response?.catalogFreshness}
        onOpen={item => {
          trackTeamLandingOpen({
            tileState: item.tile,
            hadAgent: agent?.teamWorkspaceAvailable === true
          });
          setPreviewing(item.material);
        }}
      />
      {previewing && (
        <MaterialPreview
          teamId={teamId}
          material={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </section>
  );
}
