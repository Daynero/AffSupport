// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { entitlementPublicationRevision, submitEntitlementToken } from '../apps/web/src/api/client';
const REVISION = '77777777-7777-4777-8777-777777777777';
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('agentToken', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('reads the paired fence and includes it unchanged in the native publication request', async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ entitlementRevision: REVISION })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ entitled: true })));
  vi.stubGlobal('fetch', fetcher);
  const revision = await entitlementPublicationRevision(controller.signal);
  expect(revision).toBe(REVISION);
  await submitEntitlementToken('synthetic-signed-token', revision, controller.signal);
  const [, read] = fetcher.mock.calls[0];
  const [url, write] = fetcher.mock.calls[1];
  expect(read.headers['x-session-token']).toBe('a'.repeat(64));
  expect(url).toMatch(/\/api\/entitlement$/u);
  expect(JSON.parse(write.body)).toEqual({ token: 'synthetic-signed-token', revision: REVISION });
  expect(write.signal).toBe(controller.signal);
});
it('keeps legacy entitlement exchange compatible without pretending actor-bound recovery is supported', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const revision = await entitlementPublicationRevision();
  expect(revision).toBeNull();
  await submitEntitlementToken('synthetic-signed-token', revision);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ token: 'synthetic-signed-token' });
});
it('requires upgrade for an actor-bound agent that cannot fence publication', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ capabilities: ['team-background-recovery-actor-bound'] }))
      )
  );
  await expect(entitlementPublicationRevision()).rejects.toThrow('AGENT_UPDATE_REQUIRED');
});
it('rejects malformed revision metadata', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ entitlementRevision: {} })))
  );
  await expect(entitlementPublicationRevision()).rejects.toThrow('INVALID_RESPONSE');
});
it('never fetches a publication fence without pairing', async () => {
  localStorage.clear();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(entitlementPublicationRevision()).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
