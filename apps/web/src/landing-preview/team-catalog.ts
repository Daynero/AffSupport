import type {
  CatalogMaterialItem,
  CatalogSearchRequestInput,
  CatalogSearchResponse,
  LandingRenderPointer,
  RenderArtifactRef,
  TeamLandingPreviewCatalogRequest,
  TeamLandingPreviewSnapshotItem
} from '@video-compressor/shared';

const PAGE_SIZE = 100;
const TOKEN_CONCURRENCY = 6;

export interface TeamPreviewCatalogClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
  listLandingRenders: (
    teamId: string,
    materialIds: string[],
    preset: string
  ) => Promise<LandingRenderPointer[]>;
  getLandingRenderArtifact: (
    teamId: string,
    materialId: string,
    preset: string
  ) => Promise<RenderArtifactRef | null>;
  landingRenderImageUrl: (artifact: RenderArtifactRef, segment: number) => string;
}

/** Builds a grant-only snapshot; provider ids, paths and credentials never reach the agent. */
export async function buildTeamPreviewCatalogSnapshot(input: {
  teamId: string;
  teamName: string;
  client: TeamPreviewCatalogClient;
}): Promise<TeamLandingPreviewCatalogRequest> {
  const materials = await listAllLandings(input.teamId, input.client);
  const renders: LandingRenderPointer[] = [];
  for (let offset = 0; offset < materials.length; offset += PAGE_SIZE) {
    renders.push(
      ...(await input.client.listLandingRenders(
        input.teamId,
        materials.slice(offset, offset + PAGE_SIZE).map(material => material.id),
        'default'
      ))
    );
  }
  const byMaterial = new Map(renders.map(render => [render.materialId, render] as const));
  const items = await mapLimit(materials, TOKEN_CONCURRENCY, async material => {
    const render = byMaterial.get(material.id);
    let artifact: RenderArtifactRef | null = null;
    if (render?.state === 'ready' && render.artifact) {
      artifact = await input.client
        .getLandingRenderArtifact(input.teamId, material.id, render.preset)
        .catch(() => null);
    }
    return snapshotItem(material, render, artifact, input.client);
  });
  return { teamId: input.teamId, teamName: input.teamName, items };
}

async function listAllLandings(teamId: string, client: TeamPreviewCatalogClient) {
  const materials: CatalogMaterialItem[] = [];
  for (let page = 1; ; page += 1) {
    const result = await client.searchCatalog(teamId, {
      filters: { category: ['landing', 'archive'] },
      page,
      pageSize: PAGE_SIZE
    });
    if (
      result.items.some(
        item =>
          item.teamId !== teamId || (item.category !== 'landing' && item.category !== 'archive')
      )
    ) {
      throw new Error('INVALID_RESPONSE');
    }
    materials.push(...result.items);
    if (materials.length >= result.total || result.items.length < PAGE_SIZE) return materials;
  }
}

function snapshotItem(
  material: CatalogMaterialItem,
  render: LandingRenderPointer | undefined,
  artifact: RenderArtifactRef | null,
  client: TeamPreviewCatalogClient
): TeamLandingPreviewSnapshotItem {
  const ready =
    render?.state === 'ready' &&
    artifact !== null &&
    artifact.segmentTokens?.length === artifact.segmentCount;
  const state: TeamLandingPreviewSnapshotItem['state'] = ready
    ? 'ready'
    : render?.state === 'rendering'
      ? 'rendering'
      : render?.state === 'failed'
        ? 'error'
        : material.category === 'archive'
          ? 'candidate'
          : 'needs_agent';
  return {
    materialId: material.id,
    name: material.name,
    state,
    sourceVersion: render?.sourceVersion ?? '',
    fingerprint: render?.fingerprint ?? '',
    preset: render?.preset ?? 'default',
    previewUrls: ready
      ? artifact.segmentTokens!.map((_, segment) => client.landingRenderImageUrl(artifact, segment))
      : [],
    ...(render?.failureReason ? { failureReason: render.failureReason } : {})
  };
}

async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, () => worker())
  );
  return output;
}
