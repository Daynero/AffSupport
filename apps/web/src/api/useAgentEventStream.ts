import { useEffect, useRef } from 'react';
import { streamClient } from './stream-client';

/** FR-034: below this, an interruption is not the user's problem. */
const DEFAULT_GRACE_MS = 3_000;
/** The first retry is fast, because most interruptions end almost at once. */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
/** And the last one is not, because a local app that is down stays down. */
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * Subscribes to live updates from the local app.
 *
 * Two transports, chosen by `channel`. When the agent advertises `event-stream` the caller
 * passes a channel name and this attaches to the one multiplexed connection; otherwise it
 * falls back to that tool's own endpoint over `EventSource`, exactly as before.
 *
 * The fallback is not a temporary scaffold — the seven per-tool endpoints stay in this
 * release, so an interface and an agent can be upgraded independently rather than in step.
 */
export function useAgentEventStream<T>(input: {
  /** The per-tool endpoint. Used when no channel is given, or the agent has no stream. */
  url: string | null;
  /** Name on the multiplexed stream. Ignored unless the agent advertises it. */
  channel?: string;
  /** Whether the agent advertises `event-stream`. */
  multiplexed?: boolean;
  enabled: boolean;
  onMessage: (event: T) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  onReconnect?: () => void | Promise<void>;
  reconnectDelayMs?: number;
  /**
   * How long an interruption must last before the interface hears about it.
   *
   * FR-034. Three seconds by default, which covers a wifi handover and a lid
   * closing without covering an application that has actually gone away.
   */
  graceMs?: number;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;

  const multiplexed = Boolean(input.multiplexed && input.channel);

  useEffect(() => {
    if (!input.enabled || !multiplexed || !input.channel) return;
    // One connection for every channel, owned by the client rather than by any component:
    // four tool pages open between them a single socket, and whichever mounts first is not
    // special.
    return streamClient.subscribe(input.channel, event => callbacks.current.onMessage(event as T));
  }, [input.enabled, multiplexed, input.channel]);

  useEffect(() => {
    if (!input.enabled || multiplexed || !input.url || typeof EventSource === 'undefined') return;
    let active = true;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = callbacks.current.reconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS;
    /** Whether the interface has already been told; kept so it is told once. */
    let reportedDisconnect = false;

    const connect = () => {
      if (!active) return;
      source = new EventSource(input.url as string);
      source.onopen = () => {
        // Recovered. Cancel a pending grace so an interruption that ended
        // inside it is never reported, and reset the backoff so the next one
        // starts fast again.
        if (graceTimer !== null) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        backoffMs = callbacks.current.reconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS;
        reportedDisconnect = false;
        callbacks.current.onOpen?.();
      };
      source.onmessage = event => {
        try {
          callbacks.current.onMessage(JSON.parse(event.data) as T);
        } catch {
          // A malformed local event is ignored; the next snapshot remains authoritative.
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        // The grace period. A stream drops for reasons that resolve in under a
        // second — a laptop lid, a wifi handover, the agent finishing a write —
        // and telling the interface about every one of those is how a blip
        // came to look like an uninstalled application. Nothing is reported
        // until the interruption has outlived the grace; a reconnect inside it
        // is invisible, which is what it deserves to be.
        // Told once per interruption, not once per retry: a local app that is
        // down produces an error on every attempt, and an interface that
        // re-announced each one would flicker for as long as the tab is open.
        if (graceTimer === null && !reportedDisconnect) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            if (!active) return;
            reportedDisconnect = true;
            callbacks.current.onDisconnect?.();
          }, callbacks.current.graceMs ?? DEFAULT_GRACE_MS);
        }
        // Progressive backoff, so a local app that is genuinely down is not
        // reconnected to five times a second for as long as the tab is open —
        // and so the first retry is still fast, because most interruptions end
        // almost immediately.
        const delay = Math.min(MAX_RECONNECT_DELAY_MS, backoffMs);
        backoffMs = Math.min(MAX_RECONNECT_DELAY_MS, backoffMs * 2);
        timer = setTimeout(() => {
          timer = null;
          const reconnect = callbacks.current.onReconnect;
          if (reconnect) {
            void Promise.resolve(reconnect()).finally(() => connect());
          } else connect();
        }, delay);
      };
    };

    connect();
    return () => {
      active = false;
      source?.close();
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // Nothing is reported on unmount: a page being torn down is not a
      // disconnection anyone needs to see.
      reportedDisconnect = false;
    };
  }, [input.enabled, multiplexed, input.url]);
}
