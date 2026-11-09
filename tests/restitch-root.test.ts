import { expect, it, vi } from 'vitest';
import {
  acceptManualRestitchRoot,
  readManualRestitchRoot
} from '../supabase/functions/drive-ops/restitch-root';
const id = (n: number) => 'b1600000-0000-4000-8000-' + String(n).padStart(12, '0');
const request = () => ({
  teamId: id(1),
  actorId: id(2),
  sourceMaterialId: id(3),
  idempotencyKey: 'manual:' + id(4),
  clientOperationId: id(4)
});
it('does not convert a missing admission acknowledgement and absent readback into another mutation', async () => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_accept_manual_restitch_download')
      throw Error('SYNTHETIC_PRIVATE_MESSAGE');
    return { data: null, error: null };
  });
  await expect(acceptManualRestitchRoot({ rpc }, request())).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_accept_manual_restitch_download',
    'service_read_manual_restitch_download'
  ]);
});
it.each([
  'PERMISSION_DENIED',
  'INVALID_INPUT',
  'REQUEST_REUSE_CONFLICT',
  'RESTITCH_INVALID',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_SOURCES_TOO_MANY'
] as const)('keeps proven %s admission refusals distinct from unknown accounting', async code => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: code } }));
  await expect(acceptManualRestitchRoot({ rpc }, request())).rejects.toMatchObject({
    code,
    message: code
  });
  expect(rpc).toHaveBeenCalledOnce();
});
it('uses only the read RPC for recovery, including an absent result', async () => {
  const rpc = vi.fn(async (_name: string) => ({ data: null, error: null }));
  expect(await readManualRestitchRoot({ rpc }, request())).toBeNull();
  expect(rpc.mock.calls[0]?.[0]).toBe('service_read_manual_restitch_download');
});
it('rejects malformed success plus failed readback without exposing either payload', async () => {
  const rpc = vi.fn(async (name: string) =>
    name === 'service_accept_manual_restitch_download'
      ? { data: { operationId: id(5), private: 'SYNTHETIC_PRIVATE_CONTENT' }, error: null }
      : { data: null, error: { message: 'SYNTHETIC_PRIVATE_SQL_DETAIL' } }
  );
  await expect(acceptManualRestitchRoot({ rpc }, request())).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});
