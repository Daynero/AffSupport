#!/usr/bin/env node
/** Native boundary probe and bounded packaged-beta observation recorder.
 * This command does not infer acceptance from collected snapshots.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  isNativeUpdateSnapshot,
  NATIVE_UPDATE_STAGES,
  NATIVE_UPDATE_LIMITS
} from '../packages/shared/dist/native-app-updates.js';
import { NATIVE_UPDATE_QUALIFICATION_CASES } from './lib/native-update-qualification.mjs';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes('--native-boundaries')) {
  if (process.platform !== 'darwin') throw new Error('NATIVE_PROBE_MACOS_REQUIRED');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-native-boundaries-'));
  try {
    const policy = path.join(directory, 'Policy.swift');
    await writeFile(
      policy,
      `enum NativeUpdateBuildPolicy { static let artifactPrefix = "https://invalid.test"; static let frameBytes = ${NATIVE_UPDATE_LIMITS.frameBytes}; static let canonicalPayloadBytes = ${NATIVE_UPDATE_LIMITS.canonicalPayloadBytes}; static let historyEntries = ${NATIVE_UPDATE_LIMITS.historyEntries}; static let archiveBytes: Int64 = ${NATIVE_UPDATE_LIMITS.archiveBytes} }\n`
    );
    const binary = path.join(directory, 'probe');
    await exec(
      '/usr/bin/nice',
      [
        '-n',
        '15',
        '/usr/bin/swiftc',
        '-j',
        '1',
        '-module-cache-path',
        process.env.SOTY_NATIVE_MODULE_CACHE ?? path.join(directory, 'module-cache'),
        'packaging/NativeUpdates/Models.swift',
        'packaging/NativeUpdates/ReceiptStore.swift',
        'packaging/NativeUpdates/Recovery.swift',
        'packaging/NativeUpdates/Readiness.swift',
        policy,
        'packaging/NativeUpdates/Tests/main.swift',
        '-o',
        binary
      ],
      { timeout: 120000 }
    );
    const { stdout } = await exec(binary, [], { timeout: 30000 });
    process.stdout.write(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else if (args.includes('--capture')) {
  const scenario = option('scenario');
  const output = option('output');
  const origin = new URL(option('origin') ?? 'http://127.0.0.1:43140');
  const until = option('until') ?? 'ui_visible';
  const fault = option('fault');
  if (
    !scenario ||
    !NATIVE_UPDATE_QUALIFICATION_CASES.includes(scenario) ||
    !output ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.port !== '43140' ||
    !NATIVE_UPDATE_STAGES.some(stage => stage === until) ||
    (fault && !NATIVE_UPDATE_STAGES.some(stage => stage === fault))
  )
    throw new Error('NATIVE_PROBE_ARGUMENTS');
  const session = process.env.SOTY_UPDATE_PROBE_SESSION_TOKEN;
  if (!session) throw new Error('NATIVE_PROBE_SESSION_REQUIRED');
  const observations = [];
  let owned = null;
  let faulted = false;
  const app = option('launch');
  if (app) {
    if (path.basename(app) !== 'Soty Beta.app') throw new Error('NATIVE_PROBE_BETA_APP_REQUIRED');
    const release = JSON.parse(
      await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')
    );
    if (release.channel !== 'beta') throw new Error('NATIVE_PROBE_BETA_IDENTITY');
    owned = spawn(path.join(app, 'Contents/MacOS/SotyBetaAgent'), [], {
      stdio: 'ignore',
      env: { ...process.env, NO_OPEN: '1' }
    });
  }
  if (fault && !owned) throw new Error('NATIVE_PROBE_FAULT_REQUIRES_OWNED_HOST');
  const read = async route => {
    const response = await fetch(new URL(route, origin), {
      headers: { 'x-session-token': session },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('NATIVE_PROBE_READ_FAILED');
    const text = await response.text();
    if (text.length > 262144) throw new Error('NATIVE_PROBE_FRAME_LIMIT');
    return JSON.parse(text);
  };
  const started = Date.now();
  let consecutiveUnavailable = 0;
  try {
    while (Date.now() - started < 10 * 60_000 && observations.length < 5000) {
      try {
        const health = await read('/api/health');
        if (health.environment !== 'beta' || health.channel !== 'beta')
          throw new Error('NATIVE_PROBE_NON_BETA');
        const state = await read('/api/app-update');
        if (!isNativeUpdateSnapshot(state)) throw new Error('NATIVE_PROBE_INVALID_SNAPSHOT');
        consecutiveUnavailable = 0;
        const previous = observations.at(-1);
        if (
          !previous ||
          previous.state.revision !== state.revision ||
          previous.state.stage !== state.stage
        )
          observations.push({
            at: Date.now(),
            state,
            buildId: health.buildId,
            sourceRevision: health.sourceRevision
          });
        if (fault && state.stage === fault && !faulted) {
          if (!owned?.pid || owned.exitCode !== null)
            throw new Error('NATIVE_PROBE_OWNERSHIP_LOST');
          owned.kill('SIGKILL');
          faulted = true;
        }
        if (state.stage === until || (faulted && consecutiveUnavailable > 2)) break;
      } catch (error) {
        if (error instanceof Error && error.message === 'NATIVE_PROBE_NON_BETA') throw error;
        consecutiveUnavailable++;
        if (faulted && consecutiveUnavailable >= 3) break;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  } finally {
    const sourceSha = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const record = {
      schemaVersion: 1,
      kind: 'native-update-observation',
      status: 'unreviewed',
      sourceSha,
      scenario,
      startedAt: started,
      finishedAt: Date.now(),
      faulted,
      controlledRuntimeOnly: true,
      observations
    };
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({
        output: path.resolve(output),
        sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        observations: observations.length,
        status: 'unreviewed'
      }) + '\n'
    );
    // A surviving host is deliberately left to the tester; no unrelated app is stopped.
  }
} else {
  process.stdout.write(
    'Usage: --native-boundaries | --capture --scenario=<case> --output=<file> [--launch=<Soty Beta.app>] [--fault=<stage>] [--until=<stage>]\n'
  );
}
