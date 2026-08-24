import { expect, it } from 'vitest';
import { readEventStream } from '../apps/web/src/api/event-stream.js';
import { bootAgent, type AgentProcess } from './support/agent-process.js';
import { describeRequiring, requirePath } from './support/requires.js';
import { waitFor } from './support/wait.js';

/**
 * The multiplexed stream, end to end: the real agent, the real reader.
 *
 * `tests/stream-multiplex.test.ts` drives the fan-out directly, which is where the caps and
 * the sampling lifecycle are checked. What that cannot cover is the part this replaces — the
 * transport. Seven per-tool connections each carried the session token as a **query
 * parameter**, and a query parameter lands in server logs, in a `Referer`, and in whatever
 * the browser remembers about the page. Proving that the header-authenticated route works,
 * and that the same request without the header is refused, is the whole reason the transport
 * changed.
 */

const builtAgent = requirePath('apps/agent/dist/index.js');

async function channelsSeen(agent: AgentProcess, channels: string[], forMs: number) {
  const seen = new Set<string>();
  const abort = new AbortController();
  const reading = readEventStream({
    url: `${agent.origin}/api/stream?channels=${channels.join(',')}`,
    token: agent.token,
    signal: abort.signal,
    onFrame: frame => seen.add(frame.channel)
  }).catch(() => {
    // Aborting the read is how this ends; the frames collected before it are the result.
  });

  await waitFor(() => channels.every(channel => seen.has(channel)), {
    timeoutMs: forMs,
    intervalMs: 50,
    describe: `frames for ${channels.join(', ')}`
  }).catch(() => {});
  abort.abort();
  await reading;
  return seen;
}

describeRequiring(builtAgent, 'the multiplexed live-update stream', () => {
  it('replays every requested channel to a reader that authenticates by header', async () => {
    const agent = await bootAgent();
    try {
      // Advertised, not assumed. A client that does not see this keeps its seven
      // connections, which is what lets the two halves ship independently.
      const health = (await agent.api('/api/health')) as { capabilities: string[] };
      expect(health.capabilities).toContain('event-stream');

      expect([...(await channelsSeen(agent, ['compressor', 'power'], 10_000))].sort()).toEqual([
        'compressor',
        'power'
      ]);
    } finally {
      await agent.stop();
    }
  }, 120_000);

  it('refuses a reader that does not present the token', async () => {
    const agent = await bootAgent();
    try {
      // The point of moving the token out of the URL is that the URL is no longer a
      // credential. If it still were, this would succeed.
      const anonymous = await fetch(`${agent.origin}/api/stream?channels=compressor`);
      expect(anonymous.status).toBe(401);
    } finally {
      await agent.stop();
    }
  }, 120_000);

  it('refuses a channel nothing publishes rather than opening an empty stream', async () => {
    const agent = await bootAgent();
    try {
      const response = await agent.request('/api/stream?channels=not-a-channel');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'NO_SUCH_CHANNEL' });
    } finally {
      await agent.stop();
    }
  }, 120_000);
});
