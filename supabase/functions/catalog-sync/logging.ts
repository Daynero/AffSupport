import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';

/**
 * What the catalog sync worker writes to its log (028).
 *
 * Two records: the outcome of one claimed job, and a database error that the
 * worker is about to turn into a retryable "Drive unavailable". Both carry
 * the identifiers an operator needs to join a browser's request to the job
 * and the job to its space; neither ever carries a token, a cursor, a file
 * name or an RPC parameter.
 */

export interface JobResultFields {
  jobId: string;
  jobKind: string;
  teamId: string | null;
  connectionId: string;
  workerId: string;
  leaseEpoch: number;
  queueFolders: number;
  runtimeMs: number;
  providerCalls: number;
  result: 'checkpoint' | 'retry' | 'lease_lost';
  phase?: string;
  processed?: number;
  slices?: number;
  yielded?: boolean;
  code?: string;
}

export function jobResultRecord(fields: JobResultFields): Record<string, unknown> {
  return { ...fields };
}

const SAFE_RPC_REASONS = new Set<string>([
  ...TEAM_ERROR_CODES,
  'INCOMPLETE_SCAN',
  'INCOMPLETE_LISTING',
  'LEASE_LOST',
  'LEASE_MISMATCH',
  'STALE_RESULT'
]);

/**
 * Keep a SQLSTATE and a closed raised reason, never arbitrary database prose:
 * PostgreSQL conversion errors can echo the rejected input in their message.
 */
export function rpcErrorRecord(
  rpc: string,
  error: { code?: unknown; message?: unknown }
): { event: 'catalog_sync_rpc_error'; rpc: string; code: string | null; message: string | null } {
  return {
    event: 'catalog_sync_rpc_error',
    rpc,
    code:
      typeof error.code === 'string' && /^(?:[A-Z0-9]{5}|PGRST\d{3})$/u.test(error.code)
        ? error.code
        : null,
    message:
      typeof error.message === 'string' && SAFE_RPC_REASONS.has(error.message)
        ? error.message
        : null
  };
}
