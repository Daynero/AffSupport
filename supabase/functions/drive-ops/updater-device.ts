import type { GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import { videoShareLink } from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';

/**
 * The re-stitching computer's routes (feature 023, delivery 2).
 *
 * A desktop app enrolled for a space asks here for the next spare copy to make, keeps its lease
 * while it works, and reports how it went. It authenticates with its device secret, whose hash the
 * database compares; every claim re-checks that the member who enrolled it may still process. The
 * process itself is started exactly as a member's own run is — the same grants, as that member —
 * and the copy comes back through the ordinary output finalize, where `recordRestitchOutput` makes
 * it the catalog's spare.
 *
 * Everything outside this file arrives as deps, so the handlers are tested without Deno or Drive.
 */

export const DEVICE_SECRET_HEADER = 'x-soty-device-secret';
export const RESTITCH_TOOL_ID = 'restitch';
export const RESTITCH_CONTRACT_VERSION = 1;
const LEASE_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SECRET = /^[0-9a-f]{64}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface ProcessGrants {
  operationId: string;
  sourceGrant: unknown;
  finalizeGrant: unknown;
}

export interface UpdaterDeviceDeps {
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

/** The secret from its header, shaped as enrolment issued it; anything else is not a device. */
export function deviceSecret(headers: Headers): string {
  const secret = headers.get(DEVICE_SECRET_HEADER) ?? '';
  if (!SECRET.test(secret)) throw new TeamFunctionError('AUTH_REQUIRED');
  return secret;
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

function contracts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(entry[0]) &&
        typeof entry[1] === 'number' &&
        Number.isSafeInteger(entry[1])
    )
  );
}

async function fail(
  deps: UpdaterDeviceDeps,
  device: { deviceId: string; secretHash: string },
  jobId: string,
  leaseHash: string,
  code: string
) {
  await deps
    .rpc('service_complete_restitch_job', {
      p_device: device.deviceId,
      p_secret_hash: device.secretHash,
      p_job: jobId,
      p_lease_token_hash: leaseHash,
      p_outcome: 'failed',
      p_error: code,
      p_discovered: null
    })
    .catch(() => undefined);
}

export async function claimRestitchJob(
  deps: UpdaterDeviceDeps,
  headers: Headers,
  body: Record<string, unknown>
) {
  const device = {
    deviceId: uuid(body.deviceId),
    secretHash: await deps.hashHex(deviceSecret(headers))
  };
  const lease = deps.randomToken();
  const leaseHash = await deps.hashHex(lease);
  const claimed = await deps.rpc('service_claim_restitch_job', {
    p_device: device.deviceId,
    p_secret_hash: device.secretHash,
    p_build: typeof body.build === 'string' ? body.build.slice(0, 80) : null,
    p_contracts: contracts(body.toolContracts),
    p_lease_token_hash: leaseHash,
    p_lease_seconds: LEASE_SECONDS
  });
  if (claimed === null || claimed === undefined) return { job: null };
  const job = parseClaimedRestitchJob(claimed);
  if (!job) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: true });

  // Nothing a run could make without the space's re-stitch settings: fail the job, not the round.
  if (!job.defaults || job.defaults.configured !== true) {
    await fail(deps, device, job.jobId, leaseHash, 'RESTITCH_INVALID');
    return { job: null };
  }

  for (const operationId of job.openOperationIds) {
    await deps.abandonOperation(operationId).catch(error => {
      const code = error instanceof TeamFunctionError ? error.code : 'UNKNOWN';
      deps.log('[updater-device] earlier operation left open', `${operationId} ${code}`);
    });
  }

  let grants: ProcessGrants;
  try {
    grants = await deps.startProcess(job.actorId, {
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
    deps.log('[updater-device] process not started', `${job.jobId} ${code}`);
    await fail(deps, device, job.jobId, leaseHash, code);
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
      options: { defaults: job.defaults, prepared: job.prepared },
      sourceGrant: grants.sourceGrant,
      finalizeGrant: grants.finalizeGrant
    }
  };
}

export async function heartbeatRestitchJob(
  deps: UpdaterDeviceDeps,
  headers: Headers,
  body: Record<string, unknown>
) {
  const cancel = await deps.rpc('service_heartbeat_restitch_job', {
    p_device: uuid(body.deviceId),
    p_secret_hash: await deps.hashHex(deviceSecret(headers)),
    p_job: uuid(body.jobId),
    p_lease_token_hash: await deps.hashHex(leaseToken(body.leaseToken)),
    p_lease_seconds: LEASE_SECONDS
  });
  return { cancel: cancel !== false };
}

export async function completeRestitchJob(
  deps: UpdaterDeviceDeps,
  headers: Headers,
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
    p_device: uuid(body.deviceId),
    p_secret_hash: await deps.hashHex(deviceSecret(headers)),
    p_job: uuid(body.jobId),
    p_lease_token_hash: await deps.hashHex(leaseToken(body.leaseToken)),
    p_outcome: outcome,
    p_error: outcome === 'failed' ? (errorCode ?? 'PROCESS_FAILED') : null,
    p_discovered: isRecord(body.discovered) ? body.discovered : null
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
  deps: Pick<UpdaterDeviceDeps, 'rpc' | 'log'> & {
    drive: Pick<GoogleDriveClient, 'listAnyonePermissions' | 'createAnyoneReaderPermission'>;
  },
  input: { operationId: string; materialId: string; driveFileId: string }
): Promise<string> {
  let link: string | null = videoShareLink(input.driveFileId, null);
  try {
    await ensureAnyoneReader(deps.drive, input.driveFileId);
  } catch (error) {
    const code = error instanceof TeamFunctionError ? error.code : 'SHARE_NOT_ALLOWED';
    deps.log('[updater-device] copy not shared', `${input.materialId} ${code}`);
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
