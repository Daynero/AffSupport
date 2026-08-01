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
  type AgentEntitlementStatus,
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
import { ensureAgentEntitlement } from './api/entitlement';
import { useAgentEventStream } from './api/useAgentEventStream';
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
  toolAvailable: (tool: WishlyToolId) => boolean;
  teamWorkspaceAvailable?: boolean;
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
  const [entitlement, setEntitlement] = useState<AgentEntitlementStatus | null>(null);
  const connectedOnceRef = useRef(false);
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
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2200);
      try {
        let result = await connect(controller.signal);
        window.clearTimeout(timer);
        // An enforced agent without a fresh token refuses tool routes: exchange
        // the Supabase session for a signed entitlement token, then reconnect.
        if (
          versionState(result.apiVersion) === 'connected' &&
          result.entitlement?.enforced &&
          !result.entitlement.entitled
        ) {
          await ensureAgentEntitlement();
          const retryController = new AbortController();
          const retryTimer = window.setTimeout(() => retryController.abort(), 2200);
          try {
            result = await connect(retryController.signal);
          } finally {
            window.clearTimeout(retryTimer);
          }
        }
        if (!mounted.current) return;
        setEntitlement(result.entitlement);
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
          toolContracts: result.toolContracts
        });
        setConnection(next);
        if (next !== 'connected') return;
        if (!result.state) throw new Error('AGENT_STATE_MISSING');
        setState(result.state);
        setConnectedOnce(true);
        connectedOnceRef.current = true;
      } catch (error) {
        window.clearTimeout(timer);
        if (!mounted.current) return;
        if (error instanceof Error && error.message === 'PAIRING_REQUIRED') {
          setConnection(mode === 'connecting' ? 'connecting' : 'pairing_required');
          if (mode === 'connecting' || agentInstallAwaitingPairing()) pairWithAgent();
        } else if (error instanceof Error && error.message.startsWith('ENTITLEMENT')) {
          // No automatic retry: the fix is user-side (sign in / go online) and
          // hammering the Edge Function every few seconds helps nobody.
          setConnection('entitlement_blocked');
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

  useAgentEventStream<AgentEvent>({
    url: connectedOnce ? eventUrl() : null,
    enabled: connectedOnce,
    onMessage: update => {
      setState(update.state);
      setConnection('connected');
    },
    onDisconnect: () => setConnection('disconnected'),
    onReconnect: () => establish('retry')
  });

  // The signed token lives 12h and the agent adds a 7-day offline grace, so a
  // long-running session only needs an occasional silent top-up. Failures are
  // ignored: the grace window keeps the agent entitled until the next success.
  useEffect(() => {
    if (connection !== 'connected' || !entitlement?.enforced) return;
    const topUp = () =>
      void ensureAgentEntitlement()
        .then(setEntitlement)
        .catch(() => {});
    if (entitlement.reason === 'grace') topUp();
    const interval = window.setInterval(topUp, 6 * 60 * 60_000);
    return () => window.clearInterval(interval);
  }, [connection, entitlement?.enforced, entitlement?.reason]);

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
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [establish]);

  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const manifest = await loadStableReleaseManifest();
        if (active) setReleaseManifest({ status: 'ready', manifest });
      } catch {
        if (active) {
          setReleaseManifest(current =>
            current.status === 'ready' ? current : { status: 'unavailable', manifest: null }
          );
        }
      } finally {
        loading = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15 * 60_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
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
        toolAvailable: tool => toolContractCompatible(tool, toolContracts),
        teamWorkspaceAvailable:
          connection === 'connected' && toolContractCompatible('teamWorkspace', toolContracts),
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

export function useOptionalAgent() {
  return useContext(AgentContext);
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
