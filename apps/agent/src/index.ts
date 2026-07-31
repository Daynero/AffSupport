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
import { buildServer } from './server/app.js';
import { EventChannel } from './server/sse.js';
import { createToolModules } from './server/tools.js';
import { createAligner } from './translation/aligner.js';
import { createTranslator } from './translation/translator.js';
import { whisperAvailable } from './whisper/tools.js';

const token = randomBytes(32).toString('hex');
const nativeToken = process.env.AGENT_NATIVE_TOKEN?.trim() || null;
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
const mediaActions = new MediaActionQueue();
let saveChain = Promise.resolve();
let shuttingDown = false;
let runtimeRestartRequested = false;
let mediaToolsCheckInFlight = false;
let mediaToolsTimer: ReturnType<typeof setInterval> | null = null;
let installedReleaseTimer: ReturnType<typeof setInterval> | null = null;

const landingEvents = new EventChannel<LandingEvent>(allowedOrigins, () => ({
  type: 'landing:state',
  state: landingOptimizer.state()
}));
const landingOptimizer = new LandingOptimizer(tools, (type: LandingEventType = 'landing:state') =>
  landingEvents.broadcast({ type, state: landingOptimizer.state() })
);

const landingPreviewCatalog = new LandingPreviewCatalog();
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
transcriptionQueue.setTranslator(createTranslator());
transcriptionQueue.setAligner(createAligner());

const agentEvents = new EventChannel<AgentEvent>(allowedOrigins, () => ({
  type: 'state',
  state: queue.state()
}));

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
const queue = new JobQueue(
  tools,
  broadcast,
  restored.jobs,
  restored.settings,
  restored.batch,
  imageStore
);
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

const modules = createToolModules({
  compressor: { queue, estimator, imageStore, events: agentEvents, tools },
  mediaActions,
  landing: { optimizer: landingOptimizer, events: landingEvents },
  landingPreview: { catalog: landingPreviewCatalog, events: landingPreviewEvents },
  transcription: { queue: transcriptionQueue, events: transcriptionEvents }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const app = await buildServer({
  token,
  nativeToken,
  allowedOrigins,
  entitlementGate,
  config,
  instanceId,
  startedAt,
  tools,
  queue,
  modules,
  webRoot: path.resolve(here, '../../web/dist')
});
logError = (error, message) => app.log.error(error, message);

if (process.env.PACKAGED_APP === '1') {
  mediaToolsTimer = setInterval(() => void refreshMediaTools(), 10_000);
  mediaToolsTimer.unref();
}
if (config.installedReleasePath) {
  installedReleaseTimer = setInterval(() => {
    void readFile(config.installedReleasePath as string, 'utf8')
      .then(raw => JSON.parse(raw) as { buildId?: unknown })
      .then(installed => {
        if (typeof installed.buildId === 'string' && installed.buildId !== config.buildId) {
          queue.requestUpdateDrain(installed.buildId);
        }
      })
      .catch(() => undefined);
  }, 3000);
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (mediaToolsTimer) clearInterval(mediaToolsTimer);
  if (installedReleaseTimer) clearInterval(installedReleaseTimer);
  try {
    await saveChain;
    await transcriptionSaveChain;
    for (const module of modules) await module.shutdown();
    await app.close();
  } catch (error) {
    logError(error, 'Shutdown failed');
  }
  process.exit(code);
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Wishly Agent: http://${config.host}:${config.port}`);
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
  const watchdog = setInterval(() => {
    if (process.ppid !== parentPid) {
      clearInterval(watchdog);
      void shutdown(0);
    }
  }, 1000);
  watchdog.unref();
}
