import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eventStreamHeaders } from '../http.js';
import type { ChannelHub } from './sse.js';

/**
 * One connection carrying every channel the client asked for.
 *
 * The interface used to hold seven server-sent-event connections at once — one per tool.
 * Seven sockets, seven reconnect timers, and seven independent opinions about whether the
 * local app is reachable, which is why a brief interruption could leave one page saying
 * "connected" and another offering to install the application.
 *
 * The seven endpoints stay in this release. A client that does not see the `event-stream`
 * capability keeps using them, and nothing has to be upgraded in lockstep.
 */

export interface StreamContext {
  hub: ChannelHub;
  allowedOrigins: ReadonlySet<string>;
}

/** At most this many channel names in one request, so a URL cannot become a workload. */
const MAX_CHANNELS = 16;

function requestedChannels(raw: unknown, hub: ChannelHub): string[] {
  // A repeated query parameter arrives as an array. Reading `String(raw)` on one would
  // produce a comma-joined string that happens to parse, which is the kind of accident that
  // makes a guard look like it works.
  const value = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  const known = new Set(hub.channels());
  const asked = value
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .slice(0, MAX_CHANNELS);
  // No `channels` at all means every channel: the ordinary case for the interface, and one
  // fewer thing for a client to keep in step with the agent.
  const selected = asked.length > 0 ? asked : [...known];
  return [...new Set(selected.filter(name => known.has(name)))];
}

export function registerStreamRoutes(app: FastifyInstance, ctx: StreamContext): void {
  const { hub, allowedOrigins } = ctx;

  app.get<{ Querystring: { channels?: unknown } }>(
    '/api/stream',
    async (
      request: FastifyRequest<{ Querystring: { channels?: unknown } }>,
      reply: FastifyReply
    ) => {
      const channels = requestedChannels(request.query?.channels, hub);
      if (channels.length === 0) {
        return reply.code(400).send({ error: 'NO_SUCH_CHANNEL' });
      }

      // `hijack` bypasses Fastify's send hook, which is where the cross-origin headers are
      // normally attached — so this response has to carry its own or a browser discards
      // every frame without telling anyone why.
      reply.hijack();
      reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, allowedOrigins));

      const detach = hub.subscribe(reply.raw, channels);
      request.raw.on('close', detach);
      return reply;
    }
  );
}
