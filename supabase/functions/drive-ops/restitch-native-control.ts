import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord, parseUuid } from '../_shared/validation.ts';
import { restitchTicket } from '../drive-transfer/restitch-ticket.ts';
import { restitchSelectionRpcFailure } from './restitch-selection-store.ts';
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
export interface NativeRestitchControlDeps {
  service: ServiceRpcClient;
  secret: string;
  /** Both IDs must come from verified real Auth, never body-selected fields. */
  user(request: Request): Promise<{ userId: string; sessionId: string }>;
}
function uuid(value: unknown): string {
  const result = parseUuid(value);
  if (!result.ok) throw new TeamFunctionError('INVALID_INPUT');
  return result.value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new TeamFunctionError('AUTH_REQUIRED');
  return value;
}
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return '\\x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function restitchEnrollmentProofHash(secret: string): Promise<string> {
  return hash('soty:restitch-enrollment-proof:v1:' + token(secret));
}
async function rpc(
  service: ServiceRpcClient,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc(name, args);
  } catch {
    throw uncertain();
  }
  if (!isRecord(reply) || !Object.hasOwn(reply, 'data') || !Object.hasOwn(reply, 'error'))
    throw uncertain();
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  return reply.data;
}
function enrollment(value: unknown, grantId: string) {
  try {
    if (
      !isRecord(value) ||
      value.grantId !== grantId ||
      typeof value.redeemed !== 'boolean' ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw uncertain();
    return {
      grantId,
      enrollmentId: uuid(value.enrollmentId),
      rootOperationId: uuid(value.rootOperationId),
      teamId: uuid(value.teamId),
      actorId: uuid(value.actorId),
      nativeInstanceId: uuid(value.nativeInstanceId),
      expiresAt: value.expiresAt,
      redeemed: value.redeemed
    };
  } catch {
    throw uncertain();
  }
}
function ownership(value: unknown, claimId: string) {
  try {
    if (
      !isRecord(value) ||
      value.claimId !== claimId ||
      typeof value.active !== 'boolean' ||
      typeof value.epoch !== 'number' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1
    )
      throw uncertain();
    return {
      rootOperationId: uuid(value.rootOperationId),
      claimId,
      nativeInstanceId: uuid(value.nativeInstanceId),
      executorId: uuid(value.executorId),
      epoch: value.epoch,
      active: value.active
    };
  } catch {
    throw uncertain();
  }
}
/** Internal dispatcher; no production/beta route or installed capability yet.
 * The hosting route must apply its normal CORS and bounded JSON intake. Only
 * enrollment uses browser Auth. Every credential-bearing response is origin-free
 * and purpose-bound; ordinary JWTs and generic transfer grants cannot control it. */
export async function handleRestitchNativeControl(
  request: Request,
  action: string,
  body: unknown,
  deps: NativeRestitchControlDeps
): Promise<unknown> {
  if (
    request.method !== 'POST' ||
    !['enroll', 'redeem', 'claim', 'read', 'quiesce', 'authorize', 'finish'].includes(action)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  if (action !== 'enroll' && request.headers.has('origin'))
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (!isRecord(body)) throw new TeamFunctionError('INVALID_INPUT');
  const x = { ...body };
  if (action === 'enroll') {
    const root = uuid(x.rootOperationId),
      team = uuid(x.teamId),
      enrollmentId = uuid(x.enrollmentId),
      native = uuid(x.nativeInstanceId);
    if (typeof x.proofDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(x.proofDigest))
      throw new TeamFunctionError('INVALID_INPUT');
    const proofHash = '\\x' + x.proofDigest;
    // Original enrollment ID is also the grant ID: a lost reply never generates
    // another grant, changes the challenge window or resets its bound scope.
    const grantId = enrollmentId;
    const { userId, sessionId } = await deps.user(request);
    const actor = uuid(userId),
      session = uuid(sessionId);
    const ticket = await restitchTicket(deps.secret, grantId, 'control');
    const value = enrollment(
      await rpc(deps.service, 'service_issue_restitch_native_control', {
        p_root: root,
        p_team: team,
        p_actor: actor,
        p_session: session,
        p_grant: grantId,
        p_enrollment: enrollmentId,
        p_native: native,
        p_proof_hash: proofHash,
        p_ticket_hash: await hash(ticket)
      }),
      grantId
    );
    if (
      value.rootOperationId !== root ||
      value.teamId !== team ||
      value.actorId !== actor ||
      value.enrollmentId !== enrollmentId ||
      value.nativeInstanceId !== native
    )
      throw uncertain();
    return value; // never returns a token, digest, native claim or provider context
  }
  if (x.protocolVersion !== 1) throw new TeamFunctionError('RESTITCH_CLIENT_OUTDATED');
  const grantId = uuid(x.grantId);
  if (action === 'redeem') {
    const proofHash = await restitchEnrollmentProofHash(
      token(request.headers.get('x-restitch-enrollment-secret'))
    );
    const value = enrollment(
      await rpc(deps.service, 'service_redeem_restitch_native_control', {
        p_grant: grantId,
        p_proof_hash: proofHash
      }),
      grantId
    );
    if (!value.redeemed) throw uncertain();
    return {
      ...value,
      purpose: 'restitch_native_control_v1',
      protocolVersion: 1,
      ticket: await restitchTicket(deps.secret, grantId, 'control')
    };
  }
  const ticketHash = await hash(token(request.headers.get('x-restitch-control-ticket')));
  const scope = { p_grant: grantId, p_ticket_hash: ticketHash };
  if (action === 'authorize') {
    const value = await rpc(deps.service, 'service_authorize_restitch_native_control', scope);
    if (!isRecord(value)) throw uncertain();
    const registered = enrollment(value, grantId),
      owned = ownership(value, uuid(value.claimId));
    if (!registered.redeemed || !owned.active) throw uncertain();
    return { ...registered, ...owned };
  }
  const claimId = uuid(x.claimId),
    original = { ...scope, p_claim: claimId };
  if (action === 'finish') {
    if (!['delivered', 'failed', 'canceled'].includes(String(x.outcome)))
      throw new TeamFunctionError('INVALID_INPUT');
    const value = await rpc(deps.service, 'service_finish_restitch_native_control', {
      ...original,
      p_quiescence: uuid(x.quiescenceId),
      p_outcome: x.outcome
    });
    if (value !== true) throw uncertain();
    return true;
  }
  if (action === 'quiesce') {
    const value = await rpc(deps.service, 'service_quiesce_restitch_native_control', {
      ...original,
      p_quiescence: uuid(x.quiescenceId)
    });
    if (value !== true) throw uncertain();
    return true;
  }
  if (action === 'read') {
    const value = await rpc(deps.service, 'service_read_restitch_native_control_claim', original);
    return value === null ? null : ownership(value, claimId);
  }
  try {
    return ownership(
      await rpc(deps.service, 'service_claim_restitch_native_control', {
        ...original,
        p_contract: 1
      }),
      claimId
    );
  } catch (cause) {
    if (
      !(cause instanceof TeamFunctionError) ||
      cause.code !== 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    )
      throw cause;
    // Unknown claim acknowledgement: exact read only, never a second mutation.
    return ownership(
      await rpc(deps.service, 'service_read_restitch_native_control_claim', original),
      claimId
    );
  }
}
