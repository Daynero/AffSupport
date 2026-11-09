import { sampleCatalogVideoDuration } from './catalog-video-duration.ts';
import {
  AGENT_INTAKE_MAX_BYTES,
  RANGE_REQUEST_MAX_BYTES
} from '../../../packages/shared/dist/team/contract.js';
import type { TeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { catalogVideoTransferTicket } from './catalog-video-transfer-ticket.ts';
import { recoveryTokenHash } from '../team-recovery/digest.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { catalogVideoNativeStore } from './catalog-video-native-store.ts';
interface Child {
  index: number;
  requestId: string;
  operationId: string | null;
}
/** Reissues only the original admitted process grants; it never calls process/start.
 * The reservation is durable and bounded, including lost issue acknowledgements. */
export function catalogVideoProcessGrants(
  service: ServiceRpcClient,
  original: {
    setId: string;
    nativeInstanceId: string;
    claimHash: string;
    protocolVersion: 1;
  },
  options: {
    functionBase: string;
    secret: string;
    prepareAlias?: (
      context: Awaited<ReturnType<ReturnType<typeof catalogVideoNativeStore>['processContext']>>,
      child: Child
    ) => Promise<{ rootOperationId: string; selectionProtocol: 1; defaults: TeamRestitchDefaults }>;
  }
) {
  const native = { ...original },
    base = new URL(options.functionBase);
  if (
    base.origin !== 'http://127.0.0.1:54321' ||
    base.pathname.replace(/\/$/u, '') !== '/functions/v1' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const store = catalogVideoNativeStore(service, native);
  return async (child: Child) => {
    const context = await store.processContext(child);
    if (!context.settings.configured || context.sourceSizeBytes > AGENT_INTAKE_MAX_BYTES)
      throw new TeamFunctionError(
        context.sourceSizeBytes > AGENT_INTAKE_MAX_BYTES ? 'TOO_LARGE' : 'RESTITCH_INVALID'
      );
    // Drive-pool jobs must bind their own protected selection path. The legacy
    // local library must never be substituted for an unsupported pool capability.
    if (
      context.settings.sourceMode === 'drive' &&
      context.settings.operation !== 'unstitch' &&
      !options.prepareAlias
    )
      throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
    const scope = {
      p_set: native.setId,
      p_hash: native.claimHash,
      p_native: native.nativeInstanceId,
      p_protocol: 1,
      p_index: child.index,
      p_request: child.requestId,
      p_operation: child.operationId
    };
    const reservation = await service.rpc('service_reserve_catalog_video_grants', scope);
    const round = reservation.data;
    if (
      reservation.error ||
      !isRecord(round) ||
      typeof round.sourceTicketId !== 'string' ||
      typeof round.finalizeTicketId !== 'string' ||
      typeof round.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(round.expiresAt)) ||
      typeof round.acquisition !== 'number'
    )
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    const alias =
      context.settings.sourceMode === 'drive' && context.settings.operation !== 'unstitch'
        ? await options.prepareAlias!(context, child)
        : null;
    if (alias && (alias.rootOperationId !== child.operationId || alias.selectionProtocol !== 1))
      throw new TeamFunctionError('INVALID_RESPONSE');
    const sourceTicket = await catalogVideoTransferTicket(
      options.secret,
      round.sourceTicketId,
      'process_input'
    );
    const finalizeTicket = await catalogVideoTransferTicket(
      options.secret,
      round.finalizeTicketId,
      'finalize'
    );
    const maxUses = Math.min(
      10000,
      Math.ceil(context.sourceSizeBytes / RANGE_REQUEST_MAX_BYTES) + 8
    );
    const issued = await service.rpc('service_issue_catalog_video_grants', {
      ...scope,
      p_acquisition: round.acquisition,
      p_source_hash: await recoveryTokenHash(sourceTicket),
      p_finalize_hash: await recoveryTokenHash(finalizeTicket),
      p_source_uses: maxUses
    });
    if (issued.error || issued.data !== true)
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    const sourceGrant = {
      ticket: sourceTicket,
      purpose: 'process_input' as const,
      expiresAt: round.expiresAt,
      maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
      maxUses
    };
    const finalizeGrant = {
      ticket: finalizeTicket,
      purpose: 'finalize' as const,
      expiresAt: round.expiresAt,
      maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
      maxUses: 4
    };
    return {
      operationId: context.operationId,
      state: context.operationState,
      agentContractVersion: 1,
      toolId: 'restitch' as const,
      sourceGrant,
      finalizeGrant,
      transferUrl: base.origin + '/functions/v1/drive-transfer/range',
      cloudBaseUrl: base.origin + '/functions/v1/drive-ops',
      options: {
        defaults:
          alias?.defaults ??
          (await sampleCatalogVideoDuration(context.settings, {
            setId: native.setId,
            requestId: child.requestId,
            settingsDigest: context.settingsDigest
          })),
        prepared: null,
        screens: null,
        restitchSelectionRootId: alias?.rootOperationId ?? null,
        restitchSelectionProtocol: alias?.selectionProtocol ?? null,
        teamId: context.teamId,
        catalogVideoSetId: native.setId,
        catalogVideoVariantIndex: child.index,
        catalogVideoRequestId: child.requestId,
        settingsDigest: context.settingsDigest
      }
    };
  };
}
