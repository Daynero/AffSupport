import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentEventType,
  LandingEvent,
  LandingEventType,
  LandingPreviewEvent,
  TranscriptionEvent,
  TranscriptionEventType
} from '@video-compressor/shared';
import { allowedOrigins, config } from './config.js';
import { EntitlementGate } from './entitlement/entitlement.js';
import { EstimationWorker } from './estimate/worker.js';
import { applicationSupportRoot } from './files/support-dir.js';
import {
  commandExists,
  ffmpegPath,
  ffprobePath,
  MediaToolUnavailableError
} from './ffmpeg/tools.js';
import { ImageAssetStore } from './images/store.js';
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
import { resolveSessionToken } from './server/session-token.js';
import { ChannelHub, EventChannel } from './server/sse.js';
import { createToolModules } from './server/tools.js';
import { TeamPreviewBridge } from './team-bridge/preview.js';
import { TeamOperationEvents, type TeamOperationEvent } from './team-bridge/events.js';
import { TeamDownloadBridge } from './team-bridge/download.js';
import { TeamLandingRenderBridge } from './team-bridge/landing-gallery.js';
import { createTeamProcessDelegates, TeamProcessBridge } from './team-bridge/process.js';
import { CreativeLibraryProcessBridge } from './team-bridge/library.js';
import { TeamTransferClient } from './team-bridge/transfer.js';
import { createAligner } from './translation/aligner.js';
import { createTranslator } from './translation/translator.js';
import { whisperAvailable } from './whisper/tools.js';
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
const instanceId = randomBytes(12).toString('hex');
const startedAt = new Date().toISOString();
const tools = {
  ffmpeg: await commandExists(ffmpegPath),
  ffprobe: await commandExists(ffprobePath)
};
// The whisper binary is static, so it is probed once at boot; ffmpeg is
// re-checked live and the model presence is computed on demand by the queue.
const transcriptionTools = {
  ffmpeg: tools.ffmpeg,
  whisper: await whisperAvailable()
};
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
const restoredTranscription = await loadTranscriptionState();
const transcriptionQueue = new TranscriptionQueue(
  transcriptionTools,
  (type: TranscriptionEventType = 'transcription:state') => {
    transcriptionEvents.broadcast({ type, state: transcriptionQueue.state() });
    // Progress ticks arrive many times a second and change nothing the
    // persisted list needs (job membership, statuses, settings) — skip them.
    if (type !== 'transcription:progress') void persistTranscriptionState();
  },
  restoredTranscription.jobs,
  restoredTranscription.settings
);
transcriptionEvents.publishOn(channelHub, 'transcription');
transcriptionQueue.setTranslator(createTranslator());
transcriptionQueue.setAligner(createAligner());

const agentEvents = new EventChannel<AgentEvent>(allowedOrigins, () => ({
  type: 'state',
  state: queue.state()
}));
agentEvents.publishOn(channelHub, 'compressor');

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
  transcriptionSaveChain = transcriptionSaveChain
    .then(() => saveTranscriptionState(transcriptionQueue.persisted()))
    .catch(error => logError(error, 'Could not save transcription state'));
  return transcriptionSaveChain;
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
    void saveChain.finally(() => shutdown(75));
  }, 250);
  timer.unref();
}

async function refreshMediaTools() {
  if (mediaToolsCheckInFlight || shuttingDown) return;
  mediaToolsCheckInFlight = true;
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      commandExists(ffmpegPath),
      commandExists(ffprobePath)
    ]);
    queue.setToolAvailability({ ffmpeg, ffprobe });
    transcriptionQueue.setToolAvailability({
      ffmpeg,
      whisper: transcriptionTools.whisper
    });
    if ((!ffmpeg || !ffprobe) && !queue.workActive() && !mediaActions.workActive()) {
      requestRuntimeRestart(
        new MediaToolUnavailableError(ffmpeg ? 'ffprobe' : 'ffmpeg', 'HEALTH_CHECK')
      );
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
// The governor is what notices the machine slept; the queue is what knows whether the
// encode it had running is still there (FR-009a).
// It broadcasts on its own when it finds something to interrupt.
powerGovernor.setWakeListener(() => queue.handleWake());
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
const teamEvents = new EventChannel<TeamOperationEvent>(allowedOrigins, () =>
  teamOperationEvents.snapshot()
);
teamEvents.publishOn(channelHub, 'team');
teamOperationEvents.setNotify(event => teamEvents.broadcast(event));
const teamTransfer = new TeamTransferClient();
const teamDelegates = createTeamProcessDelegates({
  compressor: queue,
  transcription: transcriptionQueue,
  landing: landingOptimizer
});
const teamProcessBridge = new TeamProcessBridge({
  transfer: teamTransfer,
  delegates: teamDelegates,
  events: teamOperationEvents
});
const creativeLibraryProcessBridge = new CreativeLibraryProcessBridge({
  process: teamProcessBridge
});
const teamDownloadBridge = new TeamDownloadBridge({ transfer: teamTransfer, delegates: teamDelegates });
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
  teamWorkspace: {
    preview: teamPreviewBridge,
    process: teamProcessBridge,
    download: teamDownloadBridge,
    landings: teamLandingRenderBridge,
    library: creativeLibraryProcessBridge,
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
    void saveChain.finally(() => shutdown(UPDATE_HANDOFF_EXIT_CODE));
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
  config,
  instanceId,
  startedAt,
  tools,
  queue,
  modules,
  power: powerGovernor,
  powerSampler,
  channelHub,
  webRoot: path.resolve(here, '../../web/dist')
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

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (mediaToolsTimer) clearInterval(mediaToolsTimer);
  if (installedReleaseTimer) clearInterval(installedReleaseTimer);
  if (updateDrainTimer) clearInterval(updateDrainTimer);
  try {
    await saveChain;
    await transcriptionSaveChain;
    for (const module of modules) await module.shutdown();
    // Resume anything the duty cycler left stopped before the process exits: a
    // suspended child would outlive the agent and never make progress again.
    await powerGovernor.shutdown();
    await app.close();
  } catch (error) {
    logError(error, 'Shutdown failed');
  }
  process.exit(code);
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Soty Agent: http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(0);
  });
}
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
      void shutdown(0);
    }
  }, 1000);
  watchdog.unref();
}
