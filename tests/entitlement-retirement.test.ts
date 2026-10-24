// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../apps/web/src/api/client', () => ({
  requestBody: (...args: unknown[]) => calls.request(...args)
}));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  calls.request.mockReset();
  vi.restoreAllMocks();
});
async function module() {
  return import('../apps/web/src/api/entitlement-retirement');
}
describe('browser durable native retirement', () => {
  it('retains an offline logout across module restart and retries before identity publication', async () => {
    const api = await module();
    calls.request.mockRejectedValue(new Error('offline'));
    expect(await api.retireAgentActor(A)).toBe('pending');
    expect(localStorage.getItem(api.RETIREMENT_PREFIX + A)).not.toBeNull();
    vi.resetModules();
    const restarted = await module();
    calls.request.mockResolvedValue({ cleared: true });
    const publish = vi.fn(async () => 'published');
    expect(await restarted.publishAgentIdentity(restarted.agentIdentityRevision(), publish)).toBe(
      'published'
    );
    expect(calls.request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      '/api/entitlement/logout',
      { actorId: A }
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(localStorage.getItem(api.RETIREMENT_PREFIX + A)).toBeNull();
  });
  it('refuses token publication from an exchange started before logout', async () => {
    const api = await module();
    const revision = api.agentIdentityRevision();
    calls.request.mockResolvedValue({ cleared: true });
    await api.retireAgentActor(A);
    const publish = vi.fn();
    await expect(api.publishAgentIdentity(revision, publish)).rejects.toThrow(
      'ENTITLEMENT_SIGNIN_REQUIRED'
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it('does not lose a newer same-actor logout while the first acknowledgement is pending', async () => {
    const api = await module();
    let resolve!: (value: unknown) => void;
    calls.request.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const first = api.retireAgentActor(A);
    await vi.waitFor(() => expect(calls.request).toHaveBeenCalledOnce());
    calls.request.mockRejectedValue(new Error('offline'));
    const second = api.retireAgentActor(A);
    resolve({ cleared: true });
    await first;
    expect(await second).toBe('pending');
    expect(localStorage.getItem(api.RETIREMENT_PREFIX + A)).not.toBeNull();
  });
  it('keeps other actor intents and blocks publication while retirement is unconfirmed', async () => {
    const api = await module();
    calls.request.mockRejectedValue(new Error('offline'));
    await api.retireAgentActor(A);
    await api.retireAgentActor(B);
    const publish = vi.fn();
    await expect(api.publishAgentIdentity(api.agentIdentityRevision(), publish)).rejects.toThrow(
      'ENTITLEMENT_UNAVAILABLE'
    );
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem(api.RETIREMENT_PREFIX + A)).not.toBeNull();
    expect(localStorage.getItem(api.RETIREMENT_PREFIX + B)).not.toBeNull();
  });
  it('does not report an unpersisted offline intent as durable', async () => {
    const api = await module();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    calls.request.mockRejectedValue(new Error('offline'));
    expect(await api.retireAgentActor(A)).toBe('unrecorded');
  });
});
