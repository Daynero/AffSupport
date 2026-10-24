// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSubresourceUrl } from '../apps/web/src/api/useSubresourceUrl';
import { clearSubresourceTickets } from '../apps/web/src/api/subresource-paths';
import { issueTicket, ticketAuthorises } from '../apps/agent/src/server/tickets';

const state = vi.hoisted(() => ({
  token: 'a'.repeat(64),
  listeners: new Set<() => void>(),
  failRead: false,
  failSubscribe: false
}));
vi.mock('../apps/web/src/api/client', () => ({ agentUrl: 'http://127.0.0.1:43140' }));
vi.mock('../apps/web/src/api/pairing-token', () => ({
  pairingToken: () => {
    if (state.failRead) throw new Error('synthetic token reader unavailable');
    return state.token;
  },
  onPairingToken: (listener: () => void) => {
    if (state.failSubscribe) throw new Error('synthetic subscription unavailable');
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }
}));
const A = 'a'.repeat(64),
  B = 'b'.repeat(64),
  RESOURCE = '/api/images/synthetic-repair/content';
function response(secret: string) {
  return new Response(
    JSON.stringify({ ticket: issueTicket(secret, 'GET', RESOURCE), expiresInMs: 300_000 })
  );
}
function validFor(secret: string, url: string | null | undefined) {
  return (
    typeof url === 'string' &&
    ticketAuthorises(secret, 'GET', RESOURCE, new URL(url).searchParams.get('ticket'))
  );
}
function replaceToken() {
  state.token = B;
  for (const listener of state.listeners) listener();
}
beforeEach(() => {
  state.token = A;
  state.failRead = false;
  state.failSubscribe = false;
  clearSubresourceTickets();
});
afterEach(() => {
  cleanup();
  state.listeners.clear();
  clearSubresourceTickets();
  vi.unstubAllGlobals();
});

it('refreshes a mounted resource URL after pairing changes without remounting the view', async () => {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) =>
    response((init.headers as Record<string, string>)['x-session-token'])
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() => useSubresourceUrl(RESOURCE));
  await waitFor(() => expect(validFor(A, view.result.current)).toBe(true));
  expect(state.listeners.size).toBe(1);
  act(replaceToken);
  await waitFor(() => expect(validFor(B, view.result.current)).toBe(true));
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(state.listeners.size).toBe(0);
});

it('does not let an older completion erase the repaired URL and unsubscribes on unmount', async () => {
  let finish: (value: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          finish = resolve;
        })
    )
    .mockResolvedValueOnce(response(B));
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() => useSubresourceUrl(RESOURCE));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(state.listeners.size).toBe(1);
  act(replaceToken);
  await waitFor(() => expect(validFor(B, view.result.current)).toBe(true));
  await act(async () => {
    finish(response(A));
    await Promise.resolve();
  });
  expect(validFor(B, view.result.current)).toBe(true);
  view.unmount();
  expect(state.listeners.size).toBe(0);
});

it('does not subscribe or fetch after unmounting before the deferred setup completes', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(A));
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() => useSubresourceUrl(RESOURCE));
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.listeners.size).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['missing path', 'token reader', 'listener setup'])(
  'does not leave a pending URL when $0 is unavailable',
  async kind => {
    state.failRead = kind === 'token reader';
    state.failSubscribe = kind === 'listener setup';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const view = renderHook(() => useSubresourceUrl(kind === 'missing path' ? null : RESOURCE));
    await waitFor(() => expect(view.result.current).toBeNull());
    expect(fetcher).not.toHaveBeenCalled();
    view.unmount();
    expect(state.listeners.size).toBe(0);
  }
);
