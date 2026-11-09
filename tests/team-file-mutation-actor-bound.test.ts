import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as mutationGuards from '../supabase/functions/drive-ops/handler';
const A = '47000000-0000-4000-8000-000000000081',
  B = '47000000-0000-4000-8000-000000000082';
const calls = vi.hoisted(() => ({
  invoke: vi.fn(),
  ready: [] as Array<() => void>,
  actor: '' as string,
  write: vi.fn()
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ functions: { invoke: calls.invoke } }),
  getSupabaseClient: () => null,
  withFreshSession: <T>(work: () => PromiseLike<T>) => work()
}));
const { teamApi } = await import('../apps/web/src/api/team');
const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
const input = {
  teamId: '47000000-0000-4000-8000-000000000001',
  materialId: '47000000-0000-4000-8000-000000000002',
  idempotencyKey: 'original-intent-key'
};
beforeEach(() => {
  setPrivateCacheScope(A, 'file-mutation');
  calls.actor = A;
  calls.ready.length = 0;
  calls.invoke.mockImplementation(
    (path: string, request: { body: Record<string, unknown> }) =>
      new Promise(resolve =>
        calls.ready.push(() => {
          try {
            if (path.endsWith('-as-actor')) {
              const guard = (
                mutationGuards as unknown as {
                  assertExpectedMutationActor: (expected: unknown, actual: string) => void;
                }
              ).assertExpectedMutationActor;
              if (!guard) throw Error('Missing actor-bound mutation guard');
              guard(request.body.expectedActorId, calls.actor);
            }
            calls.write(calls.actor);
            resolve({
              data: {
                ok: true,
                value: path.startsWith('drive-ops/updater/')
                  ? { job: null }
                  : {
                      operationId: '47000000-0000-4000-8000-000000000003',
                      state: 'succeeded',
                      materialId: input.materialId,
                      reused: false
                    }
              },
              error: null
            });
          } catch (cause) {
            resolve({
              data: {
                ok: false,
                error: {
                  code: (cause as { code?: string }).code ?? 'INVALID_RESPONSE',
                  retryable: false
                }
              },
              error: null
            });
          }
        })
      )
  );
});
afterEach(() => {
  calls.invoke.mockReset();
  calls.write.mockReset();
  setPrivateCacheScope(null, 'file-mutation-ended');
});
for (const method of ['trashMaterial', 'restoreMaterial'] as const) {
  it(method + ' binds the originating actor before token acquisition', async () => {
    const pending = teamApi[method](input);
    expect(calls.write).not.toHaveBeenCalled();
    calls.actor = B;
    calls.ready.shift()!();
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(calls.write).not.toHaveBeenCalled();
  });
  it(method + ' permits the unchanged actor through the guarded mutation seam', async () => {
    const pending = teamApi[method](input);
    calls.ready.shift()!();
    expect(await pending).toMatchObject({ state: 'succeeded', materialId: input.materialId });
    expect(calls.write).toHaveBeenCalledExactlyOnceWith(A);
  });
}

it('restitch claiming binds the actor before asynchronous token acquisition', async () => {
  const pending = teamApi.claimRestitchJob(input.teamId, [], 2);
  calls.actor = B;
  calls.ready.shift()!();
  await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(calls.write).not.toHaveBeenCalled();
});
it('restitch claiming permits the original actor through its guarded route', async () => {
  const pending = teamApi.claimRestitchJob(input.teamId, [], 2);
  calls.ready.shift()!();
  expect(await pending).toBeNull();
  expect(calls.write).toHaveBeenCalledExactlyOnceWith(A);
});
