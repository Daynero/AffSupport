import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { preflightLocal } from './preflight.mjs';
import {
  provisionLocalFixtures,
  verifiedLocalStack,
  assertFixtureProvisionable
} from './fixtures.mjs';
import { createActor } from './actors.mjs';
import { fixtureAccountName } from './names.mjs';
import { runArrivals } from './arrival.mjs';
import { summarizeAttempts } from './load-accounting.mjs';
import { DeliveryLedger } from './delivery.mjs';

export function realtimeCalibrationProfile(name) {
  if (!['steady', 'burst'].includes(name)) throw new Error('ACCEPTANCE_LOAD_CONFIG_INVALID');
  return {
    id: name,
    count: 110,
    warmup: 10,
    intervalMs: name === 'steady' ? 1000 : 200,
    concurrency: 4,
    timeoutMs: 15000
  };
}

/** Named, bounded local protocol calibration. Native DOM and hosted quota proofs remain unknown. */
export async function calibrateRealtimeLocal(target, profileName = 'steady') {
  const profile = realtimeCalibrationProfile(profileName);
  const before = await preflightLocal(target);
  if (!before.ok) throw new Error('ACCEPTANCE_PREFLIGHT_FAILED');
  const { state } = await provisionLocalFixtures(target);
  const status = await verifiedLocalStack(target);
  const lock = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000
  });
  await lock.connect();
  const aliases = ['A', 'B', 'C', 'X', 'S'];
  const receivers = ['A', 'B', 'C'];
  const clients = new Map();
  const actors = new Map();
  const channels = [];
  const failures = [];
  const events = Object.fromEntries(aliases.map(a => [a, 0]));
  const controller = new AbortController();
  const run = randomUUID().slice(0, 8);
  const offers = Array.from({ length: profile.count }, (_, index) => ({
    index,
    name: fixtureAccountName(target.namespace, run, `rt${index}`)
  }));
  const ledger = new DeliveryLedger(receivers, offers);
  const api = [];
  const reads = Object.fromEntries(receivers.map(a => [a, 0]));
  const pendingReads = new Set();
  let started = 0;
  let running = true;
  let result;
  let after;
  let failureCode = null;
  let peakChannels = 0;
  const fail = code => {
    if (!failures.includes(code)) failures.push(code);
    controller.abort();
  };
  try {
    const held = await lock.query('select pg_try_advisory_lock(hashtextextended($1,0)) held', [
      `acceptance-fixtures:${target.namespace}`
    ]);
    if (held.rows[0]?.held !== true) throw new Error('ACCEPTANCE_FIXTURE_BUSY');
    await assertFixtureProvisionable(target.namespace);
    for (const alias of aliases) {
      const client = createClient(target.authUrl, status.ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: `acceptance-${run}-${alias}`
        },
        realtime: { timeout: 10000 },
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
            })
        }
      });
      clients.set(alias, client);
      const actor = state.actors[alias];
      const login = await client.auth.signInWithPassword({
        email: actor.email,
        password: actor.password
      });
      if (
        login.error ||
        login.data.user?.id !== actor.id ||
        login.data.user?.user_metadata?.acceptance_namespace !== target.namespace ||
        !login.data.session
      )
        throw new Error('ACCEPTANCE_ACTOR_LOGIN_FAILED');
      actors.set(
        alias,
        createActor(target, {
          accessToken: login.data.session.access_token,
          publicKey: status.ANON_KEY,
          expectedSubject: actor.id
        })
      );
    }
    for (const alias of aliases) {
      const client = clients.get(alias);
      let dirty = false;
      let reading = false;
      const refresh = () => {
        dirty = true;
        if (reading || !running || controller.signal.aborted) return;
        reading = true;
        const work = (async () => {
          while (dirty && running && !controller.signal.aborted) {
            dirty = false;
            const response = await actors
              .get(alias)
              .rpc('list_team_accounts', { p_team: state.teams.W1 }, { signal: controller.signal });
            reads[alias] += 1;
            if (!running || controller.signal.aborted) return;
            if (!response.ok || !Array.isArray(response.data)) {
              fail('AUTHORIZED_READ_FAILED');
              return;
            }
            ledger.observe(alias, response.data, performance.now() - started);
          }
        })()
          .catch(() => fail('AUTHORIZED_READ_INVALID'))
          .finally(() => {
            reading = false;
            pendingReads.delete(work);
          });
        pendingReads.add(work);
      };
      const channel = client.channel(`acceptance036-${run}-${alias}`).on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_account_workspace_signals',
          filter: `team_id=eq.${state.teams.W1}`
        },
        payload => {
          if (!running || controller.signal.aborted) return;
          events[alias] += 1;
          if (!receivers.includes(alias)) {
            fail('UNAUTHORIZED_REALTIME_DELIVERY');
            return;
          }
          if (payload.new?.team_id !== state.teams.W1) {
            fail('UNEXPECTED_REALTIME_SCOPE');
            return;
          }
          if (started) refresh();
        }
      );
      channels.push(channel);
      await new Promise((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => reject(new Error('ACCEPTANCE_REALTIME_UNAVAILABLE')), 15000);
        channel.subscribe(state => {
          if (state === 'SUBSCRIBED' && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve(undefined);
          } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state) && running) {
            if (ready) fail('REALTIME_CONNECTION_LOST');
            else {
              clearTimeout(timer);
              reject(new Error('ACCEPTANCE_REALTIME_UNAVAILABLE'));
            }
          }
        });
      });
    }
    peakChannels = [...clients.values()].reduce((sum, c) => sum + c.getChannels().length, 0);
    started = performance.now();
    result = await runArrivals({
      count: profile.count,
      intervalMs: profile.intervalMs,
      concurrency: profile.concurrency,
      warmup: profile.warmup,
      timeoutMs: profile.timeoutMs,
      signal: controller.signal,
      execute: async (index, signal) => {
        const response = await actors.get(index % 2 ? 'B' : 'A').rpc(
          'create_team_account',
          {
            p_team: state.teams.W1,
            p_name: offers[index].name
          },
          { signal }
        );
        const row = response.data;
        api.push({
          index,
          completedMs: performance.now() - started,
          status: response.status,
          correct: response.ok && row?.name === offers[index].name && typeof row?.id === 'string'
        });
        if (!response.ok || row?.name !== offers[index].name || typeof row?.id !== 'string') {
          fail('WRITER_RESULT_FAILED');
          return false;
        }
        ledger.accept(index, row.id);
        while (!signal.aborted && !ledger.delivered(index)) {
          try {
            await wait(10, undefined, { signal });
          } catch {
            break;
          }
        }
        return ledger.delivered(index);
      }
    });
    // Drain real readbacks before classifying missing results. Future work stays unoffered.
    await Promise.allSettled([...pendingReads]);
    after = await preflightLocal(target);
  } catch (error) {
    const allowed = [
      'ACCEPTANCE_FIXTURE_BUSY',
      'ACCEPTANCE_FIXTURE_CLEANUP_PENDING',
      'ACCEPTANCE_ACTOR_LOGIN_FAILED',
      'ACCEPTANCE_REALTIME_UNAVAILABLE'
    ];
    failureCode =
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : 'ACCEPTANCE_REALTIME_CALIBRATION_FAILED';
  } finally {
    running = false;
    controller.abort();
    await Promise.allSettled([...pendingReads]);
    await Promise.allSettled(
      [...clients.values()].map(async client => {
        await client.removeAllChannels();
        await client.realtime.disconnect();
        await client.auth.stopAutoRefresh();
      })
    );
    await lock.end();
  }
  const samples = result ? ledger.samples(result.samples, profile.timeoutMs) : [];
  const summary = summarizeAttempts(samples, profile.timeoutMs);
  const perReceiver = receivers.map(receiver => ({
    receiver,
    ...summarizeAttempts(
      samples.filter(s => s.receiver === receiver),
      profile.timeoutMs
    )
  }));
  const teardown = [...clients.values()].every(
    c => c.getChannels().length === 0 && !c.realtime.isConnected()
  );
  const identityUnchanged = !!after?.ok && after.targetFingerprint === before.targetFingerprint;
  const evidence = {
    schemaVersion: 1,
    campaignId: target.namespace,
    kind: 'local-realtime-calibration',
    generatedAt: new Date().toISOString(),
    targetFingerprint: before.targetFingerprint,
    profile,
    ok:
      !failureCode &&
      !failures.length &&
      identityUnchanged &&
      teardown &&
      result?.summary.measured === 100 &&
      result.summary.success === 100 &&
      summary.success === 300,
    failureCode,
    failures,
    incompleteWrites: result ? result.summary.measured - result.summary.success : null,
    missingOrFailedDeliveries: summary.measured - summary.success,
    identityUnchanged,
    peakChannels,
    subscriptionCount: channels.length,
    receivedSignals: events,
    authoritativeReads: reads,
    teardown,
    offeredWrites: result?.summary ?? null,
    delivery: summary,
    perReceiver,
    stopped: result?.stopped ?? true,
    notOffered: result?.notOffered ?? offers.length,
    api,
    samples,
    limits: [
      'Five real Auth clients; A/B/C authorized, X/S not members of W1.',
      'Fixed local protocol calibration with 10 warmup and 100 measured creates; no Drive or provider calls.',
      'Delivery means event-triggered authoritative account readback with matching result ID/name, not native DOM.',
      'Missing, late, dropped and unoffered work remain explicit; this is not LOAD-01–10, hosted quota or 8-hour soak proof.'
    ]
  };
  const directory = path.resolve('release/acceptance', target.namespace, 'load');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `realtime-${Date.now()}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx' }
  );
  return evidence;
}
