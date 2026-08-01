import { useEffect, useRef } from 'react';

export function useAgentEventStream<T>(input: {
  url: string | null;
  enabled: boolean;
  onMessage: (event: T) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  onReconnect?: () => void | Promise<void>;
  reconnectDelayMs?: number;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;

  useEffect(() => {
    if (!input.enabled || !input.url || typeof EventSource === 'undefined') return;
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
  }, [input.enabled, input.url]);
}
