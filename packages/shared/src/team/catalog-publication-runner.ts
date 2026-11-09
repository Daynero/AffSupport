import {
  decideCatalogVideoWrite,
  type CatalogActiveVideoDelivery,
  type CatalogPublicationJob,
  type CatalogPublicationPolicy,
  type CatalogPublicationTarget
} from './catalog-publication-lifecycle.js';
export interface CatalogDuePublication {
  readonly catalogId: string;
  readonly policy: CatalogPublicationPolicy;
  readonly job: CatalogPublicationJob;
  readonly active: CatalogActiveVideoDelivery | null;
}
export type CatalogPublicationVerifyResult =
  | { outcome: 'verified'; providerRevision: string; verifiedAt: string }
  | { outcome: 'unknown' }
  | { outcome: 'absent' };
export interface CatalogPublicationAuthority {
  /** The existing scheduler owns bounded claims, real server time and leases. */
  claim(limit: number): Promise<readonly CatalogDuePublication[]>;
  now(): number;
  /** Must verify current membership/delegation/entitlement and immutable target access. */
  availability(item: CatalogDuePublication): Promise<'ready' | 'waiting' | 'blocked'>;
  wait(item: CatalogDuePublication, writerFence?: string): Promise<void>;
  /** Catalog-wide reservation must recheck revision, due policy and target atomically. */
  reserve(item: CatalogDuePublication): Promise<{ writerFence: string } | null>;
  /** Marks dispatched ownership before network I/O; an uncertain acknowledgement
   * must throw, so this invocation does not perform an unaccounted provider write. */
  dispatch(item: CatalogDuePublication, writerFence: string): Promise<void>;
  apply(item: CatalogDuePublication, writerFence: string): Promise<void>;
  /** Exact original owner readback compares actual video cells/recipe, not appProperties. */
  verify(item: CatalogDuePublication, writerFence: string): Promise<CatalogPublicationVerifyResult>;
  /** `absent` is a readback proof that the atomic write (cells + receipt marker) of
   * this fence is not in the target. The server alone decides, from its own clock,
   * whether enough time passed since dispatch to requeue under a new fence. */
  settle(
    item: CatalogDuePublication,
    writerFence: string,
    result: CatalogPublicationVerifyResult
  ): Promise<void>;
  reconcile(item: CatalogDuePublication): Promise<void>;
  blocked(
    item: CatalogDuePublication,
    reason:
      'target_unavailable' | 'job_blocked' | 'stale_job' | 'clock_unavailable' | 'invalid_due',
    writerFence?: string
  ): Promise<void>;
}
export interface CatalogPublicationTickResult {
  readonly claimed: number;
  readonly verified: number;
  readonly preserved: number;
  readonly waiting: number;
  readonly blocked: number;
  readonly uncertain: number;
}
/** Bounded sequential runner: no detached work, browser clock or local timer.
 * Only a verified exact-fence settlement promotes active delivery. A lost apply
 * reply still performs original-owner readback and never repeats apply. */
export async function runCatalogPublicationTick(
  authority: CatalogPublicationAuthority,
  limit = 3
): Promise<CatalogPublicationTickResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_INPUT');
  const claimed = await authority.claim(limit);
  if (claimed.length > limit) throw new Error('INVALID_RESPONSE');
  const items = claimed.map(item =>
    Object.freeze({
      catalogId: item.catalogId,
      policy: Object.freeze({ ...item.policy }),
      job: Object.freeze({ ...item.job, target: Object.freeze({ ...item.job.target }) }),
      active: item.active
        ? Object.freeze({ ...item.active, target: Object.freeze({ ...item.active.target }) })
        : null
    })
  );
  if (items.length > limit || new Set(items.map(item => item.catalogId)).size !== items.length)
    throw new Error('INVALID_RESPONSE');
  let verified = 0,
    preserved = 0,
    waiting = 0,
    blocked = 0,
    uncertain = 0;
  for (const item of items) {
    try {
      const initial = decideCatalogVideoWrite({
        ...item,
        serverNow: authority.now(),
        targetAvailable: true
      });
      if (initial.action === 'reconcile') {
        await authority.reconcile(item);
        uncertain++;
        continue;
      }
      if (initial.action === 'preserve_active') {
        preserved++;
        continue;
      }
      if (initial.action === 'blocked') {
        await authority.blocked(item, initial.reason);
        blocked++;
        continue;
      }
      const readiness = await authority.availability(item);
      if (readiness === 'waiting') {
        await authority.wait(item);
        waiting++;
        continue;
      }
      if (readiness === 'blocked') {
        await authority.blocked(item, 'target_unavailable');
        blocked++;
        continue;
      }
      const reserved = await authority.reserve(item);
      if (!reserved) {
        uncertain++;
        continue;
      }
      const writerFence = reserved.writerFence;
      if (typeof writerFence !== 'string' || !writerFence || writerFence.length > 128)
        throw new Error('INVALID_RESPONSE');
      // Revalidate immediately before dispatch. Reservation alone is not proof
      // that a revoked/deleted target may still be published.
      const readyAgain = await authority.availability(item);
      if (readyAgain === 'waiting') {
        await authority.wait(item, writerFence);
        waiting++;
        continue;
      }
      if (readyAgain === 'blocked') {
        await authority.blocked(item, 'target_unavailable', writerFence);
        blocked++;
        continue;
      }
      await authority.dispatch(item, writerFence);
      try {
        await authority.apply(item, writerFence);
      } catch {
        /* A lost response is not absence of a write. Verify original ownership. */
      }
      const result = await authority.verify(item, writerFence);
      await authority.settle(item, writerFence, result);
      if (result.outcome === 'verified') verified++;
      else uncertain++;
    } catch {
      uncertain++;
    }
  }
  return { claimed: items.length, verified, preserved, waiting, blocked, uncertain };
}
export type { CatalogPublicationTarget };
