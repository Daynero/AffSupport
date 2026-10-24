import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearSubresourceTickets,
  imageContentPath,
  landingPreviewPath,
  subresourceTicket,
  transcriptionMediaPath
} from '../apps/web/src/api/subresource-paths';
import { issueTicket, ticketAuthorises } from '../apps/agent/src/server/tickets';
import { onRequestFailure } from '../apps/web/src/api/request-failures';

const ORIGIN = 'http://127.0.0.1:43140';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let sequence = 0;
let resource: string;
const fetcher = vi.fn();
function response(secret = A) {
  return new Response(
    JSON.stringify({ ticket: issueTicket(secret, 'GET', resource), expiresInMs: 300_000 }),
    { headers: { 'content-type': 'application/json' } }
  );
}
beforeEach(() => {
  clearSubresourceTickets();
  resource = imageContentPath(`synthetic-${sequence++}`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
  fetcher.mockReset().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  clearSubresourceTickets();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('encodes each opaque resource ID as one path segment without importing a browser client', () => {
  expect(imageContentPath('a/b ?')).toBe('/api/images/a%2Fb%20%3F/content');
  expect(transcriptionMediaPath('a/b ?')).toBe('/api/transcription/jobs/a%2Fb%20%3F/media');
  expect(landingPreviewPath('job/one', 'asset?two', 'after')).toBe(
    '/api/landing/jobs/job%2Fone/assets/asset%3Ftwo/preview/after'
  );
});

it('coalesces one session request and refreshes at the early expiry boundary', async () => {
  fetcher.mockImplementation(async () => response());
  const first = subresourceTicket(ORIGIN, A, resource);
  const second = subresourceTicket(ORIGIN, A, resource);
  expect(second).toBe(first);
  const ticket = await first;
  expect(await second).toBe(ticket);
  expect(ticketAuthorises(A, 'GET', resource, ticket)).toBe(true);
  vi.setSystemTime(Date.now() + 239_999);
  expect(await subresourceTicket(ORIGIN, A, resource)).toBe(ticket);
  expect(fetcher).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 1);
  await subresourceTicket(ORIGIN, A, resource);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  { name: 'session', origin: ORIGIN, token: B },
  { name: 'agent origin', origin: 'http://127.0.0.1:43141', token: A }
])('mints fresh authority after changing the $name', async ({ origin, token }) => {
  fetcher.mockImplementation(async (_url: unknown, init: RequestInit) =>
    response((init.headers as Record<string, string>)['x-session-token'])
  );
  await subresourceTicket(ORIGIN, A, resource);
  const next = await subresourceTicket(origin, token, resource);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe(`${origin}/api/tickets`);
  expect(ticketAuthorises(token, 'GET', resource, next)).toBe(true);
});

it('discards a cleared in-flight reply without removing a newer pending request', async () => {
  const replies: Array<(value: Response) => void> = [];
  fetcher.mockImplementation(() => new Promise<Response>(resolve => replies.push(resolve)));
  const old = subresourceTicket(ORIGIN, A, resource);
  clearSubresourceTickets();
  const next = subresourceTicket(ORIGIN, B, resource);
  replies[0](response(A));
  const oldValue = await old;
  const again = subresourceTicket(ORIGIN, B, resource);
  replies[1]?.(response(B));
  const [nextValue, againValue] = await Promise.all([next, again]);
  expect(oldValue).toBeNull();
  expect(again).toBe(next);
  expect(nextValue).toBe(againValue);
  expect(ticketAuthorises(B, 'GET', resource, nextValue)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('fences a body that arrives after another session has already requested the resource', async () => {
  let finish: (body: unknown) => void = () => {};
  const json = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json }).mockResolvedValueOnce(response(B));
  const old = subresourceTicket(ORIGIN, A, resource);
  await Promise.resolve();
  expect(json).toHaveBeenCalledOnce();
  clearSubresourceTickets();
  const next = subresourceTicket(ORIGIN, B, resource);
  finish({ ticket: issueTicket(A, 'GET', resource), expiresInMs: 300_000 });
  const [oldValue, nextValue] = await Promise.all([old, next]);
  expect(oldValue).toBeNull();
  expect(ticketAuthorises(B, 'GET', resource, nextValue)).toBe(true);
});

it.each([401, 403, 500])('does not cache an HTTP %i refusal', async status => {
  const observed = vi.fn();
  const stop = onRequestFailure(observed);
  try {
    fetcher.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(response());
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeNull();
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls).toEqual(
      status === 401 ? [['unauthorized']] : status === 403 ? [['forbidden']] : []
    );
  } finally {
    stop();
  }
});

it('keeps malformed and unavailable responses distinct from a usable ticket', async () => {
  const observed = vi.fn();
  const stop = onRequestFailure(observed);
  try {
    fetcher
      .mockResolvedValueOnce(new Response('{broken'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: 12 })))
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ticket: 'synthetic-default-lifetime' }))
      );
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeNull();
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeNull();
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeNull();
    expect(await subresourceTicket(ORIGIN, A, resource)).toBe('synthetic-default-lifetime');
    expect(observed.mock.calls).toEqual([['connection_failed']]);
  } finally {
    stop();
  }
});

it('does not report a superseded connection failure against the replacement session', async () => {
  let reject: (error: Error) => void = () => {};
  fetcher
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    )
    .mockResolvedValueOnce(response(B));
  const observed = vi.fn();
  const stop = onRequestFailure(observed);
  try {
    const old = subresourceTicket(ORIGIN, A, resource);
    const next = subresourceTicket(ORIGIN, B, resource);
    expect(ticketAuthorises(B, 'GET', resource, await next)).toBe(true);
    reject(new Error('synthetic old connection failure'));
    expect(await old).toBeNull();
    expect(observed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it('isolates diagnostic listener failures and honors unsubscribe', async () => {
  const broken = onRequestFailure(() => {
    throw new Error('synthetic observer failure');
  });
  const observed = vi.fn();
  const stop = onRequestFailure(observed);
  const removed = vi.fn();
  onRequestFailure(removed)();
  try {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await subresourceTicket(ORIGIN, A, resource)).toBeNull();
    expect(observed.mock.calls).toEqual([['unauthorized']]);
    expect(removed).not.toHaveBeenCalled();
  } finally {
    broken();
    stop();
  }
});
