import { afterEach, expect, it, vi } from 'vitest';
import { catalogUpdaterRpcError } from '../supabase/functions/catalog-updater/rpc-error';

afterEach(() => vi.restoreAllMocks());

/**
 * 2026-11-25: every refusal of a database function reached the catalog manager as
 * DRIVE_UNAVAILABLE — «Google Drive не відповідає» for a picture pool that was not ready.
 * The registry's own codes now pass through; the rest stays the retryable unavailability.
 */
it('passes a code the registry knows through as it is', () => {
  for (const code of [
    'GLOBAL_IMAGE_READINESS_UNKNOWN',
    'GLOBAL_IMAGE_POLICY_CONFLICT',
    'CATALOG_PUBLICATION_PENDING',
    'LEASE_MISMATCH',
    'SOURCE_CHANGED',
    'WRONG_STATE'
  ]) {
    expect(catalogUpdaterRpcError('service_x', { code: 'P0001', message: code }).code).toBe(code);
  }
  expect(
    catalogUpdaterRpcError('service_x', { message: 'GLOBAL_IMAGE_READINESS_UNKNOWN' }).retryable
  ).toBe(false);
});

it('keeps a failed connection, a timeout and a code nobody registered retryable', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const failure of [
    { message: 'canceling statement due to statement timeout', code: '57014' },
    { message: 'TypeError: fetch failed' },
    {},
    { message: 'INVALID_AUDIT_EVENT', code: 'P0001' }
  ]) {
    const error = catalogUpdaterRpcError('service_x', failure);
    expect(error.code).toBe('DRIVE_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  }
  // Only the closed code is named in the log; free text never is.
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    '[catalog-updater] unregistered database code',
    'service_x',
    'INVALID_AUDIT_EVENT'
  );
});
