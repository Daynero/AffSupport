import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import open from 'open';
import {
  AGENT_TOOL_CONTRACTS,
  CORE_CONTRACT_VERSION,
  AGENT_API_VERSION,
  AGENT_CAPABILITIES,
  CRF_MAX,
  CRF_MIN,
  FRAME_RATE_MAX,
  FRAME_RATE_MIN,
  MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  VIDEO_BITRATE_MAX_KBPS,
  VIDEO_BITRATE_MIN_KBPS,
  type AgentEvent,
  type AgentEventType,
  type AgentSettings,
  type AgentSettingsPatch,
  type ImageAsset,
  type ImageSlot,
  type LandingEvent,
  type LandingEventType
} from '@video-compressor/shared';
import { EstimationWorker } from './estimate/worker.js';
import { selectOutputFolder, selectVideos } from './files/picker.js';
import { applicationSupportRoot } from './files/support-dir.js';
import { findDroppedSource } from './files/dropped-source.js';
import {
  commandExists,
  ffmpegPath,
  ffprobePath,
  MediaToolUnavailableError
} from './ffmpeg/tools.js';
import { allowedOrigins, config } from './config.js';
import { eventStreamHeaders } from './http.js';
import { isSupportedVideoPath, JobQueue } from './queue/queue.js';
import { loadState, saveState } from './queue/store.js';
import { ImageAssetError, ImageAssetStore, MAX_IMAGE_BYTES } from './images/store.js';
import { LandingOptimizer } from './landing/optimizer.js';
import { registerLandingRoutes } from './landing/routes.js';

const token = randomBytes(32).toString('hex');
const instanceId = randomBytes(12).toString('hex');
const startedAt = new Date().toISOString();
const app = Fastify({ logger: true, bodyLimit: 16_384 });
const tools = {
  ffmpeg: await commandExists(ffmpegPath),
  ffprobe: await commandExists(ffprobePath)
};
const clients = new Set<NodeJS.WritableStream>();
const landingClients = new Set<NodeJS.WritableStream>();
const imageStore = new ImageAssetStore();
const pendingSelections = new Map<string, string>();
let saveChain = Promise.resolve();
let shuttingDown = false;
let runtimeRestartRequested = false;
let mediaToolsCheckInFlight = false;
let mediaToolsTimer: ReturnType<typeof setInterval> | null = null;
let installedReleaseTimer: ReturnType<typeof setInterval> | null = null;

const landingOptimizer = new LandingOptimizer(tools, (type: LandingEventType = 'landing:state') => {
  const event: LandingEvent = { type, state: landingOptimizer.state() };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of landingClients) client.write(payload);
});

function broadcast(type: AgentEventType = 'state') {
  const event: AgentEvent = { type, state: queue.state() };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
  void persistQueueState();
}

function persistQueueState() {
  saveChain = saveChain
    .then(() => saveState(queue.persisted()))
    .catch(error => app.log.error(error, 'Could not save local state'));
  return saveChain;
}

function requestRuntimeRestart(error: MediaToolUnavailableError) {
  app.log.error(
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
    if ((!ffmpeg || !ffprobe) && !queue.workActive()) {
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
await estimator.init();

await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'x-session-token']
});
await app.register(fastifyMultipart, {
  limits: { files: 1, fields: 4, fileSize: 100 * 1024 * 1024 * 1024 }
});

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (request.url.startsWith('/api/') && origin && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: 'Origin is not allowed.' });
  }
});
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url === '/health' || request.url === '/api/health') {
    reply.header('Cache-Control', 'no-store');
  }
  if (
    request.headers['access-control-request-private-network'] === 'true' &&
    request.headers.origin &&
    allowedOrigins.has(request.headers.origin)
  ) {
    reply.header('Access-Control-Allow-Private-Network', 'true');
  }
  return payload;
});
app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const supplied =
    request.headers['x-session-token'] ?? (request.query as { token?: string }).token;
  if (supplied !== token) return reply.code(401).send({ error: 'Invalid session token.' });
});

app.get('/api/health', async () => ({
  ok: tools.ffmpeg && tools.ffprobe,
  tools,
  version: config.version,
  buildNumber: config.buildNumber,
  buildId: config.buildId,
  apiVersion: AGENT_API_VERSION,
  channel: config.channel,
  sourceRevision: config.sourceRevision,
  capabilities: [...AGENT_CAPABILITIES],
  coreContractVersion: CORE_CONTRACT_VERSION,
  toolContracts: { ...AGENT_TOOL_CONTRACTS },
  update: queue.state().update
}));
app.get('/health', async () => ({
  product: 'local-video-compressor-agent',
  ready: tools.ffmpeg && tools.ffprobe,
  version: config.version,
  buildNumber: config.buildNumber,
  buildId: config.buildId,
  apiVersion: AGENT_API_VERSION,
  channel: config.channel,
  sourceRevision: config.sourceRevision,
  capabilities: [...AGENT_CAPABILITIES],
  coreContractVersion: CORE_CONTRACT_VERSION,
  toolContracts: { ...AGENT_TOOL_CONTRACTS },
  update: queue.state().update,
  instanceId,
  startedAt,
  busy: queue.workActive() || landingOptimizer.state().running
}));
app.get('/api/diagnostics', async () => ({
  version: config.version,
  buildNumber: config.buildNumber,
  buildId: config.buildId,
  apiVersion: AGENT_API_VERSION,
  channel: config.channel,
  sourceRevision: config.sourceRevision,
  instanceId,
  startedAt,
  system: `${os.platform()} ${os.release()}`,
  architecture: os.arch(),
  ffmpeg: tools.ffmpeg && tools.ffprobe ? 'ready' : 'unavailable',
  lastError: queue.state().warning ?? null
}));
app.get('/api/queue', async () => queue.state());
app.get('/api/events', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, allowedOrigins));
  clients.add(reply.raw);
  reply.raw.write(`data: ${JSON.stringify({ type: 'state', state: queue.state() })}\n\n`);
  request.raw.on('close', () => clients.delete(reply.raw));
});

app.post('/api/files/select', async (_request, reply) => {
  if (process.platform !== 'darwin') {
    return reply.code(501).send({ error: 'The native file picker is unavailable on this system.' });
  }
  const paths = await selectVideos();
  const warnings = await queue.add(paths);
  for (const warning of warnings) {
    const selected = paths.find(value => path.basename(value) === warning.fileName);
    if (selected && warning.reason !== 'unsupported-format' && warning.reason !== 'inaccessible') {
      pendingSelections.set(warning.id, selected);
    }
  }
  return { state: queue.state(), warnings };
});

// Finder drops can include a file:// URL. Retain that source path rather than
// importing a copy, so "next to originals" really means next to the original.
app.post<{ Body: { paths?: unknown } }>('/api/files/add', async (request, reply) => {
  const paths = request.body?.paths;
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string')) {
    return reply.code(400).send({ error: 'Invalid file paths.' });
  }
  const localPaths = paths
    .filter(value => path.isAbsolute(value))
    .map(value => path.resolve(value));
  if (!localPaths.length)
    return reply.code(400).send({ error: 'No local file paths were provided.' });
  const warnings = await queue.add(localPaths);
  return { state: queue.state(), warnings };
});

app.post('/api/files/upload', async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: 'No file was provided.' });
  const fileName = path.basename(part.filename || 'video');
  const signatureField = part.fields.signature;
  const signature =
    signatureField && 'value' in signatureField && typeof signatureField.value === 'string'
      ? signatureField.value
      : `${fileName}:${Date.now()}`;
  const sizeField = part.fields.size;
  const modifiedField = part.fields.lastModified;
  const sourceSize = Number(
    sizeField && 'value' in sizeField && typeof sizeField.value === 'string'
      ? sizeField.value
      : Number.NaN
  );
  const sourceModifiedAt = Number(
    modifiedField && 'value' in modifiedField && typeof modifiedField.value === 'string'
      ? modifiedField.value
      : Number.NaN
  );
  if (!isSupportedVideoPath(fileName)) {
    part.file.resume();
    return {
      state: queue.state(),
      warnings: [
        {
          id: randomBytes(16).toString('hex'),
          fileName,
          reason: 'unsupported-format',
          message: 'This file format is not supported.'
        }
      ]
    };
  }

  const droppedSource = await findDroppedSource(fileName, sourceSize, sourceModifiedAt);
  if (droppedSource) {
    part.file.resume();
    const warnings = await queue.add([droppedSource]);
    return { state: queue.state(), warnings };
  }

  const importRoot =
    process.env.AGENT_IMPORT_PATH ?? path.join(applicationSupportRoot(), 'Imports');
  await mkdir(importRoot, { recursive: true });
  const directory = await mkdtemp(path.join(importRoot, 'import-'));
  const inputPath = path.join(directory, fileName);
  try {
    await pipeline(part.file, createWriteStream(inputPath, { flags: 'wx' }));
    if (part.file.truncated) throw new Error('The file is too large.');
    const warnings = await queue.addUploaded(inputPath, fileName, signature);
    if (warnings.length) await rm(directory, { recursive: true, force: true });
    return { state: queue.state(), warnings };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    return reply.code(400).send({
      error: error instanceof Error ? error.message : 'The file could not be imported.'
    });
  }
});

app.post<{ Params: { slot: string } }>('/api/images/:slot', async (request, reply) => {
  const slot = imageSlot(request.params.slot);
  if (!slot) return reply.code(400).send({ error: 'IMAGE_SLOT_INVALID' });
  const part = await request.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
  if (!part) return reply.code(400).send({ error: 'IMAGE_MISSING' });
  const previous =
    slot === 'start'
      ? queue.state().settings.imageEmbedding.startImage
      : queue.state().settings.imageEmbedding.endImage;
  let asset: ImageAsset | null = null;
  try {
    asset = await imageStore.import(
      part.file,
      part.filename || 'image',
      part.mimetype || 'application/octet-stream'
    );
    await queue.setImage(slot, asset);
    await queue.releaseImageIfUnused(previous);
    return queue.state();
  } catch (error) {
    if (asset) await queue.releaseImageIfUnused(asset);
    const code = error instanceof ImageAssetError ? error.code : 'IMAGE_IMPORT_FAILED';
    return reply.code(code === 'IMAGE_TOO_LARGE' ? 413 : 400).send({ error: code });
  }
});

app.delete<{ Params: { slot: string } }>('/api/images/:slot', async (request, reply) => {
  const slot = imageSlot(request.params.slot);
  if (!slot) return reply.code(400).send({ error: 'IMAGE_SLOT_INVALID' });
  const previous =
    slot === 'start'
      ? queue.state().settings.imageEmbedding.startImage
      : queue.state().settings.imageEmbedding.endImage;
  await queue.setImage(slot, null);
  await queue.releaseImageIfUnused(previous);
  return queue.state();
});

app.get<{ Params: { id: string } }>('/api/images/:id/content', async (request, reply) => {
  const asset = queue.imageAsset(request.params.id);
  if (!asset) return reply.code(404).send({ error: 'IMAGE_UNAVAILABLE' });
  try {
    const filePath = await imageStore.validate(asset);
    return reply
      .header('Cache-Control', 'private, no-store')
      .type(asset.mimeType)
      .send(createReadStream(filePath));
  } catch {
    return reply.code(404).send({ error: 'IMAGE_UNAVAILABLE' });
  }
});

app.post<{ Body: { ids?: unknown } }>('/api/files/confirm', async (request, reply) => {
  if (
    !request.body ||
    !Array.isArray(request.body.ids) ||
    !request.body.ids.every(id => typeof id === 'string')
  ) {
    return reply.code(400).send({ error: 'Invalid confirmation.' });
  }
  const paths = request.body.ids
    .map(id => pendingSelections.get(id))
    .filter((value): value is string => Boolean(value));
  request.body.ids.forEach(id => pendingSelections.delete(id));
  await queue.add(paths, true);
  return queue.state();
});

app.post('/api/output/select', async () => {
  const folder = await selectOutputFolder();
  if (folder) {
    await queue.updateSettings({ outputMode: 'chosen-folder', outputFolder: folder });
  }
  return queue.state();
});

app.post<{ Body: AgentSettingsPatch }>('/api/settings', async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'Invalid settings.' });
  }
  const allowed: Partial<AgentSettings> = {};
  if (body.mode !== undefined) {
    if (!['optimal', 'custom'].includes(body.mode)) {
      return reply.code(400).send({ error: 'Invalid compression mode.' });
    }
    allowed.mode = body.mode;
  }
  if (body.outputMode !== undefined) {
    if (!['next-to-originals', 'chosen-folder'].includes(body.outputMode)) {
      return reply.code(400).send({ error: 'Invalid output mode.' });
    }
    allowed.outputMode = body.outputMode;
  }
  if (body.stripMetadata !== undefined) {
    if (typeof body.stripMetadata !== 'boolean') {
      return reply.code(400).send({ error: 'Invalid metadata setting.' });
    }
    allowed.stripMetadata = body.stripMetadata;
  }
  if (body.frameRate !== undefined) {
    if (body.frameRate === null) allowed.frameRate = null;
    else {
      const value = Number(body.frameRate);
      if (!Number.isInteger(value) || value < FRAME_RATE_MIN || value > FRAME_RATE_MAX) {
        return reply.code(400).send({ error: 'Invalid frame rate.' });
      }
      allowed.frameRate = value;
    }
  }
  if (body.resolutionLimit !== undefined) {
    if (body.resolutionLimit === null) allowed.resolutionLimit = null;
    else {
      const value = Number(body.resolutionLimit);
      if (!Number.isInteger(value) || value < RESOLUTION_MIN || value > RESOLUTION_MAX) {
        return reply.code(400).send({ error: 'Invalid resolution.' });
      }
      allowed.resolutionLimit = value;
    }
  }
  if (body.rateControl !== undefined) {
    if (!['crf', 'bitrate'].includes(body.rateControl)) {
      return reply.code(400).send({ error: 'Invalid rate control.' });
    }
    allowed.rateControl = body.rateControl;
  }
  if (body.crf !== undefined) {
    const value = Number(body.crf);
    if (!Number.isInteger(value) || value < CRF_MIN || value > CRF_MAX) {
      return reply.code(400).send({ error: 'Invalid quality.' });
    }
    allowed.crf = value;
  }
  if (body.videoBitrateKbps !== undefined) {
    const value = Number(body.videoBitrateKbps);
    if (
      !Number.isInteger(value) ||
      value < VIDEO_BITRATE_MIN_KBPS ||
      value > VIDEO_BITRATE_MAX_KBPS
    ) {
      return reply.code(400).send({ error: 'Invalid bitrate.' });
    }
    allowed.videoBitrateKbps = value;
  }
  if (body.imageEmbedding !== undefined) {
    if (!body.imageEmbedding || typeof body.imageEmbedding !== 'object') {
      return reply.code(400).send({ error: 'Invalid image embedding settings.' });
    }
    if ('startImage' in body.imageEmbedding || 'endImage' in body.imageEmbedding) {
      return reply
        .code(400)
        .send({ error: 'Image assets must be selected through the image API.' });
    }
    const imageEmbedding = { ...queue.state().settings.imageEmbedding };
    if (body.imageEmbedding.enabled !== undefined) {
      if (typeof body.imageEmbedding.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'Invalid image embedding mode.' });
      }
      imageEmbedding.enabled = body.imageEmbedding.enabled;
    }
    if (body.imageEmbedding.finalDurationMode !== undefined) {
      if (
        !['random-30-40', 'random-40-50', 'random-50-60', 'custom'].includes(
          body.imageEmbedding.finalDurationMode
        )
      ) {
        return reply.code(400).send({ error: 'Invalid final image duration mode.' });
      }
      imageEmbedding.finalDurationMode = body.imageEmbedding.finalDurationMode;
    }
    if (body.imageEmbedding.customFinalDurationSeconds !== undefined) {
      const value = Number(body.imageEmbedding.customFinalDurationSeconds);
      if (
        !Number.isInteger(value) ||
        value < MIN_CUSTOM_FINAL_IMAGE_DURATION_SECONDS ||
        value > MAX_CUSTOM_FINAL_IMAGE_DURATION_SECONDS
      ) {
        return reply.code(400).send({ error: 'INVALID_CUSTOM_IMAGE_DURATION' });
      }
      imageEmbedding.customFinalDurationSeconds = value;
    }
    if (body.imageEmbedding.fitMode !== undefined) {
      if (!['cover', 'contain', 'stretch'].includes(body.imageEmbedding.fitMode)) {
        return reply.code(400).send({ error: 'Invalid image fit mode.' });
      }
      imageEmbedding.fitMode = body.imageEmbedding.fitMode;
    }
    allowed.imageEmbedding = imageEmbedding;
  }
  await queue.updateSettings(allowed);
  return queue.state();
});

app.post<{ Body: { ids?: unknown } }>('/api/queue/start', async (request, reply) => {
  if (!queue.acceptingNewTasks()) {
    return reply.code(409).send({ error: 'UPDATE_PENDING' });
  }
  if (!tools.ffmpeg) {
    return reply.code(503).send({ error: 'The bundled video engine is unavailable.' });
  }
  if (
    !request.body ||
    !Array.isArray(request.body.ids) ||
    !request.body.ids.every(id => typeof id === 'string')
  ) {
    return reply.code(400).send({ error: 'Choose one or more ready videos.' });
  }
  const invalidImageWasCleared = await queue.revalidateSettingsImages();
  if (invalidImageWasCleared) return reply.code(400).send({ error: 'IMAGE_UNAVAILABLE' });
  const embeddingError = queue.embeddingConfigurationError();
  if (embeddingError) return reply.code(400).send({ error: embeddingError });
  await estimator.pause();
  const started = await queue.start(request.body.ids);
  if (!started) {
    estimator.resume();
    return reply.code(409).send({ error: 'No selected videos are ready to start.' });
  }
  return queue.state();
});

app.post<{ Params: { id: string } }>('/api/jobs/:id/estimate-priority', async (request, reply) =>
  queue.prioritizeEstimate(request.params.id)
    ? queue.state()
    : reply.code(409).send({ error: 'This estimate cannot be prioritized.' })
);
app.delete<{ Params: { id: string } }>('/api/jobs/:id/estimate-priority', async (request, reply) =>
  queue.cancelPrioritizedEstimate(request.params.id)
    ? queue.state()
    : reply.code(409).send({ error: 'This estimate is not prioritized.' })
);
app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) =>
  (await queue.cancel(request.params.id))
    ? queue.state()
    : reply.code(409).send({ error: 'Only the current job can be cancelled.' })
);
app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) =>
  queue.remove(request.params.id)
    ? queue.state()
    : reply.code(409).send({ error: 'An active job cannot be removed.' })
);
app.post<{ Body: { ids?: unknown } }>('/api/jobs/remove', async (request, reply) => {
  if (
    !request.body ||
    !Array.isArray(request.body.ids) ||
    !request.body.ids.every(id => typeof id === 'string')
  ) {
    return reply.code(400).send({ error: 'Invalid selection.' });
  }
  queue.removeMany(request.body.ids);
  return queue.state();
});
app.delete('/api/jobs/completed', async () => {
  queue.clearCompleted();
  return queue.state();
});
app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) =>
  (await queue.retry(request.params.id))
    ? queue.state()
    : reply.code(409).send({ error: 'This job cannot be retried.' })
);
app.post<{ Params: { id: string } }>('/api/jobs/:id/reveal', async (request, reply) => {
  const job = queue
    .state()
    .jobs.find(candidate => candidate.id === request.params.id && candidate.status === 'completed');
  if (!job) return reply.code(404).send({ error: 'Completed file not found.' });
  spawn('/usr/bin/open', ['-R', job.outputPath], {
    shell: false,
    detached: true,
    stdio: 'ignore'
  }).unref();
  return queue.state();
});
app.post<{ Params: { id: string } }>('/api/jobs/:id/open', async (request, reply) => {
  const job = queue
    .state()
    .jobs.find(candidate => candidate.id === request.params.id && candidate.status === 'completed');
  if (!job) return reply.code(404).send({ error: 'Completed file not found.' });
  spawn('/usr/bin/open', [job.outputPath], {
    shell: false,
    detached: true,
    stdio: 'ignore'
  }).unref();
  return queue.state();
});
app.post('/api/output/reveal', async (_request, reply) => {
  const folder = queue.outputFolder();
  if (!folder) return reply.code(404).send({ error: 'No output folder is available yet.' });
  spawn('/usr/bin/open', [folder], { shell: false, detached: true, stdio: 'ignore' }).unref();
  return queue.state();
});

registerLandingRoutes(app, {
  optimizer: landingOptimizer,
  clients: landingClients,
  allowedOrigins,
  acceptingNewTasks: () => queue.acceptingNewTasks()
});

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../web/dist');
await app.register(fastifyStatic, {
  root: webRoot,
  wildcard: false,
  setHeaders: (response, filePath) => {
    response.header(
      'Cache-Control',
      path.basename(filePath) === 'index.html'
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=31536000, immutable'
    );
  }
});
// Without PUBLIC_SITE_ORIGIN a source run must pair against the Vite dev
// site: the bundled web/dist is a production build that refuses dev env.
const pairOrigin =
  config.publicOrigin ??
  (config.sourceRevision === 'development'
    ? config.devOrigin
    : `http://${config.host}:${config.port}`);
let browserClaimedAgent = false;
app.get('/pair', async (_request, reply) => {
  browserClaimedAgent = true;
  return reply.redirect(`${pairOrigin}/#agentToken=${token}`);
});
app.get('/local', async (_request, reply) => {
  browserClaimedAgent = true;
  return reply.redirect(`http://${config.host}:${config.port}/#agentToken=${token}`);
});
app.setNotFoundHandler((request, reply) =>
  request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'API action not found.' })
    : reply.sendFile('index.html')
);

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
    await estimator.shutdown();
    await queue.shutdown();
    await landingOptimizer.shutdown();
    await app.close();
  } catch (error) {
    app.log.error(error, 'Shutdown failed');
  }
  process.exit(code);
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Wishly Agent: http://${config.host}:${config.port}`);
  if (process.env.NODE_ENV !== 'test' && process.env.NO_OPEN !== '1') {
    // Let the browser tab that initiated installation claim this process first.
    // A direct launch still opens Wishly when no existing tab pairs in time.
    setTimeout(() => {
      if (!browserClaimedAgent && !shuttingDown) {
        void open(`http://${config.host}:${config.port}/pair`).catch(error =>
          app.log.warn(error, 'Could not open Wishly in the browser')
        );
      }
    }, 8000);
  }
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

function imageSlot(value: string): ImageSlot | null {
  return value === 'start' || value === 'end' ? value : null;
}
