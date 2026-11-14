import { describe, expect, it, vi } from 'vitest';
import { recoveryDriveResult } from '../supabase/functions/team-recovery/drive-response';
import {
  handleRecovery,
  type RecoveryHandlerDeps
} from '../supabase/functions/team-recovery/handler';
import { errorResponse, TeamFunctionError } from '../supabase/functions/_shared/errors';

describe('recovery to Drive HTTP error transport', () => {
  it.each([
    'AUTH_REQUIRED',
    'PERMISSION_DENIED',
    'NEEDS_REAUTH',
    'RESTITCH_CLIENT_OUTDATED'
  ] as const)('preserves the actionable %s refusal', async code => {
    await expect(
      recoveryDriveResult(errorResponse(new TeamFunctionError(code)))
    ).rejects.toMatchObject({ code, retryable: false });
  });

  it('preserves provider backoff without forwarding identifying details', async () => {
    await expect(
      recoveryDriveResult(
        Response.json(
          {
            ok: false,
            error: {
              code: 'RATE_LIMITED',
              retryable: true,
              details: { retryAfterMs: 60_000, token: 'secret', reason: 'user@example.test' }
            }
          },
          { status: 429 }
        )
      )
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      details: { retryAfterMs: 60_000 }
    });
  });

  it('reaches the outdated-agent settlement through an actual HTTP refusal', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const credential = 'a'.repeat(43);
    const rpc = vi.fn(async (action: string) =>
      action === 'claim' ? { teamId: id } : { job: null, operationCredential: null }
    );
    const deps: RecoveryHandlerDeps = {
      user: vi.fn(),
      rpc,
      revoke: vi.fn(),
      token: () => credential,
      hash: async () => 'hash',
      drive: async () =>
        recoveryDriveResult(errorResponse(new TeamFunctionError('RESTITCH_CLIENT_OUTDATED')))
    };
    const request = new Request('https://synthetic.test/recovery', {
      method: 'POST',
      headers: { 'x-team-recovery-credential': credential },
      body: JSON.stringify({ action: 'claim', protocolVersion: 2, requestId: id })
    });
    await expect(handleRecovery(request, deps)).rejects.toMatchObject({
      code: 'AGENT_UPDATE_REQUIRED'
    });
    expect(rpc.mock.calls.map(([action]) => action)).toEqual(['claim', 'register_claim']);
  });

  it('returns a valid success receipt unchanged', async () => {
    await expect(
      recoveryDriveResult(Response.json({ ok: true, value: { job: null } }))
    ).resolves.toEqual({ job: null });
  });

  it.each([
    'not JSON',
    JSON.stringify({ ok: false, error: { code: 'UNKNOWN_PROVIDER_FAILURE', retryable: false } }),
    JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }),
    JSON.stringify({ ok: true, value: { job: null } })
  ])('keeps an unknown or inconsistent failure retryable: %s', async body => {
    await expect(recoveryDriveResult(new Response(body, { status: 503 }))).rejects.toMatchObject({
      code: 'DRIVE_UNAVAILABLE',
      retryable: true
    });
  });
});
