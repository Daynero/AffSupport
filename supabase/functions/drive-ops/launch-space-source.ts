import type {
  LaunchConfig,
  LaunchSourceSnapshot
} from '../../../packages/shared/dist/team/launches.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import type { SpaceCatalogRpc } from './catalog-space-source.ts';

/**
 * 057 T104: a Launch of an R2 space. The Launch, its acceptance and its catalog step are the Drive
 * ones; under them the source is the space's file, named by its content
 * (`private.launch_sources_from_config`: 'space-v1:<content id>', no Drive file id), and the catalog
 * is the space's (catalog-space-source.ts).
 *
 * What an R2 Launch catalog cannot do is refused before the Launch is accepted, so nothing is
 * frozen that its catalog step would then refuse: a legacy catalog request (the dialog's protocol
 * is the only one in a space). Re-stitched videos are the space's own variation sets, one per
 * video, admitted with the Launch (T115, 20261226320000); a later link for several creatives or
 * for pictures is a publication target per creative (T117, 20261226330000).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTENT_ID = /^[0-9a-f]{64}$/u;

/** The name a Launch gives a space file: its content (20261226310000). */
export function spaceLaunchMaterialVersion(contentId: string): string {
  return `space-v1:${contentId}`;
}

/** What an R2 space's Launch catalog cannot make; refused before anything is accepted. */
export function assertSpaceLaunchCatalog(config: LaunchConfig): void {
  if (config.method !== 'catalog') return;
  const several =
    (config.creatives?.length ?? 1) > 1 || (config.creativeKind ?? 'video') !== 'video';
  if (config.catalog.catalogVideoProtocolVersion !== 1)
    throw new TeamFunctionError(
      several ? 'MULTI_CREATIVE_UNSUPPORTED' : 'STORAGE_BACKEND_MISMATCH',
      {
        retryable: false
      }
    );
}

/**
 * Proves a Launch's source in an R2 space: the file is live in the space, the member may view it,
 * and — when the Launch froze it — it still holds the content it was frozen with.
 */
export async function proveSpaceLaunchMaterial(
  rpc: SpaceCatalogRpc,
  input: { teamId: string; actorId: string; materialId: string; expectedVersion?: string | null }
): Promise<{ category: string | null; parentFolderId: string | null; version: string }> {
  const found = await rpc('service_space_catalog_material', {
    p_team: input.teamId,
    p_material: input.materialId,
    p_actor: input.actorId,
    p_permission: 'view'
  });
  if (
    !isRecord(found) ||
    found.id !== input.materialId ||
    found.kind !== 'file' ||
    typeof found.contentId !== 'string' ||
    !CONTENT_ID.test(found.contentId) ||
    (found.parentFolderId !== null &&
      (typeof found.parentFolderId !== 'string' || !UUID.test(found.parentFolderId)))
  )
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  const version = spaceLaunchMaterialVersion(found.contentId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== version)
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  return {
    category: typeof found.category === 'string' ? found.category : null,
    parentFolderId: found.parentFolderId as string | null,
    version
  };
}

/** Every creative of a Launch's source, each against the content the Launch froze for it. */
export async function proveSpaceLaunchSource(
  rpc: SpaceCatalogRpc,
  teamId: string,
  actorId: string,
  source: LaunchSourceSnapshot
): Promise<void> {
  const creatives = source.materials?.length
    ? source.materials.map(material => ({
        materialId: material.materialId,
        version: material.version
      }))
    : [{ materialId: source.materialId, version: source.materialVersion }];
  if (creatives[0]!.materialId.toLowerCase() !== source.materialId.toLowerCase())
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  for (const creative of creatives)
    await proveSpaceLaunchMaterial(rpc, {
      teamId,
      actorId,
      materialId: creative.materialId,
      expectedVersion: creative.version
    });
}

/**
 * What `/launches/generate` proves of an R2 space's Launch before it is accepted: every creative
 * at its frozen content and, for a catalog, the first one of the catalog's kind beside a folder
 * the member may upload to (where its feed is written), as a Drive Launch proves its own.
 */
export async function proveSpaceLaunch(
  rpc: SpaceCatalogRpc,
  teamId: string,
  actorId: string,
  config: LaunchConfig,
  source: LaunchSourceSnapshot
): Promise<void> {
  await proveSpaceLaunchSource(rpc, teamId, actorId, source);
  if (config.method !== 'catalog') return;
  const first = await proveSpaceLaunchMaterial(rpc, {
    teamId,
    actorId,
    materialId: config.materialId
  });
  if (first.category !== (config.creativeKind ?? 'video'))
    throw new TeamFunctionError('WRONG_STATE');
  if (!first.parentFolderId) throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  const folder = await rpc('service_space_catalog_material', {
    p_team: teamId,
    p_material: first.parentFolderId,
    p_actor: actorId,
    p_permission: 'upload'
  });
  if (!isRecord(folder) || folder.id !== first.parentFolderId || folder.kind !== 'folder')
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
}
