/** Publication ownership is independent from video preparation and routine updates.
 * These decisions authorize no provider write; the server must still reserve its
 * catalog-wide writer and verify current access and the immutable target. */
export type CatalogPublicationTarget =
  | Readonly<{ kind: 'source'; materialId: string; sourceVersion: string }>
  | Readonly<{ kind: 'video_set'; videoSetId: string; recipeRevision: number }>;
export type CatalogPublicationPolicy =
  | Readonly<{ mode: 'immediate'; revision: number }>
  | Readonly<{ mode: 'held'; revision: number }>
  | Readonly<{ mode: 'scheduled'; revision: number; dueAt: string; timeZone: string }>;
export type CatalogPublicationJobState =
  | 'waiting'
  | 'preparing'
  | 'applying'
  | 'verifying'
  | 'retry_wait'
  | 'unknown'
  | 'blocked'
  | 'cancel_requested'
  | 'published'
  | 'superseded'
  | 'held';
export interface CatalogPublicationJob {
  readonly revision: number;
  readonly writerFence: string | null;
  readonly state: CatalogPublicationJobState;
  readonly target: CatalogPublicationTarget;
}
export interface CatalogActiveVideoDelivery {
  readonly target: CatalogPublicationTarget;
  readonly providerRevision: string;
  readonly verifiedAt: string;
}
export type CatalogVideoWriteDecision =
  | Readonly<{ action: 'preserve_active'; target: CatalogPublicationTarget | null }>
  | Readonly<{ action: 'reserve_publication'; target: CatalogPublicationTarget; revision: number }>
  | Readonly<{ action: 'reconcile'; revision: number }>
  | Readonly<{
      action: 'blocked';
      reason:
        'clock_unavailable' | 'stale_job' | 'invalid_due' | 'target_unavailable' | 'job_blocked';
    }>;
const inFlight = new Set<CatalogPublicationJobState>([
  'applying',
  'verifying',
  'unknown',
  'cancel_requested'
]);
/** Background and routine writers share this gate. A pending replacement never
 * replaces an already verified target until publication settles successfully. */
export function decideCatalogVideoWrite(input: {
  policy: CatalogPublicationPolicy;
  job: CatalogPublicationJob | null;
  active: CatalogActiveVideoDelivery | null;
  serverNow: number;
  targetAvailable: boolean;
}): CatalogVideoWriteDecision {
  if (!Number.isSafeInteger(input.serverNow))
    return { action: 'blocked', reason: 'clock_unavailable' };
  const { policy, job, active } = input;
  if (job && inFlight.has(job.state)) return { action: 'reconcile', revision: job.revision };
  if (job && job.revision !== policy.revision) return { action: 'blocked', reason: 'stale_job' };
  const preserve = (): CatalogVideoWriteDecision => ({
    action: 'preserve_active',
    target: active?.target ?? null
  });
  if (policy.mode === 'held' || !job || ['published', 'superseded', 'held'].includes(job.state))
    return preserve();
  if (job.state === 'blocked') return { action: 'blocked', reason: 'job_blocked' };
  if (policy.mode === 'scheduled') {
    const due = Date.parse(policy.dueAt);
    if (!Number.isFinite(due)) return { action: 'blocked', reason: 'invalid_due' };
    if (input.serverNow < due) return preserve();
  }
  if (!input.targetAvailable) return { action: 'blocked', reason: 'target_unavailable' };
  return { action: 'reserve_publication', target: job.target, revision: job.revision };
}
/** Never erase links on cancellation, or promote a ready-but-unverified set. */
export function settleCatalogVideoPublication(input: {
  policy: CatalogPublicationPolicy;
  job: CatalogPublicationJob;
  expectedRevision: number;
  expectedFence: string;
  outcome: 'verified' | 'unknown' | 'failed';
  providerRevision?: string;
  verifiedAt?: string;
  active: CatalogActiveVideoDelivery | null;
}): { job: CatalogPublicationJob; active: CatalogActiveVideoDelivery | null } {
  const { job } = input;
  if (
    job.revision !== input.expectedRevision ||
    input.policy.revision !== input.expectedRevision ||
    !input.expectedFence ||
    job.writerFence !== input.expectedFence ||
    !['applying', 'verifying', 'unknown', 'cancel_requested'].includes(job.state)
  )
    throw new Error('PROCESS_RESULT_UNCERTAIN');
  if (input.outcome !== 'verified')
    return {
      job: { ...job, state: input.outcome === 'unknown' ? 'unknown' : 'blocked' },
      active: input.active
    };
  if (
    !input.providerRevision ||
    !input.verifiedAt ||
    !Number.isFinite(Date.parse(input.verifiedAt))
  )
    throw new Error('INVALID_INPUT');
  return {
    job: { ...job, state: 'published' },
    active: {
      target: job.target,
      providerRevision: input.providerRevision,
      verifiedAt: input.verifiedAt
    }
  };
}

/** Boundary for persisted publication bindings. Provider URLs and browser-supplied
 * source paths cannot become a publication target. */
export function parseCatalogPublicationTarget(raw: unknown): CatalogPublicationTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_INPUT');
  const value = raw as Record<string, unknown>;
  const uuid = (x: unknown): x is string =>
    typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(x);
  if (
    value.kind === 'source' &&
    uuid(value.materialId) &&
    typeof value.sourceVersion === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(value.sourceVersion) &&
    value.videoSetId === undefined &&
    value.recipeRevision === undefined
  )
    return Object.freeze({
      kind: 'source',
      materialId: value.materialId.toLowerCase(),
      sourceVersion: value.sourceVersion
    });
  if (
    value.kind === 'video_set' &&
    uuid(value.videoSetId) &&
    Number.isSafeInteger(value.recipeRevision) &&
    Number(value.recipeRevision) > 0 &&
    value.materialId === undefined &&
    value.sourceVersion === undefined
  )
    return Object.freeze({
      kind: 'video_set',
      videoSetId: value.videoSetId.toLowerCase(),
      recipeRevision: value.recipeRevision as number
    });
  throw new Error('INVALID_INPUT');
}
