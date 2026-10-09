import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readEventStream,
  StreamIdleError,
  StreamRefusedError,
  type StreamFrame
} from '../apps/web/src/api/event-stream.js';
import { idleBudgetMs } from '../apps/web/src/api/stream-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * A body that delivers what the test enqueues and otherwise stays silent, like a dead socket.
 *
 * A real `fetch` fails the pending read when its signal aborts; a hand-made stream does not,
 * so the fake fetch wires that up itself.
 */
function silentBody() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
  return {
    response,
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        try {
          controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          /* already closed */
        }
      });
      return response;
    }),
    write: (text: string) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close()
  };
}

describe('the stream watchdog (032 FR-003)', () => {
  it('derives its budget from the agent heartbeat', () => {
    expect(idleBudgetMs(15_000)).toBe(35_000);
    expect(idleBudgetMs(5_000)).toBe(15_000);
  });

  it('gives up on a connection that goes quiet for longer than the budget', async () => {
    vi.useFakeTimers();
    const body = silentBody();
    vi.stubGlobal('fetch', body.fetch);
    const frames: StreamFrame[] = [];
    const activity = vi.fn();
    const reading = readEventStream({
      url: 'http://127.0.0.1:43120/api/stream',
      token: 't',
      signal: new AbortController().signal,
      idleMs: 1_000,
      onActivity: activity,
      onFrame: frame => frames.push(frame)
    });
    const failure = reading.catch(error => error);
    await vi.advanceTimersByTimeAsync(0);

    // Heartbeats keep it alive: each one re-arms the timer.
    body.write(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(800);
    body.write(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(800);
    body.write('data: {"channel":"compressor","event":1}\n\n');
    await vi.advanceTimersByTimeAsync(800);
    expect(activity).toHaveBeenCalledTimes(3);
    expect(frames).toEqual([{ channel: 'compressor', event: 1 }]);

    // Then silence. A socket the OS tore down under the browser looks exactly like
    // this: no error, no end, no bytes.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await failure).toBeInstanceOf(StreamIdleError);
  });

  it('tells a refused stream apart from a dead one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Invalid session token."}', { status: 401 }))
    );
    await expect(
      readEventStream({
        url: 'http://127.0.0.1:43120/api/stream',
        token: 't',
        signal: new AbortController().signal,
        onFrame: () => {}
      })
    ).rejects.toMatchObject({ name: 'StreamRefusedError', status: 401 });
    expect(new StreamRefusedError(403).status).toBe(403);
  });

  it('delivers named events to their own handler, never as a channel frame', async () => {
    const body = silentBody();
    vi.stubGlobal('fetch', body.fetch);
    const frames: StreamFrame[] = [];
    const named: string[] = [];
    const reading = readEventStream({
      url: 'http://127.0.0.1:43120/api/stream',
      token: 't',
      signal: new AbortController().signal,
      onFrame: frame => frames.push(frame),
      onNamedEvent: name => named.push(name)
    });
    body.write('event: replaced\ndata: {}\n\n');
    body.write('event: shutdown\ndata: {"reason":"update"}\n\n');
    body.write('data: {"channel":"power","event":{"limit":100}}\n\n');
    body.close();
    await reading;
    expect(named).toEqual(['replaced', 'shutdown']);
    expect(frames).toEqual([{ channel: 'power', event: { limit: 100 } }]);
  });

  it('honours the caller abort as an abort, not as idleness', async () => {
    vi.useFakeTimers();
    const body = silentBody();
    vi.stubGlobal('fetch', body.fetch);
    const controller = new AbortController();
    const reading = readEventStream({
      url: 'http://127.0.0.1:43120/api/stream',
      token: 't',
      signal: controller.signal,
      idleMs: 5_000,
      onFrame: () => {}
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const error = await reading;
    expect(error).not.toBeInstanceOf(StreamIdleError);
  });
});
