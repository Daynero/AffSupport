import { expect, it, vi } from 'vitest';
import {
  NativeRestitchExecutor,
  type NativeRestitchCheckpoint,
  type NativeRestitchExecutionScope,
  type NativeRestitchExecutorIdentity
} from '../apps/agent/src/team-bridge/native-restitch-executor';
const id = (n: number) => `b1700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = () => ({ rootOperationId: id(1), teamId: id(2), actorId: id(3), claimId: id(4) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(retained: NativeRestitchCheckpoint[] = []) {
  const states: NativeRestitchCheckpoint[][] = [];
  let actor: string | null = id(3);
  const claim = vi.fn(async (scope: Readonly<NativeRestitchExecutorIdentity>) => ({
    ...scope,
    executorId: id(6),
    epoch: 1,
    active: true
  }));
  const quiesce = vi.fn(async () => true);
  const save = vi.fn(async (items: readonly NativeRestitchCheckpoint[]) => {
    states.push(structuredClone([...items]));
  });
  const create = (maxRetained = 8) =>
    new NativeRestitchExecutor({
      nativeInstanceId: id(5),
      maxRetained,
      currentActorId: () => actor,
      authority: { claim, quiesce },
      journal: { load: async () => retained, save }
    });
  return {
    create,
    claim,
    quiesce,
    save,
    states,
    actor: (value: string | null) => {
      actor = value;
    }
  };
}
async function turns() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

it('persists the original claim before authority mutation and runs work only after owned persistence', async () => {
  const f = fixture(),
    gate = deferred<void>();
  f.save.mockImplementationOnce(async items => {
    f.states.push(structuredClone([...items]));
    await gate.promise;
  });
  const owner = f.create();
  await owner.initialize();
  const work = vi.fn(async () => 7);
  const result = owner.execute(identity(), work);
  await turns();
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.states[0]?.[0]).toMatchObject({
    phase: 'claiming',
    identity: { ...identity(), nativeInstanceId: id(5), installedContract: 1 }
  });
  gate.resolve();
  expect(await result).toBe(7);
  expect(f.quiesce).toHaveBeenCalledTimes(1);
  expect(f.states.flat().some(state => state.phase === 'owned')).toBe(true);
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'quiescent', outcome: 'returned' });
});
it('joins original unawaited activity before claiming quiescence', async () => {
  const f = fixture(),
    active = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  let done = false;
  const result = owner
    .execute(identity(), async scope => {
      void scope.run(() => active.promise);
      return 9;
    })
    .then(value => {
      done = true;
      return value;
    });
  await turns();
  expect(owner.busy()).toBe(true);
  expect(done).toBe(false);
  expect(f.quiesce).not.toHaveBeenCalled();
  active.resolve();
  expect(await result).toBe(9);
  expect(owner.busy()).toBe(false);
});
it('cancels deferred claims without starting work and closes the exact eventual owner', async () => {
  const f = fixture(),
    gate = deferred<unknown>(),
    owner = f.create();
  await owner.initialize();
  f.claim.mockImplementationOnce(() => gate.promise as ReturnType<typeof f.claim>);
  const work = vi.fn(async () => 9);
  const result = owner.execute(identity(), work);
  const checked = expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
  await turns();
  owner.cancel(id(1));
  expect(owner.busy()).toBe(true);
  expect(f.quiesce).not.toHaveBeenCalled();
  gate.resolve({
    ...identity(),
    nativeInstanceId: id(5),
    executorId: id(6),
    epoch: 1,
    active: true
  });
  await checked;
  expect(work).not.toHaveBeenCalled();
  expect(f.quiesce).toHaveBeenCalledTimes(1);
});
it('keeps cancellation busy through actual activity and cleanup, including work that ignores abort', async () => {
  const f = fixture(),
    active = deferred<void>(),
    clean = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  const result = owner.execute(identity(), async scope => {
    scope.cleanup(() => clean.promise);
    await scope.run(() => active.promise);
  });
  const checked = expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
  await turns();
  expect(owner.cancel(id(1))).toBe(true);
  active.resolve();
  await turns();
  expect(owner.busy()).toBe(true);
  expect(f.quiesce).not.toHaveBeenCalled();
  clean.resolve();
  await checked;
  expect(owner.busy()).toBe(false);
  expect(f.quiesce).toHaveBeenCalledTimes(1);
});
it('closes global admission and joins active work during shutdown', async () => {
  const f = fixture(),
    active = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  const result = owner.execute(identity(), scope => scope.run(() => active.promise));
  const checked = expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
  await turns();
  let stopped = false;
  const stop = owner.shutdown().then(() => {
    stopped = true;
  });
  await turns();
  await expect(
    owner.execute({ ...identity(), rootOperationId: id(11) }, async () => 1)
  ).rejects.toMatchObject({ message: 'WRONG_STATE' });
  expect(stopped).toBe(false);
  active.resolve();
  await checked;
  await stop;
});
it('captures caller identity before persistence waits', async () => {
  const f = fixture(),
    gate = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  f.save.mockImplementationOnce(async () => gate.promise);
  const input = identity();
  const result = owner.execute(input, async () => 2);
  input.actorId = id(99);
  input.rootOperationId = id(98);
  gate.resolve();
  await result;
  expect(f.claim.mock.calls[0]?.[0]).toMatchObject(identity());
});
it('retains an unknown claim and refuses a fresh claim for that root', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.claim.mockRejectedValueOnce(Error('lost acknowledgement'));
  await expect(owner.execute(identity(), async () => 1)).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  await expect(
    owner.execute({ ...identity(), claimId: id(7) }, async () => 2)
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.claim).toHaveBeenCalledTimes(1);
  expect(f.quiesce).not.toHaveBeenCalled();
});
it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
  'refuses an invalid owned epoch %s before local work',
  async epoch => {
    const f = fixture(),
      owner = f.create();
    await owner.initialize();
    f.claim.mockImplementationOnce(async scope => ({
      ...scope,
      executorId: id(6),
      epoch,
      active: true
    }));
    const work = vi.fn(async () => 2);
    await expect(owner.execute(identity(), work)).rejects.toMatchObject({
      message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(work).not.toHaveBeenCalled();
    expect(f.quiesce).not.toHaveBeenCalled();
  }
);
it('persists one quiescence nonce and retains unknown service closure instead of admitting another epoch', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.quiesce.mockRejectedValueOnce(Error('lost closure'));
  await expect(owner.execute(identity(), async () => 1)).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  const retained = owner.snapshot(id(1));
  expect(retained).toMatchObject({ phase: 'blocked', reason: 'quiescence_unconfirmed' });
  expect(retained?.quiescenceId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(
    owner.execute({ ...identity(), claimId: id(8) }, async () => 2)
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.claim).toHaveBeenCalledTimes(1);
});
it('restores incomplete journal records as uncertainty without automatically taking ownership', async () => {
  const f = fixture(),
    first = f.create();
  await first.initialize();
  f.claim.mockRejectedValueOnce(Error('lost claim'));
  await expect(first.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  const saved = first.snapshot(id(1))!;
  const after = fixture([saved]),
    restarted = after.create();
  await restarted.initialize();
  await expect(
    restarted.execute({ ...identity(), claimId: id(10) }, async () => 1)
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(after.claim).not.toHaveBeenCalled();
});
it('rejects stale actor admission without claiming and stops new activity after an actor switch', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.actor(id(99));
  await expect(owner.execute(identity(), async () => 1)).rejects.toMatchObject({
    message: 'PERMISSION_DENIED'
  });
  expect(f.claim).not.toHaveBeenCalled();
  f.actor(id(3));
  const result = owner.execute(identity(), async scope => {
    f.actor(id(99));
    await scope.run(async () => 1);
  });
  await expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
});
it('refuses callbacks retained after the execution closes', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  let retained!: NativeRestitchExecutionScope;
  await owner.execute(identity(), async scope => {
    retained = scope;
  });
  const work = vi.fn(async () => 1);
  await expect(retained.run(work)).rejects.toMatchObject({ message: 'WRONG_STATE' });
  expect(work).not.toHaveBeenCalled();
});
it('never evicts uncertain records to make room for another operation', async () => {
  const f = fixture(),
    owner = f.create(1);
  await owner.initialize();
  f.claim.mockRejectedValueOnce(Error('lost claim'));
  await expect(owner.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  await expect(
    owner.execute({ ...identity(), rootOperationId: id(10) }, async () => 1)
  ).rejects.toMatchObject({ message: 'RATE_LIMITED' });
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'blocked' });
  expect(f.claim).toHaveBeenCalledTimes(1);
});
it('does not attest quiescence when owned cleanup cannot be confirmed', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  await expect(
    owner.execute(identity(), async scope => {
      scope.cleanup(async () => {
        throw Error('unconfirmed close');
      });
    })
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.quiesce).not.toHaveBeenCalled();
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'blocked', reason: 'activity_unconfirmed' });
});

it('does not dispatch a claim after cancellation during the original journal write', async () => {
  const f = fixture(),
    gate = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  f.save.mockImplementationOnce(async () => gate.promise);
  const result = owner.execute(identity(), async () => 1);
  const checked = expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
  await turns();
  owner.cancel(id(1));
  gate.resolve();
  await checked;
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.quiesce).not.toHaveBeenCalled();
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'not_claimed', outcome: 'canceled' });
});

it('does not deliver a late work result after the active actor changes', async () => {
  const f = fixture(),
    gate = deferred<number>(),
    owner = f.create();
  await owner.initialize();
  const result = owner.execute(identity(), scope => scope.run(() => gate.promise));
  const checked = expect(result).rejects.toMatchObject({ message: 'PROCESS_CANCELED' });
  await turns();
  f.actor(id(99));
  gate.resolve(7);
  await checked;
  expect(f.quiesce).toHaveBeenCalledTimes(1);
  expect(owner.snapshot(id(1))).toBeNull();
});

it('aborts sibling activity on global failure while preserving the original failure', async () => {
  const f = fixture(),
    gate = deferred<void>(),
    owner = f.create();
  await owner.initialize();
  const failure = Error('DRIVE_UNAVAILABLE');
  let signal!: AbortSignal;
  const result = owner.execute(identity(), async scope => {
    void scope.run(() => {
      signal = scope.signal;
      return gate.promise;
    });
    await Promise.resolve();
    throw failure;
  });
  const checked = expect(result).rejects.toBe(failure);
  await turns();
  const abortedBeforeDrain = signal.aborted;
  gate.resolve();
  await checked;
  expect(abortedBeforeDrain).toBe(true);
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'quiescent', outcome: 'rejected' });
});
it('retains unknown ownership after a cancelled claim loses its acknowledgement', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.claim.mockImplementationOnce(async scope => {
    owner.cancel(scope.rootOperationId);
    throw Error('lost claim');
  });
  await expect(owner.execute(identity(), async () => 1)).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(owner.snapshot(id(1))).toMatchObject({ phase: 'blocked', reason: 'claim_unconfirmed' });
  expect(f.quiesce).not.toHaveBeenCalled();
});

it('joins rejected unawaited activity without creating an unhandled wrapper rejection', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  const result = await owner.execute(identity(), async scope => {
    void scope.run(async () => {
      throw Error('handled by owner join');
    });
    return 1;
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(result).toBe(1);
  expect(f.quiesce).toHaveBeenCalledTimes(1);
});

it('reconciles a lost closure with the original nonce after all local work stopped, without a new claim', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.quiesce.mockRejectedValueOnce(Error('lost closure'));
  await expect(owner.execute(identity(), async () => 7)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  const nonce = owner.snapshot(id(1))!.quiescenceId;
  expect(await owner.reconcileClosure(id(1))).toBe(true);
  expect(f.claim).toHaveBeenCalledTimes(1);
  expect(f.quiesce).toHaveBeenCalledTimes(2);
  expect(f.quiesce.mock.calls[1]).toEqual(f.quiesce.mock.calls[0]);
  expect(owner.snapshot(id(1))).toMatchObject({
    phase: 'quiescent',
    quiescenceId: nonce,
    outcome: 'returned'
  });
});

it('never turns an unknown claim or a restarted journal into locally observed closure', async () => {
  const f = fixture(),
    first = f.create();
  await first.initialize();
  f.claim.mockRejectedValueOnce(Error('lost claim'));
  await expect(first.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  await expect(first.reconcileClosure(id(1))).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.quiesce).not.toHaveBeenCalled();
  const g = fixture(),
    original = g.create();
  await original.initialize();
  g.quiesce.mockRejectedValueOnce(Error('lost closure'));
  await expect(original.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  const restartedFixture = fixture([original.snapshot(id(1))!]),
    restarted = restartedFixture.create();
  await restarted.initialize();
  await expect(restarted.reconcileClosure(id(1))).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(restartedFixture.quiesce).not.toHaveBeenCalled();
});

it('owns deferred closure reconciliation during duplicate requests and shutdown', async () => {
  const f = fixture(),
    owner = f.create(),
    gate = deferred<boolean>();
  await owner.initialize();
  f.quiesce.mockRejectedValueOnce(Error('lost closure'));
  await expect(owner.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  f.quiesce.mockImplementationOnce(() => gate.promise);
  const result = owner.reconcileClosure(id(1));
  const duplicate = owner.reconcileClosure(id(1));
  await turns();
  expect(owner.busy()).toBe(true);
  await expect(
    owner.execute({ ...identity(), claimId: id(9) }, async () => 1)
  ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  let stopped = false;
  const stop = owner.shutdown().then(() => {
    stopped = true;
  });
  await turns();
  expect(stopped).toBe(false);
  gate.resolve(true);
  expect(await result).toBe(true);
  expect(await duplicate).toBe(true);
  await stop;
  expect(f.quiesce).toHaveBeenCalledTimes(2);
  expect(owner.busy()).toBe(false);
});

it('does not expose old-actor closure recovery or admit work after shutdown', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.initialize();
  f.quiesce.mockRejectedValueOnce(Error('lost closure'));
  await expect(owner.execute(identity(), async () => 1)).rejects.toBeInstanceOf(Error);
  f.actor(id(99));
  await expect(owner.reconcileClosure(id(1))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.quiesce).toHaveBeenCalledTimes(1);
  f.actor(id(3));
  await owner.shutdown();
  await expect(owner.reconcileClosure(id(1))).rejects.toMatchObject({ code: 'WRONG_STATE' });
});
it('recovers only a persisted drained checkpoint through verified original cancellation metadata, never a fresh claim or media run', async () => {
  const checkpoint: NativeRestitchCheckpoint = {
    identity: { ...identity(), nativeInstanceId: id(55), installedContract: 1 },
    receipt: { executorId: id(6), epoch: 3 },
    quiescenceId: id(77),
    phase: 'blocked',
    reason: 'quiescence_unconfirmed',
    outcome: 'rejected',
    touchedAt: new Date().toISOString()
  };
  const f = fixture([checkpoint]),
    executor = f.create();
  await executor.initialize();
  const verify = vi.fn(async (saved: Readonly<NativeRestitchCheckpoint>) => {
    expect(saved.identity.nativeInstanceId).toBe(id(55));
    expect(saved.quiescenceId).toBe(id(77));
    return true;
  });
  expect(await executor.reconcileVerifiedCancellation(id(1), verify)).toBe(true);
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.quiesce).not.toHaveBeenCalled();
  expect(executor.snapshot(id(1))).toMatchObject({
    phase: 'quiescent',
    outcome: 'rejected',
    quiescenceId: id(77)
  });
});
it.each(['interrupted', 'activity_unconfirmed', 'claim_unconfirmed'] as const)(
  'does not turn %s or a restarted boot into cancellation quiescence proof',
  async reason => {
    const f = fixture([
        {
          identity: { ...identity(), nativeInstanceId: id(55), installedContract: 1 },
          receipt: { executorId: id(6), epoch: 3 },
          quiescenceId: id(77),
          phase: 'blocked',
          reason,
          outcome: 'rejected',
          touchedAt: new Date().toISOString()
        }
      ]),
      executor = f.create();
    await executor.initialize();
    const verify = vi.fn();
    await expect(executor.reconcileVerifiedCancellation(id(1), verify)).rejects.toThrow(
      'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    );
    expect(verify).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
  }
);
