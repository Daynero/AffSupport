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
  toolContractCompatible,
  type AgentEvent,
  type QueueState,
  type ToolContracts,
  type WishlyToolId
} from '@video-compressor/shared';
import {
  agentInstallAwaitingPairing,
  connect,
  consumePairingToken,
  eventUrl,
  onPairingToken,
  pairWithAgent
} from './api/client';
import { failureState, type ConnectionState, versionState } from './connection';
import { analytics } from './analytics/service';
import { loadStableReleaseManifest, type ReleaseManifestState } from './release-manifest';

const emptyState: QueueState = {
  jobs: [],
  running: false,
  tools: { ffmpeg: false, ffprobe: false },
  settings: {
    mode: 'optimal',
    outputMode: 'next-to-originals',
    outputFolder: null,
    stripMetadata: true,
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

export interface AgentContextValue {
  connection: ConnectionState;
  state: QueueState;
  setState: Dispatch<SetStateAction<QueueState>>;
  connectedOnce: boolean;
  agentVersion: string | null;
  agentBuildId: string | null;
  agentChannel: string | null;
  agentApiVersion: number | null;
  capabilities: string[];
  toolContracts: ToolContracts;
  releaseManifest: ReleaseManifestState;
  platform: 'macos' | 'windows' | 'linux' | 'other';
  toolAvailable: (tool: WishlyToolId) => boolean;
  reconnect: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [state, setState] = useState<QueueState>(emptyState);
  const [connectedOnce, setConnectedOnce] = useState(false);
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [agentBuildId, setAgentBuildId] = useState<string | null>(null);
  const [agentChannel, setAgentChannel] = useState<string | null>(null);
  const [agentApiVersion, setAgentApiVersion] = useState<number | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [toolContracts, setToolContracts] = useState<ToolContracts>({});
  const [releaseManifest, setReleaseManifest] = useState<ReleaseManifestState>({
    status: 'checking',
    manifest: null
  });
  const platform = broadPlatform();
  const connectedOnceRef = useRef(false);
  const events = useRef<EventSource | null>(null);
  const connecting = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const establish = useCallback(
    async (mode: 'checking' | 'connecting' | 'retry' = 'connecting') => {
      if (connecting.current) return;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      connecting.current = true;
      // A background retry keeps the current panel and only pulses a small inline
      // indicator. Flipping to the full "connecting" state on every 4s attempt made
      // the home page blink between the spinner and the onboarding panel.
      if (mode !== 'retry') setConnection(mode);
      events.current?.close();
      events.current = null;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2200);
      try {
        const result = await connect(controller.signal);
        window.clearTimeout(timer);
        if (!mounted.current) return;
        const next = versionState(result.apiVersion);
        setAgentVersion(result.version || null);
        setAgentBuildId(result.buildId || null);
        setAgentChannel(result.channel || null);
        setAgentApiVersion(result.apiVersion);
        setCapabilities(result.capabilities);
        setToolContracts(result.toolContracts);
        analytics.setAgentContext({
          version: result.version || null,
          buildId: result.buildId || null,
          channel: result.channel || null,
          apiVersion: result.apiVersion,
          toolContracts: result.toolContracts,
          platform
        });
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
          retryTimer.current = setTimeout(() => void establish('retry'), 4000);
        };
      } catch (error) {
        window.clearTimeout(timer);
        if (!mounted.current) return;
        if (error instanceof Error && error.message === 'PAIRING_REQUIRED') {
          setConnection(mode === 'connecting' ? 'connecting' : 'pairing_required');
          if (mode === 'connecting' || agentInstallAwaitingPairing()) pairWithAgent();
        } else {
          setConnection(connectedOnceRef.current ? 'disconnected' : await failureState());
          retryTimer.current = setTimeout(() => void establish('retry'), 4000);
        }
      } finally {
        connecting.current = false;
      }
    },
    []
  );

  const previousConnection = useRef<ConnectionState>('checking');
  useEffect(() => {
    const previous = previousConnection.current;
    if (connection === 'connected' && previous !== 'connected')
      analytics.track('agent_connected', {});
    if (connection === 'disconnected' && previous === 'connected')
      analytics.track('agent_disconnected', { error_category: 'agent_disconnected' });
    if (connection === 'agent_update_required' && previous !== 'agent_update_required')
      analytics.track('agent_update_required', {});
    previousConnection.current = connection;
  }, [connection]);

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

  useEffect(() => {
    let active = true;
    void loadStableReleaseManifest()
      .then(manifest => {
        if (active) setReleaseManifest({ status: 'ready', manifest });
      })
      .catch(() => {
        if (active) setReleaseManifest({ status: 'unavailable', manifest: null });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <AgentContext.Provider
      value={{
        connection,
        state,
        setState,
        connectedOnce,
        agentVersion,
        agentBuildId,
        agentChannel,
        agentApiVersion,
        capabilities,
        toolContracts,
        releaseManifest,
        platform,
        toolAvailable: tool => toolContractCompatible(tool, toolContracts),
        reconnect: () => void establish('connecting')
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function broadPlatform(): 'macos' | 'windows' | 'linux' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes('mac')) return 'macos';
  if (value.includes('win')) return 'windows';
  if (value.includes('linux')) return 'linux';
  return 'other';
}

export function useAgent() {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgent must be used inside AgentProvider');
  return value;
}

export function AgentContextOverride({
  value,
  children
}: {
  value: AgentContextValue;
  children: ReactNode;
}) {
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
