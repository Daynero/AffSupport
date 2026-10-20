import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '34000000-0000-4000-8000-000000000001';
const ADMIN = '34000000-0000-4000-8000-000000000002';
const INSTALL = '34000000-0000-4000-8000-000000000003';
const ROTATION = '34000000-0000-4000-8000-000000000004';
const REQUEST = '34000000-0000-4000-8000-000000000005';
const H = (n: number) => '\\x' + n.toString(16).padStart(2, '0').repeat(32);
let db: TeamTestDb;
let team: string;
let tariff: string;
async function call(action: string, hash: string | null, input: object = {}) {
  return (
    await db.root<{ r: Record<string, unknown> }>(
      'select public.service_team_recovery($1,$2::text::bytea,$3::jsonb) as r',
      [action, hash, JSON.stringify(input)]
    )
  )[0]!.r;
}
async function enroll() {
  await db.root('delete from private.team_recovery_delegations');
  const challenge = await call('delegate', H(1), {
    actorId: OWNER,
    teamId: team,
    installationId: INSTALL
  });
  await call('redeem', H(1), {
    challengeId: challenge.challengeId,
    refresh: 'a'.repeat(43),
    refreshHash: H(2)
  });
  return challenge;
}
async function rotate() {
  return call('rotate', H(2), {
    rotationId: ROTATION,
    refresh: 'b'.repeat(43),
    refreshHash: H(3),
    claim: 'c'.repeat(43),
    claimHash: H(4)
  });
}
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@recovery.test' });
  await createUser(db, { id: ADMIN, email: 'admin@recovery.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  tariff = (
    await db.asUser<{ id: string }>(
      ADMIN,
      "select public.admin_grant_space_tariff('owner@recovery.test','lead',private.kyiv_today()+30,0)->>'id' id"
    )
  )[0]!.id;
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Synthetic recovery')"
    )
  )[0]!.id;
}, 60_000);
afterAll(async () => db?.close());
describe('scoped background delegation', () => {
  it('consumes enrollment once and rejects a wrong ticket', async () => {
    const challenge = await enroll();
    await expect(
      call('redeem', H(1), {
        challengeId: challenge.challengeId,
        refresh: 'a'.repeat(43),
        refreshHash: H(2)
      })
    ).rejects.toThrow(/AUTH_REQUIRED/);
    const next = await call('delegate', H(1), {
      actorId: OWNER,
      teamId: team,
      installationId: INSTALL
    });
    await expect(
      call('redeem', H(9), {
        challengeId: next.challengeId,
        refresh: 'a'.repeat(43),
        refreshHash: H(2)
      })
    ).rejects.toThrow(/AUTH_REQUIRED/);
  });
  it('replays the same rotation response after a lost reply and rejects cross-audience credentials', async () => {
    await enroll();
    const first = await rotate();
    expect(
      await call('rotate', H(2), {
        rotationId: ROTATION,
        refresh: 'z'.repeat(43),
        refreshHash: H(8),
        claim: 'y'.repeat(43),
        claimHash: H(9)
      })
    ).toEqual(first);
    await expect(call('settle', H(4), { operationId: REQUEST, jobId: REQUEST })).rejects.toThrow(
      /AUTH_REQUIRED/
    );
    await expect(call('claim', H(3), { requestId: REQUEST })).rejects.toThrow(/AUTH_REQUIRED/);
  });
  it('revokes the family when a consumed refresh handle is replayed under a different rotation ID', async () => {
    const reply = await call('rotate', H(2), {
      rotationId: REQUEST,
      refresh: 'd'.repeat(43),
      refreshHash: H(5),
      claim: 'e'.repeat(43),
      claimHash: H(6)
    });
    expect(reply).toEqual({ error: 'AUTH_REQUIRED' });
    await expect(call('claim', H(4), { requestId: REQUEST })).rejects.toThrow(/AUTH_REQUIRED/);
  });
  it('coalesces a lost claim response and enforces idle claim budgets', async () => {
    await enroll();
    await rotate();
    const context = await call('claim', H(4), { requestId: REQUEST });
    expect(context.teamId).toBe(team);
    expect(await call('claim', H(4), { requestId: REQUEST })).toEqual({ pending: true });
    await call('register_claim', H(4), {
      requestId: REQUEST,
      response: { job: null, operationCredential: null },
      operationHash: H(7)
    });
    expect(await call('claim', H(4), { requestId: REQUEST })).toEqual({
      replay: { job: null, operationCredential: null }
    });
    await expect(call('claim', H(4), { requestId: ROTATION })).rejects.toThrow(/RATE_LIMITED/);
  });
  it('refuses current work after tariff closure and only permits a bounded read-only probe', async () => {
    await db.asUser(ADMIN, 'select public.admin_end_space_tariff($1,true)', [tariff]);
    await expect(call('authorize_claim', H(4))).rejects.toThrow(/SPACE_BLOCKED/);
    expect((await call('probe', H(3))).allowed).toBe(false);
    await expect(call('probe', H(3))).rejects.toThrow(/RATE_LIMITED/);
    await db.asUser(ADMIN, 'select public.admin_extend_space_tariff($1,1,false)', [tariff]);
  });
  it('fences operation credentials to the exact operation, job and pause epoch', async () => {
    await enroll();
    await rotate();
    await call('claim', H(4), { requestId: REQUEST });
    const operation = (
      await db.root<{ id: string }>(
        "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'upload','pending','recovery-scope','recovery-scope') returning id",
        [team, OWNER]
      )
    )[0]!.id;
    await call('register_claim', H(4), {
      requestId: REQUEST,
      response: {
        job: { operationId: operation, jobId: REQUEST },
        operationCredential: 'x'.repeat(43)
      },
      operationHash: H(7)
    });
    expect(
      (await call('authorize_execute', H(7), { operationId: operation, jobId: REQUEST }))
        .operationId
    ).toBe(operation);
    await expect(
      call('authorize_execute', H(7), { operationId: ROTATION, jobId: REQUEST })
    ).rejects.toThrow(/AUTH_REQUIRED/);
    await expect(
      call('authorize_execute', H(7), { operationId: operation, jobId: ROTATION })
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(call('claim', H(7), { requestId: ROTATION })).rejects.toThrow(/AUTH_REQUIRED/);
    await db.asUser(ADMIN, 'select public.admin_end_space_tariff($1,true)', [tariff]);
    await db.asUser(ADMIN, 'select public.admin_extend_space_tariff($1,1,false)', [tariff]);
    await expect(
      call('authorize_execute', H(7), { operationId: operation, jobId: REQUEST })
    ).rejects.toThrow(/AUTH_REQUIRED/);
  });
  it('rejects expired credentials and expires replay secrets without deleting unresolved history', async () => {
    await enroll();
    await rotate();
    await db.root(
      "update private.team_recovery_credentials set expires_at=clock_timestamp()-interval '1 second'"
    );
    await expect(call('authorize_claim', H(4))).rejects.toThrow(/AUTH_REQUIRED/);
    await db.root(
      "update private.team_recovery_delegations set rotation_replay_until=clock_timestamp()-interval '1 second'"
    );
    await db.root('select private.sweep_workspace_recovery()');
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.team_recovery_credentials'
        )
      )[0]!.n
    ).toBe(0);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.team_recovery_delegations where rotation_secret_id is not null'
        )
      )[0]!.n
    ).toBe(0);
  });
  it('revokes a removed member during tariff pause and does not revive the handle on re-add', async () => {
    await db.root('delete from private.team_recovery_delegations');
    const member = '34000000-0000-4000-8000-000000000009';
    await createUser(db, { id: member, email: 'member@recovery.test' });
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
      [team, member]
    );
    const challenge = await call('delegate', H(10), {
      actorId: member,
      teamId: team,
      installationId: INSTALL
    });
    await call('redeem', H(10), {
      challengeId: challenge.challengeId,
      refresh: 'm'.repeat(43),
      refreshHash: H(11)
    });
    await db.asUser(ADMIN, 'select public.admin_end_space_tariff($1,true)', [tariff]);
    expect((await call('probe', H(11))).allowed).toBe(false);
    await db.root(
      "update public.team_members set status='removed',removed_at=clock_timestamp() where team_id=$1 and user_id=$2",
      [team, member]
    );
    await db.root(
      "update public.team_members set status='active',removed_at=null where team_id=$1 and user_id=$2",
      [team, member]
    );
    await db.asUser(ADMIN, 'select public.admin_extend_space_tariff($1,1,false)', [tariff]);
    await expect(call('probe', H(11))).rejects.toThrow(/AUTH_REQUIRED/);
    const next = await call('delegate', H(12), {
      actorId: member,
      teamId: team,
      installationId: INSTALL
    });
    await call('redeem', H(12), {
      challengeId: next.challengeId,
      refresh: 'n'.repeat(43),
      refreshHash: H(13)
    });
    await db.root(
      `update public.team_members set permission_overrides='{"process":false}'::jsonb where team_id=$1 and user_id=$2`,
      [team, member]
    );
    await db.root(
      "update public.team_members set permission_overrides='{}'::jsonb where team_id=$1 and user_id=$2",
      [team, member]
    );
    await expect(call('probe', H(13))).rejects.toThrow(/AUTH_REQUIRED/);
  });
  it('keeps service credential issuance unavailable to browser roles', async () => {
    expect(
      await db.root(
        "select has_function_privilege('authenticated','public.service_team_recovery(text,bytea,jsonb)','execute') as browser,has_function_privilege('anon','public.service_team_recovery(text,bytea,jsonb)','execute') as anonymous"
      )
    ).toEqual([{ browser: false, anonymous: false }]);
    await expect(call('anything', H(4))).rejects.toThrow(/INVALID_INPUT/);
  });
});
