import { useEffect, useRef } from 'react';
import { streamClient } from './stream-client';

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

    const connect = () => {
      if (!active) return;
      source = new EventSource(input.url as string);
      source.onopen = () => callbacks.current.onOpen?.();
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
        callbacks.current.onDisconnect?.();
        timer = setTimeout(() => {
          timer = null;
          const reconnect = callbacks.current.onReconnect;
          if (reconnect) {
            void Promise.resolve(reconnect()).finally(() => connect());
          } else connect();
        }, callbacks.current.reconnectDelayMs ?? 4_000);
      };
    };

    connect();
    return () => {
      active = false;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [input.enabled, multiplexed, input.url]);
}
