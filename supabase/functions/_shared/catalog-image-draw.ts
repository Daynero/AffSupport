import { TeamFunctionError } from './errors.ts';
import { isRecord } from './validation.ts';
import {
  parseCatalogDrawnImage,
  type CatalogDrawnImage,
  type CatalogImageDrawOptions
} from './catalog-image-rows.ts';

export type CatalogImageRpc = (name: string, params: Record<string, unknown>) => Promise<unknown>;

export async function assertCatalogImageContract(
  call: CatalogImageRpc,
  teamId: string,
  version: 2 | undefined
) {
  const mode = await call('service_catalog_image_mode_v2', { p_team: teamId });
  if (mode !== 'legacy' && mode !== 'v2') throw new TeamFunctionError('INVALID_RESPONSE');
  if (mode === 'v2' && version !== 2) throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
}

/** null denotes legacy mode; an empty admitted v2 pool needs settings repair. */
export async function drawCatalogImagePool(
  call: CatalogImageRpc,
  teamId: string,
  count: number,
  options: CatalogImageDrawOptions = {}
): Promise<CatalogDrawnImage[]> {
  if (options.contractVersion === 2) {
    const result = await call('service_draw_product_catalog_images_v2', {
      p_team: teamId,
      p_count: count,
      p_attempt: options.attemptId ?? null,
      p_scope: options.scope ?? 'create'
    });
    if (result !== null) {
      if (!Array.isArray(result) || result.length > 400)
        throw new TeamFunctionError('INVALID_RESPONSE');
      if (result.length === 0)
        throw new TeamFunctionError('WRONG_STATE', { details: { reason: 'settings_missing' } });
      return result.map(value => {
        const image = parseCatalogDrawnImage(value);
        if (!image || !('kind' in image) || image.kind !== 'r2')
          throw new TeamFunctionError('INVALID_RESPONSE');
        return image;
      });
    }
  }
  const result = await call('service_draw_product_catalog_images', {
    p_team: teamId,
    p_count: count
  });
  if (!Array.isArray(result)) throw new TeamFunctionError('INVALID_RESPONSE');
  return result.map(value => {
    if (!isRecord(value) || typeof value.drive_file_id !== 'string')
      throw new TeamFunctionError('INVALID_RESPONSE');
    return {
      driveFileId: value.drive_file_id,
      resourceKey: typeof value.resource_key === 'string' ? value.resource_key : null,
      name: typeof value.name === 'string' ? value.name : null
    };
  });
}
