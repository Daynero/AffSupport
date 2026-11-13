import { claimRestitchForInstalledAgent } from '../restitch/claim';
import { useEffect, useRef, useState } from 'react';
import {
  parseMaterialRestitchPrep,
  usablePrep,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import { cancelTeamAgentProcess, startTeamAgentProcess, toolEventUrl } from '../../api/client';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { useOptionalAgent } from '../../AgentContext';
import { teamApi, type RestitchClaim } from '../../api/team';
import { ensureRestitchImages } from '../restitch/images';
import { withReadDeadline } from '../readCoordinator';
import {
  backgroundRecoveryStatus,
  ensureBackgroundRecovery,
  RECOVERY_CHANGED,
  type BackgroundRecoveryStatus,
  type RecoverySetupObservation
} from '../../api/recovery';

/**
 * This tab as a preparer of the catalog updater's spare copies (023).
 *
 * While the space's updater runs with re-stitching on, a member who may process and whose Soty app is
 * connected lends the app to it: the tab asks drive-ops for the next copy to make, hands the process to
 * the app — the same re-stitch the app already runs for a download — and keeps the lease while it
 * works. The copy lands through the ordinary finalize, where the server makes it the catalog's spare.
 * With no tab like this open, rounds keep moving the IDs and the sheets keep their video.
 *
 * One lease per member is enforced by the database, so a second tab of the same member simply finds
 * nothing to do.
 */

const POLL_MS = 30_000;
const AFTER_JOB_MS = 3_000;
const HEARTBEAT_MS = 25_000;
const PROGRESS_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface RestitchPreparerClient {
  claimRestitchJob: (teamId: string) => Promise<RestitchClaim | null>;
  heartbeatRestitchJob: (
    jobId: string,
    leaseToken: string,
    progress?: RestitchProgress
  ) => Promise<boolean>;
  completeRestitchJob: (input: {
    jobId: string;
    leaseToken: string;
    outcome: 'finalized' | 'failed';
    errorCode: string | null;
  }) => Promise<boolean>;
  startProcess: typeof startTeamAgentProcess;
  cancelProcess: typeof cancelTeamAgentProcess;
  ensureImages?: typeof ensureRestitchImages;
}

const defaultClient: RestitchPreparerClient = {
  claimRestitchJob: claimRestitchForInstalledAgent,
  heartbeatRestitchJob: (jobId, leaseToken, progress) =>
    teamApi.heartbeatRestitchJob(jobId, leaseToken, progress),
  completeRestitchJob: input => teamApi.completeRestitchJob(input),
  startProcess: startTeamAgentProcess,
  cancelProcess: cancelTeamAgentProcess,
  ensureImages: ensureRestitchImages
};

type RestitchProgressStage = 'downloading' | 'processing' | 'uploading' | 'finalizing';
interface RestitchProgress {
  progress: number;
  stage: RestitchProgressStage;
}
const PROGRESS_STAGES: readonly string[] = ['downloading', 'processing', 'uploading', 'finalizing'];

/** A preparation the app can trust for this exact file, or none — the run then inspects for itself. */
function preparedFor(claim: RestitchClaim): unknown {
  const parsed = parseMaterialRestitchPrep(claim.options.prepared);
  return usablePrep(parsed.ok ? parsed.value : null, claim.videoDriveVersion);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(message) ? message : 'PROCESS_FAILED';
}

/** Runs one claimed job to its end; resolves once the server has been told. */
export async function runRestitchClaim(
  claim: RestitchClaim,
  client: RestitchPreparerClient,
  isStopped: () => boolean,
  liveProgress: () => RestitchProgress | null = () => null,
  teamId?: string
): Promise<void> {
  let cancelled = false;
  let reporting = false;
  let lastReport: RestitchProgress | null = null;
  let lastHeartbeatAt = Date.now();
  const heartbeat = window.setInterval(() => {
    if (reporting || cancelled) return;
    const progress = liveProgress();
    if (
      Date.now() - lastHeartbeatAt < HEARTBEAT_MS &&
      (!progress ||
        (lastReport?.progress === progress.progress && lastReport.stage === progress.stage))
    )
      return;
    reporting = true;
    void client
      .heartbeatRestitchJob(claim.jobId, claim.leaseToken, progress ?? undefined)
      .then(cancel => {
        lastHeartbeatAt = Date.now();
        lastReport = progress;
        if (cancel && !cancelled) {
          cancelled = true;
          void client.cancelProcess(claim.operationId).catch(() => false);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        reporting = false;
      });
  }, PROGRESS_POLL_MS);
  let outcome: 'finalized' | 'failed' = 'failed';
  let code: string | null = null;
  try {
    // A job that carries the space's drawn pictures (030) needs nothing from any library.
    const drawn = Array.isArray(claim.options.screens) ? claim.options.screens : null;
    if (!drawn && client.ensureImages && teamId) {
      await client.ensureImages(teamId, claim.options.defaults as TeamRestitchDefaults);
    }
    const result = await client.startProcess({
      operationId: claim.operationId,
      toolId: claim.toolId,
      options: {
        defaults: claim.options.defaults,
        prepared: preparedFor(claim),
        ...(drawn ? { screens: drawn, teamId: claim.options.teamId ?? teamId } : {})
      },
      sourceGrant: claim.sourceGrant,
      finalizeGrant: claim.finalizeGrant
    });
    if (result.state === 'succeeded') outcome = 'finalized';
    else code = 'PROCESS_FAILED';
  } catch (error) {
    code = errorCode(error);
  } finally {
    window.clearInterval(heartbeat);
  }
  // A run the updater called off needs no report; nor does one this tab abandoned on unmount.
  if (cancelled || (isStopped() && code === 'PROCESS_CANCELED')) return;
  await client
    .completeRestitchJob({
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      outcome,
      errorCode: outcome === 'failed' ? code : null
    })
    .catch(() => false);
}

export function useRestitchPreparer(input: {
  teamId: string;
  /** Updater running with re-stitching on, the member may process, and the app is connected. */
  enabled: boolean;
  client?: RestitchPreparerClient;
  /** Told once when the server says this page is too old to claim (030); claiming then stops. */
  onOutdated?: () => void;
  onAgentOutdated?: () => void;
  /** Current authorized workspace session; absence keeps the legacy read-only owner. */
  automatic?: { actorId: string; sessionKey: string };
  onSetupStage?: (event: RecoverySetupObservation) => void;
}): {
  preparing: boolean;
  backgroundStatus: BackgroundRecoveryStatus | null;
  setupErrorCode: string | null;
} {
  const { teamId, enabled } = input;
  const agentOutdatedRef = useRef(input.onAgentOutdated);
  agentOutdatedRef.current = input.onAgentOutdated;
  const outdatedRef = useRef(input.onOutdated);
  outdatedRef.current = input.onOutdated;
  const clientRef = useRef(input.client ?? defaultClient);
  clientRef.current = input.client ?? defaultClient;
  const [preparing, setPreparing] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const progressRef = useRef<RestitchProgress | null>(null);
  const agent = useOptionalAgent();
  const [backgroundStatus, setBackgroundStatus] = useState<BackgroundRecoveryStatus | null>(null);
  const [setupErrorCode, setSetupErrorCode] = useState<string | null>(null);
  const automaticActor = input.automatic?.actorId;
  const automaticSession = input.automatic?.sessionKey;
  const setupStageRef = useRef(input.onSetupStage);
  setupStageRef.current = input.onSetupStage;

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
      const operation = event.operations.find(item => item.operationId === watching);
      if (
        operation?.state !== 'running' ||
        !PROGRESS_STAGES.includes(operation.stage) ||
        !Number.isFinite(operation.progress)
      )
        return;
      progressRef.current = {
        progress: Math.max(0, Math.min(100, Math.round(operation.progress))),
        stage: operation.stage as RestitchProgressStage
      };
    }
  });

  const nativeSupported = agent?.capabilities?.includes('team-background-recovery') === true;
  const actorBound = agent?.capabilities?.includes('team-background-recovery-actor-bound') === true;
  const agentConnected = agent?.connection === 'connected';
  const nativeInstanceId = agent?.lastKnownAgent?.instanceId;
  // Unknown native status must not start a competing browser executor.
  const [nativeOwner, setNativeOwner] = useState<boolean | null>(null);
  useEffect(() => {
    setBackgroundStatus(null);
    setSetupErrorCode(null);
    if (!nativeSupported) {
      setNativeOwner(false);
      return;
    }
    if (!agentConnected) {
      setNativeOwner(null);
      return;
    }
    let live = true;
    let revision = 0;
    let retry: number | null = null;
    let requestController: AbortController | null = null;
    let failures = 0;
    setNativeOwner(null);
    const refresh = () => {
      if (retry !== null) window.clearTimeout(retry);
      retry = null;
      const requestedRevision = ++revision;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      setNativeOwner(null);
      const isCurrent = () => live && requestedRevision === revision && !controller.signal.aborted;
      void withReadDeadline(signal => backgroundRecoveryStatus(teamId, signal), controller.signal)
        .then(async value => {
          if (!isCurrent()) return;
          setBackgroundStatus(value);
          if (automaticActor && actorBound) {
            // Native ownership is the only executor in the automatic mode.
            // A disabled/unknown response must not open a browser claim race.
            if (['eligible', 'pending'].includes(value.automaticSetup ?? '')) {
              value = await ensureBackgroundRecovery(teamId, {
                actorId: automaticActor,
                isCurrent,
                signal: controller.signal,
                onSetupStage: event => setupStageRef.current?.(event)
              });
            } else if (!value.enabled && !value.automaticSetup) {
              throw new Error('AGENT_UPDATE_REQUIRED');
            }
          }
          if (!isCurrent()) return;
          failures = 0;
          setBackgroundStatus(value);
          setSetupErrorCode(null);
          setNativeOwner(automaticActor && actorBound ? true : value.enabled);
          // The native credential can expire while this tab stays open. Re-read
          // ownership without making the browser a second worker.
          if (automaticActor && actorBound) retry = window.setTimeout(refresh, MAX_BACKOFF_MS);
        })
        .catch(error => {
          if (isCurrent()) {
            setNativeOwner(null);
            const code = errorCode(error);
            setSetupErrorCode(code);
            if (
              [
                'AGENT_UPDATE_REQUIRED',
                'PERMISSION_DENIED',
                'ENTITLEMENT_BLOCKED',
                'ENTITLEMENT_SIGNIN_REQUIRED',
                'AUTH_REQUIRED'
              ].includes(code)
            )
              return;
            // A transient loopback failure must not disable preparation until
            // the next focus/reconnect. Keep ownership unknown until a fresh read.
            failures += 1;
            retry = window.setTimeout(
              refresh,
              Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures - 1, 4))
            );
          }
        });
    };
    refresh();
    const changedInAnotherTab = (event: StorageEvent) => {
      if (event.key === RECOVERY_CHANGED) refresh();
    };
    window.addEventListener(RECOVERY_CHANGED, refresh);
    window.addEventListener('storage', changedInAnotherTab);
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      requestController?.abort();
      if (retry !== null) window.clearTimeout(retry);
      window.removeEventListener(RECOVERY_CHANGED, refresh);
      window.removeEventListener('storage', changedInAnotherTab);
      window.removeEventListener('focus', refresh);
    };
  }, [
    teamId,
    nativeSupported,
    actorBound,
    agentConnected,
    nativeInstanceId,
    automaticActor,
    automaticSession
  ]);

  useEffect(() => {
    if (!enabled || (nativeSupported && (!agentConnected || nativeOwner !== false))) return;
    let stopped = false;
    let timer: number | null = null;
    let failures = 0;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      timer = null;
      if (stopped) return;
      let claim: RestitchClaim | null;
      try {
        claim = await clientRef.current.claimRestitchJob(teamId);
        failures = 0;
      } catch (error) {
        // This page predates the space's settings (030): nothing it claims could be run, so it
        // stops asking until it is reloaded, and says so once.
        if (errorCode(error) === 'AGENT_UPDATE_REQUIRED') {
          stopped = true;
          agentOutdatedRef.current?.();
          return;
        }
        if (errorCode(error) === 'RESTITCH_CLIENT_OUTDATED') {
          stopped = true;
          outdatedRef.current?.();
          return;
        }
        failures += 1;
        schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures - 1, 4)));
        return;
      }
      if (stopped) {
        // A focus/ownership change can stop this executor while its cloud claim
        // is in flight. It has never reached the app, so return the lease.
        if (claim) {
          await clientRef.current
            .completeRestitchJob({
              jobId: claim.jobId,
              leaseToken: claim.leaseToken,
              outcome: 'failed',
              errorCode: 'PROCESS_CANCELED'
            })
            .catch(() => false);
        }
        return;
      }
      if (!claim) {
        schedule(POLL_MS);
        return;
      }
      setPreparing(true);
      progressRef.current = { progress: 0, stage: 'downloading' };
      setWatching(claim.operationId);
      try {
        await runRestitchClaim(
          claim,
          clientRef.current,
          () => stopped,
          () => progressRef.current,
          teamId
        );
      } finally {
        progressRef.current = null;
        if (!stopped) {
          setWatching(null);
          setPreparing(false);
        }
      }
      schedule(AFTER_JOB_MS);
    };

    schedule(AFTER_JOB_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      setPreparing(false);
    };
  }, [enabled, teamId, nativeSupported, nativeOwner, agentConnected, nativeInstanceId]);

  return { preparing, backgroundStatus, setupErrorCode };
}
