import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'video-compressor-agent-e2e-'));
const outputFolder = path.join(temporary, 'output');
const statePath = path.join(temporary, 'state.json');
const cachePath = path.join(temporary, 'estimate-cache.json');
const importPath = path.join(temporary, 'imports');
await mkdir(outputFolder, { recursive: true });
await writeFile(
  statePath,
  JSON.stringify({
    settings: {
      mode: 'optimal',
      outputMode: 'chosen-folder',
      outputFolder,
      frameRate: null,
      resolutionLimit: null,
      rateControl: 'crf',
      crf: 26,
      videoBitrateKbps: 2500
    },
    jobs: [],
    batch: null
  }),
  'utf8'
);

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const agent = spawn(process.execPath, ['apps/agent/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_PORT: String(port),
    AGENT_STATE_PATH: statePath,
    AGENT_CACHE_PATH: cachePath,
    AGENT_IMPORT_PATH: importPath,
    NO_OPEN: '1',
    NODE_ENV: 'test'
  },
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe']
});
let agentLog = '';
agent.stdout.on('data', data => {
  agentLog = (agentLog + data.toString()).slice(-20_000);
});
agent.stderr.on('data', data => {
  agentLog = (agentLog + data.toString()).slice(-20_000);
});

try {
  await waitFor(async () => (await fetch(`${origin}/health`)).ok, 15_000);
  const pairing = await fetch(`${origin}/local`, { redirect: 'manual' });
  const location = pairing.headers.get('location');
  if (!location) throw new Error('Agent pairing redirect is missing.');
  const token = new URL(location, origin).hash.replace('#agentToken=', '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Agent pairing token is invalid.');
  const api = async (route, init = {}) => {
    const response = await fetch(`${origin}${route}`, {
      ...init,
      headers: { 'x-session-token': token, ...(init.headers ?? {}) }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${route}: ${body.error ?? response.status}`);
    return body;
  };

  const health = await api('/api/health');
  if (health.apiVersion !== 3 || !health.tools.ffmpeg || !health.tools.ffprobe) {
    throw new Error(`Agent health check failed: ${JSON.stringify(health)}`);
  }

  const optimalInput = path.join(temporary, 'optimal-source.mp4');
  await createVideo(optimalInput, 24);
  const optimalHash = await sha256(optimalInput);
  const optimalJob = await upload(api, optimalInput, 'optimal-source.mp4');
  await waitForEstimate(api, optimalJob.id);
  await start(api, [optimalJob.id]);
  const optimalDone = await waitForJob(api, optimalJob.id);
  const optimalMedia = await probe(optimalDone.outputPath);
  assert(optimalMedia.codec === 'h264', 'Optimal output is not H.264.');
  assert(optimalMedia.width === 320 && optimalMedia.height === 180, 'Optimal changed resolution.');
  assert(Math.abs(optimalMedia.fps - 24) < 0.02, 'Optimal changed frame rate.');
  assert((await sha256(optimalInput)) === optimalHash, 'Optimal changed the original file.');

  await api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'custom',
      frameRate: 12,
      resolutionLimit: 240,
      rateControl: 'crf',
      crf: 26
    })
  });
  const customInput = path.join(temporary, 'custom-source.mp4');
  await createVideo(customInput, 24);
  const customHash = await sha256(customInput);
  const customJob = await upload(api, customInput, 'custom-source.mp4');
  await waitForEstimate(api, customJob.id);
  await start(api, [customJob.id]);
  const customDone = await waitForJob(api, customJob.id);
  const customMedia = await probe(customDone.outputPath);
  assert(customMedia.codec === 'h264', 'Custom output is not H.264.');
  assert(customMedia.width === 240 && customMedia.height === 136, 'Custom resolution was not applied.');
  assert(Math.abs(customMedia.fps - 12) < 0.02, 'Custom frame rate was not applied.');
  assert((await sha256(customInput)) === customHash, 'Custom changed the original file.');

  console.log(
    JSON.stringify(
      {
        agent: 'connected',
        apiVersion: health.apiVersion,
        optimal: {
          status: optimalDone.status,
          output: path.basename(optimalDone.outputPath),
          width: optimalMedia.width,
          height: optimalMedia.height,
          fps: optimalMedia.fps,
          codec: optimalMedia.codec,
          originalUnchanged: true
        },
        custom: {
          status: customDone.status,
          output: path.basename(customDone.outputPath),
          width: customMedia.width,
          height: customMedia.height,
          fps: customMedia.fps,
          codec: customMedia.codec,
          originalUnchanged: true
        }
      },
      null,
      2
    )
  );
} catch (error) {
  if (agentLog) console.error(agentLog);
  throw error;
} finally {
  agent.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => agent.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  await rm(temporary, { recursive: true, force: true });
}

async function upload(api, filePath, fileName) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('signature', `${fileName}:${bytes.length}:${Date.now()}`);
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), fileName);
  const response = await api('/api/files/upload', { method: 'POST', body: form });
  if (response.warnings.length) throw new Error(`Upload warning: ${JSON.stringify(response.warnings)}`);
  const job = response.state.jobs.find(candidate => candidate.fileName === fileName);
  if (!job || job.status !== 'ready') throw new Error(`Uploaded job is not ready: ${JSON.stringify(job)}`);
  return job;
}

async function waitForEstimate(api, id) {
  await waitFor(async () => {
    const state = await api('/api/queue');
    const job = state.jobs.find(candidate => candidate.id === id);
    return job && ['estimated', 'unavailable'].includes(job.estimateStatus);
  }, 30_000);
}

async function start(api, ids) {
  await api('/api/queue/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids })
  });
}

async function waitForJob(api, id) {
  let result;
  await waitFor(async () => {
    const state = await api('/api/queue');
    result = state.jobs.find(candidate => candidate.id === id);
    return result && ['completed', 'failed', 'cancelled'].includes(result.status);
  }, 30_000);
  if (result.status !== 'completed') throw new Error(`Compression failed: ${JSON.stringify(result)}`);
  return result;
}

async function createVideo(output, rate) {
  const code = await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=${rate}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    output
  ]);
  if (code !== 0) throw new Error(`Could not create test video (${code}).`);
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,codec_name',
        '-of',
        'json',
        file
      ],
      { shell: false }
    );
    let output = '';
    process.stdout.on('data', data => {
      output += data;
    });
    process.on('error', reject);
    process.on('close', code => {
      if (code !== 0) return reject(new Error(`FFprobe failed (${code}).`));
      const stream = JSON.parse(output).streams[0];
      const [numerator, denominator] = String(stream.avg_frame_rate).split('/').map(Number);
      resolve({
        width: stream.width,
        height: stream.height,
        fps: numerator / denominator,
        codec: stream.codec_name
      });
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { shell: false, stdio: 'ignore' });
    process.on('error', reject);
    process.on('close', resolve);
  });
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(check, timeout) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`Timed out after ${timeout}ms.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
