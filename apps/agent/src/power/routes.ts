import type { FastifyInstance } from 'fastify';
import { parsePowerLimitRequest, type PowerEvent } from '@video-compressor/shared';
import { EventChannel } from '../server/sse.js';
import type { PowerGovernor } from './governor.js';

/**
 * What the routes need from a sampler, expressed structurally so the HTTP layer
 * does not depend on the measurement implementation. `watch()` registers a
 * viewer and returns its teardown.
 */
export interface PowerSamplerHandle {
  watch(): () => void;
}

export interface PowerRoutesDeps {
  governor: PowerGovernor;
  allowedOrigins: ReadonlySet<string>;
  /** Absent before measurement is wired; the routes still serve a snapshot. */
  sampler?: PowerSamplerHandle;
  onError?: (error: unknown, message: string) => void;
}

/**
 * The power throttle's HTTP surface: a snapshot, a setter, and a live stream.
 *
 * These sit behind the same origin allowlist, session token, and entitlement
 * gate as every tool route — deliberately NOT in ENTITLEMENT_EXEMPT_ROUTES.
 * That set is the routes needed to *establish* a session; a settings control is
 * not one of them, and exempting the snapshot would leak live machine-load
 * telemetry to any allowed origin before entitlement is proven.
 */
export function registerPowerRoutes(
  app: FastifyInstance,
  deps: PowerRoutesDeps
): EventChannel<PowerEvent> {
  const { governor, allowedOrigins, sampler } = deps;
  const events = new EventChannel<PowerEvent>(allowedOrigins, () => governor.state());

  // Any state change — a new limit, a child starting or finishing, a fresh
  // sample — reaches every open window through this one broadcast. That is what
  // makes two browser windows agree without any client-side coordination.
  governor.setChangeListener(() => events.broadcast(governor.state()));

  app.get('/api/power', async () => governor.state());

  app.post('/api/power/limit', async (request, reply) => {
    const parsed = parsePowerLimitRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      await governor.setLimit(parsed.value.limitPercent);
    } catch (error) {
      deps.onError?.(error, 'Could not persist the power limit');
      // The limit was NOT applied: the lever must never show a value that will
      // not survive a restart.
      return reply.code(500).send({ error: 'POWER_PERSIST_FAILED' });
    }
    return governor.state();
  });

  app.get('/api/power/events', async (request, reply) => {
    // Measurement is refcounted to viewers: nobody watching means no sampling
    // cost at all.
    const stop = sampler?.watch();
    request.raw.on('close', () => stop?.());
    await events.handler(request, reply);
  });

  return events;
}
