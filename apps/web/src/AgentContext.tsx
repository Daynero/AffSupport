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
  agentKnown,
  agentProvenAlive,
  agentUrl,
  markAgentSeen,
  claimAutomaticPairing,
  connect,
  onRequestFailure,
  toolEventUrl,
  onPairingToken,
  pairWithAgent,
  releaseAutomaticPairing,
  type RequestFailureKind
} from './api/client';
import { ensureAgentEntitlement } from './api/entitlement';
import {
  handshakeForToken,
  hasPendingPairingToken,
  pairingToken,
  storePairingToken,
  verifyPairingToken
} from './api/pairing-token';
import { DEFAULT_HEARTBEAT_MS, streamClient, type StreamEndReason } from './api/stream-client';
import { useAgentEventStream } from './api/useAgentEventStream';
import { failureState, type ConnectionState, type LinkReason, versionState } from './connection';
import { analytics } from './analytics/service';
import {
  trackBlockedByBrowser,
  trackLinkCheckCompleted,
  trackLinkCheckStarted,
  trackLinkInconsistency,
  trackLinkLost,
  trackLinkRecovered,
  trackPairing,
  trackReconnectClicked,
  type LinkReasonProp,
  type LinkStage,
  type LinkTrigger,
  type ReconnectSurface
} from './analytics/link';
import { servedByAgent } from './lib/config';
import { platformFromAgentCapabilities } from './lib/platform';
import {
  installedReleaseStatus,
  loadStableReleaseManifest,
  type ReleaseManifestState
} from './release-manifest';
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

/**
 * Whether a tool can be used right now, and if not, which of the reasons it is (032 FR-013).
 *
 * The booleans this replaces were false for two very different situations — an agent that
 * is not there and an agent that is too old for the job — and every surface that read one
 * had to guess which sentence to show. Most guessed "update".
 */
export type Availability = 'ready' | 'disconnected' | 'too_old' | 'blocked' | 'account';

/** One connection attempt, from trigger to outcome. */
export interface LinkAttempt {
  id: string;
  startedAt: number;
  trigger: LinkTrigger;
  stage: LinkStage;
  /** A manual "Reconnect" pressed while this attempt was already running. */
  joined: boolean;
}

/** The last agent this page talked to, kept across a loss so screens can say "last seen". */
export interface LastKnownAgent {
  version: string | null;
  buildId: string | null;
  instanceId: string | null;
  channel: string | null;
  capabilities: string[];
  toolContracts: ToolContracts;
  seenAt: number;
}

export interface AgentContextValue {
  connection: ConnectionState;
  /** Why the connection is not simply `connected`; null while it is, or is being checked. */
  reason: LinkReason | null;
  /** The attempt in flight, if any. */
  attempt: LinkAttempt | null;
  lastKnownAgent: LastKnownAgent | null;
  /** The online account check failed but the agent is still inside its grace window. */
  accountCheckPending: boolean;
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
  /** True when the signed manifest says this installed version is unsupported. */
  releaseBlocked: boolean;
  toolAvailable: (tool: SotyToolId) => boolean;
  toolAvailability: (tool: SotyToolId) => Availability;
  teamWorkspaceAvailable?: boolean;
  teamWorkspaceAvailability: Availability;
  reconnect: (surface?: ReconnectSurface) => void;
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

/** How long one attempt may take, all stages included (032 FR-009). */
const ATTEMPT_TIMEOUT_MS = 8_000;
/** The probe inside an attempt: the agent answers loopback in milliseconds or not at all. */
const PROBE_TIMEOUT_MS = 2_200;
/** Automatic retries: twice quickly, then slowly (032 FR-008). */
const RETRY_FAST_MS = 4_000;
const RETRY_SLOW_MS = 15_000;
const RETRY_FAST_COUNT = 2;
/** Account-check retries while the agent still refuses: 30 s, doubling to 5 min. */
const ACCOUNT_RETRY_MIN_MS = 30_000;
const ACCOUNT_RETRY_MAX_MS = 5 * 60_000;
/** A visibility, page-show or online event is checked after a short debounce. */
const WAKE_DEBOUNCE_MS = 500;
/** A dropped stream is re-checked over HTTP once the interface's grace has passed. */
const STREAM_RECHECK_MS = 3_000;
/** Not every refused request may restart a check; one per this interval is enough. */
const INCONSISTENCY_INTERVAL_MS = 5_000;
/** How many times a held fragment token is re-verified while the agent is unreachable. */
const PENDING_TOKEN_RETRIES = 3;
const PENDING_TOKEN_RETRY_MS = 10_000;

function reasonForState(state: ConnectionState): LinkReason | null {
  switch (state) {
    case 'agent_update_required':
      return 'agent_too_old';
    case 'web_update_required':
      return 'web_too_old';
    case 'connection_blocked':
      return 'blocked_by_browser';
    case 'pairing_required':
      return 'pairing_rejected';
    case 'entitlement_blocked':
      return 'account_check_required';
    case 'not_installed_or_not_running':
      return agentKnown() ? 'not_running' : 'not_installed';
    case 'disconnected':
      return 'not_running';
    default:
      return null;
  }
}

function toReasonProp(reason: LinkReason | null): LinkReasonProp {
  return reason ?? 'unknown';
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [reason, setReason] = useState<LinkReason | null>(null);
  const [attempt, setAttempt] = useState<LinkAttempt | null>(null);
  const [lastKnownAgent, setLastKnownAgent] = useState<LastKnownAgent | null>(null);
  const [accountCheckPending, setAccountCheckPending] = useState(false);
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
  const [heartbeatMs, setHeartbeatMs] = useState(DEFAULT_HEARTBEAT_MS);
  const [releaseManifest, setReleaseManifest] = useState<ReleaseManifestState>({
    status: 'checking',
    manifest: null
  });
  const [entitlement, setEntitlement] = useState<AgentEntitlementStatus | null>(null);
  const connectedOnceRef = useRef(false);
  const connectionRef = useRef<ConnectionState>('checking');
  connectionRef.current = connection;
  /** The attempt in flight, readable without a render. */
  const attemptRef = useRef<LinkAttempt | null>(null);
  /** A new token arrived while an attempt was running; check again when it ends. */
  const rerunAfterAttempt = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountRetryDelay = useRef(ACCOUNT_RETRY_MIN_MS);
  const consecutiveFailures = useRef(0);
  const mounted = useRef(true);
  /** When the link was lost, for the recovery duration; null while connected. */
  const lostAt = useRef<number | null>(null);
  /** How the loss will have been recovered: by hand or on its own. */
  const recoveryMode = useRef<'auto' | 'manual'>('auto');
  const lastInconsistencyAt = useRef(0);
  const pendingTokenRetries = useRef(0);
  const streamRecheck = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setConnectionAndReason = useCallback((next: ConnectionState) => {
    setConnection(next);
    setReason(reasonForState(next));
  }, []);

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

  const scheduleRetry = useCallback((run: (trigger: LinkTrigger) => void) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const delay = consecutiveFailures.current < RETRY_FAST_COUNT ? RETRY_FAST_MS : RETRY_SLOW_MS;
    consecutiveFailures.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      run('retry');
    }, delay);
  }, []);

  const establishRef = useRef<(trigger: LinkTrigger) => Promise<void>>(async () => {});

  const establish = useCallback(
    async (trigger: LinkTrigger) => {
      // One attempt at a time. A second ask joins the one in flight rather than being
      // dropped on the floor: the button the user pressed must visibly do something, and
      // the attempt that is running will answer it (032 FR-009).
      const running = attemptRef.current;
      if (running) {
        if (trigger === 'manual' && !running.joined) {
          running.joined = true;
          setAttempt({ ...running });
        }
        // A token that arrived mid-attempt was not the one that attempt read. Joining
        // would let it fail on the old token, and a handshake that hands back the
        // token this browser already holds changes nothing, so nobody would ever ask
        // again — "Looking for Soty…" for good. Run once more when it is over.
        if (trigger === 'token_changed') rerunAfterAttempt.current = true;
        return;
      }
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      const current: LinkAttempt = {
        id: crypto.randomUUID(),
        startedAt: Date.now(),
        trigger,
        stage: 'probe',
        joined: false
      };
      attemptRef.current = current;
      setAttempt(current);
      trackLinkCheckStarted({ flowId: current.id, trigger });
      const setStage = (stage: LinkStage) => {
        current.stage = stage;
        if (mounted.current) setAttempt({ ...current });
      };
      // A background retry keeps the current panel and only pulses a small inline
      // indicator. Flipping to the full "connecting" state on every attempt made
      // the home page blink between the spinner and the onboarding panel.
      if (trigger === 'boot') setConnectionAndReason('checking');
      else if (trigger === 'manual' || trigger === 'token_changed')
        setConnectionAndReason('connecting');

      const controller = new AbortController();
      // The deadline both aborts the stages that listen and ends the attempt for the
      // ones that do not: an attempt is over at the deadline whatever is still pending,
      // so a "Reconnect" can never be swallowed by a check that hung (032 FR-009).
      let expireAttempt: () => void = () => {};
      const expired = new Promise<never>((_resolve, reject) => {
        expireAttempt = () => reject(new Error('TIMEOUT'));
      });
      const deadline = window.setTimeout(() => {
        controller.abort();
        expireAttempt();
      }, ATTEMPT_TIMEOUT_MS);
      const stillCurrent = () => attemptRef.current === current;
      const probeSignal = () => {
        const probe = new AbortController();
        const timer = window.setTimeout(() => probe.abort(), PROBE_TIMEOUT_MS);
        const onDeadline = () => probe.abort();
        controller.signal.addEventListener('abort', onDeadline, { once: true });
        return {
          signal: probe.signal,
          done: () => {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', onDeadline);
          }
        };
      };

      const finish = (
        outcome: 'success' | 'failure' | 'blocked',
        nextReason: LinkReason | null
      ) => {
        trackLinkCheckCompleted({
          flowId: current.id,
          outcome,
          reason: outcome === 'success' ? undefined : toReasonProp(nextReason),
          stage: current.stage,
          durationMs: Date.now() - current.startedAt
        });
      };

      const read = async () => {
        setStage('health');
        const first = probeSignal();
        let result: Awaited<ReturnType<typeof connect>>;
        try {
          result = await connect(first.signal);
        } finally {
          first.done();
        }
        // An enforced agent without a fresh token refuses tool routes: exchange
        // the Supabase session for a signed entitlement token, then reconnect.
        if (
          versionState(result.apiVersion) === 'connected' &&
          result.entitlement?.enforced &&
          !result.entitlement.entitled
        ) {
          setStage('entitlement');
          await ensureAgentEntitlement(controller.signal);
          setStage('snapshot');
          const second = probeSignal();
          try {
            result = await connect(second.signal);
          } finally {
            second.done();
          }
        }
        return result;
      };

      try {
        const result = await Promise.race([read(), expired]);
        if (!mounted.current || !stillCurrent()) return;
        // The Agent answered, whatever it answered. Remembered here rather than
        // only on a full connection, because a version mismatch or a failed
        // entitlement check still proves Soty is installed — and those are the
        // states whose screens have to choose between "open" and "download".
        markAgentSeen();
        setEntitlement(result.entitlement);
        const next = versionState(result.apiVersion);
        const previousInstance = knownInstance.current;
        setAgentVersion(result.version || null);
        setAgentBuildId(result.buildId || null);
        setAgentChannel(result.channel || null);
        setAgentApiVersion(result.apiVersion);
        setCapabilities(result.capabilities);
        setToolContracts(result.toolContracts);
        if (result.heartbeatMs) setHeartbeatMs(result.heartbeatMs);
        setLastKnownAgent({
          version: result.version || null,
          buildId: result.buildId || null,
          instanceId: result.instanceId || null,
          channel: result.channel || null,
          capabilities: result.capabilities,
          toolContracts: result.toolContracts,
          seenAt: Date.now()
        });
        // 031 FR-053: the Agent's per-boot id and its own word on the host OS; an agent
        // older than the `platform` field is placed by its capabilities, which only ever
        // establish macOS — anything else stays unknown rather than guessed.
        const agentPlatform = result.platform ?? platformFromAgentCapabilities(result.capabilities);
        analytics.setAgentContext({
          version: result.version || null,
          buildId: result.buildId || null,
          channel: result.channel || null,
          apiVersion: result.apiVersion,
          toolContracts: result.toolContracts,
          instanceId: result.instanceId || null,
          platform: agentPlatform === 'macos' || agentPlatform === 'windows' ? agentPlatform : null
        });
        consecutiveFailures.current = 0;
        if (next !== 'connected') {
          setConnectionAndReason(next);
          finish('failure', reasonForState(next));
          return;
        }
        if (!result.state) throw new Error('AGENT_STATE_MISSING');
        setStage('snapshot');
        // The documented bypass. A restarted local app resets its counter to
        // zero, so the first snapshot of a new run looks stale by number and is
        // not: keyed on identity — the build the agent reports — rather than on
        // the number, because treating a lower revision as stale here would
        // freeze the interface on the previous run's last state forever.
        const instance = result.instanceId || result.buildId || null;
        applyState(result.state, { freshConnect: true, instance });
        setConnection('connected');
        setReason(result.update && result.update.state !== 'none' ? 'update_in_progress' : null);
        setAccountCheckPending(false);
        accountRetryDelay.current = ACCOUNT_RETRY_MIN_MS;
        setConnectedOnce(true);
        connectedOnceRef.current = true;
        releaseAutomaticPairing();
        setStage('stream');
        if (lostAt.current !== null) {
          trackLinkRecovered({
            flowId: current.id,
            durationMs: Date.now() - lostAt.current,
            mode: recoveryMode.current,
            instanceChanged: previousInstance !== null && previousInstance !== instance,
            tokenChanged: trigger === 'token_changed'
          });
          lostAt.current = null;
          recoveryMode.current = 'auto';
        }
        finish('success', null);
      } catch (error) {
        window.clearTimeout(deadline);
        if (!mounted.current || !stillCurrent()) return;
        if (error instanceof Error && error.message === 'PAIRING_REQUIRED') {
          setStage('token');
          // Re-pair without asking whenever the Agent has proved it is running:
          // it answered 401 with a token this browser no longer shares, or it
          // served this very page. Making the user hunt for a "find the agent"
          // button after every Agent restart was the single most common way to
          // get stuck, and the budget keeps a rejected token from spinning.
          if (agentProvenAlive(error)) markAgentSeen();
          const canPairSilently =
            trigger === 'manual' ||
            trigger === 'boot' ||
            agentProvenAlive(error) ||
            agentInstallAwaitingPairing();
          if (canPairSilently && claimAutomaticPairing()) {
            setConnectionAndReason('connecting');
            finish('failure', 'pairing_rejected');
            trackPairing('started', { flowId: current.id, method: 'handshake' });
            // In-page first (FR-038). The navigation below works and takes the
            // whole page with it — an editable transcript, a half-filled form,
            // an open dialog — to deliver a string. The handshake asks for the
            // same string without moving anyone, and falls back to the old path
            // on timeout, so this is never worse than it was.
            void handshakeForToken(agentUrl).then(handshakeToken => {
              if (!mounted.current) return;
              if (handshakeToken) {
                trackPairing('completed', { flowId: current.id, method: 'handshake' });
                // Storing notifies the token listener, which restarts the stream and
                // re-establishes with `token_changed`. The same token coming back means
                // the agent did not reject it for being stale — a retry later, not now —
                // unless a run that started meanwhile has already connected on it.
                if (!storePairingToken(handshakeToken) && connectionRef.current !== 'connected') {
                  scheduleRetry(t => void establishRef.current(t));
                }
                return;
              }
              trackPairing('failed', { flowId: current.id, method: 'handshake' });
              trackPairing('started', { flowId: current.id, method: 'navigation' });
              pairWithAgent();
            });
          } else {
            // Not a dead end: the Agent may still be starting, so keep looking.
            setConnectionAndReason('pairing_required');
            finish('failure', 'pairing_rejected');
            scheduleRetry(t => void establishRef.current(t));
          }
        } else if (error instanceof Error && error.message.startsWith('ENTITLEMENT')) {
          // The agent refuses tool routes until the account check succeeds. A server
          // that said no (401/403) needs the user; a server that could not be reached
          // is retried on its own, slowly, because the fix may simply be the network
          // coming back (032 FR-015).
          const unavailable = error.message === 'ENTITLEMENT_UNAVAILABLE';
          setConnection('entitlement_blocked');
          setReason(unavailable ? 'account_check_unavailable' : 'account_check_required');
          finish('failure', unavailable ? 'account_check_unavailable' : 'account_check_required');
          if (unavailable) {
            if (accountRetryTimer.current) clearTimeout(accountRetryTimer.current);
            const delay = accountRetryDelay.current;
            accountRetryDelay.current = Math.min(ACCOUNT_RETRY_MAX_MS, delay * 2);
            accountRetryTimer.current = setTimeout(() => {
              accountRetryTimer.current = null;
              void establishRef.current('retry');
            }, delay);
          }
        } else if (error instanceof Error && error.message === 'TIMEOUT') {
          setConnectionAndReason(connectedOnceRef.current ? 'disconnected' : 'checking');
          setReason('timeout');
          finish('failure', 'timeout');
          scheduleRetry(t => void establishRef.current(t));
        } else {
          const next = connectedOnceRef.current
            ? 'disconnected'
            : await failureState({ hosted: !servedByAgent(), agentKnown: agentKnown() });
          if (!mounted.current) return;
          setConnectionAndReason(next);
          if (next === 'connection_blocked') trackBlockedByBrowser();
          finish(next === 'connection_blocked' ? 'blocked' : 'failure', reasonForState(next));
          // A browser that blocks loopback blocks it every time; polling it changes nothing.
          if (next !== 'connection_blocked') scheduleRetry(t => void establishRef.current(t));
        }
      } finally {
        window.clearTimeout(deadline);
        attemptRef.current = null;
        if (mounted.current) setAttempt(null);
        if (rerunAfterAttempt.current) {
          rerunAfterAttempt.current = false;
          if (mounted.current) void establishRef.current('token_changed');
        }
      }
    },
    [applyState, scheduleRetry, setConnectionAndReason]
  );
  establishRef.current = establish;

  /** The link was lost: remember when, tell analytics once, show it. */
  const noteLost = useCallback(
    (transport: 'stream' | 'request' | 'watchdog', streamReason?: StreamEndReason) => {
      if (lostAt.current === null) {
        lostAt.current = Date.now();
        recoveryMode.current = 'auto';
        trackLinkLost({
          flowId: attemptRef.current?.id ?? crypto.randomUUID(),
          transport,
          reason:
            streamReason === 'unauthorized'
              ? 'pairing_rejected'
              : streamReason === 'forbidden'
                ? 'account_check_required'
                : 'not_running'
        });
      }
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
    // The token is a function: read at every connection, so a re-pair is picked up by
    // the next attempt rather than retried against forever (032 W2).
    streamClient.configure({ agentUrl, token: () => pairingToken(), heartbeatMs });
    return () => streamClient.configure(null);
  }, [connectedOnce, multiplexed, heartbeatMs]);

  useAgentEventStream<AgentEvent>({
    url: connectedOnce ? toolEventUrl('compressor') : null,
    channel: 'compressor',
    multiplexed,
    enabled: connectedOnce,
    onMessage: update => {
      applyState(update.state);
      // A live frame proves the stream, not the API: `connected` is only restored by an
      // attempt that read health, so a revoked token cannot look like a working link.
    },
    onDisconnect: streamReason => {
      noteLost(streamReason === 'watchdog' ? 'watchdog' : 'stream', streamReason);
      if (connectionRef.current === 'connected') setConnectionAndReason('disconnected');
      if (streamReason === 'unauthorized') setReason('pairing_rejected');
    },
    onReconnect: streamReason => {
      // The shared client retries the socket by itself; what it cannot do is decide what
      // the failure meant. A rejected token needs re-pairing, a refused entitlement needs
      // the account check, and anything else needs health re-read before "connected" is
      // believed again. The re-read waits out the grace: a local app restarting answers
      // nothing for a second, and a probe that fails inside the grace would turn a blip
      // into a banner the grace exists to prevent (032 FR-002).
      if (streamReason === 'parked') return;
      if (streamReason === 'unauthorized' || streamReason === 'forbidden') {
        void establish('token_changed');
        return;
      }
      if (streamRecheck.current) return;
      streamRecheck.current = setTimeout(() => {
        streamRecheck.current = null;
        void establish('stream_lost');
      }, STREAM_RECHECK_MS);
    }
  });

  // The signed token lives 12h and the agent adds a 7-day offline grace, so a
  // long-running session only needs an occasional silent top-up. Failures mark the
  // check as pending rather than blocking anything: the grace window keeps the agent
  // entitled until the next success.
  useEffect(() => {
    if (connection !== 'connected' || !entitlement?.enforced) return;
    const topUp = () =>
      void ensureAgentEntitlement()
        .then(next => {
          setEntitlement(next);
          setAccountCheckPending(false);
        })
        .catch(() => setAccountCheckPending(true));
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
    // stops working for reasons nothing on screen explains. When the local app
    // cannot be reached yet, the token is held and asked about again (FR-019).
    const verify = async () => {
      const adopted = await verifyPairingToken(agentUrl);
      if (!mounted.current) return;
      if (adopted) trackPairing('completed', { flowId: crypto.randomUUID(), method: 'fragment' });
      if (
        !adopted &&
        hasPendingPairingToken() &&
        pendingTokenRetries.current < PENDING_TOKEN_RETRIES
      ) {
        pendingTokenRetries.current += 1;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void verify();
        }, PENDING_TOKEN_RETRY_MS);
      }
    };
    void verify().finally(() => {
      if (mounted.current) void establish('boot');
    });
    // The token changed — by this tab's handshake, by another tab's, or by the fragment.
    // The stream must carry the new one and the state must be re-read against it.
    const removePairingListener = onPairingToken(() => {
      streamClient.restart();
      void establish('token_changed');
    });
    return () => {
      mounted.current = false;
      removePairingListener();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (accountRetryTimer.current) clearTimeout(accountRetryTimer.current);
      if (streamRecheck.current) clearTimeout(streamRecheck.current);
    };
  }, [establish]);

  // Coming back — to the tab, to the page, to the network — is checked at once rather
  // than on the next timer. A machine that slept has a dead socket and no error to show
  // for it; the person looking at it should not wait for a retry schedule (032 FR-004).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = (trigger: LinkTrigger) => {
      if (document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (connectionRef.current === 'connected' && streamClient.isOpen()) return;
        if (connectionRef.current === 'connection_blocked' && trigger !== 'online') return;
        void establish(trigger);
      }, WAKE_DEBOUNCE_MS);
    };
    const onVisibility = () => wake('visibility');
    const onPageShow = () => wake('pageshow');
    const onOnline = () => wake('online');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, [establish]);

  // A request refused while the page believes it is connected is the one signal that the
  // stream and the API have come apart (032 FR-026). Re-check, at most once per interval.
  useEffect(
    () =>
      onRequestFailure((kind: RequestFailureKind) => {
        if (connectionRef.current !== 'connected') return;
        const now = Date.now();
        if (now - lastInconsistencyAt.current < INCONSISTENCY_INTERVAL_MS) return;
        lastInconsistencyAt.current = now;
        trackLinkInconsistency({
          flowId: attemptRef.current?.id ?? crypto.randomUUID(),
          errorCode: kind,
          streamOpen: streamClient.isOpen()
        });
        noteLost('request', kind === 'unauthorized' ? 'unauthorized' : undefined);
        void establish(kind === 'unauthorized' ? 'token_changed' : 'request_failed');
      }),
    [establish, noteLost]
  );

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
  const status = useMemo(() => {
    const connected = connection === 'connected';
    const availability = (compatible: boolean): Availability => {
      if (connection === 'connection_blocked') return 'blocked';
      if (connection === 'entitlement_blocked') return 'account';
      if (!connected) return 'disconnected';
      return compatible ? 'ready' : 'too_old';
    };
    return {
      connection,
      reason,
      attempt,
      lastKnownAgent,
      accountCheckPending,
      connectedOnce,
      agentVersion,
      agentBuildId,
      agentChannel,
      agentApiVersion,
      capabilities,
      toolContracts,
      releaseManifest,
      /**
       * A version the signed manifest says is no longer supported.
       *
       * Kept as a derived value rather than folded into `connection`: the
       * manifest arrives on its own schedule, and a probe result must not be
       * overwritten by a network read that had not finished yet. The tool gate
       * re-reads this the moment the manifest lands. Only meaningful while the
       * agent is connected: a lost link is not an old agent (032 FR-014).
       */
      releaseBlocked:
        connected &&
        releaseManifest.status === 'ready' &&
        installedReleaseStatus({
          manifest: releaseManifest.manifest,
          installedVersion: agentVersion,
          installedChannel: agentChannel,
          compatible: toolContractCompatible('compressor', toolContracts)
        }) === 'update_required',
      toolAvailable: (tool: SotyToolId) => toolContractCompatible(tool, toolContracts),
      toolAvailability: (tool: SotyToolId) =>
        availability(toolContractCompatible(tool, toolContracts)),
      teamWorkspaceAvailable: connected && toolContractCompatible('teamWorkspace', toolContracts),
      teamWorkspaceAvailability: availability(
        toolContractCompatible('teamWorkspace', toolContracts)
      ),
      reconnect: (surface?: ReconnectSurface) => {
        // An explicit ask is never held back by the automatic budget: that
        // budget exists to stop the page navigating in a loop on its own, not
        // to stop the user from trying again.
        releaseAutomaticPairing();
        recoveryMode.current = 'manual';
        if (surface) {
          trackReconnectClicked({
            flowId: attemptRef.current?.id ?? crypto.randomUUID(),
            surface
          });
        }
        void establish('manual');
      }
    };
  }, [
    connection,
    reason,
    attempt,
    lastKnownAgent,
    accountCheckPending,
    connectedOnce,
    agentVersion,
    agentBuildId,
    agentChannel,
    agentApiVersion,
    capabilities,
    toolContracts,
    releaseManifest,
    establish
  ]);

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
