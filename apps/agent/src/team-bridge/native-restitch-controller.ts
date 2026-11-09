import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  isRecord,
  TEAM_ERROR_CODES,
  STITCH_ERROR_CODES,
  parseTeamEdgeResult,
  parseTeamRestitchDefaults,
  type AppEnvironment,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import { diagnostics } from '../server/diagnostics-log.js';
import path from 'node:path';
import { applicationSupportRoot } from '../files/support-dir.js';
import { NativeRestitchVaultFile } from './native-restitch-vault.js';
import {
  NativeRestitchExecutor,
  type NativeRestitchCheckpoint,
  type NativeRestitchExecutorIdentity,
  type NativeRestitchOwnedReceipt
} from './native-restitch-executor.js';
import {
  createNativeScreenRecoveryProvider,
  type NativeScreenRecoveryScope
} from './native-screen-recovery-provider.js';
import { RestitchScreenDownloader } from './restitch-screen-download.js';
import {
  ScreenCacheError,
  type ProtectedScreenCacheBinding,
  type TeamScreenCache
} from './screen-cache.js';
import type { TeamAgentDownloadRequest, TeamDownloadFailureStage } from './download.js';
import type { TeamFileOperationResult } from '@video-compressor/shared';
import type { ScreenRecoveryProvider } from './screen-recovery.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const failureCodes = new Set<string>([...TEAM_ERROR_CODES, ...STITCH_ERROR_CODES]);
const uncertain = () => new ScreenCacheError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ScreenCacheError('INVALID_INPUT');
  return value.toLowerCase();
}
type RangeRecord = {
  slot: 'start' | 'end';
  versionId: string;
  acquisition: number;
  offset: number;
  requestId: string;
  grantId: string;
  refreshId: string | null;
};
type Credential = {
  logicalKind: 'download' | 'process';
  rootOperationId: string;
  teamId: string;
  actorId: string;
  nativeInstanceId: string;
  enrollmentId: string;
  claimId: string;
  proofSecret: string;
  ticket: string | null;
  closed: boolean;
  ranges: RangeRecord[];
};
export interface NativeRestitchDeliveryContext extends NativeScreenRecoveryScope {
  selectionProtocol: 1;
  defaults: TeamRestitchDefaults;
  source: {
    materialId: string;
    version: string;
    checksum: string;
    sizeBytes: number;
    mimeType: string;
  };
}
export interface NativeRestitchEnrollment {
  rootOperationId: string;
  teamId: string;
  actorId: string;
  nativeInstanceId: string;
  enrollmentId: string;
  proofDigest: string;
}
export interface NativeRestitchVault {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export interface NativeRestitchControllerOptions {
  endpoint: string;
  environment: AppEnvironment;
  currentActorId: () => string | null;
  vault?: NativeRestitchVault;
  /** Trusted runtime boot identity shared with installed variant recovery. */
  nativeInstanceId?: string;
  journal: {
    load(): Promise<readonly NativeRestitchCheckpoint[]>;
    save(value: readonly NativeRestitchCheckpoint[]): Promise<void>;
  };
  cache: Pick<TeamScreenCache, 'resolveProtected' | 'refusedProtected'>;
  fetch?: typeof fetch;
  run: (input: {
    request: TeamAgentDownloadRequest;
    provider: ScreenRecoveryProvider;
    context: NativeRestitchDeliveryContext;
    sourceFetch: typeof fetch;
    authorize: () => Promise<void>;
    reportFailureStage: (stage: TeamDownloadFailureStage) => void;
    signal: AbortSignal;
  }) => Promise<{
    saved: true;
    fileName: string;
    sizeBytes: number;
    destination: string;
    discovered?: unknown;
  }>;
}
function parseCredentials(value: unknown): Credential[] {
  if (value === null) return [];
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 64
  )
    throw uncertain();
  const records: Credential[] = value.records.map(raw => {
    if (
      !isRecord(raw) ||
      typeof raw.proofSecret !== 'string' ||
      !TOKEN.test(raw.proofSecret) ||
      (raw.ticket !== null && (typeof raw.ticket !== 'string' || !TOKEN.test(raw.ticket))) ||
      typeof raw.closed !== 'boolean' ||
      !Array.isArray(raw.ranges) ||
      raw.ranges.length > 2
    )
      throw uncertain();
    const ranges: RangeRecord[] = raw.ranges.map(r => {
      if (
        !isRecord(r) ||
        (r.slot !== 'start' && r.slot !== 'end') ||
        !Number.isSafeInteger(r.acquisition) ||
        Number(r.acquisition) < 0 ||
        Number(r.acquisition) > 2 ||
        !Number.isSafeInteger(r.offset) ||
        Number(r.offset) < 0 ||
        Number(r.offset) >= 50 * 1024 * 1024 ||
        (r.refreshId !== null && (typeof r.refreshId !== 'string' || !UUID.test(r.refreshId)))
      )
        throw uncertain();
      return {
        slot: r.slot,
        versionId: uuid(r.versionId),
        acquisition: r.acquisition as number,
        offset: r.offset as number,
        requestId: uuid(r.requestId),
        grantId: uuid(r.grantId),
        refreshId: r.refreshId === null ? null : uuid(r.refreshId)
      };
    });
    if (new Set(ranges.map(r => r.slot)).size !== ranges.length) throw uncertain();
    if (
      raw.logicalKind !== undefined &&
      raw.logicalKind !== 'download' &&
      raw.logicalKind !== 'process'
    )
      throw uncertain();
    return {
      logicalKind: raw.logicalKind === 'process' ? 'process' : 'download',
      rootOperationId: uuid(raw.rootOperationId),
      teamId: uuid(raw.teamId),
      actorId: uuid(raw.actorId),
      nativeInstanceId: uuid(raw.nativeInstanceId),
      enrollmentId: uuid(raw.enrollmentId),
      claimId: uuid(raw.claimId),
      proofSecret: raw.proofSecret,
      ticket: raw.ticket as string | null,
      closed: raw.closed,
      ranges
    };
  });
  if (
    new Set(records.map(r => r.rootOperationId)).size !== records.length ||
    new Set(records.map(r => r.enrollmentId)).size !== records.length
  )
    throw uncertain();
  return records;
}
/** Private controller. No request may supply its authority, vault or run callback. */
export class NativeRestitchController {
  readonly #native: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #vault: NativeRestitchVault;
  readonly #executor: NativeRestitchExecutor;
  #records: Credential[] = [];
  #ready: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();
  #vaultFailed = false;
  #closing = false;
  #identityChanges = 0;
  readonly #preparing = new Map<
    string,
    {
      team: string;
      logicalKind: 'download' | 'process';
      actor: string;
      controller: AbortController;
      completion: Promise<NativeRestitchEnrollment>;
    }
  >();
  readonly #active = new Map<
    string,
    { root: string; actor: string; completion: Promise<unknown>; controller: AbortController }
  >();
  readonly #redeeming = new Map<
    string,
    { actor: string; controller: AbortController; completion: Promise<void> }
  >();
  constructor(private readonly options: NativeRestitchControllerOptions) {
    const url = new URL(options.endpoint);
    // A beta agent stays on the local stack. A production agent reaches the hosted
    // backend over HTTPS, and may use a local stack in development.
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const reachable = loopback
      ? url.protocol === 'http:'
      : options.environment === 'production' && url.protocol === 'https:';
    if (
      !reachable ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/functions/v1/drive-ops'
    )
      throw new ScreenCacheError('INVALID_INPUT');
    this.#native =
      options.nativeInstanceId === undefined ? randomUUID() : uuid(options.nativeInstanceId);
    this.#endpoint = url.href;
    this.#fetch = options.fetch ?? fetch;
    const vaultIdentity = createHash('sha256')
      .update(options.environment + ':' + url.href)
      .digest('hex');
    this.#vault =
      options.vault ??
      new NativeRestitchVaultFile(
        path.join(
          applicationSupportRoot(),
          'NativeRestitch',
          options.environment,
          vaultIdentity + '.vault'
        ),
        'soty-recovery-restitch-' + vaultIdentity
      );
    this.#executor = new NativeRestitchExecutor({
      nativeInstanceId: this.#native,
      maxRetained: 64,
      currentActorId: options.currentActorId,
      journal: options.journal,
      authority: {
        claim: (identity, signal) => this.#claim(identity, signal),
        quiesce: (identity, receipt, nonce) => this.#quiesce(identity, receipt, nonce)
      }
    });
  }
  nativeInstanceId() {
    return this.#native;
  }
  async #initialize() {
    this.#ready ??= (async () => {
      try {
        this.#records = parseCredentials(await this.#vault.read());
        await this.#executor.initialize();
      } catch {
        this.#vaultFailed = true;
        throw uncertain();
      }
    })();
    await this.#ready;
  }
  #actor() {
    const actor = this.options.currentActorId();
    if (actor === null) throw new ScreenCacheError('AUTH_REQUIRED');
    return uuid(actor);
  }
  #fresh() {
    if (this.#closing) throw new ScreenCacheError('WRONG_STATE');
    if (this.#vaultFailed) throw uncertain();
    if (this.#identityChanges > 0) throw new ScreenCacheError('AUTH_REQUIRED');
  }
  #record(enrollment: string, fresh = true) {
    const record = this.#records.find(r => r.enrollmentId === uuid(enrollment));
    if (!record) throw uncertain();
    if (fresh) {
      this.#fresh();
      if (record.actorId !== this.#actor()) throw new ScreenCacheError('PERMISSION_DENIED');
      if (record.nativeInstanceId !== this.#native) throw uncertain();
      if (record.closed) throw new ScreenCacheError('PROCESS_RESULT_UNCERTAIN');
    }
    return record;
  }
  #root(identity: Readonly<NativeRestitchExecutorIdentity>) {
    const record = this.#records.find(r => r.rootOperationId === identity.rootOperationId);
    if (
      !record ||
      record.teamId !== identity.teamId ||
      record.actorId !== identity.actorId ||
      record.claimId !== identity.claimId ||
      record.nativeInstanceId !== identity.nativeInstanceId
    )
      throw uncertain();
    return record;
  }
  async #mutate(change: () => void) {
    const work = this.#writes.then(async () => {
      if (this.#vaultFailed) throw uncertain();
      change();
      try {
        await this.#vault.write(structuredClone({ schemaVersion: 1, records: this.#records }));
      } catch {
        this.#vaultFailed = true;
        throw uncertain();
      }
    });
    this.#writes = work.then(
      () => {},
      () => {}
    );
    await work;
  }
  async prepare(
    input: {
      rootOperationId: string;
      teamId: string;
    },
    logicalKind: 'download' | 'process' = 'download'
  ): Promise<NativeRestitchEnrollment> {
    const root = uuid(input.rootOperationId),
      team = uuid(input.teamId),
      actor = this.#actor();
    this.#fresh();
    const previous = this.#preparing.get(root);
    if (previous) {
      if (
        previous.team !== team ||
        previous.actor !== actor ||
        previous.logicalKind !== logicalKind
      )
        throw new ScreenCacheError('PERMISSION_DENIED');
      return previous.completion;
    }
    const controller = new AbortController();
    const completion = Promise.resolve()
      .then(() =>
        this.#prepare(
          { rootOperationId: root, teamId: team },
          actor,
          controller.signal,
          logicalKind
        )
      )
      .finally(() => this.#preparing.delete(root));
    this.#preparing.set(root, { team, actor, logicalKind, controller, completion });
    return completion;
  }
  async #prepare(
    input: {
      rootOperationId: string;
      teamId: string;
    },
    actorId: string,
    signal: AbortSignal,
    logicalKind: 'download' | 'process'
  ): Promise<NativeRestitchEnrollment> {
    const rootOperationId = uuid(input.rootOperationId),
      teamId = uuid(input.teamId);
    const current = () => {
      if (signal.aborted) throw new ScreenCacheError('PROCESS_CANCELED');
      this.#fresh();
      if (this.#actor() !== actorId) throw new ScreenCacheError('PERMISSION_DENIED');
    };
    await this.#initialize();
    current();
    let record = this.#records.find(r => r.rootOperationId === rootOperationId);
    if (record) {
      record = this.#record(record.enrollmentId);
      if (record.teamId !== teamId || record.logicalKind !== logicalKind)
        throw new ScreenCacheError('PERMISSION_DENIED');
    } else {
      if (this.#executor.snapshot(rootOperationId)) throw uncertain();
      record = {
        logicalKind,
        rootOperationId,
        teamId,
        actorId,
        nativeInstanceId: this.#native,
        enrollmentId: randomUUID(),
        claimId: randomUUID(),
        proofSecret: randomBytes(32).toString('base64url'),
        ticket: null,
        closed: false,
        ranges: []
      };
      const captured = record;
      await this.#mutate(() => {
        current();
        if (this.#records.length >= 64) {
          const index = this.#records.findIndex(r => r.closed);
          if (index < 0) throw new ScreenCacheError('RATE_LIMITED');
          this.#records.splice(index, 1);
        }
        this.#records.push(captured);
      });
    }
    current();
    return Object.freeze({
      rootOperationId,
      teamId,
      actorId,
      nativeInstanceId: record.nativeInstanceId,
      enrollmentId: record.enrollmentId,
      proofDigest: createHash('sha256')
        .update('soty:restitch-enrollment-proof:v1:' + record.proofSecret)
        .digest('hex')
    });
  }
  async #rpc(
    record: Credential,
    area: 'control' | 'selection',
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (
      !['quiesce', 'finish', 'read', 'abandon'].includes(action) &&
      this.options.currentActorId()?.toLowerCase() !== record.actorId
    )
      throw new ScreenCacheError('PERMISSION_DENIED');
    if (this.#vaultFailed && !['quiesce', 'finish', 'read', 'abandon'].includes(action))
      throw uncertain();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (action === 'redeem') headers['x-restitch-enrollment-secret'] = record.proofSecret;
    else {
      if (!record.ticket) throw new ScreenCacheError('AUTH_REQUIRED');
      headers['x-restitch-control-ticket'] = record.ticket;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      eof = false;
    try {
      const response = await this.#fetch(this.#endpoint + `/restitch/${area}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, protocolVersion: 1, grantId: record.enrollmentId }),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000)
      });
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw uncertain();
      reader = response.body?.getReader();
      if (!reader) throw uncertain();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          eof = true;
          break;
        }
        if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > 64 * 1024)
          throw uncertain();
        parts.push(part.value);
      }
      const parsed = parseTeamEdgeResult(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
      );
      if (!parsed.ok)
        throw new ScreenCacheError(
          parsed.error.code === 'EXPIRED' ? 'AUTH_REQUIRED' : parsed.error.code
        );
      if (!response.ok) throw uncertain();
      return parsed.value;
    } catch (error) {
      if (error instanceof ScreenCacheError) throw error;
      throw uncertain();
    } finally {
      if (reader) {
        if (!eof) await reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          /* the original transport still owns cancellation */
        }
      }
    }
  }
  async redeem(enrollmentId: string): Promise<void> {
    await this.#initialize();
    const record = this.#record(enrollmentId),
      old = this.#redeeming.get(record.enrollmentId);
    if (old) return old.completion;
    const controller = new AbortController();
    const completion = Promise.resolve()
      .then(async () => {
        const value = await this.#rpc(record, 'control', 'redeem', {}, controller.signal);
        if (
          !isRecord(value) ||
          value.grantId !== record.enrollmentId ||
          value.enrollmentId !== record.enrollmentId ||
          value.rootOperationId !== record.rootOperationId ||
          value.teamId !== record.teamId ||
          value.actorId !== record.actorId ||
          value.nativeInstanceId !== record.nativeInstanceId ||
          value.purpose !== 'restitch_native_control_v1' ||
          value.protocolVersion !== 1 ||
          value.redeemed !== true ||
          typeof value.ticket !== 'string' ||
          !TOKEN.test(value.ticket)
        )
          throw uncertain();
        const ticket = value.ticket;
        await this.#mutate(() => {
          record.ticket = ticket;
        });
        if (this.#actor() !== record.actorId || controller.signal.aborted)
          throw new ScreenCacheError('PERMISSION_DENIED');
      })
      .finally(() => this.#redeeming.delete(record.enrollmentId));
    this.#redeeming.set(record.enrollmentId, { actor: record.actorId, controller, completion });
    return completion;
  }
  async #claim(identity: Readonly<NativeRestitchExecutorIdentity>, signal: AbortSignal) {
    const record = this.#root(identity),
      body = { claimId: identity.claimId };
    try {
      return await this.#rpc(record, 'control', 'claim', body, signal);
    } catch (cause) {
      // The HTTP reply can disappear after the server commits ownership. Read only
      // the original claim, including after cancellation so its owner can quiesce.
      // A missing/unknown read never authorizes another claim or callback.
      const existing = await this.#rpc(record, 'control', 'read', body);
      if (existing === null) throw cause;
      return existing;
    }
  }
  async #quiesce(
    identity: Readonly<NativeRestitchExecutorIdentity>,
    _receipt: Readonly<NativeRestitchOwnedReceipt>,
    quiescenceId: string
  ) {
    const checkpoint = this.#executor.snapshot(identity.rootOperationId);
    if (!checkpoint || checkpoint.quiescenceId !== quiescenceId || !checkpoint.outcome)
      throw uncertain();
    const record = this.#root(identity);
    for (const range of record.ranges)
      await this.#rpc(record, 'selection', 'abandon', {
        slot: range.slot,
        requestId: range.requestId,
        rangeGrantId: range.grantId
      });
    return this.#rpc(record, 'control', 'finish', {
      claimId: identity.claimId,
      quiescenceId,
      outcome:
        checkpoint.outcome === 'returned'
          ? 'delivered'
          : checkpoint.outcome === 'canceled'
            ? 'canceled'
            : 'failed'
    });
  }
  #context(
    value: unknown,
    record: Credential,
    receipt: Readonly<NativeRestitchOwnedReceipt>
  ): NativeRestitchDeliveryContext {
    if (
      !isRecord(value) ||
      value.selectionProtocol !== 1 ||
      value.rootOperationId !== record.rootOperationId ||
      value.teamId !== record.teamId ||
      value.actorId !== record.actorId ||
      value.nativeInstanceId !== record.nativeInstanceId ||
      value.executorId !== receipt.executorId ||
      value.epoch !== receipt.epoch ||
      !isRecord(value.source)
    )
      throw uncertain();
    const defaults = parseTeamRestitchDefaults(value.defaults),
      source = value.source;
    if (
      !defaults.ok ||
      !defaults.value.configured ||
      defaults.value.sourceMode !== 'drive' ||
      !['stitch', 'restitch'].includes(defaults.value.operation) ||
      typeof source.version !== 'string' ||
      !source.version ||
      source.version.length > 1024 ||
      typeof source.checksum !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(source.checksum) ||
      !Number.isSafeInteger(source.sizeBytes) ||
      Number(source.sizeBytes) < 1 ||
      typeof source.mimeType !== 'string' ||
      !source.mimeType ||
      source.mimeType.length > 128
    )
      throw uncertain();
    return {
      selectionProtocol: 1,
      rootOperationId: record.rootOperationId,
      teamId: record.teamId,
      actorId: record.actorId,
      poolNamespaceId: uuid(value.poolNamespaceId),
      executorId: receipt.executorId,
      epoch: receipt.epoch,
      nativeInstanceId: record.nativeInstanceId,
      defaults: defaults.value,
      source: {
        materialId: uuid(source.materialId),
        version: source.version,
        checksum: source.checksum,
        sizeBytes: source.sizeBytes as number,
        mimeType: source.mimeType
      }
    };
  }
  async #range(
    record: Credential,
    binding: ProtectedScreenCacheBinding,
    offset: number,
    signal: AbortSignal
  ) {
    let entry: RangeRecord | undefined;
    await this.#mutate(() => {
      const previous = record.ranges.find(r => r.slot === binding.slot);
      if (
        previous &&
        previous.versionId === binding.versionId &&
        previous.acquisition === binding.acquisition &&
        previous.offset === offset
      ) {
        entry = previous;
        return;
      }
      entry = {
        slot: binding.slot,
        versionId: binding.versionId,
        acquisition: binding.acquisition,
        offset,
        requestId: randomUUID(),
        grantId: randomUUID(),
        refreshId: null
      };
      record.ranges = record.ranges.filter(r => r.slot !== binding.slot);
      record.ranges.push(entry);
    });
    if (!entry) throw uncertain();
    return this.#rpc(
      record,
      'selection',
      'range',
      {
        slot: binding.slot,
        versionId: binding.versionId,
        acquisition: binding.acquisition,
        offset,
        requestId: entry.requestId,
        rangeGrantId: entry.grantId
      },
      signal
    );
  }
  async #refresh(
    record: Credential,
    binding: ProtectedScreenCacheBinding,
    requestId: string,
    signal: AbortSignal
  ) {
    const original = record.ranges.find(
      r =>
        r.slot === binding.slot &&
        r.versionId === binding.versionId &&
        r.acquisition === binding.acquisition &&
        r.requestId === requestId
    );
    if (!original) throw uncertain();
    if (!original.refreshId)
      await this.#mutate(() => {
        original.refreshId = randomUUID();
      });
    const value = await this.#rpc(
      record,
      'selection',
      'refresh',
      {
        slot: binding.slot,
        versionId: binding.versionId,
        acquisition: binding.acquisition,
        requestId,
        rangeGrantId: original.grantId,
        refreshId: original.refreshId
      },
      signal
    );
    // The original leaf is retired only after its exact refresh acknowledgement.
    await this.#mutate(() => {
      record.ranges = record.ranges.filter(r => r !== original);
    });
    return value;
  }
  async download(enrollmentId: string, request: TeamAgentDownloadRequest) {
    return this.#execute(enrollmentId, request, 'download', this.options.run);
  }
  /** The callback resolves after upload and verified original-operation finalize;
   * local rendering alone must never settle protected selection accounting. */
  async process(
    enrollmentId: string,
    operationId: string,
    run: (
      input: Omit<Parameters<NativeRestitchControllerOptions['run']>[0], 'request'>
    ) => Promise<TeamFileOperationResult>
  ) {
    const request = {
      operationId: uuid(operationId),
      transferGrant: {}
    } as TeamAgentDownloadRequest;
    return this.#execute(enrollmentId, request, 'process', async input => {
      const result = await run({
        provider: input.provider,
        context: input.context,
        sourceFetch: input.sourceFetch,
        authorize: input.authorize,
        reportFailureStage: input.reportFailureStage,
        signal: input.signal
      }).catch(cause => {
        // A guarded original process cancellation is already canonical. Preserve
        // that outcome when closing the SAME native selection owner.
        if (cause instanceof Error && cause.message === 'PROCESS_CANCELED')
          this.#executor.cancel(operationId);
        throw cause;
      });
      if (result.operationId !== operationId || result.state !== 'succeeded' || !result.materialId)
        throw new ScreenCacheError('PROCESS_RESULT_UNCERTAIN');
      return result;
    });
  }
  async #execute<T>(
    enrollmentId: string,
    request: TeamAgentDownloadRequest,
    logicalKind: 'download' | 'process',
    run: (input: Parameters<NativeRestitchControllerOptions['run']>[0]) => Promise<T>
  ) {
    request = {
      ...request,
      operationId: uuid(request.operationId),
      transferGrant: { ...request.transferGrant },
      process: request.process ? { ...request.process } : null
    };
    await this.#initialize();
    const record = this.#record(enrollmentId);
    if (record.logicalKind !== logicalKind) throw new ScreenCacheError('WRONG_STATE');
    if (!record.ticket) throw new ScreenCacheError('AUTH_REQUIRED');
    if (
      this.#active.has(request.operationId) ||
      [...this.#active.values()].some(run => run.root === record.rootOperationId)
    )
      throw new ScreenCacheError('WRONG_STATE');
    if (this.#executor.snapshot(record.rootOperationId))
      throw new ScreenCacheError('PROCESS_RESULT_UNCERTAIN');
    const captured = request,
      controller = new AbortController();
    const completion = Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) throw new ScreenCacheError('PROCESS_CANCELED');
        let result: T | undefined, failure: unknown;
        let failureStage: TeamDownloadFailureStage = 'unknown';
        try {
          result = await this.#executor.execute(
            {
              rootOperationId: record.rootOperationId,
              teamId: record.teamId,
              actorId: record.actorId,
              claimId: record.claimId
            },
            async scope => {
              const abort = () =>
                controller.signal.reason instanceof Error &&
                ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(
                  controller.signal.reason.message
                )
                  ? this.#executor.interrupt(
                      record.rootOperationId,
                      controller.signal.reason.message as
                        'PROCESS_RESULT_UNCERTAIN' | 'PERMISSION_DENIED'
                    )
                  : this.#executor.cancel(record.rootOperationId);
              controller.signal.addEventListener('abort', abort, { once: true });
              scope.cleanup(async () => controller.signal.removeEventListener('abort', abort));
              if (controller.signal.aborted) abort();
              const context = this.#context(
                await scope.run(() =>
                  this.#rpc(record, 'selection', 'context', { slot: 'end' }, scope.signal)
                ),
                record,
                scope.receipt
              );
              const screenEndpoint = this.#endpoint.replace(
                /\/drive-ops$/u,
                '/drive-transfer/restitch/screen-range'
              );
              const downloader = new RestitchScreenDownloader({
                endpoint: screenEndpoint,
                fetchImpl: this.#fetch,
                authority: {
                  reserve: (binding, offset, signal) => this.#range(record, binding, offset, signal)
                }
              });
              const provider = createNativeScreenRecoveryProvider({
                scope: context,
                cache: this.options.cache,
                call: (action, body, signal) =>
                  this.#rpc(record, 'selection', action, body, signal),
                download: (binding, signal) => downloader.download(binding, signal),
                refresh: (binding, requestId, signal) =>
                  this.#refresh(record, binding, requestId, signal)
              });
              const sourceEndpoint = this.#endpoint.replace(
                /\/drive-ops$/u,
                '/drive-transfer/range'
              );
              const sourceFetch: typeof fetch = async (input, init) => {
                if (this.#vaultFailed) throw uncertain();
                scope.signal.throwIfAborted();
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (url.href !== sourceEndpoint || init?.method !== 'GET')
                  throw new ScreenCacheError('PERMISSION_DENIED');
                const headers = new Headers(init.headers);
                headers.set('x-restitch-control-grant', record.enrollmentId);
                headers.set('x-restitch-control-ticket', record.ticket!);
                headers.set('x-restitch-source-purpose', 'restitch_source_range_v1');
                const signals = [scope.signal];
                if (init.signal) signals.push(init.signal);
                return this.#fetch(sourceEndpoint.replace(/\/range$/u, '/restitch/source-range'), {
                  ...init,
                  headers,
                  redirect: 'error',
                  signal: AbortSignal.any(signals)
                });
              };
              const output = await scope.run(() =>
                run({
                  request: { ...captured, transferUrl: sourceEndpoint },
                  provider,
                  context,
                  sourceFetch,
                  reportFailureStage: stage => {
                    failureStage = stage;
                  },
                  authorize: async () => {
                    const current = await this.#rpc(
                      record,
                      'control',
                      'authorize',
                      {},
                      scope.signal
                    );
                    if (
                      !isRecord(current) ||
                      current.grantId !== record.enrollmentId ||
                      current.rootOperationId !== context.rootOperationId ||
                      current.actorId !== context.actorId ||
                      current.teamId !== context.teamId ||
                      current.nativeInstanceId !== context.nativeInstanceId ||
                      current.executorId !== context.executorId ||
                      current.epoch !== context.epoch ||
                      current.active !== true
                    )
                      throw uncertain();
                  },
                  signal: scope.signal
                })
              );
              if (logicalKind === 'download' && (!isRecord(output) || output.saved !== true))
                throw new ScreenCacheError('INVALID_RESPONSE');
              return output;
            }
          );
        } catch (error) {
          failure = error;
        }
        const checkpoint = this.#executor.snapshot(record.rootOperationId);
        if (checkpoint?.phase === 'quiescent' && checkpoint.quiescenceId) {
          try {
            await this.#mutate(() => {
              record.closed = true;
            });
          } catch {
            if (failure === undefined) failure = new ScreenCacheError('PROCESS_RESULT_UNCERTAIN');
          }
        }
        if (failure !== undefined) {
          const rawCode =
            failure instanceof ScreenCacheError
              ? failure.code
              : failure instanceof Error
                ? failure.message
                : '';
          const interrupted =
            controller.signal.reason instanceof Error &&
            ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(
              controller.signal.reason.message
            );
          const canceled =
            !interrupted &&
            (controller.signal.aborted ||
              rawCode === 'PROCESS_CANCELED' ||
              rawCode === 'DOWNLOAD_CANCELED');
          diagnostics.record('team', 'process_terminal', {
            operationId: record.rootOperationId,
            tool: 'restitch',
            stage: failureStage,
            outcome: canceled ? 'canceled' : 'failed',
            errorCode: canceled
              ? 'PROCESS_CANCELED'
              : interrupted
                ? (controller.signal.reason as Error).message
                : failureCodes.has(rawCode)
                  ? rawCode
                  : 'PROCESS_FAILED'
          });
          throw failure;
        }
        if (!result) throw uncertain();
        return result;
      })
      .finally(() => this.#active.delete(captured.operationId));
    this.#active.set(captured.operationId, {
      root: record.rootOperationId,
      actor: record.actorId,
      completion,
      controller
    });
    return completion;
  }
  async waitOperation(operationId: string) {
    await this.#active.get(operationId)?.completion.catch(() => undefined);
  }
  async cancelAll() {
    const pending = [
      ...[...this.#active.values()].map(r => r.completion),
      ...[...this.#redeeming.values()].map(r => r.completion),
      ...[...this.#preparing.values()].map(r => r.completion)
    ];
    for (const id of this.#active.keys()) this.cancelOperation(id);
    for (const r of this.#redeeming.values()) r.controller.abort();
    for (const r of this.#preparing.values()) r.controller.abort();
    await Promise.allSettled(pending);
    return pending.length;
  }
  async reconcile(enrollmentId: string) {
    await this.#initialize();
    const record = this.#record(enrollmentId);
    if (await this.#executor.reconcileClosure(record.rootOperationId)) {
      await this.#mutate(() => {
        record.closed = true;
      });
      return { reconciled: true, historical: true };
    }
    return { reconciled: false, historical: true };
  }
  /** Installed-runtime metadata only. Never redeems, claims, samples or runs media. */
  async reconcileCatalogCancellation(
    operationId: string,
    proveOriginalCanceled: () => Promise<boolean>
  ) {
    await this.#initialize();
    const record = this.#records.find(value => value.rootOperationId === uuid(operationId));
    if (
      !record ||
      record.logicalKind !== 'process' ||
      !record.ticket ||
      record.actorId !== this.#actor()
    )
      throw uncertain();
    return this.#executor.reconcileVerifiedCancellation(
      record.rootOperationId,
      async checkpoint => {
        if (
          checkpoint.identity.claimId !== record.claimId ||
          checkpoint.identity.nativeInstanceId !== record.nativeInstanceId ||
          checkpoint.identity.teamId !== record.teamId ||
          checkpoint.identity.actorId !== record.actorId ||
          !checkpoint.receipt ||
          !checkpoint.quiescenceId
        )
          throw uncertain();
        const original = await this.#rpc(record, 'control', 'read', { claimId: record.claimId });
        if (
          !isRecord(original) ||
          original.claimId !== record.claimId ||
          original.rootOperationId !== record.rootOperationId ||
          original.nativeInstanceId !== record.nativeInstanceId ||
          original.executorId !== checkpoint.receipt.executorId ||
          original.epoch !== checkpoint.receipt.epoch
        )
          throw uncertain();
        if ((await proveOriginalCanceled()) !== true) throw uncertain();
        for (const range of record.ranges)
          await this.#rpc(record, 'selection', 'abandon', {
            slot: range.slot,
            requestId: range.requestId,
            rangeGrantId: range.grantId
          });
        const result = await this.#rpc(record, 'control', 'finish', {
          claimId: record.claimId,
          quiescenceId: checkpoint.quiescenceId,
          outcome: 'canceled'
        });
        if (result !== true) throw uncertain();
        await this.#mutate(() => {
          record.closed = true;
        });
        return true;
      }
    );
  }
  cancelOperation(
    operationId: string,
    reason:
      'PROCESS_CANCELED' | 'PROCESS_RESULT_UNCERTAIN' | 'PERMISSION_DENIED' = 'PROCESS_CANCELED'
  ) {
    const active = this.#active.get(operationId);
    if (!active) return false;
    active.controller.abort(new Error(reason));
    if (reason !== 'PROCESS_CANCELED') this.#executor.interrupt(active.root, reason);
    else this.#executor.cancel(active.root);
    return true;
  }
  async prepareActorChange(actorId: string | null) {
    this.#identityChanges++;
    try {
      const next = actorId?.toLowerCase() ?? null,
        pending: Promise<unknown>[] = [];
      for (const [id, run] of this.#active)
        if (run.actor !== next) {
          this.cancelOperation(id);
          pending.push(run.completion);
        }
      for (const run of this.#redeeming.values())
        if (run.actor !== next) {
          run.controller.abort();
          pending.push(run.completion);
        }
      for (const run of this.#preparing.values())
        if (run.actor !== next) {
          run.controller.abort();
          pending.push(run.completion);
        }
      await Promise.allSettled(pending);
    } finally {
      this.#identityChanges--;
    }
  }
  busy() {
    return this.#active.size > 0 || this.#redeeming.size > 0 || this.#preparing.size > 0;
  }
  async shutdown() {
    this.#closing = true;
    for (const id of this.#active.keys()) this.cancelOperation(id);
    for (const run of this.#redeeming.values()) run.controller.abort();
    for (const run of this.#preparing.values()) run.controller.abort();
    await Promise.allSettled(
      [...this.#active.values()]
        .map(r => r.completion)
        .concat([...this.#redeeming.values()].map(r => r.completion))
    );
    await Promise.allSettled([...this.#preparing.values()].map(r => r.completion));
    await this.#executor.shutdown();
    await this.#writes;
  }
}
