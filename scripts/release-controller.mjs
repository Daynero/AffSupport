#!/usr/bin/env node
import { readFile, mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TaskStore } from './lib/release/task-store.mjs';
import { ReleaseController } from './lib/release/controller.mjs';
import { createControllerRunner } from './lib/release/controller-runner.mjs';
import { createRepairExecutor } from './lib/release/repair-dispatch.mjs';
import { startPanelServer } from './lib/release/panel-server.mjs';
import { claimTarget, processIdentity } from './lib/release/target-ownership.mjs';
import {
  CodexProvider,
  validateAutomationPolicy,
  providerBoundaryDigest
} from './lib/release/codex-provider.mjs';
import { readIntent } from './lib/release/intent.mjs';
const exec = promisify(execFile);
const root = path.resolve(process.env.SOTY_RELEASE_RUNNER_DIR ?? 'release/automation');
const socketPath = path.join(root, 'controller.sock');
const configPath =
  process.env.SOTY_RELEASE_CONTROLLER_CONFIG ?? path.join(root, 'controller-config.json');
const loadConfig = async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const name of [
    'repositoryRoot',
    'executable',
    'capabilityPath',
    'bindingsPath',
    'assetsRoot'
  ])
    if (!path.isAbsolute(config[name] ?? '')) throw new Error('INVALID_CONTROLLER_CONFIG');
  return config;
};
async function runnerEnvironment(repositoryRoot) {
  const file = await readFile(
    path.join(repositoryRoot, 'release/automation/release-runner.env'),
    'utf8'
  );
  const allowed = new Set([
    'SOTY_RELEASE_PROBE',
    'SOTY_RELEASE_PROBE_DIGEST',
    'SOTY_RELEASE_BRIDGE_CONFIG',
    'BETA_RUNTIME_SOURCE_APP',
    'SOTY_RELEASE_GH',
    'NODE_BINARY',
    'FFMPEG_BINARY',
    'FFPROBE_BINARY',
    'WHISPER_BINARY',
    'WHISPER_VAD_MODEL',
    'FFMPEG_SOURCE_ARCHIVE',
    'X264_SOURCE_ARCHIVE'
  ]);
  const env = { ...process.env, SOTY_RELEASE_RUNNER_DIR: root };
  for (const line of file.split('\n').filter(Boolean)) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (index < 1 || !allowed.has(key)) throw new Error('INVALID_RUNNER_ENVIRONMENT');
    env[key] = line.slice(index + 1);
  }
  return env;
}
export function callController(operation, payload = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
          if (raw.length > 262144) req.destroy(new Error('CONTROLLER_REPLY_TOO_LARGE'));
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(raw);
            if (!result.ok) reject(new Error(result.error));
            else resolve(result.data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(60000, () => req.destroy(new Error('CONTROLLER_UNAVAILABLE')));
    req.on('error', reject);
    req.end(JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), operation, ...payload }));
  });
}
export async function serveController() {
  const config = await loadConfig();
  const policy = validateAutomationPolicy(
    JSON.parse(
      await readFile(new URL('../config/release-automation-policy.json', import.meta.url), 'utf8')
    )
  );
  const owner = await claimTarget(
    root,
    'release-controller',
    randomUUID(),
    await processIdentity()
  );
  if (!owner.acquired) throw new Error('CONTROLLER_ALREADY_RUNNING');
  let panel = null;
  let timer = null;
  const env = await runnerEnvironment(config.repositoryRoot);
  Object.assign(process.env, env);
  const runner = createControllerRunner({
    root,
    repositoryRoot: config.repositoryRoot,
    bindingsPath: config.bindingsPath,
    env
  });
  const store = new TaskStore(root);
  const repair = createRepairExecutor({ root, ...config, policy, runner });
  const controller = new ReleaseController({ root, store, runner, repair, policy });
  const control = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Error('INVALID_CONTROLLER_OPERATION');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 32768) throw new Error('CONTROLLER_REQUEST_TOO_LARGE');
      }
      const input = JSON.parse(raw);
      if (input.schemaVersion !== 1 || typeof input.requestId !== 'string')
        throw new Error('INVALID_CONTROLLER_REQUEST');
      let data;
      if (input.operation === 'accept') data = await controller.accept(input.intent);
      else if (input.operation === 'status' || input.operation === 'report')
        data = await controller.snapshot(await store.read(input.taskId));
      else if (input.operation === 'panel') {
        await store.read(input.taskId);
        data = { url: panel.bootstrapUrl(input.taskId) };
      } else if (input.operation === 'cancel')
        data = await controller.cancel(input.taskId, input.expectedRevision);
      else if (input.operation === 'decide')
        data = await controller.decide(input.taskId, input.expectedRevision, input.decision);
      else throw new Error('INVALID_CONTROLLER_OPERATION');
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          ok: false,
          error:
            error instanceof Error && /^[A-Z_]+$/.test(error.message)
              ? error.message
              : 'CONTROLLER_REQUEST_FAILED'
        })
      );
    }
  });
  const close = async () => {
    if (timer) clearInterval(timer);
    if (panel) await panel.close();
    control.closeAllConnections();
    await new Promise(resolve => control.close(() => resolve(undefined)));
    // Active workers survive controller exit; active repair ambiguity is durable.
    await unlink(socketPath).catch(() => {});
    await owner.release();
  };
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const socket = await lstat(socketPath).catch(e => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (socket) {
      if (!socket.isSocket()) throw new Error('CONTROLLER_SOCKET_CONFLICT');
      await unlink(socketPath);
    }
    panel = await startPanelServer({
      controller,
      assetsRoot: config.assetsRoot,
      port: policy.panelPort
    });
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(socketPath, () => resolve(undefined));
    });
    await chmod(socketPath, 0o600);
    await controller.recover();
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const taskId of controller.liveTasks)
          await controller
            .tick(taskId)
            .catch(e =>
              controller.block(
                taskId,
                e instanceof Error && /^[A-Z_]+$/.test(e.message)
                  ? e.message
                  : 'CONTROLLER_OBSERVATION_FAILED'
              )
            );
      } finally {
        busy = false;
      }
    };
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, 2000);
    process.once('SIGTERM', () => {
      void close().then(() => process.exit(0));
    });
    process.once('SIGINT', () => {
      void close().then(() => process.exit(0));
    });
    console.log(JSON.stringify({ ok: true, state: 'serving', origin: panel.origin }));
    return { controller, panel, close };
  } catch (error) {
    await close();
    throw error;
  }
}
async function main(argv) {
  const command = argv[0];
  const taskId = argv[1];
  if (command === 'serve') {
    await serveController();
    return;
  }
  if (command === 'doctor') {
    const config = await loadConfig();
    const receipt = JSON.parse(await readFile(config.capabilityPath, 'utf8'));
    const version = (await exec(config.executable, ['--version'], { timeout: 10000 })).stdout
      .trim()
      .replace(/^codex-cli\s+/, '');
    const provider = new CodexProvider({
      executable: config.executable,
      checkout: config.repositoryRoot
    });
    try {
      await provider.health();
      const ok =
        receipt.ready &&
        receipt.version === version &&
        receipt.checks?.untrustedPolicy === true &&
        receipt.boundaryDigest === (await providerBoundaryDigest());
      console.log(
        JSON.stringify({
          ok,
          managedAuth: true,
          version,
          capabilityReady: receipt.ready,
          productionActivation: 'requires actual G0 and three live sandbox records'
        })
      );
      if (!ok) process.exitCode = 1;
    } finally {
      provider.close();
    }
    return;
  }
  if (command === 'accept') {
    const index = argv.indexOf('--intent');
    if (index < 0 || !path.isAbsolute(argv[index + 1] ?? ''))
      throw new Error('ABSOLUTE_INTENT_REQUIRED');
    console.log(
      JSON.stringify({
        ok: true,
        data: await callController('accept', { intent: await readIntent(argv[index + 1]) })
      })
    );
    return;
  }
  if (['status', 'report', 'panel', 'cancel', 'decide'].includes(command)) {
    const status = await callController('status', { taskId });
    const data = await callController(command, {
      taskId,
      expectedRevision: status.revision,
      decision: argv[2]
    });
    if (command === 'panel') {
      console.log(data.url);
      return;
    }
    console.log(JSON.stringify({ ok: true, data }));
    return;
  }
  throw new Error('USAGE_RELEASE_CONTROLLER');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'CONTROLLER_UNAVAILABLE'
      })
    );
    process.exitCode = 1;
  });
}
