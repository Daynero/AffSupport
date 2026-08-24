import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_TOOL_CONTRACTS,
  resolveLandingTileState,
  type CatalogMaterialItem,
  type CatalogSearchFilters,
  type LandingGalleryItem,
  type LandingRenderPointer
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { toolEventUrl } from '../../api/client';
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
    // A terminal render failure is actionable in this gallery even when its
    // agent-facing reason is the generic `render_error`.  The shared contract
    // intentionally preserves its existing fallback semantics for older
    // agents; the browser can still give the member an explicit retry state.
    const tile =
      render?.state === 'failed'
        ? 'error'
        : resolveLandingTileState({
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
  const multiplexed = Boolean(agent?.capabilities?.includes('event-stream'));
  const fixedFilters = useMemo(() => LANDING_FILTER, []);
  const catalog = useCatalogSearch({ teamId, client, fixedFilters });
  const [renders, setRenders] = useState<LandingRenderPointer[]>([]);
  const [rendersLoading, setRendersLoading] = useState(false);
  const [activeRender, setActiveRender] = useState<{
    materialId: string;
    operationId: string | null;
    progress: number;
  } | null>(null);
  const renderRequestSequence = useRef(0);

  const materialIds = useMemo(
    () => (catalog.result?.items ?? []).map(material => material.id),
    [catalog.result?.items]
  );

  const refetchRenders = useCallback(async () => {
    const sequence = ++renderRequestSequence.current;
    if (!client.listLandingRenders || materialIds.length === 0) {
      if (sequence === renderRequestSequence.current) {
        setRenders([]);
        setRendersLoading(false);
      }
      return;
    }
    setRendersLoading(true);
    try {
      const value = await client.listLandingRenders(teamId, materialIds, 'default');
      if (sequence === renderRequestSequence.current) {
        setRenders(value.filter(render => materialIds.includes(render.materialId)));
      }
    } catch {
      if (sequence === renderRequestSequence.current) setRenders([]);
    } finally {
      if (sequence === renderRequestSequence.current) setRendersLoading(false);
    }
  }, [client, materialIds, teamId]);

  useEffect(() => {
    void refetchRenders();
  }, [refetchRenders]);

  const refetch = useCallback(async () => {
    await Promise.all([catalog.refetch(), refetchRenders()]);
  }, [catalog.refetch, refetchRenders]);

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
    url: activeRender?.operationId ? toolEventUrl('team-landings') : null,
    channel: 'team',
    multiplexed,
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
      if (progress.state !== 'running') {
        setActiveRender(current =>
          current?.operationId === progress.operationId ? null : current
        );
        void refetch();
      }
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
    refetch,
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
