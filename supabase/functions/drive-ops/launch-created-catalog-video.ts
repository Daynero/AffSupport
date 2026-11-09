import { parseStoredProductCatalogResult } from './catalog-durable.ts';
import { parseCatalogVideoGenerationProgress } from './catalog-video-generation.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
async function action(
  service: ServiceRpcClient,
  actorId: string,
  body: Record<string, unknown>,
  kind: 'read' | 'cancel'
) {
  if (!uuid(actorId) || body.expectedActorId !== actorId)
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    !uuid(body.teamId) ||
    !uuid(body.generationId) ||
    (kind === 'cancel' && !uuid(body.requestId)) ||
    Object.keys(body).some(
      key =>
        ![
          'teamId',
          'generationId',
          'expectedActorId',
          ...(kind === 'cancel' ? ['requestId'] : [])
        ].includes(key)
    )
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_created_launch_catalog_video', {
    p_team: body.teamId,
    p_actor: actorId,
    p_generation: body.generationId,
    p_action: kind,
    p_request: kind === 'cancel' ? body.requestId : null
  });
  if (result.error) {
    const known = (
      [
        'PERMISSION_DENIED',
        'WRONG_STATE',
        'PROCESS_RESULT_UNCERTAIN',
        'NOT_FOUND',
        'INVALID_INPUT'
      ] as const
    ).find(code => isRecord(result.error) && result.error.message === code);
    throw new TeamFunctionError(known ?? 'PROCESS_RESULT_UNCERTAIN');
  }
  const parsed = parseStoredProductCatalogResult(result.data);
  if (!parsed || parsed.outcome !== 'created' || !isRecord(result.data))
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const observation =
    result.data.videoGenerationObservation === undefined
      ? undefined
      : parseCatalogVideoGenerationProgress(result.data.videoGenerationObservation);
  if (result.data.videoGenerationObservation !== undefined && !observation)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  return { ...parsed, ...(observation ? { videoGenerationObservation: observation } : {}) };
}
export const readLaunchCatalogVideo = (
  service: ServiceRpcClient,
  actorId: string,
  body: Record<string, unknown>
) => action(service, actorId, body, 'read');
export const cancelLaunchCatalogVideo = (
  service: ServiceRpcClient,
  actorId: string,
  body: Record<string, unknown>
) => action(service, actorId, body, 'cancel');
