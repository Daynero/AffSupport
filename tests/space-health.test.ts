// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { StorageHealth } from '@video-compressor/shared';
import type { CatalogUpdaterState } from '../apps/web/src/api/team';
import {
  agentTone,
  realtimeTone,
  storageStale,
  storageTone,
  summarizeSpaceHealth,
  updaterTone,
  workTone,
  type SpaceHealthInput
} from '../apps/web/src/team/workspace/useSpaceHealth';

/**
 * The space's health (070, US5, T027): five sources the header already had, folded into
 * `ok | attention` and a list of what is busy. Every source on its own, then the mixtures the
 * header has to order.
 */

const connected: StorageHealth = { kind: 'connected', lastReconciledAt: '2026-11-24T00:00:00Z' };

const updater = (overrides: Partial<CatalogUpdaterState> = {}): CatalogUpdaterState => ({
  state: 'running',
  interval: '1h',
  restitch: false,
  nextRunAt: '2026-11-24T06:00:00Z',
  startedAt: '2026-11-24T00:00:00Z',
  catalogCount: 2,
  failingCount: 0,
  spareReadyCount: null,
  activeCount: 0,
  restitchBlockedCode: null,
  serverNow: '2026-11-24T00:00:00Z',
  ...overrides
});

const healthy: SpaceHealthInput = {
  storage: { health: connected, stale: false },
  agent: { connection: 'connected', availability: 'ready' },
  realtime: { state: 'connected', graceElapsed: false },
  work: { batchRunning: false, sessionOnly: false },
  updater: updater()
};

describe('each source on its own', () => {
  it('storage: connected is fine, a scan is work, anything a person must fix is attention', () => {
    expect(storageTone(connected, false)).toBe('ok');
    expect(storageTone(null, false)).toBe('idle');
    expect(storageTone(connected, true)).toBe('attention');
    for (const health of [
      { kind: 'indexing', indexedFolders: 1, totalFolders: 3, files: 9 },
      { kind: 'preparing', ready: 1, pending: 2 },
      { kind: 'waiting_provider', since: '2026-11-24T00:00:00Z' }
    ] as StorageHealth[])
      expect(storageTone(health, false)).toBe('busy');
    for (const health of [
      { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
      { kind: 'attention', reason: 'sync_failed', fixer: 'manager' },
      { kind: 'disconnected' },
      { ...connected, syncHealth: 'delayed' },
      { ...connected, coverage: 'partial' },
      { ...connected, coverage: 'permission_limited' }
    ] as StorageHealth[])
      expect(storageTone(health, false)).toBe('attention');
  });

  it('agent: says nothing during the first check, and needs a person for every other miss', () => {
    expect(agentTone(null)).toBe('idle');
    expect(agentTone({ connection: 'checking', availability: 'disconnected' })).toBe('idle');
    expect(agentTone({ connection: 'connecting', availability: 'disconnected' })).toBe('idle');
    expect(agentTone({ connection: 'connected', availability: 'ready' })).toBe('ok');
    for (const availability of ['disconnected', 'too_old', 'blocked', 'account'] as const)
      expect(agentTone({ connection: 'disconnected', availability })).toBe('attention');
  });

  it('live updates: quiet inside the grace, attention after it or when switched off', () => {
    expect(realtimeTone({ state: 'connected', graceElapsed: false })).toBe('ok');
    expect(realtimeTone({ state: 'connecting', graceElapsed: false })).toBe('idle');
    expect(realtimeTone({ state: 'reconnecting', graceElapsed: false })).toBe('idle');
    expect(realtimeTone({ state: 'connecting', graceElapsed: true })).toBe('attention');
    expect(realtimeTone({ state: 'reconnecting', graceElapsed: true })).toBe('attention');
    expect(realtimeTone({ state: 'disabled', graceElapsed: false })).toBe('attention');
  });

  it('updater: a waiting schedule is fine, a run is work, a failure needs a look', () => {
    expect(updaterTone(null)).toBe('ok');
    expect(updaterTone(updater({ state: 'stopped', activeCount: 0 }))).toBe('ok');
    expect(updaterTone(updater())).toBe('ok');
    expect(updaterTone(updater({ activeCount: 2 }))).toBe('busy');
    expect(updaterTone(updater({ nextRunAt: null }))).toBe('busy');
    expect(updaterTone(updater({ state: 'stopped', activeCount: 1 }))).toBe('busy');
    expect(updaterTone(updater({ failingCount: 1 }))).toBe('attention');
    expect(updaterTone(updater({ activeCount: 1, failingCount: 1 }))).toBe('attention');
    expect(updaterTone(updater({ restitchBlockedCode: 'PERMISSION_DENIED' }))).toBe('attention');
  });

  it('work: a running batch is work, a session-only journal needs a person', () => {
    expect(workTone({ batchRunning: false, sessionOnly: false })).toBe('ok');
    expect(workTone({ batchRunning: true, sessionOnly: false })).toBe('busy');
    expect(workTone({ batchRunning: false, sessionOnly: true })).toBe('attention');
    expect(workTone({ batchRunning: true, sessionOnly: true })).toBe('attention');
  });

  it('storage stops being trusted two minutes after its last good read', () => {
    expect(storageStale(null, 1_000_000)).toBe(false);
    expect(storageStale(1_000_000 - 119_999, 1_000_000)).toBe(false);
    expect(storageStale(1_000_000 - 120_000, 1_000_000)).toBe(true);
  });
});

describe('the summary', () => {
  it('is ok with nothing busy when every source is fine (SC-005: zero chips)', () => {
    expect(summarizeSpaceHealth(healthy)).toEqual({
      kind: 'ok',
      tones: { storage: 'ok', agent: 'ok', realtime: 'ok', updater: 'ok', work: 'ok' },
      attention: [],
      busy: []
    });
  });

  it('is still ok while the first checks run', () => {
    const summary = summarizeSpaceHealth({
      ...healthy,
      storage: { health: null, stale: false },
      agent: { connection: 'checking', availability: 'disconnected' },
      realtime: { state: 'connecting', graceElapsed: false }
    });
    expect(summary.kind).toBe('ok');
    expect(summary.attention).toEqual([]);
    expect(summary.busy).toEqual([]);
  });

  it('names the one source that needs a person', () => {
    const summary = summarizeSpaceHealth({
      ...healthy,
      agent: { connection: 'disconnected', availability: 'disconnected' }
    });
    expect(summary.kind).toBe('attention');
    expect(summary.attention).toEqual(['agent']);
  });

  it('keeps work apart from attention: a running job alone is still ok', () => {
    const summary = summarizeSpaceHealth({
      ...healthy,
      work: { batchRunning: true, sessionOnly: false },
      updater: updater({ activeCount: 1 }),
      storage: { health: { kind: 'preparing', ready: 1, pending: 4 }, stale: false }
    });
    expect(summary.kind).toBe('ok');
    expect(summary.busy).toEqual(['storage', 'updater', 'work']);
  });

  it('orders attention the way a person should look: storage, agent, live, updater, work', () => {
    const summary = summarizeSpaceHealth({
      storage: {
        health: { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
        stale: false
      },
      agent: { connection: 'disconnected', availability: 'too_old' },
      realtime: { state: 'disabled', graceElapsed: false },
      work: { batchRunning: false, sessionOnly: true },
      updater: updater({ failingCount: 2 })
    });
    expect(summary.attention).toEqual(['storage', 'agent', 'realtime', 'updater', 'work']);
    expect(summary.busy).toEqual([]);
  });

  it('carries attention and work together', () => {
    const summary = summarizeSpaceHealth({
      ...healthy,
      realtime: { state: 'reconnecting', graceElapsed: true },
      work: { batchRunning: true, sessionOnly: false }
    });
    expect(summary.kind).toBe('attention');
    expect(summary.attention).toEqual(['realtime']);
    expect(summary.busy).toEqual(['work']);
  });

  it('covers every combination of the five tones without losing a source', () => {
    const storages: Array<SpaceHealthInput['storage']> = [
      { health: connected, stale: false },
      {
        health: { kind: 'indexing', indexedFolders: 0, totalFolders: null, files: 0 },
        stale: false
      },
      { health: connected, stale: true }
    ];
    const agents: Array<SpaceHealthInput['agent']> = [
      { connection: 'connected', availability: 'ready' },
      { connection: 'disconnected', availability: 'disconnected' }
    ];
    const lives: Array<SpaceHealthInput['realtime']> = [
      { state: 'connected', graceElapsed: false },
      { state: 'disabled', graceElapsed: false }
    ];
    const works: Array<SpaceHealthInput['work']> = [
      { batchRunning: false, sessionOnly: false },
      { batchRunning: true, sessionOnly: false },
      { batchRunning: false, sessionOnly: true }
    ];
    const updaters = [updater(), updater({ activeCount: 1 }), updater({ failingCount: 1 })];
    for (const storage of storages)
      for (const agent of agents)
        for (const realtime of lives)
          for (const work of works)
            for (const state of updaters) {
              const summary = summarizeSpaceHealth({
                storage,
                agent,
                realtime,
                work,
                updater: state
              });
              const listed = [...summary.attention, ...summary.busy];
              expect(new Set(listed).size).toBe(listed.length);
              expect(summary.kind).toBe(summary.attention.length > 0 ? 'attention' : 'ok');
              for (const source of summary.attention)
                expect(summary.tones[source]).toBe('attention');
              for (const source of summary.busy) expect(summary.tones[source]).toBe('busy');
            }
  });
});
