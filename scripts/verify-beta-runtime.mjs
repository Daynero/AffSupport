#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BETA_PROFILE } from '../packages/shared/dist/environment.js';

/**
 * Proves the packaged beta actually works, not merely that it is shaped right.
 *
 * The structural smoke around this one reads plists, bundle strings and
 * generated Swift: all real checks, and all of them satisfied by a build that
 * cannot authenticate a single user or finish a single job. This script runs the
 * short version of what a tester does — start the packaged app, pair with it,
 * present a beta entitlement, compress three seconds of video, read the result
 * back — because that is the difference between "the package is correct" and
 * "the package works".
 *
 * Everything it needs is local: the packaged app, the beta entitlement private
 * key, and ffmpeg from inside the bundle. Nothing here reaches production, and
 * a missing prerequisite fails rather than skips — a beta whose runtime journey
 * was quietly not run must not produce a verification record.
 */

const DEADLINE_MS = 4 * 60_000;
const AGENT = `http://127.0.0.1:${BETA_PROFILE.agentPort}`;
const BETA_ENTITLEMENT_KEY = 'config/keys/beta-agent-entitlement.private.pem';

/**
 * A packaged beta serves its own UI, so its allowed origin is the agent itself
 * rather than the Vite port a source-run beta uses. Reading it from `.env.beta`
 * keeps this journey honest about which origin the build was configured for.
 */
function configuredBetaOrigin() {
  const origin = /^PUBLIC_SITE_ORIGIN=(.+)$/mu.exec(readFileSync('.env.beta', 'utf8'))?.[1]?.trim();
  if (!origin) fail('.env.beta does not configure PUBLIC_SITE_ORIGIN');
  return origin;
}

/** PIDs listening on the beta agent port right now. */
function agentListeners() {
  const result = spawnSync('lsof', ['-tiTCP:' + BETA_PROFILE.agentPort, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    shell: false
  });
  if (result.error) fail(`cannot check the beta agent port: ${result.error.message}`);
  return (result.stdout ?? '').split('\n').map(Number).filter(Number.isInteger).filter(Boolean);
}

/**
 * The whole process tree this journey started: the Node server that holds the
 * port, and the packaged app that launched it.
 *
 * Stopping only the listener leaves `Soty Beta.app` running under a temporary
 * HOME that this script is about to delete — a stranded app the next run would
 * then refuse to work around. The parent is included only when it really is the
 * packaged binary under test, so a listener that belongs to something else
 * cannot get its parent killed by association.
 */
function launchedProcessTree(app) {
  const tree = [];
  for (const listener of agentListeners()) {
    tree.push(listener);
    const parent = Number(
      spawnSync('ps', ['-o', 'ppid=', '-p', String(listener)], {
        encoding: 'utf8',
        shell: false
      }).stdout?.trim()
    );
    if (!Number.isInteger(parent) || parent <= 1) continue;
    const command =
      spawnSync('ps', ['-o', 'command=', '-p', String(parent)], {
        encoding: 'utf8',
        shell: false
      }).stdout ?? '';
    if (command.includes(`${app}/Contents/MacOS/`)) tree.push(parent);
  }
  return tree;
}

function fail(message) {
  process.stderr.write(`Beta runtime journey failed: ${message}\n`);
  process.exit(1);
}

const started = Date.now();
function remainingMs() {
  const left = DEADLINE_MS - (Date.now() - started);
  if (left <= 0) fail('the bounded runtime journey ran out of time');
  return left;
}

async function until(describe, probe, { attempts = 60, delayMs = 500 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    remainingMs();
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  fail(`${describe} (${last instanceof Error ? last.message : 'no response'})`);
}

/**
 * A short-lived beta entitlement, signed with the beta key.
 *
 * Minting it here is also the only way to prove the public key baked into the
 * packaged build is the counterpart of the beta private key: if they had
 * drifted apart, every entitled route in beta would be untestable.
 */
function betaEntitlementToken(subject) {
  const key = createPrivateKey(readFileSync(BETA_ENTITLEMENT_KEY));
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

async function main() {
  const app = path.resolve('release/beta/Soty Beta.app');
  for (const required of [app, BETA_ENTITLEMENT_KEY]) {
    try {
      statSync(required);
    } catch {
      fail(`${required} is missing; package beta first and keep the beta entitlement key local`);
    }
  }

  // Somebody else's beta is not this journey's to drive, and certainly not to
  // stop afterwards. The packaged agent holds a single-instance lock, so a
  // second launch would silently talk to theirs instead of the build under test.
  const preexisting = agentListeners();
  if (preexisting.length)
    fail(
      `a beta agent is already listening on ${BETA_PROFILE.agentPort} (pid ${preexisting.join(', ')}); ` +
        'stop it with npm run beta:down before verifying a packaged beta'
    );

  const origin = configuredBetaOrigin();
  const work = mkdtempSync(path.join(tmpdir(), 'soty-beta-runtime-'));
  const home = path.join(work, 'home');
  const media = path.join(work, 'media');
  const support = path.join(home, 'Library', 'Application Support', 'Soty Beta');
  mkdirSync(support, { recursive: true });
  mkdirSync(media, { recursive: true });

  const ffmpeg = path.join(app, 'Contents/Resources/runtime/bin/ffmpeg');
  const input = path.join(media, 'beta runtime input.mp4');
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      input
    ],
    { shell: false }
  );
  const jobId = 'beta-runtime-journey';
  writeFileSync(
    path.join(support, 'state.json'),
    JSON.stringify({
      jobs: [
        {
          id: jobId,
          inputPath: input,
          outputPath: path.join(media, 'beta runtime output.mp4'),
          fileName: 'beta runtime input.mp4',
          durationSeconds: 3,
          originalSize: statSync(input).size,
          finalSize: null,
          progress: 0,
          status: 'queued',
          error: null,
          preset: 'balanced',
          estimateStatus: 'waiting',
          estimatePreset: 'balanced'
        }
      ],
      settings: { preset: 'balanced', outputMode: 'next-to-originals', outputFolder: null }
    })
  );

  // A clean environment and a private HOME: this journey must not read or write
  // the developer's own beta state.
  spawnSync(
    'env',
    [
      '-i',
      'PATH=/usr/bin:/bin',
      '/usr/bin/open',
      '-n',
      '--env',
      'NO_OPEN=1',
      '--env',
      'WISHLY_ALLOW_UNINSTALLED_AGENT=1',
      '--env',
      'TMPDIR=/tmp',
      `--env`,
      `HOME=${home}`,
      '--stdout',
      path.join(work, 'agent.log'),
      '--stderr',
      path.join(work, 'agent.log'),
      app
    ],
    { shell: false, stdio: 'inherit' }
  );

  let stopped = false;
  /** Only what this run caused to exist is stopped by this run. */
  const stop = launched => {
    if (stopped) return;
    stopped = true;
    for (const pid of launched) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone between the probe and the signal.
      }
    }
    // Give the app a moment to let go of the port before the temporary HOME it
    // is reading disappears underneath it.
    for (let attempt = 0; attempt < 40 && agentListeners().length; attempt += 1) {
      spawnSync('sleep', ['0.1'], { shell: false });
    }
    for (const pid of agentListeners()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Nothing to do.
      }
    }
    rmSync(work, { recursive: true, force: true });
  };

  let launched = [];
  try {
    await until(
      'the packaged beta agent never became reachable',
      async () => (await fetch(`${AGENT}/health`)).ok
    );
    launched = launchedProcessTree(app);

    // Pairing is the real local login: the agent hands back a session token
    // through a redirect, exactly as the beta web app receives one.
    const pairing = await fetch(`${AGENT}/pair`, { redirect: 'manual' });
    const token = /#agentToken=([a-f0-9]{64})/u.exec(pairing.headers.get('location') ?? '')?.[1];
    if (!token) fail('pairing did not return a session token');

    const api = async (route, init = {}) => {
      const response = await fetch(`${AGENT}${route}`, {
        ...init,
        headers: { Origin: origin, 'x-session-token': token, ...(init.headers ?? {}) }
      });
      if (!response.ok) fail(`${route} answered ${response.status}`);
      return response.json();
    };

    const health = await api('/api/health');
    if (!health.ok) fail('the packaged beta agent reports ok=false');
    if (health.channel && health.channel !== 'beta')
      fail(`the packaged agent reports channel ${health.channel}, not beta`);
    if (health.entitlement?.enforced !== true)
      fail('beta must enforce the entitlement gate; an unenforced gate tests nothing');

    const entitlement = await api('/api/entitlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: betaEntitlementToken(jobId) })
    });
    if (!entitlement.entitled)
      fail('the beta entitlement token was refused; the packaged public key does not match');

    await api('/api/queue/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [jobId] })
    });
    const finished = await until(
      'the packaged beta never finished its short operation',
      async () => {
        const state = await api('/api/queue');
        const job = state.jobs?.find(candidate => candidate.id === jobId);
        if (job?.status === 'failed') fail(`the packaged operation failed: ${job.error}`);
        return job?.status === 'completed' ? job : null;
      },
      { attempts: 120, delayMs: 1000 }
    );
    if (!(statSync(finished.outputPath).size > 0))
      fail('the packaged operation produced no output');

    process.stdout.write(
      `Packaged beta authenticated, accepted a beta entitlement, and completed one operation ` +
        `in ${Math.round((Date.now() - started) / 1000)}s.\n`
    );
  } finally {
    stop(launched);
  }
}

await main();
