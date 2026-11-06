import { captureCatalogMutationOwner } from '../catalog-updater/captureCatalogMutationOwner';
import { RESTITCH_CONTRACT_VERSION, TEAM_ERROR_CODES } from '@video-compressor/shared';
import { agentRestitchContractVersion, getRestitchScreenRefusals } from '../../api/client';
import { teamApi, type RestitchClaim } from '../../api/team';
import { beginCatalogUiFlow, type CatalogUiFlow } from '../catalog-updater/analytics';

/** No cloud job is taken before the current installation has answered. */
export async function claimRestitchForInstalledAgent(
  teamId: string
): Promise<RestitchClaim | null> {
  const owner = captureCatalogMutationOwner(() => true);
  let flow: CatalogUiFlow | null;
  try {
    flow = beginCatalogUiFlow('restitch_claim');
  } catch {
    flow = null;
  }
  let version: number | null = null;
  try {
    owner.options();
    flow?.stage('executor_check_requested');
    version = await agentRestitchContractVersion();
    owner.options();
    flow?.stage('executor_checked');
    const refusals =
      version >= RESTITCH_CONTRACT_VERSION ? await getRestitchScreenRefusals(teamId, '*') : [];
    flow?.stage('claim_requested');
    const job = await teamApi.claimRestitchJob(teamId, refusals, version, owner.options());
    owner.options();
    flow?.claimResult(job?.operationId ?? null);
    return job;
  } catch (caught) {
    // A legacy local library remains usable. Drive pools require the newer installed app.
    const error =
      version !== null &&
      version < RESTITCH_CONTRACT_VERSION &&
      caught instanceof Error &&
      caught.message === 'RESTITCH_CLIENT_OUTDATED'
        ? new Error('AGENT_UPDATE_REQUIRED')
        : caught;
    const code = error instanceof Error ? error.message : '';
    flow?.fail(TEAM_ERROR_CODES.find(known => known === code) ?? 'UNKNOWN', 'claim_refused');
    throw error;
  }
}
