import {
  TEAM_RECOVERY_PROTOCOL_VERSION,
  RECOVERY_PREUPLOAD_FAILURE_CODES
} from '../../../packages/shared/dist/team/recovery.js';
import { recoveryDigest } from './digest.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { RESTITCH_CONTRACT_VERSION } from '../../../packages/shared/dist/team/restitch.js';

const ACTIONS = [
  'delegate',
  'redeem',
  'rotate',
  'revoke',
  'disconnect',
  'probe',
  'claim',
  'heartbeat',
  'checkpoint',
  'settle'
] as const;
export interface RecoveryHandlerDeps {
  user(request: Request): Promise<string>;
  rpc(action: string, hash: string | null, input: Record<string, unknown>): Promise<unknown>;
  revoke(actor: string, team: string, installation: string): Promise<void>;
  drive(
    action: 'claim' | 'heartbeat' | 'complete',
    credential: string,
    body: Record<string, unknown>
  ): Promise<unknown>;
  token(): string;
  hash(value: string): Promise<string>;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TeamFunctionError('AUTH_REQUIRED');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
  return value;
}
export async function handleRecovery(
  request: Request,
  deps: RecoveryHandlerDeps
): Promise<unknown> {
  if (request.method !== 'POST' || Number(request.headers.get('content-length') ?? 0) > 262144)
    throw new TeamFunctionError('INVALID_INPUT');
  const text = await request.text();
  if (text.length > 262144) throw new TeamFunctionError('TOO_LARGE');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TeamFunctionError('INVALID_INPUT');
  }
  const body = object(raw);
  const action = body.action;
  if (typeof action !== 'string' || !ACTIONS.some(candidate => candidate === action))
    throw new TeamFunctionError('INVALID_INPUT');
  if (action === 'delegate' || action === 'revoke') {
    const actorId = await deps.user(request);
    const teamId = uuid(body.teamId);
    const installationId = uuid(body.installationId);
    if (action === 'revoke') {
      await deps.revoke(actorId, teamId, installationId);
      return { revoked: true };
    }
    if (typeof body.ticketDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(body.ticketDigest))
      throw new TeamFunctionError('INVALID_INPUT');
    return deps.rpc('delegate', recoveryDigest(body.ticketDigest), {
      actorId,
      teamId,
      installationId
    });
  }
  // Desktop-only responses contain credentials. Never return them to a browser origin.
  if (request.headers.has('origin')) throw new TeamFunctionError('PERMISSION_DENIED');
  if (action !== 'disconnect' && body.protocolVersion !== TEAM_RECOVERY_PROTOCOL_VERSION)
    throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
  const credential = token(request.headers.get('x-team-recovery-credential'));
  const hash = await deps.hash(credential);
  if (action === 'disconnect') return deps.rpc('disconnect', hash, {});
  if (action === 'redeem') {
    const refresh = deps.token();
    return deps.rpc('redeem', hash, {
      challengeId: uuid(body.challengeId),
      refresh,
      refreshHash: await deps.hash(refresh)
    });
  }
  if (action === 'rotate') {
    const refresh = deps.token();
    const claim = deps.token();
    const value = object(
      await deps.rpc('rotate', hash, {
        rotationId: uuid(body.rotationId),
        refresh,
        refreshHash: await deps.hash(refresh),
        claim,
        claimHash: await deps.hash(claim)
      })
    );
    if (value.error === 'AUTH_REQUIRED') throw new TeamFunctionError('AUTH_REQUIRED');
    return value;
  }
  if (action === 'probe') return deps.rpc('probe', hash, {});
  if (action === 'claim') {
    const installedVersion =
      body.restitchContractVersion === undefined ? 1 : body.restitchContractVersion;
    if (
      typeof installedVersion !== 'number' ||
      !Number.isSafeInteger(installedVersion) ||
      installedVersion < 1
    )
      throw new TeamFunctionError('INVALID_INPUT');
    const executorVersion = Math.min(installedVersion, RESTITCH_CONTRACT_VERSION);
    const assertCompatible = (value: unknown) => {
      if (executorVersion >= RESTITCH_CONTRACT_VERSION || !isRecord(value) || !isRecord(value.job))
        return;
      const options = value.job.options;
      if (
        isRecord(options) &&
        ((isRecord(options.defaults) && options.defaults.sourceMode === 'drive') ||
          options.screens !== undefined)
      )
        throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
    };
    const requestId = uuid(body.requestId);
    const authorized = object(await deps.rpc('claim', hash, { requestId }));
    if (authorized.replay !== undefined) {
      assertCompatible(authorized.replay);
      return authorized.replay;
    }
    if (authorized.pending === true) return { pending: true };
    const teamId = uuid(authorized.teamId);
    let claimed: unknown;
    try {
      claimed = await deps.drive('claim', credential, {
        teamId,
        restitchContractVersion: executorVersion,
        ...(Array.isArray(body.screenRefusals)
          ? { screenRefusals: body.screenRefusals.slice(0, 512) }
          : {})
      });
    } catch (error) {
      if (error instanceof TeamFunctionError && error.code === 'RESTITCH_CLIENT_OUTDATED') {
        // This closed updater refusal occurs before lease/token/process creation.
        // Complete only that proven no-job receipt; an unknown Drive failure stays held.
        let receipt: Record<string, unknown>;
        try {
          receipt = object(
            await deps.rpc('register_claim', hash, {
              requestId,
              response: { job: null, operationCredential: null },
              operationHash: null
            })
          );
        } catch {
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
        }
        if (receipt.job !== null || receipt.operationCredential !== null)
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
        throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
      }
      throw error;
    }
    const value = object(claimed);
    assertCompatible(value);
    const operation = deps.token();
    const response = { ...value, operationCredential: value.job === null ? null : operation };
    return deps.rpc('register_claim', hash, {
      requestId,
      response,
      operationHash: await deps.hash(operation)
    });
  }
  const operationId = uuid(body.operationId);
  const jobId = uuid(body.jobId);
  const authorized = object(await deps.rpc('authorize_execute', hash, { operationId, jobId }));
  if (action === 'checkpoint') {
    const receipt = object(await deps.rpc('checkpoint', hash, { operationId, jobId }));
    if (receipt.executionAllowed !== true) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    return receipt;
  }
  if (action === 'heartbeat') {
    const value = await deps.drive('heartbeat', credential, {
      jobId,
      leaseToken: token(body.leaseToken)
    });
    await deps.rpc('heartbeat', hash, { operationId, jobId });
    return value;
  }
  let state = authorized.operationState;
  if (body.failureCode !== undefined) {
    if (!RECOVERY_PREUPLOAD_FAILURE_CODES.some(code => code === body.failureCode))
      throw new TeamFunctionError('INVALID_INPUT');
    const reported = object(
      await deps.rpc('report_failure', hash, {
        operationId,
        jobId,
        failureCode: body.failureCode
      })
    );
    state = reported.operationState;
  }
  if (state !== 'succeeded' && state !== 'failed' && state !== 'canceled') return { pending: true };
  // A committed upload is not yet proof that the updater owns its output.
  if (state === 'succeeded' && authorized.outputRecorded !== true) return { pending: true };
  await deps.drive('complete', credential, {
    jobId,
    leaseToken: token(body.leaseToken),
    outcome: state === 'succeeded' ? 'finalized' : 'failed',
    errorCode:
      state === 'succeeded'
        ? null
        : typeof body.failureCode === 'string'
          ? body.failureCode
          : 'PROCESS_FAILED'
  });
  await deps.rpc('settle', hash, { operationId, jobId });
  return { settled: true, state };
}
