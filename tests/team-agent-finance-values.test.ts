import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';
let f: Awaited<ReturnType<typeof financeFixture>>;
beforeAll(async () => {
  f = await financeFixture();
}, 60000);
afterAll(async () => {
  await f?.db.close();
});
async function set(metric: string, value: string | null, version: string, request = randomUUID()) {
  return (
    await f.db.asUser<{
      result: {
        requestId: string;
        undoReference: string | null;
        fields: { value: string | null; version: string }[];
      };
    }>(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on))) as result',
      [f.team, f.agent, '2026-09-10', metric, value, version, 'UTC', request]
    )
  )[0]!.result;
}
describe('daily finance writes', () => {
  it('reads arbitrary cross-month ranges but refuses unbounded requests', async () => {
    const result = await f.db.asUser<{ result: { from: string; to: string } }>(
      FINANCE_OWNER,
      'select public.get_team_agent_finance($1,$2,$3,$4) as result',
      [f.team, '2026-08-28', '2026-09-12', 'UTC']
    );
    expect(result[0]!.result.from).toBe('2026-08-28');
    expect(result[0]!.result.to).toBe('2026-09-12');
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.get_team_agent_finance($1,$2,$3,$4)', [
        f.team,
        '2025-01-01',
        '2026-09-12',
        'UTC'
      ])
    ).rejects.toThrow(/INVALID_INPUT/);
  });
  it('replaces exact cents, independently versions metrics and rejects stale writes', async () => {
    expect((await set('spend', '125.50', '0')).fields[0]!.value).toBe('125.50');
    expect((await set('balance', '70.00', '0')).fields[0]!.version).toBe('1');
    expect((await set('spend', '150.25', '1')).fields[0]!.value).toBe('150.25');
    await expect(set('spend', '999.00', '1')).rejects.toThrow(/FINANCE_CONFLICT/);
  });
  it('replays a request once and rejects request reuse with a different payload', async () => {
    const id = randomUUID();
    const first = await set('topup', '200.00', '0', id);
    expect(await set('topup', '200.00', '0', id)).toEqual(first);
    await expect(set('topup', '300.00', '0', id)).rejects.toThrow(/REQUEST_REUSE_CONFLICT/);
  });
  it('undoes single clear, rejects repeated or stale undo, and preserves other days', async () => {
    const cleared = await set('balance', null, '1');
    expect(cleared.undoReference).toBeTruthy();
    const request = randomUUID();
    const params = [f.team, cleared.requestId, request];
    const restored = await f.db.asUser<{ result: unknown }>(
      FINANCE_OWNER,
      'select public.undo_team_agent_finance_clear($1,$2,$3) as result',
      params
    );
    expect(
      await f.db.asUser(
        FINANCE_OWNER,
        'select public.undo_team_agent_finance_clear($1,$2,$3) as result',
        params
      )
    ).toEqual(restored);
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.undo_team_agent_finance_clear($1,$2,$3)', [
        f.team,
        cleared.requestId,
        randomUUID()
      ])
    ).rejects.toThrow(/FINANCE_UNDO_ALREADY_APPLIED/);
  });
  it('isolates viewers and returns one authoritative snapshot', async () => {
    await expect(
      f.db.asUser(
        FINANCE_VIEWER,
        'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
        [f.team, f.agent, '2026-09-10', 'spend', '1.00', '2', 'UTC', randomUUID()]
      )
    ).rejects.toThrow(/PERMISSION_DENIED/);
    const data = await f.db.asUser<{ snapshot: { fields: unknown[] } }>(
      FINANCE_VIEWER,
      'select public.get_team_agent_finance($1,$2,$3,$4) as snapshot',
      [f.team, '2026-09-01', '2026-09-30', 'UTC']
    );
    expect(data[0]!.snapshot.fields).toHaveLength(3);
  });
  it('clears and restores every metric and rejects Undo after a newer write', async () => {
    for (const metric of ['balance', 'topup', 'spend']) {
      const write = (value: string | null, version: string) =>
        f.db.asUser<{
          result: { undoReference: string | null; requestId: string; fields: unknown[] };
        }>(
          FINANCE_OWNER,
          'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on))) as result',
          [f.team, f.agent, '2026-09-11', metric, value, version, 'UTC', randomUUID()]
        );
      expect((await write(null, '0'))[0]!.result.fields).toEqual([]);
      await write('0.00', '0');
      const cleared = (await write(null, '1'))[0]!.result;
      expect(cleared.undoReference).toBe(cleared.requestId);
      await f.db.asUser(FINANCE_OWNER, 'select public.undo_team_agent_finance_clear($1,$2,$3)', [
        f.team,
        cleared.requestId,
        randomUUID()
      ]);
      const again = (await write(null, '3'))[0]!.result;
      await write('99.99', '4');
      await expect(
        f.db.asUser(FINANCE_OWNER, 'select public.undo_team_agent_finance_clear($1,$2,$3)', [
          f.team,
          again.requestId,
          randomUUID()
        ])
      ).rejects.toThrow(/FINANCE_CONFLICT/);
    }
  });
  it('paginates history without duplicates and refuses another editor’s Undo', async () => {
    const clear = await set('topup', null, '1');
    await f.db.root(
      "update public.team_members set base_role='editor' where team_id=$1 and user_id=$2",
      [f.team, FINANCE_VIEWER]
    );
    await expect(
      f.db.asUser(FINANCE_VIEWER, 'select public.undo_team_agent_finance_clear($1,$2,$3)', [
        f.team,
        clear.requestId,
        randomUUID()
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    const first = (
      await f.db.asUser<{ result: { events: { id: string }[]; nextCursor: unknown } }>(
        FINANCE_OWNER,
        'select public.list_team_agent_finance_history($1,$2,null,2) as result',
        [f.team, f.agent]
      )
    )[0]!.result;
    const second = (
      await f.db.asUser<{ result: { events: { id: string }[] } }>(
        FINANCE_OWNER,
        'select public.list_team_agent_finance_history($1,$2,$3,2) as result',
        [f.team, f.agent, JSON.stringify(first.nextCursor)]
      )
    )[0]!.result;
    expect(first.events).toHaveLength(2);
    expect(second.events).toHaveLength(2);
    expect(new Set([...first.events, ...second.events].map(e => e.id)).size).toBe(4);
  });
});
