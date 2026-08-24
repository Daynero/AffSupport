import type { FastifyReply, FastifyRequest } from 'fastify';
import { eventStreamHeaders } from '../http.js';

/**
 * One server-sent-events fan-out. Every tool (compressor, landing,
 * transcription) keeps its own channel: `broadcast` pushes an event to all
 * connected clients and `handler` serves the SSE endpoint, replaying the
 * current snapshot to a client the moment it connects.
 *
 * A channel may also be registered with a {@link ChannelHub}, which is how the
 * same events reach the one multiplexed stream without every tool having to
 * know that the stream exists.
 */
export class EventChannel<TEvent> {
  private readonly clients = new Set<NodeJS.WritableStream>();
  private hub: ChannelHub | null = null;
  private hubName = '';

  constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly snapshot: () => TEvent
  ) {}

  /**
   * Publishes this channel on `hub` under `name`, as well as on its own endpoint.
   *
   * Both, not either. The seven per-tool endpoints stay in this release so a client that
   * has not been updated keeps working, and a tool would otherwise have to know which
   * transport its reader happens to be using.
   */
  publishOn(hub: ChannelHub, name: string, onActive?: ChannelSource['onActive']): this {
    this.hub = hub;
    this.hubName = name;
    hub.register({ name, snapshot: () => this.snapshot(), onActive });
    return this;
  }

  broadcast(event: TEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      // A socket that died between the 'close' event and this write must not
      // throw back into the caller: `broadcast` runs inside the queue's drain
      // loop, where a rejection would strand the remaining jobs.
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
    this.hub?.publish(this.hubName, event);
  }

  /** Fastify route handler; bound so it can be passed to `app.get` directly. */
  handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, this.allowedOrigins));
    this.clients.add(reply.raw);
    reply.raw.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    request.raw.on('close', () => this.clients.delete(reply.raw));
  };
}

/** What the hub needs from a channel to serve it. */
export interface ChannelSource {
  readonly name: string;
  /** The current state, replayed to each subscriber the moment it connects. */
  snapshot(): unknown;
  /**
   * Called when the channel gains its first subscriber and loses its last.
   *
   * For channels that cost something to produce. Consumption sampling runs a timer and reads
   * the process table; leaving it running because a panel was open once is work the machine
   * does for nobody.
   */
  onActive?(active: boolean): void;
}

/** One frame on the multiplexed stream. Only the envelope is new. */
interface Frame {
  channel: string;
  event: unknown;
}

/**
 * How long a subscriber may go without any traffic before a heartbeat is sent.
 *
 * Fifteen seconds is well inside the shortest idle timeout a proxy or a laptop's power
 * management is likely to impose, and far longer than any real update interval.
 */
const HEARTBEAT_MS = 15_000;

/**
 * How much unwritten data a subscriber may accumulate before it is dropped.
 *
 * A reader that has stopped draining — a suspended tab, a laptop that closed mid-run — does
 * not stop the writes arriving. Today they accumulate in the socket's buffer inside the
 * queue's drain loop, which is a memory leak that grows for as long as the run lasts. One
 * megabyte is far more than any legitimate backlog and far less than a problem.
 */
const STALLED_BYTES = 1_000_000;

/** Subscribers per channel, and per process. */
const MAX_PER_CHANNEL = 8;
const MAX_PER_PROCESS = 32;

interface Subscriber {
  socket: NodeJS.WritableStream & { writableLength?: number; destroy?: () => void };
  channels: Set<string>;
  /** Ordering for eviction: the oldest connection goes first. */
  joinedAt: number;
}

/**
 * The named-channel fan-out behind `GET /api/stream`.
 *
 * The interface used to hold seven server-sent-event connections at once — one per tool —
 * which is seven sockets, seven reconnect timers and seven independent opinions about
 * whether the local app is reachable. One connection carrying named frames replaces them.
 *
 * The per-tool endpoints are not removed in this release: a client that has not been
 * updated keeps working, and the capability flag is what lets a newer one know it may use
 * the stream instead.
 */
export class ChannelHub {
  private readonly sources = new Map<string, ChannelSource>();
  private readonly subscribers = new Set<Subscriber>();
  private heartbeat: NodeJS.Timeout | null = null;
  private nextJoin = 0;

  register(source: ChannelSource): void {
    this.sources.set(source.name, source);
  }

  /** Every channel a client may ask for. */
  channels(): string[] {
    return [...this.sources.keys()];
  }

  /** Current snapshot of one channel, or null when nothing publishes under that name. */
  snapshot(name: string): unknown {
    return this.sources.get(name)?.snapshot() ?? null;
  }

  publish(name: string, event: unknown): void {
    if (!name) return;
    const frame = `data: ${JSON.stringify({ channel: name, event } satisfies Frame)}\n\n`;
    for (const subscriber of [...this.subscribers]) {
      if (!subscriber.channels.has(name)) continue;
      this.write(subscriber, frame);
    }
  }

  /**
   * Attaches one socket to the named channels and replays their snapshots.
   *
   * Returns the function that detaches it. Callers must invoke it on close — a subscriber
   * left in the set is a write that throws on every subsequent event.
   */
  subscribe(socket: Subscriber['socket'], names: readonly string[]): () => void {
    const channels = new Set(names.filter(name => this.sources.has(name)));
    const subscriber: Subscriber = { socket, channels, joinedAt: this.nextJoin++ };

    this.evictForCapacity(channels);
    // Read *before* joining, or the new subscriber counts itself and a channel is never seen
    // to go from nobody-listening to somebody-listening — which is the only moment a
    // sampler has to start.
    const newlyActive = [...channels].filter(name => this.listenerCount(name) === 0);

    this.subscribers.add(subscriber);
    this.startHeartbeat();
    for (const name of newlyActive) this.sources.get(name)?.onActive?.(true);
    for (const name of channels) {
      const frame: Frame = { channel: name, event: this.snapshot(name) };
      this.write(subscriber, `data: ${JSON.stringify(frame)}\n\n`);
    }

    return () => this.detach(subscriber);
  }

  /** Closes every subscriber. For shutdown, so nothing holds the process open. */
  closeAll(): void {
    for (const subscriber of [...this.subscribers]) this.detach(subscriber);
    this.stopHeartbeat();
  }

  private detach(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    for (const name of subscriber.channels) this.deactivateIfUnused(name);
    if (this.subscribers.size === 0) this.stopHeartbeat();
  }

  /**
   * Makes room for a new subscriber by dropping the oldest, not by refusing the newest.
   *
   * Refusing the newest would make the application look broken to the person who just
   * opened a tab, while an abandoned one they forgot about keeps its place. The evicted
   * connection is told why, so its reader reconnects rather than sitting on a dead socket.
   */
  private evictForCapacity(wanted: ReadonlySet<string>): void {
    const byAge = [...this.subscribers].sort((a, b) => a.joinedAt - b.joinedAt);
    while (this.subscribers.size >= MAX_PER_PROCESS && byAge.length > 0) {
      this.replace(byAge.shift() as Subscriber);
    }
    for (const name of wanted) {
      const onChannel = byAge.filter(subscriber => subscriber.channels.has(name));
      while (onChannel.length >= MAX_PER_CHANNEL) {
        const oldest = onChannel.shift() as Subscriber;
        this.replace(oldest);
        const index = byAge.indexOf(oldest);
        if (index >= 0) byAge.splice(index, 1);
      }
    }
  }

  private replace(subscriber: Subscriber): void {
    try {
      subscriber.socket.write(`event: replaced\ndata: {}\n\n`);
    } catch {
      // The socket is going either way; a failed goodbye is not worth reporting.
    }
    this.detach(subscriber);
    subscriber.socket.destroy?.();
  }

  private write(subscriber: Subscriber, payload: string): void {
    try {
      subscriber.socket.write(payload);
    } catch {
      this.detach(subscriber);
      return;
    }
    // A reader that has stopped draining does not stop the writes arriving. Dropping it is
    // the only way the buffer stops growing, and it reconnects on its own.
    if ((subscriber.socket.writableLength ?? 0) > STALLED_BYTES) {
      this.detach(subscriber);
      subscriber.socket.destroy?.();
    }
  }

  private listenerCount(name: string): number {
    let count = 0;
    for (const subscriber of this.subscribers) if (subscriber.channels.has(name)) count += 1;
    return count;
  }

  private deactivateIfUnused(name: string): void {
    if (this.listenerCount(name) === 0) this.sources.get(name)?.onActive?.(false);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const subscriber of [...this.subscribers]) this.write(subscriber, `: heartbeat\n\n`);
    }, HEARTBEAT_MS);
    // Never hold the process open for a keep-alive.
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
