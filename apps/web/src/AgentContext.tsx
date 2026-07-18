import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react';
import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  defaultImageEmbeddingSettings,
  type AgentEvent,
  type QueueState
} from '@video-compressor/shared';
import {
  connect,
  consumePairingToken,
  eventUrl,
  onPairingToken,
  pairWithAgent
} from './api/client';
import { failureState, type ConnectionState, versionState } from './connection';

const emptyState: QueueState = {
  jobs: [],
  running: false,
  tools: { ffmpeg: false, ffprobe: false },
  settings: {
    mode: 'optimal',
    outputMode: 'next-to-originals',
    outputFolder: null,
    frameRate: null,
    resolutionLimit: null,
    rateControl: 'crf',
    crf: DEFAULT_CRF,
    videoBitrateKbps: DEFAULT_VIDEO_BITRATE_KBPS,
    imageEmbedding: defaultImageEmbeddingSettings()
  },
  batch: null,
  warning: null
};

interface AgentContextValue {
  connection: ConnectionState;
  state: QueueState;
  setState: Dispatch<SetStateAction<QueueState>>;
  connectedOnce: boolean;
  reconnect: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [state, setState] = useState<QueueState>(emptyState);
  const [connectedOnce, setConnectedOnce] = useState(false);
  const connectedOnceRef = useRef(false);
  const events = useRef<EventSource | null>(null);
  const connecting = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const establish = useCallback(async (mode: 'checking' | 'connecting' = 'connecting') => {
    if (connecting.current) return;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    connecting.current = true;
    setConnection(mode);
    events.current?.close();
    events.current = null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2200);
    try {
      const result = await connect(controller.signal);
      window.clearTimeout(timer);
      if (!mounted.current) return;
      const next = versionState(result.apiVersion);
      setConnection(next);
      if (next !== 'connected') return;
      if (!result.state) throw new Error('AGENT_STATE_MISSING');
      setState(result.state);
      setConnectedOnce(true);
      connectedOnceRef.current = true;
      const source = new EventSource(eventUrl());
      events.current = source;
      source.onmessage = event => {
        const update = JSON.parse(event.data) as AgentEvent;
        setState(update.state);
        setConnection('connected');
      };
      source.onerror = () => {
        source.close();
        events.current = null;
        setConnection('disconnected');
        retryTimer.current = setTimeout(() => void establish('connecting'), 4000);
      };
    } catch (error) {
      window.clearTimeout(timer);
      if (!mounted.current) return;
      if (error instanceof Error && error.message === 'PAIRING_REQUIRED') {
        setConnection(mode === 'checking' ? 'pairing_required' : 'connecting');
        if (mode !== 'checking') pairWithAgent();
      } else {
        setConnection(connectedOnceRef.current ? 'disconnected' : await failureState());
        retryTimer.current = setTimeout(() => void establish('connecting'), 4000);
      }
    } finally {
      connecting.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    consumePairingToken();
    void establish('checking');
    const removePairingListener = onPairingToken(() => void establish('connecting'));
    return () => {
      mounted.current = false;
      removePairingListener();
      events.current?.close();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [establish]);

  return (
    <AgentContext.Provider
      value={{
        connection,
        state,
        setState,
        connectedOnce,
        reconnect: () => void establish('connecting')
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgent must be used inside AgentProvider');
  return value;
}
