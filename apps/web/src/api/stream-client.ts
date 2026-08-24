import { readEventStream, streamUrl, type StreamFrame } from './event-stream';

/**
 * The one connection, shared by everything that wants live updates.
 *
 * A hook cannot own this. The point of multiplexing is that four tool pages open between
 * them a single socket, so the connection has to outlive any one component and be told which
 * channels are wanted rather than asked. That is what this holds.
 *
 * Reconnection lives here too, for the same reason the seven-connection design was a
 * problem: seven readers each deciding independently whether the local app was reachable is
 * how one page could say "connected" while another offered to install the application.
 */

export type ChannelListener = (event: unknown) => void;

interface Config {
  agentUrl: string;
  token: string;
}

/**
 * How long to wait before reconnecting, growing with each consecutive failure.
 *
 * The first retry is fast because the overwhelmingly common cause is the local app
 * restarting, which takes about a second. The ceiling exists so a machine that is asleep, or
 * an app the user quit deliberately, is not hammered for as long as the tab stays open.
 */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];

class StreamClient {
  private config: Config | null = null;
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private openListeners = new Set<(open: boolean) => void>();

  /**
   * Points the client at a local app, or at nothing.
   *
   * Passing `null` closes the connection: that is what happens when the session ends, and
   * leaving a socket open against an app the user is no longer paired with would keep
   * reporting a connection that is not theirs.
   */
  configure(config: Config | null): void {
    const changed =
      config?.agentUrl !== this.config?.agentUrl || config?.token !== this.config?.token;
    this.config = config;
    if (changed) this.restart();
  }

  /** Notified whenever the connection opens or drops. */
  watchConnection(listener: (open: boolean) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  subscribe(channel: string, listener: ChannelListener): () => void {
    const existing = this.listeners.get(channel);
    if (existing) existing.add(listener);
    else {
      this.listeners.set(channel, new Set([listener]));
      // A channel nobody was listening to is a channel the open connection did not ask for.
      this.restart();
    }

    return () => {
      const set = this.listeners.get(channel);
      if (!set) return;
      set.delete(listener);
      if (set.size > 0) return;
      this.listeners.delete(channel);
      this.restart();
    };
  }

  /** Closes the connection and forgets the retry schedule. For tests and teardown. */
  close(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
  }

  private restart(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const config = this.config;
    const channels = [...this.listeners.keys()];
    if (!config || channels.length === 0) return;

    const abort = new AbortController();
    this.abort = abort;
    try {
      await readEventStream({
        url: streamUrl(config.agentUrl, channels),
        token: config.token,
        signal: abort.signal,
        onOpen: () => {
          this.failures = 0;
          for (const listener of this.openListeners) listener(true);
        },
        onFrame: frame => this.deliver(frame)
      });
    } catch {
      // Every failure is the same failure from here: the connection is not usable. Which of
      // the possible causes it was belongs to whatever asks the health endpoint next.
    }

    if (abort.signal.aborted || this.abort !== abort) return;
    this.abort = null;
    for (const listener of this.openListeners) listener(false);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] as number;
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private deliver(frame: StreamFrame): void {
    for (const listener of this.listeners.get(frame.channel) ?? []) {
      try {
        listener(frame.event);
      } catch {
        // One page's handler throwing must not stop the frame reaching the others.
      }
    }
  }
}

/** The process-wide client. One connection, however many pages are open. */
export const streamClient = new StreamClient();
