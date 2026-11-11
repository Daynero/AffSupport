import { callCatalogVideoForegroundHttp } from './team-bridge/catalog-video-foreground-http.js';
import { runCatalogVariantRecovery } from './team-bridge/catalog-variant-recovery.js';
import {
  CATALOG_FOREGROUND_VAULT_ACCOUNT,
  CatalogVideoForegroundController
} from './team-bridge/catalog-video-foreground.js';
import { NativeRestitchVaultFile } from './team-bridge/native-restitch-vault.js';
import { settleCatalogVariantProcess } from './team-bridge/catalog-variant-closure.js';
import { randomUUID } from 'node:crypto';
import { isRecord } from '@video-compressor/shared';
import { NativeRestitchController } from './team-bridge/native-restitch-controller.js';
import { NativeRestitchJournal } from './team-bridge/native-restitch-journal.js';
import { ScreenCacheError } from './team-bridge/screen-cache.js';
import { TeamRecoveryWorker } from './team-bridge/recovery-worker.js';
import { RecoveryJournal } from './team-bridge/recovery-journal.js';
import { createAgentInstance } from './server/instance.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentEventType,
  LandingEvent,
  LandingEventType,
  LandingPreviewEvent,
  StitcherEvent,
  TranscriptionEvent,
  TranscriptionEventType
} from '@video-compressor/shared';
import { allowedOrigins, config } from './config.js';
import { EntitlementGate } from './entitlement/entitlement.js';
import { EstimationWorker } from './estimate/worker.js';
import { applicationSupportRoot } from './files/support-dir.js';
import { shutdownNativePickers } from './files/picker.js';
import {
  ffmpegPath,
  ffprobePath,
  MediaToolUnavailableError,
  probeMediaTool
} from './ffmpeg/tools.js';
import { ImageAssetStore } from './images/store.js';
import { sweepWorkspaces } from './landing/workspace.js';
import { LandingOptimizer } from './landing/optimizer.js';
import { LandingPreviewCatalog } from './landing-preview/catalog.js';
import { MediaActionQueue } from './media-actions/queue.js';
import { JobQueue } from './queue/queue.js';
import { loadState, saveState } from './queue/store.js';
import { loadTranscriptionState, saveTranscriptionState } from './queue/transcription-store.js';
import { TranscriptionQueue } from './queue/transcription-queue.js';
import {
  packagedAgentLostLauncher,
  parseLauncherPid,
  processIsAlive
} from './runtime/launcher-watchdog.js';
import { PowerGovernor } from './power/governor.js';
import { loadPowerState, savePowerLimit } from './power/store.js';
import { PowerSampler } from './power/sampler.js';
import { activeThreadBudget, setActiveGovernor } from './power/spawn.js';
import { buildServer } from './server/app.js';
import { hasCapability } from './server/capabilities.js';
import {
  DIAGNOSTICS_FILE_NAME,
  DiagnosticsLog,
  setActiveDiagnosticsLog
} from './server/diagnostics-log.js';
import { currentPlatform } from './platform/platform.js';
import { resolveSessionToken } from './server/session-token.js';
import { ChannelHub, EventChannel, type ShutdownReason } from './server/sse.js';
import { createToolModules } from './server/tools.js';
import { StitchQueue } from './stitcher/queue.js';
import { loadStitcherState, saveStitcherState } from './stitcher/store.js';
import { TeamPreviewBridge } from './team-bridge/preview.js';
import { TeamOperationEvents, type TeamOperationEvent } from './team-bridge/events.js';
import { RestitchPrepareBridge } from './team-bridge/restitch-prepare.js';
import { TeamDownloadBridge } from './team-bridge/download.js';
import { TeamLandingRenderBridge } from './team-bridge/landing-gallery.js';
import { createTeamProcessDelegates, TeamProcessBridge } from './team-bridge/process.js';
import { createRestitchDelegate } from './team-bridge/restitch.js';
import { TeamScreenCache } from './team-bridge/screen-cache.js';
import { TeamPosterBridge } from './team-bridge/poster.js';
import { CreativeLibraryProcessBridge } from './team-bridge/library.js';
import { TeamTransferClient } from './team-bridge/transfer.js';
import { TeamSourceCache } from './team-bridge/source-cache.js';
import { defaultQualityForInstalledModels, whisperAvailable } from './whisper/tools.js';
import { sweepAbandonedTempDirectories } from './whisper/transcriber.js';
import { pathGrants } from './files/path-grants.js';

// Persisted across restarts on purpose: a per-boot token silently unpairs
// every browser that already holds one (see server/session-token.ts).
const token = await resolveSessionToken();
const nativeToken = process.env.AGENT_NATIVE_TOKEN?.trim() || null;
const updateHandoffToken = process.env.AGENT_UPDATE_HANDOFF_TOKEN?.trim() || null;
// Distinguishes an intentional update handoff from an unexpected clean exit
// in the native launcher. The launcher then either opens the installed build
// or releases its instance lock for the waiting newer launcher.
const UPDATE_HANDOFF_EXIT_CODE = 76;
// Server-issued account entitlement. Packaged production builds embed the
// public key via the launcher; without it (development) nothing is enforced.
const entitlementGate = new EntitlementGate({
  publicKeyBase64: process.env.AGENT_ENTITLEMENT_PUBLIC_KEY,
  stateFile: path.join(applicationSupportRoot(), 'entitlement.json')
});
await entitlementGate.load();
const { instanceId, startedAt } = createAgentInstance();
// The bounded local journal (031 FR-054). Loaded before anything else can write to it, so
// the sequence continues from the previous boot and its shutdown reason is still on the page;
// installed process-wide so the deep seams (spawn, pickers, drop resolver, streams) reach it.
const diagnosticsLog = new DiagnosticsLog({
  instanceId,
  file: path.join(applicationSupportRoot(), DIAGNOSTICS_FILE_NAME)
});
await diagnosticsLog.load();
setActiveDiagnosticsLog(diagnosticsLog);
diagnosticsLog.record('boot', 'started', {
  version: config.version,
  buildId: config.buildId,
  instanceId,
  platform: currentPlatform(),
  environment: config.environment,
  // Whether the port is the one every client assumes, or one somebody configured.
  portRole: process.env.AGENT_PORT ? 'configured' : 'default',
  packaged: process.env.PACKAGED_APP === '1',
  entitlementEnforced: entitlementGate.enforced
});
const bootProbes = {
  ffmpeg: await probeMediaTool(ffmpegPath),
  ffprobe: await probeMediaTool(ffprobePath)
};
for (const [tool, probe] of Object.entries(bootProbes)) {
  // Said out loud once, because the alternative is a UI that only knows the
  // engine is unavailable: a bundled binary that is present but refused looks
  // exactly like one that was never installed.
  if (!probe.runnable) console.error(`Bundled ${tool} is not runnable (${probe.failure})`);
}
const tools = {
  ffmpeg: bootProbes.ffmpeg.runnable,
  ffprobe: bootProbes.ffprobe.runnable
};
// The whisper binary is static, so it is probed once at boot; ffmpeg is
// re-checked live and the model presence is computed on demand by the queue.
const transcriptionTools = {
  ffmpeg: tools.ffmpeg,
  whisper: await whisperAvailable()
};
diagnosticsLog.record('boot', 'tools_probed', {
  ffmpeg: tools.ffmpeg,
  ffprobe: tools.ffprobe,
  whisper: transcriptionTools.whisper
});
const imageStore = new ImageAssetStore();
const mediaActions = new MediaActionQueue(() => broadcast());
const teamPreviewBridge = new TeamPreviewBridge();
await teamPreviewBridge.init();
let saveChain = Promise.resolve();
let shuttingDown = false;
let runtimeRestartRequested = false;
let mediaToolsCheckInFlight = false;
let mediaToolsTimer: ReturnType<typeof setInterval> | null = null;
let installedReleaseTimer: ReturnType<typeof setInterval> | null = null;
let updateDrainTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The one live-update fan-out, alongside the seven per-tool endpoints.
 *
 * Both, in this release. A client that has not been updated keeps its seven connections;
 * one that sees the `event-stream` capability opens a single connection instead. Removing
 * the endpoints would make the two halves have to ship together.
 */
const channelHub = new ChannelHub();

const landingEvents = new EventChannel<LandingEvent>(allowedOrigins, () => ({
  type: 'landing:state',
  state: landingOptimizer.state()
}));
const landingOptimizer = new LandingOptimizer(tools, (type: LandingEventType = 'landing:state') =>
  landingEvents.broadcast({ type, state: landingOptimizer.state() })
);
landingEvents.publishOn(channelHub, 'landing');
// Whatever was chosen last time, before the first request can read the settings back.
await landingOptimizer.restoreSettings();
/* And whatever the last run left behind. A working copy is a whole copy of a landing; it is
   cleared when its job goes, which does not happen if this process was killed.
   Awaited: the sweep deletes every `landing-*` directory, and `createWorkspace` makes its
   directories with exactly that prefix — so a drop that arrived while a fire-and-forget sweep
   was still walking could have its working copy removed underneath it. Nothing can arrive
   before the server listens, and this finishes first. */
await sweepWorkspaces();

const landingPreviewCatalog = new LandingPreviewCatalog({
  // Read through the process-wide governor rather than captured here: the
  // governor is constructed further down, and the budget has to be the live one
  // anyway so a limit lowered mid-render reaches the pool (A7).
  threadBudget: activeThreadBudget
});
await landingPreviewCatalog.init();
const landingPreviewEvents = new EventChannel<LandingPreviewEvent>(allowedOrigins, () => ({
  type: 'landing-preview:state',
  state: landingPreviewCatalog.state()
}));
landingPreviewCatalog.setNotify(type =>
  landingPreviewEvents.broadcast({
    type: type ?? 'landing-preview:state',
    state: landingPreviewCatalog.state()
  })
);
landingPreviewEvents.publishOn(channelHub, 'landing-preview');

const transcriptionEvents = new EventChannel<TranscriptionEvent>(allowedOrigins, () => ({
  type: 'transcription:state',
  state: transcriptionQueue.state()
}));
const restoredTranscription = await loadTranscriptionState(undefined, {
  fallbackQuality: defaultQualityForInstalledModels()
});
// Scratch audio a killed process left behind; see the transcriber for why it matters.
void sweepAbandonedTempDirectories().catch(() => {});
const transcriptionQueue = new TranscriptionQueue(
  transcriptionTools,
  (type: TranscriptionEventType = 'transcription:state') => {
    // The snapshot is built only when somebody will read it; a run made with every window
    // closed used to serialise the whole state four times a second for nobody.
    if (transcriptionEvents.hasListeners()) {
      transcriptionEvents.broadcast({ type, state: transcriptionQueue.state() });
    }
    // Progress ticks arrive many times a second and change nothing the
    // persisted list needs (job membership, statuses, settings) — skip them.
    if (type !== 'transcription:progress') scheduleTranscriptionPersist();
  },
  restoredTranscription.jobs,
  restoredTranscription.settings
);
transcriptionEvents.publishOn(channelHub, 'transcription');
transcriptionQueue.setInstanceId(instanceId);
// Remove orphaned preview proxies and uploaded copies.
void transcriptionQueue.sweepCaches().catch(() => {});
void transcriptionQueue
  .sweepImports(
    process.env.AGENT_TRANSCRIBE_IMPORT_PATH ??
      path.join(applicationSupportRoot(), 'TranscribeImports')
  )
  .catch(() => {});

const agentEvents = new EventChannel<AgentEvent>(allowedOrigins, () => ({
  type: 'state',
  state: queue.state()
}));
agentEvents.publishOn(channelHub, 'compressor');

/**
 * The stitcher's screens come from the compressor's own image library (FR-003), so the id
 * the browser sends is resolved against the same settings and the same store rather than a
 * second copy of either.
 */
const stitcherEvents = new EventChannel<StitcherEvent>(allowedOrigins, () => ({
  type: 'stitcher:state',
  state: stitchQueue.state()
}));
const restoredStitcher = await loadStitcherState();
/** One resolver, shared by the tool's own queue and by a team delivery. */
const screenImagePath = async (id: string): Promise<string | null> => {
  const embedding = queue.state().settings.imageEmbedding;
  const asset = [...embedding.startImages, ...embedding.endImages].find(
    candidate => candidate.id === id
  );
  if (!asset) return null;
  try {
    return await imageStore.validate(asset);
  } catch {
    return null;
  }
};
const stitchQueue = new StitchQueue({
  imagePathFor: screenImagePath,
  onChange: () => stitcherEvents.broadcast({ type: 'stitcher:state', state: stitchQueue.state() }),
  settings: restoredStitcher.settings,
  jobs: restoredStitcher.jobs,
  threads: () => activeThreadBudget(),
  save: state => void saveStitcherState(state)
});
stitcherEvents.publishOn(channelHub, 'stitcher');

function broadcast(type: AgentEventType = 'state') {
  agentEvents.broadcast({ type, state: queue.state() });
  void persistQueueState();
}

function persistQueueState() {
  saveChain = saveChain
    .then(() => saveState(queue.persisted()))
    .catch(error => logError(error, 'Could not save local state'));
  return saveChain;
}

// The transcription list persists through its own serialized chain so a slow
// compressor save can never delay (or be delayed by) a transcription save.
let transcriptionSaveChain = Promise.resolve();
function persistTranscriptionState() {
  if (transcriptionPersistTimer) {
    clearTimeout(transcriptionPersistTimer);
    transcriptionPersistTimer = null;
  }
  transcriptionSaveChain = transcriptionSaveChain
    .then(() => saveTranscriptionState(transcriptionQueue.persisted()))
    .catch(error => logError(error, 'Could not save transcription state'));
  return transcriptionSaveChain;
}
/**
 * Saves are coalesced: adding fifty files fires a hundred state changes in under a second,
 * and each one used to rewrite the whole list to disk. The trailing write lands a quarter
 * of a second after the last change; shutdown flushes whatever is still pending.
 */
const TRANSCRIPTION_PERSIST_DELAY_MS = 250;
let transcriptionPersistTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTranscriptionPersist() {
  if (transcriptionPersistTimer) return;
  transcriptionPersistTimer = setTimeout(() => {
    transcriptionPersistTimer = null;
    void persistTranscriptionState();
  }, TRANSCRIPTION_PERSIST_DELAY_MS);
}

// The server logger only exists after buildServer(); anything logged before
// that (an early failed state save, for example) falls back to the console.
let logError: (error: unknown, message: string) => void = (error, message) =>
  console.error(message, error);

function requestRuntimeRestart(error: MediaToolUnavailableError) {
  logError(
    { tool: error.tool, causeCode: error.causeCode },
    'Bundled media runtime became unavailable'
  );
  if (process.env.PACKAGED_APP !== '1' || runtimeRestartRequested || shuttingDown) return;
  runtimeRestartRequested = true;
  const timer = setTimeout(() => {
    void saveChain.finally(() => shutdown(75, 'restart'));
  }, 250);
  timer.unref();
}

async function refreshMediaTools() {
  if (mediaToolsCheckInFlight || shuttingDown) return;
  mediaToolsCheckInFlight = true;
  try {
    const [ffmpegProbe, ffprobeProbe] = await Promise.all([
      probeMediaTool(ffmpegPath),
      probeMediaTool(ffprobePath)
    ]);
    const ffmpeg = ffmpegProbe.runnable;
    const ffprobe = ffprobeProbe.runnable;
    queue.setToolAvailability({ ffmpeg, ffprobe });
    transcriptionQueue.setToolAvailability({
      ffmpeg,
      whisper: transcriptionTools.whisper
    });
    if ((!ffmpeg || !ffprobe) && !queue.workActive() && !mediaActions.workActive()) {
      const broken = ffmpeg ? ('ffprobe' as const) : ('ffmpeg' as const);
      const failure = (ffmpeg ? ffprobeProbe : ffmpegProbe).failure;
      // A binary that vanished — an update swapping the runtime out from under a
      // running agent — comes back with a fresh one, so the restart is worth its
      // budget. One the system refuses to launch would be refused again after
      // every restart, so the agent stays up and the UI keeps saying the engine
      // is unavailable instead of the launcher burning through its retries.
      if (failure === 'ENOENT') {
        requestRuntimeRestart(new MediaToolUnavailableError(broken, 'HEALTH_CHECK'));
      } else {
        logError({ tool: broken, causeCode: failure }, 'Bundled media runtime cannot be launched');
      }
    }
  } finally {
    mediaToolsCheckInFlight = false;
  }
}

const restored = await loadState();

/**
 * Rebuilds the path ledger from the state it authorises.
 *
 * Not from a grant file. The persisted queue *is* the record of what the user
 * chose — every input path in it got there through a picker or a drop — so
 * deriving authorisation from it means restoration and authorisation cannot
 * disagree. A separate file would be a second answer to the same question, and
 * the day the two differed one of them would be wrong with nothing to say which.
 *
 * Grants restored this way are held rather than left to age: a queued job may
 * sit for days, and expiring the grant under it would turn a resumed queue into
 * a permission error the user can neither understand nor act on.
 */
function restorePathGrants(): void {
  const chosen = new Set<string>();
  for (const job of restored.jobs) {
    if (job.inputPath) chosen.add(job.inputPath);
  }
  for (const job of restoredTranscription.jobs) {
    if (job.inputPath) chosen.add(job.inputPath);
  }
  const outputFolder = restored.settings?.outputFolder;
  for (const candidate of chosen) {
    pathGrants.mint(candidate, { origin: 'restore', referenced: true });
  }
  if (outputFolder) {
    pathGrants.mint(outputFolder, { access: 'write', origin: 'restore', referenced: true });
  }
}

restorePathGrants();

/**
 * The shared local-resource budget. Constructed before any tool because every
 * heavy child process is spawned through it, and because the compressor queue
 * asks it to hold the active encode while prioritized estimates run — the
 * governor is the single owner of suspend state, so nothing else may stop a
 * managed child.
 *
 * `busy` is read lazily so it can reference the module list defined further
 * down; without it a job that is preparing images (no child process yet) would
 * report as idle while the UI shows it running.
 */
const powerGovernor = new PowerGovernor({
  busy: () => modules.some(module => module.busy()),
  onError: (error, message) => logError(error, message),
  persist: limitPercent => savePowerLimit(limitPercent)
});
const restoredPower = await loadPowerState();
if (restoredPower)
  powerGovernor.adoptPersistedLimit(restoredPower.limitPercent, restoredPower.updatedAt);
// Deep spawn sites resolve the budget through this rather than threading a
// governor through every intermediate signature.
setActiveGovernor(powerGovernor);
const powerSampler = new PowerSampler({
  governor: powerGovernor,
  onError: (error, message) => logError(error, message)
});

const queue = new JobQueue(
  tools,
  broadcast,
  restored.jobs,
  restored.settings,
  restored.batch,
  imageStore
);
queue.attachPowerGovernor(powerGovernor);
// Files can be removed outside Soty while the app is closed. They are not an
// error state to preserve: restore only cards whose sources still exist.
await queue.removeMissingSources();
// The governor is what notices the machine slept; the queue is what knows whether the
// encode it had running is still there (FR-009a).
// It broadcasts on its own when it finds something to interrupt.
powerGovernor.setWakeListener(wake => queue.handleWake(wake));
// Conversions started from the file manager ride the compressor's channel rather than
// opening an eighth one (FR-009b), so they reach the interface wherever its state does.
if (hasCapability('finder-image-conversion')) {
  queue.setMediaActionSource(() => mediaActions.state());
}
await queue.revalidateSettingsImages();
const estimator = new EstimationWorker(
  () => queue.estimationJobs(),
  (id, patch, event) => queue.updateEstimate(id, patch, event),
  () => queue.compressionActive(),
  undefined,
  imageStore
);
queue.attachEstimator({
  schedule: () => estimator.schedule(),
  invalidate: () => estimator.invalidate(),
  resume: () => estimator.resume(),
  runPrioritized: () => estimator.runPrioritized(),
  cancelPrioritized: id => estimator.cancelPrioritized(id)
});
queue.attachRuntimeRecovery(requestRuntimeRestart);
await queue.recoverRuntimeInterruptedJobs();
await persistQueueState();
// Write the migrated transcription list back immediately so interrupted-job
// markers and dropped stale entries survive even a crash right after boot.
await persistTranscriptionState();
await estimator.init();

const teamOperationEvents = new TeamOperationEvents();
// The bounded diagnostic journal survives a restart; the SSE snapshot must not
// leave a known failed child looking active forever after that restart.
let teamHistoryCursor = 0;
const teamHistory = [];
for (;;) {
  const records = diagnosticsLog.since(teamHistoryCursor, 500);
  if (!records.length) break;
  teamHistory.push(...records);
  teamHistoryCursor = records[records.length - 1]!.seq;
}
teamOperationEvents.restoreFailures(teamHistory);
const teamEvents = new EventChannel<TeamOperationEvent>(allowedOrigins, () =>
  teamOperationEvents.snapshot()
);
teamEvents.publishOn(channelHub, 'team');
teamOperationEvents.setNotify(event => teamEvents.broadcast(event));
const teamTransfer = new TeamTransferClient();
/*
 * Every variation of a catalog restitch is its own operation over the same video. The source
 * is kept here by Drive's MD5 so variations after the first read it from disk (re-verified)
 * instead of downloading it again.
 */
const teamSourceCache = new TeamSourceCache();
/*
 * 015 — the delegate a re-stitched download runs.
 *
 * Kept beside the others rather than inside `createTeamProcessDelegates`, because it needs
 * two things the process pipelines do not: the compressor's image library read live (the
 * space stores ids, not pictures) and a way to hand back what it had to discover, so the
 * caller can store it and nobody pays for the same inspection twice.
 */
/* 030 — the space's own pictures, drawn by the server from its Drive pools, live in a cache
   of their own beside the library, never in it. */
const teamScreenCache = new TeamScreenCache({
  transfer: teamTransfer,
  // The server is built further down; the cache only speaks after a delivery, long after.
  log: message => {
    try {
      app.log.info(message);
    } catch {
      /* before the server exists there is nobody to tell */
    }
  }
});
const restitchDelegate = createRestitchDelegate({
  embedding: () => queue.state().settings.imageEmbedding,
  imagePathFor: screenImagePath,
  screenCache: teamScreenCache,
  threads: () => activeThreadBudget()
});
const teamDelegates = {
  ...createTeamProcessDelegates({
    compressor: queue,
    transcription: transcriptionQueue,
    landing: landingOptimizer
  }),
  restitch: restitchDelegate
};
const teamProcessBridge = new TeamProcessBridge({
  transfer: teamTransfer,
  delegates: teamDelegates,
  events: teamOperationEvents
});
const catalogRuntimeBootId = randomUUID();
const protectedCatalogVariantProcess: NonNullable<
  Parameters<typeof runCatalogVariantRecovery>[0]['protectedProcess']
> = async (
  request,
  enroll,
  upstreamSignal,
  authorizeParent,
  complete,
  cancellationRequested,
  ended
) => {
  if (isRecord(request.options) && typeof request.options.restitchSelectionRootId !== 'string') {
    const authorizedFetch: typeof fetch = async (input, init) => {
      await authorizeParent();
      upstreamSignal.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !== config.backendOrigin &&
        !(
          url.protocol === 'https:' &&
          ['www.googleapis.com', 'content.googleapis.com'].includes(url.hostname) &&
          !url.port &&
          !url.username &&
          !url.password &&
          !url.hash &&
          init?.method === 'PUT'
        )
      )
        throw new Error('PERMISSION_DENIED');
      return fetch(input, {
        ...init,
        redirect: init?.redirect === 'manual' ? 'manual' : 'error',
        signal: AbortSignal.any([upstreamSignal, ...(init?.signal ? [init.signal] : [])])
      });
    };
    return settleCatalogVariantProcess({
      operationId: request.operationId,
      signal: upstreamSignal,
      complete,
      cancellationRequested,
      ended,
      run: () =>
        teamProcessBridge.processProtected(request, {
          transfer: new TeamTransferClient({
            fetchImpl: authorizedFetch,
            sourceCache: teamSourceCache
          }),
          delegate: restitchDelegate,
          signal: upstreamSignal,
          authorize: authorizeParent
        })
    });
  }
  const controller = nativeRestitchController;
  if (!controller || !isRecord(request.options) || typeof request.options.teamId !== 'string')
    throw new Error('AGENT_UPDATE_REQUIRED');
  upstreamSignal.throwIfAborted();
  const enrollment = await controller.prepare(
    { rootOperationId: request.operationId, teamId: request.options.teamId },
    'process'
  );
  await enroll(enrollment);
  await controller.redeem(enrollment.enrollmentId);
  const abort = () =>
    controller.cancelOperation(
      request.operationId,
      upstreamSignal.reason instanceof Error &&
        ['PROCESS_RESULT_UNCERTAIN', 'PERMISSION_DENIED'].includes(upstreamSignal.reason.message)
        ? (upstreamSignal.reason.message as 'PROCESS_RESULT_UNCERTAIN' | 'PERMISSION_DENIED')
        : 'PROCESS_CANCELED'
    );
  upstreamSignal.addEventListener('abort', abort, { once: true });
  try {
    upstreamSignal.throwIfAborted();
    return await controller.process(
      enrollment.enrollmentId,
      request.operationId,
      async ({ provider, context, sourceFetch, authorize, signal }) => {
        const protectedFetch: typeof fetch = async (input, init) => {
          await authorizeParent();
          await authorize();
          signal.throwIfAborted();
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.href === request.transferUrl) return sourceFetch(input, init);
          if (
            url.origin !== config.backendOrigin &&
            !(
              url.protocol === 'https:' &&
              ['www.googleapis.com', 'content.googleapis.com'].includes(url.hostname) &&
              !url.port &&
              !url.username &&
              !url.password &&
              !url.hash &&
              init?.method === 'PUT'
            )
          )
            throw new Error('PERMISSION_DENIED');
          return fetch(input, {
            ...init,
            redirect: init?.redirect === 'manual' ? 'manual' : 'error',
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
          });
        };
        const delegate = createRestitchDelegate({
          embedding: () => queue.state().settings.imageEmbedding,
          imagePathFor: screenImagePath,
          screenCache: teamScreenCache,
          threads: () => activeThreadBudget(),
          screenRecovery: async input => {
            if (
              input.sourceChecksum?.toLowerCase() !== context.source.checksum ||
              input.sourceSizeBytes !== context.source.sizeBytes
            )
              throw new ScreenCacheError('SOURCE_CHANGED');
            return provider;
          }
        });
        return settleCatalogVariantProcess({
          operationId: request.operationId,
          signal,
          complete,
          cancellationRequested,
          ended,
          run: () =>
            teamProcessBridge.processProtected(request, {
              transfer: new TeamTransferClient({
                fetchImpl: protectedFetch,
                sourceCache: teamSourceCache
              }),
              delegate,
              signal,
              authorize
            })
        });
      }
    );
  } finally {
    upstreamSignal.removeEventListener('abort', abort);
  }
};
const teamRecoveryWorker = new TeamRecoveryWorker({
  screenRefusals: teamId => teamScreenCache.refusalHistory(teamId),
  environment: config.environment,
  currentActorId: () => entitlementGate.currentActorId(),
  journal: new RecoveryJournal(path.join(applicationSupportRoot(), 'Recovery', config.environment)),
  process: teamProcessBridge,
  allowed: () => entitlementGate.status().entitled,
  catalogVariants: hasCapability('team-background-recovery-actor-bound')
    ? {
        nativeInstanceId: catalogRuntimeBootId,
        enabled: () => Boolean(nativeRestitchController),
        protectedProcess: protectedCatalogVariantProcess
      }
    : undefined,
  record: (code, props) => diagnosticsLog.record('team', code, props)
});
entitlementGate.onBeforeActorChange(actorId => teamRecoveryWorker.prepareActorChange(actorId));
const teamPosterBridge = new TeamPosterBridge({ transfer: teamTransfer });
const creativeLibraryProcessBridge = new CreativeLibraryProcessBridge({
  process: teamProcessBridge
});
const teamDownloadBridge = new TeamDownloadBridge({
  transfer: teamTransfer,
  delegates: teamDelegates,
  events: teamOperationEvents
});
/**
 * Looking at a space's materials ahead of time, so a download does not have to.
 *
 * Shares the transfer client with every other bridge and publishes the same coarse progress;
 * what it finds is read back over its own route, because the event channel carries no content.
 */
const teamRestitchPrepareBridge = new RestitchPrepareBridge({
  transfer: teamTransfer,
  events: teamOperationEvents
});
const nativeRestitchController = hasCapability('team-background-recovery-actor-bound')
  ? new NativeRestitchController({
      endpoint: `${config.backendOrigin}/functions/v1/drive-ops`,
      environment: config.environment,
      nativeInstanceId: catalogRuntimeBootId,
      currentActorId: () => entitlementGate.currentActorId(),
      journal: new NativeRestitchJournal(
        path.join(applicationSupportRoot(), 'NativeRestitch', config.environment)
      ),
      cache: teamScreenCache,
      run: async ({
        request,
        provider,
        context,
        sourceFetch,
        authorize,
        reportFailureStage,
        signal
      }) => {
        const delegate = createRestitchDelegate({
          embedding: () => queue.state().settings.imageEmbedding,
          imagePathFor: screenImagePath,
          screenCache: teamScreenCache,
          threads: () => activeThreadBudget(),
          screenRecovery: async input => {
            if (
              input.sourceChecksum?.toLowerCase() !== context.source.checksum ||
              input.sourceSizeBytes !== context.source.sizeBytes
            )
              throw new ScreenCacheError('SOURCE_CHANGED');
            return provider;
          }
        });
        const bridge = new TeamDownloadBridge({
          transfer: new TeamTransferClient({ fetchImpl: sourceFetch }),
          delegates: { restitch: delegate },
          events: teamOperationEvents,
          beforeSave: authorize,
          onFailureStage: reportFailureStage
        });
        const abort = () => bridge.cancel(request.operationId);
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (signal.aborted) throw new Error('PROCESS_CANCELED');
          return await bridge.download({
            ...request,
            compress: null,
            process: {
              tool: 'restitch',
              defaults: context.defaults,
              prepared: null,
              screens: null,
              teamId: context.teamId,
              suffix: request.process?.tool === 'restitch' ? request.process.suffix : undefined
            }
          });
        } finally {
          signal.removeEventListener('abort', abort);
          await bridge.shutdown();
        }
      }
    })
  : undefined;
if (nativeRestitchController)
  entitlementGate.onBeforeActorChange(actor => nativeRestitchController.prepareActorChange(actor));
const catalogForeground = hasCapability('catalog-video-foreground-v1')
  ? new CatalogVideoForegroundController({
      nativeInstanceId: catalogRuntimeBootId,
      currentActorId: () => entitlementGate.currentActorId(),
      allowed: () => entitlementGate.status().entitled,
      vault: new NativeRestitchVaultFile(
        path.join(
          applicationSupportRoot(),
          'NativeRestitch',
          config.environment,
          'catalog-foreground.vault'
        ),
        CATALOG_FOREGROUND_VAULT_ACCOUNT
      ),
      redeem: body => callCatalogForeground('redeem', body),
      awaitBinding: (body, signal) => callCatalogForeground('await', body, undefined, signal),
      reconcileCanceled: async (setId, ticket, enrollmentId, oldExecutionBoot) => {
        if (!nativeRestitchController) return false;
        const call = (action: string, body: Record<string, unknown>) =>
          callCatalogForeground(
            action,
            {
              ...body,
              protocolVersion: 1,
              variantProtocolVersion: 1,
              setId,
              enrollmentId,
              nativeInstanceId: oldExecutionBoot
            },
            ticket
          );
        const snapshot = await call('load', {});
        if (
          snapshot.setId !== setId ||
          !Array.isArray(snapshot.children) ||
          snapshot.children.length < 1 ||
          snapshot.children.length > 400
        )
          return false;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
        let recovered = 0;
        let allClosed = true;
        for (const [index, child] of snapshot.children.entries()) {
          if (
            !isRecord(child) ||
            child.index !== index ||
            typeof child.requestId !== 'string' ||
            !uuid.test(child.requestId) ||
            !['queued', 'working', 'unknown', 'registered'].includes(String(child.state))
          )
            return false;
          if (child.state === 'queued' || child.state === 'registered') continue;
          if (typeof child.operationId !== 'string' || !uuid.test(child.operationId)) return false;
          const original = { index, requestId: child.requestId, operationId: child.operationId };
          // A probe: a restarted agent asking whether a child was cancelled is not
          // the old run's sign of life (it delayed the silence takeover by 2 min).
          const pulse = await call('heartbeat', { ...original, probe: true });
          if (
            pulse.continue !== false ||
            pulse.registered !== false ||
            pulse.reason !== 'canceled'
          ) {
            allClosed = false;
            continue;
          }
          const observation = {
            operationId: setId,
            childOperationId: child.operationId,
            requestId: child.requestId,
            readyCount: snapshot.children.filter(
              value => isRecord(value) && value.state === 'registered'
            ).length,
            requestedCount: snapshot.children.length
          };
          diagnosticsLog.record('team', 'catalog_variant_stage', {
            ...observation,
            stage: 'reconciling'
          });
          const closed = await nativeRestitchController
            .reconcileCatalogCancellation(child.operationId, async () => {
              const result = await call('complete', {
                ...original,
                outcome: 'canceled',
                failureCode: 'PROCESS_CANCELED'
              });
              return (
                result.operationId === original.operationId &&
                result.kind === 'terminal' &&
                result.state === 'canceled'
              );
            })
            .catch(() => false);
          diagnosticsLog.record('team', 'catalog_variant_stage', {
            ...observation,
            stage: closed ? 'canceled' : 'unknown',
            ...(closed ? {} : { errorCode: 'PROCESS_RESULT_UNCERTAIN' })
          });
          if (closed) recovered++;
          else allClosed = false;
        }
        return recovered > 0 && allClosed;
      },
      run: async (setId, ticket, enrollmentId, signal, executionNativeInstanceId) => {
        const call = (action: string, body: Record<string, unknown>) =>
          callCatalogForeground(
            action.replace(/^variant_/u, ''),
            {
              ...body,
              protocolVersion: 1,
              setId,
              enrollmentId,
              nativeInstanceId: executionNativeInstanceId
            },
            ticket
          );
        await runCatalogVariantRecovery({
          functionsBase: `${config.backendOrigin}/functions/v1`,
          initialSetId: setId,
          nativeInstanceId: executionNativeInstanceId,
          call,
          closureCall: call,
          process: teamProcessBridge,
          protectedProcess: protectedCatalogVariantProcess,
          signal
        });
        const value = await call('load', {});
        if (
          value.setId !== setId ||
          !Array.isArray(value.children) ||
          value.children.length < 1 ||
          value.children.some((child: unknown) => !isRecord(child) || child.state !== 'registered')
        )
          throw new Error('PROCESS_RESULT_UNCERTAIN');
      }
    })
  : undefined;
const callCatalogForeground = (
  action: string,
  body: Record<string, unknown>,
  ticket?: string,
  signal?: AbortSignal
) => callCatalogVideoForegroundHttp(config.backendOrigin, action, body, ticket, signal);

if (catalogForeground) {
  await catalogForeground
    .load()
    .catch(() => diagnosticsLog.record('team', 'recovery_unavailable', {}));
  entitlementGate.onBeforeActorChange(actor => catalogForeground.prepareActorChange(actor));
}
await teamRecoveryWorker
  .load()
  .catch(() => diagnosticsLog.record('team', 'recovery_unavailable', {}));

const teamLandingRenderBridge = new TeamLandingRenderBridge({
  preview: teamPreviewBridge,
  events: teamOperationEvents
});

const modules = createToolModules({
  compressor: { queue, estimator, imageStore, events: agentEvents, tools },
  mediaActions,
  landing: { optimizer: landingOptimizer, events: landingEvents },
  landingPreview: { catalog: landingPreviewCatalog, events: landingPreviewEvents },
  transcription: { queue: transcriptionQueue, events: transcriptionEvents },
  stitcher: {
    queue: stitchQueue,
    events: stitcherEvents,
    tools: () => tools,
    embedding: () => queue.state().settings.imageEmbedding
  },
  teamWorkspace: {
    screenCache: teamScreenCache,
    preview: teamPreviewBridge,
    process: teamProcessBridge,
    recovery: teamRecoveryWorker,
    nativeRestitch: nativeRestitchController,
    catalogForeground,
    poster: teamPosterBridge,
    download: teamDownloadBridge,
    landings: teamLandingRenderBridge,
    library: creativeLibraryProcessBridge,
    restitch: teamRestitchPrepareBridge,
    events: teamEvents
  }
});

/**
 * Stops accepting new work across every tool, then exits only after the
 * canonical module list reports that all current work has settled. This lets a
 * replacement launcher take over without interrupting a user's active task.
 */
function requestUpdateDrain(targetBuildId: string) {
  queue.requestUpdateDrain(targetBuildId);
  if (shuttingDown || updateDrainTimer) return;

  const finishWhenIdle = () => {
    if (shuttingDown) {
      if (updateDrainTimer) clearInterval(updateDrainTimer);
      updateDrainTimer = null;
      return;
    }
    if (modules.some(module => module.busy())) return;
    if (updateDrainTimer) clearInterval(updateDrainTimer);
    updateDrainTimer = null;
    // Preserve the latest queue state before the native host releases its
    // lock. The next Agent can then restore exactly the same durable queue.
    void saveChain.finally(() => shutdown(UPDATE_HANDOFF_EXIT_CODE, 'update'));
  };

  updateDrainTimer = setInterval(finishWhenIdle, 250);
  updateDrainTimer.unref();
  finishWhenIdle();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const app = await buildServer({
  token,
  nativeToken,
  updateHandoffToken,
  requestUpdateDrain,
  allowedOrigins,
  entitlementGate,
  recoveryInstallationId: () => teamRecoveryWorker.installationId,
  config,
  instanceId,
  startedAt,
  tools,
  queue,
  modules,
  power: powerGovernor,
  powerSampler,
  channelHub,
  webRoot: path.resolve(here, '../../web/dist'),
  diagnostics: diagnosticsLog
});
logError = (error, message) => app.log.error(error, message);

if (process.env.PACKAGED_APP === '1') {
  mediaToolsTimer = setInterval(() => void refreshMediaTools(), 10_000);
  mediaToolsTimer.unref();
}
if (config.installedReleasePath) {
  // C21. Unreferenced below: a poller that keeps the event loop alive turns
  // "the agent has nothing left to do" into "the agent never exits", and the
  // symptom is a process the user cannot get rid of.
  installedReleaseTimer = setInterval(() => {
    void readFile(config.installedReleasePath as string, 'utf8')
      .then(raw => JSON.parse(raw) as { buildId?: unknown })
      .then(installed => {
        if (typeof installed.buildId === 'string' && installed.buildId !== config.buildId) {
          requestUpdateDrain(installed.buildId);
        }
      })
      .catch(() => undefined);
  }, 3000);
  installedReleaseTimer.unref();
}

/**
 * How long the server close may take before the process exits regardless.
 *
 * Node's `server.close` waits for every connection to end. The streams are ended first,
 * so ordinarily it returns at once; this is for the connection that does not — a peer
 * that never acknowledges the close, an upload that never finishes. Three seconds is
 * long enough for any reply that was already being written and short enough that the
 * launcher waiting on the exit code is not left guessing.
 */
const CLOSE_DEADLINE_MS = 3000;

async function shutdown(code: number, reason: ShutdownReason) {
  if (shuttingDown) return;
  shuttingDown = true;
  diagnosticsLog.record('shutdown', 'requested', { reason, code });
  if (mediaToolsTimer) clearInterval(mediaToolsTimer);
  if (installedReleaseTimer) clearInterval(installedReleaseTimer);
  if (updateDrainTimer) clearInterval(updateDrainTimer);
  try {
    await shutdownNativePickers();
    await saveChain;
    if (transcriptionPersistTimer) await persistTranscriptionState();
    await transcriptionSaveChain;
    for (const module of modules) await module.shutdown();
    // Resume anything the duty cycler left stopped before the process exits: a
    // suspended child would outlive the agent and never make progress again.
    await powerGovernor.shutdown();
    // The same code whether close returns or not. `unref` so the timer itself never
    // holds a process open that would otherwise have finished.
    setTimeout(() => process.exit(code), CLOSE_DEADLINE_MS).unref();
    // Every open stream is told why and ended *before* close: an open stream is a
    // connection, and close waits for connections. Left open, the process would sit on a
    // port it no longer answers, heartbeating "connected" at an interface showing state
    // that is never going to change, and the launcher would never see the exit code.
    channelHub.closeAll(reason);
    EventChannel.closeAll(reason);
    await app.close();
    diagnosticsLog.record('shutdown', 'completed', { reason, code });
  } catch (error) {
    logError(error, 'Shutdown failed');
    diagnosticsLog.record('shutdown', 'failed', { reason, code });
  }
  // The last thing before exit, so the reason is on disk for the next boot to serve.
  await diagnosticsLog.close();
  process.exit(code);
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Soty Agent: http://${config.host}:${config.port}`);
  diagnosticsLog.record('boot', 'listening');
} catch (error) {
  app.log.error(error);
  // The port is the usual reason, and it is a category, not a secret.
  diagnosticsLog.record('shutdown', 'listen_failed', {
    reason: 'error',
    code: 1,
    cause: errorCodeClass(error)
  });
  await diagnosticsLog.close();
  process.exit(1);
}

/** `EADDRINUSE`, `EACCES` or `other`: a closed vocabulary for the journal, never the message. */
function errorCodeClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EADDRINUSE' || code === 'EACCES') return code.toLowerCase();
  return 'other';
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(0, 'signal');
  });
}
// A rejection nobody caught used to end the process. The queues fire and forget a great
// deal of work by design — a document write, a preview transcode — and
// a full disk in one of them is a reason to log, not to take the running transcription
// and every open connection down with it.
process.on('unhandledRejection', reason => {
  logError(reason, 'Unhandled rejection');
});
if (process.env.PACKAGED_APP === '1') {
  const parentPid = process.ppid;
  const launcherPid = parseLauncherPid(process.env.AGENT_LAUNCHER_PID);
  const watchdog = setInterval(() => {
    if (
      packagedAgentLostLauncher({
        initialParentPid: parentPid,
        currentParentPid: process.ppid,
        launcherPid,
        isAlive: processIsAlive
      })
    ) {
      clearInterval(watchdog);
      void shutdown(0, 'launcher');
    }
  }, 1000);
  watchdog.unref();
}
