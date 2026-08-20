import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { registerPowerRoutes } from '../apps/agent/src/power/routes.js';
import { POWER_LIMIT_MAX, POWER_LIMIT_MIN, type PowerState } from '../packages/shared/src/types.js';

const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

interface Harness {
  app: FastifyInstance;
  governor: PowerGovernor;
  broadcasts: PowerState[];
  watchers: () => number;
}

function harness(options: { persist?: (limit: number) => Promise<void> } = {}): Harness {
  const app = Fastify({ logger: false });
  apps.push(app);
  const governor = new PowerGovernor({
    cpuCount: 10,
    pauseSupported: true,
    persist: options.persist
  });
  const broadcasts: PowerState[] = [];
  let watchers = 0;
  const events = registerPowerRoutes(app, {
    governor,
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    sampler: {
      watch: () => {
        watchers += 1;
        return () => {
          watchers -= 1;
        };
      }
    }
  });
  const original = events.broadcast.bind(events);
  events.broadcast = (event: PowerState) => {
    broadcasts.push(event);
    original(event);
  };
  return { app, governor, broadcasts, watchers: () => watchers };
}

describe('GET /api/power', () => {
  it('reports an unrestricted default on a fresh agent', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'GET', url: '/api/power' });
    expect(response.statusCode).toBe(200);
    const state = response.json() as PowerState;
    expect(state.limitPercent).toBe(POWER_LIMIT_MAX);
    expect(state.mode).toBe('unrestricted');
    expect(state.activeChildren).toBe(0);
  });

  it('carries no consumption figure before anything has been measured', async () => {
    const { app } = harness();
    const state = (await app.inject({ method: 'GET', url: '/api/power' })).json() as PowerState;
    // Never a fabricated 0%: "unavailable" and "idle" are different claims.
    expect(state.sample.availability).toBe('warming-up');
    expect(state.sample).not.toHaveProperty('systemSharePercent');
  });
});

describe('POST /api/power/limit', () => {
  it('applies a valid limit and returns the new snapshot', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/power/limit',
      payload: { limitPercent: 40 }
    });
    expect(response.statusCode).toBe(200);
    const state = response.json() as PowerState;
    expect(state.limitPercent).toBe(40);
    expect(state.mode).toBe('limited');
  });

  it('clamps an out-of-range value instead of refusing it', async () => {
    const { app } = harness();
    // A client sending 500 means "maximum"; failing that request would be
    // pedantic, and the response is authoritative so the lever self-corrects.
    const high = await app.inject({
      method: 'POST',
      url: '/api/power/limit',
      payload: { limitPercent: 500 }
    });
    expect((high.json() as PowerState).limitPercent).toBe(POWER_LIMIT_MAX);

    const low = await app.inject({
      method: 'POST',
      url: '/api/power/limit',
      payload: { limitPercent: 5 }
    });
    expect((low.json() as PowerState).limitPercent).toBe(POWER_LIMIT_MIN);
  });

  it('rejects a malformed body with a stable machine code', async () => {
    const { app } = harness();
    for (const payload of [{}, { limitPercent: '40' }, { limitPercent: null }, []]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/power/limit',
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'POWER_LIMIT_INVALID' });
    }
  });

  it('does not apply a limit it could not persist', async () => {
    const { app } = harness({
      persist: async () => {
        throw new Error('EROFS');
      }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/power/limit',
      payload: { limitPercent: 40 }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'POWER_PERSIST_FAILED' });

    // The follow-up read must still show the OLD limit: a lever pointing at a
    // value that will not survive a restart is worse than a visible error.
    const state = (await app.inject({ method: 'GET', url: '/api/power' })).json() as PowerState;
    expect(state.limitPercent).toBe(POWER_LIMIT_MAX);
  });

  it('broadcasts the change so other windows agree', async () => {
    const { app, broadcasts } = harness();
    await app.inject({ method: 'POST', url: '/api/power/limit', payload: { limitPercent: 40 } });
    // Cross-window agreement falls out of the broadcast; no client-side
    // coordination is involved.
    expect(broadcasts.at(-1)?.limitPercent).toBe(40);
  });

  it('is idempotent', async () => {
    const { app } = harness();
    await app.inject({ method: 'POST', url: '/api/power/limit', payload: { limitPercent: 40 } });
    const second = await app.inject({
      method: 'POST',
      url: '/api/power/limit',
      payload: { limitPercent: 40 }
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as PowerState).limitPercent).toBe(40);
  });
});

describe('sampling lifecycle', () => {
  it('measures only while someone is watching', async () => {
    const { app, watchers } = harness();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    expect(watchers()).toBe(0);
    const controller = new AbortController();
    const streamed = fetch(`http://127.0.0.1:${port}/api/power/events`, {
      headers: { origin: ALLOWED_ORIGIN },
      signal: controller.signal
    });
    const response = await streamed;
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(watchers()).toBe(1));

    controller.abort();
    await response.body?.cancel().catch(() => {});
    // Nobody watching means no probing at all: the measurement must never be a
    // meaningful contributor to the load it reports.
    await vi.waitFor(() => expect(watchers()).toBe(0));
  });

  it('replays the current snapshot to a client the moment it connects', async () => {
    const { app } = harness();
    await app.inject({ method: 'POST', url: '/api/power/limit', payload: { limitPercent: 40 } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/power/events`, {
      headers: { origin: ALLOWED_ORIGIN },
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    const frame = new TextDecoder().decode(chunk?.value);
    expect(frame).toContain('"limitPercent":40');
    controller.abort();
    await reader?.cancel().catch(() => {});
  });
});
