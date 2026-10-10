import net from 'node:net';
import { outcome, type AdversarialSuite } from '../adversarial.js';
import { startMinimalAgent, type MinimalAgent } from '../minimal-agent.js';

/**
 * C4, C5, C6. Request admission against a real listening agent, over a real socket.
 *
 * A raw socket rather than `fetch`: the attacks worth testing are exactly the headers a
 * well-behaved client refuses to send — a foreign or duplicated `Host`, none at all — and the
 * point is what the server does with the bytes, not what a client library allows.
 */

const HOSTILE_ORIGIN = 'https://evil.example';

export interface AdmissionTarget {
  agent: MinimalAgent;
  port: number;
  /** Sends one raw HTTP/1.1 request and returns the status line's code and the body. */
  send(lines: string[]): Promise<{ status: number; headers: string; body: string }>;
  get(path: string, headers?: Record<string, string>): ReturnType<AdmissionTarget['send']>;
}

async function startAdmissionTarget(): Promise<AdmissionTarget & { stop(): Promise<void> }> {
  const agent = await startMinimalAgent({ listen: true });
  const port = Number(new URL(agent.origin).port);

  const send: AdmissionTarget['send'] = lines =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.setTimeout(5_000, () => socket.destroy(new Error('timed out')));
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('close', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const [head = '', ...rest] = raw.split('\r\n\r\n');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
        resolve({ status, headers: head, body: rest.join('\r\n\r\n') });
      });
      socket.write(`${[...lines, 'Connection: close'].join('\r\n')}\r\n\r\n`);
    });

  return {
    agent,
    port,
    send,
    get(path, headers = {}) {
      const all = { Host: `127.0.0.1:${port}`, ...headers };
      return send([
        `GET ${path} HTTP/1.1`,
        ...Object.entries(all).map(([name, value]) => `${name}: ${value}`)
      ]);
    },
    stop: () => agent.stop()
  };
}

/** Refused, and the response carries no session token anywhere — header or body. */
function refusedWithout(
  response: { status: number; headers: string; body: string },
  token: string,
  statuses: readonly number[]
) {
  const leaked = response.headers.includes(token) || response.body.includes(token);
  return outcome(
    statuses.includes(response.status) && !leaked,
    `${response.status}${leaked ? ' and the token was in the response' : ''}`
  );
}

export const admissionSuite: AdversarialSuite<AdmissionTarget> = {
  testFile: 'tests/agent-admission.test.ts',
  start: startAdmissionTarget,
  attempts: [
    {
      name: 'a spoofed Host on the health probe',
      attempt: async t =>
        refusedWithout(await t.get('/health', { Host: 'evil.example.com' }), t.agent.token, [403])
    },
    {
      name: 'a spoofed Host on /pair, which hands out the token',
      attempt: async t =>
        refusedWithout(await t.get('/pair', { Host: 'evil.example.com' }), t.agent.token, [403])
    },
    {
      name: 'a spoofed Host on /local, which also hands out the token',
      attempt: async t =>
        refusedWithout(await t.get('/local', { Host: 'evil.example.com' }), t.agent.token, [403])
    },
    {
      name: "a rebound Host that carries this machine's port",
      attempt: async t =>
        refusedWithout(
          await t.get('/pair', { Host: `evil.example.com:${t.port}` }),
          t.agent.token,
          [403]
        )
    },
    {
      name: 'two Host headers, the second hostile',
      attempt: async t =>
        refusedWithout(
          await t.send([
            'GET /pair HTTP/1.1',
            `Host: 127.0.0.1:${t.port}`,
            'Host: evil.example.com'
          ]),
          t.agent.token,
          // Node itself refuses a duplicate Host with 400 before the app sees it; either
          // answer is a refusal.
          [400, 403]
        )
    },
    {
      name: 'no Host header at all',
      attempt: async t =>
        refusedWithout(await t.send(['GET /pair HTTP/1.0']), t.agent.token, [400, 403])
    },
    {
      name: 'a hostile Origin carrying a valid token',
      attempt: async t =>
        refusedWithout(
          await t.get('/api/health', { Origin: HOSTILE_ORIGIN, 'X-Session-Token': t.agent.token }),
          t.agent.token,
          [403]
        )
    },
    {
      name: 'the opaque "null" Origin of a sandboxed frame, carrying a valid token',
      attempt: async t =>
        refusedWithout(
          await t.get('/api/health', { Origin: 'null', 'X-Session-Token': t.agent.token }),
          t.agent.token,
          [403]
        )
    },
    {
      name: 'an API call with no token',
      attempt: async t => refusedWithout(await t.get('/api/health'), t.agent.token, [401])
    },
    {
      name: 'an API call with a wrong token of the right length',
      attempt: async t =>
        refusedWithout(
          await t.get('/api/health', { 'X-Session-Token': 'x'.repeat(t.agent.token.length) }),
          t.agent.token,
          [401]
        )
    },
    {
      name: 'the token truncated by one character',
      attempt: async t =>
        refusedWithout(
          await t.get('/api/health', { 'X-Session-Token': t.agent.token.slice(0, -1) }),
          t.agent.token,
          [401]
        )
    },
    {
      name: 'a repeated token query parameter, which parses to an array',
      attempt: async t =>
        refusedWithout(
          await t.get(`/api/health?token=${t.agent.token}&token=${t.agent.token}`),
          t.agent.token,
          [401]
        )
    },
    {
      name: 'a percent-encoded /api prefix with no token',
      // The router decodes `%61` to `a`; the guard used to read the raw URL and let this
      // through to /api/diagnostics unauthenticated.
      attempt: async t =>
        refusedWithout(await t.get('/%61pi/diagnostics'), t.agent.token, [401, 403, 404])
    },
    {
      name: 'a percent-encoded /api prefix from a hostile Origin',
      attempt: async t =>
        refusedWithout(
          await t.get('/%61pi/health', { Origin: HOSTILE_ORIGIN }),
          t.agent.token,
          [401, 403, 404]
        )
    },
    {
      name: 'a percent-encoded native route with no update token',
      attempt: async t =>
        refusedWithout(
          await t.send([
            'POST /native/update/%64rain HTTP/1.1',
            `Host: 127.0.0.1:${t.port}`,
            'Content-Length: 0'
          ]),
          t.agent.token,
          [401, 403, 404]
        )
    }
  ]
};
