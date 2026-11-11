import { TEAM_ERROR_CODES, STITCH_ERROR_CODES } from '@video-compressor/shared';
import { diagnostics } from '../server/diagnostics-log.js';
/** A child is persisted before work starts. Interrupted work is reconciled by its
 * original identity; neither a lost upload reply nor restart creates another child. */
export interface CatalogVariantChild {
  index: number;
  requestId: string;
  operationId: string | null;
  state: 'queued' | 'working' | 'unknown' | 'registered';
  outputId: string | null;
}
export interface CatalogVariantSnapshot {
  setId: string;
  revision: number;
  children: CatalogVariantChild[];
}
export interface CatalogVariantAuthority {
  load(): Promise<CatalogVariantSnapshot>;
  /** Atomic revision CAS, with an immutable set/index/request binding. */
  save(expectedRevision: number, next: CatalogVariantSnapshot): Promise<boolean>;
  reconcile(
    child: Readonly<CatalogVariantChild>,
    signal: AbortSignal
  ): Promise<
    | { kind: 'registered'; outputId: string; operationId: string }
    | { kind: 'admitted'; operationId: string }
    | { kind: 'absent' }
    /** `retry`: the server proved the operation failed without output and
     * requeued this variant under a new identity (bounded server-side). */
    | { kind: 'unknown'; retry?: { attempt: number } }
  >;
  admit(
    child: Readonly<CatalogVariantChild>,
    signal: AbortSignal
  ): Promise<{ operationId: string }>;
  /** Resolves only after durable output registration, never just upload acceptance. */
  execute(child: Readonly<CatalogVariantChild>, signal: AbortSignal): Promise<{ outputId: string }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () => new Error('PROCESS_RESULT_UNCERTAIN');
function capture(value: CatalogVariantSnapshot): CatalogVariantSnapshot {
  if (
    !UUID.test(value.setId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.children) ||
    value.children.length < 1 ||
    value.children.length > 400
  )
    throw uncertain();
  const ids = new Set<string>(),
    outputs = new Set<string>();
  const children = value.children.map((child, index) => {
    if (
      child.index !== index ||
      !UUID.test(child.requestId) ||
      ids.has(child.requestId) ||
      (child.operationId !== null && !UUID.test(child.operationId)) ||
      (child.state === 'registered' && child.operationId === null) ||
      !['queued', 'working', 'unknown', 'registered'].includes(child.state) ||
      (child.state === 'registered'
        ? !child.outputId || !UUID.test(child.outputId)
        : child.outputId !== null)
    )
      throw uncertain();
    ids.add(child.requestId);
    if (child.outputId) {
      if (outputs.has(child.outputId)) throw uncertain();
      outputs.add(child.outputId);
    }
    return { ...child };
  });
  return { setId: value.setId, revision: value.revision, children };
}
export interface CatalogVariantObservation {
  setId: string;
  childRequestId?: string;
  childOperationId?: string;
  errorCode?: string;
  /** Set only with `retrying`: which bounded retry of this variant begins. */
  retryAttempt?: number;
  stage:
    | 'accepted'
    | 'reconciling'
    | 'retrying'
    | 'processing'
    | 'registered'
    | 'ready'
    | 'unknown'
    | 'canceled';
  ready: number;
  total: number;
}
export class CatalogVariantExecutor {
  #running: Promise<CatalogVariantSnapshot> | null = null;
  constructor(
    private readonly authority: CatalogVariantAuthority,
    private readonly observe: (event: CatalogVariantObservation) => void = event => {
      diagnostics.record('team', 'catalog_variant_stage', {
        operationId: event.setId,
        ...(event.childRequestId ? { requestId: event.childRequestId } : {}),
        ...(event.childOperationId ? { childOperationId: event.childOperationId } : {}),
        stage: event.stage,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.retryAttempt ? { retryAttempt: event.retryAttempt } : {}),
        readyCount: event.ready,
        requestedCount: event.total
      });
    }
  ) {}
  run(
    signal: AbortSignal,
    progress: (ready: number, total: number) => void = () => {}
  ): Promise<CatalogVariantSnapshot> {
    if (this.#running) return this.#running;
    const work = this.#run(signal, progress).finally(() => {
      this.#running = null;
    });
    this.#running = work;
    return work;
  }
  async #run(signal: AbortSignal, progress: (ready: number, total: number) => void) {
    let snapshot = capture(await this.authority.load());
    const stage = (
      value: CatalogVariantObservation['stage'],
      child?: CatalogVariantChild,
      errorCode?: string,
      retryAttempt?: number
    ) => {
      try {
        this.observe({
          setId: snapshot.setId,
          ...(child
            ? {
                childRequestId: child.requestId,
                ...(child.operationId ? { childOperationId: child.operationId } : {})
              }
            : {}),
          stage: value,
          ...(errorCode ? { errorCode } : {}),
          ...(retryAttempt ? { retryAttempt } : {}),
          ready: snapshot.children.filter(c => c.state === 'registered').length,
          total: snapshot.children.length
        });
      } catch {
        /* Diagnostics cannot change output ownership. */
      }
    };
    stage('accepted');
    const current = () => {
      if (signal.aborted) {
        const code =
          signal.reason instanceof Error &&
          ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(signal.reason.message)
            ? signal.reason.message
            : 'PROCESS_CANCELED';
        stage(code === 'PROCESS_CANCELED' ? 'canceled' : 'unknown', undefined, code);
        throw new Error(code);
      }
    };
    const notify = () => {
      try {
        progress(
          snapshot.children.filter(c => c.state === 'registered').length,
          snapshot.children.length
        );
      } catch {
        /* Observation cannot change execution. */
      }
    };
    const save = async (
      index: number,
      state: CatalogVariantChild['state'],
      outputId: string | null = null,
      operationId: string | null = snapshot.children[index]!.operationId
    ) => {
      const next = capture({
        ...snapshot,
        revision: snapshot.revision + 1,
        children: snapshot.children.map(c =>
          c.index === index ? { ...c, state, outputId, operationId } : c
        )
      });
      if (!(await this.authority.save(snapshot.revision, next))) throw uncertain();
      snapshot = next;
    };
    notify();
    for (const original of snapshot.children) {
      current();
      let child = snapshot.children[original.index]!;
      if (child.state === 'registered') continue;
      if (child.state !== 'queued') {
        stage('reconciling', child);
        const observed = await this.authority.reconcile(Object.freeze({ ...child }), signal);
        current();
        if (observed.kind === 'unknown' && observed.retry) {
          // The requeued variant has a new request id and no operation; only the
          // authority's own snapshot may say so.
          snapshot = capture(await this.authority.load());
          current();
          child = snapshot.children[original.index]!;
          if (!child || child.state !== 'queued' || child.operationId !== null) {
            stage('unknown', child);
            throw uncertain();
          }
          stage('retrying', child, undefined, observed.retry.attempt);
        } else if (observed.kind === 'unknown') {
          stage('unknown', child);
          throw uncertain();
        } else if (observed.kind === 'registered') {
          await save(child.index, 'registered', observed.outputId, observed.operationId);
          notify();
          continue;
        }
        if (observed.kind === 'admitted') {
          await save(child.index, 'working', null, observed.operationId);
        } else if (child.operationId !== null) throw uncertain();
        // Only authoritative absence permits original-child admission.
      }
      await save(child.index, 'working');
      current();
      child = snapshot.children[child.index]!;
      try {
        if (child.operationId === null) {
          const accepted = await this.authority.admit(Object.freeze({ ...child }), signal);
          await save(child.index, 'working', null, accepted.operationId);
          child = snapshot.children[child.index]!;
          current();
        }
        stage('processing', child);
        const output = await this.authority.execute(Object.freeze({ ...child }), signal);
        // Persist confirmed registration even if cancellation arrived alongside it.
        await save(child.index, 'registered', output.outputId);
        notify();
        stage('registered', child);
      } catch (cause) {
        // Keep the persisted working identity if this checkpoint itself is unknown.
        await save(child.index, 'unknown').catch(() => undefined);
        const code = cause instanceof Error ? cause.message : '';
        stage(
          code === 'PROCESS_CANCELED' ? 'canceled' : 'unknown',
          child,
          signal.aborted &&
            !(
              signal.reason instanceof Error &&
              ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(signal.reason.message)
            )
            ? 'PROCESS_CANCELED'
            : new Set<string>([...TEAM_ERROR_CODES, ...STITCH_ERROR_CODES]).has(code)
              ? code
              : 'PROCESS_RESULT_UNCERTAIN'
        );
        throw cause;
      }
    }
    current();
    stage('ready');
    return capture(snapshot);
  }
}
