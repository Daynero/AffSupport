/**
 * The stitcher's live state.
 *
 * A context rather than page-local state for one reason: the queue list, the plan line and
 * the start button all read the same snapshot, and a snapshot that arrives by SSE while a
 * request is in flight must land in exactly one place. Written the way every other store in
 * this app is — a context that throws outside its provider, and an override for tests.
 */

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
import type { StitchSettingsPatch, StitcherState } from '@video-compressor/shared';
import { toolEventUrl } from '../api/client';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { useAgent } from '../AgentContext';
import { fetchStitcherState, updateStitcherSettings } from './api';

export interface StitcherStore {
  state: StitcherState | null;
  connected: boolean;
  refresh: () => Promise<void>;
  applyState: (next: StitcherState) => void;
  updateSettings: (patch: StitchSettingsPatch) => Promise<void>;
}

const StitcherContext = createContext<StitcherStore | null>(null);

/** Lets a test render the page against a snapshot without a local app. */
export const StitcherContextOverride = StitcherContext.Provider;

export function useStitcher(): StitcherStore {
  const value = useContext(StitcherContext);
  if (!value) throw new Error('useStitcher must be used inside StitcherProvider');
  return value;
}

export function StitcherProvider({ children }: { children: ReactNode }) {
  const { connection, capabilities } = useAgent();
  const connected = connection === 'connected';
  const multiplexed = capabilities.includes('event-stream');
  const [state, setState] = useState<StitcherState | null>(null);
  // A request that resolves after a newer event must not overwrite it.
  const generation = useRef(0);

  const applyState = useCallback((next: StitcherState) => {
    generation.current += 1;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    const { state: next } = await fetchStitcherState();
    if (generation.current === mine) applyState(next);
  }, [applyState]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void fetchStitcherState()
      .then(({ state: next }) => {
        if (active) applyState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected, applyState]);

  useAgentEventStream<{ state: StitcherState }>({
    url: connected ? toolEventUrl('stitcher') : null,
    channel: 'stitcher',
    multiplexed,
    enabled: connected,
    onMessage: event => applyState(event.state)
  });

  const updateSettings = useCallback(
    async (patch: StitchSettingsPatch) => {
      const { state: next } = await updateStitcherSettings(patch);
      applyState(next);
    },
    [applyState]
  );

  const value = useMemo<StitcherStore>(
    () => ({ state, connected, refresh, applyState, updateSettings }),
    [state, connected, refresh, applyState, updateSettings]
  );

  return <StitcherContext.Provider value={value}>{children}</StitcherContext.Provider>;
}
