// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  request: vi.fn(),
  body: vi.fn(),
  entitlement: vi.fn(),
  invoke: vi.fn()
}));
vi.mock('../apps/web/src/api/client', () => ({
  request: (...args: unknown[]) => fake.request(...args),
  requestBody: (...args: unknown[]) => fake.body(...args)
}));
vi.mock('../apps/web/src/api/entitlement', () => ({
  ensureAgentEntitlement: () => fake.entitlement()
}));
vi.mock('../apps/web/src/api/team', () => ({
  invokeTeamFunction: (...args: unknown[]) => fake.invoke(...args)
}));
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, value: { supabaseUrl: 'http://127.0.0.1:54321' } }
}));
import { enableBackgroundRecovery } from '../apps/web/src/api/recovery';
afterEach(() => {
  fake.request.mockReset();
  fake.body.mockReset();
  fake.entitlement.mockReset();
  fake.invoke.mockReset();
  localStorage.clear();
});
it.each([
  {},
  { capabilities: ['team-background-recovery'] },
  { capabilities: ['team-background-recovery-actor-bound'] },
  { capabilities: ['team-background-recovery', 'team-background-recovery-actor-bound'] }
])(
  'requires the complete native setup capability before issuing any account token or enrollment',
  async health => {
    fake.request.mockResolvedValue(health);
    await expect(enableBackgroundRecovery('synthetic-team')).rejects.toThrow(
      'AGENT_UPDATE_REQUIRED'
    );
    expect(fake.request).toHaveBeenCalledExactlyOnceWith('/api/health');
    expect(fake.entitlement).not.toHaveBeenCalled();
    expect(fake.body).not.toHaveBeenCalled();
  }
);

it('allows complete updated setup in health, identity, enrollment and confirmation order', async () => {
  const id = '34000000-0000-4000-8000-000000000001';
  const order: string[] = [];
  const status = { enabled: true, installationId: id, state: 'ready', reason: null };
  fake.request.mockImplementation(async (path: string) => {
    if (path === '/api/health') {
      order.push('health');
      return {
        entitlementRevision: id,
        capabilities: ['team-background-recovery', 'team-background-recovery-actor-bound']
      };
    }
    order.push('status');
    return status;
  });
  fake.entitlement.mockImplementation(async () => {
    order.push('identity');
  });
  fake.body.mockImplementation(async (path: string) => {
    if (path.endsWith('/enroll')) {
      order.push('enroll');
      return { enrollmentId: id, installationId: id, ticketDigest: 'a'.repeat(64) };
    }
    order.push('confirm');
    return { enabled: true };
  });
  fake.invoke.mockImplementation(async () => {
    order.push('delegate');
    return { challengeId: id };
  });
  expect(await enableBackgroundRecovery(id)).toEqual(status);
  expect(order).toEqual(['health', 'identity', 'enroll', 'delegate', 'confirm', 'status']);
});
