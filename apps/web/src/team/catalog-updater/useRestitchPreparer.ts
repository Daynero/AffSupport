import { useEffect, useRef, useState } from 'react';
import { parseMaterialRestitchPrep, usablePrep } from '@video-compressor/shared';
import { cancelTeamAgentProcess, startTeamAgentProcess } from '../../api/client';
import { teamApi, type RestitchClaim } from '../../api/team';

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
const MAX_BACKOFF_MS = 5 * 60_000;

export interface RestitchPreparerClient {
  claimRestitchJob: (teamId: string) => Promise<RestitchClaim | null>;
  heartbeatRestitchJob: (jobId: string, leaseToken: string) => Promise<boolean>;
  completeRestitchJob: (input: {
    jobId: string;
    leaseToken: string;
    outcome: 'finalized' | 'failed';
    errorCode: string | null;
  }) => Promise<boolean>;
  startProcess: typeof startTeamAgentProcess;
  cancelProcess: typeof cancelTeamAgentProcess;
}

const defaultClient: RestitchPreparerClient = {
  claimRestitchJob: teamId => teamApi.claimRestitchJob(teamId),
  heartbeatRestitchJob: (jobId, leaseToken) => teamApi.heartbeatRestitchJob(jobId, leaseToken),
  completeRestitchJob: input => teamApi.completeRestitchJob(input),
  startProcess: startTeamAgentProcess,
  cancelProcess: cancelTeamAgentProcess
};

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
  isStopped: () => boolean
): Promise<void> {
  let cancelled = false;
  const heartbeat = window.setInterval(() => {
    void client
      .heartbeatRestitchJob(claim.jobId, claim.leaseToken)
      .then(cancel => {
        if (cancel && !cancelled) {
          cancelled = true;
          void client.cancelProcess(claim.operationId).catch(() => false);
        }
      })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  let outcome: 'finalized' | 'failed' = 'failed';
  let code: string | null = null;
  try {
    const result = await client.startProcess({
      operationId: claim.operationId,
      toolId: claim.toolId,
      options: { defaults: claim.options.defaults, prepared: preparedFor(claim) },
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
}): { preparing: boolean } {
  const { teamId, enabled } = input;
  const clientRef = useRef(input.client ?? defaultClient);
  clientRef.current = input.client ?? defaultClient;
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!enabled) return;
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
      } catch {
        failures += 1;
        schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures - 1, 4)));
        return;
      }
      if (stopped) return;
      if (!claim) {
        schedule(POLL_MS);
        return;
      }
      setPreparing(true);
      try {
        await runRestitchClaim(claim, clientRef.current, () => stopped);
      } finally {
        if (!stopped) setPreparing(false);
      }
      schedule(AFTER_JOB_MS);
    };

    schedule(AFTER_JOB_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      setPreparing(false);
    };
  }, [enabled, teamId]);

  return { preparing };
}
