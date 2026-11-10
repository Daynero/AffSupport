import {
  prepareCatalogVideoForeground,
  foregroundRpc,
  type CatalogForegroundScope
} from './catalog-video-foreground-authority.ts';
import type { CatalogVideoForegroundExecutor } from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import { catalogPublicationSourceIdentity } from '../../../packages/shared/dist/team/catalog-publication-source.js';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import { parseTeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import { captureCatalogVideoSource } from './catalog-video-set-admission.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';
import { videoShareLink } from '../_shared/product-catalog.ts';
import { createCatalogVideoLinkResolver } from '../_shared/catalog-video-link.ts';
import { verifyInitialCatalogPublication } from './catalog-initial-publication.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { TeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import {
  acceptCatalogVideoSet,
  type CatalogVideoFreshSource
} from './catalog-video-set-admission.ts';
import type {
  CatalogInitialVideoAuthority,
  CatalogInitialVideoPlan
} from './catalog-video-generation.ts';

/** Server-owned callbacks retain existing Drive ancestry/access checks and
 * original-operation output resolution. No browser-supplied output URL is used. */
export function catalogInitialVideoAuthority(
  service: ServiceRpcClient,
  input: {
    teamId: string;
    actorId: string;
    executorId?: string;
    foregroundEnrollmentId?: string;
    readyVideoSetId?: string;
    readyCatalogIntentId?: string;
    initialCatalogKey?: string;
    sourceMaterialId: string;
    targetedWriterEnabled?: boolean;
    readRestitchDefaults(): Promise<TeamRestitchDefaults>;
    captureFreshSource(): Promise<CatalogVideoFreshSource>;
    resolveReadyLinks(
      setId: string,
      recipeRevision: number,
      rowIds: readonly string[]
    ): Promise<readonly string[]>;
    verifyAndRegisterCreated(
      intentId: string,
      plan: CatalogInitialVideoPlan,
      catalogMaterialId: string
    ): Promise<void>;
  }
): CatalogInitialVideoAuthority {
  const identity = { ...input };
  return {
    ...(input.targetedWriterEnabled === undefined
      ? {}
      : { targetedWriterEnabled: input.targetedWriterEnabled }),
    async serverNow() {
      const result = await service.rpc('service_catalog_publication_clock', {});
      if (result.error || typeof result.data !== 'number' || !Number.isSafeInteger(result.data))
        throw new TeamFunctionError('INVALID_RESPONSE');
      return result.data;
    },
    async prepare({ intentId, plan }) {
      if (identity.readyCatalogIntentId && identity.readyCatalogIntentId !== intentId)
        throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
      let accepted = await service.rpc('service_read_catalog_video_acceptance', {
        p_set: plan.setId,
        p_team: identity.teamId,
        p_actor: identity.actorId
      });
      if (accepted.error) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
      if (isRecord(accepted.data) && accepted.data.catalogIntentId !== intentId) {
        accepted = await service.rpc('service_read_catalog_video_consumer_acceptance', {
          p_set: plan.setId,
          p_team: identity.teamId,
          p_actor: identity.actorId,
          p_intent: intentId
        });
        if (
          accepted.error ||
          !isRecord(accepted.data) ||
          accepted.data.catalogIntentId !== intentId ||
          accepted.data.parentState !== 'ready'
        )
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
      }
      if (
        identity.initialCatalogKey &&
        isRecord(accepted.data) &&
        accepted.data.parentState === 'ready' &&
        (identity.readyCatalogIntentId || !identity.readyVideoSetId)
      ) {
        const original = await service.rpc('service_read_initial_catalog_ready_binding', {
          p_team: identity.teamId,
          p_actor: identity.actorId,
          p_source: identity.sourceMaterialId,
          p_key: identity.initialCatalogKey
        });
        if (
          original.error ||
          !isRecord(original.data) ||
          original.data.catalogIntentId !== intentId ||
          original.data.videoSetId !== plan.setId
        )
          throw new TeamFunctionError('SOURCE_CHANGED');
        identity.readyVideoSetId = plan.setId!;
        identity.readyCatalogIntentId = intentId;
      }
      if (
        isRecord(accepted.data) &&
        (accepted.data.parentState === 'canceled' ||
          accepted.data.parentState === 'cancel_requested')
      )
        return {
          state: accepted.data.parentState,
          registeredCount:
            isRecord(accepted.data.snapshot) && Array.isArray(accepted.data.snapshot.children)
              ? accepted.data.snapshot.children.filter(
                  child => isRecord(child) && child.state === 'registered'
                ).length
              : 0
        };
      let snapshot: unknown = isRecord(accepted.data) ? accepted.data.snapshot : null;
      if (
        identity.readyVideoSetId &&
        (identity.readyVideoSetId !== plan.setId ||
          !isRecord(accepted.data) ||
          accepted.data.parentState !== 'ready')
      )
        throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
      if (!accepted.data) {
        if (identity.foregroundEnrollmentId)
          await foregroundRpc(service, 'service_note_catalog_video_foreground_intent', {
            p_enrollment: identity.foregroundEnrollmentId,
            p_team: identity.teamId,
            p_actor: identity.actorId,
            p_intent: intentId,
            p_planned_set: plan.setId
          });
        if (!identity.executorId) throw new TeamFunctionError('TEAM_TRANSPORT_UNAVAILABLE');
        const settings = {
          ...(await identity.readRestitchDefaults()),
          ...plan.preferences.restitchDuration
        };
        snapshot = (
          await acceptCatalogVideoSet(
            service,
            {
              setId: plan.setId!,
              teamId: identity.teamId,
              actorId: identity.actorId,
              executorId: identity.executorId,
              foregroundEnrollmentId: identity.foregroundEnrollmentId,
              catalogMaterialId: null,
              catalogIntentId: intentId,
              updateAttemptId: null,
              sourceMaterialId: identity.sourceMaterialId,
              settings,
              requestedCount: plan.preferences.videoVariationCount,
              recipe: {
                recipeRevision: 1,
                recipeRowIds: plan.recipeRowIds,
                variantCount: plan.preferences.videoVariationCount,
                seed: plan.assignmentSeed
              },
              childRequestIds: plan.childRequestIds
            },
            identity.captureFreshSource
          )
        ).snapshot;
      }
      if (!isRecord(snapshot) || snapshot.setId !== plan.setId || !Array.isArray(snapshot.children))
        throw new TeamFunctionError('INVALID_RESPONSE');
      const descriptor = identity.foregroundEnrollmentId
        ? await foregroundRpc(service, 'service_catalog_video_public_executor', {
            p_set: plan.setId,
            p_team: identity.teamId,
            p_actor: identity.actorId
          })
        : null;
      const executor = descriptor
        ? (descriptor as import('../../../packages/shared/dist/team/catalog-video-foreground.js').CatalogVideoForegroundProgressExecutor)
        : undefined;
      const children = snapshot.children;
      const registeredCount = children.filter(
        child =>
          isRecord(child) && child.state === 'registered' && typeof child.outputId === 'string'
      ).length;
      if (registeredCount !== plan.preferences.videoVariationCount)
        return {
          state: children.some(child => isRecord(child) && child.state === 'unknown')
            ? 'unknown'
            : 'preparing',
          registeredCount,
          ...(executor ? { executor } : {})
        };
      return {
        state: 'ready',
        ...(executor ? { executor } : {}),
        videoLinks:
          plan.preferences.videoPublication.mode === 'scheduled'
            ? []
            : await identity.resolveReadyLinks(plan.setId!, 1, plan.recipeRowIds)
      };
    },
    registerCreated({ intentId, plan, catalogMaterialId }) {
      return identity.verifyAndRegisterCreated(intentId, plan, catalogMaterialId);
    }
  };
}

/** Complete service adapter: index supplies only its already-authenticated Drive
 * client factory, never source proofs, output URLs or an unchecked installation. */
export async function createCatalogInitialVideoAuthority(
  service: ServiceRpcClient,
  identity: {
    teamId: string;
    actorId: string;
    sourceMaterialId: string;
    expectedExecutorId?: string;
    foregroundExecutor?: CatalogVideoForegroundExecutor;
    foregroundScope?: CatalogForegroundScope;
    foregroundSecret?: string;
    restitchEnabled?: boolean;
    /** 050: the create request asked for an R2 copy; the preference row follows registration. */
    copyVideoToR2?: boolean;
    frozenRestitchDefaults?: TeamRestitchDefaults;
    /** Server-frozen Launch candidate; exact consumer proof is required in prepare. */
    readyVideoSetId?: string;
    initialCatalogKey?: string;
    targetedWriterEnabled?: boolean;
  },
  driveFor: (credentialId: string) => Promise<import('../_shared/drive.ts').GoogleDriveClient>
): Promise<CatalogInitialVideoAuthority> {
  let readyCatalogIntentId: string | undefined;
  if (
    identity.restitchEnabled === true &&
    identity.initialCatalogKey &&
    !identity.readyVideoSetId
  ) {
    const original = await service.rpc('service_read_initial_catalog_ready_binding', {
      p_team: identity.teamId,
      p_actor: identity.actorId,
      p_source: identity.sourceMaterialId,
      p_key: identity.initialCatalogKey
    });
    if (original.error) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    if (original.data !== null) {
      if (
        !isRecord(original.data) ||
        typeof original.data.videoSetId !== 'string' ||
        typeof original.data.catalogIntentId !== 'string'
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      identity = { ...identity, readyVideoSetId: original.data.videoSetId };
      readyCatalogIntentId = original.data.catalogIntentId;
    }
  }
  if (identity.foregroundExecutor && identity.foregroundScope && identity.foregroundSecret) {
    await prepareCatalogVideoForeground(
      service,
      identity.foregroundSecret,
      identity.foregroundScope,
      identity.foregroundExecutor
    );
    if (identity.readyVideoSetId || identity.restitchEnabled === false)
      await foregroundRpc(service, 'service_retire_unused_catalog_video_foreground', {
        p_enrollment: identity.foregroundExecutor.enrollmentId,
        p_team: identity.teamId,
        p_actor: identity.actorId
      });
  }
  const useForeground =
    !!identity.foregroundExecutor &&
    identity.restitchEnabled !== false &&
    !identity.readyVideoSetId;
  const { data, error } = await service.rpc(
    useForeground
      ? 'service_catalog_video_foreground_context'
      : 'service_initial_catalog_video_context',
    {
      ...(useForeground ? { p_enrollment: identity.foregroundExecutor!.enrollmentId } : {}),
      p_team: identity.teamId,
      p_actor: identity.actorId,
      p_source: identity.sourceMaterialId,
      ...(useForeground
        ? {}
        : {
            p_executor: identity.expectedExecutorId ?? null,
            p_require_executor: identity.restitchEnabled !== false && !identity.readyVideoSetId
          })
    }
  );
  if (error?.message === 'AGENT_REQUIRED')
    throw new TeamFunctionError('AGENT_REQUIRED', { retryable: false });
  if (
    error ||
    !isRecord(data) ||
    !isRecord(data.material) ||
    (identity.restitchEnabled !== false &&
      !identity.readyVideoSetId &&
      typeof data.executorId !== 'string')
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const original = data.material;
  const field = (key: string) => {
    const value = original[key];
    if (typeof value !== 'string') throw new TeamFunctionError('INVALID_RESPONSE');
    return value;
  };
  const connectionId = field('connectionId'),
    fileId = field('fileId'),
    credentialId = field('credentialId'),
    root = field('rootFolderId');
  const defaults =
    identity.frozenRestitchDefaults ?? (isRecord(data.defaults) ? data.defaults : {});
  const parsed = parseTeamRestitchDefaults(defaults);
  if (!parsed.ok) throw new TeamFunctionError('RESTITCH_INVALID');
  let indexedVersion = typeof original.version === 'string' ? original.version : null;
  const refreshOriginal = async (intentId?: string) => {
    const drive = await driveFor(credentialId);
    await proveLiveAncestry({ client: drive, fileId, rootFolderId: root, maximumDepth: 16 });
    const live = await drive.getFile(fileId);
    if (identity.restitchEnabled === false) {
      if (
        !intentId ||
        !live.version ||
        !live.checksum ||
        live.size === null ||
        live.capabilities.canDownload !== true
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      const result = await service.rpc('service_capture_initial_catalog_publication_source', {
        p_team: identity.teamId,
        p_actor: identity.actorId,
        p_intent: intentId,
        p_source: identity.sourceMaterialId,
        p_connection: connectionId,
        p_file: fileId,
        p_expected_version: indexedVersion,
        p_observed: {
          fileId: live.id,
          version: live.version,
          checksum: live.checksum,
          sizeBytes: live.size,
          mimeType: live.mimeType
        }
      });
      if (result.error?.message === 'PERMISSION_DENIED')
        throw new TeamFunctionError('PERMISSION_DENIED');
      if (result.error?.message === 'WRONG_STATE') throw new TeamFunctionError('WRONG_STATE');
      if (result.error || !isRecord(result.data) || result.data.version !== live.version)
        throw new TeamFunctionError('SOURCE_CHANGED');
      indexedVersion = live.version;
      return {
        materialId: identity.sourceMaterialId,
        teamId: identity.teamId,
        actorId: identity.actorId,
        connectionId,
        fileId: live.id,
        version: live.version,
        checksum: live.checksum,
        sizeBytes: live.size,
        mimeType: live.mimeType
      };
    }
    const source = await captureCatalogVideoSource(
      service,
      {
        materialId: identity.sourceMaterialId,
        teamId: identity.teamId,
        actorId: identity.actorId,
        indexedConnectionId: connectionId,
        indexedFileId: fileId,
        indexedVersion
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
    indexedVersion = source.version;
    return source;
  };
  const resolveReadyLinks = (setId: string, recipeRevision: number, rowIds: readonly string[]) =>
    resolveCatalogReadyLinks(service, identity, driveFor, setId, recipeRevision, rowIds);
  return catalogInitialVideoAuthority(service, {
    ...identity,
    readyCatalogIntentId,
    foregroundEnrollmentId: useForeground ? identity.foregroundExecutor!.enrollmentId : undefined,
    executorId: typeof data.executorId === 'string' ? data.executorId : undefined,
    readRestitchDefaults: async () => parsed.value,
    captureFreshSource: refreshOriginal,
    resolveReadyLinks,
    verifyAndRegisterCreated: async (intentId, plan, catalogMaterialId) => {
      // Original sharing may advance only metadata. Refresh before freezing a
      // source-only publication target; copied-N creation never shares original.
      if (!plan.preferences.restitchEnabled) await refreshOriginal(intentId);
      await verifyInitialCatalogPublication(
        service,
        { teamId: identity.teamId, actorId: identity.actorId, intentId, catalogMaterialId },
        driveFor,
        plan.preferences.restitchEnabled
          ? plan.preferences.videoPublication.mode === 'scheduled'
            ? undefined
            : async () => {
                await resolveReadyLinks(plan.setId!, 1, plan.recipeRowIds);
              }
          : async () => {
              await refreshOriginal(intentId);
            }
      );
    }
  });
}

/** Ready video links for a frozen recipe: each distinct output is proven live,
 * shared and identity-checked once, then mapped onto every row it serves. */
export async function resolveCatalogReadyLinks(
  service: ServiceRpcClient,
  identity: { teamId: string; actorId: string; copyVideoToR2?: boolean },
  driveFor: (credentialId: string) => Promise<import('../_shared/drive.ts').GoogleDriveClient>,
  setId: string,
  recipeRevision: number,
  rowIds: readonly string[]
): Promise<string[]> {
  const result = await service.rpc('service_initial_catalog_video_outputs', {
    p_team: identity.teamId,
    p_actor: identity.actorId,
    p_set: setId,
    p_recipe: recipeRevision
  });
  if (result.error || !Array.isArray(result.data) || result.data.length !== rowIds.length)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const videoLinks = createCatalogVideoLinkResolver({ service });
  const links = new Map<string, string>();
  // Rows share a few video files (N variants for up to 400 products). Each
  // distinct output is proven once per call; proving it per row made a
  // 100-product catalog issue hundreds of sequential Drive calls and outlive
  // the function's wall clock, so the catalog never finished.
  const proven = new Map<string, string>();
  for (const row of result.data) {
    if (
      !isRecord(row) ||
      typeof row.rowId !== 'string' ||
      typeof row.fileId !== 'string' ||
      typeof row.rootFolderId !== 'string' ||
      typeof row.credentialId !== 'string'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const provenKey = JSON.stringify([
      row.credentialId,
      row.fileId,
      row.rootFolderId,
      row.materialId,
      row.connectionId,
      row.sourceVersion
    ]);
    const already = proven.get(provenKey);
    if (already !== undefined) {
      links.set(row.rowId, already);
      continue;
    }
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
      typeof row.materialId !== 'string' ||
      typeof row.connectionId !== 'string' ||
      typeof row.sourceVersion !== 'string' ||
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
    // 050: a catalog being created has no preference row yet; its request carries the option.
    const fileId: string = row.fileId;
    const resolved = await videoLinks.resolve({
      scope: { teamId: identity.teamId, assumeEnabled: identity.copyVideoToR2 === true },
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
    const link = resolved.url;
    proven.set(provenKey, link);
    links.set(row.rowId, link);
  }
  return rowIds.map(id => {
    const link = links.get(id);
    if (!link) throw new TeamFunctionError('INVALID_RESPONSE');
    return link;
  });
}
