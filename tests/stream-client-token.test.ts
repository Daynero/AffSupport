// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fake transport the tests drive by hand: every connection is recorded with the token
 * it carried, and the test decides how each one ends.
 */
const transport = vi.hoisted(() => ({
  calls: [] as Array<{
    token: string;
    signal: AbortSignal;
    open: () => void;
    frame: (channel: string, event: unknown) => void;
    named: (name: string) => void;
    end: (error?: unknown) => void;
    activity: () => void;
  }>
}));

vi.mock('../apps/web/src/api/event-stream.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/event-stream.js')>();
  return {
    ...actual,
    readEventStream: (options: {
      token: string;
      signal: AbortSignal;
      onOpen?: () => void;
      onFrame: (frame: { channel: string; event: unknown }) => void;
      onNamedEvent?: (name: string, data: string) => void;
      onActivity?: () => void;
    }) =>
      new Promise<void>((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        transport.calls.push({
          token: options.token,
          signal: options.signal,
          open: () => options.onOpen?.(),
          frame: (channel, event) => options.onFrame({ channel, event }),
          named: name => options.onNamedEvent?.(name, '{}'),
          end: error => (error ? reject(error) : resolve()),
          activity: () => options.onActivity?.()
        });
      })
  };
});

import { StreamRefusedError } from '../apps/web/src/api/event-stream.js';
import { streamClient, type StreamStatus } from '../apps/web/src/api/stream-client.js';

const AGENT = 'http://127.0.0.1:4';

describe('the shared stream and the pairing token (032 FR-006/FR-007)', () => {
  let token = 'first';
  const statuses: StreamStatus[] = [];
  let unwatch = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    transport.calls.length = 0;
    statuses.length = 0;
    token = 'first';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    unwatch = streamClient.watchConnection(status => statuses.push(status));
    streamClient.configure({ agentUrl: AGENT, token: () => token, heartbeatMs: 15_000 });
  });

  afterEach(() => {
    unwatch();
    streamClient.configure(null);
    streamClient.close();
    vi.useRealTimers();
  });

  it('reads the token at every connection, not once at configuration', async () => {
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls.map(call => call.token)).toEqual(['first']);

    // The local app restarted with a new token and the page re-paired. Nothing
    // reconfigured the client; the next connection must still carry the new one.
    token = 'second';
    transport.calls[0].end(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(600);
    expect(transport.calls.map(call => call.token)).toEqual(['first', 'second']);
    unsubscribe();
  });

  it('restarts at once when told the token changed, dropping any pending backoff', async () => {
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[0].end(new Error('socket closed'));
    // Inside the first backoff: no reconnect yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.calls).toHaveLength(1);

    token = 'second';
    streamClient.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].token).toBe('second');
    unsubscribe();
  });

  it('stops retrying a rejected token and tells the owner why', async () => {
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[0].end(new StreamRefusedError(401));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ open: false, reason: 'unauthorized' });

    // Retrying a 401 every half second is how a stale tab exhausts the agent's auth
    // budget for every other tab. The owner re-pairs and restarts; nobody else does.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.calls).toHaveLength(1);
    unsubscribe();
  });

  it('classifies a refused entitlement and a rate limit differently', async () => {
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[0].end(new StreamRefusedError(403));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ open: false, reason: 'forbidden' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.calls).toHaveLength(1);

    streamClient.restart();
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[1].end(new StreamRefusedError(429));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ open: false, reason: 'throttled' });
    // Throttled is retried, but not quickly.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(transport.calls).toHaveLength(3);
    unsubscribe();
  });

  it('reports open and closed with the reason, and ignores its own aborts', async () => {
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[0].open();
    expect(statuses.at(-1)).toEqual({ open: true });
    expect(streamClient.isOpen()).toBe(true);

    transport.calls[0].end();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ open: false, reason: 'closed' });
    expect(streamClient.isOpen()).toBe(false);

    // A restart aborts the connection it owns; that is not a loss anyone should hear about.
    await vi.advanceTimersByTimeAsync(600);
    const before = statuses.length;
    streamClient.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.length).toBe(before);
    unsubscribe();
  });
});

describe('a client the agent replaced (032 A5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transport.calls.length = 0;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    streamClient.configure({ agentUrl: AGENT, token: () => 't' });
  });

  afterEach(() => {
    streamClient.configure(null);
    streamClient.close();
    vi.useRealTimers();
  });

  it('waits before reconnecting instead of evicting the client that evicted it', async () => {
    const statuses: StreamStatus[] = [];
    const unwatch = streamClient.watchConnection(status => statuses.push(status));
    const unsubscribe = streamClient.subscribe('compressor', () => {});
    await vi.advanceTimersByTimeAsync(0);
    transport.calls[0].open();
    transport.calls[0].named('replaced');
    transport.calls[0].end();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ open: false, reason: 'replaced' });

    // Not at 500 ms, like an ordinary drop, but after the longer schedule.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(transport.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(transport.calls).toHaveLength(2);
    unwatch();
    unsubscribe();
  });
});
