import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NativeUpdateCode } from '@video-compressor/shared';

export class AppUpdateError extends Error {
  constructor(readonly code: NativeUpdateCode) {
    super(code);
  }
}
export interface UpdateWorkload {
  busy(): boolean;
  flush(): Promise<void>;
  pauseAdmission(): () => void;
}
/** Linearizes request admission, background quiescence and the final durable flush. */
export class AgentUpdateCoordinator {
  private permits = new Set<symbol>();
  private hold: { attempt: string; epoch: string; resume: () => void; committed: boolean } | null =
    null;
  constructor(
    private readonly work: UpdateWorkload,
    private readonly scale: (ms: number) => number
  ) {}
  accepting() {
    return this.hold === null;
  }
  admission(): (() => void) | null {
    if (this.hold) return null;
    const token = Symbol();
    this.permits.add(token);
    return () => {
      this.permits.delete(token);
    };
  }
  acquire(attempt: string): string {
    if (this.hold) {
      if (this.hold.attempt === attempt) return this.hold.epoch;
      throw new AppUpdateError('APP_UPDATE_BUSY');
    }
    const epoch = randomUUID();
    // Install the hold before calling collaborators, including synchronous callbacks.
    this.hold = { attempt, epoch, committed: false, resume: () => undefined };
    try {
      this.hold.resume = this.work.pauseAdmission();
    } catch {
      this.hold = null;
      throw new AppUpdateError('APP_UPDATE_BUSY');
    }
    return epoch;
  }
  release(attempt: string, epoch: string): void {
    if (
      !this.hold ||
      this.hold.attempt !== attempt ||
      this.hold.epoch !== epoch ||
      this.hold.committed
    )
      throw new AppUpdateError('APP_UPDATE_WRONG_STATE');
    const resume = this.hold.resume;
    this.hold = null;
    resume();
  }
  /** Only a native receipt proving Sparkle never started may undo this commit. */
  releaseRejectedCommit(attempt: string, epoch: string): void {
    if (!this.hold || this.hold.attempt !== attempt || this.hold.epoch !== epoch)
      throw new AppUpdateError('APP_UPDATE_WRONG_STATE');
    this.hold.committed = false;
    this.release(attempt, epoch);
  }
  commit(attempt: string, epoch: string): void {
    if (
      !this.hold ||
      this.hold.attempt !== attempt ||
      this.hold.epoch !== epoch ||
      this.permits.size ||
      this.work.busy()
    )
      throw new AppUpdateError('APP_UPDATE_BUSY');
    this.hold.committed = true;
  }
  async drain(attempt: string, epoch: string, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    for (;;) {
      if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
      if (!this.hold || this.hold.attempt !== attempt || this.hold.epoch !== epoch)
        throw new AppUpdateError('APP_UPDATE_WRONG_STATE');
      if (performance.now() - started > this.scale(30 * 60_000))
        throw new AppUpdateError('APP_UPDATE_BUSY');
      if (!this.permits.size && !this.work.busy()) {
        try {
          await this.work.flush();
        } catch (error) {
          if (error instanceof Error && error.message === 'APP_UPDATE_BUSY')
            throw new AppUpdateError('APP_UPDATE_BUSY');
          throw new AppUpdateError('APP_UPDATE_FLUSH_FAILED');
        }
        if (signal.aborted) throw new AppUpdateError('APP_UPDATE_INTERRUPTED');
        if (this.hold?.attempt !== attempt || this.hold.epoch !== epoch)
          throw new AppUpdateError('APP_UPDATE_WRONG_STATE');
        if (!this.permits.size && !this.work.busy()) return;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 100);
        timer.unref();
      });
    }
  }
  registerAdmission(app: FastifyInstance): void {
    const releases = new WeakMap<FastifyRequest, () => void>();
    const release = (request: FastifyRequest) => {
      releases.get(request)?.();
      releases.delete(request);
    };
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
      if (route.startsWith('/api/app-update') || route.startsWith('/native/update/')) return;
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      const nativeWork = route.startsWith('/native/');
      if ((!mutation || !route.startsWith('/api/')) && !nativeWork) return;
      // Cancellation remains available while draining; resuming/starting does not.
      if (/(?:\/cancel|\/cancel-all|\/stop)$/.test(route)) return;
      const permit = this.admission();
      if (!permit) return reply.code(409).send({ error: 'UPDATE_PENDING' });
      releases.set(request, permit);
      reply.raw.once('finish', () => release(request));
      reply.raw.once('close', () => release(request));
    });
    app.addHook('onResponse', async request => {
      release(request);
    });
    app.addHook('onError', async request => {
      release(request);
    });
    app.addHook('onRequestAbort', async request => {
      release(request);
    });
  }
}
