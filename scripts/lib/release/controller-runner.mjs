import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicRecord } from './task-store.mjs';
import { JournalObserver } from './observation.mjs';
import { processIdentity } from './target-ownership.mjs';
import { loadSnapshot, runDirectory } from './store.mjs';
import { validateProductionActivation } from './activation.mjs';
import { resolveTargetBinding } from './targets.mjs';
import { productionBinding } from './bindings.mjs';
import { intentDigest } from './intent.mjs';
const exec = promisify(execFile);
export function createControllerRunner({ root, repositoryRoot, bindingsPath, env = process.env }) {
  const observers = new Map();
  const command = async (args, environment = env) => {
    try {
      const { stdout } = await exec(process.execPath, [path.join(repositoryRoot, 'scripts/release-runner.mjs'), ...args],
        { cwd: repositoryRoot, env: environment, timeout: 60000, maxBuffer: 65536, shell: false });
      return JSON.parse(stdout.trim());
    } catch (error) {
      let code = 'RUNNER_COMMAND_FAILED';
      if (error instanceof Error && 'stdout' in error) {
        try { const result = JSON.parse(String(error.stdout).trim()); if (result.ok) return result; code = result.error?.code ?? code; } catch { /* no raw log leak */ }
      }
      throw new Error(code, { cause: error });
    }
  };
  const intentFile = async (intent) => {
    const file = path.join(root, 'intents', `${intent.runId}.json`);
    await atomicRecord(file, intent, true).catch(async (error) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (intentDigest(JSON.parse(await readFile(file, 'utf8'))) !== intentDigest(intent)) throw new Error('RUN_IDENTITY_CONFLICT');
    }); return file;
  };
  const frozenBinding = async (intent) => {
    const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
    const binding = resolveTargetBinding(intent, bindings);
    if (binding.repository !== intent.repository) throw new Error('RELEASE_REPOSITORY_SCOPE_MISMATCH');
    if (intent.targetKind === 'production') {
      const pinned = productionBinding();
      if (Object.keys(pinned).some((key) => binding[key] !== pinned[key])) throw new Error('PRODUCTION_BINDING_NOT_PINNED');
    }
    const file = path.join(root, 'bindings', `${intent.runId}.json`);
    await atomicRecord(file, binding, true).catch(async (error) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (JSON.parse(await readFile(file, 'utf8')).digest !== binding.digest) throw new Error('TARGET_BINDING_CHANGED');
    });
    return { binding, file };
  };
  return {
    async validate(intent) {
      await frozenBinding(intent);
      if (intent.targetKind === 'production') {
        await validateProductionActivation(root, repositoryRoot);
      }
      await command(['preflight', '--intent', await intentFile(intent), '--bindings', bindingsPath]);
    },
    async start(intent) {
      const { file } = await frozenBinding(intent);
      if (intent.targetKind === 'production') await validateProductionActivation(root, repositoryRoot);
      const environment = { ...env };
      environment.SOTY_RELEASE_HANDOFF_OWNER = 'controller';
      delete environment.SOTY_RELEASE_BINDING;
      if (intent.targetKind === 'sandbox') {
        environment.SOTY_RELEASE_BINDING = file;
      }
      return command(['start', '--intent', await intentFile(intent)], environment);
    },
    async cancel(runId) { return command(['cancel', runId]); },
    async stopped(runId) {
      const heartbeat = await readFile(path.join(runDirectory(runId), 'worker-heartbeat.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!heartbeat?.identity) throw new Error('WORKER_OWNERSHIP_AMBIGUOUS');
      const actual = await processIdentity(heartbeat.identity.pid);
      return !actual || actual.bootId !== heartbeat.identity.bootId || actual.startMarker !== heartbeat.identity.startMarker;
    },
    async observe(runId) {
      let observer = observers.get(runId);
      if (!observer) { observer = new JournalObserver(path.join(runDirectory(runId), 'journal.ndjson'), runId); observers.set(runId, observer); }
      const [run, events, heartbeat] = await Promise.all([loadSnapshot(runId), observer.read(),
        readFile(path.join(runDirectory(runId), 'worker-heartbeat.json'), 'utf8').then(JSON.parse).catch(() => null)]);
      const remote = [...events].reverse().find((e) => e.type === 'remote_progress');
      return { run, events, heartbeat, windowsUrl: remote?.payload.url ?? null };
    },
  };
}
