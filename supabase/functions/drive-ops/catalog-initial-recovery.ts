import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { readAcceptedInitialCatalogRequest } from './catalog-video-generation.ts';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
/** Existing catalog cron/worker-secret recovery lane. Canonical begin owns all
 * leases; this bounded observer never invents or resamples a browser request. */
export async function runInitialCatalogRecovery(
  service: ServiceRpcClient,
  options: {
    enabled: boolean;
    executeFrozen(body: Record<string, unknown>, actorId: string): Promise<unknown>;
  }
): Promise<{ enabled: boolean; completed: number; pending: number }> {
  const result = { enabled: options.enabled, completed: 0, pending: 0 };
  if (!options.enabled) return result;
  const listed = await service.rpc('service_list_initial_catalog_recovery', { p_limit: 3 });
  if (listed.error || !Array.isArray(listed.data) || listed.data.length > 3)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const seen = new Set<string>();
  for (const item of listed.data) {
    if (
      !isRecord(item) ||
      !uuid(item.teamId) ||
      !uuid(item.actorId) ||
      typeof item.idempotencyKey !== 'string' ||
      !/^product-catalog:[0-9a-f-]{36}$/iu.test(item.idempotencyKey) ||
      seen.has(item.idempotencyKey)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    seen.add(item.idempotencyKey);
    try {
      const body = await readAcceptedInitialCatalogRequest(service, item.actorId, {
        teamId: item.teamId,
        expectedActorId: item.actorId,
        idempotencyKey: item.idempotencyKey
      });
      if (
        body.teamId !== item.teamId ||
        body.idempotencyKey !== item.idempotencyKey ||
        body.catalogVideoProtocolVersion !== 1
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const receipt = await options.executeFrozen(body, item.actorId);
      if (
        isRecord(receipt) &&
        ['created', 'recreated', 'existing'].includes(String(receipt.outcome))
      )
        result.completed++;
      else result.pending++;
    } catch {
      result.pending++;
    }
  }
  return result;
}
