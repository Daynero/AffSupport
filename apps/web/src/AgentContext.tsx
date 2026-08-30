import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useMemo
} from 'react';
import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  defaultImageEmbeddingSettings,
  isNewerSnapshot,
  toolContractCompatible,
  type AgentEntitlementStatus,
  type AgentEvent,
  type QueueState,
  type ToolContracts,
  type SotyToolId
} from '@video-compressor/shared';
import {
  agentInstallAwaitingPairing,
  agentProvenAlive,
  agentUrl,
  markAgentSeen,
  claimAutomaticPairing,
  connect,
  toolEventUrl,
  onPairingToken,
  pairWithAgent,
  releaseAutomaticPairing
} from './api/client';
import { ensureAgentEntitlement } from './api/entitlement';
import {
  handshakeForToken,
  pairingToken,
  storePairingToken,
  verifyPairingToken
} from './api/pairing-token';
import { streamClient } from './api/stream-client';
import { useAgentEventStream } from './api/useAgentEventStream';
import { failureState, type ConnectionState, versionState } from './connection';
import { analytics } from './analytics/service';
import { loadStableReleaseManifest, type ReleaseManifestState } from './release-manifest';
import { reconcileQueue } from './api/reconcile-queue';

const emptyState: QueueState = {
  jobs: [],
  running: false,
  tools: { ffmpeg: false, ffprobe: false },
  settings: {
    mode: 'optimal',
    outputMode: 'next-to-originals',
    outputFolder: null,
  outputSuffix: null,
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
  toolAvailable: (tool: SotyToolId) => boolean;
  teamWorkspaceAvailable?: boolean;
  reconnect: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

/**
 * The queue snapshot, kept in a context of its own.
 *
 * Everything else here — the connection state, the agent's version, its
 * capabilities — changes a handful of times in a session. The snapshot changes
 * several times a second while an encode runs, and it used to share one context
 * object with the rest, so a progress tick re-rendered every component that had
 * only ever asked whether the agent was connected.
 *
 * `useAgent` still returns both, because most callers genuinely want both and
 * rewriting every one of them would be a larger change than the problem
 * justifies. What this buys is that a component *can* subscribe to just the
 * status, and the ones that sit above the whole page now do.
 */
const AgentStatusContext = createContext<Omit<AgentContextValue, 'state' | 'setState'> | null>(
  null
);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [state, setState] = useState<QueueState>(emptyState);
  /**
   * The last revision shown, so a snapshot that lost a race cannot win.
   *
   * A request in flight when an event fires resolves *after* it and overwrites
   * a newer snapshot with an older one — the interface then shows a job as
   * running that has already finished, and nothing corrects it until the next
   * event. Held in a ref rather than derived from `state` so the comparison
   * does not depend on when React re-renders.
   */
  const shownRevision = useRef(0);
  /** Which local-app run the shown revision belongs to. */
  const knownInstance = useRef<string | null>(null);
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
        // The Agent answered, whatever it answered. Remembered here rather than
        // only on a full connection, because a version mismatch or a failed
        // entitlement check still proves Soty is installed — and those are the
        // states whose screens have to choose between "open" and "download".
        markAgentSeen();
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
        // The documented bypass. A restarted local app resets its counter to
        // zero, so the first snapshot of a new run looks stale by number and is
        // not: keyed on identity — the build the agent reports — rather than on
        // the number, because treating a lower revision as stale here would
        // freeze the interface on the previous run's last state forever.
        applyState(result.state, { freshConnect: true, instance: result.instanceId || result.buildId || null });
        setConnectedOnce(true);
        connectedOnceRef.current = true;
        releaseAutomaticPairing();
      } catch (error) {
        window.clearTimeout(timer);
        if (!mounted.current) return;
        if (error instanceof Error && error.message === 'PAIRING_REQUIRED') {
          // Re-pair without asking whenever the Agent has proved it is running:
          // it answered 401 with a token this browser no longer shares, or it
          // served this very page. Making the user hunt for a "find the agent"
          // button after every Agent restart was the single most common way to
          // get stuck, and the budget keeps a rejected token from spinning.
          if (agentProvenAlive(error)) markAgentSeen();
          const canPairSilently =
            mode === 'connecting' || agentProvenAlive(error) || agentInstallAwaitingPairing();
          if (canPairSilently && claimAutomaticPairing()) {
            setConnection('connecting');
            // In-page first (FR-038). The navigation below works and takes the
            // whole page with it — an editable transcript, a half-filled form,
            // an open dialog — to deliver a string. The handshake asks for the
            // same string without moving anyone, and falls back to the old path
            // on timeout, so this is never worse than it was.
            void handshakeForToken(agentUrl).then(handshakeToken => {
              if (!mounted.current) return;
              if (handshakeToken) {
                storePairingToken(handshakeToken);
                void establish('retry');
                return;
              }
              pairWithAgent();
            });
          } else {
            // Not a dead end: the Agent may still be starting, so keep looking.
            setConnection('pairing_required');
            retryTimer.current = setTimeout(() => void establish('retry'), 4000);
          }
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

  /**
   * The one place a queue snapshot is written.
   *
   * Every other writer goes through here, so "newer wins" is a property of the
   * context rather than a rule each caller has to remember. An equal revision
   * is allowed through: a re-fetch of the same state is harmless, and refusing
   * it would make a manual refresh appear to do nothing.
   */
  const applyState = useCallback(
    (
      next: SetStateAction<QueueState>,
      options: { freshConnect?: boolean; instance?: string | null } = {}
    ) => {
      // An updater function is a local edit — the caller is deriving the next
      // state from the one already shown, so there is no race to arbitrate and
      // nothing to compare against.
      if (typeof next === 'function') {
        setState(next);
        return;
      }
      const instanceChanged =
        options.instance !== undefined && options.instance !== knownInstance.current;
      if (options.freshConnect && instanceChanged) {
        knownInstance.current = options.instance ?? null;
        shownRevision.current = next.revision ?? 0;
        setState(current => reconcileQueue(current, next));
        return;
      }
      if (!isNewerSnapshot(next, { revision: shownRevision.current })) return;
      shownRevision.current = next.revision ?? 0;
      // Reconciled in the writer, so every consumer benefits and no component
      // has to know that a snapshot arrives as fresh objects each time.
      setState(current => reconcileQueue(current, next));
    },
    []
  );

  // One connection for every tool, when the agent offers one. The seven per-tool endpoints
  // remain the fallback, so an agent and an interface can be upgraded independently.
  const multiplexed = capabilities.includes('event-stream');

  useEffect(() => {
    if (!connectedOnce || !multiplexed) {
      streamClient.configure(null);
      return;
    }
    streamClient.configure({ agentUrl, token: pairingToken() });
    return () => streamClient.configure(null);
  }, [connectedOnce, multiplexed]);

  useAgentEventStream<AgentEvent>({
    url: connectedOnce ? toolEventUrl('compressor') : null,
    channel: 'compressor',
    multiplexed,
    enabled: connectedOnce,
    onMessage: update => {
      applyState(update.state);
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
    // A token from the fragment was taken out of the URL at start-up but not
    // believed. Prove it against the local app first: adopting an unverified
    // one replaces the working token in every open tab, and the session then
    // stops working for reasons nothing on screen explains.
    void verifyPairingToken(agentUrl).finally(() => {
      if (mounted.current) void establish('checking');
    });
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
    let lastFetchedAt = 0;
    /**
     * The floor between manifest fetches.
     *
     * The interval alone was fine; the two event listeners were not. Focus and
     * visibility both fire when a user alt-tabs back, so a person moving
     * between windows re-fetched the release manifest on every switch — several
     * times a minute for anyone working across two applications, for a file
     * that changes at most on a release day.
     */
    const MIN_INTERVAL_MS = 60_000;
    const refresh = async (options: { force?: boolean } = {}) => {
      if (loading) return;
      if (!options.force && Date.now() - lastFetchedAt < MIN_INTERVAL_MS) return;
      lastFetchedAt = Date.now();
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
    // The first load is forced: the floor exists to damp repeated triggers,
    // not to delay the initial fetch.
    void refresh({ force: true });
    const interval = window.setInterval(() => void refresh({ force: true }), 15 * 60_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  /**
   * The half of the context that rarely changes.
   *
   * Memoised so a queue snapshot arriving four times a second does not hand
   * every status consumer a new object to compare against.
   */
  const status = useMemo(
    () => ({
      connection,
      connectedOnce,
      agentVersion,
      agentBuildId,
      agentChannel,
      agentApiVersion,
      capabilities,
      toolContracts,
      releaseManifest,
      toolAvailable: (tool: SotyToolId) => toolContractCompatible(tool, toolContracts),
      teamWorkspaceAvailable:
        connection === 'connected' && toolContractCompatible('teamWorkspace', toolContracts),
      reconnect: () => {
        // An explicit ask is never held back by the automatic budget: that
        // budget exists to stop the page navigating in a loop on its own, not
        // to stop the user from trying again.
        releaseAutomaticPairing();
        void establish('connecting');
      }
    }),
    [
      connection,
      connectedOnce,
      agentVersion,
      agentBuildId,
      agentChannel,
      agentApiVersion,
      capabilities,
      toolContracts,
      releaseManifest,
      entitlement
    ]
  );

  return (
    <AgentStatusContext.Provider value={status}>
      <AgentContext.Provider value={{ ...status, state, setState: applyState }}>
        {children}
      </AgentContext.Provider>
    </AgentStatusContext.Provider>
  );
}

export function useAgent() {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgent must be used inside AgentProvider');
  return value;
}

/**
 * Everything except the queue snapshot.
 *
 * For components that only need to know whether the agent is there — a header,
 * a route guard, a badge. They re-render when the connection changes, and not
 * when a progress bar moves.
 */
export function useAgentStatus() {
  const value = useContext(AgentStatusContext);
  if (!value) throw new Error('useAgentStatus must be used inside AgentProvider');
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
