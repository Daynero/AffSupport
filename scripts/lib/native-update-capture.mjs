/**
 * Bounded packaged-beta observation recorder for the 052 qualification matrix.
 *
 * It records what an owned beta host reports and what this process did to it.
 * It never labels an observation acceptance: the record stays `unreviewed`.
 *
 * Ownership: a host is ours only when this process launched it from the exact
 * `--launch` bundle (no listener on the beta port beforehand), or when it runs
 * from inside that same bundle after Sparkle relaunched it. Faults signal only
 * those processes; no other application is ever touched.
 *
 * Steps (`--step=<stage|*>:<action>`, ordered, each fires once when the
 * observed stage matches after every earlier step has fired):
 *   check | prepare | accept | defer | cancel | ack-visible
 *   accept-lost-reply  accept, drop the connection before the reply, retry the same key
 *   accept-stale       accept with a revision older than the observed one
 *   kill | kill-agent | kill-sparkle   SIGKILL the owned launcher / agent / Sparkle helpers
 *   quit               an ordinary macOS quit of the owned bundle
 *   relaunch           start the owned bundle again once nothing listens on the port
 *   entitle            present a beta entitlement (local beta key, never production)
 *   queue-start=<id>   start one queued compressor job
 *   post=<route>@<json file>  one bounded POST to a beta API route
 *   upload=<route>@<file>[@<bytes per second>]  one multipart upload, in the background,
 *                      optionally throttled so it is still in flight at a later stage
 *   drop=<route>@<file>  a browser drop of a file that exists on this Mac (name, size and
 *                      modification time, empty body), as the web sends for Finder drops
 *   stitch-start=<operation>  add the paths of the last drop to the stitcher and start them
 *   run=<absolute .mjs>       an external fault script; gets the app path, never a token
 *   queue-start-all    start every ready or queued compressor job
 *   transcription-start-all  start every ready transcription in the fast mode
 *   get=<route>        record a bounded summary of one beta GET route
 *   power=<percent>    set the shared power limit
 *   freeze-new-agent   SIGSTOP the next owned agent that starts (a target that never gets ready)
 *   thaw-agent         SIGCONT the agent frozen above
 *   sample-helpers     sample CPU of owned Sparkle helpers and the power state until the end
 *   wait=<ms>
 *
 * While the agent is unreachable the native receipt (Updates/beta/native.json, owner-only)
 * is read instead and recorded with `source: native-receipt`; steps match either source.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  isNativeUpdateSnapshot,
  NATIVE_UPDATE_STAGES
} from '../../packages/shared/dist/native-app-updates.js';
import { NATIVE_UPDATE_QUALIFICATION_CASES } from './native-update-qualification.mjs';
import { readBetaUpdateProfile } from './native-update-profile.mjs';

const exec = promisify(execFile);
const API_ACTIONS = ['check', 'prepare', 'accept', 'defer', 'cancel', 'ack-visible'];
const SIMPLE_ACTIONS = [
  ...API_ACTIONS,
  'accept-lost-reply',
  'accept-stale',
  'kill',
  'kill-agent',
  'kill-sparkle',
  'quit',
  'relaunch',
  'entitle',
  'queue-start-all',
  'transcription-start-all',
  'freeze-new-agent',
  'thaw-agent',
  'sample-helpers'
];

export function parseStep(raw) {
  const split = raw.indexOf(':');
  if (split < 1) throw new Error('NATIVE_PROBE_STEP_INVALID');
  const stage = raw.slice(0, split);
  const action = raw.slice(split + 1);
  if (stage !== '*' && !NATIVE_UPDATE_STAGES.includes(stage))
    throw new Error('NATIVE_PROBE_STEP_INVALID');
  if (SIMPLE_ACTIONS.includes(action)) return { stage, action };
  let match;
  if ((match = /^get=(\/api\/[A-Za-z0-9/_-]{1,128})$/u.exec(action)))
    return { stage, action: 'get', route: match[1] };
  if ((match = /^power=(\d{1,3})$/u.exec(action)))
    return { stage, action: 'power', percent: Number(match[1]) };
  if ((match = /^wait=(\d{1,7})$/u.exec(action)))
    return { stage, action: 'wait', ms: Number(match[1]) };
  if ((match = /^queue-start=([A-Za-z0-9._-]{1,128})$/u.exec(action)))
    return { stage, action: 'queue-start', id: match[1] };
  if ((match = /^post=(\/api\/[A-Za-z0-9/_-]{1,128})@(\/.+\.json)$/u.exec(action)))
    return { stage, action: 'post', route: match[1], file: match[2] };
  if ((match = /^upload=(\/api\/[A-Za-z0-9/_-]{1,128})@(\/[^@]+?)(?:@(\d{1,10}))?$/u.exec(action)))
    return {
      stage,
      action: 'upload',
      route: match[1],
      file: match[2],
      rate: match[3] ? Number(match[3]) : null
    };
  if ((match = /^drop=(\/api\/[A-Za-z0-9/_-]{1,128})@(\/.+)$/u.exec(action)))
    return { stage, action: 'drop', route: match[1], file: match[2] };
  if ((match = /^stitch-start=(restitch|unstitch)$/u.exec(action)))
    return { stage, action: 'stitch-start', operation: match[1] };
  if ((match = /^run=(\/.+\.mjs)$/u.exec(action)))
    return { stage, action: 'run', script: match[1] };
  throw new Error('NATIVE_PROBE_STEP_INVALID');
}

/** Processes executing from inside the owned bundle, by role. */
async function ownedProcesses(app) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,comm='], {
    maxBuffer: 8 * 1024 * 1024
  });
  const prefix = `${app}/Contents/`;
  return stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!m || Number(m[3]) !== process.getuid?.() || !m[4].startsWith(prefix)) return [];
    const command = m[4];
    const role = command.startsWith(`${prefix}MacOS/`)
      ? 'launcher'
      : command.startsWith(`${prefix}Resources/runtime/node`)
        ? 'agent'
        : command.startsWith(`${prefix}Frameworks/Sparkle.framework/`)
          ? 'sparkle'
          : 'other';
    return [{ pid: Number(m[1]), ppid: Number(m[2]), role, name: path.basename(command) }];
  });
}

async function betaListeners(port) {
  const { stdout } = await exec('/usr/sbin/lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']).catch(
    error => {
      if (error.code === 1) return { stdout: '' };
      throw error;
    }
  );
  return stdout.split('\n').filter(Boolean).map(Number);
}

/** A request that is written completely and then abandoned before any reply byte. */
function postAndDrop(url, headers, body) {
  return new Promise(resolve => {
    const request = http.request(url, { method: 'POST', headers });
    request.on('error', () => resolve('dropped'));
    request.on('response', response => {
      response.destroy();
      resolve('answered-before-drop');
    });
    request.end(body, () => {
      // The body has left this process; drop the socket so no reply can arrive.
      request.destroy();
      resolve('dropped');
    });
  });
}

/** One multipart file part streamed to the agent, optionally at a bounded rate. */
function uploadFile(url, headers, file, rate) {
  return new Promise((resolve, reject) => {
    const boundary = `----soty-qualification-${randomUUID()}`;
    const name = path.basename(file);
    const head = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename=${JSON.stringify(name)}\r\n` +
        'content-type: application/octet-stream\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = statSync(file).size;
    const request = http.request(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': head.length + size + tail.length
      }
    });
    request.on('error', reject);
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8').slice(0, 262144));
        } catch {
          /* absent */
        }
        resolve({ status: response.statusCode, json });
      });
    });
    request.write(head);
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    const startedAt = Date.now();
    let sent = 0;
    stream.on('data', chunk => {
      sent += chunk.length;
      const ok = request.write(chunk);
      const due = rate ? startedAt + (sent / rate) * 1000 - Date.now() : 0;
      if (!ok || due > 0) {
        stream.pause();
        const resume = () => setTimeout(() => stream.resume(), Math.max(0, due));
        if (!ok) request.once('drain', resume);
        else resume();
      }
    });
    stream.on('error', reject);
    stream.on('end', () => request.end(tail));
  });
}

function betaEntitlementToken(subject, keyFile) {
  const key = createPrivateKey(readFileSync(keyFile));
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sub: subject, plan: 'pro', iat: now, exp: now + 3600 })
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`wat1.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `wat1.${payload}.${signature}`;
}

export async function capture(args) {
  const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const scenario = option('scenario');
  const output = option('output');
  const origin = new URL(option('origin') ?? 'http://127.0.0.1:43140');
  const until = option('until') ?? 'ui_visible';
  const fault = option('fault');
  const settleMs = Number(option('settle-ms') ?? 0);
  const timeoutMs = Number(option('timeout-ms') ?? 10 * 60_000);
  const steps = args
    .filter(value => value.startsWith('--step='))
    .map(value => parseStep(value.slice(7)));
  if (fault) steps.push({ stage: fault, action: 'kill' });
  if (
    !scenario ||
    !NATIVE_UPDATE_QUALIFICATION_CASES.includes(scenario) ||
    !output ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.port !== '43140' ||
    !(until === 'none' || NATIVE_UPDATE_STAGES.some(stage => stage === until)) ||
    (fault && !NATIVE_UPDATE_STAGES.some(stage => stage === fault)) ||
    !Number.isSafeInteger(settleMs) ||
    settleMs < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60 * 60_000
  )
    throw new Error('NATIVE_PROBE_ARGUMENTS');
  const launch = option('launch');
  const app = launch ?? option('app');
  if (!app || !path.isAbsolute(app) || path.basename(app) !== 'Soty Beta.app')
    throw new Error('NATIVE_PROBE_BETA_APP_REQUIRED');
  const hostSteps = ['kill', 'kill-agent', 'kill-sparkle', 'quit', 'relaunch'];
  if (!launch && steps.some(step => hostSteps.includes(step.action)))
    throw new Error('NATIVE_PROBE_FAULT_REQUIRES_OWNED_HOST');
  const profile = await readBetaUpdateProfile(app, { required: true });
  if (!profile) throw new Error('NATIVE_UPDATE_PROFILE_REQUIRED');
  const support = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    profile.supportDirectoryName
  );
  const installationFile = path.join(support, 'Updates/beta/installation-id');
  const release = async () =>
    JSON.parse(await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8'));
  const launchedRelease = await release();
  if (launchedRelease.channel !== 'beta') throw new Error('NATIVE_PROBE_BETA_IDENTITY');
  const observations = [];
  const actions = [];
  const started = Date.now();
  let launches = 0;
  const startHost = async () => {
    if ((await betaListeners(origin.port)).length)
      throw new Error('NATIVE_PROBE_BETA_ALREADY_RUNNING');
    const child = spawn(path.join(app, 'Contents/MacOS/SotyBetaAgent'), [], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, NO_OPEN: '1', SOTY_UPDATE_PROBE_SESSION_TOKEN: '' }
    });
    child.unref();
    launches++;
    return child.pid;
  };
  if (launch) await startHost();
  let session = process.env.SOTY_UPDATE_PROBE_SESSION_TOKEN || null;
  const pair = async () => {
    const response = await fetch(new URL('/pair', origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    });
    const token = /#agentToken=([a-f0-9]{64})/u.exec(response.headers.get('location') ?? '')?.[1];
    if (!token) throw new Error('NATIVE_PROBE_PAIRING_FAILED');
    session = token;
  };
  const usePairing = args.includes('--pair');
  const headers = () => ({ 'x-session-token': session ?? '' });
  const read = async route => {
    if (!session && usePairing) await pair();
    if (!session) throw new Error('NATIVE_PROBE_SESSION_REQUIRED');
    let response = await fetch(new URL(route, origin), {
      headers: headers(),
      signal: AbortSignal.timeout(5000)
    });
    if (response.status === 401 && usePairing) {
      await pair();
      response = await fetch(new URL(route, origin), {
        headers: headers(),
        signal: AbortSignal.timeout(5000)
      });
    }
    if (!response.ok) throw new Error('NATIVE_PROBE_READ_FAILED');
    const text = await response.text();
    if (text.length > 262144) throw new Error('NATIVE_PROBE_FRAME_LIMIT');
    return JSON.parse(text);
  };
  const post = async (route, body) => {
    const response = await fetch(new URL(route, origin), {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    const text = (await response.text()).slice(0, 4096);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* recorded as absent */
    }
    return { status: response.status, json };
  };
  const summary = json =>
    json && typeof json === 'object'
      ? isNativeUpdateSnapshot(json)
        ? { stage: json.stage, code: json.code, revision: json.revision, attemptId: json.attemptId }
        : {
            error: typeof json.error === 'string' ? json.error : undefined,
            keys: Object.keys(json).slice(0, 12),
            ...(Array.isArray(json.jobs)
              ? {
                  jobs: json.jobs.slice(-8).map(job => ({
                    id: job.id,
                    status: job.status,
                    fileName: job.fileName,
                    progress: job.progress,
                    finalSize: job.finalSize ?? null
                  }))
                }
              : {}),
            ...(Array.isArray(json.state?.jobs)
              ? {
                  jobs: json.state.jobs
                    .slice(-8)
                    .map(job => ({ id: job.id, status: job.status, fileName: job.fileName }))
                }
              : {})
          }
      : null;
  let current = null;
  const command = (action, extra = {}) => ({
    schemaVersion: 1,
    idempotencyKey: randomUUID(),
    expectedRevision: current?.revision ?? 0,
    candidateId: current?.candidateId ?? null,
    ...extra
  });
  const signalOwned = async role => {
    const owned = (await ownedProcesses(app)).filter(entry => entry.role === role);
    for (const entry of owned) process.kill(entry.pid, 'SIGKILL');
    return owned.map(({ pid, name }) => ({ pid, name }));
  };
  const perform = async step => {
    const at = Date.now();
    const entry = { at, stage: current?.stage ?? null, action: step.action };
    try {
      if (API_ACTIONS.includes(step.action)) {
        const result = await post(`/api/app-update/${step.action}`, command(step.action));
        Object.assign(entry, { status: result.status, result: summary(result.json) });
      } else if (step.action === 'accept-stale') {
        const body = command('accept');
        body.expectedRevision = Math.max(0, (current?.revision ?? 1) - 1);
        const result = await post('/api/app-update/accept', body);
        Object.assign(entry, { status: result.status, result: summary(result.json) });
      } else if (step.action === 'accept-lost-reply') {
        const body = JSON.stringify(command('accept'));
        const first = await postAndDrop(
          new URL('/api/app-update/accept', origin),
          {
            ...headers(),
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body)
          },
          body
        );
        await new Promise(resolve => setTimeout(resolve, 1500));
        const retry = await fetch(new URL('/api/app-update/accept', origin), {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30_000)
        });
        let json = null;
        try {
          json = JSON.parse((await retry.text()).slice(0, 4096));
        } catch {
          /* absent */
        }
        Object.assign(entry, {
          first,
          retryStatus: retry.status,
          retry: summary(json),
          sameKey: true
        });
      } else if (step.action === 'kill') entry.signalled = await signalOwned('launcher');
      else if (step.action === 'kill-agent') entry.signalled = await signalOwned('agent');
      else if (step.action === 'kill-sparkle') entry.signalled = await signalOwned('sparkle');
      else if (step.action === 'quit') {
        await exec(
          '/usr/bin/osascript',
          ['-e', `tell application ${JSON.stringify(app)} to quit`],
          {
            timeout: 30_000
          }
        );
        entry.requested = true;
      } else if (step.action === 'relaunch') {
        const deadline = Date.now() + 60_000;
        while (
          (await betaListeners(origin.port)).length ||
          (await ownedProcesses(app)).some(p => p.role === 'launcher')
        ) {
          if (Date.now() > deadline) throw new Error('NATIVE_PROBE_RELAUNCH_BLOCKED');
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        entry.pid = await startHost();
      } else if (step.action === 'entitle') {
        const health = await read('/api/health');
        const keyFile = path.resolve('config/keys/beta-agent-entitlement.private.pem');
        const result = await post('/api/entitlement', {
          token: betaEntitlementToken(`qualification-${scenario}`, keyFile),
          revision: health.entitlementRevision
        });
        Object.assign(entry, { status: result.status, entitled: result.json?.entitled === true });
      } else if (step.action === 'queue-start') {
        const result = await post('/api/queue/start', { ids: [step.id] });
        Object.assign(entry, { status: result.status, id: step.id, result: summary(result.json) });
      } else if (step.action === 'post') {
        const result = await post(step.route, JSON.parse(await readFile(step.file, 'utf8')));
        Object.assign(entry, {
          status: result.status,
          route: step.route,
          result: summary(result.json)
        });
      } else if (step.action === 'upload') {
        const pendingUpload = uploadFile(
          new URL(step.route, origin),
          headers(),
          step.file,
          step.rate
        )
          .then(result => ({ status: result.status, result: summary(result.json) }))
          .catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
          .then(result => {
            actions.push({
              at: Date.now(),
              action: 'upload-finished',
              route: step.route,
              ...result
            });
          });
        background.push(pendingUpload);
        Object.assign(entry, {
          route: step.route,
          file: path.basename(step.file),
          rate: step.rate,
          background: true
        });
      } else if (step.action === 'run') {
        const { stdout, stderr } = await exec(process.execPath, [step.script], {
          timeout: 10 * 60_000,
          env: {
            PATH: process.env.PATH,
            HOME: os.homedir(),
            SOTY_PROBE_APP: app,
            SOTY_PROBE_SUPPORT: support
          },
          maxBuffer: 1024 * 1024
        }).catch(error => ({
          stdout: error.stdout ?? '',
          stderr: `${error.stderr ?? ''} exit=${error.code}`
        }));
        Object.assign(entry, {
          script: path.basename(step.script),
          stdout: stdout.slice(0, 4096),
          stderr: stderr.slice(0, 2048)
        });
      } else if (step.action === 'queue-start-all') {
        const queue = await read('/api/queue');
        const ids = (queue.jobs ?? [])
          .filter(job => ['queued', 'ready'].includes(job.status))
          .map(job => job.id);
        const result = await post('/api/queue/start', { ids });
        Object.assign(entry, { status: result.status, ids, result: summary(result.json) });
      } else if (step.action === 'drop') {
        const info = statSync(step.file);
        const form = new FormData();
        form.append('size', String(info.size));
        form.append('lastModified', String(Math.round(info.mtimeMs)));
        form.append('file', new Blob([]), path.basename(step.file));
        const response = await fetch(new URL(step.route, origin), {
          method: 'POST',
          headers: headers(),
          body: form,
          signal: AbortSignal.timeout(30_000)
        });
        const json = await response.json().catch(() => null);
        dropped = Array.isArray(json?.paths) ? json.paths : [];
        Object.assign(entry, { status: response.status, route: step.route, found: dropped.length });
      } else if (step.action === 'stitch-start') {
        const added = await post('/api/stitcher/files', { paths: dropped });
        const ids = (added.json?.state?.jobs ?? []).map(job => job.id);
        const result = await post('/api/stitcher/start', {
          ids: ids.slice(-1),
          operation: step.operation
        });
        Object.assign(entry, {
          addStatus: added.status,
          status: result.status,
          failures: result.json?.failures ?? null,
          jobs: (result.json?.state?.jobs ?? [])
            .slice(-2)
            .map(job => ({ id: job.id, status: job.status }))
        });
      } else if (step.action === 'transcription-start-all') {
        const state = await read('/api/transcription/state');
        const ids = (state.jobs ?? [])
          .filter(job => ['ready', 'queued', 'pending'].includes(job.status))
          .map(job => job.id);
        const result = await post('/api/transcription/start', { ids, quality: 'fast' });
        Object.assign(entry, { status: result.status, ids, result: summary(result.json) });
      } else if (step.action === 'get') {
        Object.assign(entry, { route: step.route, result: summary(await read(step.route)) });
      } else if (step.action === 'power') {
        const result = await post('/api/power/limit', { limitPercent: step.percent });
        Object.assign(entry, { status: result.status, percent: step.percent });
      } else if (step.action === 'freeze-new-agent') {
        const known = new Set(
          (await ownedProcesses(app)).filter(p => p.role === 'agent').map(p => p.pid)
        );
        background.push(
          (async () => {
            const deadline = Date.now() + 5 * 60_000;
            while (Date.now() < deadline) {
              const fresh = (await ownedProcesses(app)).find(
                p => p.role === 'agent' && !known.has(p.pid)
              );
              if (fresh) {
                process.kill(fresh.pid, 'SIGSTOP');
                frozen = fresh.pid;
                actions.push({ at: Date.now(), action: 'froze-agent', pid: fresh.pid });
                return;
              }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            actions.push({ at: Date.now(), action: 'freeze-new-agent-timeout' });
          })()
        );
        entry.known = [...known];
      } else if (step.action === 'thaw-agent') {
        if (frozen) process.kill(frozen, 'SIGCONT');
        entry.pid = frozen;
        frozen = null;
      } else if (step.action === 'sample-helpers') {
        sampling = true;
        background.push(
          (async () => {
            let tick = 0;
            while (sampling && helperSamples.length < 4000) {
              const { stdout } = await exec(
                '/bin/ps',
                ['-axo', 'pid=,ppid=,uid=,%cpu=,time=,stat=,comm='],
                {
                  maxBuffer: 8 * 1024 * 1024
                }
              );
              const rows = stdout.split('\n').flatMap(line => {
                const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(
                  line
                );
                if (!m || Number(m[3]) !== process.getuid?.()) return [];
                const command = m[7];
                const sparkle =
                  command.includes('Sparkle') ||
                  ['Autoupdate', 'Updater', 'Installer', 'Downloader'].includes(
                    path.basename(command)
                  );
                if (!sparkle && !command.startsWith(`${app}/Contents/`)) return [];
                return [
                  {
                    pid: Number(m[1]),
                    ppid: Number(m[2]),
                    cpu: Number(m[4].replace(',', '.')),
                    time: m[5],
                    stat: m[6],
                    name: path.basename(command),
                    inBundle: command.startsWith(`${app}/Contents/`)
                  }
                ];
              });
              const sample = { at: Date.now(), rows };
              if (tick++ % 4 === 0)
                sample.power = await read('/api/power')
                  .then(value => ({
                    limitPercent: value.limitPercent,
                    keys: Object.keys(value).slice(0, 16),
                    mode: value.mode,
                    throttlingSupported: value.throttlingSupported,
                    holdingToLimit: value.holdingToLimit,
                    activeChildren: value.activeChildren,
                    sample: value.sample
                  }))
                  .catch(() => null);
              helperSamples.push(sample);
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          })()
        );
      } else if (step.action === 'wait') await new Promise(resolve => setTimeout(resolve, step.ms));
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    entry.finishedAt = Date.now();
    actions.push(entry);
  };
  const background = [];
  const helperSamples = [];
  let sampling = false;
  let frozen = null;
  let dropped = [];
  let receiptRevision = null;
  let pending = 0;
  let unavailable = false;
  let lastChange = Date.now();
  try {
    while (Date.now() - started < timeoutMs && observations.length < 5000) {
      try {
        const health = await read('/api/health');
        if (health.environment !== 'beta' || health.channel !== 'beta')
          throw new Error('NATIVE_PROBE_NON_BETA');
        const state = await read('/api/app-update');
        if (!isNativeUpdateSnapshot(state)) throw new Error('NATIVE_PROBE_INVALID_SNAPSHOT');
        const installationId = (await readFile(installationFile, 'utf8')).trim();
        if (state.installationId !== installationId)
          throw new Error('NATIVE_PROBE_PROFILE_MISMATCH');
        unavailable = false;
        current = state;
        const previous = [...observations].reverse().find(entry => entry.state);
        if (
          !previous ||
          previous.state?.revision !== state.revision ||
          previous.state?.stage !== state.stage ||
          previous.buildId !== health.buildId
        ) {
          observations.push({
            at: Date.now(),
            state,
            buildId: health.buildId,
            sourceRevision: health.sourceRevision
          });
          lastChange = Date.now();
        }
      } catch (error) {
        if (
          error instanceof Error &&
          ['NATIVE_PROBE_NON_BETA', 'NATIVE_PROBE_PROFILE_MISMATCH'].includes(error.message)
        )
          throw error;
        if (!unavailable) {
          observations.push({
            at: Date.now(),
            unavailable: true,
            reason: error instanceof Error ? error.message : 'unknown'
          });
          lastChange = Date.now();
          // A stale API stage must not satisfy a step while nothing answers.
          current = null;
          receiptRevision = null;
        }
        unavailable = true;
        // The host's own durable receipt still says where the attempt is.
        try {
          const receipt = JSON.parse(
            await readFile(path.join(support, 'Updates/beta/native.json'), 'utf8')
          );
          if (receipt.revision !== receiptRevision) {
            receiptRevision = receipt.revision;
            const projected = {
              stage: receipt.stage,
              code: receipt.code ?? null,
              revision: receipt.revision,
              attemptId: receipt.attemptId ?? null,
              candidateId: receipt.candidateId ?? null,
              lastProvenStage: receipt.lastProvenStage ?? null,
              nativeSuccess: receipt.nativeSuccess === true,
              uiSuccess: receipt.uiSuccess === true
            };
            observations.push({ at: Date.now(), source: 'native-receipt', state: projected });
            current = { ...(current ?? {}), ...projected };
            lastChange = Date.now();
          }
        } catch {
          /* no receipt yet, or mid-rename */
        }
      }
      while (pending < steps.length) {
        const step = steps[pending];
        // A stage read from the native receipt while the agent is down matches too.
        const ready = step.stage === '*' || current?.stage === step.stage;
        if (!ready) break;
        pending++;
        await perform(step);
        lastChange = Date.now();
      }
      const done = pending >= steps.length;
      if (
        done &&
        until !== 'none' &&
        !unavailable &&
        current?.stage === until &&
        Date.now() - lastChange >= settleMs
      )
        break;
      if (done && until === 'none' && Date.now() - lastChange >= Math.max(settleMs, 1000)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  } finally {
    sampling = false;
    await Promise.race([
      Promise.all(background),
      new Promise(resolve => setTimeout(resolve, 60_000).unref())
    ]);
    const finalRelease = await release().catch(() => null);
    const toolRevision = (
      await exec('git', ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
    ).stdout.trim();
    const record = {
      schemaVersion: 1,
      kind: 'native-update-observation',
      status: 'unreviewed',
      // The packaged source under qualification; the tool revision is recorded separately.
      sourceSha: launchedRelease.sourceRevision,
      toolRevision,
      scenario,
      startedAt: started,
      finishedAt: Date.now(),
      faulted: actions.some(entry => ['kill', 'kill-agent', 'kill-sparkle'].includes(entry.action)),
      controlledRuntimeOnly: true,
      profileId: profile.profileId,
      launchedBuildId: launchedRelease.buildId,
      finalBundleBuildId: finalRelease?.buildId ?? null,
      launches,
      stepsFired: pending,
      stepsPlanned: steps.length,
      actions,
      observations,
      ...(helperSamples.length ? { helperSamples } : {})
    };
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    const bytes = JSON.stringify(record, null, 2) + '\n';
    await writeFile(output, bytes, { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({
        output: path.resolve(output),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        observations: observations.length,
        stepsFired: `${pending}/${steps.length}`,
        status: 'unreviewed'
      }) + '\n'
    );
    // A surviving host is deliberately left to the tester; no unrelated app is stopped.
  }
}
