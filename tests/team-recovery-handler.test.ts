import { recoveryDigest, recoveryTokenHash } from '../supabase/functions/team-recovery/digest';
import { describe, expect, it, vi } from 'vitest';
import {
  handleRecovery,
  type RecoveryHandlerDeps
} from '../supabase/functions/team-recovery/handler';
const ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);
function deps(): RecoveryHandlerDeps {
  return {
    user: vi.fn(async () => ID),
    rpc: vi.fn(async () => ({})),
    revoke: vi.fn(async () => {}),
    drive: vi.fn(async () => ({ job: null })),
    token: () => SECRET,
    hash: async () => 'hashed'
  };
}
function request(body: unknown, origin = false) {
  return new Request('https://synthetic.test', {
    method: 'POST',
    headers: {
      'x-team-recovery-credential': SECRET,
      ...(origin ? { origin: 'https://web.test' } : {})
    },
    body: JSON.stringify(body)
  });
}
describe('native recovery protocol', () => {
  it('encodes a SHA-256 digest as 32 PostgreSQL bytea bytes', async () => {
    const digest = await recoveryTokenHash(SECRET);
    expect(digest.length).toBe(66);
    expect(digest.slice(0, 2)).toBe(String.fromCharCode(92) + 'x');
    expect(Buffer.from(digest.slice(2), 'hex')).toHaveLength(32);
    expect(recoveryDigest('b'.repeat(64))).toBe(String.fromCharCode(92) + 'x' + 'b'.repeat(64));
  });
  it('rejects credential-bearing browser calls before consuming a credential', async () => {
    const d = deps();
    await expect(
      handleRecovery(request({ action: 'rotate', rotationId: ID }, true), d)
    ).rejects.toThrow();
    expect(d.rpc).not.toHaveBeenCalled();
  });
  it('derives delegation actor from authentication rather than request body', async () => {
    const d = deps();
    await handleRecovery(
      request(
        {
          action: 'delegate',
          teamId: ID,
          installationId: ID,
          ticketDigest: 'b'.repeat(64),
          actorId: 'forged'
        },
        true
      ),
      d
    );
    expect(d.rpc).toHaveBeenCalledWith('delegate', recoveryDigest('b'.repeat(64)), {
      actorId: ID,
      teamId: ID,
      installationId: ID
    });
  });
  it('returns a durable claim replay without claiming another job', async () => {
    const d = deps();
    vi.mocked(d.rpc).mockResolvedValue({ replay: { job: null } });
    expect(await handleRecovery(request({ action: 'claim', requestId: ID }), d)).toEqual({
      job: null
    });
    expect(d.drive).not.toHaveBeenCalled();
  });
  it('does not settle an operation whose terminal result is unknown', async () => {
    const d = deps();
    vi.mocked(d.rpc).mockResolvedValue({ operationState: 'running' });
    expect(
      await handleRecovery(
        request({ action: 'settle', operationId: ID, jobId: ID, leaseToken: SECRET }),
        d
      )
    ).toEqual({ pending: true });
    expect(d.drive).not.toHaveBeenCalled();
  });
  it('does not release a successful upload before its catalog output receipt is durable', async () => {
    const d = deps();
    vi.mocked(d.rpc).mockResolvedValue({ operationState: 'succeeded', outputRecorded: false });
    expect(
      await handleRecovery(
        request({ action: 'settle', operationId: ID, jobId: ID, leaseToken: SECRET }),
        d
      )
    ).toEqual({ pending: true });
    expect(d.drive).not.toHaveBeenCalled();
  });
  it('uses the authoritative terminal receipt before completing the existing job', async () => {
    const d = deps();
    vi.mocked(d.rpc).mockResolvedValue({ operationState: 'succeeded', outputRecorded: true });
    await handleRecovery(
      request({ action: 'settle', operationId: ID, jobId: ID, leaseToken: SECRET }),
      d
    );
    expect(d.drive).toHaveBeenCalledWith('complete', SECRET, {
      jobId: ID,
      leaseToken: SECRET,
      outcome: 'finalized',
      errorCode: null
    });
    expect(d.rpc).toHaveBeenLastCalledWith('settle', 'hashed', { operationId: ID, jobId: ID });
  });
  it('rejects unknown actions and oversized input without side effects', async () => {
    const d = deps();
    await expect(handleRecovery(request({ action: 'arbitrary' }), d)).rejects.toThrow();
    await expect(
      handleRecovery(request({ action: 'probe', padding: 'x'.repeat(262145) }), d)
    ).rejects.toThrow();
    expect(d.rpc).not.toHaveBeenCalled();
  });
});
