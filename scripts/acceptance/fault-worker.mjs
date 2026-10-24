import { spawn } from 'node:child_process';
import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { parseFaultRequest, validateFaultDescriptor } from './fault-model.mjs';
import { terminateGateTree } from '../lib/gate-process-tree.mjs';

const workers = new WeakMap();
const fields = [
  'namespace',
  'faultId',
  'kind',
  'resourceKind',
  'actorId',
  'teamId',
  'operationId',
  'flowId',
  'ttlMs'
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(code)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function inspect(record) {
  if (record.session.closed) throw Error('ACCEPTANCE_FAULT_WORKER_CLOSED');
  const file = path.join(record.session.directory, 'recovery.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error('ACCEPTANCE_FAULT_CHECKPOINT_INVALID');
  const source = new URL('../../apps/agent/src/team-bridge/recovery-journal.ts', import.meta.url);
  const { RecoveryJournal } = await tsImport(source.href, import.meta.url);
  const data = await new RecoveryJournal(record.session.directory).load();
  const input = record.request,
    registration = data.registrations[0],
    checkpoint = data.checkpoints[0];
  if (
    data.registrations.length !== 1 ||
    data.checkpoints.length !== 1 ||
    registration.actorId !== input.actorId ||
    registration.teamId !== input.teamId ||
    registration.installationId !== input.faultId ||
    registration.delegationId !== input.flowId ||
    registration.account !== `soty-recovery-${input.faultId}` ||
    registration.endpoint !== 'http://127.0.0.1:54321/functions/v1/team-recovery' ||
    checkpoint.delegationId !== input.flowId ||
    checkpoint.requestId !== input.faultId ||
    checkpoint.operationId !== input.operationId ||
    checkpoint.stage !== 'accepted' ||
    checkpoint.reason !== null
  )
    throw Error('ACCEPTANCE_FAULT_CHECKPOINT_INVALID');
  return { checkpoint, sha256: digest(await readFile(file)) };
}
function owned(handle) {
  const record = workers.get(handle);
  if (!record) throw Error('ACCEPTANCE_FAULT_WORKER_UNOWNED');
  return record;
}
function start(session, request, mode) {
  if (session.closed) throw Error('ACCEPTANCE_FAULT_WORKER_CLOSED');
  if ([...session.records].some(record => !record.exited))
    throw Error('ACCEPTANCE_FAULT_WORKER_NOT_EXITED');
  if (session.records.size >= 4) throw Error('ACCEPTANCE_FAULT_WORKER_RESTART_LIMIT');
  let resolveReady = () => {};
  /** @type {(error: unknown) => void} */
  let rejectReady = () => {};
  /** @type {(value: unknown) => void} */
  let resolveExit = () => {};
  /** @type {Promise<void>} */
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise(resolve => {
    resolveExit = resolve;
  });
  ready.catch(() => undefined);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fault-worker-fixture.mjs', import.meta.url))],
    {
      cwd: session.directory,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true
    }
  );
  let exited = false,
    processing = false;
  const record = {
    child,
    session,
    request,
    ready,
    exit,
    get exited() {
      return exited;
    }
  };
  session.records.add(record);
  const timer = setTimeout(() => rejectReady(Error('ACCEPTANCE_FAULT_CHECKPOINT_TIMEOUT')), 10000);
  child.once('error', () => {
    exited = true;
    clearTimeout(timer);
    rejectReady(Error('ACCEPTANCE_FAULT_WORKER_START_FAILED'));
    resolveExit({ code: null, signal: null, failed: true });
  });
  child.once('exit', (code, signal) => {
    exited = true;
    clearTimeout(timer);
    rejectReady(Error('ACCEPTANCE_FAULT_WORKER_EXITED'));
    resolveExit({ code, signal });
  });
  child.on('message', async message => {
    if (processing) return;
    processing = true;
    try {
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        Object.keys(message).sort().join(',') !== 'faultId,kind' ||
        Reflect.get(message, 'kind') !== 'checkpoint' ||
        Reflect.get(message, 'faultId') !== request.faultId
      )
        throw Error('ACCEPTANCE_FAULT_CHECKPOINT_INVALID');
      await inspect(record);
      clearTimeout(timer);
      resolveReady();
    } catch {
      clearTimeout(timer);
      rejectReady(Error('ACCEPTANCE_FAULT_CHECKPOINT_INVALID'));
    }
  });
  child.once('spawn', () => {
    if (session.closed) {
      terminateGateTree(child);
      return;
    }
    const { namespace, ...input } = request;
    child.send({ mode, namespace, request: input }, error => {
      if (error) rejectReady(Error('ACCEPTANCE_FAULT_WORKER_START_FAILED'));
    });
  });
  const handle = Object.freeze({
    ready: () => ready,
    alive: () => !exited && child.exitCode === null && child.signalCode === null,
    checkpoint: async () => {
      await ready;
      return inspect(record);
    }
  });
  workers.set(handle, record);
  return handle;
}

/** Closed native fixture only. It uses real RecoveryJournal code and no server
 * credential, provider request, user profile or arbitrary executable/argument.
 */
export async function spawnCheckpointFixture(namespace, input) {
  const parsed = parseFaultRequest(input, namespace);
  if (!parsed.ok || parsed.value.kind !== 'worker_crash_after_checkpoint')
    throw Error('ACCEPTANCE_FAULT_INVALID');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-acceptance-checkpoint-'));
  return start(
    { directory, closed: false, cleaned: false, records: new Set() },
    parsed.value,
    'write'
  );
}
export async function restartCheckpointFixture(handle) {
  const record = owned(handle);
  if (!record.exited) throw Error('ACCEPTANCE_FAULT_WORKER_NOT_EXITED');
  return start(record.session, record.request, 'read');
}
export async function crashOwnedCheckpointFixture(entry, control, handle) {
  const record = owned(handle);
  if (
    !validateFaultDescriptor(entry) ||
    entry.kind !== 'worker_crash_after_checkpoint' ||
    fields.some(key => entry[key] !== record.request[key])
  )
    throw Error('ACCEPTANCE_FAULT_SCOPE_MISMATCH');
  await record.ready;
  const before = await inspect(record);
  if ((await control('claim'))?.ok !== true) return { fixtureOnly: true, crashed: false };
  await inspect(record);
  if ((await control('effect-start'))?.ok !== true) return { fixtureOnly: true, crashed: false };
  const requested = terminateGateTree(record.child);
  if (requested !== 'requested')
    return { fixtureOnly: true, crashed: null, code: 'ACCEPTANCE_FAULT_WORKER_UNCONFIRMED' };
  await bounded(record.exit, 5000, 'ACCEPTANCE_FAULT_WORKER_UNCONFIRMED');
  const after = await inspect(record);
  if (before.sha256 !== after.sha256) throw Error('ACCEPTANCE_FAULT_CHECKPOINT_CHANGED');
  return {
    fixtureOnly: true,
    crashed: true,
    checkpointSurvived: true,
    observationConfirmed: (await control('observe'))?.ok === true
  };
}
export async function cleanupCheckpointFixture(handle) {
  const record = owned(handle),
    session = record.session;
  if (session.cleaned) return;
  session.closed = true;
  for (const item of session.records) if (!item.exited) terminateGateTree(item.child);
  for (const item of session.records)
    await bounded(item.exit, 5000, 'ACCEPTANCE_FAULT_WORKER_CLEANUP_UNCONFIRMED');
  await rm(session.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  session.cleaned = true;
}
