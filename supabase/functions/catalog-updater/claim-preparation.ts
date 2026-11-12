import { TeamFunctionError } from '../_shared/errors.ts';

export type CatalogClaimRpc = (
  name: string,
  parameters: Record<string, unknown>
) => Promise<unknown>;

export interface PreparedCatalogClaims {
  rows: unknown[];
  quarantined: number;
  stale: number;
}

/** Resolve image-use authority before any claimed row can reach provider work. */
export async function prepareCatalogClaims(
  rows: unknown[],
  workerId: string,
  call: CatalogClaimRpc
): Promise<PreparedCatalogClaims> {
  let quarantined = 0;
  let stale = 0;
  const prepared = await Promise.all(
    rows.map(async row => {
      if (
        !row ||
        typeof row !== 'object' ||
        !('team_id' in row) ||
        typeof row.team_id !== 'string' ||
        !('catalog_material_id' in row) ||
        typeof row.catalog_material_id !== 'string'
      )
        return row;
      const mode = await call('service_catalog_image_mode_v2', { p_team: row.team_id });
      if (mode !== 'v2' && mode !== 'global') return row;
      const attempt = await call('service_catalog_image_update_attempt_v2', {
        p_catalog: row.catalog_material_id,
        p_worker: workerId
      });
      if (attempt === null) {
        // A finished legacy attempt or a concurrent Stop is not a malformed
        // sibling. Only the current lease may quarantine an inconsistent round.
        const parked = await call('service_park_catalog_update_claim', {
          p_item: row.catalog_material_id,
          p_worker: workerId
        });
        if (typeof parked !== 'boolean') throw new TeamFunctionError('INVALID_RESPONSE');
        if (parked) quarantined++;
        else stale++;
        return null;
      }
      if (typeof attempt !== 'string') throw new TeamFunctionError('INVALID_RESPONSE');
      return {
        ...row,
        image_attempt_id: attempt,
        ...(mode === 'global' ? { global_images: true, refresh_images: true } : {})
      };
    })
  );
  return { rows: prepared.filter(row => row !== null), quarantined, stale };
}
