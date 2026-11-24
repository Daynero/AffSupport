import { useEffect, useState } from 'react';
import type { StorageHealth } from '@video-compressor/shared';
import { useOptionalAgent, type Availability } from '../../AgentContext';
import type { CatalogUpdaterState } from '../../api/team';
import type { ConnectionState } from '../../connection';
import { useOptionalWorkspaceOperations } from '../explorer/WorkspaceOperationsProvider';
import { useOptionalLibraryProcessing } from '../library/LibraryProcessingProvider';
import { useTeam } from '../TeamContext';
import type { TeamRealtimeState } from '../useTeamRealtime';

/**
 * The space's health, said once (070, US5, R3).
 *
 * The header carried five chips — storage, the local app, live updates, the background work and
 * the catalog updater — and most of the time all five said "fine". Five green words are noise,
 * and noise is how a real problem gets missed. This folds the five sources the header already
 * had into one answer: `ok`, or `attention` with the sources that need a person, plus the
 * sources that are busy. Nothing new is read; it is a derived state.
 *
 * The order of `attention` is the order a person should look: storage first (without it there
 * are no files), then the local app, live updates, the updater, and a session-only journal.
 */

export type HealthSource = 'storage' | 'agent' | 'realtime' | 'updater' | 'work';

/**
 * `idle` — nothing to report and nothing wrong (no Drive yet, the first agent check, a live
 * channel inside its grace); `busy` — work is under way; `attention` — a person is needed.
 */
export type HealthTone = 'ok' | 'idle' | 'busy' | 'attention';

export const HEALTH_SOURCES: readonly HealthSource[] = [
  'storage',
  'agent',
  'realtime',
  'updater',
  'work'
];

export interface SpaceHealthInput {
  storage: {
    health: StorageHealth | null;
    /** The last good read is older than the chip trusts (028). */
    stale: boolean;
  };
  /** `null` outside the agent's provider (a test, a page with no local app). */
  agent: { connection: ConnectionState; availability: Availability } | null;
  realtime: { state: TeamRealtimeState; graceElapsed: boolean };
  work: { batchRunning: boolean; sessionOnly: boolean };
  updater: CatalogUpdaterState | null;
}

export interface SpaceHealth {
  kind: 'ok' | 'attention';
  tones: Record<HealthSource, HealthTone>;
  /** The sources that need a person, most important first. */
  attention: HealthSource[];
  /** The sources with work under way. */
  busy: HealthSource[];
}

export function storageTone(health: StorageHealth | null, stale: boolean): HealthTone {
  if (!health) return 'idle';
  if (stale) return 'attention';
  if (
    health.kind === 'attention' ||
    health.kind === 'disconnected' ||
    health.syncHealth === 'delayed' ||
    health.coverage === 'partial' ||
    health.coverage === 'permission_limited'
  )
    return 'attention';
  if (
    health.kind === 'indexing' ||
    health.kind === 'preparing' ||
    health.kind === 'waiting_provider'
  )
    return 'busy';
  return 'ok';
}

export function agentTone(agent: SpaceHealthInput['agent']): HealthTone {
  if (!agent) return 'idle';
  // The first check says nothing either way (AgentLinkChip): a chip that flashes
  // "connect Soty" on every page load is noise.
  if (agent.connection === 'checking' || agent.connection === 'connecting') return 'idle';
  return agent.availability === 'ready' ? 'ok' : 'attention';
}

export function realtimeTone(realtime: SpaceHealthInput['realtime']): HealthTone {
  if (realtime.state === 'connected') return 'ok';
  if (realtime.state === 'disabled') return 'attention';
  return realtime.graceElapsed ? 'attention' : 'idle';
}

/** The same reading as `CatalogUpdaterChip`: a waiting schedule is fine, a run is work. */
export function updaterTone(state: CatalogUpdaterState | null): HealthTone {
  if (!state || (state.state !== 'running' && !state.activeCount)) return 'ok';
  if (state.failingCount > 0 || state.restitchBlockedCode) return 'attention';
  const oneOff = state.state === 'stopped' || state.nextRunAt === null;
  if ((state.activeCount ?? 0) > 0 || oneOff) return 'busy';
  return 'ok';
}

export function workTone(work: SpaceHealthInput['work']): HealthTone {
  if (work.sessionOnly) return 'attention';
  return work.batchRunning ? 'busy' : 'ok';
}

export function summarizeSpaceHealth(input: SpaceHealthInput): SpaceHealth {
  const tones: Record<HealthSource, HealthTone> = {
    storage: storageTone(input.storage.health, input.storage.stale),
    agent: agentTone(input.agent),
    realtime: realtimeTone(input.realtime),
    updater: updaterTone(input.updater),
    work: workTone(input.work)
  };
  const attention = HEALTH_SOURCES.filter(source => tones[source] === 'attention');
  const busy = HEALTH_SOURCES.filter(source => tones[source] === 'busy');
  return { kind: attention.length > 0 ? 'attention' : 'ok', tones, attention, busy };
}

/**
 * A brief drop — or a slow first connect — is normal and self-healing; announcing either at once
 * would make the header flicker on every tab switch. Only a wait still unresolved after this long
 * is worth saying out loud.
 */
export const REALTIME_GRACE_MS = 8_000;

const WAITING: ReadonlySet<TeamRealtimeState> = new Set(['connecting', 'reconnecting']);

/** Whether live updates have been missing for longer than the grace. */
export function useRealtimeGrace(state: TeamRealtimeState): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!WAITING.has(state)) {
      setElapsed(false);
      return;
    }
    // Moving between the two waiting states restarts the timer but does not clear an elapsed
    // grace: once we have said live updates are missing, saying it differently is not a reason
    // to go quiet and flicker back.
    const timer = window.setTimeout(() => setElapsed(true), REALTIME_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return elapsed && WAITING.has(state);
}

/** Two minutes without a fresh read and the storage state is not trusted (028). */
export function storageStale(staleSince: number | null, now = Date.now()): boolean {
  return staleSince !== null && now - staleSince >= 2 * 60_000;
}

/**
 * The live hook: the five sources from where they already live. The storage health and the
 * updater state are the shell's (it reads them for other reasons too); the rest are contexts.
 */
export function useSpaceHealth({
  storage,
  staleSince,
  updater
}: {
  storage: StorageHealth | null;
  staleSince: number | null;
  updater: CatalogUpdaterState | null;
}): SpaceHealth & { realtimeGraceElapsed: boolean } {
  const { realtimeState } = useTeam();
  const graceElapsed = useRealtimeGrace(realtimeState);
  const agent = useOptionalAgent();
  const batch = useOptionalLibraryProcessing();
  const operations = useOptionalWorkspaceOperations();
  const summary = summarizeSpaceHealth({
    storage: { health: storage, stale: storageStale(staleSince) },
    agent: agent
      ? { connection: agent.connection, availability: agent.teamWorkspaceAvailability }
      : null,
    realtime: { state: realtimeState, graceElapsed },
    work: {
      batchRunning: batch?.phase === 'running',
      sessionOnly: Boolean(operations?.sessionOnly)
    },
    updater
  });
  return { ...summary, realtimeGraceElapsed: graceElapsed };
}
