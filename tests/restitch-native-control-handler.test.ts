import { expect, it, vi } from 'vitest';
import {
  handleRestitchNativeControl,
  restitchEnrollmentProofHash
} from '../supabase/functions/drive-ops/restitch-native-control';
import { restitchTicket } from '../supabase/functions/drive-transfer/restitch-ticket';
const id = (n: number) => 'b1760000-0000-4000-8000-' + String(n).padStart(12, '0');
const receipt = {
  grantId: id(1),
  enrollmentId: id(1),
  rootOperationId: id(2),
  teamId: id(3),
  actorId: id(4),
  nativeInstanceId: id(5),
  expiresAt: '2026-11-08T00:00:00Z',
  redeemed: true
};
const owned = {
  rootOperationId: id(2),
  claimId: id(6),
  nativeInstanceId: id(5),
  executorId: id(7),
  epoch: 1,
  active: true
};
const secret = 's'.repeat(64);
function fixture() {
  const rpc = vi.fn(
    async (
      _name: string,
      _args: Record<string, unknown>
    ): Promise<{ data: unknown; error: { message: string } | null }> => ({
      data: receipt,
      error: null
    })
  );
  const user = vi.fn(async () => ({ userId: id(4), sessionId: id(8) }));
  return { rpc, user, deps: { service: { rpc }, secret, user } };
}
function request(headers: Record<string, string> = {}) {
  return new Request('https://project.invalid/native-control', { method: 'POST', headers });
}
it('takes enrollment actor/session from verified authorization and never returns the control ticket to a browser', async () => {
  const f = fixture(),
    body = {
      teamId: id(3),
      rootOperationId: id(2),
      enrollmentId: id(1),
      nativeInstanceId: id(5),
      proofDigest: 'a'.repeat(64),
      actorId: id(99),
      sessionId: id(98)
    };
  const result = await handleRestitchNativeControl(
    request({ origin: 'https://app.invalid' }),
    'enroll',
    body,
    f.deps
  );
  expect(f.rpc.mock.calls[0]).toEqual([
    'service_issue_restitch_native_control',
    expect.objectContaining({
      p_actor: id(4),
      p_session: id(8),
      p_grant: id(1),
      p_enrollment: id(1)
    })
  ]);
  expect(result).toEqual(receipt);
  expect(JSON.stringify(result)).not.toContain(await restitchTicket(secret, id(1), 'control'));
});
it.each(['redeem', 'claim', 'read', 'quiesce', 'authorize'])(
  'refuses a browser origin for native-only %s before reading credentials or SQL',
  async action => {
    const f = fixture();
    await expect(
      handleRestitchNativeControl(request({ origin: 'https://app.invalid' }), action, {}, f.deps)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.user).not.toHaveBeenCalled();
  }
);
it('returns the purpose-bound ticket only after acknowledging the original native proof', async () => {
  const f = fixture(),
    proof = 'p'.repeat(43);
  const result = await handleRestitchNativeControl(
    request({ 'x-restitch-enrollment-secret': proof }),
    'redeem',
    { grantId: id(1), protocolVersion: 1 },
    f.deps
  );
  expect(f.rpc.mock.calls[0]).toEqual([
    'service_redeem_restitch_native_control',
    { p_grant: id(1), p_proof_hash: await restitchEnrollmentProofHash(proof) }
  ]);
  expect(result).toMatchObject({
    purpose: 'restitch_native_control_v1',
    protocolVersion: 1,
    ticket: await restitchTicket(secret, id(1), 'control')
  });
  expect(f.user).not.toHaveBeenCalled();
});
it('does not mint a ticket after a malformed native proof acknowledgement', async () => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: { ...receipt, grantId: id(99) }, error: null });
  await expect(
    handleRestitchNativeControl(
      request({ 'x-restitch-enrollment-secret': 'p'.repeat(43) }),
      'redeem',
      { grantId: id(1), protocolVersion: 1 },
      f.deps
    )
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
});
it('derives ownership from the enrolled control instead of body-selected actor, root, executor or epoch', async () => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: owned, error: null });
  expect(
    await handleRestitchNativeControl(
      request({ 'x-restitch-control-ticket': 'c'.repeat(43) }),
      'claim',
      {
        grantId: id(1),
        claimId: id(6),
        protocolVersion: 1,
        actorId: id(99),
        rootOperationId: id(98),
        executorId: id(97),
        epoch: 99
      },
      f.deps
    )
  ).toEqual(owned);
  expect(f.rpc.mock.calls[0]).toEqual([
    'service_claim_restitch_native_control',
    {
      p_grant: id(1),
      p_ticket_hash: expect.stringMatching(/^\\x[a-f0-9]{64}$/u),
      p_claim: id(6),
      p_contract: 1
    }
  ]);
});
it('retains a lost claim acknowledgement with one exact read and no second claim', async () => {
  const f = fixture();
  f.rpc.mockRejectedValueOnce(Error('PRIVATE_PAYLOAD'));
  f.rpc.mockResolvedValueOnce({ data: owned, error: null });
  expect(
    await handleRestitchNativeControl(
      request({ 'x-restitch-control-ticket': 'c'.repeat(43) }),
      'claim',
      { grantId: id(1), claimId: id(6), protocolVersion: 1 },
      f.deps
    )
  ).toEqual(owned);
  expect(f.rpc.mock.calls.map(call => call[0])).toEqual([
    'service_claim_restitch_native_control',
    'service_read_restitch_native_control_claim'
  ]);
});
it('does not use ordinary authorization or generic transfer body tickets as native control', async () => {
  const f = fixture();
  await expect(
    handleRestitchNativeControl(
      request({ authorization: 'Bearer ordinary-user-jwt' }),
      'claim',
      { grantId: id(1), claimId: id(6), protocolVersion: 1, ticket: 'c'.repeat(43) },
      f.deps
    )
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.user).not.toHaveBeenCalled();
});
it.each([false, null, 'true'])('does not acknowledge ambiguous native closure %j', async value => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: value, error: null });
  await expect(
    handleRestitchNativeControl(
      request({ 'x-restitch-control-ticket': 'c'.repeat(43) }),
      'quiesce',
      { grantId: id(1), claimId: id(6), quiescenceId: id(9), protocolVersion: 1 },
      f.deps
    )
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
});
