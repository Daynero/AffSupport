import type { FastifyInstance } from 'fastify';
import {
  SOTY_LOAD_CHANNEL,
  parsePowerLimitRequest,
  type PowerEvent,
  type SotyLoad
} from '@video-compressor/shared';
import { EventChannel, type ChannelHub } from '../server/sse.js';
import type { PowerGovernor } from './governor.js';
import { SotyLoadMonitor } from './soty-load.js';

/**
 * What the routes need from a sampler, expressed structurally so the HTTP layer
 * does not depend on the measurement implementation. `watch()` registers a
 * viewer and returns its teardown.
 */
export interface PowerSamplerHandle {
  watch(): () => void;
}

/** What the routes need from Soty's load monitor; structural for the same reason. */
export interface SotyLoadHandle {
  watch(): () => void;
  snapshot(): SotyLoad;
  onChange(listener: (load: SotyLoad) => void): () => void;
}

export interface PowerRoutesDeps {
  governor: PowerGovernor;
  allowedOrigins: ReadonlySet<string>;
  /** Absent before measurement is wired; the routes still serve a snapshot. */
  sampler?: PowerSamplerHandle;
  onError?: (error: unknown, message: string) => void;
  /** The multiplexed fan-out, when one is wired. */
  channelHub?: ChannelHub;
  /** Soty's own load; a real monitor over the governor's tree when absent and a hub is wired. */
  sotyLoad?: SotyLoadHandle;
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
  const { governor, allowedOrigins, sampler, channelHub } = deps;
  const events = new EventChannel<PowerEvent>(allowedOrigins, () => governor.state());

  if (channelHub) {
    // The one channel that costs something to produce. Sampling reads the process table on a
    // timer, so it is refcounted to viewers here exactly as it is on the per-tool endpoint:
    // nobody watching means no measurement at all, and a panel somebody opened once must not
    // leave the machine doing work for nobody.
    let stopSampling: (() => void) | undefined;
    events.publishOn(channelHub, 'power', active => {
      if (active) {
        stopSampling = sampler?.watch();
        return;
      }
      stopSampling?.();
      stopSampling = undefined;
    });
    publishSotyLoad(
      channelHub,
      deps.sotyLoad ?? new SotyLoadMonitor({ tree: governor, onError: deps.onError })
    );
  }

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

/**
 * Soty's own load, on the stream only.
 *
 * No per-tool endpoint: every agent that has this has the multiplexed stream, and the
 * header asks for it only where `machineLoad` is in the contract. Refcounted to the
 * channel's subscribers like the consumption sampler above — measured while somebody is
 * looking, and not otherwise.
 */
function publishSotyLoad(hub: ChannelHub, monitor: SotyLoadHandle): void {
  let stopWatching: (() => void) | undefined;
  hub.register({
    name: SOTY_LOAD_CHANNEL,
    snapshot: () => monitor.snapshot(),
    onActive: active => {
      if (active) {
        stopWatching ??= monitor.watch();
        return;
      }
      stopWatching?.();
      stopWatching = undefined;
    }
  });
  monitor.onChange(load => {
    if (hub.hasListeners(SOTY_LOAD_CHANNEL)) hub.publish(SOTY_LOAD_CHANNEL, load);
  });
}
