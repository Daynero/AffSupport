export const CATALOG_FOREGROUND_VAULT_ACCOUNT = 'soty-recovery-beta-catalog-foreground';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  isRecord,
  parseCatalogVideoForegroundExecutor,
  parseCatalogVideoForegroundBinding,
  type CatalogVideoForegroundBinding,
  type CatalogVideoForegroundExecutor
} from '@video-compressor/shared';
import type { NativeRestitchVaultFile } from './native-restitch-vault.js';
/** When an interrupted creation is tried again without its dialog. The server
 * takes a variant over only after 2 minutes of silence, so the first attempt
 * may be refused; about an hour in all, then the dialog is needed again. */
export const FOREGROUND_RESUME_DELAYS_MS: readonly number[] = [
  60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000
];
/** Answers that no later attempt can change. */
const RESUME_FINAL = new Set([
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
  'EXPIRED',
  'WRONG_STATE',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'AGENT_UPDATE_REQUIRED'
]);
interface Entry {
  binding: CatalogVideoForegroundBinding;
  actorId: string;
  receipt: CatalogVideoForegroundExecutor;
  secret: string;
  setId?: string;
  ticket?: string;
  executionNativeInstanceId?: string;
  createdAt?: number;
  readyAt?: number;
  state: 'prepared' | 'running' | 'ready' | 'unknown' | 'unused' | 'canceled';
}
/** One accepted set, no background claim and no browser credentials. Secrets use
 * the same OS-key encrypted atomic vault as protected native restitch controls. */
export class CatalogVideoForegroundController {
  #entries = new Map<string, Entry>();
  #running = new Map<string, { abort: AbortController; task: Promise<void> }>();
  #serial: Promise<unknown> = Promise.resolve();
  #faulted = false;
  #epoch = 0;
  #stopping = false;
  #waiting = new Map<string, AbortController>();
  #waitingTasks = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      nativeInstanceId: string;
      currentActorId: () => string | null;
      allowed: () => boolean;
      vault: Pick<NativeRestitchVaultFile, 'read' | 'write'>;
      awaitBinding?: (
        body: Record<string, unknown>,
        signal: AbortSignal
      ) => Promise<Record<string, unknown>>;
      reconcileCanceled?: (
        setId: string,
        ticket: string,
        enrollmentId: string,
        oldExecutionBoot: string
      ) => Promise<boolean>;
      redeem: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
      /** Test seam: waits before each unattended resume attempt. */
      resumeDelaysMs?: readonly number[];
      run: (
        setId: string,
        ticket: string,
        enrollmentId: string,
        signal: AbortSignal,
        executionNativeInstanceId: string
      ) => Promise<unknown>;
    }
  ) {}
  async load() {
    try {
      await this.#load();
    } catch (error) {
      this.#faulted = true;
      throw error;
    }
  }
  async #load() {
    const raw = await this.options.vault.read();
    if (raw === null) return;
    if (!Array.isArray(raw) || raw.length > 128) throw new Error('PROCESS_RESULT_UNCERTAIN');
    for (const value of raw) {
      if (
        !isRecord(value) ||
        !parseCatalogVideoForegroundBinding(value.binding) ||
        typeof value.actorId !== 'string' ||
        typeof value.secret !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(value.secret) ||
        !parseCatalogVideoForegroundExecutor(value.receipt) ||
        !['prepared', 'running', 'ready', 'unknown', 'unused', 'canceled'].includes(
          String(value.state)
        )
      )
        throw new Error('PROCESS_RESULT_UNCERTAIN');
      const entry = value as unknown as Entry;
      if (
        entry.receipt.proofDigest !==
          createHash('sha256')
            .update('soty:catalog-video-foreground-proof:v1:' + entry.secret)
            .digest('hex') ||
        (entry.ticket !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(entry.ticket)) ||
        (entry.setId !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            entry.setId
          ))
      )
        throw new Error('PROCESS_RESULT_UNCERTAIN');
      if (this.#entries.has(entry.receipt.enrollmentId))
        throw new Error('PROCESS_RESULT_UNCERTAIN');
      // Process restart never silently takes over an interrupted execution.
      if (entry.state === 'running') entry.state = 'unknown';
      this.#entries.set(entry.receipt.enrollmentId, entry);
      if (
        entry.state === 'unknown' &&
        entry.setId &&
        entry.ticket &&
        this.options.reconcileCanceled
      )
        this.#recoverCanceled(entry);
      else if (!['ready', 'unused', 'canceled'].includes(entry.state)) this.#arm(entry);
    }
  }
  async #persist() {
    try {
      await this.options.vault.write([...this.#entries.values()]);
    } catch (error) {
      this.#faulted = true;
      throw new Error('PROCESS_RESULT_UNCERTAIN', { cause: error });
    }
  }
  #actor() {
    if (this.#stopping || this.#faulted) throw new Error('PROCESS_RESULT_UNCERTAIN');
    const actor = this.options.currentActorId();
    if (!actor || !this.options.allowed()) throw new Error('PERMISSION_DENIED');
    return actor;
  }
  prepare(raw: unknown): Promise<CatalogVideoForegroundExecutor> {
    const work = this.#serial.then(async () => {
      const binding = parseCatalogVideoForegroundBinding(raw),
        actorId = this.#actor();
      if (!binding) throw new Error('INVALID_INPUT');
      const prior = [...this.#entries.values()].find(
        e =>
          e.actorId === actorId &&
          e.binding.teamId === binding.teamId &&
          e.binding.requestKey === binding.requestKey
      );
      if (prior) {
        if (JSON.stringify(prior.binding) !== JSON.stringify(binding))
          throw new Error('REQUEST_REUSE_CONFLICT');
        this.#arm(prior);
        return { ...prior.receipt };
      }
      if (this.#entries.size >= 128) {
        // Only a fully read-back registered set may leave the bounded secret vault.
        // Never evict unknown, accepted or active original authority.
        const ready = [...this.#entries.values()]
          .filter(
            e =>
              ['ready', 'unused', 'canceled'].includes(e.state) &&
              !this.#running.has(e.receipt.enrollmentId) &&
              !this.#waiting.has(e.receipt.enrollmentId)
          )
          .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0))[0];
        if (!ready) throw new Error('PROCESS_RESULT_UNCERTAIN');
        this.#entries.delete(ready.receipt.enrollmentId);
        await this.#persist();
      }
      const secret = randomBytes(32).toString('base64url');
      const receipt: CatalogVideoForegroundExecutor = {
        protocolVersion: 1,
        enrollmentId: randomUUID(),
        nativeInstanceId: this.options.nativeInstanceId,
        proofDigest: createHash('sha256')
          .update('soty:catalog-video-foreground-proof:v1:' + secret)
          .digest('hex')
      };
      this.#entries.set(receipt.enrollmentId, {
        binding,
        actorId,
        receipt,
        secret,
        state: 'prepared',
        createdAt: Date.now()
      });
      await this.#persist();
      this.#arm(this.#entries.get(receipt.enrollmentId)!);
      return { ...receipt };
    });
    this.#serial = work.catch(() => {});
    return work;
  }
  attach(raw: unknown) {
    const work = this.#serial.then(() => this.#attach(raw));
    this.#serial = work.catch(() => {});
    return work;
  }
  async #attach(raw: unknown, boundGrant?: Record<string, unknown>) {
    const epoch = this.#epoch;
    if (
      !isRecord(raw) ||
      raw.protocolVersion !== 1 ||
      typeof raw.enrollmentId !== 'string' ||
      typeof raw.setId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw.setId)
    )
      throw new Error('INVALID_INPUT');
    const entry = this.#entries.get(raw.enrollmentId);
    if (
      !entry ||
      entry.actorId !== this.#actor() ||
      raw.teamId !== entry.binding.teamId ||
      raw.nativeInstanceId !== entry.receipt.nativeInstanceId ||
      (entry.setId && entry.setId !== raw.setId)
    )
      throw new Error('PERMISSION_DENIED');
    if (['unused', 'canceled'].includes(entry.state)) throw new Error('WRONG_STATE');
    if (!this.#running.has(raw.enrollmentId) && entry.state !== 'ready') {
      // Persist exact set before the first network call; lost ACK retries retain it.
      entry.setId = raw.setId;
      await this.#persist();
      const grant =
        boundGrant ??
        (await this.#grant(entry, body => this.options.redeem(body), {
          protocolVersion: 1,
          setId: entry.setId,
          enrollmentId: entry.receipt.enrollmentId,
          nativeInstanceId: entry.receipt.nativeInstanceId,
          executionNativeInstanceId: this.options.nativeInstanceId,
          expectedExecutionNativeInstanceId:
            entry.executionNativeInstanceId ?? entry.receipt.nativeInstanceId,
          proofSecret: entry.secret
        }));
      if (
        grant.protocolVersion !== 1 ||
        grant.setId !== entry.setId ||
        grant.executorId !== entry.receipt.enrollmentId ||
        grant.nativeInstanceId !== entry.receipt.nativeInstanceId ||
        grant.executionNativeInstanceId !== this.options.nativeInstanceId ||
        grant.actorId !== entry.actorId ||
        grant.teamId !== entry.binding.teamId ||
        grant.sourceMaterialId !== entry.binding.sourceMaterialId ||
        grant.requestKey !== entry.binding.requestKey ||
        (grant.expectedVersion == null ? undefined : Number(grant.expectedVersion)) !==
          entry.binding.expectedVersion ||
        typeof grant.ticket !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(grant.ticket)
      )
        throw new Error('INVALID_RESPONSE');
      if (this.#actor() !== entry.actorId) throw new Error('PERMISSION_DENIED');
      entry.ticket = grant.ticket;
      entry.executionNativeInstanceId = this.options.nativeInstanceId;
      entry.state = 'running';
      await this.#persist();
      if (epoch !== this.#epoch || this.#actor() !== entry.actorId) {
        entry.state = 'unknown';
        await this.#persist();
        throw new Error('PERMISSION_DENIED');
      }
      const abort = new AbortController();
      const task = Promise.resolve()
        .then(() =>
          this.options.run(
            entry.setId!,
            entry.ticket!,
            entry.receipt.enrollmentId,
            abort.signal,
            this.options.nativeInstanceId
          )
        )
        .then(
          () => {
            entry.state = abort.signal.aborted ? 'unknown' : 'ready';
            if (entry.state === 'ready') entry.readyAt = Date.now();
          },
          () => {
            entry.state = 'unknown';
          }
        )
        .finally(async () => {
          this.#running.delete(entry.receipt.enrollmentId);
          // Stopped by this agent (shutdown, account change): never resumed here.
          if (!abort.signal.aborted) this.#resume(entry);
          await this.#persist();
        })
        .catch(() => {
          this.#faulted = true;
        });
      this.#running.set(entry.receipt.enrollmentId, { abort, task });
    }
    return {
      protocolVersion: 1,
      setId: entry.setId,
      enrollmentId: entry.receipt.enrollmentId,
      state: entry.state
    };
  }
  async #grant(
    entry: Entry,
    send: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
    body: Record<string, unknown>
  ) {
    try {
      return await send(body);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'REQUEST_REUSE_CONFLICT') throw error;
      const observed = await send({
        ...body,
        executionNativeInstanceId: undefined,
        expectedExecutionNativeInstanceId: undefined
      });
      if (
        observed.state !== 'bound' ||
        observed.enrollmentId !== entry.receipt.enrollmentId ||
        observed.nativeInstanceId !== entry.receipt.nativeInstanceId ||
        observed.actorId !== entry.actorId ||
        observed.teamId !== entry.binding.teamId ||
        observed.sourceMaterialId !== entry.binding.sourceMaterialId ||
        observed.requestKey !== entry.binding.requestKey ||
        (observed.expectedVersion == null ? undefined : Number(observed.expectedVersion)) !==
          entry.binding.expectedVersion ||
        typeof observed.executionNativeInstanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          observed.executionNativeInstanceId
        ) ||
        (entry.setId && observed.setId !== entry.setId)
      )
        throw new Error('INVALID_RESPONSE', { cause: error });
      entry.executionNativeInstanceId = observed.executionNativeInstanceId;
      await this.#persist();
      return send({ ...body, expectedExecutionNativeInstanceId: entry.executionNativeInstanceId });
    }
  }
  #recoverCanceled(entry: Entry) {
    if (
      !this.options.reconcileCanceled ||
      !entry.setId ||
      !entry.ticket ||
      this.#waiting.has(entry.receipt.enrollmentId)
    )
      return;
    const abort = new AbortController();
    this.#waiting.set(entry.receipt.enrollmentId, abort);
    const task = Promise.resolve()
      .then(async () => {
        if (this.#actor() !== entry.actorId || abort.signal.aborted) return;
        const proven = await this.options.reconcileCanceled!(
          entry.setId!,
          entry.ticket!,
          entry.receipt.enrollmentId,
          entry.executionNativeInstanceId ?? entry.receipt.nativeInstanceId
        );
        if (proven === true) {
          entry.state = 'canceled';
          entry.readyAt = Date.now();
          await this.#persist();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.#waiting.delete(entry.receipt.enrollmentId);
        this.#waitingTasks.delete(task);
        if (!abort.signal.aborted) this.#resume(entry);
      });
    this.#waitingTasks.add(task);
  }
  /** An interrupted creation continues without its dialog: "Створення триває на
   * сервері, навіть коли це вікно закрите" (beta 2026-11-11: two requeued sets
   * waited with no dialog open). The server stays the arbiter: a redeem fails a
   * variant silent for 2 minutes and requeues it, and refuses a takeover while a
   * variant may still be running anywhere, so an attempt here is never a second
   * writer. A run that ends unknown again is tried on the next delay. */
  #resume(entry: Entry) {
    const id = entry.receipt.enrollmentId;
    if (
      !entry.setId ||
      entry.state !== 'unknown' ||
      // The server authority lives at most 24 hours; older entries only expire.
      (entry.createdAt !== undefined && Date.now() - entry.createdAt > 24 * 60 * 60 * 1000) ||
      this.#stopping ||
      this.#waiting.has(id) ||
      this.#running.has(id)
    )
      return;
    const abort = new AbortController();
    this.#waiting.set(id, abort);
    const delays = this.options.resumeDelaysMs ?? FOREGROUND_RESUME_DELAYS_MS;
    const task = (async () => {
      for (const wait of delays) {
        await delay(wait, undefined, { signal: abort.signal, ref: false });
        if (abort.signal.aborted || entry.state !== 'unknown' || !entry.setId) return;
        let actor: string;
        try {
          actor = this.#actor();
        } catch {
          if (this.#stopping || this.#faulted) return;
          continue;
        }
        if (actor !== entry.actorId) continue;
        try {
          await this.attach({
            protocolVersion: 1,
            teamId: entry.binding.teamId,
            setId: entry.setId,
            enrollmentId: id,
            nativeInstanceId: entry.receipt.nativeInstanceId
          });
        } catch (error) {
          if (error instanceof Error && RESUME_FINAL.has(error.message)) return;
          continue;
        }
        await this.#running.get(id)?.task;
        if (entry.state !== 'unknown') return;
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.#waiting.get(id) === abort) this.#waiting.delete(id);
        this.#waitingTasks.delete(task);
      });
    this.#waitingTasks.add(task);
  }
  #arm(entry: Entry) {
    if (
      !this.options.awaitBinding ||
      this.#waiting.has(entry.receipt.enrollmentId) ||
      this.#running.has(entry.receipt.enrollmentId) ||
      ['ready', 'unused', 'canceled'].includes(entry.state)
    )
      return;
    const abort = new AbortController();
    this.#waiting.set(entry.receipt.enrollmentId, abort);
    const deadline = Date.now() + 15 * 60 * 1000;
    const task = (async () => {
      while (!abort.signal.aborted && Date.now() < deadline) {
        if (this.#actor() !== entry.actorId) return;
        let grant: Record<string, unknown>;
        try {
          grant = await this.#grant(entry, body => this.options.awaitBinding!(body, abort.signal), {
            protocolVersion: 1,
            enrollmentId: entry.receipt.enrollmentId,
            nativeInstanceId: entry.receipt.nativeInstanceId,
            executionNativeInstanceId: this.options.nativeInstanceId,
            expectedExecutionNativeInstanceId:
              entry.executionNativeInstanceId ?? entry.receipt.nativeInstanceId,
            proofSecret: entry.secret
          });
        } catch (error) {
          if (
            error instanceof Error &&
            [
              'PERMISSION_DENIED',
              'AUTH_REQUIRED',
              'WRONG_STATE',
              'INVALID_INPUT',
              'INVALID_RESPONSE'
            ].includes(error.message)
          )
            return;
          await delay(2000, undefined, { signal: abort.signal, ref: false });
          continue;
        }
        if (abort.signal.aborted) return;
        if (grant.state === 'unused') {
          if (grant.enrollmentId !== entry.receipt.enrollmentId)
            throw new Error('INVALID_RESPONSE');
          const work = this.#serial.then(async () => {
            if (entry.setId || this.#running.has(entry.receipt.enrollmentId))
              throw new Error('PROCESS_RESULT_UNCERTAIN');
            entry.state = 'unused';
            entry.readyAt = Date.now();
            await this.#persist();
          });
          this.#serial = work.catch(() => {});
          await work;
          return;
        }
        if (grant.state === 'bound') {
          const work = this.#serial.then(() =>
            this.#attach(
              {
                protocolVersion: 1,
                teamId: entry.binding.teamId,
                setId: grant.setId,
                enrollmentId: entry.receipt.enrollmentId,
                nativeInstanceId: entry.receipt.nativeInstanceId
              },
              grant
            )
          );
          this.#serial = work.catch(() => {});
          await work;
          return;
        }
        if (grant.state !== 'pending' || grant.enrollmentId !== entry.receipt.enrollmentId)
          throw new Error('INVALID_RESPONSE');
        await delay(2000, undefined, { signal: abort.signal, ref: false });
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.#waiting.delete(entry.receipt.enrollmentId);
        this.#waitingTasks.delete(task);
      });
    this.#waitingTasks.add(task);
  }
  busy() {
    return this.#running.size > 0;
  }
  async prepareActorChange(actor: string | null) {
    this.#epoch++;
    for (const [id, abort] of this.#waiting)
      if (this.#entries.get(id)?.actorId !== actor) abort.abort();
    for (const [id, run] of this.#running)
      if (this.#entries.get(id)?.actorId !== actor) run.abort.abort(new Error('PERMISSION_DENIED'));
    await Promise.all([...this.#waitingTasks, ...[...this.#running.values()].map(r => r.task)]);
  }
  async shutdown() {
    this.#stopping = true;
    this.#epoch++;
    for (const abort of this.#waiting.values()) abort.abort();
    for (const run of this.#running.values())
      run.abort.abort(new Error('PROCESS_RESULT_UNCERTAIN'));
    await Promise.all([...this.#waitingTasks, ...[...this.#running.values()].map(r => r.task)]);
  }
}
