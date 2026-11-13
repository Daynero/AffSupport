import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  NATIVE_UPDATE_LIMITS,
  PRODUCTION_SITE_ORIGIN,
  isNativeUpdateCommand,
  isNativeUpdateSnapshot,
  updateRecord,
  type NativeUpdateAction,
  type NativeUpdateCommand,
  type NativeUpdateSnapshot
} from '@video-compressor/shared';
import { EventChannel, type ChannelHub } from '../server/sse.js';
import {
  nativeUpdateHelperPids,
  type NativeUpdateHostConfiguration
} from '../platform/platform.js';
import type { PowerGovernor } from '../power/governor.js';
import type { DiagnosticsLog } from '../server/diagnostics-log.js';
import { AgentUpdateCoordinator, AppUpdateError } from './coordinator.js';
import { NativeUpdateBridge } from './native-bridge.js';
import {
  fetchNativeUpdateManifest,
  nativeUpdateFeed,
  prepareNativeArchive
} from './preparation.js';
import { writeUpdateReceipt } from './receipt.js';

type UpdateEvent = { type: 'app-update:state'; state: NativeUpdateSnapshot | null };
export class NativeAppUpdateService {
  private state: NativeUpdateSnapshot | null = null;
  private hello: { url: string; publicKey: string; channel: string; target: string } | null = null;
  private bridge: NativeUpdateBridge;
  private events: EventChannel<UpdateEvent>;
  private serial: Promise<void> = Promise.resolve();
  private job: Promise<void> | null = null;
  private abort = new AbortController();
  private checkAbort = new AbortController();
  private receiptWrites: Promise<void> = Promise.resolve();
  private hold: { attempt: string; epoch: string; committed: boolean } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checks: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private exiting = false;
  private helpers = new Map<number, () => void>();
  private lastDiagnostic = '';
  private closed = false;
  constructor(
    private readonly options: {
      host: NativeUpdateHostConfiguration;
      barrier: AgentUpdateCoordinator;
      power: PowerGovernor;
      origins: ReadonlySet<string>;
      hub: ChannelHub;
      bootId: string;
      buildId: string;
      sourceRevision: string;
      toolsReady: () => boolean;
      diagnostics: DiagnosticsLog;
      exitForUpdate: () => Promise<void>;
    }
  ) {
    this.bridge = new NativeUpdateBridge(options.host.socketPath, options.host.token);
    this.events = new EventChannel(options.origins, () => ({
      type: 'app-update:state',
      state: this.state
    }));
    this.events.publishOn(options.hub, 'app-update');
  }
  available() {
    return this.hello !== null && this.state !== null;
  }
  snapshot() {
    return this.state;
  }
  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work, work);
    this.serial = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  async start(): Promise<void> {
    const value = await this.bridge.request('hello', { pid: process.pid });
    if (
      !updateRecord(value) ||
      !isNativeUpdateSnapshot(value.state) ||
      typeof value.manifestURL !== 'string' ||
      typeof value.publicKey !== 'string' ||
      value.publicKey.length > 256 ||
      !['stable', 'beta'].includes(String(value.channel)) ||
      !['macos-arm64', 'macos-x64'].includes(String(value.target))
    )
      throw new AppUpdateError('APP_UPDATE_UNSUPPORTED');
    const url = new URL(value.manifestURL);
    if (
      value.channel === 'stable'
        ? value.manifestURL !== `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`
        : url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
    )
      throw new AppUpdateError('APP_UPDATE_MANIFEST_INVALID');
    this.hello = {
      url: value.manifestURL,
      publicKey: value.publicKey,
      channel: String(value.channel),
      target: String(value.target)
    };
    const receipts = await this.bridge.request('receipts');
    if (updateRecord(receipts) && Array.isArray(receipts.records)) {
      for (const record of receipts.records.slice(-NATIVE_UPDATE_LIMITS.historyEntries)) {
        if (
          updateRecord(record) &&
          isNativeUpdateSnapshot(record.state) &&
          record.state.installationId === value.state.installationId &&
          Number.isSafeInteger(record.sequence) &&
          typeof record.recordedAtMs === 'number' &&
          Number.isFinite(record.recordedAtMs)
        )
          this.diagnose(record.state, record.recordedAtMs, true);
      }
    }
    this.publish(value.state);
    if (
      [
        'target_started',
        'recovering',
        'unknown',
        'install_committed',
        'replacement_started',
        'relaunch_requested'
      ].includes(value.state.stage) &&
      value.state.attemptId
    ) {
      const epoch = this.options.barrier.acquire(value.state.attemptId);
      this.hold = {
        attempt: value.state.attemptId,
        epoch,
        committed: value.state.stage !== 'target_started'
      };
      if (value.state.stage === 'target_started' && this.options.toolsReady()) {
        await this.refresh('target-ready', {
          pid: process.pid,
          buildId: this.options.buildId,
          sourceRevision: this.options.sourceRevision,
          attemptId: value.state.attemptId,
          installationId: value.state.installationId
        });
        this.options.barrier.release(value.state.attemptId, epoch);
        this.hold = null;
      }
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, 500);
    this.timer.unref();
  }
  afterListening() {
    // Native monitoring is background infrastructure; browsers still use one SSE owner.
    this.checks = setInterval(() => {
      if (
        this.state &&
        [
          'idle',
          'offered',
          'prepared',
          'deferred',
          'ui_visible',
          'native_ready',
          'failed'
        ].includes(this.state.stage)
      )
        void this.command('check', this.nextCommand()).catch(() => undefined);
    }, NATIVE_UPDATE_LIMITS.checkIntervalMs);
    this.checks.unref();
    if (this.state && ['idle', 'offered', 'prepared', 'deferred'].includes(this.state.stage))
      void this.command('check', this.nextCommand()).catch(() => undefined);
  }
  private nextCommand(): NativeUpdateCommand {
    return {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      expectedRevision: this.state?.revision ?? 0,
      candidateId: this.state?.candidateId ?? null
    };
  }
  private publish(value: NativeUpdateSnapshot) {
    if (this.state && value.revision < this.state.revision) return;
    if (
      this.state &&
      value.revision === this.state.revision &&
      value.downloadedBytes === this.state.downloadedBytes &&
      value.stage === this.state.stage &&
      value.code === this.state.code &&
      value.nativeSuccess === this.state.nativeSuccess &&
      value.uiSuccess === this.state.uiSuccess
    )
      return;
    this.state = value;
    this.events.broadcast({ type: 'app-update:state', state: value });
    this.diagnose(value);
  }
  private diagnose(value: NativeUpdateSnapshot, nativeAtMs?: number, readback = false) {
    const diagnostic = `${value.attemptId}:${value.stage}:${value.code}`;
    if (diagnostic !== this.lastDiagnostic) {
      this.lastDiagnostic = diagnostic;
      this.options.diagnostics.record('update', 'native_update_stage', {
        stage: value.stage,
        last_proven_stage: value.lastProvenStage,
        outcome: value.uiSuccess
          ? 'ui_success'
          : value.nativeSuccess
            ? 'native_success'
            : value.stage,
        ...(value.operationId ? { operation_id: value.operationId } : {}),
        ...(value.attemptId ? { attempt_id: value.attemptId } : {}),
        installation_id: value.installationId,
        ...(value.candidate
          ? { target: value.candidate.target, artifact_sha256: value.candidate.archive.sha256 }
          : {}),
        ...(value.code ? { error_code: value.code } : {}),
        revision: value.revision,
        native_success: value.nativeSuccess,
        ui_success: value.uiSuccess,
        receipt_readback: readback,
        ...(nativeAtMs === undefined ? {} : { native_at_ms: nativeAtMs })
      });
    }
  }
  private async refresh(action: string, payload: unknown = {}): Promise<NativeUpdateSnapshot> {
    const value = await this.bridge.request(action, payload);
    if (!isNativeUpdateSnapshot(value)) throw new AppUpdateError('APP_UPDATE_INVALID');
    this.publish(value);
    return value;
  }
  private async check() {
    if (!this.hello) throw new AppUpdateError('APP_UPDATE_UNSUPPORTED');
    const envelope = await fetchNativeUpdateManifest({
      ...this.hello,
      url: this.hello.url,
      signal: this.checkAbort.signal
    });
    return this.refresh('offer', { payload: envelope.payload, signature: envelope.signature });
  }
  async command(
    action: NativeUpdateAction,
    command: NativeUpdateCommand
  ): Promise<NativeUpdateSnapshot> {
    // A validated native defer must be able to win while the final network
    // freshness read is in flight. Native revision/consent is the linearizer;
    // a stale or refused command never aborts somebody else's attempt.
    if (action === 'defer' || action === 'cancel') {
      if (!this.available()) throw new AppUpdateError('APP_UPDATE_UNSUPPORTED');
      const snapshot = await this.refresh('command', { action, command });
      this.abort.abort();
      const hold = this.hold;
      if (hold) {
        await this.receipt('released', snapshot);
        if (this.hold === hold) {
          if (hold.committed) this.options.barrier.releaseRejectedCommit(hold.attempt, hold.epoch);
          else this.options.barrier.release(hold.attempt, hold.epoch);
          this.hold = null;
        }
      }
      return snapshot;
    }
    return this.mutate(async () => {
      if (!this.available()) throw new AppUpdateError('APP_UPDATE_UNSUPPORTED');
      if (this.hold && action !== 'ack-visible') throw new AppUpdateError('APP_UPDATE_BUSY');
      if (action === 'check') {
        const snapshot = await this.check();
        if (snapshot.automaticDownload && snapshot.stage === 'offered')
          queueMicrotask(() => {
            void this.command('prepare', this.nextCommand()).catch(() => undefined);
          });
        return snapshot;
      }
      if (this.job && !['ack-visible', 'set-auto-download'].includes(action))
        throw new AppUpdateError('APP_UPDATE_BUSY');
      if (action === 'accept') await this.check();
      const snapshot = await this.refresh('command', {
        action,
        command,
        bootId: this.options.bootId
      });
      if (action === 'prepare' && snapshot.stage === 'preparing')
        this.launch(() => this.prepare(snapshot));
      if (action === 'accept' && snapshot.stage === 'consented')
        this.launch(() => this.install(snapshot));
      return snapshot;
    });
  }
  private launch(work: () => Promise<void>) {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.job = work()
      .catch(async error => {
        if (signal.aborted) return;
        const code = error instanceof AppUpdateError ? error.code : 'APP_UPDATE_INTERRUPTED';
        await this.refresh('failed', { code }).catch(() => undefined);
        if (this.hold && !this.hold.committed) {
          this.options.barrier.release(this.hold.attempt, this.hold.epoch);
          this.hold = null;
        }
      })
      .finally(() => {
        this.job = null;
      });
  }
  private async prepare(snapshot: NativeUpdateSnapshot) {
    if (!snapshot.candidate) throw new AppUpdateError('APP_UPDATE_INVALID');
    const signal = this.abort.signal;
    await prepareNativeArchive(
      snapshot.candidate,
      path.join(this.options.host.receiptDirectory, 'cache'),
      signal,
      bytes => {
        if (!signal.aborted) void this.refresh('progress', { bytes }).catch(() => undefined);
      }
    );
    if (!signal.aborted) await this.refresh('prepared', { candidateId: snapshot.candidateId });
  }
  private async receipt(
    stage: 'drained' | 'released' | 'committed',
    snapshot: NativeUpdateSnapshot
  ) {
    if (!this.hold || !snapshot.candidateId) throw new AppUpdateError('APP_UPDATE_WRONG_STATE');
    const receipt = {
      schemaVersion: 1 as const,
      attemptId: this.hold.attempt,
      candidateId: snapshot.candidateId,
      installationId: snapshot.installationId,
      bootId: this.options.bootId,
      epoch: this.hold.epoch,
      stage
    };
    const write = this.receiptWrites
      .catch(() => undefined)
      .then(() => writeUpdateReceipt(this.options.host.receiptDirectory, receipt));
    this.receiptWrites = write;
    await write;
  }
  private async install(snapshot: NativeUpdateSnapshot) {
    if (!snapshot.attemptId || !snapshot.candidateId)
      throw new AppUpdateError('APP_UPDATE_INVALID');
    const epoch = this.options.barrier.acquire(snapshot.attemptId);
    this.hold = { attempt: snapshot.attemptId, epoch, committed: false };
    const signal = this.abort.signal;
    await this.refresh('draining');
    await this.options.barrier.drain(snapshot.attemptId, epoch, signal);
    await this.receipt('drained', snapshot);
    await this.refresh('drained', { epoch });
    await this.mutate(async () => {
      if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
      const fresh = await this.check();
      if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
      if (fresh.candidateId !== snapshot.candidateId || fresh.attemptId !== snapshot.attemptId)
        throw new AppUpdateError('APP_UPDATE_CANDIDATE_CHANGED');
      if (!this.options.power.throttlingSupported() && this.options.power.limitPercent() < 100)
        throw new AppUpdateError('APP_UPDATE_POWER_UNAVAILABLE');
      await this.receipt('committed', snapshot);
      if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
      this.options.barrier.commit(snapshot.attemptId!, epoch);
      this.hold!.committed = true;
      try {
        await this.refresh('install', {
          attemptId: snapshot.attemptId,
          preparationBudgetMs: this.options.power.scaleTimeout(
            NATIVE_UPDATE_LIMITS.downloadTimeoutMs
          )
        });
      } catch (error) {
        // A lost IPC reply is uncertain. Release only after native readback
        // positively proves the SDK was never started for this same attempt.
        const proof = await this.bridge.request('pending').catch(() => null);
        if (
          updateRecord(proof) &&
          proof.handoffStarted === false &&
          isNativeUpdateSnapshot(proof.state) &&
          proof.state.attemptId === snapshot.attemptId &&
          ['failed', 'drained'].includes(proof.state.stage) &&
          proof.state.lastProvenStage === 'drained'
        ) {
          await this.receipt('released', proof.state);
          this.options.barrier.releaseRejectedCommit(snapshot.attemptId!, epoch);
          this.hold = null;
          this.publish(proof.state);
        }
        throw error;
      }
    });
  }
  private async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const value = await this.bridge.request('pending');
      if (
        !updateRecord(value) ||
        !isNativeUpdateSnapshot(value.state) ||
        typeof value.installerReady !== 'boolean'
      )
        throw new AppUpdateError('APP_UPDATE_INVALID');
      this.publish(value.state);
      if (
        this.hold?.committed &&
        value.handoffStarted === false &&
        value.state.attemptId === this.hold.attempt &&
        value.state.stage === 'failed' &&
        value.state.lastProvenStage === 'drained'
      ) {
        await this.receipt('released', value.state);
        this.options.barrier.releaseRejectedCommit(this.hold.attempt, this.hold.epoch);
        this.hold = null;
        for (const release of this.helpers.values()) release();
        this.helpers.clear();
      }
      if (value.checkRequested === true)
        void this.command('check', this.nextCommand()).catch(() => undefined);
      if (value.state.stage === 'target_started' && this.hold && this.options.toolsReady()) {
        const ready = await this.refresh('target-ready', {
          pid: process.pid,
          buildId: this.options.buildId,
          sourceRevision: this.options.sourceRevision,
          attemptId: value.state.attemptId,
          installationId: value.state.installationId
        });
        if (ready.nativeSuccess) {
          this.options.barrier.release(this.hold.attempt, this.hold.epoch);
          this.hold = null;
        }
      }
      if (value.state.stage === 'install_committed') {
        const live = new Set(await nativeUpdateHelperPids(this.options.host));
        for (const [pid, release] of this.helpers)
          if (!live.has(pid)) {
            release();
            this.helpers.delete(pid);
          }
        for (const pid of live)
          if (!this.helpers.has(pid))
            this.helpers.set(pid, this.options.power.registerNativeHelper(pid));
        if (value.installerReady && !this.exiting && this.hold?.committed) {
          this.exiting = true;
          for (const release of this.helpers.values()) release();
          this.helpers.clear();
          await this.options.exitForUpdate();
        }
      }
    } catch {
      /* A lost native reply is not installation failure or success. */
    } finally {
      this.polling = false;
    }
  }
  register(app: FastifyInstance) {
    this.options.barrier.registerAdmission(app);
    app.get('/api/app-update', async (_request, reply) =>
      this.available() ? this.state : reply.code(501).send({ error: 'APP_UPDATE_UNSUPPORTED' })
    );
    for (const action of [
      'check',
      'prepare',
      'accept',
      'defer',
      'cancel',
      'ack-visible',
      'set-auto-download'
    ] as const) {
      app.post(
        `/api/app-update/${action}`,
        { bodyLimit: NATIVE_UPDATE_LIMITS.commandBodyBytes },
        async (request, reply) => {
          if (!isNativeUpdateCommand(request.body))
            return reply.code(400).send({ error: 'APP_UPDATE_INVALID' });
          try {
            return reply.code(202).send(await this.command(action, request.body));
          } catch (error) {
            const code =
              error instanceof AppUpdateError ? error.code : 'APP_UPDATE_NATIVE_UNAVAILABLE';
            return reply
              .code(
                code === 'APP_UPDATE_UNSUPPORTED' ? 501 : code === 'APP_UPDATE_INVALID' ? 400 : 409
              )
              .send({ error: code });
          }
        }
      );
    }
    // Public, read-only metadata only. No native credential is attached to any
    // Sparkle HTTP request (its headers also travel to the GitHub download CDN).
    app.get('/.well-known/soty/app-update.xml', async (_request, reply) => {
      const snapshot = await this.bridge.snapshot();
      if (!snapshot.candidate || snapshot.stage !== 'install_committed')
        return reply.code(404).send();
      return reply
        .header('cache-control', 'no-store')
        .type('application/xml')
        .send(nativeUpdateFeed(snapshot.candidate));
    });
  }
  async close() {
    this.closed = true;
    this.abort.abort();
    this.checkAbort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.checks) clearInterval(this.checks);
    for (const release of this.helpers.values()) release();
    this.helpers.clear();
  }
}
