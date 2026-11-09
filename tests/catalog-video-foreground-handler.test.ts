import { it, expect, vi } from 'vitest';
import { handleCatalogVideoForeground } from '../supabase/functions/drive-ops/catalog-video-foreground';
import {
  catalogForegroundHash,
  catalogForegroundTicket
} from '../supabase/functions/drive-ops/catalog-video-foreground-authority';
const id = 'c1800000-0000-4000-8000-000000000001';
const body = {
  protocolVersion: 1,
  enrollmentId: id,
  nativeInstanceId: id,
  proofSecret: 'a'.repeat(43)
};
const req = (headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:54321/functions/v1/drive-ops/catalog-video/foreground/await', {
    method: 'POST',
    headers
  });
it('rejects browser origin before lookup and never accepts recovery namespace as foreground ticket', async () => {
  const service = { rpc: vi.fn() };
  const admit = vi.fn();
  await expect(
    handleCatalogVideoForeground(
      service,
      's'.repeat(32),
      req({ origin: 'http://localhost:5175' }),
      'await',
      body,
      admit
    )
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  await expect(
    handleCatalogVideoForeground(
      service,
      's'.repeat(32),
      req({ 'x-team-recovery-credential': 'a'.repeat(43) }),
      'load',
      { ...body, setId: id },
      admit
    )
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(service.rpc).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});
it('pending/unused replies disclose neither service private scope nor a ticket and perform no process admission', async () => {
  for (const state of ['pending', 'unused']) {
    const service = {
        rpc: vi.fn().mockResolvedValue({
          data: { state, enrollmentId: id, _ticketScope: { secret: 'never' }, ticket: 'never' },
          error: null
        })
      },
      admit = vi.fn();
    expect(
      await handleCatalogVideoForeground(service, 's'.repeat(32), req(), 'await', body, admit)
    ).toEqual({ state, enrollmentId: id });
    expect(admit).not.toHaveBeenCalled();
  }
});
it('ticket is stable for original immutable scope and requires private server secret', async () => {
  const receipt = {
      protocolVersion: 1 as const,
      enrollmentId: id,
      nativeInstanceId: id,
      proofDigest: 'a'.repeat(64)
    },
    scope = {
      teamId: id,
      actorId: id,
      sessionId: id,
      sourceMaterialId: id,
      consumerKind: 'create' as const,
      requestKey: 'original',
      expectedVersion: null
    };
  const ticket = await catalogForegroundTicket('s'.repeat(32), scope, receipt);
  expect(await catalogForegroundTicket('s'.repeat(32), scope, receipt)).toBe(ticket);
  expect(await catalogForegroundTicket('t'.repeat(32), scope, receipt)).not.toBe(ticket);
  expect(
    await catalogForegroundTicket('s'.repeat(32), { ...scope, requestKey: 'other' }, receipt)
  ).not.toBe(ticket);
  expect(await catalogForegroundHash(ticket)).toMatch(/^\\x[a-f0-9]{64}$/u);
});
