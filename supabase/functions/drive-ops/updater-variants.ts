import type { CatalogVideoForegroundExecutor } from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { acceptCatalogVideoSet, captureCatalogVideoSource } from './catalog-video-set-admission.ts';
function rpcError(message: string): never {
  switch (message) {
    case 'PERMISSION_DENIED':
    case 'AUTH_REQUIRED':
    case 'INVALID_INPUT':
    case 'WRONG_STATE':
    case 'REQUEST_REUSE_CONFLICT':
    case 'SOURCE_CHANGED':
    case 'RESTITCH_INVALID':
    case 'AGENT_UPDATE_REQUIRED':
      throw new TeamFunctionError(message, { retryable: false });
    default:
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export interface CatalogUpdaterVariantIdentity {
  teamId: string;
  actorId: string;
  catalogMaterialId: string;
  requestId?: string;
  expectedExecutorId?: string;
  foregroundExecutor?: CatalogVideoForegroundExecutor;
}
const validate = (value: CatalogUpdaterVariantIdentity) => {
  if (
    !UUID.test(value.teamId) ||
    !UUID.test(value.actorId) ||
    !UUID.test(value.catalogMaterialId) ||
    (value.requestId !== undefined && !UUID.test(value.requestId)) ||
    (value.expectedExecutorId !== undefined && !UUID.test(value.expectedExecutorId))
  )
    throw new TeamFunctionError('INVALID_INPUT');
};
export async function readCatalogUpdaterVariants(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity
) {
  const identity = { ...input };
  validate(identity);
  const result = await service.rpc('service_read_catalog_updater_variants', {
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_catalog: identity.catalogMaterialId,
    p_request: identity.requestId ?? null
  });
  if (result.error) rpcError(result.error.message ?? '');
  return result.data;
}
export async function cancelCatalogUpdaterVariants(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity
) {
  const identity = { ...input };
  validate(identity);
  if (!identity.requestId) throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_cancel_catalog_updater_variants', {
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_catalog: identity.catalogMaterialId,
    p_request: identity.requestId
  });
  if (result.error) rpcError(result.error.message ?? '');
  return result.data;
}
/** Admission opens/fences the original updater item in the same transaction and
 * freezes every generated ID before provider I/O. Ready outputs never authorize
 * legacy sheet writes or change an active publication by themselves. */
export async function startCatalogUpdaterVariants(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity & {
    requestId: string;
    requestedCount: number;
    profileVersion: number;
  },
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
) {
  const identity = { ...input };
  validate(identity);
  if (
    !Number.isSafeInteger(identity.requestedCount) ||
    identity.requestedCount < 1 ||
    identity.requestedCount > 400 ||
    !Number.isSafeInteger(identity.profileVersion) ||
    identity.profileVersion < 1
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const admitted = await service.rpc('service_accept_catalog_updater_variants', {
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_catalog: identity.catalogMaterialId,
    p_request: identity.requestId,
    p_count: identity.requestedCount,
    p_profile_version: identity.profileVersion,
    p_executor: identity.foregroundExecutor?.enrollmentId ?? identity.expectedExecutorId ?? null
  });
  if (admitted.error) rpcError(admitted.error.message ?? '');
  if (!isRecord(admitted.data)) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  return materializeCatalogUpdaterVariantRequest(service, identity, admitted.data, driveFor);
}

/** Original accepted round/request only: never accepts a browser-supplied authority row. */
export async function materializeCatalogUpdaterVariantRequest(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity & { requestId: string; requestedCount: number },
  accepted: Record<string, unknown>,
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
) {
  const identity = { ...input };
  validate(identity);
  const r = structuredClone(accepted);
  if (
    r.team_id !== identity.teamId ||
    r.actor_id !== identity.actorId ||
    r.catalog_material_id !== identity.catalogMaterialId ||
    r.request_id !== identity.requestId ||
    r.requested_count !== identity.requestedCount ||
    typeof r.set_id !== 'string' ||
    !UUID.test(r.set_id) ||
    typeof r.attempt_id !== 'string' ||
    !UUID.test(r.attempt_id) ||
    typeof r.executor_id !== 'string' ||
    typeof r.source_material_id !== 'string' ||
    !Array.isArray(r.recipe_row_ids) ||
    !Array.isArray(r.child_request_ids) ||
    !isRecord(r.provider_context) ||
    !isRecord(r.settings_snapshot) ||
    typeof r.assignment_seed !== 'string'
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  if (r.canceled_at !== null) return readCatalogUpdaterVariants(service, identity);
  const note = async (stage: string, code: string | null = null) => {
    try {
      await service.rpc('service_note_catalog_updater_variant_admission', {
        p_team: identity.teamId,
        p_actor: identity.actorId,
        p_request: identity.requestId,
        p_stage: stage,
        p_code: code
      });
    } catch {
      /* Diagnostic delivery does not change original admission ownership. */
    }
  };
  try {
    const defaults = parseTeamRestitchDefaults(r.settings_snapshot);
    if (!defaults.ok || !defaults.value.configured) throw new TeamFunctionError('RESTITCH_INVALID');
    const context = r.provider_context;
    const text = (key: string) => {
      if (typeof context[key] !== 'string') throw new TeamFunctionError('INVALID_RESPONSE');
      return context[key];
    };
    const fileId = text('fileId'),
      connectionId = text('connectionId'),
      credentialId = text('credentialId'),
      rootFolderId = text('rootFolderId');
    await acceptCatalogVideoSet(
      service,
      {
        setId: r.set_id,
        teamId: identity.teamId,
        actorId: identity.actorId,
        executorId: r.executor_id,
        catalogMaterialId: identity.catalogMaterialId,
        catalogIntentId: null,
        updateAttemptId: r.attempt_id,
        sourceMaterialId: r.source_material_id,
        settings: r.settings_snapshot as unknown as TeamRestitchDefaults,
        requestedCount: identity.requestedCount,
        recipe: {
          recipeRevision: 1,
          recipeRowIds: r.recipe_row_ids as string[],
          variantCount: identity.requestedCount,
          seed: r.assignment_seed
        },
        childRequestIds: r.child_request_ids as string[]
      },
      async () => {
        const drive = await driveFor(credentialId);
        await proveLiveAncestry({ client: drive, fileId, rootFolderId, maximumDepth: 16 });
        const live = await drive.getFile(fileId);
        const source = await captureCatalogVideoSource(
          service,
          {
            materialId: r.source_material_id as string,
            teamId: identity.teamId,
            actorId: identity.actorId,
            indexedConnectionId: connectionId,
            indexedFileId: fileId,
            indexedVersion: typeof context.version === 'string' ? context.version : null
          },
          async () => {
            if (
              !live.version ||
              !live.checksum ||
              live.size === null ||
              live.capabilities.canDownload !== true
            )
              throw new TeamFunctionError('SOURCE_CHANGED');
            return {
              accessProven: true,
              fileId: live.id,
              version: live.version,
              checksum: live.checksum,
              sizeBytes: live.size,
              mimeType: live.mimeType
            };
          }
        );
        await note('source_proven');
        return source;
      }
    );
    await note('set_admitted');
  } catch (cause) {
    const known = new Set<string>([
      ...TEAM_ERROR_CODES.filter(code => code.startsWith('RESTITCH_')),
      'RESTITCH_NO_SCREENS',
      'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
      'SOURCE_CHANGED',
      'PERMISSION_DENIED',
      'RESTITCH_INVALID',
      'DRIVE_UNAVAILABLE',
      'RATE_LIMITED',
      'PROCESS_RESULT_UNCERTAIN',
      'INVALID_RESPONSE',
      'SHARE_NOT_ALLOWED'
    ]);
    const code =
      cause instanceof TeamFunctionError && known.has(cause.code)
        ? cause.code
        : 'PROCESS_RESULT_UNCERTAIN';
    await note('admitted', code);
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
  }
  return readCatalogUpdaterVariants(service, identity);
}

/** Trusted worker-only row mapping. This proves copied output availability; it
 * does not authorize a provider catalog write or manufacture publication proof. */
export async function resolveCatalogUpdaterVariantLinks(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity & { requestId: string },
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
): Promise<
  readonly {
    rowId: string;
    ordinal: number;
    materialId: string;
    sourceVersion: string;
    url: string;
  }[]
> {
  const identity = { ...input };
  validate(identity);
  const status = await readCatalogUpdaterVariants(service, identity);
  if (!isRecord(status) || status.state !== 'ready') throw new TeamFunctionError('WRONG_STATE');
  const result = await service.rpc('service_catalog_updater_variant_outputs', {
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_request: identity.requestId
  });
  if (result.error) rpcError(result.error.message ?? '');
  if (!Array.isArray(result.data) || result.data.length < 1 || result.data.length > 400)
    throw new TeamFunctionError('INVALID_RESPONSE');
  const { catalogPublicationSourceIdentity } =
    await import('../../../packages/shared/dist/team/catalog-publication-source.js');
  const { ensureAnyoneReader } = await import('../_shared/link-sharing.ts');
  const { videoShareLink } = await import('../_shared/product-catalog.ts');
  const { createCatalogVideoLinkResolver } = await import('../_shared/catalog-video-link.ts');
  const videoLinks = createCatalogVideoLinkResolver({ service });
  const verified = new Map<string, { sourceVersion: string; url: string }>();
  const rowIds = new Set<string>();
  const mapping: {
    rowId: string;
    ordinal: number;
    materialId: string;
    sourceVersion: string;
    url: string;
  }[] = [];
  for (const [index, row] of result.data.entries()) {
    if (
      !isRecord(row) ||
      row.ordinal !== index + 1 ||
      typeof row.rowId !== 'string' ||
      !UUID.test(row.rowId) ||
      typeof row.materialId !== 'string' ||
      !UUID.test(row.materialId) ||
      typeof row.connectionId !== 'string' ||
      !UUID.test(row.connectionId) ||
      typeof row.fileId !== 'string' ||
      typeof row.credentialId !== 'string' ||
      typeof row.rootFolderId !== 'string' ||
      typeof row.sourceVersion !== 'string'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    if (rowIds.has(row.rowId)) throw new TeamFunctionError('INVALID_RESPONSE');
    rowIds.add(row.rowId);
    const prior = verified.get(row.materialId);
    if (prior) {
      if (prior.sourceVersion !== row.sourceVersion) throw new TeamFunctionError('SOURCE_CHANGED');
      mapping.push({
        rowId: row.rowId,
        ordinal: row.ordinal,
        materialId: row.materialId,
        sourceVersion: row.sourceVersion,
        url: prior.url
      });
      continue;
    }
    const current = await readCatalogUpdaterVariants(service, identity);
    if (!isRecord(current) || current.state !== 'ready' || current.setId !== status.setId)
      throw new TeamFunctionError('WRONG_STATE');
    const drive = await driveFor(row.credentialId);
    await proveLiveAncestry({
      client: drive,
      fileId: row.fileId,
      rootFolderId: row.rootFolderId,
      maximumDepth: 16
    });
    const live = await drive.getFile(row.fileId);
    if (live.capabilities.canDownload !== true) throw new TeamFunctionError('PERMISSION_DENIED');
    if (
      (await catalogPublicationSourceIdentity(
        {
          materialId: row.materialId,
          connectionId: row.connectionId,
          fileId: live.id,
          checksum: live.checksum,
          mimeType: live.mimeType,
          sizeBytes: live.size,
          driveVersion: live.version
        },
        row.sourceVersion.startsWith('strict-v1:')
      )) !== row.sourceVersion
    )
      throw new TeamFunctionError('SOURCE_CHANGED');
    // 050: with the option and a ready copy the proof is the R2 link; otherwise the Drive path as before.
    const fileId: string = row.fileId;
    const link = await videoLinks.resolve({
      scope: { catalogMaterialId: identity.catalogMaterialId },
      source: {
        materialId: row.materialId,
        sourceVersion: row.sourceVersion,
        sizeBytes: live.size,
        mimeType: live.mimeType,
        checksum: live.checksum
      },
      drive: async () => {
        const permissions = await drive.listAnyonePermissions(fileId);
        if (permissions.length === 0) {
          if (live.capabilities.canShare !== true) throw new TeamFunctionError('SHARE_NOT_ALLOWED');
          await ensureAnyoneReader(drive, fileId, permissions);
        }
        return videoShareLink(live.id, live.resourceKey);
      }
    });
    const url = link.url;
    verified.set(row.materialId, { sourceVersion: row.sourceVersion, url });
    mapping.push({
      rowId: row.rowId,
      ordinal: row.ordinal,
      materialId: row.materialId,
      sourceVersion: row.sourceVersion,
      url
    });
  }
  const settled = await readCatalogUpdaterVariants(service, identity);
  if (!isRecord(settled) || settled.state !== 'ready' || settled.setId !== status.setId)
    throw new TeamFunctionError('WRONG_STATE');
  return Object.freeze(mapping.map(row => Object.freeze(row)));
}

/** Resume reads the originally admitted count/version/executor; no current UI
 * profile or fresh client-generated operation identity can replace that intent. */
export async function resumeCatalogUpdaterVariants(
  service: ServiceRpcClient,
  input: CatalogUpdaterVariantIdentity & { requestId: string },
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
) {
  const identity = { ...input };
  validate(identity);
  const result = await service.rpc(
    identity.expectedExecutorId
      ? 'service_resume_catalog_variant_round'
      : 'service_resume_catalog_updater_variants',
    {
      p_team: identity.teamId,
      p_actor: identity.actorId,
      p_catalog: identity.catalogMaterialId,
      p_request: identity.requestId,
      ...(identity.expectedExecutorId ? { p_executor: identity.expectedExecutorId } : {})
    }
  );
  if (result.error) rpcError(result.error.message ?? '');
  const row = result.data;
  if (isRecord(row) && row.outcome === 'blocked')
    return readCatalogUpdaterVariants(service, identity);
  if (
    !isRecord(row) ||
    row.request_id !== identity.requestId ||
    row.team_id !== identity.teamId ||
    row.actor_id !== identity.actorId ||
    row.catalog_material_id !== identity.catalogMaterialId ||
    typeof row.requested_count !== 'number' ||
    typeof row.profile_version !== 'number' ||
    typeof row.executor_id !== 'string'
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return materializeCatalogUpdaterVariantRequest(
    service,
    { ...identity, requestedCount: row.requested_count },
    row,
    driveFor
  );
}

/** Bounded consumer on the existing catalog cron lane, no separate queue. */
export async function settleCatalogUpdaterVariantTargets(
  service: ServiceRpcClient,
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>,
  limit = 3
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_list_catalog_updater_variant_targets', {
    p_limit: limit
  });
  if (result.error) rpcError(result.error.message ?? '');
  if (!Array.isArray(result.data) || result.data.length > limit)
    throw new TeamFunctionError('INVALID_RESPONSE');
  let attached = 0,
    unknown = 0;
  for (const row of result.data) {
    if (
      !isRecord(row) ||
      typeof row.teamId !== 'string' ||
      typeof row.actorId !== 'string' ||
      typeof row.catalogMaterialId !== 'string' ||
      typeof row.requestId !== 'string'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const identity = {
      teamId: row.teamId,
      actorId: row.actorId,
      catalogMaterialId: row.catalogMaterialId,
      requestId: row.requestId
    };
    try {
      await resolveCatalogUpdaterVariantLinks(service, identity, driveFor);
      const receipt = await service.rpc('service_attach_catalog_updater_variant_target', {
        p_team: identity.teamId,
        p_actor: identity.actorId,
        p_request: identity.requestId
      });
      if (receipt.error) rpcError(receipt.error.message ?? '');
      if (
        !isRecord(receipt.data) ||
        !isRecord(receipt.data.target) ||
        receipt.data.target.kind !== 'video_set' ||
        typeof receipt.data.target.videoSetId !== 'string' ||
        !UUID.test(receipt.data.target.videoSetId) ||
        receipt.data.target.recipeRevision !== 1
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      const released = await service.rpc('service_release_catalog_variant_regular', {
        p_team: identity.teamId,
        p_request: identity.requestId
      });
      if (released.error) rpcError(released.error.message ?? '');
      attached++;
    } catch {
      unknown++;
      try {
        await service.rpc('service_note_catalog_updater_variant_admission', {
          p_team: identity.teamId,
          p_actor: identity.actorId,
          p_request: identity.requestId,
          p_stage: 'set_admitted',
          p_code: 'PROCESS_RESULT_UNCERTAIN'
        });
      } catch {
        /* Existing unknown request remains durable. */
      }
    }
  }
  return { attached, unknown };
}

/** Freeze/adopt the existing scheduled/Run attempt before the legacy provider
 * claim. No browser, new round or second execution queue is introduced. */
export async function prepareScheduledCatalogVideoSets(
  service: ServiceRpcClient,
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>,
  limit = 3
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new TeamFunctionError('INVALID_INPUT');
  const released = await service.rpc('service_release_catalog_variant_regulars', {
    p_limit: limit
  });
  if (released.error) rpcError(released.error.message ?? '');
  const settled = await service.rpc('service_settle_catalog_variant_deliveries', {
    p_limit: limit
  });
  if (settled.error) rpcError(settled.error.message ?? '');
  const listed = await service.rpc('service_list_catalog_variant_rounds', { p_limit: limit });
  if (listed.error) rpcError(listed.error.message ?? '');
  if (!Array.isArray(listed.data) || listed.data.length > limit)
    throw new TeamFunctionError('INVALID_RESPONSE');
  let admitted = 0,
    blocked = 0,
    unknown = 0;
  for (const row of listed.data) {
    if (
      !isRecord(row) ||
      typeof row.teamId !== 'string' ||
      typeof row.actorId !== 'string' ||
      typeof row.catalogMaterialId !== 'string' ||
      typeof row.attemptId !== 'string'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const identity = {
      teamId: row.teamId,
      actorId: row.actorId,
      catalogMaterialId: row.catalogMaterialId,
      requestId: row.attemptId
    };
    validate(identity);
    let accepted = false;
    try {
      const result = await service.rpc('service_resume_catalog_updater_variants', {
        p_team: identity.teamId,
        p_actor: identity.actorId,
        p_catalog: identity.catalogMaterialId,
        p_request: identity.requestId
      });
      if (result.error) rpcError(result.error.message ?? '');
      if (!isRecord(result.data)) throw new TeamFunctionError('INVALID_RESPONSE');
      if (result.data.outcome === 'blocked') {
        blocked++;
        continue;
      }
      accepted = true;
      if (typeof result.data.requested_count !== 'number')
        throw new TeamFunctionError('INVALID_RESPONSE');
      await materializeCatalogUpdaterVariantRequest(
        service,
        { ...identity, requestedCount: result.data.requested_count },
        result.data,
        driveFor
      );
      admitted++;
    } catch (cause) {
      unknown++;
      if (!accepted) {
        const code =
          cause instanceof TeamFunctionError &&
          ['PERMISSION_DENIED', 'SOURCE_CHANGED', 'RESTITCH_INVALID'].includes(cause.code)
            ? cause.code
            : 'PROCESS_RESULT_UNCERTAIN';
        try {
          await service.rpc('service_note_catalog_variant_round_failure', {
            p_team: identity.teamId,
            p_actor: identity.actorId,
            p_attempt: identity.requestId,
            p_code: code
          });
        } catch {
          /* Original attempt remains fenced and explicitly unknown. */
        }
      }
    }
  }
  return { admitted, blocked, unknown };
}
