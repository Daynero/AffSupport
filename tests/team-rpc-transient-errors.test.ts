import { describe, expect, it } from 'vitest';
import { TeamApiError, throwRpc } from '../apps/web/src/api/team';

/**
 * 1.4.3 (beta 2026-11-11): under load PostgREST answered a launch read with
 * 5xx/statement timeouts; throwRpc turned them into a non-retryable
 * INVALID_RESPONSE and the open launch dialog closed itself.
 */
function caught(error: { message: string; code?: string }): TeamApiError {
  try {
    throwRpc(error);
  } catch (cause) {
    if (cause instanceof TeamApiError) return cause;
    throw cause;
  }
  throw new Error('throwRpc did not throw');
}

describe('throwRpc transient server failures', () => {
  it.each([
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: 'PGRST003', message: 'Timed out acquiring connection from connection pool.' },
    { code: '53300', message: 'sorry, too many clients already' },
    { code: '', message: '<html><title>502 Bad Gateway</title></html>' },
    { code: '', message: 'upstream request timeout' },
    { code: '', message: 'supabase.co | 522: Connection timed out' }
  ])('treats %o as a retryable transport failure', error => {
    const failure = caught(error);
    expect(failure.code).toBe('TEAM_TRANSPORT_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
  });

  it('keeps a real refusal non-retryable', () => {
    const failure = caught({ code: 'P0001', message: 'PERMISSION_DENIED' });
    expect(failure.code).toBe('PERMISSION_DENIED');
    expect(failure.retryable).toBe(false);
  });

  it('keeps an unknown non-transient database error non-retryable', () => {
    const failure = caught({ code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(failure.code).toBe('INVALID_RESPONSE');
    expect(failure.retryable).toBe(false);
  });
});
