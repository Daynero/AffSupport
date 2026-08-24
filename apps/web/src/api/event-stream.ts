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

export interface StreamOptions {
  url: string;
  token: string;
  signal: AbortSignal;
  onFrame: (frame: StreamFrame) => void;
  /** Called once the response headers arrive, before any frame. */
  onOpen?: () => void;
}

/**
 * Reads one connection until it ends or is aborted.
 *
 * Resolves when the server closes the stream; rejects when the connection could not be
 * established or fails mid-read. The caller owns reconnection — a reader that reconnected
 * itself would have two policies for the same question, and the interface already has one.
 */
export async function readEventStream(options: StreamOptions): Promise<void> {
  const response = await fetch(options.url, {
    headers: { 'x-session-token': options.token, accept: 'text/event-stream' },
    signal: options.signal,
    cache: 'no-store'
  });

  if (!response.ok || !response.body) {
    throw new Error(`stream refused: ${response.status}`);
  }
  options.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line. Anything after the last separator is a partial
    // frame and stays in the buffer — a chunk boundary falls wherever the network puts it,
    // not where the protocol would like it to.
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      emit(frame, options.onFrame);
      separator = buffer.indexOf('\n\n');
    }
  }
}

function emit(frame: string, onFrame: (frame: StreamFrame) => void): void {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    // A line beginning with a colon is a comment — the heartbeat is one — and carries
    // nothing to deliver. Ignoring it here is what keeps the connection alive without the
    // interface ever seeing it.
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;

  try {
    const parsed = JSON.parse(data.join('\n')) as StreamFrame;
    if (parsed && typeof parsed.channel === 'string') onFrame(parsed);
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
