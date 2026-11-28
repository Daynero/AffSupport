/**
 * 057 T107 (research.md R15 «Фонове доведення»): the variations of a catalog in an R2 space are
 * finished by the member's delegated agent when no page is open — the background parity of the
 * Drive catalog updater's re-stitch jobs (`drive-ops/updater-restitch.ts`).
 *
 * team-recovery authorizes the agent's recovery credential exactly as for Drive and, for an R2
 * space (the receipt says `storageBackend: 'r2'`), calls these in place of `drive-ops/updater/*`:
 *
 * - `claim` leases the next variation no one is working on (`service_claim_space_catalog_variant`),
 *   draws its pictures from the space's pools with a download ticket each (as the page does),
 *   opens the run as `/catalog-variants/run` does (same key, folder and attempts) and binds it
 *   under the lease, then hands the agent the run's two tickets and the set's frozen settings with
 *   the duration drawn from the variation's identity. The agent reads and writes through
 *   space-storage (contract 3); its finalize registers the output with the catalog.
 * - `heartbeat` keeps the lease and says when to stop; `complete` releases it.
 *
 * Pictures that cannot be drawn now hold the lease for an hour without a run, as the Drive updater
 * defers a job whose pool is empty; a lost bind cancels the run before any agent sees it.
 */
// @deno-types="../../../packages/shared/dist/team/restitch.d.ts"
import {
  parseTeamRestitchDefaults,
  RESTITCH_CONTRACT_VERSION,
  RESTITCH_SCREEN_REFUSAL_LIMIT,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import { isSpaceUuid } from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { sampleCatalogVideoDuration } from '../drive-ops/catalog-video-duration.ts';
import { call, openCatalogVariantRun } from './catalog-variants.ts';
import { issueAgentDownloadGrant, issueSpaceProcessGrants, type ProcessDeps } from './process.ts';

/** The lease the agent heartbeats (the Drive updater's is the same two minutes). */
export const SPACE_VARIANT_LEASE_SECONDS = 120;
/** How long a variation whose pictures cannot be drawn waits before it is claimed again. */
export const SPACE_VARIANT_SCREEN_DEFER_SECONDS = 3600;
const SCREEN_ROUNDS = 8;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface SpaceVariantRecoveryDeps extends ProcessDeps {
  actorId: string;
  /** The public `space-storage/agent/source` address a picture's ticket is traded at. */
  sourceUrl: string;
  /** 32 random bytes, base64url without padding. */
  randomToken(): string;
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

/** SHA-256 as the `\x…` hex a bytea parameter takes. */
async function leaseHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return '\\x' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function leaseToken(value: unknown): string {
  if (typeof value !== 'string' || !LEASE_TOKEN.test(value)) return refuse('INVALID_INPUT');
  return value;
}

interface LeasedVariant {
  jobId: string;
  setId: string;
  index: number;
  requestId: string;
  attempt: number;
  sourceMaterialId: string;
  sourceName: string;
  settings: TeamRestitchDefaults;
  settingsDigest: string;
}

function parseLease(value: unknown): LeasedVariant {
  if (
    !isRecord(value) ||
    !isSpaceUuid(value.jobId) ||
    !isSpaceUuid(value.setId) ||
    !Number.isSafeInteger(value.index) ||
    (value.index as number) < 0 ||
    (value.index as number) > 399 ||
    !isSpaceUuid(value.requestId) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 3 ||
    !isSpaceUuid(value.sourceMaterialId) ||
    typeof value.sourceName !== 'string' ||
    typeof value.settingsDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.settingsDigest)
  )
    return refuse('INVALID_RESPONSE');
  const settings = parseTeamRestitchDefaults(value.settings);
  if (!settings.ok || !settings.value.configured) return refuse('RESTITCH_INVALID');
  return {
    jobId: value.jobId,
    setId: value.setId,
    index: value.index as number,
    requestId: value.requestId,
    attempt: value.attempt as number,
    sourceMaterialId: value.sourceMaterialId,
    sourceName: value.sourceName,
    settings: settings.value,
    settingsDigest: value.settingsDigest
  };
}

/** Older settings and the opposite slot cannot consume this slot's refusal window (as on Drive). */
function remembered(history: unknown, revision: string) {
  if (!Array.isArray(history)) return [];
  const counts = { start: 0, end: 0 };
  return history.filter(item => {
    if (
      !isRecord(item) ||
      item.settingsRevision !== revision ||
      (item.slot !== 'start' && item.slot !== 'end') ||
      typeof item.materialId !== 'string' ||
      typeof item.checksum !== 'string'
    )
      return false;
    if (counts[item.slot] >= RESTITCH_SCREEN_REFUSAL_LIMIT) return false;
    counts[item.slot]++;
    return true;
  }) as Array<{ slot: string; materialId: string; checksum: string }>;
}

/**
 * One picture per enabled slot from the space's pools, each with a ticket this member's agent
 * trades at `/agent/source`; null when none can be drawn or granted now.
 */
async function drawScreens(
  deps: SpaceVariantRecoveryDeps,
  teamId: string,
  refusals: Array<{ slot: string; materialId: string; checksum: string }>
): Promise<unknown[] | null> {
  const excluded: string[] = [];
  for (let round = 0; round < SCREEN_ROUNDS; round++) {
    let drawn: unknown;
    try {
      drawn = await call(deps, 'service_draw_restitch_screens', {
        p_team: teamId,
        p_actor: deps.actorId,
        p_exclude: [...excluded]
      });
    } catch {
      return null;
    }
    const picked = isRecord(drawn) && Array.isArray(drawn.screens) ? drawn.screens : [];
    const refused = picked.filter(
      entry =>
        isRecord(entry) &&
        refusals.some(
          item =>
            item.slot === entry.slot &&
            item.materialId === entry.materialId &&
            typeof entry.checksum === 'string' &&
            item.checksum.toLowerCase() === entry.checksum.toLowerCase()
        )
    );
    if (refused.length) {
      const before = excluded.length;
      for (const entry of refused)
        if (
          isRecord(entry) &&
          typeof entry.materialId === 'string' &&
          !excluded.includes(entry.materialId)
        )
          excluded.push(entry.materialId);
      if (excluded.length === before) return null;
      continue;
    }
    const screens: unknown[] = [];
    let failed: string | null = null;
    for (const entry of picked) {
      if (!isRecord(entry) || typeof entry.materialId !== 'string') continue;
      try {
        const granted = await issueAgentDownloadGrant(
          { teamId, materialId: entry.materialId },
          deps
        );
        screens.push({ ...entry, transfer: { transferUrl: deps.sourceUrl, grant: granted.grant } });
      } catch {
        failed = entry.materialId;
        break;
      }
    }
    if (failed === null) return screens;
    excluded.push(failed);
  }
  return null;
}

export async function claimSpaceCatalogVariantJob(
  deps: SpaceVariantRecoveryDeps,
  body: { teamId: string; restitchContractVersion: number; screenRefusals?: unknown }
): Promise<{ job: null } | { job: Record<string, unknown> }> {
  const lease = deps.randomToken();
  const hash = await leaseHash(lease);
  const claimed = await call(deps, 'service_claim_space_catalog_variant', {
    p_team: body.teamId,
    p_actor: deps.actorId,
    p_lease_hash: hash,
    p_lease_seconds: SPACE_VARIANT_LEASE_SECONDS
  });
  if (claimed === null || claimed === undefined) return { job: null };
  const release = () =>
    call(deps, 'service_complete_space_catalog_variant_job', {
      p_actor: deps.actorId,
      p_job: isRecord(claimed) ? claimed.jobId : null,
      p_lease_hash: hash
    }).catch(() => undefined);
  let leased: LeasedVariant;
  try {
    leased = parseLease(claimed);
  } catch (cause) {
    await release();
    throw cause;
  }
  const defer = () =>
    call(deps, 'service_defer_space_catalog_variant_job', {
      p_actor: deps.actorId,
      p_job: leased.jobId,
      p_lease_hash: hash,
      p_seconds: SPACE_VARIANT_SCREEN_DEFER_SECONDS
    }).catch(() => undefined);

  // Pictures from the space's pools need the current executor; an older one is told before any run.
  let screens: unknown[] | null = null;
  if (leased.settings.sourceMode === 'drive') {
    if (body.restitchContractVersion < RESTITCH_CONTRACT_VERSION) {
      await release();
      throw new TeamFunctionError('RESTITCH_CLIENT_OUTDATED', { retryable: false });
    }
    screens = await drawScreens(
      deps,
      body.teamId,
      remembered(body.screenRefusals, leased.settings.updatedAt ?? '')
    );
    if (screens === null) {
      await defer();
      return { job: null };
    }
  }

  let opened;
  try {
    opened = await openCatalogVariantRun(
      {
        teamId: body.teamId,
        sourceMaterialId: leased.sourceMaterialId,
        sourceName: leased.sourceName,
        index: leased.index,
        requestId: leased.requestId,
        attempt: leased.attempt,
        toolContractVersion: RESTITCH_CONTRACT_VERSION
      },
      deps,
      operationId =>
        call(deps, 'service_bind_space_catalog_variant_job', {
          p_team: body.teamId,
          p_actor: deps.actorId,
          p_job: leased.jobId,
          p_lease_hash: hash,
          p_attempt: leased.attempt,
          p_operation: operationId
        })
    );
  } catch {
    // A page or another claim made it first, or the source moved: nothing reaches the agent.
    await release();
    return { job: null };
  }
  const grants = await issueSpaceProcessGrants(opened, deps);
  const defaults = await sampleCatalogVideoDuration(leased.settings, {
    setId: leased.setId,
    requestId: leased.requestId,
    settingsDigest: leased.settingsDigest
  });
  return {
    job: {
      jobId: leased.jobId,
      leaseToken: lease,
      operationId: grants.operationId,
      toolId: 'restitch',
      // The agent reads and writes this run through space-storage, never Drive.
      workspaceStorage: 'r2',
      videoMaterialId: leased.sourceMaterialId,
      options: {
        defaults,
        prepared: null,
        ...(screens ? { screens, teamId: body.teamId } : {})
      },
      sourceGrant: grants.sourceGrant,
      finalizeGrant: grants.finalizeGrant
    }
  };
}

export async function heartbeatSpaceCatalogVariantJob(
  deps: Pick<SpaceVariantRecoveryDeps, 'rpc' | 'actorId'>,
  body: Record<string, unknown>
): Promise<{ cancel: boolean }> {
  if (!isSpaceUuid(body.jobId)) return refuse('INVALID_INPUT');
  const value = await call(deps as ProcessDeps, 'service_heartbeat_space_catalog_variant_job', {
    p_actor: deps.actorId,
    p_job: body.jobId,
    p_lease_hash: await leaseHash(leaseToken(body.leaseToken)),
    p_lease_seconds: SPACE_VARIANT_LEASE_SECONDS
  });
  return { cancel: !(isRecord(value) && value.cancel === false) };
}

export async function completeSpaceCatalogVariantJob(
  deps: Pick<SpaceVariantRecoveryDeps, 'rpc' | 'actorId'>,
  body: Record<string, unknown>
): Promise<{ recorded: boolean }> {
  if (!isSpaceUuid(body.jobId)) return refuse('INVALID_INPUT');
  if (body.outcome !== 'finalized' && body.outcome !== 'failed') return refuse('INVALID_INPUT');
  const value = await call(deps as ProcessDeps, 'service_complete_space_catalog_variant_job', {
    p_actor: deps.actorId,
    p_job: body.jobId,
    p_lease_hash: await leaseHash(leaseToken(body.leaseToken))
  });
  return { recorded: isRecord(value) && value.recorded === true };
}
