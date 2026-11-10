import {
  isCatalogVideoR2Availability,
  isCatalogVideoR2PreferenceReceipt,
  isCatalogVideoR2State,
  isCatalogVideoR2Usage,
  type CatalogVideoR2Availability,
  type CatalogVideoR2PreferenceReceipt,
  type CatalogVideoR2State,
  type CatalogVideoR2Usage
} from '@video-compressor/shared';
import { invokeTeamFunction } from './team';

/**
 * Optional publication of a catalog's video to R2 (050). The existing team
 * function boundary owns auth and error-envelope decoding; every answer is
 * narrowed by the shared guards before a component sees it.
 */
export interface CatalogVideoR2Client {
  availability(
    teamId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogVideoR2Availability>;
  readState(
    catalogMaterialId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogVideoR2State>;
  setPreference(
    catalogMaterialId: string,
    input: { enabled: boolean }
  ): Promise<CatalogVideoR2PreferenceReceipt>;
  readUsage(teamId: string, options?: { signal?: AbortSignal }): Promise<CatalogVideoR2Usage>;
}

const query = (path: string, values: Record<string, string>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return `catalog-video-r2/${path}?${params.toString()}`;
};
const pathId = (id: string) => encodeURIComponent(id);

export const catalogVideoR2Client: CatalogVideoR2Client = {
  availability: (teamId, options) =>
    invokeTeamFunction(query('availability', { teamId }), {}, isCatalogVideoR2Availability, {
      method: 'GET',
      ...(options?.signal ? { signal: options.signal } : {})
    }),
  readState: (catalogMaterialId, options) =>
    invokeTeamFunction(
      `catalog-video-r2/catalogs/${pathId(catalogMaterialId)}/state`,
      {},
      isCatalogVideoR2State,
      { method: 'GET', ...(options?.signal ? { signal: options.signal } : {}) }
    ),
  setPreference: (catalogMaterialId, input) =>
    invokeTeamFunction(
      `catalog-video-r2/catalogs/${pathId(catalogMaterialId)}/preference`,
      { enabled: input.enabled },
      isCatalogVideoR2PreferenceReceipt
    ),
  readUsage: (teamId, options) =>
    invokeTeamFunction(query('usage', { teamId }), {}, isCatalogVideoR2Usage, {
      method: 'GET',
      ...(options?.signal ? { signal: options.signal } : {})
    })
};
