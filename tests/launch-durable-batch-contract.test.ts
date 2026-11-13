import { expect, it, vi } from 'vitest';
import {
  parseLaunchBatchCommand,
  parseDurableLaunchBatch,
  parseDurableLaunchBatchList
} from '../packages/shared/src/team/launch-batch';
import { acceptLaunchBatch } from '../supabase/functions/drive-ops/launch-batch';
import { launchConfig, launchSources } from './fixtures/launches';
const id = (n: number) => 'd0530000-0000-4000-8000-' + String(n).padStart(12, '0');
const command = {
  teamId: id(1),
  expectedActorId: id(2),
  requestKey: id(3),
  items: [{ launchId: id(4), expectedVersion: '3', childRequestKey: id(5) }]
};
function receipt() {
  return {
    id: id(6),
    teamId: command.teamId,
    requestKey: command.requestKey,
    createdAt: '2026-11-13T10:00:00Z',
    cancelRequestedAt: null,
    items: [
      {
        ...command.items[0]!,
        admission: 'accepted',
        errorCode: null,
        generationId: id(7),
        offer: 'Offer',
        social: 'g1',
        agentId: '1234567892',
        agentSuffix: '892',
        cancelPending: false,
        cancelErrorCode: null,
        generation: {
          id: id(7),
          state: 'accepted',
          stage: 'accepted',
          stateVersion: '1',
          attemptNo: 1,
          requestKey: id(5),
          inputVersion: '3',
          startedAt: '2026-11-13T10:00:00Z',
          errorCode: null,
          childOperationIds: [],
          progress: null,
          videoGeneration: null
        }
      }
    ]
  };
}
const config = launchConfig();
const sources = {
  ...launchSources,
  schemaVersion: 1,
  agentRowId: config.agentRowId,
  offerId: config.offerId,
  buyerId: config.buyerId,
  materialId: config.materialId,
  catalogSettingsVersion: null
};
it('rejects duplicate launch/key intent, oversized selection and unsafe CAS versions', () => {
  expect(parseLaunchBatchCommand(command)).toEqual(command);
  for (const items of [
    [command.items[0], command.items[0]],
    [command.items[0], { ...command.items[0], launchId: id(8) }],
    Array.from({ length: 101 }, (_, i) => ({
      launchId: id(i + 100),
      childRequestKey: id(i + 300),
      expectedVersion: '1'
    })),
    [{ ...command.items[0], expectedVersion: '9223372036854775808' }]
  ])
    expect(parseLaunchBatchCommand({ ...command, items })).toBeNull();
  expect(parseLaunchBatchCommand({ ...command, expectedActorId: 'different-user' })).toBeNull();
});
it('binds the projected generation to both immutable member key and selected version', () => {
  const valid = receipt();
  expect(parseDurableLaunchBatch(valid)).not.toBeNull();
  for (const generation of [
    { ...valid.items[0]!.generation, id: id(9) },
    { ...valid.items[0]!.generation, requestKey: id(9) },
    { ...valid.items[0]!.generation, inputVersion: '4' }
  ])
    expect(
      parseDurableLaunchBatch({ ...valid, items: [{ ...valid.items[0], generation }] })
    ).toBeNull();
  expect(
    parseDurableLaunchBatch({
      ...valid,
      items: [{ ...valid.items[0], admission: 'refused', errorCode: 'SOURCE_CHANGED' }]
    })
  ).toBeNull();
  expect(
    parseDurableLaunchBatch({
      ...valid,
      items: [{ ...valid.items[0], cancelErrorCode: 'https://private.invalid' }]
    })
  ).toBeNull();
});
it('requires pagination continuation to name the last exact observed batch', () => {
  const batch = receipt();
  expect(
    parseDurableLaunchBatchList({
      items: [batch],
      hasMore: true,
      nextCursor: { createdAt: batch.createdAt, id: batch.id }
    })
  ).not.toBeNull();
  for (const nextCursor of [
    null,
    { createdAt: batch.createdAt, id: id(9) },
    { createdAt: '2026-11-12T10:00:00Z', id: batch.id }
  ])
    expect(parseDurableLaunchBatchList({ items: [batch], hasMore: true, nextCursor })).toBeNull();
  expect(
    parseDurableLaunchBatchList({
      items: [],
      hasMore: true,
      nextCursor: { createdAt: batch.createdAt, id: batch.id }
    })
  ).toBeNull();
});
it('replays a committed batch before touching live sources or preparing new plans', async () => {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: { batch: receipt() },
    error: null
  }));
  expect(await acceptLaunchBatch({ rpc }, command.expectedActorId, command)).toEqual(
    parseDurableLaunchBatch(receipt())
  );
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]![0]).toBe('service_launch_batch_context');
});
it('persists per-item transient metadata waits for automatic retry', async () => {
  const value = receipt();
  const pending = {
    ...value,
    items: [
      {
        ...value.items[0],
        admission: 'pending',
        errorCode: 'DRIVE_UNAVAILABLE',
        generationId: null,
        generation: null,
        admissionAttempts: 1,
        admissionNextAttemptAt: '2026-11-13T10:00:30Z'
      }
    ]
  };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    data:
      name === 'service_launch_batch_context'
        ? { items: [{ ...command.items[0], config, sources, errorCode: 'DRIVE_UNAVAILABLE' }] }
        : pending,
    error: null
  }));
  expect(
    (await acceptLaunchBatch({ rpc }, command.expectedActorId, command)).items[0]!.admission
  ).toBe('pending');
  expect(rpc).toHaveBeenCalledTimes(2);
});
it('does not accept reordered or wrong-version preparation context', async () => {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: { items: [{ ...command.items[0], launchId: id(9), config, sources, errorCode: null }] },
    error: null
  }));
  await expect(acceptLaunchBatch({ rpc }, command.expectedActorId, command)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('derives previews on the server and forwards only the selected immutable intent', async () => {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    data:
      name === 'service_launch_batch_context'
        ? { items: [{ ...command.items[0], config, sources, errorCode: null }] }
        : receipt(),
    error: null
  }));
  await acceptLaunchBatch({ rpc }, command.expectedActorId, {
    ...command,
    preview: { unsafe: 'browser' }
  });
  const args = rpc.mock.calls.find(
    ([name]) => name === 'service_accept_launch_batch'
  )![1] as Record<string, unknown>;
  expect(args.p_intent).toEqual(command);
  expect(args.p_prepared).toEqual([
    expect.objectContaining({
      launchId: command.items[0]!.launchId,
      expectedVersion: '3',
      config,
      sources,
      errorCode: null,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      preview: expect.objectContaining({ campaigns: expect.any(Array) })
    })
  ]);
});

it('prepares single-budget batch campaigns from stored settings rather than dividing the amount', async () => {
  const single = { ...config, budgetMode: 'single', campaignCount: 3, maxBudget: 20 };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    data:
      name === 'service_launch_batch_context'
        ? { items: [{ ...command.items[0], config: single, sources, errorCode: null }] }
        : receipt(),
    error: null
  }));
  await acceptLaunchBatch({ rpc }, command.expectedActorId, command);
  const args = rpc.mock.calls.find(([name]) => name === 'service_accept_launch_batch')![1];
  expect(args.p_prepared).toEqual([
    expect.objectContaining({
      config: single,
      errorCode: null,
      preview: expect.objectContaining({
        campaigns: [
          expect.objectContaining({ ordinal: 1, budget: 20, adStart: 1, adEnd: 3 }),
          expect.objectContaining({ ordinal: 2, budget: 20, adStart: 4, adEnd: 6 }),
          expect.objectContaining({ ordinal: 3, budget: 20, adStart: 7, adEnd: 9 })
        ]
      })
    })
  ]);
});
