import { RESTITCH_CONTRACT_VERSION } from '../../../packages/shared/dist/team/restitch.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** The gateway is the existing trusted process-start implementation, not a
 * user-selected endpoint. Lost replies resolve through original-key SQL only. */
export async function admitCatalogVideoVariant(
  service: ServiceRpcClient,
  input: {
    setId: string;
    nativeInstanceId: string;
    claimHash: string;
    protocolVersion: 1;
    index: number;
    requestId: string;
  },
  gateway: {
    restitchedFolder(teamId: string, actorId: string): Promise<string>;
    startProcess(actorId: string, body: Record<string, unknown>): Promise<{ operationId: string }>;
    /** The source as Drive has it now (version and md5), with its row brought up to it. */
    liveSource?(
      teamId: string,
      actorId: string,
      materialId: string
    ): Promise<{ version: string; checksum: string | null }>;
  }
) {
  const original = { ...input };
  const read = async () => {
    const result = await service.rpc('service_read_catalog_video_admission', {
      p_set: original.setId,
      p_hash: original.claimHash,
      p_native: original.nativeInstanceId,
      p_protocol: original.protocolVersion,
      p_index: original.index,
      p_request: original.requestId
    });
    if (result.error || !isRecord(result.data))
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    return result.data;
  };
  const first = await read();
  if (
    first.kind === 'admitted' &&
    typeof first.operationId === 'string' &&
    UUID.test(first.operationId)
  )
    return { operationId: first.operationId };
  if (
    first.kind !== 'new' ||
    typeof first.teamId !== 'string' ||
    typeof first.actorId !== 'string' ||
    typeof first.materialId !== 'string' ||
    typeof first.outputName !== 'string' ||
    typeof first.idempotencyKey !== 'string' ||
    typeof first.sourceVersion !== 'string' ||
    !first.sourceVersion ||
    first.sourceVersion.length > 1024 ||
    !UUID.test(first.teamId) ||
    !UUID.test(first.actorId) ||
    !UUID.test(first.materialId) ||
    first.idempotencyKey !== 'catalog-variant:' + original.requestId
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  const destination = await gateway.restitchedFolder(first.teamId, first.actorId);
  // A second read after folder preparation closes cancellation/ownership changes
  // before process admission. Existing process idempotency serializes contenders.
  const current = await read();
  if (
    current.kind === 'admitted' &&
    typeof current.operationId === 'string' &&
    UUID.test(current.operationId)
  )
    return { operationId: current.operationId };
  if (current.kind !== 'new' || JSON.stringify(current) !== JSON.stringify(first))
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const actorId = first.actorId;
  const start = (sourceVersion: string) =>
    gateway.startProcess(actorId, {
      teamId: first.teamId,
      materialId: first.materialId,
      destinationFolderId: destination,
      idempotencyKey: first.idempotencyKey,
      expectedSourceVersion: sourceVersion,
      outputName: first.outputName,
      toolId: 'restitch',
      agentContractVersion: 1,
      toolContractVersion: RESTITCH_CONTRACT_VERSION,
      conflictMode: 'keep_both',
      optionsSummary: { catalogVideoSetId: original.setId, videoVariantIndex: original.index }
    });
  try {
    return await start(first.sourceVersion);
  } catch (cause) {
    const observed = await read();
    if (
      observed.kind === 'admitted' &&
      typeof observed.operationId === 'string' &&
      UUID.test(observed.operationId)
    )
      return { operationId: observed.operationId };
    // Drive moves a file's version on metadata-only changes (sharing by link). The
    // same bytes under a newer version rebase the set; different bytes still refuse.
    if (
      !(cause instanceof TeamFunctionError && cause.code === 'SOURCE_CHANGED') ||
      !gateway.liveSource
    )
      throw cause;
    const live = await gateway.liveSource(first.teamId, first.actorId, first.materialId);
    if (live.version === first.sourceVersion || !live.checksum) throw cause;
    const rebased = await service.rpc('service_rebase_catalog_video_source', {
      p_set: original.setId,
      p_hash: original.claimHash,
      p_native: original.nativeInstanceId,
      p_protocol: original.protocolVersion,
      p_version: live.version,
      p_checksum: live.checksum
    });
    if (rebased.error || rebased.data !== true) throw cause;
    const again = await read();
    if (again.kind !== 'new' || again.sourceVersion !== live.version) throw cause;
    return await start(live.version);
  }
}
