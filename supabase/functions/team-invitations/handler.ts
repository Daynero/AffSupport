import type { TeamErrorCode } from '../../../packages/shared/dist/team/transport.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { buildInvitationEmail, type InvitationDeliveryResult } from './email.ts';

type BaseRole = 'admin' | 'editor' | 'viewer';

export type InvitationCommand =
  | {
      action: 'create';
      teamId: string;
      email: string;
      initialRole: BaseRole;
      idempotencyKey: string;
    }
  | {
      action: 'direct-add';
      teamId: string;
      email: string;
      initialRole: BaseRole;
    }
  | { action: 'resend'; invitationId: string }
  | { action: 'revoke'; invitationId: string }
  | { action: 'accept' | 'decline'; invitationId: string; token?: string };

interface InvitationRpcError {
  code: TeamErrorCode;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

type InvitationRpcResult = { ok: true; value: unknown } | { ok: false; error: InvitationRpcError };

interface DeliveryRequest {
  to: string;
  message: ReturnType<typeof buildInvitationEmail>;
}

export interface InvitationCommandDependencies {
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<InvitationRpcResult>;
  deliver: (request: DeliveryRequest) => Promise<InvitationDeliveryResult>;
  createToken: () => string;
  siteUrl: string;
  actorId?: string;
  directAddMode?: unknown;
  /**
   * Which environment this function serves. In `beta` no delivery is attempted
   * and the invitation link is returned to the caller instead — see
   * deliverAndRecord.
   */
  environment?: 'production' | 'beta';
}

interface InvitationDeliverySnapshot {
  id: string;
  teamName: string;
  inviterName: string;
  targetEmail: string;
  initialRole: string | null;
  state: string | null;
  expiresAt: string | null;
}

function stringField(row: Record<string, unknown>, camel: string, snake: string): string {
  const value = row[camel] ?? row[snake];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return value;
}

function deliverySnapshot(value: unknown): InvitationDeliverySnapshot {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  const record = row as Record<string, unknown>;
  const optionalString = (camel: string, snake: string) => {
    const value = record[camel] ?? record[snake];
    return typeof value === 'string' ? value : null;
  };
  return {
    id: stringField(record, 'id', 'id'),
    teamName: stringField(record, 'teamName', 'team_name'),
    inviterName: stringField(record, 'inviterName', 'inviter_name'),
    targetEmail: stringField(record, 'targetEmail', 'target_email'),
    initialRole: optionalString('initialRole', 'initial_role'),
    state: optionalString('state', 'state'),
    expiresAt: optionalString('expiresAt', 'expires_at')
  };
}

function unwrap(result: InvitationRpcResult): unknown {
  if (result.ok) return result.value;
  throw new TeamFunctionError(result.error.code, {
    retryable: result.error.retryable,
    details: result.error.details
  });
}

function directAddLookupExists(value: unknown): boolean {
  if (!Array.isArray(value)) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (value.length === 0) return false;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  const userId = (row as Record<string, unknown>).user_id;
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return `\\x${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function inviteUrl(siteUrl: string, invitationId: string, token: string): string {
  const url = new URL('/account', siteUrl);
  url.searchParams.set('invitation', invitationId);
  url.searchParams.set('invite', token);
  return url.toString();
}

async function deliverAndRecord(
  snapshot: InvitationDeliverySnapshot,
  token: string,
  dependencies: InvitationCommandDependencies
) {
  const url = inviteUrl(dependencies.siteUrl, snapshot.id, token);
  const beta = dependencies.environment === 'beta';

  /**
   * Invitation mail is the one message type that does not travel through the
   * local mail catcher: delivery goes straight to a third-party API. A beta
   * environment must not send it, so no delivery is attempted at all — not even
   * a request that would fail — and the link is handed back to the caller
   * instead, which keeps the invitation flow fully exercisable offline.
   *
   * The recorded delivery state is the same one an unconfigured provider
   * already produces, so nothing about the database contract changes.
   */
  const delivery: InvitationDeliveryResult = beta
    ? { state: 'failed', errorCode: 'DELIVERY_UNAVAILABLE' }
    : await dependencies.deliver({
        to: snapshot.targetEmail,
        message: buildInvitationEmail({
          teamName: snapshot.teamName,
          inviterName: snapshot.inviterName,
          inviteUrl: url
        })
      });
  unwrap(
    await dependencies.rpc('set_invitation_delivery_state', {
      p_invitation: snapshot.id,
      p_delivery_state: delivery.state,
      p_error_code: delivery.errorCode
    })
  );
  return {
    invitationId: snapshot.id,
    targetEmail: snapshot.targetEmail,
    initialRole: snapshot.initialRole,
    state: snapshot.state,
    expiresAt: snapshot.expiresAt,
    deliveryState: delivery.state,
    deliveryErrorCode: delivery.errorCode,
    // Only ever populated in beta: in production this would hand a live
    // invitation token back over the wire for no reason.
    ...(beta ? { inviteUrl: url } : {})
  };
}

export async function executeInvitationCommand(
  command: InvitationCommand,
  dependencies: InvitationCommandDependencies
): Promise<unknown> {
  if (command.action === 'direct-add') {
    if (dependencies.directAddMode !== 'testing') {
      throw new TeamFunctionError('WRONG_STATE', { retryable: false });
    }
    if (!dependencies.actorId || !/^[0-9a-f-]{36}$/i.test(dependencies.actorId)) {
      throw new TeamFunctionError('AUTH_REQUIRED', { retryable: false });
    }
    const lookup = unwrap(
      await dependencies.rpc('lookup_invitable_account', {
        p_team: command.teamId,
        p_email: command.email
      })
    );
    if (!directAddLookupExists(lookup)) {
      throw new TeamFunctionError('NOT_FOUND', { retryable: false });
    }
    return unwrap(
      await dependencies.rpc('service_direct_add_registered_member', {
        p_actor: dependencies.actorId,
        p_team: command.teamId,
        p_email: command.email,
        p_base_role: command.initialRole
      })
    );
  }

  if (command.action === 'accept' || command.action === 'decline') {
    return unwrap(
      await dependencies.rpc(`${command.action}_invitation`, {
        p_invitation: command.invitationId,
        p_plain_token: command.token ?? null
      })
    );
  }

  if (command.action === 'revoke') {
    return unwrap(
      await dependencies.rpc('revoke_invitation', { p_invitation: command.invitationId })
    );
  }

  const token = dependencies.createToken();
  if (token.length < 16 || token.length > 512) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const tokenHash = await sha256Hex(token);
  const rpcResult =
    command.action === 'create'
      ? await dependencies.rpc('create_invitation', {
          p_team: command.teamId,
          p_email: command.email,
          p_initial_role: command.initialRole,
          p_token_hash: tokenHash
        })
      : await dependencies.rpc('resend_invitation', {
          p_invitation: command.invitationId,
          p_token_hash: tokenHash
        });
  const snapshot = deliverySnapshot(unwrap(rpcResult));
  return deliverAndRecord(snapshot, token, dependencies);
}
