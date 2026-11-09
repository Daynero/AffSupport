import {
  SCREEN_SELECTION_BOUNDS,
  type ScreenTransferMeasurement
} from '../../../packages/shared/dist/team/restitch-selection.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { validateUpstreamRangeResponse } from '../drive-transfer/handler.ts';
import type { RestitchSelectionSlotStore } from './restitch-selection-store.ts';

const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
const canceled = () => new TeamFunctionError('PROCESS_CANCELED');
const QUIESCENCE_MS = 5000;
type StopCode = 'PROCESS_CANCELED' | 'RESTITCH_SCREEN_IO_LIMIT';
type BodyPurpose = 'control' | 'payload' | 'untracked';
type Body = {
  purpose: BodyPurpose;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  bytes: number;
  eof: boolean;
  terminal: boolean;
  canceled: boolean;
  closing?: Promise<void>;
};
export interface RestitchRangeUpstream {
  /** OAuth and metadata transport. Bodies are measured at read time. */
  fetch: typeof fetch;
  /** Restricted to the exact frozen source and reserved byte range. */
  fetchPayload: typeof fetch;
  signal: AbortSignal;
}
export interface RestitchRangeInput {
  store: Pick<RestitchSelectionSlotStore, 'reserve' | 'settle'>;
  versionId: string;
  requestId: string;
  acquisition: number;
  offset: number;
  /** Authoritative frozen candidate metadata, never copied from an HTTP counter payload. */
  sourceFileId: string;
  sourceBytes: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  signal?: AbortSignal;
}
export interface RestitchRangeDependencies {
  fetch: typeof fetch;
  /** Preload DB context before calling the reader; this callback uses the supplied transport. */
  open: (io: RestitchRangeUpstream, range: { start: number; end: number }) => Promise<Response>;
  now?: () => number;
}

/** One issued range only. No queue, credential storage or client measurement seam. */
class RangeUpstream implements RestitchRangeUpstream {
  #controller = new AbortController();
  #inputSignal?: AbortSignal;
  #fetch: typeof fetch;
  #now: () => number;
  #budget: number;
  #spent = 0;
  #lastClock: number | null = null;
  #failed = false;
  #retired = false;
  #stop: StopCode | null = null;
  #pending = new Set<Promise<unknown>>();
  #closing = new Set<Promise<void>>();
  #bodies = new Set<Body>();
  #responses = new WeakMap<Response, Body>();
  #payload: Body | null = null;
  #payloadDispatched = false;
  #onAbort = () => this.#stopWith('PROCESS_CANCELED');
  constructor(
    fetcher: typeof fetch,
    budget: number,
    now: () => number,
    private sourceFileId: string,
    private range: { start: number; end: number },
    signal?: AbortSignal
  ) {
    this.#fetch = fetcher;
    this.#budget = budget;
    this.#now = now;
    this.#inputSignal = signal;
    if (signal?.aborted) this.#onAbort();
    else signal?.addEventListener('abort', this.#onAbort, { once: true });
  }
  get signal() {
    return this.#controller.signal;
  }
  get stopCode() {
    return this.#stop;
  }
  #stopWith(code: StopCode) {
    this.#stop ??= code;
    this.#controller.abort();
  }
  #finish(body: Body) {
    body.terminal = true;
    this.#bodies.delete(body);
    try {
      body.reader?.releaseLock();
    } catch {
      /* A pending close still owns the reader. */
    }
  }
  #readClock() {
    const value = this.#now();
    if (!Number.isFinite(value) || (this.#lastClock !== null && value < this.#lastClock)) {
      this.#failed = true;
      return NaN;
    }
    this.#lastClock = value;
    return value;
  }
  async #wait<T>(work: () => Promise<T>): Promise<T> {
    if (this.#retired || this.#failed) throw uncertain();
    if (this.#stop) throw new TeamFunctionError(this.#stop);
    // The protected pipeline is sequential. Parallel work cannot borrow the same allowance.
    if (this.#pending.size) {
      this.#failed = true;
      throw uncertain();
    }
    const start = this.#readClock();
    const remaining = this.#budget - this.#spent;
    if (!Number.isFinite(start) || !Number.isFinite(remaining)) {
      this.#failed = true;
      throw uncertain();
    }
    if (remaining <= 0) {
      this.#stopWith('RESTITCH_SCREEN_IO_LIMIT');
      throw new TeamFunctionError('RESTITCH_SCREEN_IO_LIMIT');
    }
    let operation: Promise<T>;
    try {
      operation = Promise.resolve(work());
    } catch (error) {
      operation = Promise.reject(error);
    }
    let tracked: Promise<T>;
    const finish = () => {
      const end = this.#readClock();
      if (!Number.isFinite(end) || end < start) this.#failed = true;
      else this.#spent += end - start;
      this.#pending.delete(tracked);
    };
    tracked = operation.then(
      value => {
        finish();
        return value;
      },
      error => {
        finish();
        throw error;
      }
    );
    this.#pending.add(tracked);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(this.#stop ? new TeamFunctionError(this.#stop) : uncertain());
      this.signal.addEventListener('abort', interrupt, { once: true });
      // Work can abort synchronously before the listener is registered.
      if (this.signal.aborted) interrupt();
      timer = setTimeout(() => {
        this.#stopWith('RESTITCH_SCREEN_IO_LIMIT');
      }, remaining);
    });
    try {
      return await Promise.race([tracked, interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.signal.removeEventListener('abort', interrupt);
    }
  }
  #close(body: Body): Promise<void> {
    if (body.closing) return body.closing;
    if (body.terminal) return Promise.resolve();
    body.canceled = true;
    const closing = Promise.resolve()
      .then(() => (body.terminal ? undefined : body.reader?.cancel()))
      .then(
        () => {
          this.#finish(body);
        },
        () => {
          this.#failed = true;
        }
      );
    body.closing = closing;
    this.#closing.add(closing);
    void closing.then(() => this.#closing.delete(closing));
    return closing;
  }
  #wrap(response: Response, purpose: BodyPurpose): Response {
    const body: Body = {
      purpose,
      reader: response.body?.getReader() ?? null,
      bytes: 0,
      eof: false,
      terminal: !response.body,
      canceled: false
    };
    if (!body.reader) {
      this.#responses.set(response, body);
      return response;
    }
    this.#bodies.add(body);
    const reader = body.reader;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async controller => {
          try {
            const item = await this.#wait(async () => {
              let item: ReadableStreamReadResult<Uint8Array>;
              try {
                item = await reader.read();
              } catch (error) {
                this.#finish(body);
                throw error;
              }
              if (item.done) {
                body.eof = !body.canceled;
                this.#finish(body);
              } else {
                if (!(item.value instanceof Uint8Array)) {
                  this.#failed = true;
                  throw uncertain();
                }
                body.bytes += item.value.byteLength;
                if (!Number.isSafeInteger(body.bytes)) this.#failed = true;
              }
              return item;
            });
            if (item.done) controller.close();
            else controller.enqueue(item.value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel: () => this.#close(body)
      },
      { highWaterMark: 0 }
    );
    const wrapped = new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    this.#responses.set(wrapped, body);
    if (this.#retired) void this.#close(body);
    return wrapped;
  }
  fetch: typeof fetch = (input, init) => this.#performFetch(input, init, 'control');
  fetchPayload: typeof fetch = async (input, init) => {
    let valid = false;
    try {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const headers = new Headers(init?.headers ?? request?.headers);
      valid =
        url.origin === 'https://www.googleapis.com' &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname === '/drive/v3/files/' + encodeURIComponent(this.sourceFileId) &&
        url.searchParams.getAll('alt').length === 1 &&
        url.searchParams.get('alt') === 'media' &&
        (init?.method ?? request?.method ?? 'GET').toUpperCase() === 'GET' &&
        !init?.body &&
        !request?.body &&
        headers.get('range') === 'bytes=' + this.range.start + '-' + this.range.end;
    } catch {
      /* Invalid targets never reach the provider. */
    }
    if (!valid) throw new TeamFunctionError('INVALID_INPUT');
    if (this.#payloadDispatched) {
      this.#failed = true;
      throw uncertain();
    }
    this.#payloadDispatched = true;
    return this.#performFetch(input, init, 'payload');
  };
  async #performFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    purpose: BodyPurpose
  ) {
    return this.#wait(async () => {
      const signals = [this.signal];
      if (init?.signal) signals.push(init.signal);
      if (input instanceof Request) signals.push(input.signal);
      const response = await this.#fetch(input, { ...init, signal: AbortSignal.any(signals) });
      // Register before the tracked fetch settles, including a late canceled response.
      return this.#wrap(response, purpose);
    });
  }
  markPayload(response: Response) {
    const body = this.#responses.get(response);
    if (!body) {
      // Adopt an untracked body solely to cancel it; its cost is unknown.
      try {
        this.#wrap(response, 'untracked');
      } catch {
        /* Keep the reservation held. */
      }
    }
    if (!body || body.purpose !== 'payload' || body.bytes !== 0 || this.#payload) {
      this.#failed = true;
      throw uncertain();
    }
    this.#payload = body;
  }
  async quiesce() {
    this.#retired = true;
    this.#controller.abort();
    for (const body of this.#bodies) void this.#close(body);
    const drain = async () => {
      while (this.#pending.size || this.#closing.size) {
        await Promise.allSettled([...this.#pending, ...this.#closing]);
      }
      if (this.#bodies.size || this.#failed) throw uncertain();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(uncertain()), QUIESCENCE_MS);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#inputSignal?.removeEventListener('abort', this.#onAbort);
    }
  }
  measurement(maximumBytes: number, headersValid: boolean): ScreenTransferMeasurement {
    const bytes = this.#payload?.bytes ?? 0;
    const ioMs = Math.ceil(this.#spent);
    if (
      this.#failed ||
      this.#pending.size ||
      this.#closing.size ||
      this.#bodies.size ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maximumBytes ||
      !Number.isSafeInteger(ioMs) ||
      ioMs < 0
    )
      throw uncertain();
    return {
      bytes,
      ioMs,
      complete: headersValid && this.#payload?.eof === true && bytes === maximumBytes
    };
  }
}

function safeFailure(error: unknown): TeamFunctionError {
  return error instanceof TeamFunctionError
    ? new TeamFunctionError(error.code, { retryable: error.retryable })
    : new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
}

/** Buffer at most one fixed range. Server-observed prefixes and active fetch/read waits
 * are settled before a Response is exposed. This does not prove client delivery or decode.
 */
export async function readRestitchSelectionRange(
  input: RestitchRangeInput,
  deps: RestitchRangeDependencies
): Promise<Response> {
  if (input.signal?.aborted) throw canceled();
  if (
    typeof input.sourceFileId !== 'string' ||
    input.sourceFileId.length < 1 ||
    input.sourceFileId.length > 1024 ||
    !Number.isSafeInteger(input.sourceBytes) ||
    input.sourceBytes < 1 ||
    input.sourceBytes > SCREEN_SELECTION_BOUNDS.screenBytes ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset >= input.sourceBytes ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const permit = await input.store.reserve(
    input.versionId,
    input.requestId,
    input.offset,
    input.acquisition
  );
  const r = permit.reservation;
  const maximumBytes = Math.min(
    SCREEN_SELECTION_BOUNDS.rangeBytes,
    input.sourceBytes - input.offset
  );
  if (
    permit.kind !== 'dispatch' ||
    r.requestId !== input.requestId.toLowerCase() ||
    r.candidateVersionId !== input.versionId.toLowerCase() ||
    r.acquisition !== input.acquisition ||
    r.offset !== input.offset ||
    r.bytesReserved !== maximumBytes ||
    r.settlement !== null ||
    !Number.isSafeInteger(r.ioMsReserved) ||
    r.ioMsReserved < 1 ||
    r.ioMsReserved > SCREEN_SELECTION_BOUNDS.ioMs
  )
    throw uncertain();
  const range = { start: r.offset, end: r.offset + r.bytesReserved - 1 };
  const io = new RangeUpstream(
    deps.fetch,
    r.ioMsReserved,
    deps.now ?? (() => performance.now()),
    input.sourceFileId,
    range,
    input.signal
  );
  let failure: TeamFunctionError | null = null;
  let headersValid = false;
  let buffer: Uint8Array<ArrayBuffer> | null = null;
  let retained = 0;
  try {
    if (io.stopCode) throw new TeamFunctionError(io.stopCode);
    const response = await deps.open(io, range);
    io.markPayload(response);
    validateUpstreamRangeResponse(response.status, response.headers, range, input.sourceBytes);
    headersValid = true;
    const reader = response.body?.getReader();
    if (!reader) throw new TeamFunctionError('INVALID_RESPONSE');
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (retained + item.value.byteLength > maximumBytes) throw uncertain();
      buffer ??= new Uint8Array(maximumBytes);
      buffer.set(item.value, retained);
      retained += item.value.byteLength;
    }
    reader.releaseLock();
    if (retained !== maximumBytes)
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  } catch (error) {
    failure = safeFailure(error);
  }
  await io.quiesce();
  const measurement = io.measurement(maximumBytes, headersValid);
  await input.store.settle(input.requestId, measurement);
  if (input.signal?.aborted) throw canceled();
  if (io.stopCode) throw new TeamFunctionError(io.stopCode);
  if (failure) throw failure;
  if (!buffer || !measurement.complete || retained !== maximumBytes) throw uncertain();
  let remaining: Uint8Array<ArrayBuffer> | null = buffer;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!remaining) {
            controller.close();
            return;
          }
          const bytes = remaining;
          remaining = null;
          controller.enqueue(bytes);
        },
        cancel() {
          remaining = null;
        }
      },
      { highWaterMark: 0 }
    ),
    {
      status: 206,
      headers: {
        'content-type': input.mimeType,
        'content-length': String(maximumBytes),
        'content-range': 'bytes ' + range.start + '-' + range.end + '/' + input.sourceBytes,
        'x-restitch-request-id': r.requestId,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    }
  );
}
