import {
  runCatalogPublicationTick,
  type CatalogPublicationAuthority,
  type CatalogDuePublication,
  type CatalogPublicationVerifyResult
} from '../../../packages/shared/dist/team/catalog-publication-runner.js';
import { parseCatalogPublicationSnapshot } from '../../../packages/shared/dist/team/catalog-publication-api.js';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface CatalogPublicationIo {
  /** Explicit policy ratification is supplied by the integrating worker. This
   * adapter has no unconditional-write fallback or implicit policy default. */
  writerPolicy: 'soty_owned_video_cells' | 'immutable_new_catalog' | 'targeted_video_cells';
  /** Freezes at most one due job's payload; answers how many it prepared. */
  preparePending?(): Promise<number | void>;
  availability(
    item: CatalogDuePublication,
    scope: Readonly<{ teamId: string; actorId: string; jobId: string }>
  ): Promise<'ready' | 'waiting' | 'blocked'>;
  apply(
    item: CatalogDuePublication,
    fence: string,
    scope?: Readonly<{ teamId: string; actorId: string; jobId: string }>
  ): Promise<void>;
  verify(
    item: CatalogDuePublication,
    fence: string,
    scope?: Readonly<{ teamId: string; actorId: string; jobId: string }>
  ): Promise<CatalogPublicationVerifyResult>;
}
const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(x);
const uncertain = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
/** Actual service-RPC adapter for the existing bounded scheduler. No browser
 * polling and no alternative queue. Disabled until a writer policy is supplied. */
export function createCatalogPublicationAuthority(
  service: RpcClient,
  workerId: string,
  io: CatalogPublicationIo
): CatalogPublicationAuthority {
  if (
    !uuid(workerId) ||
    !['soty_owned_video_cells', 'immutable_new_catalog', 'targeted_video_cells'].includes(
      io.writerPolicy
    )
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const contexts = new Map<string, Readonly<{ teamId: string; actorId: string; jobId: string }>>();
  let clock: number | undefined;
  async function rpc(name: string, args: Record<string, unknown>) {
    const r = await service.rpc(name, args);
    if (r.error) throw uncertain();
    return r.data;
  }
  const context = (item: CatalogDuePublication) => {
    const c = contexts.get(item.catalogId);
    if (!c) throw uncertain();
    return c;
  };
  const owned = async (
    item: CatalogDuePublication,
    fence: string,
    outcome: string,
    providerRevision: string | null = null
  ) => {
    if (
      (await rpc('service_settle_catalog_publication', {
        p_job: context(item).jobId,
        p_worker: workerId,
        p_fence: fence,
        p_outcome: outcome,
        p_provider_revision: providerRevision
      })) !== true
    )
      throw uncertain();
  };
  const defer = async (
    item: CatalogDuePublication,
    state: 'waiting' | 'blocked',
    fence?: string
  ) => {
    if (fence) return owned(item, fence, state);
    if (
      (await rpc('service_defer_catalog_publication', {
        p_job: context(item).jobId,
        p_worker: workerId,
        p_state: state
      })) !== true
    )
      throw uncertain();
  };
  return {
    async claim(limit) {
      const raw = await rpc('service_claim_catalog_publication_jobs', {
        p_worker: workerId,
        p_limit: Math.min(limit, 3)
      });
      if (
        !isRecord(raw) ||
        !Number.isSafeInteger(raw.serverNow) ||
        !Array.isArray(raw.items) ||
        raw.items.length > Math.min(limit, 3)
      )
        throw uncertain();
      clock = raw.serverNow as number;
      contexts.clear();
      return raw.items.map(value => {
        if (
          !isRecord(value) ||
          !uuid(value.catalogId) ||
          !uuid(value.teamId) ||
          !uuid(value.actorId) ||
          !uuid(value.jobId) ||
          !isRecord(value.policy) ||
          !isRecord(value.job)
        )
          throw uncertain();
        const snapshot = parseCatalogPublicationSnapshot({
          catalogId: value.catalogId,
          serverNow: clock,
          revision: value.policy.revision,
          mode: value.policy.mode,
          dueAt: value.policy.dueAt,
          timeZone: value.policy.timeZone,
          target: value.job.target,
          job: { id: value.jobId, ...value.job },
          active: value.active
        });
        if (!snapshot || !snapshot.job || contexts.has(snapshot.catalogId)) throw uncertain();
        contexts.set(
          snapshot.catalogId,
          Object.freeze({ teamId: value.teamId, actorId: value.actorId, jobId: value.jobId })
        );
        const policy =
          snapshot.mode === 'scheduled'
            ? {
                mode: 'scheduled' as const,
                revision: snapshot.revision,
                dueAt: snapshot.dueAt!,
                timeZone: snapshot.timeZone!
              }
            : { mode: snapshot.mode, revision: snapshot.revision };
        return {
          catalogId: snapshot.catalogId,
          policy,
          job: {
            revision: snapshot.revision,
            state: snapshot.job.state,
            writerFence: snapshot.job.writerFence,
            target: snapshot.target
          },
          active: snapshot.active
        };
      });
    },
    now() {
      if (clock === undefined) throw uncertain();
      return clock;
    },
    availability(item) {
      return io.availability(item, context(item));
    },
    async reserve(item) {
      const fence = await rpc('service_reserve_catalog_publication', {
        p_job: context(item).jobId,
        p_worker: workerId
      });
      if (fence === null) return null;
      if (!uuid(fence)) throw uncertain();
      return { writerFence: fence };
    },
    async dispatch(item, fence) {
      if (
        (await rpc('service_dispatch_catalog_publication', {
          p_job: context(item).jobId,
          p_worker: workerId,
          p_fence: fence
        })) !== true
      )
        throw uncertain();
    },
    apply: (item, fence) => io.apply(item, fence, context(item)),
    verify: (item, fence) => io.verify(item, fence, context(item)),
    async settle(item, fence, result) {
      await owned(
        item,
        fence,
        result.outcome,
        result.outcome === 'verified' ? result.providerRevision : null
      );
    },
    async reconcile(item) {
      if (!item.job.writerFence) throw uncertain();
      const result = await io.verify(item, item.job.writerFence, context(item));
      await owned(
        item,
        item.job.writerFence,
        result.outcome,
        result.outcome === 'verified' ? result.providerRevision : null
      );
    },
    wait: (item, fence) => defer(item, 'waiting', fence),
    blocked: (item, _reason, fence) => defer(item, 'blocked', fence)
  };
}
export async function runCatalogPublicationScheduler(input: {
  service: RpcClient;
  workerId: string;
  io: CatalogPublicationIo | null;
}) {
  if (input.io === null) {
    const result = await input.service.rpc('service_mark_due_catalog_publications_unsupported', {
      p_limit: 3
    });
    if (
      result.error ||
      typeof result.data !== 'number' ||
      !Number.isSafeInteger(result.data) ||
      result.data < 0 ||
      result.data > 3
    )
      throw uncertain();
    return {
      enabled: false as const,
      code: 'CATALOG_WRITE_UNSUPPORTED' as const,
      blockedCount: result.data
    };
  }
  const prepared = (await input.io.preparePending?.()) ?? 0;
  if (input.io.writerPolicy === 'targeted_video_cells') {
    const revived = await input.service.rpc('service_requeue_catalog_publication_cell_jobs', {});
    if (
      revived.error ||
      typeof revived.data !== 'number' ||
      !Number.isSafeInteger(revived.data) ||
      revived.data < 0 ||
      revived.data > 3
    )
      throw uncertain();
  }
  return {
    enabled: true as const,
    prepared,
    ...(await runCatalogPublicationTick(
      createCatalogPublicationAuthority(input.service, input.workerId, input.io),
      3
    ))
  };
}
