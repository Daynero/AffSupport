import { randomUUID } from 'node:crypto';
import { isRecord, type TeamErrorCode } from '@video-compressor/shared';
export const MAX_NATIVE_RESTITCH_RECORDS = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = (cause?: unknown) =>
  new NativeRestitchExecutorError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', cause);
export class NativeRestitchExecutorError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    cause?: unknown
  ) {
    super(code, { cause });
  }
}
export interface NativeRestitchExecutorInput {
  rootOperationId: string;
  teamId: string;
  actorId: string;
  claimId: string;
}
export interface NativeRestitchExecutorIdentity extends NativeRestitchExecutorInput {
  nativeInstanceId: string;
  installedContract: 1;
}
export interface NativeRestitchOwnedReceipt {
  executorId: string;
  epoch: number;
}
export interface NativeRestitchCheckpoint {
  identity: NativeRestitchExecutorIdentity;
  receipt: NativeRestitchOwnedReceipt | null;
  quiescenceId: string | null;
  phase: 'claiming' | 'owned' | 'draining' | 'quiescing' | 'quiescent' | 'not_claimed' | 'blocked';
  reason:
    | 'claim_unconfirmed'
    | 'persistence_unconfirmed'
    | 'activity_unconfirmed'
    | 'quiescence_unconfirmed'
    | 'interrupted'
    | null;
  /** Local callback outcome, never a claim that an output reached the user. */
  outcome: 'returned' | 'rejected' | 'canceled' | null;
  touchedAt: string;
}
export interface NativeRestitchExecutionScope {
  readonly identity: Readonly<NativeRestitchExecutorIdentity>;
  readonly receipt: Readonly<NativeRestitchOwnedReceipt>;
  readonly signal: AbortSignal;
  /** Own the original promise before its factory can start or reenter shutdown. */
  run<T>(start: () => Promise<T>): Promise<T>;
  cleanup(close: () => Promise<void>): void;
}
export interface NativeRestitchExecutorOptions {
  nativeInstanceId: string;
  maxRetained: number;
  currentActorId: () => string | null;
  /** Private native-only authority adapter; never supplied by an HTTP caller. */
  authority: {
    claim(
      identity: Readonly<NativeRestitchExecutorIdentity>,
      signal: AbortSignal
    ): Promise<unknown>;
    quiesce(
      identity: Readonly<NativeRestitchExecutorIdentity>,
      receipt: Readonly<NativeRestitchOwnedReceipt>,
      quiescenceId: string
    ): Promise<unknown>;
  };
  /** Atomic, environment-scoped metadata. Credentials belong in platform storage. */
  journal: {
    load(): Promise<readonly NativeRestitchCheckpoint[]>;
    save(value: readonly NativeRestitchCheckpoint[]): Promise<void>;
  };
}
interface Execution {
  checkpoint: NativeRestitchCheckpoint;
  controller: AbortController;
  completion: Promise<void>;
  accepting: boolean;
  cancelRequested: boolean;
  pending: Set<Promise<void>>;
  cleanups: Array<() => Promise<void>>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw uncertain();
  return value.toLowerCase();
}
function copy(value: NativeRestitchCheckpoint): NativeRestitchCheckpoint {
  return {
    ...value,
    identity: { ...value.identity },
    receipt: value.receipt ? { ...value.receipt } : null
  };
}
function identity(
  input: NativeRestitchExecutorInput,
  nativeInstanceId: string
): Readonly<NativeRestitchExecutorIdentity> {
  return Object.freeze({
    rootOperationId: uuid(input.rootOperationId),
    teamId: uuid(input.teamId),
    actorId: uuid(input.actorId),
    claimId: uuid(input.claimId),
    nativeInstanceId,
    installedContract: 1
  });
}
function owned(
  value: unknown,
  scope: Readonly<NativeRestitchExecutorIdentity>
): Readonly<NativeRestitchOwnedReceipt> {
  if (!value || typeof value !== 'object') throw uncertain();
  const item = value as Record<string, unknown>;
  if (
    item.rootOperationId !== scope.rootOperationId ||
    item.claimId !== scope.claimId ||
    item.nativeInstanceId !== scope.nativeInstanceId ||
    item.active !== true ||
    !Number.isSafeInteger(item.epoch) ||
    Number(item.epoch) < 1
  )
    throw uncertain();
  return Object.freeze({ executorId: uuid(item.executorId), epoch: item.epoch as number });
}
export function parseNativeRestitchCheckpoint(value: unknown): NativeRestitchCheckpoint {
  if (!isRecord(value) || !isRecord(value.identity) || value.identity.installedContract !== 1)
    throw uncertain();
  const phase = (
    ['claiming', 'owned', 'draining', 'quiescing', 'quiescent', 'not_claimed', 'blocked'] as const
  ).find(item => item === value.phase);
  const reason = (
    [
      null,
      'claim_unconfirmed',
      'persistence_unconfirmed',
      'activity_unconfirmed',
      'quiescence_unconfirmed',
      'interrupted'
    ] as const
  ).find(item => item === value.reason);
  const outcome = ([null, 'returned', 'rejected', 'canceled'] as const).find(
    item => item === value.outcome
  );
  if (
    phase === undefined ||
    reason === undefined ||
    outcome === undefined ||
    typeof value.touchedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.touchedAt))
  )
    throw uncertain();
  const scope = identity(
    {
      rootOperationId: uuid(value.identity.rootOperationId),
      teamId: uuid(value.identity.teamId),
      actorId: uuid(value.identity.actorId),
      claimId: uuid(value.identity.claimId)
    },
    uuid(value.identity.nativeInstanceId)
  );
  let receipt: NativeRestitchOwnedReceipt | null = null;
  if (value.receipt !== null) {
    if (
      !isRecord(value.receipt) ||
      !Number.isSafeInteger(value.receipt.epoch) ||
      Number(value.receipt.epoch) < 1
    )
      throw uncertain();
    receipt = { executorId: uuid(value.receipt.executorId), epoch: value.receipt.epoch as number };
  }
  const quiescenceId = value.quiescenceId === null ? null : uuid(value.quiescenceId);
  if (phase === 'not_claimed' && (receipt !== null || quiescenceId !== null)) throw uncertain();
  if (
    (['owned', 'draining', 'quiescing', 'quiescent'].includes(phase) && !receipt) ||
    (['quiescing', 'quiescent'].includes(phase) && (!quiescenceId || outcome === null))
  )
    throw uncertain();
  return {
    identity: { ...scope },
    receipt,
    quiescenceId,
    phase,
    reason,
    outcome,
    touchedAt: value.touchedAt
  };
}
/** Owns local activity and exact closure. It does not advertise a capability or
 * authenticate browser assertions. A private enrolled control channel must bind
 * the authority adapter before this can participate in a product request. */
export class NativeRestitchExecutor {
  readonly #native: string;
  readonly #limit: number;
  readonly #actor: () => string | null;
  readonly #claim: NativeRestitchExecutorOptions['authority']['claim'];
  readonly #quiesce: NativeRestitchExecutorOptions['authority']['quiesce'];
  readonly #load: NativeRestitchExecutorOptions['journal']['load'];
  readonly #save: NativeRestitchExecutorOptions['journal']['save'];
  readonly #records = new Map<string, NativeRestitchCheckpoint>();
  readonly #active = new Map<string, Execution>();
  readonly #reconciling = new Map<string, Promise<boolean>>();
  // Process-local observation only. Restored metadata never recreates this proof.
  readonly #stopped = new Set<NativeRestitchCheckpoint>();
  #writes: Promise<void> = Promise.resolve();
  #initializing: Promise<void> | null = null;
  #ready = false;
  #closing = false;
  constructor(options: NativeRestitchExecutorOptions) {
    this.#native = uuid(options.nativeInstanceId);
    if (
      !Number.isSafeInteger(options.maxRetained) ||
      options.maxRetained < 1 ||
      options.maxRetained > MAX_NATIVE_RESTITCH_RECORDS
    )
      throw new NativeRestitchExecutorError('INVALID_INPUT');
    this.#limit = options.maxRetained;
    this.#actor = options.currentActorId.bind(options);
    this.#claim = options.authority.claim.bind(options.authority);
    this.#quiesce = options.authority.quiesce.bind(options.authority);
    this.#load = options.journal.load.bind(options.journal);
    this.#save = options.journal.save.bind(options.journal);
  }
  initialize(): Promise<void> {
    if (this.#closing) return Promise.reject(new NativeRestitchExecutorError('WRONG_STATE'));
    this.#initializing ??= Promise.resolve().then(async () => {
      const values = await this.#load();
      if (!Array.isArray(values) || values.length > this.#limit) throw uncertain();
      const loaded = new Map<string, NativeRestitchCheckpoint>();
      for (const raw of values) {
        const value = parseNativeRestitchCheckpoint(raw);
        if (loaded.has(value.identity.rootOperationId)) throw uncertain();
        if (!['quiescent', 'not_claimed'].includes(value.phase)) {
          value.phase = 'blocked';
          value.reason ??= 'interrupted';
        }
        loaded.set(value.identity.rootOperationId, value);
      }
      for (const [key, value] of loaded) this.#records.set(key, value);
      this.#ready = true;
    });
    return this.#initializing;
  }
  #persist(): Promise<void> {
    const values = [...this.#records.values()].map(copy);
    const write = this.#writes.catch(() => undefined).then(() => this.#save(values));
    this.#writes = write;
    return write;
  }
  #touch(
    run: Execution,
    phase: NativeRestitchCheckpoint['phase'],
    reason: NativeRestitchCheckpoint['reason'] = null
  ) {
    run.checkpoint.phase = phase;
    run.checkpoint.reason = reason;
    run.checkpoint.touchedAt = new Date().toISOString();
  }
  #abort(
    run: Execution,
    cancellation = true,
    interruption: 'PROCESS_RESULT_UNCERTAIN' | 'PERMISSION_DENIED' = 'PROCESS_RESULT_UNCERTAIN'
  ) {
    run.cancelRequested ||= cancellation;
    run.accepting = false;
    run.controller.abort(new Error(cancellation ? 'PROCESS_CANCELED' : interruption));
  }
  #check(run: Execution) {
    if (!run.accepting)
      throw new NativeRestitchExecutorError(
        run.controller.signal.aborted ? 'PROCESS_CANCELED' : 'WRONG_STATE'
      );
    if (this.#actor()?.toLowerCase() !== run.checkpoint.identity.actorId) this.#abort(run);
    if (run.controller.signal.aborted) throw new NativeRestitchExecutorError('PROCESS_CANCELED');
  }
  #scope(
    run: Execution,
    receipt: Readonly<NativeRestitchOwnedReceipt>
  ): NativeRestitchExecutionScope {
    return Object.freeze({
      identity: Object.freeze({ ...run.checkpoint.identity }),
      receipt,
      signal: run.controller.signal,
      run: <T>(start: () => Promise<T>): Promise<T> => {
        try {
          this.#check(run);
        } catch (cause) {
          const refused = Promise.reject<T>(cause);
          void refused.catch(() => undefined);
          return refused;
        }
        // Promise callbacks run after pending ownership has been registered.
        const task = Promise.resolve().then(() => {
          this.#check(run);
          return start();
        });
        const completion = task.then(
          () => undefined,
          () => undefined
        );
        run.pending.add(completion);
        void completion.then(() => {
          run.pending.delete(completion);
        });
        return task;
      },
      cleanup: (close: () => Promise<void>) => {
        this.#check(run);
        run.cleanups.push(close);
      }
    });
  }
  async execute<T>(
    input: NativeRestitchExecutorInput,
    work: (scope: NativeRestitchExecutionScope) => Promise<T>
  ): Promise<T> {
    if (!this.#ready || this.#closing) throw new NativeRestitchExecutorError('WRONG_STATE');
    const scope = identity(input, this.#native),
      key = scope.rootOperationId;
    if (this.#actor()?.toLowerCase() !== scope.actorId)
      throw new NativeRestitchExecutorError('PERMISSION_DENIED');
    const previous = this.#records.get(key);
    if (previous && previous.identity.actorId !== scope.actorId)
      throw new NativeRestitchExecutorError('PERMISSION_DENIED');
    if (this.#active.has(key) || this.#reconciling.has(key))
      throw new NativeRestitchExecutorError('WRONG_STATE');
    if (previous && !['quiescent', 'not_claimed'].includes(previous.phase)) throw uncertain();
    if (!previous && this.#records.size >= this.#limit) {
      const settled = [...this.#records].find(([, value]) =>
        ['quiescent', 'not_claimed'].includes(value.phase)
      );
      if (!settled) throw new NativeRestitchExecutorError('RATE_LIMITED');
      this.#records.delete(settled[0]);
      this.#stopped.delete(settled[1]);
    }
    let complete!: () => void;
    const run: Execution = {
      checkpoint: {
        identity: { ...scope },
        receipt: null,
        quiescenceId: null,
        phase: 'claiming',
        reason: null,
        outcome: null,
        touchedAt: new Date().toISOString()
      },
      controller: new AbortController(),
      completion: new Promise<void>(resolve => {
        complete = resolve;
      }),
      accepting: false,
      cancelRequested: false,
      pending: new Set(),
      cleanups: []
    };
    if (previous) this.#stopped.delete(previous);
    this.#records.delete(key);
    this.#records.set(key, run.checkpoint);
    this.#active.set(key, run);
    let value!: T,
      failure: unknown,
      failed = false,
      receipt: Readonly<NativeRestitchOwnedReceipt> | null = null;
    try {
      try {
        await this.#persist();
      } catch (cause) {
        this.#touch(run, 'blocked', 'persistence_unconfirmed');
        throw uncertain(cause);
      }
      if (run.controller.signal.aborted || this.#actor()?.toLowerCase() !== scope.actorId) {
        this.#abort(run);
        this.#touch(run, 'not_claimed');
        run.checkpoint.outcome = 'canceled';
        throw new NativeRestitchExecutorError('PROCESS_CANCELED');
      }
      try {
        receipt = owned(await this.#claim(scope, run.controller.signal), scope);
      } catch (cause) {
        this.#touch(run, 'blocked', 'claim_unconfirmed');
        throw uncertain(cause);
      }
      run.checkpoint.receipt = { ...receipt };
      this.#touch(run, 'owned');
      await this.#persist();
      if (run.controller.signal.aborted || this.#actor()?.toLowerCase() !== scope.actorId) {
        this.#abort(run);
        throw new NativeRestitchExecutorError('PROCESS_CANCELED');
      }
      run.accepting = true;
      value = await work(this.#scope(run, receipt));
    } catch (cause) {
      failed = true;
      failure = cause;
      if (receipt) this.#abort(run, false);
    }
    try {
      run.accepting = false;
      if (this.#actor()?.toLowerCase() !== scope.actorId) this.#abort(run);
      if (receipt) {
        this.#touch(run, 'draining');
        await Promise.all([...run.pending]);
        let cleanupFailed = false;
        for (const close of run.cleanups.reverse()) {
          try {
            await close();
          } catch {
            cleanupFailed = true;
          }
        }
        run.checkpoint.outcome = run.cancelRequested
          ? 'canceled'
          : failed
            ? 'rejected'
            : 'returned';
        if (cleanupFailed) {
          this.#touch(run, 'blocked', 'activity_unconfirmed');
          throw uncertain(failure);
        }
        run.checkpoint.quiescenceId = randomUUID();
        this.#touch(run, 'quiescing');
        this.#stopped.add(run.checkpoint);
        try {
          await this.#persist();
        } catch (cause) {
          this.#touch(run, 'blocked', 'persistence_unconfirmed');
          throw uncertain(cause);
        }
        try {
          if ((await this.#quiesce(scope, receipt, run.checkpoint.quiescenceId)) !== true)
            throw uncertain();
        } catch (cause) {
          this.#touch(run, 'blocked', 'quiescence_unconfirmed');
          throw uncertain(cause);
        }
        this.#touch(run, 'quiescent');
        await this.#persist();
        this.#stopped.delete(run.checkpoint);
      } else {
        await this.#persist().catch(() => undefined);
      }
      if (this.#actor()?.toLowerCase() !== scope.actorId) this.#abort(run);
      if (run.checkpoint.phase === 'blocked' && failed) throw failure;
      if (run.cancelRequested) throw new NativeRestitchExecutorError('PROCESS_CANCELED', failure);
      if (failed) throw failure;
      return value;
    } catch (cause) {
      if (run.checkpoint.phase === 'blocked') await this.#persist().catch(() => undefined);
      throw cause;
    } finally {
      this.#active.delete(key);
      complete();
    }
  }
  /** Reconcile only this process's fully joined work, using the already persisted
   * closure nonce. Never redelivers a callback result or initializes another claim.
   * A restarted process or unknown claim needs separate authoritative recovery. */
  async reconcileClosure(rootOperationId: string): Promise<boolean> {
    if (!this.#ready || this.#closing) throw new NativeRestitchExecutorError('WRONG_STATE');
    const key = uuid(rootOperationId),
      checkpoint = this.#records.get(key);
    if (!checkpoint) throw uncertain();
    if (this.#actor()?.toLowerCase() !== checkpoint.identity.actorId)
      throw new NativeRestitchExecutorError('PERMISSION_DENIED');
    if (this.#active.has(key)) throw new NativeRestitchExecutorError('WRONG_STATE');
    const existing = this.#reconciling.get(key);
    if (existing) return existing;
    if (checkpoint.phase === 'quiescent') return true;
    if (!this.#stopped.has(checkpoint) || !checkpoint.receipt || !checkpoint.quiescenceId)
      throw uncertain();
    const scope = Object.freeze({ ...checkpoint.identity });
    const receipt = Object.freeze({ ...checkpoint.receipt });
    const nonce = checkpoint.quiescenceId;
    const completion = Promise.resolve().then(async () => {
      try {
        if (this.#actor()?.toLowerCase() !== scope.actorId)
          throw new NativeRestitchExecutorError('PERMISSION_DENIED');
        checkpoint.phase = 'quiescing';
        checkpoint.reason = null;
        checkpoint.touchedAt = new Date().toISOString();
        try {
          // Retry persistence first if the original write was unconfirmed.
          await this.#persist();
        } catch (cause) {
          checkpoint.reason = 'persistence_unconfirmed';
          throw uncertain(cause);
        }
        if (this.#actor()?.toLowerCase() !== scope.actorId)
          throw new NativeRestitchExecutorError('PERMISSION_DENIED');
        try {
          if ((await this.#quiesce(scope, receipt, nonce)) !== true) throw uncertain();
        } catch (cause) {
          checkpoint.reason = 'quiescence_unconfirmed';
          throw uncertain(cause);
        }
        checkpoint.phase = 'quiescent';
        checkpoint.reason = null;
        checkpoint.touchedAt = new Date().toISOString();
        try {
          await this.#persist();
        } catch (cause) {
          checkpoint.reason = 'persistence_unconfirmed';
          throw uncertain(cause);
        }
        this.#stopped.delete(checkpoint);
        if (this.#actor()?.toLowerCase() !== scope.actorId)
          throw new NativeRestitchExecutorError('PERMISSION_DENIED');
        return true;
      } catch (cause) {
        // A confirmed remote close remains confirmed even after an actor change.
        if (checkpoint.phase !== 'quiescent' || checkpoint.reason !== null) {
          checkpoint.phase = 'blocked';
          checkpoint.reason ??= 'interrupted';
          await this.#persist().catch(() => undefined);
        }
        throw cause;
      } finally {
        this.#reconciling.delete(key);
      }
    });
    this.#reconciling.set(key, completion);
    return completion;
  }
  /** Closure-only recovery of an atomically persisted drained cancellation.
   * A new boot is not proof: the private adapter must validate the ORIGINAL
   * claim/receipt, guarded canonical cancellation and exact finish nonce. */
  async reconcileVerifiedCancellation(
    rootOperationId: string,
    verifyAndFinish: (checkpoint: Readonly<NativeRestitchCheckpoint>) => Promise<boolean>
  ): Promise<boolean> {
    if (!this.#ready || this.#closing) throw new NativeRestitchExecutorError('WRONG_STATE');
    const key = uuid(rootOperationId),
      checkpoint = this.#records.get(key);
    if (!checkpoint || this.#active.has(key)) throw uncertain();
    if (this.#actor()?.toLowerCase() !== checkpoint.identity.actorId)
      throw new NativeRestitchExecutorError('PERMISSION_DENIED');
    if (checkpoint.phase === 'quiescent') return true;
    if (
      checkpoint.phase !== 'blocked' ||
      checkpoint.reason !== 'quiescence_unconfirmed' ||
      !checkpoint.receipt ||
      !checkpoint.quiescenceId ||
      !['rejected', 'canceled'].includes(String(checkpoint.outcome))
    )
      throw uncertain();
    const existing = this.#reconciling.get(key);
    if (existing) return existing;
    const completion = Promise.resolve()
      .then(async () => {
        if ((await verifyAndFinish(Object.freeze(copy(checkpoint)))) !== true) throw uncertain();
        checkpoint.phase = 'quiescent';
        checkpoint.reason = null;
        checkpoint.touchedAt = new Date().toISOString();
        await this.#persist();
        this.#stopped.delete(checkpoint);
        return true;
      })
      .finally(() => this.#reconciling.delete(key));
    this.#reconciling.set(key, completion);
    return completion;
  }
  interrupt(
    rootOperationId: string,
    reason: 'PROCESS_RESULT_UNCERTAIN' | 'PERMISSION_DENIED' = 'PROCESS_RESULT_UNCERTAIN'
  ): boolean {
    const run = this.#active.get(rootOperationId.toLowerCase());
    if (!run || this.#actor()?.toLowerCase() !== run.checkpoint.identity.actorId) return false;
    this.#abort(run, false, reason);
    return true;
  }
  cancel(rootOperationId: string): boolean {
    const run = this.#active.get(rootOperationId.toLowerCase());
    if (!run || this.#actor()?.toLowerCase() !== run.checkpoint.identity.actorId) return false;
    this.#abort(run);
    return true;
  }
  busy(): boolean {
    return this.#active.size > 0 || this.#reconciling.size > 0;
  }
  snapshot(rootOperationId: string): NativeRestitchCheckpoint | null {
    const value = this.#records.get(rootOperationId.toLowerCase());
    return value && this.#actor()?.toLowerCase() === value.identity.actorId ? copy(value) : null;
  }
  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const run of this.#active.values()) this.#abort(run);
    await Promise.allSettled([
      ...[...this.#active.values()].map(run => run.completion),
      ...this.#reconciling.values()
    ]);
    await this.#writes.catch(() => undefined);
  }
}
