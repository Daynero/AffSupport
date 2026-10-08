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

const MESSAGE_LIMIT = 200;

/**
 * The database's own words, bounded and without the request behind them. A
 * SQLSTATE and a `raise exception` text like `INCOMPLETE_SCAN` are what an
 * operator needs; the RPC parameters are what they must not see.
 */
export function rpcErrorRecord(
  rpc: string,
  error: { code?: unknown; message?: unknown }
): { event: 'catalog_sync_rpc_error'; rpc: string; code: string | null; message: string | null } {
  return {
    event: 'catalog_sync_rpc_error',
    rpc,
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? error.message.slice(0, MESSAGE_LIMIT) : null
  };
}
