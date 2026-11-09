import { expect, it, vi } from 'vitest';
import { catalogVariantProcessAdapter } from '../apps/agent/src/team-bridge/catalog-variant-process';
import type { TeamProcessRequest } from '../apps/agent/src/team-bridge/process';
const id = '47000000-0000-4000-8000-000000000001',
  output = '47000000-0000-4000-8000-000000000002';
const child = {
  index: 0,
  requestId: '47000000-0000-4000-8000-000000000003',
  operationId: id,
  state: 'working' as const,
  outputId: null
};
const request = { operationId: id, toolId: 'restitch' } as TeamProcessRequest;
it('uses the existing process bridge and returns only a matching registered output', async () => {
  const bridge = {
    process: vi.fn(async () => ({
      operationId: id,
      state: 'succeeded' as const,
      materialId: output,
      reused: false
    })),
    cancel: vi.fn(() => true)
  };
  const execute = catalogVariantProcessAdapter({
    authorizeExecution: async () => true,
    bridge,
    claim: async () => request
  });
  expect(await execute(child, new AbortController().signal)).toEqual({ outputId: output });
  expect(bridge.process).toHaveBeenCalledWith(request);
});
it('refuses a different operation identity before starting local work', async () => {
  const bridge = { process: vi.fn(), cancel: vi.fn() };
  const execute = catalogVariantProcessAdapter({
    authorizeExecution: async () => true,
    bridge,
    claim: async () => ({ ...request, operationId: output })
  });
  await expect(execute(child, new AbortController().signal)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(bridge.process).not.toHaveBeenCalled();
});
it('joins cancellation through the existing bridge and preserves a registered race winner', async () => {
  const controller = new AbortController();
  const bridge = {
    process: vi.fn(async () => {
      controller.abort();
      return { operationId: id, state: 'succeeded' as const, materialId: output, reused: false };
    }),
    cancel: vi.fn(() => true)
  };
  const execute = catalogVariantProcessAdapter({
    authorizeExecution: async () => true,
    bridge,
    claim: async () => request
  });
  expect(await execute(child, controller.signal)).toEqual({ outputId: output });
  expect(bridge.cancel).toHaveBeenCalledWith(id);
});
it('never starts local work after an uncertain or previously consumed execution fence', async () => {
  const bridge = { process: vi.fn(), cancel: vi.fn() };
  const execute = catalogVariantProcessAdapter({
    bridge,
    claim: async () => request,
    authorizeExecution: async () => false
  });
  await expect(execute(child, new AbortController().signal)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(bridge.process).not.toHaveBeenCalled();
});
