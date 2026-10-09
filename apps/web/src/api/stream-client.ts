import {
  readEventStream,
  StreamIdleError,
  StreamRefusedError,
  streamUrl,
  type StreamFrame
} from './event-stream';

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
 *
 * What this does *not* decide is what a failure means. It classifies how a connection
 * ended and tells the owner of the connection state (032 FR-001); the owner decides whether
 * to re-pair, refresh the entitlement or just wait.
 */

export type ChannelListener = (event: unknown) => void;

/** Why a connection ended, as far as this layer can tell. */
export type StreamEndReason =
  | 'closed'
  | 'aborted'
  | 'replaced'
  | 'shutdown'
  | 'watchdog'
  | 'unauthorized'
  | 'forbidden'
  | 'throttled'
  | 'network'
  | 'parked';

export interface StreamStatus {
  open: boolean;
  reason?: StreamEndReason;
}

interface Config {
  agentUrl: string;
  /**
   * Read at every (re)connection, never captured.
   *
   * The token changes when the local app is re-paired, and a connection that kept the
   * value it was configured with would retry with a stale token forever — every tool
   * stream dead while plain requests, which read the token each time, worked (032 W2).
   */
  token: () => string;
  /** The agent's heartbeat period; the idle watchdog is derived from it. */
  heartbeatMs?: number;
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
 * Slower, when the agent said another client took this slot.
 *
 * Reconnecting at once would evict the client that evicted us, which evicts us again: two
 * tabs over the limit chasing each other forever (032 A5).
 */
const REPLACED_RETRY_MS = [5_000, 10_000, 30_000];

/** A rate limit is a request to go away for a while, not an invitation to retry faster. */
const THROTTLED_RETRY_MS = [4_000, 8_000, 16_000];

/** The agent's default heartbeat, used until health says otherwise. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Two missed heartbeats plus slack: a quiet connection is a dead one (032 FR-003). */
export function idleBudgetMs(heartbeatMs: number): number {
  return 2 * heartbeatMs + 5_000;
}

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
  /** How the last connection ended, which decides the next retry schedule. */
  private lastEnd: StreamEndReason | null = null;
  /** Set by the agent's own named events, so the end of the body can be classified. */
  private announced: 'replaced' | 'shutdown' | null = null;
  private open = false;
  private openListeners = new Set<(status: StreamStatus) => void>();

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
    this.lastEnd = 'parked';
    if (this.open) {
      this.open = false;
      this.notify({ open: false, reason: 'parked' });
    }
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
      config?.agentUrl !== this.config?.agentUrl ||
      Boolean(config) !== Boolean(this.config) ||
      config?.heartbeatMs !== this.config?.heartbeatMs;
    this.config = config;
    if (changed) this.restart();
  }

  /** Whether a connection is open right now. */
  isOpen(): boolean {
    return this.open;
  }

  /** Notified whenever the connection opens or drops, with why it dropped. */
  watchConnection(listener: (status: StreamStatus) => void): () => void {
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
    this.lastEnd = null;
    this.open = false;
  }

  /**
   * Drops the current connection, if any, and opens a fresh one at once.
   *
   * Public because the owner of the connection state calls it when the pairing token has
   * changed: the next attempt must carry the new token, and waiting out a backoff computed
   * for the old one would be waiting for nothing.
   */
  restart(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.lastEnd = null;
    void this.connect();
  }

  private notify(status: StreamStatus): void {
    for (const listener of [...this.openListeners]) {
      try {
        listener(status);
      } catch {
        // A listener throwing must not stop the others from hearing.
      }
    }
  }

  private async connect(): Promise<void> {
    const config = this.config;
    const channels = [...this.listeners.keys()];
    if (!config || channels.length === 0 || this.parked) return;

    const abort = new AbortController();
    this.abort = abort;
    this.announced = null;
    let reason: StreamEndReason;
    try {
      await readEventStream({
        url: streamUrl(config.agentUrl, channels),
        token: config.token(),
        signal: abort.signal,
        idleMs: idleBudgetMs(config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS),
        onOpen: () => {
          this.failures = 0;
          this.open = true;
          this.notify({ open: true });
        },
        onNamedEvent: name => {
          if (name === 'replaced' || name === 'shutdown') this.announced = name;
        },
        onFrame: frame => this.deliver(frame)
      });
      reason = this.announced ?? 'closed';
    } catch (error) {
      reason = classify(error, this.announced);
    }

    if (abort.signal.aborted || this.abort !== abort) return;
    this.abort = null;
    this.open = false;
    this.lastEnd = reason;
    this.notify({ open: false, reason });
    // Authentication failures are the owner's to resolve: retrying a rejected token every
    // half second is how a stale tab exhausts the agent's auth budget for every other tab.
    if (reason === 'unauthorized' || reason === 'forbidden') return;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const schedule =
      this.lastEnd === 'replaced'
        ? REPLACED_RETRY_MS
        : this.lastEnd === 'throttled'
          ? THROTTLED_RETRY_MS
          : RETRY_MS;
    const delay = schedule[Math.min(this.failures, schedule.length - 1)] as number;
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

function classify(error: unknown, announced: 'replaced' | 'shutdown' | null): StreamEndReason {
  if (announced) return announced;
  if (error instanceof StreamIdleError) return 'watchdog';
  if (error instanceof StreamRefusedError) {
    if (error.status === 401) return 'unauthorized';
    if (error.status === 403) return 'forbidden';
    if (error.status === 429) return 'throttled';
    return 'network';
  }
  return 'network';
}

/** The process-wide client. One connection, however many pages are open. */
export const streamClient = new StreamClient();
