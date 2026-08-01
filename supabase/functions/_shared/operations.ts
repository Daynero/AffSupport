import { TeamFunctionError } from './errors.ts';
import type { ServiceRpcClient } from './credentials.ts';
import { isRecord } from './validation.ts';

export interface OperationAuthority {
  operationId: string;
  state: 'pending' | 'running' | 'succeeded' | 'canceled' | 'failed';
  reused: boolean;
}

const OPERATION_ERROR_CODES = new Set([
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INVALID_INPUT',
  'WRONG_STATE',
  'NAME_CONFLICT',
  'SOURCE_CHANGED',
  'DRIVE_UNAVAILABLE'
]);

function operationRpcError(error: { code?: string; message?: string }): TeamFunctionError {
  const candidates = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/gu) ?? []);
  const code = candidates.find(candidate => OPERATION_ERROR_CODES.has(candidate));
  return new TeamFunctionError(
    (code as
      | 'PERMISSION_DENIED'
      | 'NOT_FOUND'
      | 'INVALID_INPUT'
      | 'WRONG_STATE'
      | 'NAME_CONFLICT'
      | 'SOURCE_CHANGED'
      | 'DRIVE_UNAVAILABLE') ?? 'DRIVE_UNAVAILABLE',
    { retryable: code === 'DRIVE_UNAVAILABLE' }
  );
}

function byteaHex(value: Uint8Array): string {
  return `\\x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function sha256(value: string): Promise<Uint8Array> {
  if (value.length < 16) throw new TeamFunctionError('INVALID_INPUT');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{7,199}$/i.test(value)) {
    throw new TeamFunctionError('INVALID_INPUT');
  }
  return value;
}

function parseOperationAuthority(value: unknown): OperationAuthority | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (
    !isRecord(row) ||
    typeof row.operation_id !== 'string' ||
    !['pending', 'running', 'succeeded', 'canceled', 'failed'].includes(String(row.state)) ||
    typeof row.reused !== 'boolean'
  ) {
    return null;
  }
  return {
    operationId: row.operation_id,
    state: row.state as OperationAuthority['state'],
    reused: row.reused
  };
}

export async function startOperation(input: {
  service: ServiceRpcClient;
  teamId: string;
  actorId: string;
  kind: string;
  idempotencyKey: string;
  requestNonce: string;
  sourceMaterialId?: string | null;
  destinationFolderId?: string | null;
  reservedNameKey?: string | null;
  reservationExpiresAt?: string | null;
  bytesTotal?: number | null;
}): Promise<OperationAuthority> {
  const { data, error } = await input.service.rpc('service_start_team_operation', {
    p_team: input.teamId,
    p_actor: input.actorId,
    p_kind: input.kind,
    p_idempotency_key: requireIdempotencyKey(input.idempotencyKey),
    p_request_nonce: requireIdempotencyKey(input.requestNonce),
    p_source_material: input.sourceMaterialId ?? null,
    p_destination_folder: input.destinationFolderId ?? null,
    p_reserved_name_key: input.reservedNameKey ?? null,
    p_reservation_expires_at: input.reservationExpiresAt ?? null,
    p_bytes_total: input.bytesTotal ?? null
  });
  if (error) {
    if (error.code === '23505') throw new TeamFunctionError('NAME_CONFLICT');
    throw operationRpcError(error);
  }
  const authority = parseOperationAuthority(data);
  if (!authority) throw new TeamFunctionError('INVALID_RESPONSE');
  return authority;
}

export async function transitionOperation(input: {
  service: ServiceRpcClient;
  operationId: string;
  state: OperationAuthority['state'];
  stage?: string | null;
  progress?: number;
  resultMaterialId?: string | null;
  errorCode?: string | null;
  retryable?: boolean;
}): Promise<void> {
  const { error } = await input.service.rpc('service_transition_team_operation', {
    p_operation: input.operationId,
    p_state: input.state,
    p_stage: input.stage ?? null,
    p_progress: Math.min(100, Math.max(0, Math.round(input.progress ?? 0))),
    p_result_material: input.resultMaterialId ?? null,
    p_error_code: input.errorCode ?? null,
    p_retryable: input.retryable ?? false
  });
  if (error) throw operationRpcError(error);
}

export async function releaseNameReservation(
  service: ServiceRpcClient,
  operationId: string
): Promise<void> {
  const { error } = await service.rpc('service_release_team_name_reservation', {
    p_operation: operationId
  });
  if (error) throw operationRpcError(error);
}

export async function issueTransferGrant(input: {
  service: ServiceRpcClient;
  token: string;
  operationId: string | null;
  teamId: string;
  actorId: string;
  purpose: 'preview_range' | 'download_range' | 'process_input' | 'process_output' | 'finalize';
  materialId: string | null;
  destinationFolderId: string | null;
  toolId: string | null;
  maxRangeBytes: number;
  expiresAt: string;
  maxUses: number;
}): Promise<void> {
  const tokenHash = await sha256(input.token);
  const { error } = await input.service.rpc('issue_team_transfer_grant', {
    p_token_hash: byteaHex(tokenHash),
    p_operation: input.operationId,
    p_team: input.teamId,
    p_actor: input.actorId,
    p_purpose: input.purpose,
    p_material: input.materialId,
    p_destination: input.destinationFolderId,
    p_tool: input.toolId,
    p_max_range_bytes: input.maxRangeBytes,
    p_expires_at: input.expiresAt,
    p_max_uses: input.maxUses
  });
  if (error) throw operationRpcError(error);
}

export async function consumeTransferGrant(
  service: ServiceRpcClient,
  token: string,
  purpose: string
): Promise<unknown> {
  const { data, error } = await service.rpc('consume_team_transfer_grant', {
    p_token_hash: byteaHex(await sha256(token)),
    p_purpose: purpose
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new TeamFunctionError('PERMISSION_DENIED');
  }
  return data[0];
}

export async function recordAudit(input: {
  service: ServiceRpcClient;
  teamId: string;
  actorId: string;
  action: string;
  target: Record<string, string | number | boolean | null>;
  result: 'succeeded' | 'denied' | 'failed' | 'canceled';
  errorCode?: string | null;
}): Promise<void> {
  const { error } = await input.service.rpc('record_team_audit', {
    p_team: input.teamId,
    p_actor: input.actorId,
    p_action: input.action,
    p_target: input.target,
    p_result: input.result,
    p_error_code: input.errorCode ?? null
  });
  if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
}
