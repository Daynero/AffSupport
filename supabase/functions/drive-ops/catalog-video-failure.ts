import {
  STITCH_ERROR_CODES,
  type StitchErrorCode
} from '../../../packages/shared/dist/stitch-errors.js';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { isRecord } from '../_shared/validation.ts';
export type CatalogVideoFailureCode = TeamErrorCode | StitchErrorCode;
/** Correlates only original accepted children. No caller-selected operation or text is surfaced. */
export async function readCatalogVideoFailure(
  service: ServiceRpcClient,
  scope: { teamId: string; actorId: string; sourceMaterialId: string; setId: string },
  readOriginalOperations: (ids: readonly string[]) => Promise<unknown>
): Promise<CatalogVideoFailureCode | null> {
  const accepted = await service.rpc('service_read_catalog_video_acceptance', {
    p_set: scope.setId,
    p_team: scope.teamId,
    p_actor: scope.actorId
  });
  if (
    accepted.error ||
    !isRecord(accepted.data) ||
    !isRecord(accepted.data.snapshot) ||
    accepted.data.snapshot.setId !== scope.setId ||
    !Array.isArray(accepted.data.snapshot.children)
  )
    return null;
  const requests = new Map<string, string>();
  for (const child of accepted.data.snapshot.children.slice(0, 400))
    if (
      isRecord(child) &&
      child.state === 'unknown' &&
      typeof child.operationId === 'string' &&
      typeof child.requestId === 'string'
    )
      requests.set(child.operationId, child.requestId);
  if (!requests.size) return null;
  const rows = await readOriginalOperations([...requests.keys()].slice(0, 8));
  if (!Array.isArray(rows)) return null;
  for (const row of rows.slice(0, 8)) {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      !requests.has(row.id) ||
      row.team_id !== scope.teamId ||
      row.actor_id !== scope.actorId ||
      row.source_material_id !== scope.sourceMaterialId ||
      row.kind !== 'process' ||
      row.state !== 'failed' ||
      row.idempotency_key !== 'catalog-variant:' + requests.get(row.id)
    )
      continue;
    const code = [...TEAM_ERROR_CODES, ...STITCH_ERROR_CODES].find(code => code === row.error_code);
    if (code) return code;
  }
  return null;
}
