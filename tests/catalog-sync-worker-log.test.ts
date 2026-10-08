import { describe, expect, it } from 'vitest';
import { jobResultRecord, rpcErrorRecord } from '../supabase/functions/catalog-sync/logging';

/**
 * 028 — the worker's log lines carry the identifiers an operator needs and
 * nothing a person could be hurt by. The records are built by pure functions
 * so this suite can hold them to that without a Deno runtime.
 */

const SECRET_SHAPES = [/ya29\./, /refresh[_-]?token/i, /pageToken=/, /\.mp4\b/, /\/Users\//];

describe('catalog_sync_job_result', () => {
  it('names the job, its space, its connection, the worker and the lease epoch', () => {
    const record = jobResultRecord({
      jobId: 'job',
      jobKind: 'user_subtree',
      teamId: 'team',
      connectionId: 'connection',
      workerId: 'catalog-1',
      leaseEpoch: 7,
      queueFolders: 3,
      runtimeMs: 1200,
      providerCalls: 9,
      result: 'checkpoint',
      phase: 'initial_scan',
      processed: 40,
      slices: 2,
      yielded: true
    });
    expect(record).toMatchObject({
      jobId: 'job',
      teamId: 'team',
      connectionId: 'connection',
      workerId: 'catalog-1',
      leaseEpoch: 7,
      result: 'checkpoint'
    });
    expect(Object.keys(record)).not.toContain('cursor');
    expect(Object.keys(record)).not.toContain('parameters');
  });
});

describe('catalog_sync_rpc_error', () => {
  it('keeps the SQLSTATE and the raised text, drops the parameters', () => {
    const record = rpcErrorRecord('service_commit_catalog_scan_page', {
      code: '22023',
      message: 'INCOMPLETE_SCAN',
      details: 'p_files: [{"name":"secret.mp4"}]'
    } as { code: string; message: string });
    expect(record).toEqual({
      event: 'catalog_sync_rpc_error',
      rpc: 'service_commit_catalog_scan_page',
      code: '22023',
      message: 'INCOMPLETE_SCAN'
    });
  });

  it('bounds a long message and tolerates a missing one', () => {
    expect(rpcErrorRecord('x', { message: 'y'.repeat(500) }).message).toHaveLength(200);
    expect(rpcErrorRecord('x', {})).toEqual({
      event: 'catalog_sync_rpc_error',
      rpc: 'x',
      code: null,
      message: null
    });
  });

  it('never carries a token, a page token or a file name in either record', () => {
    const lines = [
      JSON.stringify(rpcErrorRecord('rpc', { code: 'P0001', message: 'LEASE_LOST' })),
      JSON.stringify(
        jobResultRecord({
          jobId: 'job',
          jobKind: 'incremental',
          teamId: null,
          connectionId: 'connection',
          workerId: 'catalog-2',
          leaseEpoch: 1,
          queueFolders: 0,
          runtimeMs: 10,
          providerCalls: 1,
          result: 'retry',
          code: 'RATE_LIMITED'
        })
      )
    ];
    for (const line of lines) {
      for (const shape of SECRET_SHAPES) expect(line).not.toMatch(shape);
    }
  });
});
