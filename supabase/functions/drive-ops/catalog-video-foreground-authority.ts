import {
  parseCatalogVideoForegroundExecutor,
  type CatalogVideoForegroundExecutor
} from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
export interface CatalogForegroundScope {
  teamId: string;
  actorId: string;
  sessionId: string;
  sourceMaterialId: string;
  consumerKind: 'create' | 'launch' | 'updater';
  requestKey: string;
  expectedVersion: string | null;
}
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
export async function catalogForegroundHash(value: string) {
  return (
    '\\x' +
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      byte => byte.toString(16).padStart(2, '0')
    ).join('')
  );
}
export async function catalogForegroundProofHash(secret: string) {
  if (!TOKEN.test(secret)) throw new TeamFunctionError('AUTH_REQUIRED');
  return catalogForegroundHash('soty:catalog-video-foreground-proof:v1:' + secret);
}
/** Private secret MAC, deterministic across lost replies, never public-digest-derived. */
export async function catalogForegroundTicket(
  secret: string,
  scope: CatalogForegroundScope,
  receipt: CatalogVideoForegroundExecutor
) {
  if (secret.length < 32 || secret.length > 4096) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  const immutable = [
    'soty:catalog-video-foreground-ticket:v1',
    receipt.enrollmentId.toLowerCase(),
    scope.teamId.toLowerCase(),
    scope.actorId.toLowerCase(),
    scope.sessionId.toLowerCase(),
    scope.sourceMaterialId.toLowerCase(),
    scope.consumerKind,
    scope.requestKey,
    scope.expectedVersion,
    receipt.nativeInstanceId.toLowerCase(),
    receipt.proofDigest
  ];
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(immutable)))
      )
    )
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
export async function foregroundRpc(
  service: ServiceRpcClient,
  name: string,
  args: Record<string, unknown>
) {
  const result = await service.rpc(name, args);
  if (result.error) {
    const code = TEAM_ERROR_CODES.find(code => result.error?.message === code);
    throw new TeamFunctionError(code ?? 'PROCESS_RESULT_UNCERTAIN');
  }
  return result.data;
}
export async function prepareCatalogVideoForeground(
  service: ServiceRpcClient,
  secret: string,
  scope: CatalogForegroundScope,
  raw: unknown
) {
  const receipt = parseCatalogVideoForegroundExecutor(raw);
  if (!receipt) throw new TeamFunctionError('INVALID_INPUT');
  const ticket = await catalogForegroundTicket(secret, scope, receipt);
  const value = await foregroundRpc(service, 'service_prepare_catalog_video_foreground', {
    p_team: scope.teamId,
    p_actor: scope.actorId,
    p_session: scope.sessionId,
    p_source: scope.sourceMaterialId,
    p_kind: scope.consumerKind,
    p_key: scope.requestKey,
    p_version: scope.expectedVersion,
    p_enrollment: receipt.enrollmentId,
    p_native: receipt.nativeInstanceId,
    p_proof_hash: '\\x' + receipt.proofDigest,
    p_token_hash: await catalogForegroundHash(ticket)
  });
  if (
    !isRecord(value) ||
    value.enrollmentId !== receipt.enrollmentId ||
    value.nativeInstanceId !== receipt.nativeInstanceId
  )
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  return receipt;
}
export async function recordCatalogForegroundFailure(
  service: ServiceRpcClient,
  scope: { teamId: string; actorId: string },
  receipt: CatalogVideoForegroundExecutor,
  cause: unknown
) {
  const code = cause instanceof TeamFunctionError ? cause.code : 'PROCESS_RESULT_UNCERTAIN';
  await service.rpc('service_record_catalog_video_foreground_failure', {
    p_enrollment: receipt.enrollmentId,
    p_team: scope.teamId,
    p_actor: scope.actorId,
    p_code: code
  });
}
export async function ticketFromForegroundRedeem(secret: string, value: Record<string, unknown>) {
  const privateScope = value._ticketScope;
  if (!isRecord(privateScope)) throw new TeamFunctionError('INVALID_RESPONSE');
  const receipt = parseCatalogVideoForegroundExecutor({
    protocolVersion: 1,
    enrollmentId: privateScope.enrollmentId,
    nativeInstanceId: privateScope.nativeInstanceId,
    proofDigest: privateScope.proofDigest
  });
  if (
    !receipt ||
    ['teamId', 'actorId', 'sessionId', 'sourceMaterialId', 'requestKey'].some(
      key => typeof privateScope[key] !== 'string'
    ) ||
    !['create', 'launch', 'updater'].includes(String(privateScope.consumerKind)) ||
    !(privateScope.expectedVersion === null || typeof privateScope.expectedVersion === 'string')
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return catalogForegroundTicket(
    secret,
    privateScope as unknown as CatalogForegroundScope,
    receipt
  );
}
