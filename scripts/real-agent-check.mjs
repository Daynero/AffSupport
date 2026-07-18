import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_API_VERSION,
  BUILD_ID,
  BUILD_NUMBER,
  PRODUCT_VERSION
} from '../packages/shared/dist/release.js';

const root = path.resolve(import.meta.dirname, '..');
const agentNode = process.env.AGENT_NODE_BINARY || process.execPath;
const agentEntry = process.env.AGENT_ENTRY_PATH || path.join(root, 'apps/agent/dist/index.js');
const agentWorkingDirectory = process.env.AGENT_WORKING_DIRECTORY || root;
const testFfmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const testFfprobe = process.env.FFPROBE_PATH || 'ffprobe';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'video-compressor-agent-e2e-'));
const outputFolder = path.join(temporary, 'output');
const statePath = path.join(temporary, 'state.json');
const cachePath = path.join(temporary, 'estimate-cache.json');
const importPath = path.join(temporary, 'imports');
const imagePath = path.join(temporary, 'images');
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
      videoBitrateKbps: 2500,
      imageEmbedding: {
        enabled: false,
        startImage: null,
        endImage: null,
        finalDurationMode: 'random-40-50',
        customFinalDurationSeconds: 2700,
        fitMode: 'cover'
      }
    },
    jobs: [],
    batch: null
  }),
  'utf8'
);

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const agent = spawn(agentNode, [agentEntry], {
  cwd: agentWorkingDirectory,
  env: {
    ...process.env,
    AGENT_PORT: String(port),
    AGENT_STATE_PATH: statePath,
    AGENT_CACHE_PATH: cachePath,
    AGENT_IMPORT_PATH: importPath,
    AGENT_IMAGE_PATH: imagePath,
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
  await waitFor(async () => (await fetch(`${origin}/health`, { cache: 'no-store' })).ok, 15_000);
  const publicHealthResponse = await fetch(`${origin}/health`, { cache: 'no-store' });
  const publicHealth = await publicHealthResponse.json();
  assert(
    publicHealthResponse.headers.get('cache-control') === 'no-store',
    'Public health was cacheable.'
  );
  assert(publicHealth.version === PRODUCT_VERSION, 'Public health has the wrong product version.');
  assert(publicHealth.buildNumber === BUILD_NUMBER, 'Public health has the wrong build number.');
  assert(publicHealth.buildId === BUILD_ID, 'Public health has the wrong build ID.');
  assert(publicHealth.apiVersion === AGENT_API_VERSION, 'Public health has the wrong API version.');
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
  if (
    health.version !== PRODUCT_VERSION ||
    health.buildId !== BUILD_ID ||
    health.apiVersion !== AGENT_API_VERSION ||
    !health.tools.ffmpeg ||
    !health.tools.ffprobe
  ) {
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
  assert(
    customMedia.width === 240 && customMedia.height === 136,
    'Custom resolution was not applied.'
  );
  assert(Math.abs(customMedia.fps - 12) < 0.02, 'Custom frame rate was not applied.');
  assert((await sha256(customInput)) === customHash, 'Custom changed the original file.');

  const openingImage = path.join(temporary, 'opening frame.png');
  const finalImage = path.join(temporary, 'final image.webp');
  await createImage(openingImage, 'red', '120x200');
  await createImage(finalImage, 'green', '300x100');
  let imageState = await uploadImage(api, openingImage, 'opening frame.png', 'start', 'image/png');
  imageState = await uploadImage(api, finalImage, 'final image.webp', 'end', 'image/webp');
  assert(
    imageState.settings.imageEmbedding.startImage.fileName === 'opening frame.png',
    'Opening image was not stored.'
  );
  assert(
    imageState.settings.imageEmbedding.endImage.fileName === 'final image.webp',
    'Final image was not stored.'
  );
  const preview = await fetch(
    `${origin}/api/images/${imageState.settings.imageEmbedding.startImage.id}/content`,
    { headers: { 'x-session-token': token } }
  );
  assert(
    preview.ok && preview.headers.get('content-type') === 'image/png',
    'Image preview endpoint failed.'
  );

  await api('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'custom',
      frameRate: 30,
      resolutionLimit: 240,
      rateControl: 'bitrate',
      videoBitrateKbps: 700,
      imageEmbedding: {
        enabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 1,
        fitMode: 'contain'
      }
    })
  });
  const embeddedInput = path.join(temporary, 'embedded silent source.mp4');
  await createVideo(embeddedInput, 30, false);
  const embeddedHash = await sha256(embeddedInput);
  const embeddedJob = await upload(api, embeddedInput, 'embedded silent source.mp4');
  await waitForEstimate(api, embeddedJob.id);
  await start(api, [embeddedJob.id]);
  const embeddedDone = await waitForJob(api, embeddedJob.id);
  const embeddedMedia = await probe(embeddedDone.outputPath);
  assert(
    embeddedDone.outputPath.includes('_embedded_compressed'),
    'Embedded output suffix is missing.'
  );
  assert(
    embeddedDone.imageEmbedding.finalDurationSeconds === 1,
    'Custom final duration was not frozen.'
  );
  assert(
    embeddedMedia.width === 240 && embeddedMedia.height === 136,
    'Embedded resolution is wrong.'
  );
  assert(Math.abs(embeddedMedia.fps - 30) < 0.02, 'Embedded frame rate is wrong.');
  assert(embeddedMedia.hasAudio, 'Silent source did not receive an audio track.');
  assert(
    Math.abs(embeddedMedia.duration - (embeddedDone.durationSeconds + 1 / 30 + 1)) < 0.15,
    'Embedded duration is wrong.'
  );
  assert((await sha256(embeddedInput)) === embeddedHash, 'Embedding changed the original file.');

  console.log(
    JSON.stringify(
      {
        agent: 'connected',
        version: health.version,
        buildId: health.buildId,
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
        },
        embedded: {
          status: embeddedDone.status,
          output: path.basename(embeddedDone.outputPath),
          width: embeddedMedia.width,
          height: embeddedMedia.height,
          fps: embeddedMedia.fps,
          duration: embeddedMedia.duration,
          hasAudio: embeddedMedia.hasAudio,
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
  if (response.warnings.length)
    throw new Error(`Upload warning: ${JSON.stringify(response.warnings)}`);
  const job = response.state.jobs.find(candidate => candidate.fileName === fileName);
  if (!job || job.status !== 'ready')
    throw new Error(`Uploaded job is not ready: ${JSON.stringify(job)}`);
  return job;
}

async function uploadImage(api, filePath, fileName, slot, mimeType) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), fileName);
  return api(`/api/images/${slot}`, { method: 'POST', body: form });
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
  if (result.status !== 'completed')
    throw new Error(`Compression failed: ${JSON.stringify(result)}`);
  return result;
}

async function createVideo(output, rate, audio = true) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=${rate}`
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
  args.push('-t', '1', '-c:v', 'libx264');
  if (audio) args.push('-c:a', 'aac');
  else args.push('-an');
  args.push(output);
  const code = await run(testFfmpeg, args);
  if (code !== 0) throw new Error(`Could not create test video (${code}).`);
}

async function createImage(output, color, size) {
  if (path.extname(output).toLowerCase() === '.webp') {
    // The release FFmpeg is decode-only for WebP, so keep a tiny valid WebP fixture inline.
    await writeFile(
      output,
      Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBoSygABc6zbAAA', 'base64')
    );
    return;
  }
  const code = await run(testFfmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=${size}`,
    '-frames:v',
    '1',
    '-threads',
    '1',
    output
  ]);
  if (code !== 0) throw new Error(`Could not create test image (${code}).`);
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      testFfprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height,avg_frame_rate,codec_name,duration:format=duration',
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
      const data = JSON.parse(output);
      const stream = data.streams.find(candidate => candidate.codec_type === 'video');
      const audio = data.streams.find(candidate => candidate.codec_type === 'audio');
      const [numerator, denominator] = String(stream.avg_frame_rate).split('/').map(Number);
      resolve({
        width: stream.width,
        height: stream.height,
        fps: numerator / denominator,
        codec: stream.codec_name,
        duration: Number(data.format.duration),
        hasAudio: Boolean(audio)
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
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
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
