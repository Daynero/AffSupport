/**
 * One re-stitched download, from the click to the file.
 *
 * Kept out of the row menu on purpose: a menu is a menu, and this holds a running operation,
 * a remembered folder, a result that outlives the run and a request that may be waiting for a
 * space to be configured. The menu asks; this does.
 *
 * The order matters and is the whole feature: read the space's defaults, read anything already
 * known about the material, and hand both to the agent. With a preparation in hand the agent
 * skips reading the file's keyframe index and searching it for existing screens — six to
 * fourteen seconds, measured — which is what makes ten seconds achievable at all. Without one
 * it does the work and hands back what it found, and that is stored so nobody pays twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaterialRestitchPrep, TeamRestitchDefaults } from '@video-compressor/shared';
import { usablePrep } from '@video-compressor/shared';
import {
  agentCanRestitch,
  cancelTeamDownload,
  downloadTeamFileWithAgent,
  toolEventUrl
} from '../../api/client';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { useOptionalAgent } from '../../AgentContext';
import { teamApi } from '../../api/team';
import { completeTeamWorkflow, startTeamWorkflow } from '../../analytics/service';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

export type RestitchDeliveryPhase =
  /** Waiting for the person to say where it goes — asked once per space, then remembered. */
  'choosing' | 'transferring' | 'inspecting' | 'stitching' | 'saving';

export type RestitchDeliveryState =
  | { kind: 'idle' }
  | {
      kind: 'running';
      phase: RestitchDeliveryPhase;
      fileName: string;
      /** How far through the phase, 0–100, when the agent has said. */
      progress?: number;
    }
  | { kind: 'delivered'; fileName: string }
  | { kind: 'failed'; message: string }
  /** The space has no defaults yet; the caller raises the toast that offers to set them. */
  | { kind: 'unconfigured' };

export interface RestitchDeliveryTarget {
  materialId: string;
  fileName: string;
  driveVersion: string | null;
}

/** Where this member's re-stitched files land, remembered per space in their own browser. */
function folderKey(teamId: string): string {
  return `wishly.team-restitch-folder.v1:${teamId}`;
}

function rememberedFolder(teamId: string): string | null {
  try {
    return localStorage.getItem(folderKey(teamId));
  } catch {
    // A browser that refuses storage simply asks where to save every time.
    return null;
  }
}

function rememberFolder(teamId: string, folder: string): void {
  try {
    localStorage.setItem(folderKey(teamId), folder);
  } catch {
    // A browser that refuses storage simply asks where to save every time, which is the
    // behaviour this exists to avoid rather than to guarantee.
  }
}

export function forgetRestitchFolder(teamId: string): void {
  try {
    localStorage.removeItem(folderKey(teamId));
  } catch {
    // Nothing to do: the next delivery asks, which is the behaviour being restored anyway.
  }
}

/** Phase from the agent's progress, so the row names a step rather than a percentage. */
function phaseFor(progress: number): RestitchDeliveryPhase {
  if (progress < 5) return 'transferring';
  if (progress < 45) return 'inspecting';
  if (progress < 95) return 'stitching';
  return 'saving';
}

/**
 * The step behind each stage the agent reports.
 *
 * A delivery is three waits in a row — the video arrives, it is re-stitched, it is written
 * where it was asked for — and each of them now reports its own percentage. Before this the
 * row named a step once, at the start, and then stood still until the file appeared: a
 * minute of "looking at the video" is indistinguishable from a hang.
 */
const PHASE_BY_STAGE: Record<string, RestitchDeliveryPhase> = {
  downloading: 'transferring',
  processing: 'stitching',
  finalizing: 'saving',
  uploading: 'saving'
};

/**
 * The order the steps happen in, so a bar can only go forwards.
 *
 * The interface guesses a step before the run starts — it knows whether the space had this
 * material prepared — and the agent's first message is about the step *before* that guess.
 * Without this the bar jumped to the middle and then fell back to the start, which reads as
 * the work being redone.
 */
const PHASE_ORDER: RestitchDeliveryPhase[] = [
  'choosing',
  'transferring',
  'inspecting',
  'stitching',
  'saving'
];

/** What the interface says about a refusal, when the agent said which one it was. */
const REFUSAL_COPY = {
  'video-codec': 'stitcherUnsupportedVideoCodec',
  'audio-codec': 'stitcherUnsupportedAudioCodec',
  'variable-frame-rate': 'stitcherUnsupportedVariableFrameRate',
  container: 'stitcherUnsupportedContainer',
  unreadable: 'stitcherUnsupportedUnreadable',
  // These two are not about the file: the space has chosen no screen, or the video carries
  // nothing to take off. Saying "some of that is not valid" for either sent people looking
  // for a bad field that does not exist.
  'no-screens': 'teamRestitchNoScreens',
  'nothing-to-remove': 'stitcherNothingToRemove'
} as const;

function refusalMessage(error: unknown): keyof typeof REFUSAL_COPY | null {
  if (!error || typeof error !== 'object' || !('reason' in error)) return null;
  const { reason } = error as { reason: unknown };
  return typeof reason === 'string' && reason in REFUSAL_COPY
    ? (reason as keyof typeof REFUSAL_COPY)
    : null;
}

export function useRestitchDelivery(teamId: string) {
  const { t } = useI18n();
  const [states, setStates] = useState<Record<string, RestitchDeliveryState>>({});
  const [pending, setPending] = useState<RestitchDeliveryTarget | null>(null);
  const defaults = useRef<TeamRestitchDefaults | null>(null);
  const running = useRef(new AbortController());
  /** The agent-side run behind each material, so it can be stopped by name. */
  const operations = useRef(new Map<string, string>());
  /**
   * Which material the agent's progress belongs to.
   *
   * Deliveries run one at a time (the shell queues a selection), so one pair is enough —
   * and state rather than a ref, because the event subscription below has to start and stop
   * with it.
   */
  const [watching, setWatching] = useState<{ materialId: string; operationId: string } | null>(
    null
  );

  // Leaving the folder or the page ends a delivery as cleanly as pressing cancel: the run is
  // abandoned rather than left writing into a view nobody is looking at (FR-013).
  useEffect(() => {
    const controller = running.current;
    return () => controller.abort();
  }, []);

  const set = useCallback((materialId: string, state: RestitchDeliveryState) => {
    setStates(current => ({ ...current, [materialId]: state }));
  }, []);

  /*
   * The agent's own progress, followed while a delivery runs.
   *
   * The same channel the process panel listens to: the download bridge publishes the bytes
   * as the source arrives, the stitch as it is joined, and the copy into the chosen folder.
   * Without this the row named its first step and then said nothing for minutes.
   */
  const agent = useOptionalAgent();
  useAgentEventStream<{
    type: 'team:operations';
    operations: Array<{ operationId: string; state: string; stage: string; progress: number }>;
  }>({
    url: watching ? toolEventUrl('team') : null,
    channel: 'team',
    multiplexed: Boolean(agent?.capabilities?.includes('event-stream')),
    enabled: Boolean(watching),
    onMessage: event => {
      if (event.type !== 'team:operations' || !watching) return;
      const live = event.operations.find(item => item.operationId === watching.operationId);
      if (!live || live.state !== 'running') return;
      setStates(current => {
        const state = current[watching.materialId];
        // The folder question is a person deciding, not the machine working: a stage that
        // arrives while the picker is open must not overwrite it.
        if (!state || state.kind !== 'running' || state.phase === 'choosing') return current;
        const reported = PHASE_BY_STAGE[live.stage] ?? state.phase;
        // Never backwards: the guess made before the request is only a guess, but a step
        // already reached has happened.
        const phase =
          PHASE_ORDER.indexOf(reported) >= PHASE_ORDER.indexOf(state.phase)
            ? reported
            : state.phase;
        const progress = Math.max(0, Math.min(100, Math.round(live.progress)));
        if (state.phase === phase && state.progress === progress) return current;
        return { ...current, [watching.materialId]: { ...state, phase, progress } };
      });
    }
  });

  const deliver = useCallback(
    async (target: RestitchDeliveryTarget): Promise<void> => {
      const known = defaults.current ?? (await teamApi.getRestitchDefaults(teamId));
      defaults.current = known;
      if (!known) {
        // Not a failure — the space simply has not been set up. The caller offers to do it,
        // and remembers what was asked for so it can continue afterwards.
        setPending(target);
        set(target.materialId, { kind: 'unconfigured' });
        return;
      }
      const capability = await agentCanRestitch();
      if (capability !== 'yes') {
        // An app that never answered is not an old app: it is one that is not running, or
        // one this page has lost its pairing with — and the sentence for that says so.
        set(target.materialId, {
          kind: 'failed',
          message: t(
            capability === 'too-old' ? 'teamRestitchAgentTooOld' : 'teamRestitchAgentMissing'
          )
        });
        return;
      }

      const operationId = crypto.randomUUID();
      operations.current.set(target.materialId, operationId);
      setWatching({ materialId: target.materialId, operationId });
      const folder = rememberedFolder(teamId);
      // The first delivery in a space opens the app's own folder picker, and the wait for it
      // is a person deciding — not a machine working. Saying "transferring" through that is
      // how a two-second choice reads as a thirty-second hang.
      set(target.materialId, {
        kind: 'running',
        phase: folder ? 'transferring' : 'choosing',
        fileName: target.fileName
      });
      // Timed from the click, and told apart by whether the space had been prepared — the one
      // comparison that says whether preparation is earning its keep (SC-001, SC-003).
      let flow: ReturnType<typeof startTeamWorkflow> | null = null;
      try {
        const found = await teamApi.getMaterialRestitchPrep(teamId, [target.materialId]);
        const prepared = usablePrep(found.get(target.materialId) ?? null, target.driveVersion);
        flow = startTeamWorkflow({
          category: 'video',
          cacheState: prepared ? 'warm' : 'cold',
          stage: 'downloading'
        });
        /*
         * The video has to arrive before anything can be done to it, and the agent reports
         * that arrival by the byte. Naming a later step here — which this did, because it
         * knew whether the material had been prepared — put the bar in the middle before
         * the first byte had been fetched.
         */
        set(target.materialId, {
          kind: 'running',
          phase: 'transferring',
          fileName: target.fileName
        });

        const grant = await teamApi.requestDownload(teamId, target.materialId, 'agent');
        if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');

        const saved = await downloadTeamFileWithAgent({
          operationId,
          transferUrl: grant.transferUrl,
          transferGrant: grant.grant,
          fileName: target.fileName,
          destination: folder,
          process: { tool: 'restitch', defaults: known, prepared }
        });

        // What the run had to work out is worth more than this delivery: stored, the next
        // member's download of the same material skips it entirely.
        const discovered = (saved as { discovered?: unknown }).discovered;
        if (discovered && target.driveVersion) {
          const record = discovered as Omit<
            MaterialRestitchPrep,
            'materialId' | 'driveVersion' | 'preparedAt'
          > & { detectorVersion?: number };
          await teamApi
            .setMaterialRestitchPrep({
              ...record,
              materialId: target.materialId,
              driveVersion: target.driveVersion,
              /* The agent's own stamp, never one invented here: the agent ships separately
                 and can be older than this page. An agent that sends none leaves a record at
                 version zero, which no build claims, so it is simply never reused. */
              detectorVersion: Math.max(0, Math.trunc(record.detectorVersion ?? 0)),
              unsupportedReason: null,
              preparedAt: new Date().toISOString()
            })
            .catch(() => {
              // Storing it is an optimisation for next time, never a reason to fail a file
              // the member already has.
            });
        }
        // Asked once, then never again for this space.
        if (saved.destination) rememberFolder(teamId, saved.destination);
        setWatching(null);
        set(target.materialId, { kind: 'delivered', fileName: saved.fileName });
        if (flow) completeTeamWorkflow(flow, { outcome: 'success', retryable: false });
      } catch (error) {
        const canceled = error instanceof Error && error.message === 'DOWNLOAD_CANCELED';
        setWatching(null);
        // A refusal says which of its five reasons it was, when the agent named one: "this
        // file type is not supported" is the wrong sentence for a video whose frame rate
        // varies, and the interface already holds the right one for each.
        const refusal = refusalMessage(error);
        // A download somebody stopped is not a failure, and a red message for a button they
        // pressed themselves reads as one.
        set(
          target.materialId,
          canceled
            ? { kind: 'idle' }
            : {
                kind: 'failed',
                message: refusal ? t(REFUSAL_COPY[refusal]) : teamErrorMessageFor(error, t)
              }
        );
        if (flow) {
          const canceled = error instanceof Error && error.message === 'PROCESS_CANCELED';
          completeTeamWorkflow(flow, {
            outcome: canceled ? 'cancelled' : 'failure',
            retryable: !canceled
          });
        }
      }
    },
    [teamId, set, t]
  );

  /**
   * Continue the delivery that met an unconfigured space.
   *
   * Called once the settings are saved, so the member gets the file they asked for without a
   * second click (FR-011).
   */
  const resume = useCallback(async () => {
    const target = pending;
    if (!target) return;
    setPending(null);
    defaults.current = null;
    await deliver(target);
  }, [pending, deliver]);

  /** Abandons the run behind one material; the agent stops the transfer and the work with it. */
  const cancel = useCallback((materialId: string) => {
    const operationId = operations.current.get(materialId);
    if (!operationId) return;
    void cancelTeamDownload(operationId).catch(() => undefined);
  }, []);

  return {
    states,
    pending,
    deliver,
    resume,
    cancel,
    clearPending: () => setPending(null),
    phaseFor
  };
}
