import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_TOOL_CONTRACTS,
  resolveLandingTileState,
  type CatalogMaterialItem,
  type CatalogSearchFilters,
  type LandingGalleryItem,
  type LandingRenderPointer
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { teamLandingEventUrl } from '../../api/client';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { useTeam } from '../TeamContext';
import { useCatalogSearch, type CatalogSearchClient } from '../catalog/useCatalogSearch';

const LANDING_FILTER: Partial<CatalogSearchFilters> = { category: ['landing', 'archive'] };

export interface TeamLandingsDataClient extends CatalogSearchClient {
  listLandingRenders?: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  landingRenderImageUrl?: (
    artifact: NonNullable<LandingRenderPointer['artifact']>,
    segment: number
  ) => string;
}

interface TeamLandingProgressEvent {
  type: 'team:operations';
  operations: Array<{
    operationId: string;
    state: 'running' | 'succeeded' | 'failed' | 'canceled';
    stage: string;
    progress: number;
  }>;
}

export function deriveLandingGalleryItems(
  materials: CatalogMaterialItem[],
  renders: LandingRenderPointer[],
  context: {
    agentPaired: boolean;
    agentCompatible: boolean;
    canDownload: boolean;
    canEdit: boolean;
  }
): LandingGalleryItem[] {
  const byMaterial = new Map(renders.map(render => [render.materialId, render] as const));
  return materials.map(material => {
    const render = byMaterial.get(material.id);
    const isCandidate = material.category === 'archive';
    const hasValidReadyRender = render?.state === 'ready' && render.artifact !== undefined;
    const tile = resolveLandingTileState({
      isCandidate,
      hasValidReadyRender,
      renderState: render?.state,
      failureReason: render?.failureReason,
      agentPaired: context.agentPaired,
      agentCompatible: context.agentCompatible
    });
    return {
      material,
      isCandidate,
      tile,
      ...(render ? { render } : {}),
      ...(render?.failureReason ? { unavailableReason: render.failureReason } : {}),
      canDownload: context.canDownload,
      canEdit: context.canEdit
    };
  });
}

export function useTeamLandings(input: { teamId: string; client: TeamLandingsDataClient }) {
  const { teamId, client } = input;
  const team = useTeam();
  const agent = useOptionalAgent();
  const fixedFilters = useMemo(() => LANDING_FILTER, []);
  const catalog = useCatalogSearch({ teamId, client, fixedFilters });
  const [renders, setRenders] = useState<LandingRenderPointer[]>([]);
  const [rendersLoading, setRendersLoading] = useState(false);
  const [activeRender, setActiveRender] = useState<{
    materialId: string;
    operationId: string | null;
    progress: number;
  } | null>(null);

  const materialIds = useMemo(
    () => (catalog.result?.items ?? []).map(material => material.id),
    [catalog.result?.items]
  );

  useEffect(() => {
    let active = true;
    if (!client.listLandingRenders || materialIds.length === 0) {
      setRenders([]);
      setRendersLoading(false);
      return;
    }
    setRendersLoading(true);
    void client
      .listLandingRenders(teamId, materialIds, 'default')
      .then(value => {
        if (active) setRenders(value.filter(render => materialIds.includes(render.materialId)));
      })
      .catch(() => {
        if (active) setRenders([]);
      })
      .finally(() => {
        if (active) setRendersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, materialIds, teamId]);

  const agentPaired = agent?.connectedOnce === true;
  const agentCompatible =
    agent?.connection === 'connected' &&
    (agent.toolContracts.teamWorkspace ?? 0) >= AGENT_TOOL_CONTRACTS.teamWorkspace;
  const items = useMemo(
    () =>
      deriveLandingGalleryItems(catalog.result?.items ?? [], renders, {
        agentPaired,
        agentCompatible,
        canDownload: team.can('download'),
        canEdit: team.can('edit')
      }),
    [agentCompatible, agentPaired, catalog.result?.items, renders, team]
  );

  const resolveThumbnail = (item: LandingGalleryItem) => {
    const artifact = item.render?.artifact;
    return artifact && client.landingRenderImageUrl
      ? client.landingRenderImageUrl(artifact, 0)
      : null;
  };

  useAgentEventStream<TeamLandingProgressEvent>({
    url: activeRender?.operationId ? teamLandingEventUrl() : null,
    enabled: Boolean(activeRender?.operationId),
    onMessage: event => {
      if (event.type !== 'team:operations' || !activeRender?.operationId) return;
      const progress = event.operations.find(
        operation => operation.operationId === activeRender.operationId
      );
      if (!progress) return;
      setActiveRender(current =>
        current?.operationId === progress.operationId
          ? { ...current, progress: Math.min(100, Math.max(0, progress.progress)) }
          : current
      );
      if (progress.state !== 'running') void catalog.refetch();
    }
  });

  const beginRender = useCallback((materialId: string) => {
    setActiveRender({ materialId, operationId: null, progress: 0 });
  }, []);
  const bindRenderOperation = useCallback((operationId: string) => {
    setActiveRender(current => (current ? { ...current, operationId } : current));
  }, []);
  const finishRender = useCallback(() => setActiveRender(null), []);

  return {
    ...catalog,
    items,
    rendersLoading,
    resolveThumbnail,
    agentCompatible,
    activeRender,
    beginRender,
    bindRenderOperation,
    finishRender
  };
}
