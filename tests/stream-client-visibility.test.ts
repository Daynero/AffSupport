// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; signal: AbortSignal }>
}));

vi.mock('../apps/web/src/api/event-stream.js', () => ({
  streamUrl: (agentUrl: string, channels: readonly string[]) =>
    `${agentUrl}/api/stream?channels=${channels.join(',')}`,
  readEventStream: (options: { url: string; signal: AbortSignal; onOpen?: () => void }) => {
    transport.calls.push({ url: options.url, signal: options.signal });
    options.onOpen?.();
    // A stream that stays open until it is aborted, like the real one.
    return new Promise<void>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}));

import { streamClient } from '../apps/web/src/api/stream-client.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * The browser allows six connections to the local app across every tab. A tab left open in
 * the background used to hold one forever, and six of them starved the tab being looked at.
 */
describe('stream client and hidden tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transport.calls.length = 0;
    setVisibility('visible');
    streamClient.configure({ agentUrl: 'http://127.0.0.1:4', token: 't' });
  });

  afterEach(() => {
    streamClient.configure(null);
    streamClient.close();
    vi.useRealTimers();
  });

  it('gives the socket back after a minute hidden and takes it again when looked at', async () => {
    const unsubscribe = streamClient.subscribe('queue', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(1);
    const first = transport.calls[0];

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(first.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.signal.aborted).toBe(true);
    // Parked, not dropped: no reconnect attempts while the tab stays hidden.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.calls).toHaveLength(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].url).toContain('channels=queue');
    unsubscribe();
  });

  it('keeps the socket through a quick switch away and back', async () => {
    const unsubscribe = streamClient.subscribe('power', () => {});
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].signal.aborted).toBe(false);
    unsubscribe();
  });
});
