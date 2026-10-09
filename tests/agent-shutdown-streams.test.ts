import { afterEach, describe, expect, it } from 'vitest';
import { EventChannel } from '../apps/agent/src/server/sse.js';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent.js';
import { waitFor } from './support/wait.js';

/**
 * Shutdown with streams open: the real Fastify app on a real port, a real reader.
 *
 * `server.close()` waits for every connection to end, and a server-sent-events response
 * is a connection that never ends on its own. The agent's shutdown used to await that
 * close with the streams still open (032 A1): the process sat on a port it no longer
 * answered, heartbeating "connected" at an interface showing frozen state, and the
 * launcher never saw an exit code. The fix is to tell every stream why and end it before
 * close is called — and that is what is checked here, from the client's side of the
 * socket.
 */

const SHUTDOWN_FRAME = (reason: string) => `event: shutdown\ndata: {"reason":"${reason}"}\n\n`;

/** Reads a stream to its end, exposing what arrived so far and whether the body ended. */
function drain(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state = { received: '', ended: false, failed: null as unknown };
  const finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.received += decoder.decode(value, { stream: true });
      }
      state.ended = true;
    } catch (error) {
      state.failed = error;
    }
  })();
  return { state, finished };
}

let agent: MinimalAgent | null = null;

afterEach(async () => {
  await agent?.stop();
  agent = null;
});

async function openStream(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${agent!.origin}${path}`, {
    headers: { 'x-session-token': agent!.token, ...headers }
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reading = drain(response);
  // The snapshot proves the subscriber is attached, not merely that the headers came back.
  await waitFor(() => reading.state.received.includes('data: '), {
    describe: `the snapshot on ${path}`
  });
  return reading;
}

describe('agent shutdown with streams open', () => {
  it('tells every open stream the reason, ends it, and lets the server close promptly', async () => {
    agent = await startMinimalAgent({ listen: true });
    const multiplexed = await openStream('/api/stream?channels=compressor');
    const legacy = await openStream('/api/events');

    const closeStarted = Date.now();
    agent.hub.closeAll('update');
    EventChannel.closeAll('update');
    await agent.app.close();
    const closeTook = Date.now() - closeStarted;

    // Well inside the entrypoint's hard deadline: close returned because the streams were
    // ended, not because a timer gave up on it.
    expect(closeTook).toBeLessThan(3000);

    await Promise.all([multiplexed.finished, legacy.finished]);
    for (const stream of [multiplexed, legacy]) {
      // A clean end of body, not a reset: the reader sees `done`, not an error.
      expect(stream.state.failed).toBeNull();
      expect(stream.state.ended).toBe(true);
      expect(stream.state.received.endsWith(SHUTDOWN_FRAME('update'))).toBe(true);
    }
  });

  it('is the streams, left open, that would otherwise hold close', async () => {
    // The premise, demonstrated rather than asserted in a comment. Without the goodbye
    // the server's close does not return while a stream is open — which is the whole
    // reason shutdown ends them first.
    agent = await startMinimalAgent({ listen: true });
    // `Connection: close` so the client drops the socket at end of body. Here close has
    // already swept idle connections once before the goodbye, so a pooled keep-alive socket
    // would otherwise sit until the client's own idle timeout — seconds of nothing.
    const stream = await openStream('/api/stream?channels=compressor', { connection: 'close' });

    let closed = false;
    const closing = agent.app.close().then(() => {
      closed = true;
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(closed).toBe(false);
    expect(stream.state.ended).toBe(false);

    agent.hub.closeAll('restart');
    await closing;
    await stream.finished;
    expect(closed).toBe(true);
    expect(stream.state.received.endsWith(SHUTDOWN_FRAME('restart'))).toBe(true);
  });

  it('a subscriber told goodbye is detached, so a later broadcast does not reach a dead socket', async () => {
    agent = await startMinimalAgent({ listen: true });
    const stream = await openStream('/api/stream?channels=compressor');
    agent.hub.closeAll('signal');
    await stream.finished;

    // Nothing to write to; must not throw back into the broadcaster either.
    expect(() => agent!.channel.broadcast({ type: 'state' })).not.toThrow();
    expect(agent.hub.hasListeners('compressor')).toBe(false);
  });
});
