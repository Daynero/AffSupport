import {
  parseLaunchBatchCommand,
  parseDurableLaunchBatch,
  type LaunchBatchCommand
} from '../../../packages/shared/dist/team/launch-batch.js';
import { isRecord } from '../_shared/validation.ts';
import {
  launchPreview,
  parseLaunchConfig,
  parseLaunchSources,
  isLaunchUuid,
  type LaunchConfig,
  type LaunchSourceSnapshot
} from '../../../packages/shared/dist/team/launches.js';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { launchFailure, launchRetryAfterMs } from '../_shared/launch-failures.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { prepareLaunchCatalogVideoAdmission } from './launch-catalog-video.ts';

async function rpc(service: ServiceRpcClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await service.rpc(name, args);
  if (error)
    throw new TeamFunctionError(
      TEAM_ERROR_CODES.find(code => code === error.message) ?? 'TEAM_TRANSPORT_UNAVAILABLE'
    );
  return data;
}
const TRANSIENT = new Set([
  'TEAM_TRANSPORT_UNAVAILABLE',
  'DRIVE_UNAVAILABLE',
  'RATE_LIMITED',
  'NO_WORK',
  'LAUNCH_INTERNAL_ERROR',
  'LAUNCH_RESULT_UNCERTAIN',
  'PROCESS_RESULT_UNCERTAIN'
]);
/** Only the authenticated Edge constructs previews/plans. Metadata failure is
 * captured per member; SQL classifies transient/setup waits as durable pending
 * admission, so an unavailable source cannot prevent healthy siblings starting. */
async function prepareLaunchBatch(
  service: ServiceRpcClient,
  command: LaunchBatchCommand,
  context: Record<string, unknown>,
  allowSkip = false
) {
  if (!Array.isArray(context.items) || context.items.length !== command.items.length)
    throw new TeamFunctionError('INVALID_RESPONSE');
  const metadataReads = new Map<string, ReturnType<ServiceRpcClient['rpc']>>();
  const requestMetadata: ServiceRpcClient['rpc'] = async (name, args) => {
    const result = await service.rpc(name, args);
    // Preserve a definitive source/permission refusal across the older generic
    // admission helper; it must not become an endless transport retry.
    const code = result.error && TEAM_ERROR_CODES.find(code => code === result.error?.message);
    if (code) throw new TeamFunctionError(code);
    return result;
  };
  const metadata: ServiceRpcClient = {
    rpc: (name, args) => {
      if (
        name !== 'service_initial_catalog_video_context' &&
        name !== 'service_launch_worker_ready'
      )
        return requestMetadata(name, args);
      const key = name + JSON.stringify(args);
      let pending = metadataReads.get(key);
      if (!pending) {
        pending = requestMetadata(name, args);
        metadataReads.set(key, pending);
      }
      return pending;
    }
  };
  const actorId = command.expectedActorId;
  const prepared: Record<string, unknown>[] = new Array(command.items.length);
  let cursor = 0;
  const prepare = async () => {
    while (cursor < command.items.length) {
      const index = cursor++,
        selected = command.items[index]!,
        row = context.items as unknown[];
      const value = row[index];
      if (
        !isRecord(value) ||
        value.launchId !== selected.launchId ||
        value.childRequestKey !== selected.childRequestKey ||
        value.expectedVersion !== selected.expectedVersion
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      if (value.skip === true) {
        if (!allowSkip) throw new TeamFunctionError('INVALID_RESPONSE');
        prepared[index] = { ...selected, skip: true };
        continue;
      }
      const base = { ...selected, sources: value.sources };
      if (value.errorCode !== null) {
        const code = TEAM_ERROR_CODES.find(code => code === value.errorCode);
        if (!code) throw new TeamFunctionError('INVALID_RESPONSE');
        prepared[index] = { ...base, errorCode: code };
        continue;
      }
      try {
        const config = parseLaunchConfig(value.config),
          sources = parseLaunchSources(value.sources);
        if (!config.ok || !sources) throw new TeamFunctionError('INVALID_INPUT');
        const preview = launchPreview(config.value, sources);
        if (!preview.ok) throw new TeamFunctionError('INVALID_INPUT');
        let video: Awaited<ReturnType<typeof prepareLaunchCatalogVideoAdmission>> | null = null;
        if (config.value.method === 'catalog') {
          const ready = await rpc(metadata, 'service_launch_worker_ready', {});
          if (ready !== true) throw new TeamFunctionError('NO_WORK');
          video = await prepareLaunchCatalogVideoAdmission(metadata, {
            teamId: command.teamId,
            actorId,
            launchId: selected.launchId,
            config: config.value,
            ...(command.expectedExecutorId
              ? { expectedExecutorId: command.expectedExecutorId }
              : {})
          });
        }
        const digest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                JSON.stringify({
                  actor: actorId,
                  team: command.teamId,
                  launch: selected.launchId,
                  version: selected.expectedVersion,
                  config: config.value,
                  sources,
                  ...(video ? { catalogExecutorId: video.executorId } : {})
                })
              )
            )
          ),
          b => b.toString(16).padStart(2, '0')
        ).join('');
        prepared[index] = {
          ...base,
          config: config.value,
          sources,
          preview: preview.value,
          video,
          digest,
          errorCode: null
        };
      } catch (error) {
        const code = launchFailure(error).code;
        prepared[index] = { ...base, errorCode: code };
      }
    }
  };
  // Bounded metadata reads, no Google IO before the durable acknowledgement.
  await Promise.all([prepare(), prepare()]);
  if (prepared.some(item => isRecord(item.video))) {
    try {
      const clock = await rpc(service, 'service_catalog_publication_clock', {});
      if (typeof clock !== 'number' || !Number.isSafeInteger(clock))
        throw new TeamFunctionError('INVALID_RESPONSE');
      for (const item of prepared)
        if (isRecord(item.video) && isRecord(item.video.plan)) item.video.plan.acceptedAt = clock;
    } catch (error) {
      const code = launchFailure(error).code;
      for (let index = 0; index < prepared.length; index++)
        if (isRecord(prepared[index]!.video))
          prepared[index] = { ...command.items[index], errorCode: code };
    }
  }
  return prepared;
}

function commandArgs(command: LaunchBatchCommand) {
  return {
    p_team: command.teamId,
    p_actor: command.expectedActorId,
    p_key: command.requestKey,
    p_intent: command
  };
}
function receipt(value: unknown, command: LaunchBatchCommand) {
  const result = parseDurableLaunchBatch(value);
  if (!result || result.teamId !== command.teamId || result.requestKey !== command.requestKey)
    throw new TeamFunctionError('INVALID_RESPONSE');
  return result;
}
export async function acceptLaunchBatch(service: ServiceRpcClient, actorId: string, raw: unknown) {
  const command = parseLaunchBatchCommand(raw);
  if (!command) throw new TeamFunctionError('INVALID_INPUT');
  if (command.expectedActorId !== actorId) throw new TeamFunctionError('PERMISSION_DENIED');
  const args = commandArgs(command),
    context = await rpc(service, 'service_launch_batch_context', args);
  if (!isRecord(context)) throw new TeamFunctionError('INVALID_RESPONSE');
  if (context.batch !== undefined) return receipt(context.batch, command);
  const prepared = await prepareLaunchBatch(service, command, context);
  return receipt(
    await rpc(service, 'service_accept_launch_batch', { ...args, p_prepared: prepared }),
    command
  );
}
/** The existing scheduled worker claims at most three due members from one
 * batch. Original CAS/keys and a short server lease fence every late retry. */
export async function recoverLaunchBatchAdmission(service: ServiceRpcClient) {
  const claim = await rpc(service, 'service_claim_launch_batch_admission_recovery', { p_limit: 3 });
  if (claim === null) return null;
  if (!isRecord(claim) || !isLaunchUuid(claim.owner) || !isRecord(claim.context))
    throw new TeamFunctionError('INVALID_RESPONSE');
  const command = parseLaunchBatchCommand(claim.command);
  if (!command) throw new TeamFunctionError('INVALID_RESPONSE');
  const prepared = await prepareLaunchBatch(service, command, claim.context, true);
  return receipt(
    await rpc(service, 'service_retry_launch_batch_admission', {
      ...commandArgs(command),
      p_prepared: prepared,
      p_owner: claim.owner
    }),
    command
  );
}

/** Non-catalog launches do no provider writes, but their source must still be
 * proven before the deterministic result is published. Recovery owns a lease. */
export async function recoverLaunchBatchOther(
  service: ServiceRpcClient,
  prove: (
    teamId: string,
    actorId: string,
    config: LaunchConfig,
    sources: LaunchSourceSnapshot
  ) => Promise<void>
) {
  await rpc(service, 'service_settle_launch_batch_cancellations', { p_limit: 3 });
  // Admission failures leave bounded leases for the next pass. Existing accepted
  // children still progress even if the retry-context transport is unavailable.
  await recoverLaunchBatchAdmission(service).catch(() => null);
  const rows = await rpc(service, 'service_list_launch_batch_other_recovery', { p_limit: 3 });
  if (!Array.isArray(rows) || rows.length > 3) throw new TeamFunctionError('INVALID_RESPONSE');
  const result = { completed: 0, pending: 0 };
  let advanced = false;
  for (const row of rows) {
    if (
      !isRecord(row) ||
      !isLaunchUuid(row.teamId) ||
      !isLaunchUuid(row.actorId) ||
      !isLaunchUuid(row.generationId)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const owner = crypto.randomUUID(),
      identity = {
        p_team: row.teamId,
        p_actor: row.actorId,
        p_generation: row.generationId,
        p_owner: owner
      };
    let fence: string | null = null;
    try {
      const claim = await rpc(service, 'service_claim_launch_generation', identity);
      if (!isRecord(claim) || claim.id !== row.generationId)
        throw new TeamFunctionError('INVALID_RESPONSE');
      if (claim.state === 'succeeded') {
        result.completed++;
        advanced = true;
        continue;
      }
      if (typeof claim.fence !== 'string') throw new TeamFunctionError('INVALID_RESPONSE');
      fence = claim.fence;
      const config = parseLaunchConfig(claim.config),
        sources = parseLaunchSources(claim.sources);
      if (!config.ok || config.value.method !== 'other' || !sources)
        throw new TeamFunctionError('INVALID_INPUT');
      await prove(row.teamId, row.actorId, config.value, sources);
      await rpc(service, 'service_publish_launch_batch_other_generation', {
        ...identity,
        p_fence: fence
      });
      result.completed++;
      advanced = true;
    } catch (error) {
      result.pending++;
      if (fence) {
        const code = launchFailure(error).code;
        try {
          await rpc(service, 'service_record_launch_batch_other_failure', {
            ...identity,
            p_fence: fence,
            p_code: code,
            p_transient: TRANSIENT.has(code),
            p_retry_after_ms: launchRetryAfterMs(error)
          });
          advanced = true;
        } catch {
          /* Lease expiry preserves fallback when failure acknowledgement is lost. */
        }
      }
    }
  }
  // A successful publication or acknowledged backoff frees this bounded slice.
  // Reuse the existing worker only when another eligible child remains. Failed
  // claims without progress and fully leased/backing-off queues never spin.
  if (advanced) await rpc(service, 'service_continue_launch_batch_recovery', {}).catch(() => null);
  return result;
}
