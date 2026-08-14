import { useEffect, useRef, useState } from 'react';
import type {
  CatalogMaterialItem,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  CatalogVocabulary,
  LandingRenderPointer,
  RenderArtifactRef,
  TeamLandingRenderJob
} from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import {
  trackTeamLandingGalleryView,
  trackTeamLandingOpen,
  trackTeamLandingRender
} from '../../analytics/service';
import { renderTeamLanding } from '../../api/client';
import { useOptionalAgent } from '../../AgentContext';
import { CatalogFilters } from '../catalog/CatalogFilters';
import { CatalogSearchBar } from '../catalog/CatalogSearchBar';
import { Button } from '../../components/ui';
import { navigateTo } from '../../lib/navigation';
import { LandingGallery } from './LandingGallery';
import { LandingFullView } from './LandingFullView';
import { useTeamLandings } from './useTeamLandings';

export interface TeamLandingsClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
  getCatalogVocabulary: (teamId: string) => Promise<CatalogVocabulary>;
  listLandingRenders?: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  landingRenderImageUrl?: (artifact: RenderArtifactRef, segment: number) => string;
  startLandingRender?: (
    teamId: string,
    materialId: string,
    preset?: string
  ) => Promise<TeamLandingRenderJob>;
  getLandingRenderArtifact?: (
    teamId: string,
    materialId: string,
    preset?: string
  ) => Promise<RenderArtifactRef | null>;
}

/** Shared gallery over the entered space's category-scoped catalog. */
export function TeamLandings({
  teamId,
  client,
  onCreateTask
}: {
  teamId: string;
  client: TeamLandingsClient;
  onCreateTask?: (asset: { id: string; name: string }) => void;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const gallery = useTeamLandings({ teamId, client });
  const [previewing, setPreviewing] = useState<{
    material: CatalogMaterialItem;
    artifact?: RenderArtifactRef;
    tileState: Parameters<typeof trackTeamLandingOpen>[0]['tileState'];
    hadAgent: boolean;
    openedAt: number;
  } | null>(null);
  const measuredResult = useRef<CatalogSearchResponse | null>(null);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (!gallery.result || measuredResult.current === gallery.result) return;
    measuredResult.current = gallery.result;
    trackTeamLandingGalleryView({
      itemCount: gallery.result.total,
      readyCount: gallery.items.filter(item => item.tile === 'ready').length,
      durationMs: Date.now() - startedAt.current
    });
  }, [gallery.items, gallery.result]);

  return (
    <section className="team-panel team-landings" aria-labelledby="team-landings-title">
      <div className="team-panel-heading">
        <h2 id="team-landings-title">{t('teamLandingsTitle')}</h2>
        <div className="team-landings-heading-actions">
          {(gallery.loading || gallery.rendersLoading) && (
            <small aria-live="polite">{t('teamLandingsLoading')}</small>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigateTo(`/landing-preview?team=${encodeURIComponent(teamId)}`)}
          >
            {t('teamLandingsOpenLocalPreviewer')}
          </Button>
        </div>
      </div>
      {(gallery.result?.total ?? 0) > 0 && (
        <div className="team-landings-discovery">
          <CatalogSearchBar value={gallery.query} onChange={gallery.setQuery} />
          <CatalogFilters
            filters={gallery.filters}
            vocabulary={gallery.vocabulary}
            hasContent
            visibleKeys={['geo', 'language', 'offer']}
            onSet={gallery.setFacet}
            onRemove={gallery.removeFilter}
            onClear={gallery.clearFilters}
          />
        </div>
      )}
      <LandingGallery
        items={gallery.items}
        loading={gallery.loading}
        error={gallery.error}
        freshness={gallery.result?.catalogFreshness}
        page={gallery.page}
        total={gallery.result?.total ?? 0}
        pageSize={50}
        onPageChange={gallery.setPage}
        resolveThumbnail={gallery.resolveThumbnail}
        renderingMaterialId={gallery.activeRender?.materialId ?? null}
        renderProgress={gallery.activeRender?.progress ?? null}
        onRender={
          gallery.agentCompatible && client.startLandingRender
            ? item => {
                if (gallery.activeRender) return;
                const renderStartedAt = Date.now();
                gallery.beginRender(item.material.id);
                void client.startLandingRender!(teamId, item.material.id, 'default')
                  .then(job => {
                    gallery.bindRenderOperation(job.operationId);
                    return renderTeamLanding(job);
                  })
                  .then(async () => {
                    trackTeamLandingRender({
                      outcome: 'ready',
                      durationMs: Date.now() - renderStartedAt
                    });
                    await gallery.refetch();
                  })
                  .catch(async () => {
                    trackTeamLandingRender({
                      outcome: 'failed',
                      durationMs: Date.now() - renderStartedAt
                    });
                    await gallery.refetch();
                  })
                  .finally(gallery.finishRender);
              }
            : undefined
        }
        onOpen={item => {
          setPreviewing({
            material: item.material,
            tileState: item.tile,
            hadAgent: agent?.teamWorkspaceAvailable === true,
            openedAt: Date.now(),
            ...(item.render?.artifact ? { artifact: item.render.artifact } : {})
          });
        }}
        onCreateTask={item => onCreateTask?.(item.material)}
      />
      {previewing && (
        <LandingFullView
          teamId={teamId}
          material={previewing.material}
          artifact={previewing.artifact}
          artifactClient={
            client.getLandingRenderArtifact && client.landingRenderImageUrl
              ? {
                  getLandingRenderArtifact: client.getLandingRenderArtifact,
                  landingRenderImageUrl: client.landingRenderImageUrl
                }
              : undefined
          }
          onClose={() => {
            trackTeamLandingOpen({
              tileState: previewing.tileState,
              hadAgent: previewing.hadAgent,
              durationMs: Date.now() - previewing.openedAt
            });
            setPreviewing(null);
          }}
        />
      )}
    </section>
  );
}
