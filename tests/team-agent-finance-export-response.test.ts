import { expect, it } from 'vitest';
import { financeExportErrorResponse } from '../supabase/functions/team-finance-export/response';
it('distinguishes expired authentication, forbidden access, invalid requests and export limits without emitting a partial file', async () => {
  for (const [cause, status, code, retryable] of [
    [new Error('AUTH_REQUIRED'), 401, 'AUTH_REQUIRED', false],
    [new Error('PERMISSION_DENIED'), 403, 'PERMISSION_DENIED', false],
    [new Error('NOT_A_MEMBER'), 403, 'PERMISSION_DENIED', false],
    [new SyntaxError('invalid JSON'), 400, 'INVALID_INPUT', false],
    [new Error('INVALID_INPUT'), 400, 'INVALID_INPUT', false],
    [new RangeError('FINANCE_EXPORT_PRECISION'), 409, 'FINANCE_EXPORT_FAILED', false],
    [new RangeError('FINANCE_EXPORT_SIZE'), 409, 'FINANCE_EXPORT_FAILED', false],
    [new Error('unexpected'), 500, 'FINANCE_EXPORT_FAILED', true]
  ] as const) {
    const response = financeExportErrorResponse(cause, { 'cache-control': 'private, no-store' });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: false, error: { code, retryable } });
  }
});
