/**
 * A live-update reader that can send a header.
 *
 * `EventSource` cannot. That single limitation is why the seven per-tool stream URLs each
 * carry the session token as a query parameter — and a query parameter is the one place a
 * secret must never be, because it lands in server logs, in a `Referer`, and in whatever the
 * browser remembers about the page. The authentication contract this replaces it with is
 * stated in `contracts/agent-http.md §2`: the token travels as a request header, and a
 * reconnection re-authenticates rather than replaying a long-lived URL.
 *
 * `fetch` with a readable body is the only way to do that, which means parsing the
 * server-sent-events framing here rather than getting it from the platform. The format is
 * small and fixed, and the parser below is the whole of it.
 */

export interface StreamFrame {
  channel: string;
  event: unknown;
}

/** The agent refused the stream before any frame: the status says why. */
export class StreamRefusedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`stream refused: ${status}`);
    this.name = 'StreamRefusedError';
    this.status = status;
  }
}

/** The connection went quiet for longer than the agent's heartbeat allows (032 FR-003). */
export class StreamIdleError extends Error {
  constructor(idleMs: number) {
    super(`stream idle for ${idleMs}ms`);
    this.name = 'StreamIdleError';
  }
}

export interface StreamOptions {
  url: string;
  token: string;
  signal: AbortSignal;
  onFrame: (frame: StreamFrame) => void;
  /** Called once the response headers arrive, before any frame. */
  onOpen?: () => void;
  /**
   * A named event (`event: replaced`, `event: shutdown`) rather than a data frame. The
   * agent uses these to tell a client something about the connection itself.
   */
  onNamedEvent?: (name: string, data: string) => void;
  /**
   * How long the connection may stay silent before it is treated as dead.
   *
   * A socket that was torn down under the browser — a laptop that slept, a wifi handover —
   * does not always produce an error; `read()` just never resolves. The agent writes a
   * heartbeat comment every few seconds precisely so this can be noticed, and the reader is
   * the only place that sees every byte. Omit to disable (tests).
   */
  idleMs?: number;
  /** Called on every chunk, whatever it carries. */
  onActivity?: () => void;
}

/**
 * Reads one connection until it ends or is aborted.
 *
 * Resolves when the server closes the stream; rejects when the connection could not be
 * established or fails mid-read. The caller owns reconnection — a reader that reconnected
 * itself would have two policies for the same question, and the interface already has one.
 */
export async function readEventStream(options: StreamOptions): Promise<void> {
  // The idle watchdog aborts through its own controller so the caller can tell "the
  // interface gave up on this connection" from "the connection went quiet".
  const idle = new AbortController();
  // Combined by hand rather than with `AbortSignal.any`, which older Safari lacks.
  const onCallerAbort = () => idle.abort();
  if (options.idleMs) {
    if (options.signal.aborted) idle.abort();
    else options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const signal = options.idleMs ? idle.signal : options.signal;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (!options.idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), options.idleMs);
  };
  const disarmIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  try {
    armIdle();
    let response: Response;
    try {
      response = await fetch(options.url, {
        headers: { 'x-session-token': options.token, accept: 'text/event-stream' },
        signal,
        cache: 'no-store'
      });
    } catch (error) {
      if (idle.signal.aborted && !options.signal.aborted)
        throw new StreamIdleError(options.idleMs ?? 0);
      throw error;
    }

    if (!response.ok || !response.body) {
      throw new StreamRefusedError(response.status);
    }
    options.onOpen?.();
    armIdle();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (idle.signal.aborted && !options.signal.aborted)
          throw new StreamIdleError(options.idleMs ?? 0);
        throw error;
      }
      const { done, value } = chunk;
      if (done) return;
      armIdle();
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Anything after the last separator is a partial
      // frame and stays in the buffer — a chunk boundary falls wherever the network puts it,
      // not where the protocol would like it to.
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        emit(frame, options);
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    disarmIdle();
    options.signal.removeEventListener('abort', onCallerAbort);
  }
}

function emit(frame: string, options: StreamOptions): void {
  const data: string[] = [];
  let name: string | null = null;
  for (const line of frame.split('\n')) {
    // A line beginning with a colon is a comment — the heartbeat is one — and carries
    // nothing to deliver. Ignoring it here is what keeps the connection alive without the
    // interface ever seeing it.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (name) {
    // Named events are about the connection, not a channel: the agent says a newer client
    // replaced this one, or that it is shutting down. They never carry a channel frame.
    options.onNamedEvent?.(name, data.join('\n'));
    return;
  }
  if (data.length === 0) return;

  try {
    const parsed = JSON.parse(data.join('\n')) as StreamFrame;
    if (parsed && typeof parsed.channel === 'string') options.onFrame(parsed);
  } catch {
    // A malformed frame is dropped rather than thrown: the next snapshot is authoritative,
    // and tearing the connection down over one bad payload would lose the good ones behind
    // it.
  }
}

/** The multiplexed stream's URL. Carries no secret, so it is safe in a log or a referrer. */
export function streamUrl(agentUrl: string, channels: readonly string[]): string {
  const query = channels.length > 0 ? `?channels=${encodeURIComponent(channels.join(','))}` : '';
  return `${agentUrl}/api/stream${query}`;
}
