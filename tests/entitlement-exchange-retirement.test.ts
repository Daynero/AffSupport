// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  invoke: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
  revision: vi.fn()
}));
vi.mock('../apps/web/src/api/client', () => ({
  entitlementPublicationRevision: (...args: unknown[]) => calls.revision(...args),
  submitEntitlementToken: (...args: unknown[]) => calls.submit(...args),
  requestBody: (...args: unknown[]) => calls.request(...args)
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({
    functions: { invoke: (...args: unknown[]) => calls.invoke(...args) }
  })
}));
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  calls.invoke.mockReset();
  calls.submit.mockReset();
  calls.request.mockReset();
  calls.revision.mockReset();
  calls.revision.mockResolvedValue(A);
  calls.submit.mockResolvedValue({ entitled: true });
});
const A = '11111111-1111-4111-8111-111111111111';
it('does not publish the late signed token from an exchange that overlapped logout', async () => {
  const { ensureAgentEntitlement } = await import('../apps/web/src/api/entitlement');
  const { retireAgentActor } = await import('../apps/web/src/api/entitlement-retirement');
  let resolve!: (value: unknown) => void;
  calls.invoke.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  const exchange = ensureAgentEntitlement();
  const verdict = expect(exchange).rejects.toThrow('ENTITLEMENT_SIGNIN_REQUIRED');
  calls.request.mockResolvedValue({ cleared: true });
  await vi.waitFor(() => expect(calls.invoke).toHaveBeenCalledOnce());
  await retireAgentActor(A);
  resolve({ data: { token: 'synthetic-signed-token' }, error: null });
  await verdict;
  expect(calls.submit).not.toHaveBeenCalled();
});
it('keeps a fresh exchange blocked by an unacknowledged older native retirement', async () => {
  const { ensureAgentEntitlement } = await import('../apps/web/src/api/entitlement');
  const { retireAgentActor } = await import('../apps/web/src/api/entitlement-retirement');
  calls.request.mockRejectedValue(new Error('offline'));
  await retireAgentActor(A);
  calls.invoke.mockResolvedValue({ data: { token: 'synthetic-signed-token' }, error: null });
  await expect(ensureAgentEntitlement()).rejects.toThrow('ENTITLEMENT_UNAVAILABLE');
  expect(calls.submit).not.toHaveBeenCalled();
  calls.request.mockResolvedValue({ cleared: false });
  await expect(ensureAgentEntitlement()).resolves.toEqual({ entitled: true });
  expect(calls.submit).toHaveBeenCalledExactlyOnceWith(
    'synthetic-signed-token',
    A,
    expect.any(AbortSignal)
  );
});

it('captures the native publication fence before the cloud exchange and sends it with the token', async () => {
  const { ensureAgentEntitlement } = await import('../apps/web/src/api/entitlement');
  const order: string[] = [];
  calls.revision.mockImplementation(async () => {
    order.push('native');
    return A;
  });
  calls.invoke.mockImplementation(async () => {
    order.push('cloud');
    return { data: { token: 'synthetic-signed-token' }, error: null };
  });
  calls.submit.mockImplementation(async (_token, revision) => {
    order.push('publish');
    expect(revision).toBe(A);
    return { entitled: true };
  });
  await ensureAgentEntitlement();
  expect(order).toEqual(['native', 'cloud', 'publish']);
});

it('does not retry a refused publication under a fresh revision with the old signed token', async () => {
  const { ensureAgentEntitlement } = await import('../apps/web/src/api/entitlement');
  calls.invoke.mockResolvedValue({ data: { token: 'synthetic-signed-token' }, error: null });
  calls.submit.mockRejectedValue(new Error('ENTITLEMENT_TOKEN_INVALID'));
  await expect(ensureAgentEntitlement()).rejects.toThrow('ENTITLEMENT_UNAVAILABLE');
  expect(calls.revision).toHaveBeenCalledOnce();
  expect(calls.invoke).toHaveBeenCalledOnce();
  expect(calls.submit).toHaveBeenCalledOnce();
});
it('bounds the native preflight before cloud issuance within the exchange deadline', async () => {
  const { ensureAgentEntitlement } = await import('../apps/web/src/api/entitlement');
  vi.useFakeTimers();
  try {
    calls.revision.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('TIMEOUT')), { once: true });
        })
    );
    const result = ensureAgentEntitlement();
    const verdict = expect(result).rejects.toThrow('ENTITLEMENT_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(6_000);
    await verdict;
    expect(calls.invoke).not.toHaveBeenCalled();
    expect(calls.submit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
