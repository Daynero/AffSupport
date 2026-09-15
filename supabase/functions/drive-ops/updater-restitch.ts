import type { GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import { videoShareLink } from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';

/**
 * The catalog updater's spare copies, prepared by a member's open tab (feature 023).
 *
 * A signed-in member's Soty tab on a computer with the Soty app asks here for the next spare to make.
 * The process is started exactly as the member's own run would be — the same grants, as that member —
 * and the tab hands it to the app, which re-stitches the video and uploads the copy through the
 * ordinary output finalize, where `recordRestitchOutput` makes it the catalog's spare. The tab keeps
 * the lease while the app works and says how it went.
 *
 * Everything outside this file arrives as deps, so the handlers are tested without Deno or Drive.
 */

export const RESTITCH_TOOL_ID = 'restitch';
export const RESTITCH_CONTRACT_VERSION = 1;
const LEASE_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface ProcessGrants {
  operationId: string;
  sourceGrant: unknown;
  finalizeGrant: unknown;
}

export interface UpdaterRestitchDeps {
  /** A service-role RPC; database refusals arrive as `TeamFunctionError`s. */
  rpc(name: string, parameters: Record<string, unknown>): Promise<unknown>;
  /** drive-ops' own `process/start`, run as `actorId`. */
  startProcess(actorId: string, body: Record<string, unknown>): Promise<ProcessGrants>;
  /** Fails an operation a lapsed lease left open and releases the name it reserved. */
  abandonOperation(operationId: string): Promise<void>;
  /** SHA-256 as the `\x…` hex a bytea parameter takes. */
  hashHex(value: string): Promise<string>;
  /** 32 random bytes, base64url without padding. */
  randomToken(): string;
  log(message: string, detail: string): void;
}

export interface ClaimedRestitchJob {
  jobId: string;
  teamId: string;
  actorId: string;
  attempt: number;
  openOperationIds: string[];
  videoMaterialId: string;
  videoName: string;
  videoDriveVersion: string | null;
  destinationFolderId: string | null;
  updateCount: number;
  defaults: Record<string, unknown> | null;
  prepared: Record<string, unknown> | null;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  return value.toLowerCase();
}

function leaseToken(value: unknown): string {
  if (typeof value !== 'string' || !LEASE_TOKEN.test(value)) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  return value;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseClaimedRestitchJob(value: unknown): ClaimedRestitchJob | null {
  if (!isRecord(value)) return null;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  const jobId = text('jobId');
  const teamId = text('teamId');
  const actorId = text('actorId');
  const videoMaterialId = text('videoMaterialId');
  const videoName = text('videoName');
  const attempt = wholeNumber(value.attempt);
  const updateCount = wholeNumber(value.updateCount);
  if (
    !jobId ||
    !teamId ||
    !actorId ||
    !videoMaterialId ||
    !videoName ||
    attempt === null ||
    updateCount === null
  ) {
    return null;
  }
  return {
    jobId,
    teamId,
    actorId,
    attempt,
    openOperationIds: Array.isArray(value.openOperationIds)
      ? value.openOperationIds.filter((id): id is string => typeof id === 'string')
      : [],
    videoMaterialId,
    videoName,
    videoDriveVersion: text('videoDriveVersion'),
    destinationFolderId: text('destinationFolderId'),
    updateCount,
    defaults: isRecord(value.defaults) ? value.defaults : null,
    prepared: isRecord(value.prepared) ? value.prepared : null
  };
}

/** `clip.final.mp4`, update 3 → `clip.final restitched 4.mp4`. */
export function restitchedCopyName(videoName: string, updateCount: number): string {
  const stem = videoName.replace(/\.[^.]+$/u, '');
  return `${stem.length > 0 ? stem : videoName} restitched ${updateCount + 1}.mp4`;
}

async function fail(
  deps: UpdaterRestitchDeps,
  actorId: string,
  jobId: string,
  leaseHash: string,
  code: string
) {
  await deps
    .rpc('service_complete_restitch_job', {
      p_actor: actorId,
      p_job: jobId,
      p_lease_token_hash: leaseHash,
      p_outcome: 'failed',
      p_error: code
    })
    .catch(() => undefined);
}

export async function claimRestitchJob(
  deps: UpdaterRestitchDeps,
  actorId: string,
  body: Record<string, unknown>
) {
  const teamId = uuid(body.teamId);
  const lease = deps.randomToken();
  const leaseHash = await deps.hashHex(lease);
  const claimed = await deps.rpc('service_claim_restitch_job', {
    p_team: teamId,
    p_actor: actorId,
    p_lease_token_hash: leaseHash,
    p_lease_seconds: LEASE_SECONDS
  });
  if (claimed === null || claimed === undefined) return { job: null };
  const job = parseClaimedRestitchJob(claimed);
  if (!job) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: true });

  // Nothing a run could make without the space's re-stitch settings: fail the job, not the round.
  if (!job.defaults || job.defaults.configured !== true) {
    await fail(deps, actorId, job.jobId, leaseHash, 'RESTITCH_INVALID');
    return { job: null };
  }

  for (const operationId of job.openOperationIds) {
    await deps.abandonOperation(operationId).catch(error => {
      const code = error instanceof TeamFunctionError ? error.code : 'UNKNOWN';
      deps.log('[updater-restitch] earlier operation left open', `${operationId} ${code}`);
    });
  }

  let grants: ProcessGrants;
  try {
    grants = await deps.startProcess(actorId, {
      teamId: job.teamId,
      materialId: job.videoMaterialId,
      destinationFolderId: job.destinationFolderId,
      // Unique per lease: a job is created afresh after every spare, so its attempt count repeats.
      idempotencyKey: `updater-${job.jobId}-${lease.slice(0, 16)}`,
      toolId: RESTITCH_TOOL_ID,
      outputName: restitchedCopyName(job.videoName, job.updateCount),
      conflictMode: 'keep_both',
      agentContractVersion: 1,
      toolContractVersion: RESTITCH_CONTRACT_VERSION
    });
  } catch (error) {
    const code = error instanceof TeamFunctionError ? error.code : 'PROCESS_FAILED';
    deps.log('[updater-restitch] process not started', `${job.jobId} ${code}`);
    await fail(deps, actorId, job.jobId, leaseHash, code);
    return { job: null };
  }

  const bound = await deps.rpc('service_bind_restitch_job_operation', {
    p_job: job.jobId,
    p_lease_token_hash: leaseHash,
    p_operation: grants.operationId
  });
  if (bound !== true) return { job: null };

  return {
    job: {
      jobId: job.jobId,
      leaseToken: lease,
      operationId: grants.operationId,
      toolId: RESTITCH_TOOL_ID,
      videoMaterialId: job.videoMaterialId,
      videoDriveVersion: job.videoDriveVersion,
      options: { defaults: job.defaults, prepared: job.prepared },
      sourceGrant: grants.sourceGrant,
      finalizeGrant: grants.finalizeGrant
    }
  };
}

export async function heartbeatRestitchJob(
  deps: UpdaterRestitchDeps,
  actorId: string,
  body: Record<string, unknown>
) {
  const cancel = await deps.rpc('service_heartbeat_restitch_job', {
    p_actor: actorId,
    p_job: uuid(body.jobId),
    p_lease_token_hash: await deps.hashHex(leaseToken(body.leaseToken)),
    p_lease_seconds: LEASE_SECONDS
  });
  return { cancel: cancel !== false };
}

export async function completeRestitchJob(
  deps: UpdaterRestitchDeps,
  actorId: string,
  body: Record<string, unknown>
) {
  const outcome = body.outcome;
  if (outcome !== 'finalized' && outcome !== 'failed') {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const errorCode =
    typeof body.errorCode === 'string' && /^[A-Z_]{2,64}$/u.test(body.errorCode)
      ? body.errorCode
      : null;
  const recorded = await deps.rpc('service_complete_restitch_job', {
    p_actor: actorId,
    p_job: uuid(body.jobId),
    p_lease_token_hash: await deps.hashHex(leaseToken(body.leaseToken)),
    p_outcome: outcome,
    p_error: outcome === 'failed' ? (errorCode ?? 'PROCESS_FAILED') : null
  });
  return { recorded: recorded === true };
}

/**
 * After a restitch output is committed: share it by link and tell the database, which decides
 * whether it is the catalog's new spare, a copy nobody wants any more (deleted by the updater's
 * worker), or not the updater's at all. Sharing that fails leaves the copy unwanted, so the job is
 * tried again rather than a sheet pointed at a file nobody can open.
 */
export async function recordRestitchOutput(
  deps: Pick<UpdaterRestitchDeps, 'rpc' | 'log'> & {
    drive: Pick<GoogleDriveClient, 'listAnyonePermissions' | 'createAnyoneReaderPermission'>;
  },
  input: { operationId: string; materialId: string; driveFileId: string }
): Promise<string> {
  let link: string | null = videoShareLink(input.driveFileId, null);
  try {
    await ensureAnyoneReader(deps.drive, input.driveFileId);
  } catch (error) {
    const code = error instanceof TeamFunctionError ? error.code : 'SHARE_NOT_ALLOWED';
    deps.log('[updater-restitch] copy not shared', `${input.materialId} ${code}`);
    link = null;
  }
  const outcome = await deps.rpc('service_record_restitch_output', {
    p_operation: input.operationId,
    p_material: input.materialId,
    p_drive_file_id: input.driveFileId,
    p_shared_link: link
  });
  return typeof outcome === 'string' ? outcome : 'none';
}
