// @deno-types="../../../packages/shared/dist/team/catalog-images.d.ts"
import { classifyCatalogImageName } from '../../../packages/shared/dist/team/catalog-images.js';
import type { CatalogDriveEnumeration } from '../_shared/catalog-drive-image-read.ts';
import { readCatalogImageBytes } from '../_shared/catalog-image-validation.ts';
import {
  catalogImageId,
  catalogImageInteger,
  catalogImageObject,
  catalogImageString
} from '../_shared/catalog-images.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceR2 } from '../_shared/r2-space.ts';

/**
 * 057 T041: pictures for the catalog pool from the files of an R2 space (`sourceKind: 'space'`).
 *
 * The Drive reader (`catalog-drive-image-read.ts`) lists Drive and proves each file inside its
 * root; an R2 space's tree is the database's, so a page of its pictures is one query
 * (`service_catalog_image_space_enumerate`), and a picture is read from the space bucket on the
 * server by its content id while its file still holds that content
 * (`service_catalog_image_space_source`). The object under a content id never changes, so what is
 * read is what was staged. The entries and the cursor have the Drive enumeration's shape, so the
 * job, its limits and its staging are the same.
 */

const PAGE = 100;
const MAX_ENTRIES = 1000;
const MAX_BYTES = 5_000_000_000;
const MAX_PICTURE_BYTES = 50_000_000;
const CONTENT_ID = /^[0-9a-f]{64}$/u;

export interface CatalogImageSpaceSourcesDeps {
  rpc(name: string, parameters: Record<string, unknown>): Promise<unknown>;
  /** The space bucket; null until it is configured, and then a space import waits retryably. */
  space: Pick<SpaceR2, 'open'> | null;
}

function cursorAfter(cursor: unknown): string | null {
  if (!Array.isArray(cursor) || cursor.length > 1001)
    throw new TeamFunctionError('INVALID_RESPONSE');
  const first: unknown = cursor[0];
  if (first && typeof first === 'object' && 'kind' in first && first.kind === 'space-after')
    return catalogImageId((first as { id?: unknown }).id);
  // The intent's first cursor is its list of sources: start from the beginning.
  return null;
}

export function createCatalogImageSpaceSources(deps: CatalogImageSpaceSourcesDeps) {
  return {
    async enumerateSpace(
      claim: Record<string, unknown>,
      worker: string,
      signal: AbortSignal
    ): Promise<CatalogDriveEnumeration> {
      if (signal.aborted)
        throw new TeamFunctionError('IMAGE_SOURCE_UNAVAILABLE', { retryable: true });
      let after = cursorAfter(claim.cursor);
      let count = catalogImageInteger(claim.admittedCount, MAX_ENTRIES);
      let bytes = catalogImageInteger(claim.admittedBytes, MAX_BYTES);
      const page = catalogImageObject(
        await deps.rpc('service_catalog_image_space_enumerate', {
          p_job: catalogImageId(claim.jobId),
          p_worker: worker,
          p_fence: catalogImageInteger(claim.fence),
          p_after: after,
          p_limit: PAGE
        })
      );
      if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean')
        throw new TeamFunctionError('INVALID_RESPONSE');
      const entries: Record<string, unknown>[] = [];
      let stopped = false;
      for (const raw of page.items) {
        const item = catalogImageObject(raw);
        const materialId = catalogImageId(item.materialId);
        const name = catalogImageString(item.name);
        const size = catalogImageInteger(item.size);
        const mime = catalogImageString(item.mime, 255);
        const contentId = catalogImageString(item.contentId, 64);
        if (!CONTENT_ID.test(contentId) || !mime.startsWith('image/'))
          throw new TeamFunctionError('INVALID_RESPONSE');
        if (!size || size > MAX_PICTURE_BYTES) throw new TeamFunctionError('IMAGE_TOO_LARGE');
        if (count >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
          stopped = true;
          break;
        }
        entries.push({
          fileId: materialId,
          name,
          size,
          mime,
          classification: classifyCatalogImageName(name),
          source: { kind: 'space', materialId, contentId, size }
        });
        after = materialId;
        count += 1;
        bytes += size;
      }
      return {
        entries,
        cursor: after ? [{ kind: 'space-after', id: after }] : [],
        complete: stopped || !page.hasMore,
        more: stopped
      };
    },

    async readSpace(
      source: Record<string, unknown>,
      actorId: string,
      teamId: string,
      signal: AbortSignal
    ): Promise<Uint8Array> {
      if (!deps.space) throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
      const materialId = catalogImageId(source.materialId);
      const contentId = catalogImageString(source.contentId, 64);
      const size = catalogImageInteger(source.size, MAX_PICTURE_BYTES);
      if (!CONTENT_ID.test(contentId) || !size) throw new TeamFunctionError('INVALID_RESPONSE');
      const found = catalogImageObject(
        await deps.rpc('service_catalog_image_space_source', {
          p_team: catalogImageId(teamId),
          p_actor: catalogImageId(actorId),
          p_material: materialId,
          p_content: contentId
        })
      );
      const key = catalogImageString(found.key, 1024);
      if (key !== `t/${teamId}/o/${contentId}` || catalogImageInteger(found.size) !== size)
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      const opened = await deps.space.open(key, { method: 'GET' }, signal);
      if (!opened?.body)
        throw new TeamFunctionError('IMAGE_SOURCE_UNAVAILABLE', { retryable: true });
      if (opened.size !== size) {
        await opened.body.cancel().catch(() => undefined);
        throw new TeamFunctionError('IMAGE_SOURCE_CHANGED');
      }
      return readCatalogImageBytes(
        new Response(opened.body, { headers: { 'content-length': String(size) } }),
        size
      );
    }
  };
}
