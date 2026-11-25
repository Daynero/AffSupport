/**
 * The space preparing itself while Soty is free (071, owner 2026-11-25).
 *
 * «Перезашиті відео — за секунди» needs every video of the space read once. Pressing the button
 * and waiting for 256 videos is not something anybody does, so a space with re-stitching
 * configured now prepares itself: while a page of Soty is open on this computer and its app has
 * nothing else to do, one video at a time is read with low priority and stored, exactly as the
 * button would.
 *
 * Who decides what:
 *
 * - **This page** decides *which* video and keeps the record — it holds the person's session,
 *   issues each download grant right before its video and writes what was found, as the manual
 *   run does. One video per run, so a grant is never older than its file.
 * - **The app** decides *when*. A background run is never counted as busy; it asks before every
 *   file and every second during one whether anything else is running in Soty or the machine is
 *   loaded, and if so abandons the file it holds (nothing half-read is stored) and ends as
 *   `yielded`. Its conversions use one thread. The page asks `prepare/background` before each run.
 * - **The person** decides *whether*: «Готувати автоматично» in the preparation card, on by
 *   default, kept per space on this computer — it is this computer's app doing the work.
 *
 * Limits (MVP): nothing happens while no page of Soty is open — the app alone cannot list a
 * space or keep a record without the person's session. A manual run always wins: the
 * background one stops and waits while the button's run goes.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { usablePrep, type TeamMaterialRow } from '@video-compressor/shared';
import {
  cancelTeamRestitchPreparation,
  prepareTeamRestitchMaterials,
  readTeamRestitchPreparation,
  teamRestitchBackgroundAllowed,
  type TeamRestitchPreparationPhase
} from '../../api/client';
import { teamApi } from '../../api/team';
import { useAgentStatus } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { listVideos } from './useRestitchPreparation';

/** A page that just opened leaves the first minute to the person. */
const START_DELAY_MS = 20_000;
/** How long to leave a busy Soty (or an unreachable one) before asking again. */
const BUSY_RETRY_MS = 60_000;
/** How long a space with nothing left to read is left alone before it is counted again. */
const REST_MS = 10 * 60_000;
const POLL_MS = 1_000;

export interface RestitchBackgroundState {
  teamId: string | null;
  /**
   * `off`: switched off for this space · `waiting`: Soty or the machine is busy, or a manual run
   * goes · `running`: a video is being read · `idle`: nothing left to read (or nothing to read for).
   */
  status: 'off' | 'waiting' | 'running' | 'idle';
  current: { name: string; since: number } | null;
  phase: TeamRestitchPreparationPhase | null;
  progress: number;
  bytes: number;
  bytesTotal: number | null;
  /** Videos stored by background runs on this page; a revision for the readiness count. */
  prepared: number;
}

const INITIAL: RestitchBackgroundState = {
  teamId: null,
  status: 'idle',
  current: null,
  phase: null,
  progress: 0,
  bytes: 0,
  bytesTotal: null,
  prepared: 0
};

let state: RestitchBackgroundState = INITIAL;
const listeners = new Set<() => void>();
const manual = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function publish(patch: Partial<RestitchBackgroundState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the background preparation is doing, for the card. */
export function useRestitchBackground(): RestitchBackgroundState {
  return useSyncExternalStore(subscribe, () => state);
}

/** The manual run tells the background one to stand aside while it goes. */
export function setManualPreparation(teamId: string, running: boolean): void {
  if (running) manual.add(teamId);
  else manual.delete(teamId);
  emit();
}

const PREFERENCE_PREFIX = 'soty.restitch.autoPrepare.v1:';

/** «Готувати автоматично» for this space on this computer; on unless switched off. */
export function readAutoPrepare(teamId: string): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_PREFIX + teamId) !== 'off';
  } catch {
    return true;
  }
}

export function writeAutoPrepare(teamId: string, enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(PREFERENCE_PREFIX + teamId);
    else window.localStorage.setItem(PREFERENCE_PREFIX + teamId, 'off');
  } catch {
    // Unsaved, the choice still holds for this page.
  }
  if (state.teamId === teamId) publish({ status: enabled ? 'waiting' : 'off' });
  emit();
}

export function useAutoPrepare(teamId: string): boolean {
  return useSyncExternalStore(subscribe, () => readAutoPrepare(teamId));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

type Outcome = 'stored' | 'failed' | 'yielded' | 'stopped' | 'lost';

/** Follows one background run, storing its finding as the manual run does. */
async function follow(teamId: string, operationId: string, signal: AbortSignal): Promise<Outcome> {
  for (;;) {
    // The person's own run, or switching this off, stops the background one at once.
    if (signal.aborted || manual.has(teamId) || !readAutoPrepare(teamId)) {
      await cancelTeamRestitchPreparation(operationId).catch(() => false);
      return 'stopped';
    }
    const report = await readTeamRestitchPreparation(operationId).catch(() => null);
    if (!report) return 'lost';
    publish({
      phase: report.phase ?? null,
      progress: report.currentProgress ?? 0,
      bytes: report.currentBytes ?? 0,
      bytesTotal: report.currentBytesTotal ?? null
    });
    const finding = report.findings.find(entry => entry.state !== 'inspecting');
    if (finding) {
      if (finding.prep) {
        const stored = await teamApi
          .setMaterialRestitchPrep(finding.prep)
          .then(() => true)
          .catch(() => false);
        if (stored) return 'stored';
      }
      return 'failed';
    }
    if (report.state === 'yielded') return 'yielded';
    if (report.state !== 'running') return 'lost';
    await sleep(POLL_MS, signal);
  }
}

/** The loop for one space while it is open, enabled and allowed to process. */
async function run(teamId: string, signal: AbortSignal): Promise<void> {
  publish({ ...INITIAL, teamId, status: readAutoPrepare(teamId) ? 'waiting' : 'off' });
  await sleep(START_DELAY_MS, signal);
  let queue: TeamMaterialRow[] = [];
  let listedAt = 0;
  // A video that failed here is left for the button, which says why; retrying it every minute
  // would spend the machine on the one file that cannot be read.
  const skipped = new Set<string>();
  while (!signal.aborted) {
    try {
      if (!readAutoPrepare(teamId)) {
        publish({ status: 'off', current: null });
        await sleep(BUSY_RETRY_MS, signal);
        continue;
      }
      if (manual.has(teamId) || !(await teamRestitchBackgroundAllowed())) {
        publish({ status: 'waiting', current: null });
        await sleep(manual.has(teamId) ? POLL_MS * 30 : BUSY_RETRY_MS, signal);
        continue;
      }
      if (queue.length === 0 || Date.now() - listedAt > REST_MS) {
        // Both screens off is the one state with nothing to prepare for.
        const settings = await teamApi.getRestitchDefaults(teamId, { signal });
        if (signal.aborted) return;
        if (!settings) {
          publish({ status: 'idle', current: null });
          await sleep(REST_MS, signal);
          continue;
        }
        const videos = await listVideos(teamId, signal);
        if (signal.aborted) return;
        const known = await teamApi.getMaterialRestitchPrep(
          teamId,
          videos.map(video => video.id)
        );
        queue = videos.filter(
          video =>
            Boolean(video.driveVersion) &&
            !skipped.has(video.id) &&
            !usablePrep(known.get(video.id) ?? null, video.driveVersion)
        );
        listedAt = Date.now();
        if (queue.length === 0) {
          publish({ status: 'idle', current: null });
          await sleep(REST_MS, signal);
          listedAt = 0;
          continue;
        }
      }
      const video = queue[0]!;
      const grant = await teamApi.requestDownload(teamId, video.id, 'agent');
      if (grant.kind !== 'agent') return;
      if (signal.aborted) return;
      const operationId = crypto.randomUUID();
      await prepareTeamRestitchMaterials({
        operationId,
        teamId,
        transferUrl: grant.transferUrl,
        materials: [
          {
            materialId: video.id,
            driveVersion: video.driveVersion ?? '',
            fileName: video.name,
            transferGrant: grant.grant
          }
        ],
        audio: { sampleRate: 48000, channels: 2 },
        background: true
      });
      publish({
        status: 'running',
        current: { name: video.name, since: Date.now() },
        phase: 'downloading',
        progress: 0,
        bytes: 0,
        bytesTotal: null
      });
      const outcome = await follow(teamId, operationId, signal);
      publish({ current: null, phase: null, progress: 0, bytes: 0, bytesTotal: null });
      if (outcome === 'stored') {
        queue.shift();
        publish({ prepared: state.prepared + 1 });
      } else if (outcome === 'failed') {
        skipped.add(video.id);
        queue.shift();
      } else {
        publish({ status: 'waiting' });
        await sleep(outcome === 'stopped' ? POLL_MS * 30 : BUSY_RETRY_MS, signal);
      }
    } catch {
      // A refused grant, a lost session, an app restarting: none of it is worth a message for
      // work nobody asked for. The loop rests and asks again.
      if (signal.aborted) return;
      publish({ status: 'waiting', current: null });
      queue = [];
      await sleep(BUSY_RETRY_MS, signal);
    }
  }
}

/**
 * Mounted once in the application shell: the open space prepares itself while it can.
 * Renders nothing; the preparation card reads `useRestitchBackground`.
 */
export function RestitchBackgroundPreparation() {
  const { activeTeam, can } = useTeam();
  const agent = useAgentStatus();
  const teamId = activeTeam?.id ?? null;
  const enabled =
    Boolean(teamId) &&
    activeTeam?.connectionState === 'connected' &&
    can('process') &&
    agent.connection === 'connected';
  useEffect(() => {
    if (!enabled || !teamId) {
      publish({ ...INITIAL });
      return;
    }
    const controller = new AbortController();
    void run(teamId, controller.signal);
    return () => controller.abort();
  }, [enabled, teamId]);
  return null;
}
