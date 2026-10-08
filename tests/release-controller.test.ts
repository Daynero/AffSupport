import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../scripts/lib/release/task-store.mjs';
import { claimTarget } from '../scripts/lib/release/target-ownership.mjs';
import { ReleaseController } from '../scripts/lib/release/controller.mjs';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';
import { freezeProgress } from '../scripts/lib/release/progress.mjs';
import policy from '../config/release-automation-policy.json';

async function controllerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'release-state-test-'));
  const store = new TaskStore(root);
  const observed = {
    run: { runId: '', state: 'waiting_remote', currentStep: 'windows_smoke' },
    events: [] as any[],
    heartbeat: null
  };
  const runner = {
    validate: vi.fn(async () => {}),
    start: vi.fn(async (_intent?: unknown) => {}),
    cancel: vi.fn(async () => {}),
    stopped: vi.fn(async () => false),
    observe: vi.fn(async () => observed)
  };
  const repair = vi.fn(async () => {});
  const identity = { pid: 1, startMarker: 'test', bootId: 'boot' };
  const controller = new ReleaseController({
    root,
    store,
    runner,
    repair,
    policy,
    identity: async () => identity,
    inspect: async () => identity
  });
  const intent = {
    schemaVersion: 1,
    runId: randomUUID(),
    repository: 'test/sandbox',
    sourceSha: 'a'.repeat(40),
    version: '1.2.5',
    notes: { digest: 'b'.repeat(64) },
    targetId: 'test-sandbox',
    targetKind: 'sandbox',
    platforms: ['macos-arm64'],
    resourceProfile: {},
    createdAt: new Date().toISOString()
  };
  observed.run.runId = intent.runId;
  return { store, observed, runner, repair, controller, intent };
}

describe('deterministic release lifecycle', () => {
  it('invalidates old candidate progress without resetting the repair budget', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    f.observed.run.state = 'blocked';
    f.runner.stopped.mockResolvedValue(true);
    f.observed.events = [{ type: 'step_completed', payload: { stepId: 'prepare' } }];
    const newRun = randomUUID();
    let savedCallbacks: any;
    f.repair.mockImplementation(async (_task?: any, _observed?: any, callbacks?: any) => {
      savedCallbacks = callbacks;
      await callbacks.update({
        generation: 2,
        runId: newRun,
        candidates: [task.runId, newRun],
        plan: freezeProgress(),
        intent: { ...f.intent, runId: newRun, sourceSha: 'c'.repeat(40) },
        progressReason: 'Exact-SHA evidence invalidated',
        budget: { attempts: [{ executionId: 'repair' }], totalTokens: 50 }
      });
    });
    await f.controller.tick(task.taskId);
    await f.controller.active.get(task.taskId);
    const current = await f.store.read(task.taskId);
    expect(current.budget.totalTokens).toBe(50);
    expect((await f.controller.snapshot(current)).progress.percent).toBe(0);
    expect((await f.controller.snapshot(current)).progressReason).toContain('invalidated');
    await savedCallbacks.update({ budget: { attempts: [], totalTokens: 0 } });
    expect((await f.store.read(task.taskId)).budget.totalTokens).toBe(50);
  });
  it('backs off proven pre-execution delivery failure without charging an attempt', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    f.observed.run.state = 'blocked';
    f.runner.stopped.mockResolvedValue(true);
    f.repair.mockRejectedValueOnce(new Error('PROVIDER_UNAVAILABLE'));
    await f.controller.tick(task.taskId);
    await f.controller.active.get(task.taskId);
    const current = await f.store.read(task.taskId);
    expect(current.state).toBe('waiting');
    expect(current.budget.attempts).toHaveLength(0);
    expect(Date.parse(current.retryAt)).toBeGreaterThan(Date.now());
    await f.controller.tick(task.taskId);
    expect(f.repair).toHaveBeenCalledTimes(1);
  });
  it('does not retry lost acceptance as a new model turn', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    f.observed.run.state = 'blocked';
    f.runner.stopped.mockResolvedValue(true);
    f.repair.mockImplementation(async (_task?: any, _observed?: any, callbacks?: any) => {
      await callbacks.update({
        repair: { state: 'starting', threadId: 'known', executionId: randomUUID() }
      });
      throw new Error('PROVIDER_RPC_TIMEOUT');
    });
    await f.controller.tick(task.taskId);
    await f.controller.active.get(task.taskId);
    expect((await f.store.read(task.taskId)).blocker.code).toBe('AGENT_EXECUTION_AMBIGUOUS');
    await f.controller.tick(task.taskId);
    expect(f.repair).toHaveBeenCalledTimes(1);
  });
  it('resumes a stopped worker with the same intent, never resets candidate identity', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    f.runner.stopped.mockResolvedValue(true);
    await f.controller.tick(task.taskId);
    expect(f.runner.start).toHaveBeenCalledTimes(2);
    expect(f.runner.start.mock.calls[1]?.[0]).toEqual(f.intent);
    expect(f.repair).not.toHaveBeenCalled();
  });
  it('requires a real policy increase for cause quota retry and preserves counters', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    const cause = 'candidate_gate:GATE_FAILED';
    const budget = {
      totalTokens: 30,
      attempts: Array.from({ length: 3 }, (_, i) => ({
        executionId: String(i),
        cause,
        usage: { totalTokens: 10 },
        finished: true,
        activeMs: 1
      }))
    };
    await f.store.update(task.taskId, task.revision, { budget, lastCause: cause });
    await f.controller.block(task.taskId, 'REPAIR_CAUSE_BUDGET_EXHAUSTED');
    const current = await f.store.read(task.taskId);
    await expect(f.controller.decide(task.taskId, current.revision, 'retry')).rejects.toThrow(
      'OWNER_DECISION_REQUIRES_NEW_POLICY_OR_RECONCILIATION'
    );
    f.controller.policy = { ...policy, maxAttemptsPerCause: 4 };
    const resumed = await f.controller.decide(task.taskId, current.revision, 'retry');
    expect(resumed.budget.attempts).toHaveLength(3);
    expect(resumed.budget.totalTokens).toBe(30);
  });
  it('reconciles saved repair results on restart without opening another editor', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    await f.store.update(task.taskId, task.revision, {
      state: 'repairing',
      repair: { state: 'running', executionId: randomUUID() }
    });
    await f.controller.claims.get(task.taskId)?.release();
    const recover = vi.fn(async (_task, callbacks) => {
      await callbacks.update({ state: 'validating' });
    });
    const repair = Object.assign(f.repair, { recover });
    const identity = { pid: 1, startMarker: 'test', bootId: 'boot' };
    const restarted = new ReleaseController({
      root: f.controller.root,
      store: f.store,
      runner: f.runner,
      repair,
      policy,
      identity: async () => identity,
      inspect: async () => identity
    });
    await restarted.recover();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(f.repair).not.toHaveBeenCalled();
    expect((await f.store.read(task.taskId)).state).toBe('validating');
  });
  it('does not call models or restart workers during 5 and 60 minute waits', async () => {
    for (const minutes of [5, 60]) {
      const f = await controllerFixture();
      const task = await f.controller.accept(f.intent);
      for (let tick = 0; tick < minutes * 30; tick++) await f.controller.tick(task.taskId);
      expect(f.repair).not.toHaveBeenCalled();
      expect(f.runner.start).toHaveBeenCalledTimes(1);
      expect((await f.controller.snapshot(await f.store.read(task.taskId))).progress.percent).toBe(
        0
      );
    }
  });
  it('requires canonical proof, releases ownership only on final completion', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    await expect(f.controller.accept({ ...f.intent, runId: randomUUID() })).rejects.toThrow(
      'AUTOMATION_TASK_ALREADY_ACTIVE'
    );
    f.observed.run.state = 'completed';
    f.observed.events = STEP_IDS.map(stepId => ({ type: 'step_completed', payload: { stepId } }));
    await f.controller.tick(task.taskId);
    expect((await f.store.read(task.taskId)).state).not.toBe('completed');
    f.observed.events.push({ type: 'run_completed', payload: {} });
    await f.controller.tick(task.taskId);
    expect((await f.store.read(task.taskId)).state).toBe('completed');
    expect(f.controller.liveTasks.size).toBe(0);
  });
  it('waits for worker stop before repair and cancellation, fences late results', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    f.observed.run.state = 'blocked';
    await f.controller.tick(task.taskId);
    expect(f.repair).not.toHaveBeenCalled();
    f.runner.stopped.mockResolvedValue(true);
    let callbacks: any;
    let finish!: () => void;
    f.repair.mockImplementation(async (_task?: any, _observed?: any, cb?: any) => {
      callbacks = cb;
      await new Promise<void>(resolve => {
        finish = resolve;
      });
    });
    await f.controller.tick(task.taskId);
    expect(f.repair).toHaveBeenCalledTimes(1);
    const current = await f.store.read(task.taskId);
    await f.controller.cancel(task.taskId, current.revision);
    await callbacks.update({ state: 'running', generation: 900 });
    expect((await f.store.read(task.taskId)).state).toBe('cancelling');
    expect((await f.store.read(task.taskId)).generation).toBe(2);
    finish();
    await f.controller.active.get(task.taskId);
    await f.controller.tick(task.taskId);
    expect((await f.store.read(task.taskId)).state).toBe('cancelled');
  });
  it('preserves ambiguous accepted repair and refuses blind owner retry', async () => {
    const f = await controllerFixture();
    const task = await f.controller.accept(f.intent);
    await f.store.update(task.taskId, task.revision, {
      state: 'repairing',
      repair: { state: 'starting', threadId: 'thread', executionId: randomUUID() }
    });
    await f.controller.claims.get(task.taskId)?.release();
    const identity = { pid: 1, startMarker: 'test', bootId: 'boot' };
    const recovered = new ReleaseController({
      root: f.controller.root,
      store: f.store,
      runner: f.runner,
      repair: f.repair,
      policy,
      identity: async () => identity,
      inspect: async () => identity
    });
    await recovered.recover();
    const current = await f.store.read(task.taskId);
    expect(current.blocker.code).toBe('AGENT_EXECUTION_AMBIGUOUS');
    await expect(recovered.decide(task.taskId, current.revision, 'retry')).rejects.toThrow(
      'OWNER_DECISION_REQUIRES_NEW_POLICY_OR_RECONCILIATION'
    );
    expect(f.repair).not.toHaveBeenCalled();
  });
  it('preserves accepted task on runner failure and validates owner revision', async () => {
    const f = await controllerFixture();
    f.runner.start.mockRejectedValueOnce(new Error('ACCESS_MISSING'));
    const task = await f.controller.accept(f.intent);
    expect(task.state).toBe('needs_owner');
    expect(task.blocker.code).toBe('ACCESS_MISSING');
    await expect(f.controller.decide(task.taskId, 1, 'retry')).rejects.toThrow(
      'TASK_REVISION_CONFLICT'
    );
    await expect(f.controller.decide(task.taskId, task.revision, 'skip-gates')).rejects.toThrow(
      'INVALID_OWNER_DECISION'
    );
  });
});

describe('durable automation ownership', () => {
  it('fences revisions and rejects path traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'release-controller-test-'));
    const store = new TaskStore(root);
    const taskId = randomUUID();
    const task = await store.create({ taskId, generation: 1, state: 'accepted' });
    expect(task.revision).toBe(1);
    expect((await store.update(taskId, 1, { state: 'running' })).revision).toBe(2);
    await expect(store.update(taskId, 1, { state: 'completed' })).rejects.toThrow(
      'TASK_REVISION_CONFLICT'
    );
    await expect(store.read('../secret')).rejects.toThrow('INVALID_TASK_ID');
  });

  it('owns a target across different run IDs and safely reclaims dead identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'release-target-test-'));
    const identity = { pid: 1, startMarker: 'first', bootId: 'boot' };
    const first = await claimTarget(
      root,
      'soty-sandbox',
      randomUUID(),
      identity,
      async () => identity
    );
    expect(first.acquired).toBe(true);
    const conflict = await claimTarget(
      root,
      'soty-sandbox',
      randomUUID(),
      identity,
      async () => identity
    );
    expect(conflict.acquired).toBe(false);
    const adopted = await claimTarget(
      root,
      'soty-sandbox',
      randomUUID(),
      identity,
      async () => null
    );
    expect(adopted.acquired).toBe(true);
    await first.release(); // old owner cannot remove successor's lock
    expect(
      (await claimTarget(root, 'soty-sandbox', randomUUID(), identity, async () => identity))
        .acquired
    ).toBe(false);
    await adopted.release();
  });
});
