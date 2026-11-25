import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc }),
  withFreshSession: (run: () => PromiseLike<unknown>) => run()
}));

import { assistantApi } from '../apps/web/src/api/assistant';

const TEAM = '22222222-2222-4222-8222-222222222222';

function answer(conversationId: string) {
  return { data: { enabled: true, conversationId, dialogs: [], messages: [] }, error: null };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}

// 070: two opens at once made two dialogs; one open per space and login is in flight at a time.
describe('assistant open', () => {
  beforeEach(() => rpc.mockReset());

  it('two concurrent opens of the newest dialog share one call and one dialog', async () => {
    const reply = deferred();
    rpc.mockReturnValueOnce(reply.promise).mockResolvedValue(answer('second'));
    const first = assistantApi.open(TEAM);
    const second = assistantApi.open(TEAM);
    reply.resolve(answer('first'));
    const [a, b] = await Promise.all([first, second]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('assistant_open_dialog', { p_team: TEAM, p_dialog: null });
    expect(a.conversationId).toBe('first');
    expect(b.conversationId).toBe('first');
  });

  it('asks again once the first open has settled, and even after it failed', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'AUTH_REQUIRED' } })
      .mockResolvedValue(answer('later'));
    await expect(assistantApi.open(TEAM)).rejects.toBeTruthy();
    expect((await assistantApi.open(TEAM)).conversationId).toBe('later');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('keeps opens of different spaces and of a named dialog apart', async () => {
    rpc.mockResolvedValue(answer('any'));
    await Promise.all([
      assistantApi.open(TEAM),
      assistantApi.open('33333333-3333-4333-8333-333333333333'),
      assistantApi.open(TEAM, 'dialog-a'),
      assistantApi.open(TEAM, 'dialog-a')
    ]);
    expect(rpc).toHaveBeenCalledTimes(4);
  });
});
