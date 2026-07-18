export function eventStreamHeaders(origin: string | undefined, allowedOrigins: ReadonlySet<string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
  // reply.hijack() bypasses Fastify's normal onSend/CORS handling, so the SSE
  // response must carry the allowed origin itself.
  if (origin && allowedOrigins.has(origin)) {
    headers.Vary = 'Origin';
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
