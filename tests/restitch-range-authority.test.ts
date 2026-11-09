import { expect, it, vi } from 'vitest';
import {
  readAuthoritativeRestitchSelectionRange,
  readRestitchSelectionSource
} from '../supabase/functions/drive-ops/restitch-range-authority';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
const id = (n: number) => 'b1580000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = { rootOperationId: id(1), teamId: id(2), actorId: id(3), slot: 'end' as const };
function context() {
  return {
    ...scope,
    versionId: id(4),
    acquisition: 0,
    credentialId: id(5),
    source: {
      fileId: 'SYNTHETIC_PRIVATE_SOURCE',
      resourceKey: null,
      parentFolderId: 'SYNTHETIC_PRIVATE_PARENT',
      rootFolderId: 'SYNTHETIC_PRIVATE_ROOT',
      sizeBytes: 4,
      mimeType: 'image/png',
      checksum: 'a'.repeat(32)
    }
  };
}
it.each([
  null,
  { ...context(), actorId: id(6) },
  { ...context(), rootOperationId: id(6) },
  { ...context(), acquisition: 1 },
  { ...context(), source: { ...context().source, sizeBytes: '4' } },
  { ...context(), source: { ...context().source, resourceKey: undefined } },
  { ...context(), source: { ...context().source, mimeType: 'text/html' } }
])(
  'never reaches credentials or provider I/O on missing or substituted service context %j',
  async value => {
    const service: ServiceRpcClient = { rpc: async () => ({ data: value, error: null }) };
    const fetcher = vi.fn<typeof fetch>();
    const readCredentials = vi.fn();
    const result = readAuthoritativeRestitchSelectionRange(
      { service, scope, versionId: id(4), acquisition: 0, requestId: id(7), offset: 0 },
      { fetch: fetcher, readCredentials }
    );
    await expect(result).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
      message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
  }
);
it('does not replace a lost source-authority reply with a fresh selection or provider request', async () => {
  const rpc = vi.fn(async () => {
    throw Error('SYNTHETIC_PRIVATE_PROVIDER_MESSAGE');
  });
  await expect(readRestitchSelectionSource({ rpc }, scope, id(4), 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('service_read_restitch_selection_source', {
    p_root_operation: id(1),
    p_team: id(2),
    p_actor: id(3),
    p_slot: 'end',
    p_version: id(4),
    p_acquisition: 0
  });
});
