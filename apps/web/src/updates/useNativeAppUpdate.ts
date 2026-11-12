import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isNativeUpdateSnapshot,
  updateRecord,
  type NativeUpdateAction,
  type NativeUpdateCommand,
  type NativeUpdateSnapshot
} from '@video-compressor/shared';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { commandNativeAppUpdate, readNativeAppUpdate } from '../api/native-app-updates';
/** One snapshot + existing SSE owner. No browser timer or independent update authority. */
export function useNativeAppUpdate(enabled: boolean, connected: boolean, buildId: string | null) {
  const [state, setState] = useState<NativeUpdateSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const current = useRef<NativeUpdateSnapshot | null>(null);
  const generation = useRef(0);
  const read = useRef<Promise<void> | null>(null);
  const trailing = useRef(false);
  const controller = useRef(new AbortController());
  const acked = useRef(new Set<string>());
  const busy = useRef(false);
  const command = useRef<{ action: NativeUpdateAction; body: NativeUpdateCommand } | null>(null);
  const accept = useCallback((next: NativeUpdateSnapshot) => {
    if (
      current.current?.installationId === next.installationId &&
      current.current.revision > next.revision
    )
      return;
    current.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(() => {
    if (!enabled || !connected) return Promise.resolve();
    if (read.current) {
      trailing.current = true;
      return read.current;
    }
    const epoch = generation.current;
    const signal = controller.current.signal;
    const run = async () => {
      // At most one coalesced follow-up, even when open/visibility overlap.
      for (let index = 0; index < 2; index++) {
        trailing.current = false;
        try {
          const next = await readNativeAppUpdate(signal);
          if (epoch === generation.current) {
            accept(next);
            setError(false);
          }
        } catch {
          if (!signal.aborted && epoch === generation.current) setError(true);
        }
        if (!trailing.current || signal.aborted) break;
      }
    };
    const promise = run().finally(() => {
      if (read.current === promise) read.current = null;
    });
    read.current = promise;
    return promise;
  }, [accept, connected, enabled]);
  const act = useCallback(
    async (action: NativeUpdateAction, automaticDownload?: boolean) => {
      if (!connected || !enabled || !current.current || busy.current) return;
      busy.current = true;
      const epoch = generation.current;
      // If a reply was lost, an explicit retry reuses its key. Native readback
      // decides whether it already happened; the browser never replays on reconnect.
      const previous = command.current;
      const body: NativeUpdateCommand =
        previous?.action === action
          ? previous.body
          : {
              schemaVersion: 1,
              idempotencyKey: crypto.randomUUID(),
              expectedRevision: current.current.revision,
              candidateId: current.current.candidateId,
              ...(automaticDownload === undefined ? {} : { automaticDownload })
            };
      command.current = { action, body };
      setPending(true);
      setError(false);
      try {
        const next = await commandNativeAppUpdate(action, body, controller.current.signal);
        if (epoch === generation.current) {
          accept(next);
          command.current = null;
        }
      } catch (cause) {
        if (epoch === generation.current) {
          if (
            cause instanceof Error &&
            /APP_UPDATE_(?:STALE_REVISION|CANDIDATE_CHANGED)/.test(cause.message)
          )
            command.current = null;
          setError(true);
          await refresh();
        }
      } finally {
        if (epoch === generation.current) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [accept, connected, enabled, refresh]
  );
  useEffect(() => {
    generation.current++;
    controller.current.abort();
    controller.current = new AbortController();
    read.current = null;
    command.current = null;
    busy.current = false;
    setPending(false);
    if (enabled && connected) void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      generation.current++;
      controller.current.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [buildId, connected, enabled, refresh]);
  useAgentEventStream<unknown>({
    enabled: enabled && connected,
    channel: 'app-update',
    multiplexed: true,
    url: null,
    onOpen: () => {
      void refresh();
    },
    onReconnect: () => refresh(),
    onMessage: value => {
      if (
        updateRecord(value) &&
        value.type === 'app-update:state' &&
        isNativeUpdateSnapshot(value.state)
      ) {
        accept(value.state);
        if (read.current) trailing.current = true;
      }
    }
  });
  useEffect(() => {
    const key = `${generation.current}:${state?.attemptId}`;
    if (
      connected &&
      state?.nativeSuccess &&
      !state.uiSuccess &&
      state.candidate?.buildId === buildId &&
      document.visibilityState === 'visible' &&
      !acked.current.has(key)
    ) {
      acked.current.add(key);
      void act('ack-visible');
    }
  }, [act, buildId, connected, state]);
  return { state, error, pending, act, refresh };
}
