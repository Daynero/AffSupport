import { TeamApiError } from '../../api/team';
import { withReadDeadline } from '../readCoordinator';
import type { CatalogUpdaterClient } from './useCatalogUpdater';

/** Authoritative bounded read shared by inline reconciliation and bulk saves. */
export function readCatalogSnapshot(
  client: CatalogUpdaterClient,
  teamId: string,
  catalogId: string,
  signal: AbortSignal = new AbortController().signal
) {
  return withReadDeadline(async child => {
    if (client.listCatalogManagerSnapshot) {
      const snapshot = await client.listCatalogManagerSnapshot(teamId, { signal: child });
      const catalog = snapshot.rows.find(row => row.catalogId === catalogId);
      if (!catalog?.profile) throw new TeamApiError('INVALID_RESPONSE', false);
      return {
        profile: catalog.profile,
        interval: catalog.updateInterval,
        nextRunAt: catalog.nextRunAt
      };
    }
    const [profiles, catalogs] = await Promise.all([
      client.listCatalogUpdateProfiles?.(teamId, { signal: child }),
      client.listTeamProductCatalogs(teamId, { signal: child })
    ]);
    const catalog = catalogs.find(row => row.catalogId === catalogId);
    const profile = profiles?.find(row => row.catalogId === catalogId) ?? catalog?.profile;
    if (!catalog || !profile) throw new TeamApiError('INVALID_RESPONSE', false);
    return { profile, interval: catalog.updateInterval, nextRunAt: catalog.nextRunAt };
  }, signal);
}
