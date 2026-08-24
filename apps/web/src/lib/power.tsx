import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  clampPowerLimit,
  powerThrottleSupported,
  DEFAULT_POWER_LIMIT,
  type PowerState
} from '@video-compressor/shared';
import { fetchPowerState, toolEventUrl, setPowerLimit } from '../api/client';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { useOptionalAgent } from '../AgentContext';

/**
 * How much of the machine Soty may use, and what it is using right now.
 *
 * The agent owns the value — it has to honour the limit even when no browser
 * tab is open — so this store reads and writes through the agent rather than
 * keeping its own copy. Cross-window agreement falls out of the agent's
 * broadcast for free; there is no client-side coordination.
 */

export type PowerStatus =
  | 'loading'
  /** Connected and the agent understands the throttle. */
  | 'ready'
  /** No agent reachable; the chosen value is held until one appears. */
  | 'offline'
  /** An agent build that predates the throttle. */
  | 'unsupported'
  | 'error';

export interface PowerContextValue {
  state: PowerState | null;
  status: PowerStatus;
  /** The value the lever should display, including one not yet accepted. */
  limitPercent: number;
  setLimit: (percent: number) => void;
  /** Subscribes to live samples; the returned teardown unsubscribes. */
  watch: () => () => void;
  /** Set when the last attempt to apply a limit failed. */
  error: string | null;
}

const PowerContext = createContext<PowerContextValue | null>(null);

/** How long to coalesce lever movement before asking the agent. */
const COMMIT_DEBOUNCE_MS = 200;

export function PowerProvider({ children }: { children: ReactNode }) {
  const agent = useOptionalAgent();
  // One connection for every tool, when the agent offers one. Consumption is the channel
  // that costs something to sample, so it is also the one whose subscription the agent
  // refcounts — asking for it here is what starts and stops the measurement.
  const multiplexed = Boolean(agent?.capabilities?.includes('event-stream'));
  const [state, setState] = useState<PowerState | null>(null);
  const [status, setStatus] = useState<PowerStatus>('loading');
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watchers, setWatchers] = useState(0);

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desired = useRef<number | null>(null);
  /** Held while no agent is reachable, so the user's choice is not discarded. */
  const deferred = useRef<number | null>(null);

  const connected = agent?.connection === 'connected';
  const supported = agent ? powerThrottleSupported(agent.toolContracts) : true;

  const commit = useCallback(async (percent: number) => {
    try {
      const next = await setPowerLimit(percent);
      setState(next);
      setStatus('ready');
      setError(null);
      // The response is authoritative: a clamped value corrects the lever here
      // rather than leaving it pointing at a limit that is not in force.
      setPending(current => (current === percent ? null : current));
    } catch (cause) {
      setPending(null);
      setError(cause instanceof Error ? cause.message : 'POWER_LIMIT_FAILED');
    }
  }, []);

  const setLimit = useCallback(
    (percent: number) => {
      const clamped = clampPowerLimit(percent);
      // Show the movement immediately: a lever that waits for the network does
      // not feel like a physical control.
      setPending(clamped);
      setError(null);
      desired.current = clamped;

      if (!connected || !supported) {
        // Keep it rather than dropping it — the user made a choice and expects
        // it to hold once the agent comes back.
        deferred.current = clamped;
        return;
      }
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => {
        commitTimer.current = null;
        const target = desired.current;
        if (target !== null) void commit(target);
      }, COMMIT_DEBOUNCE_MS);
    },
    [commit, connected, supported]
  );

  // Initial snapshot, plus the deferred value once a connection appears.
  useEffect(() => {
    if (!connected) {
      setStatus('offline');
      return;
    }
    if (!supported) {
      setStatus('unsupported');
      return;
    }
    let active = true;
    fetchPowerState()
      .then(next => {
        if (!active) return;
        setState(next);
        setStatus('ready');
        const held = deferred.current;
        deferred.current = null;
        if (held !== null && held !== next.limitPercent) void commit(held);
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [commit, connected, supported]);

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    []
  );

  const watch = useCallback(() => {
    setWatchers(count => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setWatchers(count => Math.max(0, count - 1));
    };
  }, []);

  // Live samples arrive only while the panel is open. The agent stops measuring
  // when the last subscriber goes away, so a closed panel costs nothing on
  // either side of the wire.
  useAgentEventStream<PowerState>({
    url: watchers > 0 && connected && supported ? toolEventUrl('power') : null,
    channel: 'power',
    multiplexed,
    enabled: watchers > 0 && connected && supported,
    onMessage: next => {
      setState(next);
      setStatus('ready');
      setPending(current => (current === next.limitPercent ? null : current));
    }
  });

  const value = useMemo<PowerContextValue>(
    () => ({
      state,
      status,
      limitPercent: pending ?? state?.limitPercent ?? deferred.current ?? DEFAULT_POWER_LIMIT,
      setLimit,
      watch,
      error
    }),
    [error, pending, setLimit, state, status, watch]
  );

  return <PowerContext.Provider value={value}>{children}</PowerContext.Provider>;
}

export function usePower() {
  const value = useContext(PowerContext);
  if (!value) throw new Error('usePower must be used inside PowerProvider');
  return value;
}

export function PowerContextOverride({
  value,
  children
}: {
  value: PowerContextValue;
  children: ReactNode;
}) {
  return <PowerContext.Provider value={value}>{children}</PowerContext.Provider>;
}
