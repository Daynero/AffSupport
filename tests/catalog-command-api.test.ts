import { afterEach, expect, it, vi } from 'vitest';
const { rpc, gate } = vi.hoisted(() => ({
  rpc: vi.fn(),
  gate: { wait: null as Promise<void> | null }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: async <T>(run: () => PromiseLike<T>) => {
    if (gate.wait) await gate.wait;
    return run();
  },
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1),
  team = id(2),
  commandId = id(3),
  a = id(4),
  b = id(5);
const request = { commandId, catalogIds: [a, b] };
const receipt = {
  commandId,
  kind: 'run',
  status: 'accepted',
  sourceAttemptId: null,
  requestedCount: 2,
  acceptedCount: 2,
  items: [
    { catalogId: a, accepted: true, attemptId: id(6), reason: 'accepted' },
    { catalogId: b, accepted: true, attemptId: id(7), reason: 'accepted' }
  ]
};
afterEach(() => {
  rpc.mockReset();
  gate.wait = null;
});
it('binds an exact command to its originating actor and canonical distinct catalog IDs', async () => {
  rpc.mockResolvedValue({ data: receipt, error: null });
  expect(
    await teamApi.requestCatalogUpdateCommand(team, actor, { commandId, catalogIds: [b, a, a] })
  ).toEqual(receipt);
  expect(rpc).toHaveBeenCalledWith('request_team_catalog_update_command', {
    p_team: team,
    p_command: commandId,
    p_catalogs: [a, b],
    p_expected_actor: actor,
    p_source_attempt: null
  });
});
it('preserves the original actor while session refresh is delayed', async () => {
  let release!: () => void;
  gate.wait = new Promise<void>(resolve => {
    release = resolve;
  });
  rpc.mockResolvedValue({ data: receipt, error: null });
  const saving = teamApi.requestCatalogUpdateCommand(team, actor, request);
  expect(rpc).not.toHaveBeenCalled();
  release();
  await saving;
  expect(rpc.mock.calls[0]?.[1].p_expected_actor).toBe(actor);
});
it.each([
  { ...receipt, commandId: id(9) },
  { ...receipt, acceptedCount: 1 },
  { ...receipt, items: [receipt.items[0], receipt.items[0]] },
  { ...receipt, items: [receipt.items[0], { ...receipt.items[1], attemptId: id(6) }] },
  { ...receipt, items: [receipt.items[0], { ...receipt.items[1], accepted: 'true' }] },
  { ...receipt, sourceAttemptId: id(8) }
])(
  'rejects a malformed or differently bound acknowledgement without claiming acceptance',
  async data => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(teamApi.requestCatalogUpdateCommand(team, actor, request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  }
);
it('drops unrelated provider fields from a valid receipt', async () => {
  rpc.mockResolvedValue({
    data: {
      ...receipt,
      url: 'https://private.example.invalid/',
      items: receipt.items.map(item => ({ ...item, providerPayload: 'private-value' }))
    },
    error: null
  });
  const result = await teamApi.requestCatalogUpdateCommand(team, actor, request);
  expect(JSON.stringify(result)).not.toMatch(/private|providerPayload/);
});
it('treats a missing read-only receipt as unknown, without executing a new command', async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  expect(await teamApi.getCatalogUpdateCommand(team, request)).toBeNull();
  expect(rpc).toHaveBeenCalledWith('get_team_catalog_update_command', {
    p_team: team,
    p_command: commandId
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('does not treat an undefined lookup payload as a missing committed receipt', async () => {
  rpc.mockResolvedValue({ data: undefined, error: null });
  await expect(teamApi.getCatalogUpdateCommand(team, request)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});
it('seals only the retained intent when cancelling an unconfirmed command', async () => {
  const cancelled = {
    ...receipt,
    status: 'cancelled',
    acceptedCount: 0,
    items: receipt.items.map(item => ({
      ...item,
      accepted: false,
      attemptId: null,
      reason: 'cancelled_before_acceptance'
    }))
  };
  rpc.mockResolvedValue({ data: cancelled, error: null });
  expect(await teamApi.cancelCatalogCommandIntent(team, actor, request)).toEqual(cancelled);
  expect(rpc).toHaveBeenCalledWith('cancel_team_catalog_command_intent', {
    p_team: team,
    p_command: commandId,
    p_catalogs: [a, b],
    p_expected_actor: actor,
    p_source_attempt: null
  });
});
it('refuses an unavailable server contract without falling back to an untracked writer', async () => {
  rpc.mockResolvedValue({
    data: null,
    error: { code: 'PGRST202', message: 'Function is unavailable' }
  });
  await expect(teamApi.requestCatalogUpdateCommand(team, actor, request)).rejects.toMatchObject({
    code: 'CATALOG_COMMAND_UNSUPPORTED',
    retryable: false
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('rejects an unbounded intent before any RPC is dispatched', async () => {
  await expect(
    teamApi.requestCatalogUpdateCommand(team, actor, {
      commandId,
      catalogIds: Array.from({ length: 501 }, (_, n) => id(n + 100))
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rpc).not.toHaveBeenCalled();
});
it('attaches cancellation to a read-only receipt lookup', async () => {
  const controller = new AbortController();
  const abortSignal = vi.fn().mockReturnValue(Promise.resolve({ data: receipt, error: null }));
  rpc.mockReturnValue({ abortSignal });
  await teamApi.getCatalogUpdateCommand(team, request, { signal: controller.signal });
  expect(abortSignal).toHaveBeenCalledWith(controller.signal);
});
