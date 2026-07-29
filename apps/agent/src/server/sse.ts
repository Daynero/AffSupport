import type { FastifyReply, FastifyRequest } from 'fastify';
import { eventStreamHeaders } from '../http.js';

/**
 * One server-sent-events fan-out. Every tool (compressor, landing,
 * transcription) keeps its own channel: `broadcast` pushes an event to all
 * connected clients and `handler` serves the SSE endpoint, replaying the
 * current snapshot to a client the moment it connects.
 */
export class EventChannel<TEvent> {
  private readonly clients = new Set<NodeJS.WritableStream>();

  constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly snapshot: () => TEvent
  ) {}

  broadcast(event: TEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  /** Fastify route handler; bound so it can be passed to `app.get` directly. */
  handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, this.allowedOrigins));
    this.clients.add(reply.raw);
    reply.raw.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    request.raw.on('close', () => this.clients.delete(reply.raw));
  };
}
