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

/**
 * How long a tab may stay hidden before it gives its socket back.
 *
 * The browser allows six connections to the local app across every Soty tab, and a live
 * stream holds one for as long as the tab exists. Six forgotten tabs from last week were
 * enough to leave the seventh — the one actually being looked at — spinning forever, its
 * first request queued behind sockets nobody was reading. A hidden tab needs no live
 * updates: it reconnects the moment it is looked at again, and the first frame is a full
 * snapshot, so nothing that happened meanwhile is lost. A minute keeps a quick
 * cmd-tab away from costing a reconnect.
 */
const HIDDEN_RELEASE_MS = 60_000;

class StreamClient {
  private config: Config | null = null;
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the socket has been given back because the tab is hidden. */
  private parked = false;
  private failures = 0;
  private openListeners = new Set<(open: boolean) => void>();

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (this.hiddenTimer) return;
        this.hiddenTimer = setTimeout(() => {
          this.hiddenTimer = null;
          this.park();
        }, HIDDEN_RELEASE_MS);
        return;
      }
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
      if (this.parked) {
        this.parked = false;
        this.restart();
      }
    });
  }

  /**
   * Gives the socket back without telling anyone the connection dropped: nothing is wrong
   * with the local app, and a tab nobody is looking at has no banner worth showing.
   */
  private park(): void {
    this.parked = true;
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
  }

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
      // While parked (the tab hidden for a while) this asks for nothing yet: the channel is
      // remembered and joins the connection the moment the tab is looked at again.
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
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    this.parked = false;
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
    if (!config || channels.length === 0 || this.parked) return;

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
