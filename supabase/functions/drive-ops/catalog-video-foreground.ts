import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  catalogForegroundHash,
  catalogForegroundProofHash,
  foregroundRpc,
  ticketFromForegroundRedeem
} from './catalog-video-foreground-authority.ts';
import {
  parseCatalogVariantRecoveryInput,
  isCatalogVariantRecoveryAction
} from '../team-recovery/catalog-video-handler.ts';
import { executeCatalogForegroundAction } from './catalog-video-foreground-actions.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TeamFunctionError('INVALID_INPUT');
  return value;
};
type Admit = Parameters<typeof executeCatalogForegroundAction>[5];
/** Native-only exact enrollment endpoint. Browser JWT is never a native credential. */
export async function handleCatalogVideoForeground(
  service: ServiceRpcClient,
  secret: string,
  request: Request,
  action: string,
  body: Record<string, unknown>,
  admit: Admit
) {
  if (
    request.method !== 'POST' ||
    request.headers.has('origin') ||
    (new URL(request.url).protocol !== 'http:' && new URL(request.url).protocol !== 'https:')
  )
    throw new TeamFunctionError('AUTH_REQUIRED');
  if (body.protocolVersion !== 1) throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
  const enrollmentId = uuid(body.enrollmentId),
    nativeInstanceId = uuid(body.nativeInstanceId);
  if (action === 'await' || action === 'redeem') {
    const proofHash = await catalogForegroundProofHash(
      typeof body.proofSecret === 'string' ? body.proofSecret : ''
    );
    const args = {
      p_enrollment: enrollmentId,
      p_native: nativeInstanceId,
      p_proof_hash: proofHash,
      p_expected_execution_native:
        body.expectedExecutionNativeInstanceId === undefined
          ? null
          : uuid(body.expectedExecutionNativeInstanceId),
      p_execution_native:
        body.executionNativeInstanceId === undefined ? null : uuid(body.executionNativeInstanceId)
    };
    const value = await foregroundRpc(
      service,
      action === 'await'
        ? 'service_await_catalog_video_foreground'
        : 'service_redeem_catalog_video_foreground',
      action === 'await' ? args : { ...args, p_set: uuid(body.setId) }
    );
    if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
    if (action === 'await' && (value.state === 'pending' || value.state === 'unused')) {
      if (value.enrollmentId !== enrollmentId) throw new TeamFunctionError('INVALID_RESPONSE');
      return { state: value.state, enrollmentId };
    }
    if (
      value.enrollmentId !== enrollmentId ||
      value.nativeInstanceId !== nativeInstanceId ||
      typeof value.setId !== 'string'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const ticket = await ticketFromForegroundRedeem(secret, value);
    return {
      state: 'bound',
      protocolVersion: 1,
      setId: value.setId,
      executorId: value.executorId,
      enrollmentId,
      nativeInstanceId,
      executionNativeInstanceId: value.executionNativeInstanceId,
      teamId: value.teamId,
      actorId: value.actorId,
      sourceMaterialId: value.sourceMaterialId,
      requestKey: value.requestKey,
      expectedVersion: value.expectedVersion,
      expiresAt: value.expiresAt,
      ticket
    };
  }
  const ticket = request.headers.get('x-catalog-video-foreground');
  if (
    !ticket ||
    !/^[A-Za-z0-9_-]{43}$/u.test(ticket) ||
    request.headers.has('x-team-recovery-credential')
  )
    throw new TeamFunctionError('AUTH_REQUIRED');
  const setId = uuid(body.setId),
    claimHash = await catalogForegroundHash(ticket);
  await foregroundRpc(service, 'service_require_catalog_video_audience', {
    p_set: setId,
    p_hash: claimHash,
    p_kind: 'paired_session',
    p_enrollment: enrollmentId
  });
  const mapped = action === 'read' ? 'variant_load' : 'variant_' + action;
  if (mapped === 'variant_claim' || !isCatalogVariantRecoveryAction(mapped))
    throw new TeamFunctionError('INVALID_INPUT');
  const input = parseCatalogVariantRecoveryInput(mapped, { ...body, variantProtocolVersion: 1 });
  return executeCatalogForegroundAction(service, secret, mapped, claimHash, input, admit);
}
