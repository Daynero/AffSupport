import { describe, expect, it, vi } from 'vitest';
import { CreativeLibraryProcessBridge } from '../apps/agent/src/team-bridge/library.js';
import { resolveVideoThumbnailTimeMs } from '../apps/agent/src/team-bridge/thumbnail.js';

const grant = (purpose: 'process_input' | 'finalize') =>
  ({
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: '2026-08-14T11:00:00.000Z',
    maxRangeBytes: 1024,
    maxUses: 2
  }) as const;

function request() {
  return {
    operationId: 'operation-creative-1',
    teamId: '45000000-0000-4000-8000-000000000001',
    requirementId: '45000000-0000-4000-8000-000000000002',
    attemptId: '45000000-0000-4000-8000-000000000003',
    agentInstanceId: '45000000-0000-4000-8000-000000000004',
    kind: 'translation' as const,
    variant: 'uk',
    sourceVersion: 'v1',
    leaseToken: 'lease-token-with-enough-entropy-123',
    transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
    cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
    sourceGrant: grant('process_input'),
    finalizeGrant: grant('finalize'),
    options: { language: 'auto', targetLanguage: 'uk' }
  };
}

describe('Creative Library local-agent facade', () => {
  it('delegates to the existing process runtime and cancels by operation identity', async () => {
    let finish!: (value: {
      operationId: string;
      state: 'succeeded';
      materialId: string;
      reused: false;
    }) => void;
    const pending = new Promise<{
      operationId: string;
      state: 'succeeded';
      materialId: string;
      reused: false;
    }>(resolve => {
      finish = resolve;
    });
    const process = vi.fn(() => pending);
    const cancel = vi.fn(() => true);
    const bridge = new CreativeLibraryProcessBridge({ process: { process, cancel } as never });
    const first = bridge.process(request());
    expect(bridge.busy()).toBe(true);
    await expect(bridge.process(request())).rejects.toThrow('WRONG_STATE');
    expect(bridge.cancel(request().attemptId)).toBe(true);
    expect(cancel).toHaveBeenCalledWith(request().operationId);
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: request().operationId,
        toolId: 'translation',
        options: { language: 'auto', targetLanguage: 'uk' }
      })
    );
    finish({
      operationId: request().operationId,
      state: 'succeeded',
      materialId: '45000000-0000-4000-8000-000000000005',
      reused: false
    });
    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
    await Promise.resolve();
    expect(bridge.busy()).toBe(false);
  });

  it('uses exactly 1,000 ms for normal video thumbnails and a bounded short-clip fallback', () => {
    expect(resolveVideoThumbnailTimeMs(45_000)).toBe(1_000);
    expect(resolveVideoThumbnailTimeMs(600)).toBe(600);
    expect(resolveVideoThumbnailTimeMs(Number.NaN)).toBe(0);
  });
});
