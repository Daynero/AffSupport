import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import {
  createCatalogVideoAssignment,
  parseCatalogVideoVariationCount,
  reuseCatalogVideoAssignment,
  type CatalogVideoAssignmentRecipe
} from '../../../packages/shared/dist/team/catalog-video-set.js';
import type { TeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
export interface CatalogVideoFreshSource {
  materialId: string;
  teamId: string;
  actorId: string;
  connectionId: string;
  fileId: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}
/** Existing provider client/ancestry proof supplies this snapshot; no endpoint
 * accepts a caller's observed metadata. SQL CAS refuses stale refresh ordering. */
export async function captureCatalogVideoSource(
  service: ServiceRpcClient,
  original: {
    materialId: string;
    teamId: string;
    actorId: string;
    indexedConnectionId: string;
    indexedFileId: string;
    indexedVersion: string | null;
  },
  proveLive: () => Promise<{
    accessProven: true;
    fileId: string;
    version: string;
    checksum: string;
    sizeBytes: number;
    mimeType: string;
  }>
): Promise<CatalogVideoFreshSource> {
  const identity = { ...original };
  const live = await proveLive();
  if (live.accessProven !== true || live.fileId !== identity.indexedFileId)
    throw new TeamFunctionError('SOURCE_CHANGED');
  const result = await service.rpc('service_capture_catalog_video_source', {
    p_material: identity.materialId,
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_expected_connection: identity.indexedConnectionId,
    p_expected_file: identity.indexedFileId,
    p_expected_version: identity.indexedVersion,
    p_observed: {
      fileId: live.fileId,
      version: live.version,
      checksum: live.checksum,
      sizeBytes: live.sizeBytes,
      mimeType: live.mimeType
    }
  });
  if (result.error) throw new TeamFunctionError('SOURCE_CHANGED');
  if (
    !isRecord(result.data) ||
    result.data.materialId !== identity.materialId ||
    result.data.teamId !== identity.teamId ||
    result.data.actorId !== identity.actorId ||
    result.data.connectionId !== identity.indexedConnectionId ||
    result.data.fileId !== live.fileId ||
    result.data.version !== live.version ||
    result.data.checksum !== live.checksum.toLowerCase() ||
    result.data.sizeBytes !== live.sizeBytes ||
    result.data.mimeType !== live.mimeType
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    materialId: identity.materialId,
    teamId: identity.teamId,
    actorId: identity.actorId,
    connectionId: identity.indexedConnectionId,
    fileId: live.fileId,
    version: live.version,
    checksum: live.checksum.toLowerCase(),
    sizeBytes: live.sizeBytes,
    mimeType: live.mimeType
  };
}
/** Inputs are existing accepted owner/recipe snapshots, never a raw browser DTO.
 * captureFreshSource must prove provider metadata and CAS-refresh the original
 * indexed identity before it returns; a stale body version is deliberately absent. */
export async function acceptCatalogVideoSet(
  service: ServiceRpcClient,
  input: {
    setId: string;
    teamId: string;
    actorId: string;
    executorId: string;
    foregroundEnrollmentId?: string;
    catalogMaterialId: string | null;
    catalogIntentId: string | null;
    updateAttemptId: string | null;
    sourceMaterialId: string;
    settings: TeamRestitchDefaults;
    requestedCount: number;
    recipe: CatalogVideoAssignmentRecipe;
    storedAssignment?: unknown;
    childRequestIds: readonly string[];
  },
  captureFreshSource: () => Promise<CatalogVideoFreshSource>
) {
  const original = structuredClone(input);
  const count = parseCatalogVideoVariationCount(
    original.requestedCount,
    original.recipe.recipeRowIds.length,
    true
  );
  if (
    count !== original.recipe.variantCount ||
    original.childRequestIds.length !== count ||
    new Set(original.childRequestIds).size !== count ||
    !original.settings.configured
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const assignment =
    original.storedAssignment === undefined
      ? createCatalogVideoAssignment(original.recipe)
      : reuseCatalogVideoAssignment(original.storedAssignment, original.recipe);
  const settingsDigest = await catalogVideoSettingsDigest(original.settings);
  const existing = await service.rpc('service_read_catalog_video_acceptance', {
    p_set: original.setId,
    p_team: original.teamId,
    p_actor: original.actorId
  });
  if (existing.error) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  if (existing.data !== null) {
    const accepted = existing.data;
    if (
      !isRecord(accepted) ||
      accepted.settingsDigest !== settingsDigest ||
      accepted.catalogIntentId !== original.catalogIntentId ||
      accepted.updateAttemptId !== original.updateAttemptId ||
      !isRecord(accepted.source) ||
      accepted.source.materialId !== original.sourceMaterialId ||
      accepted.source.teamId !== original.teamId ||
      accepted.source.actorId !== original.actorId ||
      !isRecord(accepted.snapshot) ||
      accepted.snapshot.setId !== original.setId ||
      !Array.isArray(accepted.snapshot.children) ||
      accepted.snapshot.children.length !== count ||
      accepted.snapshot.children.some(
        (child: unknown, index: number) =>
          !isRecord(child) ||
          child.index !== index ||
          child.requestId !== original.childRequestIds[index]
      )
    )
      throw new TeamFunctionError('REQUEST_REUSE_CONFLICT');
    const replayAssignment = reuseCatalogVideoAssignment(accepted.assignment, original.recipe);
    return {
      snapshot: accepted.snapshot,
      parentState: accepted.parentState,
      assignment: replayAssignment,
      source: accepted.source as unknown as CatalogVideoFreshSource
    };
  }
  const source = await captureFreshSource();
  if (
    source.materialId !== original.sourceMaterialId ||
    source.teamId !== original.teamId ||
    source.actorId !== original.actorId ||
    !source.version ||
    source.sizeBytes <= 0
  )
    throw new TeamFunctionError('SOURCE_CHANGED');

  const result = await service.rpc(
    input.foregroundEnrollmentId
      ? 'service_accept_foreground_catalog_video_set'
      : 'service_accept_catalog_video_set',
    {
      ...(input.foregroundEnrollmentId ? { p_enrollment: input.foregroundEnrollmentId } : {}),
      p_team: original.teamId,
      p_actor: original.actorId,
      ...(original.foregroundEnrollmentId ? {} : { p_executor: original.executorId }),
      p_payload: {
        setId: original.setId,
        catalogMaterialId: original.catalogMaterialId,
        catalogIntentId: original.catalogIntentId,
        updateAttemptId: original.updateAttemptId,
        sourceMaterialId: source.materialId,
        sourceVersion: source.version,
        settings: original.settings,
        settingsDigest,
        requestedCount: count,
        productCount: assignment.productCount,
        recipeRevision: assignment.recipeRevision,
        seed: assignment.seed
      },
      p_children: original.childRequestIds.map((requestId, index) => ({ index, requestId })),
      p_assignments: assignment.assignments
    }
  );
  if (result.error) {
    const restitch = TEAM_ERROR_CODES.find(
      code => code === result.error?.message && code.startsWith('RESTITCH_')
    );
    if (restitch) throw new TeamFunctionError(restitch, { retryable: false });
    switch (result.error.message) {
      case 'RESTITCH_NO_SCREENS':
      case 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN':
      case 'RESTITCH_INVALID':
      case 'SOURCE_CHANGED':
      case 'PERMISSION_DENIED':
      case 'WRONG_STATE':
      case 'REQUEST_REUSE_CONFLICT':
      case 'INVALID_INPUT':
        throw new TeamFunctionError(result.error.message, { retryable: false });
      default:
        throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    }
  }
  if (!isRecord(result.data) || result.data.setId !== original.setId)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  return { snapshot: result.data, parentState: 'accepted', assignment, source };
}

/** Metadata timestamps do not change the rendering recipe. Sort keys recursively
 * so equivalent typed settings share a digest regardless of transport order. */
export async function catalogVideoSettingsDigest(settings: TeamRestitchDefaults): Promise<string> {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .filter(key => key !== 'updatedAt' && key !== 'updatedBy')
              .sort()
              .map(key => [key, canonical(value[key])])
          )
        : value;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical(settings)))
      )
    )
  )
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

/** Row inventory changes reuse physical outputs only after a new trusted source
 * proof, immutable row assignment and explicit new consumer reference. */
export async function referenceReadyCatalogVideoSet(
  service: ServiceRpcClient,
  input: {
    setId: string;
    teamId: string;
    actorId: string;
    catalogMaterialId: string | null;
    catalogIntentId: string | null;
    updateAttemptId: string | null;
    sourceMaterialId: string;
    settings: TeamRestitchDefaults;
    recipe: CatalogVideoAssignmentRecipe;
  },
  captureFreshSource: () => Promise<CatalogVideoFreshSource>
) {
  const original = structuredClone(input);
  const assignment = createCatalogVideoAssignment(original.recipe);
  const source = await captureFreshSource();
  if (
    source.materialId !== original.sourceMaterialId ||
    source.teamId !== original.teamId ||
    source.actorId !== original.actorId
  )
    throw new TeamFunctionError('SOURCE_CHANGED');
  const result = await service.rpc('service_reference_ready_catalog_video_set', {
    p_team: original.teamId,
    p_actor: original.actorId,
    p_set: original.setId,
    p_payload: {
      catalogMaterialId: original.catalogMaterialId,
      catalogIntentId: original.catalogIntentId,
      updateAttemptId: original.updateAttemptId,
      sourceVersion: source.version,
      settingsDigest: await catalogVideoSettingsDigest(original.settings),
      recipeRevision: assignment.recipeRevision,
      productCount: assignment.productCount,
      seed: assignment.seed
    },
    p_assignments: assignment.assignments
  });
  if (
    result.error ||
    !isRecord(result.data) ||
    result.data.setId !== original.setId ||
    result.data.recipeRevision !== assignment.recipeRevision ||
    result.data.ready !== true
  )
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  return { setId: original.setId, assignment, source };
}
