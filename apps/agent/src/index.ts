import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import open from 'open';
import type { AgentEvent } from '@video-compressor/shared';
import { commandExists } from './ffmpeg/tools.js';
import { selectOutputFolder, selectVideos } from './files/picker.js';
import { JobQueue } from './queue/queue.js';
import { loadState, saveState } from './queue/store.js';
import type { AgentSettings } from '@video-compressor/shared';
import type { AgentEventType } from '@video-compressor/shared';
import { EstimationWorker } from './estimate/worker.js';
import { allowedOrigins, config } from './config.js';
import os from 'node:os';
import { ffmpegPath, ffprobePath } from './ffmpeg/tools.js';

const token = randomBytes(32).toString('hex');
const app = Fastify({ logger: true, bodyLimit: 16_384 });
const tools = { ffmpeg: await commandExists(ffmpegPath), ffprobe: await commandExists(ffprobePath) };
const clients = new Set<NodeJS.WritableStream>();
let queue: JobQueue;
let estimator: EstimationWorker;
const pendingSelections = new Map<string, string>();
let saveChain = Promise.resolve();

function broadcast(type:AgentEventType='state') {
  const event: AgentEvent = { type, state: queue.state() };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
  saveChain = saveChain.then(() => saveState(queue.persisted())).catch(error => app.log.error(error, 'Could not save local state'));
}
const restored = await loadState();
queue = new JobQueue(tools, broadcast, restored.jobs, restored.settings);
await saveState(queue.persisted());
estimator=new EstimationWorker(()=>queue.estimationJobs(),(id,patch,event)=>queue.updateEstimate(id,patch,event),()=>queue.state().running);
queue.attachEstimator({schedule:()=>estimator.schedule(),invalidateForPreset:preset=>estimator.invalidateForPreset(preset),resume:()=>estimator.resume()});
await estimator.init();

await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['content-type', 'x-session-token']
});
app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (request.url.startsWith('/api/') && origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'Origin is not allowed.' });
});
app.addHook('onSend', async (request, reply, payload) => {
  if (request.headers['access-control-request-private-network'] === 'true' && request.headers.origin && allowedOrigins.has(request.headers.origin)) reply.header('Access-Control-Allow-Private-Network', 'true');
  return payload;
});

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const supplied = request.headers['x-session-token'] ?? (request.query as { token?: string }).token;
  if (supplied !== token) return reply.code(401).send({ error: 'Invalid session token.' });
});
app.get('/api/health', async () => ({ ok: tools.ffmpeg && tools.ffprobe, tools, version: config.version, apiVersion: 1 }));
app.get('/health', async () => ({ product: 'local-video-compressor-agent', ready: tools.ffmpeg && tools.ffprobe }));
app.get('/api/diagnostics', async () => ({ version: config.version, macOS: os.release(), architecture: os.arch(), ffmpeg: tools.ffmpeg && tools.ffprobe ? 'ready' : 'unavailable', lastError: queue.state().warning ?? null }));
app.get('/api/queue', async () => queue.state());
app.get('/api/events', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  clients.add(reply.raw); reply.raw.write(`data: ${JSON.stringify({ type: 'state', state: queue.state() })}\n\n`);
  request.raw.on('close', () => clients.delete(reply.raw));
});
app.post('/api/files/select', async (_request, reply) => {
  if (process.platform !== 'darwin') return reply.code(501).send({ error: 'The file picker is available on macOS only.' });
  const paths = await selectVideos(); const warnings = await queue.add(paths);
  for (const warning of warnings) { const selected = paths.find(p => path.basename(p) === warning.fileName); if (selected) pendingSelections.set(warning.id, selected); }
  return { state: queue.state(), warnings };
});
app.post<{ Body: { ids?: unknown } }>('/api/files/confirm', async (request, reply) => {
  if (!request.body || !Array.isArray(request.body.ids) || !request.body.ids.every(id => typeof id === 'string')) return reply.code(400).send({ error: 'Invalid confirmation.' });
  const paths = request.body.ids.map(id => pendingSelections.get(id)).filter((p): p is string => Boolean(p)); request.body.ids.forEach(id => pendingSelections.delete(id));
  await queue.add(paths, true); return queue.state();
});
app.post('/api/output/select', async () => { const folder = await selectOutputFolder(); if (folder) queue.updateSettings({ outputMode: 'chosen-folder', outputFolder: folder }); return queue.state(); });
app.post<{ Body: Partial<AgentSettings> }>('/api/settings', async (request, reply) => {
  const body = request.body; if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'Invalid settings.' });
  const allowed: Partial<AgentSettings> = {};
  if (body.preset !== undefined) { if (!['quality', 'balanced', 'ultra-small'].includes(body.preset)) return reply.code(400).send({ error: 'Invalid preset.' }); allowed.preset = body.preset; }
  if (body.outputMode !== undefined) { if (!['next-to-originals', 'chosen-folder'].includes(body.outputMode)) return reply.code(400).send({ error: 'Invalid output mode.' }); allowed.outputMode = body.outputMode; }
  queue.updateSettings(allowed); return queue.state();
});
app.post('/api/queue/start', async (_request, reply) => {
  if (!tools.ffmpeg) return reply.code(503).send({ error: 'The bundled video engine is unavailable. Reinstall the Mac Agent.' });
  await estimator.pause(); await queue.start(); return queue.state();
});
app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) => (await queue.cancel(request.params.id)) ? queue.state() : reply.code(409).send({ error: 'Only the current job can be cancelled.' }));
app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => queue.remove(request.params.id) ? queue.state() : reply.code(409).send({ error: 'Only queued jobs can be removed.' }));
app.delete('/api/jobs/completed', async () => { queue.clearCompleted(); return queue.state(); });
app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) => queue.retry(request.params.id) ? queue.state() : reply.code(409).send({ error: 'Only failed, interrupted, or cancelled jobs can be retried.' }));
app.post<{ Params: { id: string } }>('/api/jobs/:id/reveal', async (request, reply) => {
  const job = queue.state().jobs.find(j => j.id === request.params.id && j.status === 'completed');
  if (!job) return reply.code(404).send({ error: 'Completed file not found.' });
  spawn('/usr/bin/open', ['-R', job.outputPath], { shell: false, detached: true, stdio: 'ignore' }).unref();
  return queue.state();
});
app.post('/api/output/reveal', async (_request, reply) => { const folder = queue.outputFolder(); if (!folder) return reply.code(404).send({ error: 'No output folder is available yet.' }); spawn('/usr/bin/open', [folder], { shell: false, detached: true, stdio: 'ignore' }).unref(); return queue.state(); });

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../web/dist');
await app.register(fastifyStatic, { root: webRoot, wildcard: false });
app.get('/pair', async (_request, reply) => reply.redirect(`${config.publicOrigin ?? `http://${config.host}:${config.port}`}/#agentToken=${token}`));
app.get('/local', async (_request, reply) => reply.redirect(`http://${config.host}:${config.port}/#agentToken=${token}`));
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'API action not found.' }) : reply.sendFile('index.html'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Local Video Compressor: http://${config.host}:${config.port}`);
  if (process.env.NODE_ENV !== 'test' && process.env.NO_OPEN !== '1') await open(`http://${config.host}:${config.port}/pair`);
} catch (error) { app.log.error(error); process.exit(1); }
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await estimator.shutdown();await queue.shutdown();await app.close();process.exit(0)});
