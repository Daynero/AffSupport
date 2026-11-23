/** Publication ownership is independent from video preparation and routine updates.
 * These decisions authorize no provider write; the server must still reserve its
 * catalog-wide writer and verify current access and the immutable target. */
/** 062: one creative's block of rows in a catalog published from several creatives. */
export type CatalogPublicationSegment = Readonly<{
  ordinal: number;
  kind: 'video' | 'image';
  materialId: string;
  sourceVersion?: string;
  videoSetId?: string;
  recipeRevision?: number;
  imageId?: string;
  rowStart: number;
  rowCount: number;
}>;
export type CatalogPublicationTarget =
  | Readonly<{ kind: 'source'; materialId: string; sourceVersion: string }>
  | Readonly<{ kind: 'video_set'; videoSetId: string; recipeRevision: number }>
  | Readonly<{ kind: 'creatives'; segments: readonly CatalogPublicationSegment[] }>;
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
  // 062: the server's 'creatives' target (catalog_publication_target_json). Without it every
  // read of a catalog made from several creatives, or from images, failed as INVALID_RESPONSE
  // and its result said «ще не підтверджено» for good (next, 2026-11-21).
  if (
    value.kind === 'creatives' &&
    Array.isArray(value.segments) &&
    value.segments.length <= 400 &&
    Object.keys(value).length === 2
  ) {
    const count = (x: unknown, min: number, max: number): x is number =>
      Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
    const segments = value.segments.map((entry: unknown, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('INVALID_INPUT');
      const g = entry as Record<string, unknown>;
      if (
        g.ordinal !== index ||
        (g.kind !== 'video' && g.kind !== 'image') ||
        !uuid(g.materialId) ||
        (g.sourceVersion !== undefined &&
          (typeof g.sourceVersion !== 'string' ||
            !/^[A-Za-z0-9._:-]{1,128}$/u.test(g.sourceVersion))) ||
        (g.videoSetId !== undefined && (g.kind !== 'video' || !uuid(g.videoSetId))) ||
        (g.videoSetId === undefined) !== (g.recipeRevision === undefined) ||
        (g.recipeRevision !== undefined && !count(g.recipeRevision, 1, Number.MAX_SAFE_INTEGER)) ||
        (g.imageId !== undefined && (g.kind !== 'image' || !uuid(g.imageId))) ||
        !count(g.rowStart, 0, 399) ||
        !count(g.rowCount, 1, 400) ||
        (g.rowStart as number) + (g.rowCount as number) > 400
      )
        throw new Error('INVALID_INPUT');
      return Object.freeze({
        ordinal: index,
        kind: g.kind,
        materialId: g.materialId.toLowerCase(),
        ...(typeof g.sourceVersion === 'string' ? { sourceVersion: g.sourceVersion } : {}),
        ...(typeof g.videoSetId === 'string'
          ? { videoSetId: g.videoSetId.toLowerCase(), recipeRevision: g.recipeRevision as number }
          : {}),
        ...(typeof g.imageId === 'string' ? { imageId: g.imageId.toLowerCase() } : {}),
        rowStart: g.rowStart as number,
        rowCount: g.rowCount as number
      });
    });
    return Object.freeze({ kind: 'creatives', segments: Object.freeze(segments) });
  }
  throw new Error('INVALID_INPUT');
}
