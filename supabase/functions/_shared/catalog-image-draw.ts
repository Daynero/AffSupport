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
  version: 2 | 3 | undefined
) {
  const mode = await call('service_catalog_image_mode_v2', { p_team: teamId });
  if (mode !== 'legacy' && mode !== 'v2' && mode !== 'global')
    throw new TeamFunctionError('INVALID_RESPONSE');
  if (mode === 'global' && version !== 3)
    throw new TeamFunctionError('GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED');
  if (mode === 'v2' && version !== 2 && version !== 3)
    throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
}

/** null denotes legacy mode; an empty admitted v2 pool needs settings repair. */
export async function drawCatalogImagePool(
  call: CatalogImageRpc,
  teamId: string,
  count: number,
  options: CatalogImageDrawOptions = {}
): Promise<CatalogDrawnImage[]> {
  if (options.contractVersion === 2 || options.contractVersion === 3) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        call(
          options.contractVersion === 3
            ? 'service_draw_product_catalog_images_v3'
            : 'service_draw_product_catalog_images_v2',
          {
            p_team: teamId,
            p_count: count,
            p_attempt: options.attemptId ?? null,
            p_scope: options.scope ?? 'create',
            ...(options.contractVersion === 3
              ? {
                  p_catalog: options.catalogId ?? options.attemptId ?? null,
                  p_pairs: options.pairs ?? []
                }
              : {})
          }
        ),
        new Promise<never>((_, reject) => {
          if (options.contractVersion !== 3) return;
          deadline = setTimeout(
            () =>
              reject(new TeamFunctionError('GLOBAL_IMAGE_ALLOCATION_UNKNOWN', { retryable: true })),
            1000
          );
        })
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    if (result !== null) {
      if (!Array.isArray(result) || result.length > 400)
        throw new TeamFunctionError('INVALID_RESPONSE');
      if (result.length === 0)
        throw new TeamFunctionError('WRONG_STATE', { details: { reason: 'settings_missing' } });
      const global = result.some(value => isRecord(value) && value.kind === 'global');
      if (
        global &&
        (result.length !== count ||
          result.some(value => !isRecord(value) || value.kind !== 'global'))
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return result.map(value => {
        const image = parseCatalogDrawnImage(value);
        if (!image || !('kind' in image) || !['r2', 'global'].includes(image.kind))
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
