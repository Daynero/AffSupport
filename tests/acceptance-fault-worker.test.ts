import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { armFaultDescriptor, transitionFault } from '../scripts/acceptance/fault-model.mjs';
import {
  spawnCheckpointFixture,
  crashOwnedCheckpointFixture,
  restartCheckpointFixture,
  cleanupCheckpointFixture
} from '../scripts/acceptance/fault-worker.mjs';
const namespace = 'acceptance-worker-checkpoint';
const request = () => ({
  faultId: randomUUID(),
  kind: 'worker_crash_after_checkpoint',
  actorId: randomUUID(),
  teamId: randomUUID(),
  operationId: randomUUID(),
  flowId: randomUUID(),
  ttlMs: 30000
});
function controller(initial: ReturnType<typeof armFaultDescriptor>) {
  let entry = initial;
  const scope = {
    namespace,
    actorId: entry.actorId,
    teamId: entry.teamId,
    operationId: entry.operationId,
    flowId: entry.flowId,
    phase: 'checkpoint'
  };
  return vi.fn(async (action: string) => {
    const result = transitionFault(entry, scope, action, Date.now());
    if (result.ok) entry = result.entry;
    return result;
  });
}
it('crashes only its owned fixture after actual RecoveryJournal readback and cold-reloads the checkpoint', async () => {
  const input = request(),
    entry = armFaultDescriptor(input, namespace, Date.now());
  const worker = await spawnCheckpointFixture(namespace, input);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore'
  });
  try {
    await worker.ready();
    const before = await worker.checkpoint();
    const control = controller(entry);
    expect(await crashOwnedCheckpointFixture(entry, control, worker)).toMatchObject({
      fixtureOnly: true,
      crashed: true,
      checkpointSurvived: true,
      observationConfirmed: true
    });
    expect(unrelated.exitCode).toBe(null);
    expect(unrelated.signalCode).toBe(null);
    const restarted = await restartCheckpointFixture(worker);
    await restarted.ready();
    expect(await restarted.checkpoint()).toEqual(before);
    await expect(restartCheckpointFixture(worker)).rejects.toThrow(
      'ACCEPTANCE_FAULT_WORKER_NOT_EXITED'
    );
    expect(control.mock.calls.map(call => call[0])).toEqual(['claim', 'effect-start', 'observe']);
  } finally {
    await cleanupCheckpointFixture(worker);
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const exited = once(unrelated, 'exit');
      unrelated.kill('SIGKILL');
      await exited;
    }
  }
}, 20000);
it('refuses PID-shaped or forged handles before any controller or process action', async () => {
  const entry = armFaultDescriptor(request(), namespace, Date.now());
  const control = vi.fn();
  await expect(crashOwnedCheckpointFixture(entry, control, { pid: process.pid })).rejects.toThrow(
    'ACCEPTANCE_FAULT_WORKER_UNOWNED'
  );
  expect(control).not.toHaveBeenCalled();
});
it('refuses command, path and PID configuration before spawning a fixture', async () => {
  for (const key of ['command', 'path', 'pid'])
    await expect(
      spawnCheckpointFixture(namespace, { ...request(), [key]: 'foreign' })
    ).rejects.toThrow('ACCEPTANCE_FAULT_INVALID');
});
it('does not crash a worker when the verified fault expires or is cleared before effect start', async () => {
  const input = request(),
    entry = armFaultDescriptor(input, namespace, Date.now());
  const worker = await spawnCheckpointFixture(namespace, input);
  try {
    await worker.ready();
    const control = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    expect(await crashOwnedCheckpointFixture(entry, control, worker)).toMatchObject({
      crashed: false,
      fixtureOnly: true
    });
    expect(worker.alive()).toBe(true);
    expect(control.mock.calls.map(call => call[0])).toEqual(['claim', 'effect-start']);
  } finally {
    await cleanupCheckpointFixture(worker);
  }
}, 15000);
it('does not apply a valid worker handle to another actor or operation scope', async () => {
  const input = request(),
    worker = await spawnCheckpointFixture(namespace, input);
  try {
    await worker.ready();
    const control = vi.fn();
    const entry = armFaultDescriptor({ ...input, actorId: randomUUID() }, namespace, Date.now());
    await expect(crashOwnedCheckpointFixture(entry, control, worker)).rejects.toThrow(
      'ACCEPTANCE_FAULT_SCOPE_MISMATCH'
    );
    expect(control).not.toHaveBeenCalled();
    expect(worker.alive()).toBe(true);
  } finally {
    await cleanupCheckpointFixture(worker);
  }
}, 15000);
