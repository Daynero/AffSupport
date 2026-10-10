import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM_ANALYTICS_EVENT_NAMES } from '../packages/shared/src/team/analytics.js';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { SAFE_LOGGER } from '../apps/agent/src/server/app.js';
import { isSafeDiagnosticValue } from '../apps/agent/src/server/diagnostics-log.js';
import { failureCode } from '../apps/agent/src/server/failure-codes.js';
import type { ToolModule } from '../apps/agent/src/server/tools.js';
import {
  ANALYTICS_PROPERTY_KEYS,
  sanitizeAnalyticsProperties,
  type AnalyticsEventName
} from '../apps/web/src/analytics/events.js';
import { safeErrorCode } from '../apps/web/src/analytics/errors.js';
import { isForwardableRecord } from '../apps/web/src/analytics/journal-forwarder.js';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service.js';
import { uploadBudgetSuite } from './support/adversarial/upload-budgets.js';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * SC-009, FR-029, FR-029a. Everything that leaves the machine or is shown as a failure carries
 * zero file names, paths or user content.
 *
 * Swept here: the analytics property allowlist and the envelope it is sent in, the agent's
 * diagnostics response and the forwarder that ships its journal, the error payloads of the
 * local HTTP API (a handler's own failure and one nobody caught), and the crash path — what
 * an unhandled rejection writes about itself. Each is fed the same user content and must
 * emit none of it.
 *
 * Explicitly *not* covered, because it is the product working: the interface showing a user
 * the names of files they themselves added. The last block asserts that permission is kept,
 * so a future over-eager fence cannot pass this file by stripping the user's own names from
 * their own screen.
 */

/** What the user owns: paths, bare file names, names with spaces and non-ASCII, prose, an address. */
const USER_CONTENT: readonly string[] = [
  '/Users/roman/Movies/Holiday 2026.mov',
  'C:\\Users\\roman\\Videos\\client-brief.mp4',
  '~/Desktop/Private Folder',
  'file:///Users/roman/secret-contract.pdf',
  'Holiday 2026.mov',
  'holiday-trip.mov',
  'client-secret.txt',
  'contract_final.pdf',
  'Літо на морі.mov',
  'roman@example.com',
  'the private note the user typed'
];

/** Distinctive fragments of the above; none may appear anywhere in an emitted payload. */
const NEEDLES: readonly string[] = [
  '/Users/roman',
  'Users\\roman',
  'Holiday 2026',
  'holiday-trip',
  'client-brief',
  'Private Folder',
  'secret-contract',
  'client-secret',
  'contract_final',
  'Літо',
  'roman@example.com',
  'private note'
];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value))
  };
}

function leaks(payload: unknown): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return NEEDLES.filter(needle => text.includes(needle));
}

const agents: MinimalAgent[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

describe('analytics', () => {
  it('drops user content from every property the allowlist knows', () => {
    const offenders: string[] = [];
    for (const key of ANALYTICS_PROPERTY_KEYS) {
      for (const value of USER_CONTENT) {
        const sent = sanitizeAnalyticsProperties({ [key]: value }, 'error_occurred');
        const found = leaks(sent);
        if (found.length) offenders.push(`${key} kept ${JSON.stringify(value)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('drops user content from the team events, which have their own sanitizer', () => {
    const everything = Object.fromEntries(
      ANALYTICS_PROPERTY_KEYS.map(key => [key, USER_CONTENT[0]])
    );
    for (const name of TEAM_ANALYTICS_EVENT_NAMES) {
      for (const value of USER_CONTENT) {
        const props = Object.fromEntries(Object.keys(everything).map(key => [key, value]));
        expect(leaks(sanitizeAnalyticsProperties(props, name as AnalyticsEventName)), name).toEqual(
          []
        );
      }
    }
  });

  it('drops keys the allowlist does not know, whatever they are called', () => {
    const sent = sanitizeAnalyticsProperties(
      { file_name: USER_CONTENT[4], path: USER_CONTENT[0], message: USER_CONTENT[10], query: 'x' },
      'error_occurred'
    );
    expect(sent).toEqual({});
  });

  it('sends an envelope that carries none of it, end to end', async () => {
    // `track` only runs in a browser; these globals are all it reads of one.
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'Mozilla/5.0 (Macintosh)' });
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
    const sent: PendingAnalyticsEvent[] = [];
    const service = new ProductAnalytics(async events => {
      sent.push(...events);
      return { acceptedEventIds: events.map(event => event.event_id) };
    }, null);
    service.setUser('11111111-1111-4111-8111-111111111111');
    for (const value of USER_CONTENT) {
      const props = Object.fromEntries(ANALYTICS_PROPERTY_KEYS.map(key => [key, value]));
      service.track('error_occurred', props as never);
      service.track('compression_completed', props as never);
    }
    await service.flush();
    await service.flush();
    expect(sent.length).toBeGreaterThan(0);
    expect(leaks(sent)).toEqual([]);
  });

  it('turns an exception into a code, never its sentence', () => {
    const error = Object.assign(
      new Error(`ENOENT: no such file or directory, open '${USER_CONTENT[0]}'`),
      { code: 'ENOENT' }
    );
    expect(safeErrorCode(error)).toBe('ENOENT');
    expect(safeErrorCode(new Error(USER_CONTENT[4]))).toBe('unknown');
    expect(safeErrorCode(USER_CONTENT[9])).toBe('unknown');
  });
});

describe('the diagnostics journal', () => {
  it('refuses every user-content value at the fence', () => {
    for (const value of USER_CONTENT) expect(isSafeDiagnosticValue(value), value).toBe(false);
  });

  it('serves a diagnostics page that carries none of it', async () => {
    const agent = await startMinimalAgent();
    agents.push(agent);
    for (const value of USER_CONTENT) {
      expect(agent.diagnostics.record('drop', 'resolved', { source: value })).toBe(false);
    }
    // A record that is legitimate goes through, so the page is not empty by accident.
    expect(
      agent.diagnostics.record('drop', 'resolved', { kind: 'file', count: 2, version: '1.2.6' })
    ).toBe(true);

    const response = await agent.app.inject({
      url: '/api/diagnostics',
      headers: { 'x-session-token': agent.token }
    });
    expect(response.statusCode).toBe(200);
    const page = response.json() as { log: unknown[]; logRejected: number };
    expect(page.log.length).toBeGreaterThan(0);
    expect(page.logRejected).toBeGreaterThanOrEqual(USER_CONTENT.length);
    expect(leaks(response.body)).toEqual([]);
  });

  it('never forwards a journal record that carries it, even from an older agent', () => {
    for (const value of USER_CONTENT) {
      const record = {
        seq: 1,
        at: Date.now(),
        category: 'drop',
        code: 'resolved',
        props: { source: value }
      };
      expect(isForwardableRecord(record), value).toBe(false);
    }
    expect(
      isForwardableRecord({
        seq: 1,
        at: Date.now(),
        category: 'drop',
        code: 'resolved',
        props: { kind: 'file' }
      })
    ).toBe(true);
  });
});

describe('error payloads from the local API', () => {
  async function agentWithFailingRoutes() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-leak-'));
    directories.push(dir);
    const lines: string[] = [];
    const failing: ToolModule = {
      id: 'failing',
      lifecycle: null,
      register(app) {
        // A real filesystem failure on a user-named file, left uncaught on purpose.
        app.get('/api/test/uncaught-fs', async () => readFile(path.join(dir, 'Holiday 2026.mov')));
        // The shape FFmpeg failures take: the user's path inside the sentence.
        app.get('/api/test/uncaught-tool', async () => {
          throw new Error(`ffmpeg exited 1: ${USER_CONTENT[0]}: Invalid data found`);
        });
        // A handler that throws one of the codes deliberately keeps it.
        app.get('/api/test/coded', async () => {
          throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
        });
      },
      busy: () => false,
      cancel: async () => false,
      cancelAll: async () => 0,
      shutdown: async () => undefined
    };
    const agent = await startMinimalAgent({
      modules: [failing],
      logger: { stream: { write: (line: string) => void lines.push(line) } }
    });
    agents.push(agent);
    const get = (url: string) =>
      agent.app.inject({ url, headers: { 'x-session-token': agent.token } });
    return { agent, lines, get };
  }

  it('answers an uncaught filesystem failure with a code, and logs no path', async () => {
    const { get, lines } = await agentWithFailingRoutes();
    const response = await get('/api/test/uncaught-fs');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'FILE_UNAVAILABLE' });
    expect(leaks(response.body)).toEqual([]);
    expect(leaks(lines.join('\n'))).toEqual([]);
    expect(lines.join('\n')).toContain('ENOENT');
  });

  it('answers an uncaught tool failure with a code, and logs no path', async () => {
    const { get, lines } = await agentWithFailingRoutes();
    const response = await get('/api/test/uncaught-tool');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'OPERATION_FAILED' });
    expect(leaks(response.body)).toEqual([]);
    expect(leaks(lines.join('\n'))).toEqual([]);
  });

  it('keeps a code a handler threw on purpose', async () => {
    const { get } = await agentWithFailingRoutes();
    const response = await get('/api/test/coded');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('does not echo a malformed body back', async () => {
    const target = await uploadBudgetSuite.start();
    try {
      const response = await target.agent.app.inject({
        method: 'POST',
        url: '/api/landing/upload/folder/begin',
        headers: { 'x-session-token': target.agent.token, 'content-type': 'application/json' },
        payload: `{"name": "${USER_CONTENT[4]}"`
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'INVALID_INPUT' });
      expect(leaks(response.body)).toEqual([]);
    } finally {
      await target.stop();
    }
  });

  it('answers a real write failure in a real route with a code', async () => {
    // A file where the next upload needs a directory: the write fails with ENOTDIR, whose
    // message names the full path inside the landing workspace.
    const target = await uploadBudgetSuite.start();
    try {
      await target.begin();
      expect((await target.sendFile('Holiday 2026.mov', 'x')).statusCode).toBe(200);
      const failed = await target.sendFile('Holiday 2026.mov/inner.txt', 'x');
      expect(failed.statusCode).toBe(400);
      expect(leaks(failed.json)).toEqual([]);
    } finally {
      await target.stop();
    }
  });

  it('maps the failures a route catches without letting their text through', async () => {
    const enoent = await readFile(path.join(os.tmpdir(), 'Holiday 2026.mov')).catch(error => error);
    for (const error of [
      enoent,
      new Error(USER_CONTENT[0]),
      Object.assign(new Error(`EACCES: permission denied, open '${USER_CONTENT[0]}'`), {
        code: 'EACCES'
      }),
      USER_CONTENT[10]
    ]) {
      expect(leaks(failureCode(error))).toEqual([]);
    }
  });
});

describe('crash reports', () => {
  it('writes the kind of an unhandled failure, never its sentence or stack', async () => {
    // index.ts routes every unhandled rejection and failed save through `app.log.error`.
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        ...SAFE_LOGGER,
        stream: { write: (line: string) => void lines.push(line) }
      }
    });
    await app.ready();
    const enoent = await readFile(path.join(os.tmpdir(), 'nowhere', 'Holiday 2026.mov')).catch(
      e => e
    );
    app.log.error(enoent, 'Unhandled rejection');
    app.log.error(new Error(`ffmpeg: ${USER_CONTENT[0]}`), 'Could not save local state');
    await app.close();
    const written = lines.join('\n');
    expect(leaks(written)).toEqual([]);
    expect(written).toContain('ENOENT');
    expect(written).toContain('Unhandled rejection');
  });
});

describe('what the interface may still show', () => {
  it("keeps the name of a file the user added on the user's own screen", async () => {
    // FR-029's own carve-out: a name the user chose to add is the product working.
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-leak-landing-'));
    directories.push(root);
    const previous = process.env.AGENT_LANDING_WORKSPACE;
    process.env.AGENT_LANDING_WORKSPACE = root;
    const optimizer = new LandingOptimizer({ ffmpeg: false, ffprobe: false }, () => undefined);
    try {
      await optimizer.beginUpload('folder', 'Holiday 2026');
      expect(JSON.stringify(optimizer.state())).toContain('Holiday 2026');
    } finally {
      await optimizer.abortUpload();
      await optimizer.shutdown().catch(() => undefined);
      if (previous === undefined) delete process.env.AGENT_LANDING_WORKSPACE;
      else process.env.AGENT_LANDING_WORKSPACE = previous;
    }
  });
});
