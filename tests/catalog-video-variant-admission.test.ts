import { it, expect, vi } from 'vitest';
import { RESTITCH_CONTRACT_VERSION } from '../packages/shared/src/team/restitch';
import { admitCatalogVideoVariant } from '../supabase/functions/drive-ops/catalog-video-variant-admission';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
const id = (n: number) => 'c1800000-0000-4000-8000-' + String(n).padStart(12, '0');
it('admits the first N child through the current restitch process contract instead of the obsolete version1', async () => {
  const original = {
    setId: id(1),
    nativeInstanceId: id(2),
    claimHash: '\\x' + 'a'.repeat(64),
    protocolVersion: 1 as const,
    index: 0,
    requestId: id(3)
  };
  const fresh = {
    kind: 'new',
    teamId: id(4),
    actorId: id(5),
    materialId: id(6),
    outputName: 'Synthetic.mp4',
    idempotencyKey: 'catalog-variant:' + original.requestId,
    sourceVersion: '1'
  };
  const service = { rpc: vi.fn().mockResolvedValue({ data: fresh, error: null }) };
  const startProcess = vi.fn(async (_actor: string, body: Record<string, unknown>) => {
    // The same current minimum used by central handleProcessStart TOOL_RULES.
    if (
      typeof body.toolContractVersion !== 'number' ||
      body.toolContractVersion < RESTITCH_CONTRACT_VERSION
    )
      throw new TeamFunctionError('AGENT_UPDATE_REQUIRED');
    return { operationId: id(7) };
  });
  expect(
    await admitCatalogVideoVariant(service, original, {
      restitchedFolder: async () => id(8),
      startProcess
    })
  ).toEqual({ operationId: id(7) });
  expect(startProcess).toHaveBeenCalledWith(
    fresh.actorId,
    expect.objectContaining({
      toolId: 'restitch',
      toolContractVersion: RESTITCH_CONTRACT_VERSION,
      idempotencyKey: fresh.idempotencyKey,
      expectedSourceVersion: '1'
    })
  );
  expect(RESTITCH_CONTRACT_VERSION).toBeGreaterThan(1);
});
