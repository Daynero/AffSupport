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
import type {
  NativeUpdateAction,
  NativeUpdateSnapshot,
  NativeUpdateStage
} from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { analytics } from '../analytics/service';
import { markAgentInstallStarted } from '../api/client';
import { installedReleaseStatus, resolveInstallerDownload } from '../release-manifest';
import { useNativeAppUpdate } from './useNativeAppUpdate';
import { openNativeAppUpdate } from './openNativeAppUpdate';

/**
 * 074 — one owner of «is there an update, and where is it».
 *
 * The bottom notice, the native notice and the user menu each used to read the
 * update on their own, and the offer lived only in a notice that «Later» hid for
 * good. The header button, the «What's new» window and the details dialog now
 * read the same offer from here, and the native updater has exactly one reader
 * on the page (one SSE subscription, one `ack-visible`).
 */
export type UpdatePhase =
  'available' | 'downloading' | 'waiting' | 'installing' | 'ready' | 'attention';

export interface UpdateOffer {
  /** How this computer is updated: the native updater, or a downloaded installer. */
  channel: 'native' | 'installer';
  version: string | null;
  /** Identifies the offered build; «What's new» is shown once per value. */
  buildId: string | null;
  phase: UpdatePhase;
  /** Download progress 0..1 while `downloading`, when the size is known. */
  fraction: number | null;
  /** The installed build is no longer supported: the button is a warning. */
  required: boolean;
  /** The downloaded build waits only for a press to install. */
  installReady: boolean;
  /** The installer for this build was downloaded from here: what is left is to open it. */
  installerStarted: boolean;
}

export interface UpdateCenter {
  offer: UpdateOffer | null;
  /** Start the update now: download and install (native) or fetch the installer. */
  start: () => void;
  /** The details dialog (steps, cancel, recovery). */
  openDetails: () => void;
  /** Native updater state, for the details dialog. */
  native: {
    supported: boolean;
    connected: boolean;
    recovery: boolean;
    state: NativeUpdateSnapshot | null;
    error: boolean;
    pending: boolean;
    act: (action: NativeUpdateAction, automaticDownload?: boolean) => Promise<void>;
    refresh: () => Promise<void>;
  };
}

const UpdateCenterContext = createContext<UpdateCenter | null>(null);

/** The update offer, or null outside a page that talks to the local app. */
export function useOptionalUpdateCenter(): UpdateCenter | null {
  return useContext(UpdateCenterContext);
}

/** Asks the «What's new» window to open now (the installer's processor choice lives there). */
export const OPEN_WHATS_NEW = 'soty:whats-new:open';

const DOWNLOADING: ReadonlySet<NativeUpdateStage> = new Set(['preparing']);
const WAITING: ReadonlySet<NativeUpdateStage> = new Set(['consented', 'draining', 'drained']);
const INSTALLING: ReadonlySet<NativeUpdateStage> = new Set([
  'install_committed',
  'replacement_started',
  'replacement_committed',
  'relaunch_requested',
  'target_started',
  'native_ready'
]);
const ATTENTION: ReadonlySet<NativeUpdateStage> = new Set(['failed', 'unknown', 'recovering']);

/** Where a native snapshot puts the header button, or null for «nothing to offer». */
export function nativePhase(
  state: NativeUpdateSnapshot | null,
  recovery: boolean
): UpdatePhase | null {
  if (recovery) return 'attention';
  if (!state) return null;
  if (state.nativeSuccess) return state.uiSuccess ? 'ready' : 'installing';
  if (ATTENTION.has(state.stage)) return 'attention';
  if (DOWNLOADING.has(state.stage)) return 'downloading';
  if (WAITING.has(state.stage)) return 'waiting';
  if (INSTALLING.has(state.stage)) return 'installing';
  if (state.availableActions.includes('prepare') || state.availableActions.includes('accept'))
    return 'available';
  return null;
}

/** Opens a download without leaving the page: the browser saves the installer. */
function download(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

export function UpdateCenterProvider({ children }: { children: ReactNode }) {
  const agent = useAgent();
  const [installerFor, setInstallerFor] = useState<string | null>(null);
  const supported = agent.capabilities.includes('native-app-updates-v1');
  // A live host can require a newer tool contract while its updater remains usable.
  const connected =
    agent.connection === 'connected' || agent.connection === 'agent_update_required';
  const { state, error, pending, act, refresh } = useNativeAppUpdate(
    supported,
    connected,
    agent.agentBuildId
  );
  const recovery = agent.agentRuntime?.nativeAppUpdateStatus === 'recovery_required';
  const manifest = agent.releaseManifest.status === 'ready' ? agent.releaseManifest.manifest : null;
  const target = agent.agentRuntime?.packageTarget;
  const nativeDescriptor =
    (target === 'macos-arm64' || target === 'macos-x64') && manifest
      ? manifest.nativeUpdates?.[target]
      : undefined;
  const status = installedReleaseStatus({
    manifest,
    installedVersion: agent.agentVersion,
    installedChannel: agent.agentChannel,
    compatible: agent.toolAvailable('compressor')
  });
  const legacyBusy =
    agent.state.update?.state === 'pending' || agent.state.update?.state === 'draining';

  const offer = useMemo<UpdateOffer | null>(() => {
    if (!agent.agentVersion || agent.connection === 'checking') return null;
    const required = status === 'update_required';
    const nativeFromHere = supported && !recovery ? nativePhase(state, false) : null;
    if (supported && (nativeFromHere || recovery)) {
      const phase = nativePhase(state, recovery)!;
      return {
        channel: 'native',
        version: state?.candidate?.version ?? manifest?.version ?? null,
        buildId: state?.candidate?.buildId ?? manifest?.buildId ?? null,
        phase,
        fraction:
          phase === 'downloading' && state?.totalBytes
            ? Math.min(1, state.downloadedBytes / state.totalBytes)
            : null,
        required,
        installReady: phase === 'available' && Boolean(state?.availableActions.includes('accept')),
        installerStarted: false
      };
    }
    if (status !== 'update_available' && status !== 'update_required') return null;
    // A native updater that has not looked yet still updates natively: the press checks first.
    const nativeChannel = supported && Boolean(nativeDescriptor) && !recovery;
    return {
      channel: nativeChannel ? 'native' : 'installer',
      version: manifest?.version ?? null,
      buildId: manifest?.buildId ?? null,
      phase: legacyBusy ? 'installing' : 'available',
      fraction: null,
      required,
      installReady: false,
      installerStarted:
        !nativeChannel && installerFor !== null && installerFor === manifest?.buildId
    };
  }, [
    agent.agentVersion,
    agent.connection,
    installerFor,
    legacyBusy,
    manifest,
    nativeDescriptor,
    recovery,
    state,
    status,
    supported
  ]);

  /*
   * The person's «Update» is consent to the whole native sequence: check if the
   * updater has not looked yet, download, then install once it is downloaded.
   * The updater itself waits for running work to finish and relaunches Soty.
   * Kept in memory only: a reload between download and install asks once more.
   */
  const consent = useRef(false);
  const lastStep = useRef<string | null>(null);
  useEffect(() => {
    if (!consent.current || !state || pending || !connected) return;
    const step = state.availableActions.includes('accept')
      ? 'accept'
      : state.availableActions.includes('prepare')
        ? 'prepare'
        : state.stage === 'idle' && state.availableActions.includes('check')
          ? 'check'
          : null;
    if (!step) {
      if (ATTENTION.has(state.stage) || state.stage === 'cancelled') consent.current = false;
      return;
    }
    const key = `${state.installationId}:${state.revision}:${step}`;
    if (lastStep.current === key) return;
    lastStep.current = key;
    if (step === 'accept') consent.current = false;
    void act(step);
  }, [act, connected, pending, state]);

  const start = useCallback(() => {
    if (!offer) return;
    if (offer.channel === 'native') {
      if (offer.phase !== 'available') {
        openNativeAppUpdate();
        return;
      }
      consent.current = true;
      lastStep.current = null;
      analytics.track('update_started', {});
      if (!state) void refresh();
      else if (state.availableActions.includes('accept')) {
        consent.current = false;
        void act('accept');
      } else if (state.availableActions.includes('prepare')) void act('prepare');
      else if (state.availableActions.includes('check')) void act('check');
      return;
    }
    const selection = resolveInstallerDownload(manifest, agent.agentRuntime);
    if (selection.status !== 'available') {
      // Which processor (or nothing to download): the window with the choice says it.
      window.dispatchEvent(new Event(OPEN_WHATS_NEW));
      return;
    }
    markAgentInstallStarted();
    analytics.track('update_started', { installer_target: selection.platform });
    download(selection.url);
    setInstallerFor(manifest?.buildId ?? null);
  }, [act, agent.agentRuntime, manifest, offer, refresh, state]);

  const openDetails = useCallback(() => {
    if (offer?.channel === 'installer') window.dispatchEvent(new Event(OPEN_WHATS_NEW));
    else openNativeAppUpdate();
  }, [offer?.channel]);

  const value = useMemo<UpdateCenter>(
    () => ({
      offer,
      start,
      openDetails,
      native: { supported, connected, recovery, state, error, pending, act, refresh }
    }),
    [act, connected, error, offer, openDetails, pending, recovery, refresh, start, state, supported]
  );
  return <UpdateCenterContext.Provider value={value}>{children}</UpdateCenterContext.Provider>;
}
