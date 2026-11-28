import { createCatalogImageSpaceSources } from '../catalog-images/space-sources.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceR2 } from '../_shared/r2-space.ts';
import type { CreativeImagePublisherDeps } from './creative-images.ts';
import type { SpaceCatalogRpc } from './catalog-space-source.ts';

/**
 * 057 T104: the image creatives of a catalog in an R2 space. The publication is 062's
 * (`createCreativeImagePublisher`: optimize, write once under `c1/<uuid>` in the public image
 * bucket, read back anonymously, commit) and always R2 — a space has no Drive to link from. What
 * differs is the source:
 *
 * - the reservation is keyed by the object's content id (`service_reserve_space_creative_image`),
 *   not by a Drive version and checksum, and refused when the space has no room for the picture;
 * - the bytes are read from the space bucket on the server while the file still holds that
 *   content (`service_catalog_image_space_source`, the reader the picture pool uses).
 *
 * The published object counts in the space's `catalogs` while a catalog uses it (the ledger
 * trigger on `private.launch_creative_images`, 20261226310000).
 */

const CONTENT_ID = /^[0-9a-f]{64}$/u;

export function spaceCreativeImageSource(input: {
  rpc: SpaceCatalogRpc;
  space: Pick<SpaceR2, 'open'> | null;
}): Pick<CreativeImagePublisherDeps, 'reserve' | 'readMaterial'> {
  const reader = createCatalogImageSpaceSources({ rpc: input.rpc, space: input.space });
  return {
    async reserve({ teamId, actorId, material, live, attempt }) {
      // The proven file's version is its content id (catalog-space-source.ts `asLiveFile`).
      if (!live.version || !CONTENT_ID.test(live.version))
        throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
      return input.rpc('service_reserve_space_creative_image', {
        p_team: teamId,
        p_actor: actorId,
        p_material: material.id,
        p_content: live.version,
        p_attempt: attempt
      });
    },
    async readMaterial(team, actor, material, expected, signal) {
      if (!expected.version || !CONTENT_ID.test(expected.version) || !expected.size)
        throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
      try {
        return await reader.readSpace(
          { materialId: material, contentId: expected.version, size: expected.size },
          actor,
          team,
          signal
        );
      } catch (error) {
        // The file holds other bytes now: the creative changed under the catalog.
        if (error instanceof TeamFunctionError && error.code === 'IMAGE_SOURCE_CHANGED')
          throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
        throw error;
      }
    }
  };
}
