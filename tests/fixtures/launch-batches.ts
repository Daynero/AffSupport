import type {
  DurableLaunchBatch,
  LaunchBatchCommand,
  LaunchGeneration
} from '@video-compressor/shared';
export const batchUuid = (n: number) => `75000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function batchCommand(count = 4, key = 3): LaunchBatchCommand {
  return {
    teamId: batchUuid(1),
    expectedActorId: batchUuid(2),
    requestKey: batchUuid(key),
    items: Array.from({ length: count }, (_, n) => ({
      launchId: batchUuid(100 + n),
      expectedVersion: '1',
      childRequestKey: batchUuid(200 + n)
    }))
  };
}
export function batchReceipt(
  command = batchCommand(),
  state: LaunchGeneration['state'] = 'running'
): DurableLaunchBatch {
  return {
    id: batchUuid(4),
    teamId: command.teamId,
    requestKey: command.requestKey,
    createdAt: '2026-11-13T10:00:00.000Z',
    cancelRequestedAt: null,
    items: command.items.map((item, n) => ({
      ...item,
      admission: 'accepted',
      errorCode: null,
      generationId: batchUuid(300 + n),
      offer: n % 2 ? 'Cardio Plus' : 'Nutra Balance',
      social: `g${n + 1}`,
      agentId: `account${781 + n}`,
      agentSuffix: String(781 + n),
      generation: {
        id: batchUuid(300 + n),
        requestKey: item.childRequestKey,
        inputVersion: item.expectedVersion,
        state,
        stage: state === 'succeeded' ? 'result_committed' : 'catalog_creating',
        stateVersion: '1',
        progress: null,
        errorCode: null,
        childOperationIds: []
      }
    }))
  };
}
