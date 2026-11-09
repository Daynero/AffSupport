import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { parseRestitchRootDescriptor, type ManualRestitchRoot } from './restitch-root.ts';
import { restitchSelectionRpcFailure } from './restitch-selection-store.ts';
interface AliasScope {
  setId: string;
  claimHash: string;
  nativeInstanceId: string;
  protocolVersion: 1;
}
interface ProcessIdentity {
  index: number;
  requestId: string;
  operationId: string;
  teamId: string;
  actorId: string;
  materialId: string;
  sourceVersion: string;
  settingsDigest: string;
}
export interface CatalogVideoRestitchAlias extends ManualRestitchRoot {
  recipe: ManualRestitchRoot['recipe'] & {
    logicalKind: 'process';
    catalogVideoSetId: string;
    videoVariantIndex: number;
    settingsDigest: string;
    recipeRevision: number;
  };
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
/** The caller is a trusted delegated factory. Bodies cannot choose settings,
 * pools, source identities or a new image draw. Lost replies are retried with
 * this exact original alias identity and read its already sampled recipe. */
export async function prepareCatalogVideoRestitchAlias(
  service: ServiceRpcClient,
  rawScope: AliasScope,
  rawChild: ProcessIdentity
): Promise<CatalogVideoRestitchAlias> {
  const scope = { ...rawScope },
    child = { ...rawChild };
  if (
    scope.protocolVersion !== 1 ||
    ![
      scope.setId,
      scope.nativeInstanceId,
      child.requestId,
      child.operationId,
      child.teamId,
      child.actorId,
      child.materialId
    ].every(uuid) ||
    !Number.isSafeInteger(child.index) ||
    child.index < 0 ||
    child.index > 399 ||
    !/^\\x[a-f0-9]{64}$/iu.test(scope.claimHash) ||
    typeof child.sourceVersion !== 'string' ||
    !child.sourceVersion ||
    child.sourceVersion.length > 1024 ||
    !/^[a-f0-9]{64}$/u.test(child.settingsDigest)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const reply = await service.rpc('service_accept_catalog_video_restitch_alias', {
    p_set: scope.setId,
    p_hash: scope.claimHash,
    p_native: scope.nativeInstanceId,
    p_protocol: 1,
    p_index: child.index,
    p_request: child.requestId,
    p_operation: child.operationId
  });
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  const value = reply.data;
  if (
    !isRecord(value) ||
    value.operationId !== child.operationId ||
    value.sourceVersion !== child.sourceVersion ||
    !isRecord(value.recipe) ||
    value.recipe.logicalKind !== 'process' ||
    value.recipe.catalogVideoSetId !== scope.setId ||
    value.recipe.videoVariantIndex !== child.index ||
    value.recipe.settingsDigest !== child.settingsDigest ||
    !Number.isSafeInteger(value.recipe.recipeRevision) ||
    Number(value.recipe.recipeRevision) < 1
  )
    throw new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
  const descriptor = parseRestitchRootDescriptor(value, {
    teamId: child.teamId,
    actorId: child.actorId,
    sourceMaterialId: child.materialId,
    idempotencyKey: 'catalog-variant:' + child.requestId,
    clientOperationId: child.requestId
  });
  return {
    ...descriptor,
    recipe: {
      ...descriptor.recipe,
      logicalKind: 'process',
      catalogVideoSetId: scope.setId,
      videoVariantIndex: child.index,
      settingsDigest: child.settingsDigest,
      recipeRevision: Number(value.recipe.recipeRevision)
    }
  };
}

export interface CatalogProcessEnrollment {
  rootOperationId: string;
  teamId: string;
  actorId: string;
  nativeInstanceId: string;
  enrollmentId: string;
  proofDigest: string;
}
/** Trusted native delegated gateway only. The service MAC and proof hash never
 * leave this response; the local proof must still be redeemed separately. */
export async function enrollCatalogVideoRestitchControl(
  service: ServiceRpcClient,
  secret: string,
  rawScope: AliasScope,
  rawChild: ProcessIdentity,
  rawEnrollment: CatalogProcessEnrollment
) {
  const scope = { ...rawScope },
    child = { ...rawChild },
    enrollment = { ...rawEnrollment };
  if (
    enrollment.rootOperationId !== child.operationId ||
    enrollment.teamId !== child.teamId ||
    enrollment.actorId !== child.actorId ||
    enrollment.nativeInstanceId !== scope.nativeInstanceId ||
    !uuid(enrollment.enrollmentId) ||
    !/^[a-f0-9]{64}$/u.test(enrollment.proofDigest)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const alias = await prepareCatalogVideoRestitchAlias(service, scope, child);
  const { restitchTicket } = await import('../drive-transfer/restitch-ticket.ts');
  const { recoveryDigest, recoveryTokenHash } = await import('../team-recovery/digest.ts');
  const ticket = await restitchTicket(secret, enrollment.enrollmentId, 'control');
  const reply = await service.rpc('service_issue_catalog_video_restitch_control', {
    p_set: scope.setId,
    p_hash: scope.claimHash,
    p_native: scope.nativeInstanceId,
    p_protocol: 1,
    p_index: child.index,
    p_request: child.requestId,
    p_operation: child.operationId,
    p_grant: enrollment.enrollmentId,
    p_enrollment: enrollment.enrollmentId,
    p_proof_hash: recoveryDigest(enrollment.proofDigest),
    p_ticket_hash: await recoveryTokenHash(ticket)
  });
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  const value = reply.data;
  if (
    !isRecord(value) ||
    value.grantId !== enrollment.enrollmentId ||
    value.enrollmentId !== enrollment.enrollmentId ||
    value.rootOperationId !== alias.operationId ||
    value.teamId !== child.teamId ||
    value.actorId !== child.actorId ||
    value.nativeInstanceId !== scope.nativeInstanceId ||
    typeof value.redeemed !== 'boolean' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
  return {
    grantId: enrollment.enrollmentId,
    enrollmentId: enrollment.enrollmentId,
    rootOperationId: alias.operationId,
    teamId: child.teamId,
    actorId: child.actorId,
    nativeInstanceId: scope.nativeInstanceId,
    redeemed: value.redeemed,
    expiresAt: value.expiresAt
  };
}
