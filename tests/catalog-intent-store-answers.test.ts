import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import {
  catalogIntentRpcFailure,
  catalogIntentStore,
  resumeOrReadInitialCatalog
} from '../supabase/functions/drive-ops/catalog-durable.ts';

// Beta 2026-11-26: a creation whose picture pool could not be confirmed stood at «Готово відео:
// 1 з 1» for good. service_plan_catalog_resources answered GLOBAL_IMAGE_READINESS_UNKNOWN, the
// intent store folded it into GROUP_RECONCILING ("another executor holds this"), and the resume
// answered with the progress so far instead of the reason.
const id = (n: number) => '17500000-0000-4000-8000-' + String(n).padStart(12, '0');
afterEach(() => vi.restoreAllMocks());

describe('what an intent step refused with', () => {
  it('passes a code the database raised on as that code', () => {
    for (const code of [
      'GLOBAL_IMAGE_READINESS_UNKNOWN',
      'GLOBAL_IMAGE_POOL_UNAVAILABLE',
      'CATALOG_IMAGE_UPGRADE_REQUIRED',
      'GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED',
      'NOT_FOUND',
      'INVALID_INPUT'
    ] as const) {
      const failure = catalogIntentRpcFailure('service_plan_catalog_resources', { message: code });
      expect(failure).toBeInstanceOf(TeamFunctionError);
      expect(failure.code).toBe(code);
      // Its own status and retryability, not the lease answer's.
      expect(failure.retryable).toBe(new TeamFunctionError(code).retryable);
    }
  });

  it('keeps the lease and state answers as they were, retryable', () => {
    for (const code of [
      'GROUP_RECONCILING',
      'LEASE_MISMATCH',
      'REQUEST_REUSE_CONFLICT',
      'WRONG_STATE',
      'PERMISSION_DENIED'
    ] as const)
      expect(
        catalogIntentRpcFailure('service_begin_catalog_intent', { message: code })
      ).toMatchObject({ code, retryable: true });
  });

  it('reads an answer that is no code as busy, and says which step gave it without its text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      catalogIntentRpcFailure('service_plan_catalog_resources', {
        message: 'canceling statement due to statement timeout for owner@example.invalid',
        code: '57014'
      })
    ).toMatchObject({ code: 'GROUP_RECONCILING', retryable: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(' ');
    expect(line).toContain('"rpc":"service_plan_catalog_resources"');
    expect(line).toContain('"sqlstate":"57014"');
    expect(line).not.toContain('statement timeout');
    expect(line).not.toContain('example.invalid');
  });

  it('gives the store the same answer through its own steps', async () => {
    const store = catalogIntentStore(
      {
        rpc: async () => ({ data: null, error: { message: 'GLOBAL_IMAGE_READINESS_UNKNOWN' } })
      },
      id(1),
      id(2),
      id(3),
      'product-catalog:' + id(4)
    );
    await expect(
      store.resources!(
        {
          id: id(5),
          variant: 1,
          state: 'interrupted',
          fence: '1',
          attempt: 1,
          checkpoint: {},
          result: null,
          operationId: null
        },
        id(6)
      )
    ).rejects.toMatchObject({ code: 'GLOBAL_IMAGE_READINESS_UNKNOWN' });
  });
});

describe('resuming a creation', () => {
  it('answers with the reason, not with the progress, when the step really refused', async () => {
    const readProgress = vi.fn(async () => ({ outcome: 'preparing_video' }));
    await expect(
      resumeOrReadInitialCatalog(
        Promise.reject(
          catalogIntentRpcFailure('service_plan_catalog_resources', {
            message: 'GLOBAL_IMAGE_READINESS_UNKNOWN'
          })
        ),
        readProgress
      )
    ).rejects.toMatchObject({ code: 'GLOBAL_IMAGE_READINESS_UNKNOWN' });
    expect(readProgress).not.toHaveBeenCalled();
  });

  it('still answers with the progress while another executor holds the creation', async () => {
    await expect(
      resumeOrReadInitialCatalog(
        Promise.reject(
          catalogIntentRpcFailure('service_begin_catalog_intent', {
            message: 'GROUP_RECONCILING'
          })
        ),
        async () => ({ outcome: 'preparing_video' })
      )
    ).resolves.toEqual({ outcome: 'preparing_video' });
  });
});
