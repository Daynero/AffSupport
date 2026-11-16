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

it('rebases the set when only Drive metadata moved the source version, then starts on the live version', async () => {
  const original = {
    setId: id(11),
    nativeInstanceId: id(12),
    claimHash: '\\x' + 'b'.repeat(64),
    protocolVersion: 1 as const,
    index: 4,
    requestId: id(13)
  };
  const read = (sourceVersion: string) => ({
    kind: 'new',
    teamId: id(14),
    actorId: id(15),
    materialId: id(16),
    outputName: 'Synthetic.mp4',
    idempotencyKey: 'catalog-variant:' + original.requestId,
    sourceVersion
  });
  let version = '5';
  const service = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_rebase_catalog_video_source') {
        expect(args).toMatchObject({
          p_set: original.setId,
          p_version: '9',
          p_checksum: 'f'.repeat(32)
        });
        version = '9';
        return { data: true, error: null };
      }
      return { data: read(version), error: null };
    })
  };
  const startProcess = vi.fn(async (_actor: string, body: Record<string, unknown>) => {
    if (body.expectedSourceVersion !== '9') throw new TeamFunctionError('SOURCE_CHANGED');
    return { operationId: id(17) };
  });
  expect(
    await admitCatalogVideoVariant(service, original, {
      restitchedFolder: async () => id(18),
      startProcess,
      liveSource: async () => ({ version: '9', checksum: 'f'.repeat(32) })
    })
  ).toEqual({ operationId: id(17) });
  expect(startProcess.mock.calls.map(call => call[1].expectedSourceVersion)).toEqual(['5', '9']);
});

it('keeps refusing a source whose bytes really changed', async () => {
  const original = {
    setId: id(21),
    nativeInstanceId: id(22),
    claimHash: '\\x' + 'c'.repeat(64),
    protocolVersion: 1 as const,
    index: 0,
    requestId: id(23)
  };
  const fresh = {
    kind: 'new',
    teamId: id(24),
    actorId: id(25),
    materialId: id(26),
    outputName: 'Synthetic.mp4',
    idempotencyKey: 'catalog-variant:' + original.requestId,
    sourceVersion: '5'
  };
  const service = {
    rpc: vi.fn(async (name: string) =>
      name === 'service_rebase_catalog_video_source'
        ? { data: null, error: { message: 'SOURCE_CHANGED' } }
        : { data: fresh, error: null }
    )
  };
  await expect(
    admitCatalogVideoVariant(service, original, {
      restitchedFolder: async () => id(28),
      startProcess: async () => {
        throw new TeamFunctionError('SOURCE_CHANGED');
      },
      liveSource: async () => ({ version: '9', checksum: 'e'.repeat(32) })
    })
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});

it('adopts the operation a rebased start created before its reply was lost', async () => {
  const original = {
    setId: id(31),
    nativeInstanceId: id(32),
    claimHash: '\\x' + 'd'.repeat(64),
    protocolVersion: 1 as const,
    index: 4,
    requestId: id(33)
  };
  let version = '5';
  let created: string | null = null;
  const service = {
    rpc: vi.fn(async (name: string) => {
      if (name === 'service_rebase_catalog_video_source') {
        version = '9';
        return { data: true, error: null };
      }
      return {
        data: created
          ? { kind: 'admitted', operationId: created }
          : {
              kind: 'new',
              teamId: id(34),
              actorId: id(35),
              materialId: id(36),
              outputName: 'Synthetic.mp4',
              idempotencyKey: 'catalog-variant:' + original.requestId,
              sourceVersion: version
            },
        error: null
      };
    })
  };
  const startProcess = vi.fn(async (_actor: string, body: Record<string, unknown>) => {
    if (body.expectedSourceVersion !== '9') throw new TeamFunctionError('SOURCE_CHANGED');
    // Admitted, then Drive refused before the answer reached the caller.
    created = id(37);
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  });
  expect(
    await admitCatalogVideoVariant(service, original, {
      restitchedFolder: async () => id(38),
      startProcess,
      liveSource: async () => ({ version: '9', checksum: 'f'.repeat(32) })
    })
  ).toEqual({ operationId: id(37) });
});
