import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { SAFE_LOGGER } from '../apps/agent/src/server/app.js';

/**
 * What the local app writes about itself has to be safe to hand over.
 *
 * A log is the thing a user attaches to a bug report, a support thread, or a
 * screenshot — deliberately, and without reading every line first. Anything in
 * it is effectively published. Three kinds of thing must therefore never reach
 * it: the session token, a full URL (which carries ids and now capability
 * tickets in its query), and an absolute path from the user's own disk.
 *
 * The serializer and redaction list live in `buildServer`; this asserts the
 * shape they produce, using the same pino configuration rather than a
 * re-description of it, so a change to one is visible here.
 */

const TOKEN = 'a'.repeat(64);
const TICKET = `${Date.now() + 60_000}.${'B'.repeat(43)}`;

/** Builds a server with the production logger config, capturing every line. */
async function captureLog() {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      // The real configuration, imported rather than restated: a test that
      // re-describes the thing it is guarding passes forever after the guard is
      // removed.
      ...SAFE_LOGGER,
      stream: {
        write(line: string) {
          lines.push(line);
        }
      }
    }
  });

  app.get('/api/images/:id/content', async () => ({ ok: true }));
  app.get('/pair', async (_request, reply) =>
    reply.redirect(`https://example.test/#agentToken=${TOKEN}`)
  );
  await app.ready();
  return { app, lines };
}

describe('what reaches the log', () => {
  it('never contains the session token, however it arrived', async () => {
    const { app, lines } = await captureLog();
    await app.inject({
      method: 'GET',
      url: `/api/images/holiday/content?token=${TOKEN}`,
      headers: { 'x-session-token': TOKEN }
    });
    await app.close();

    const written = lines.join('\n');
    expect(written).not.toContain(TOKEN);
  });

  it('never contains a capability ticket', async () => {
    const { app, lines } = await captureLog();
    // Tickets are short-lived, but five minutes is long enough for a log to be
    // pasted somewhere, and a ticket is a working credential for its resource.
    await app.inject({ method: 'GET', url: `/api/images/holiday/content?ticket=${TICKET}` });
    await app.close();

    expect(lines.join('\n')).not.toContain(TICKET);
  });

  it('records the route pattern rather than the URL', async () => {
    const { app, lines } = await captureLog();
    await app.inject({ method: 'GET', url: '/api/images/a-private-file-name/content?token=x' });
    await app.close();

    const written = lines.join('\n');
    // The pattern is more useful for diagnostics than a raw URL anyway, and it
    // cannot carry an id, a filename or a query.
    expect(written).toContain('/api/images/:id/content');
    expect(written).not.toContain('a-private-file-name');
  });

  it('never contains the pairing redirect that carries the token', async () => {
    const { app, lines } = await captureLog();
    await app.inject({ method: 'GET', url: '/pair' });
    await app.close();

    // The Location header on /pair is the one response header that is a
    // credential.
    expect(lines.join('\n')).not.toContain('agentToken');
  });

  it('never contains an absolute path from the user disk', async () => {
    const { app, lines } = await captureLog();
    const home = '/Users/example/Movies/private holiday.mov';
    await app.inject({
      method: 'GET',
      url: `/api/images/x/content?path=${encodeURIComponent(home)}`
    });
    await app.close();

    expect(lines.join('\n')).not.toContain('private holiday');
  });
});
