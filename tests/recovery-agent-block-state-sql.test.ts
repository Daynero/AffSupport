import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 072 (agent package): the desktop's background work stopping on a computer used to be
 * invisible to the server, so a round read «Чекає на комп'ютерний агент…» for a day. The desktop
 * now sends its local state with the recovery probe and the delegation keeps it
 * (20261224190000). An older desktop sends no field and nothing changes.
 */
const OWNER = '47200000-0000-4000-8000-0000000000e1';
const ADMIN = '47200000-0000-4000-8000-0000000000e2';
let db: TeamTestDb;
let team: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@agent-block.test' });
  await createUser(db, { id: ADMIN, email: 'admin@agent-block.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  await db.asUser(
    ADMIN,
    "select public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('owner@agent-block.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(0)::integer))"
  );
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Agent block')")
  )[0]!.id;
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function delegation(hashByte: string) {
  const id = randomUUID();
  await db.root(
    `insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash)
     values($1,$2,$3,gen_random_uuid(),decode(repeat($4,32),'hex'))`,
    [id, team, OWNER, hashByte]
  );
  return id;
}
async function probe(hashByte: string, input: object) {
  return (
    await db.root<{ r: Record<string, unknown> }>(
      `select public.service_team_recovery('probe',decode(repeat($1,32),'hex'),$2::jsonb) r`,
      [hashByte, JSON.stringify({ protocolVersion: 2, ...input })]
    )
  )[0]!.r;
}
async function state(id: string) {
  return (
    await db.root<{ reason: string | null; code: string | null; reported: boolean }>(
      `select agent_block_reason reason,agent_block_code code,agent_block_at is not null reported
       from private.team_recovery_delegations where id=$1`,
      [id]
    )
  )[0]!;
}
async function allowProbe(id: string) {
  await db.root(
    "update private.team_recovery_delegations set last_probe_at=clock_timestamp()-interval '2 minutes' where id=$1",
    [id]
  );
  await db.root(
    'delete from private.team_recovery_rate_buckets where installation_id=(select installation_id from private.team_recovery_delegations where id=$1)',
    [id]
  );
}

it('keeps the blocked state a desktop reports with its probe and clears it when told', async () => {
  const id = await delegation('d1');
  expect(
    await probe('d1', {
      localState: { stage: 'blocked', reason: 'retry_exhausted', code: 'DRIVE_STORAGE_FULL' }
    })
  ).toMatchObject({ allowed: true, delegationId: id });
  expect(await state(id)).toEqual({
    reason: 'retry_exhausted',
    code: 'DRIVE_STORAGE_FULL',
    reported: true
  });

  await allowProbe(id);
  await probe('d1', { localState: { stage: 'clear' } });
  expect(await state(id)).toEqual({ reason: null, code: null, reported: false });
});

it('leaves the state alone for an older desktop and ignores a malformed one', async () => {
  const id = await delegation('d2');
  await probe('d2', {
    localState: { stage: 'blocked', reason: 'retry_exhausted', code: 'NEEDS_REAUTH' }
  });
  for (const localState of [
    undefined,
    null,
    'blocked',
    { stage: 'blocked', reason: 'Retry Exhausted', code: 'NEEDS_REAUTH' },
    { stage: 'blocked', reason: 'retry_exhausted', code: 'https://provider/token' },
    { stage: 'blocked', reason: 'retry_exhausted' },
    { stage: 'paused' }
  ]) {
    await allowProbe(id);
    await expect(
      probe('d2', localState === undefined ? {} : { localState })
    ).resolves.toMatchObject({ allowed: true });
    expect(await state(id)).toEqual({
      reason: 'retry_exhausted',
      code: 'NEEDS_REAUTH',
      reported: true
    });
  }
});

it('records nothing when the probe itself is refused', async () => {
  const id = await delegation('d3');
  await probe('d3', {});
  // One probe a minute per delegation: the report does not get around the limit.
  await expect(
    probe('d3', {
      localState: { stage: 'blocked', reason: 'retry_exhausted', code: 'DRIVE_UNAVAILABLE' }
    })
  ).rejects.toThrow('RATE_LIMITED');
  expect(await state(id)).toEqual({ reason: null, code: null, reported: false });
  await expect(
    probe('ee', {
      localState: { stage: 'blocked', reason: 'retry_exhausted', code: 'DRIVE_UNAVAILABLE' }
    })
  ).rejects.toThrow('AUTH_REQUIRED');
});

it('lets a catalog variant close with the disk and Drive codes the desktop now reports', async () => {
  for (const fn of [
    'public.service_complete_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid,text,text)',
    'private.catalog_video_failure_code(uuid)'
  ]) {
    const body = (
      await db.root<{ d: string }>('select pg_get_functiondef($1::regprocedure) d', [fn])
    )[0]!.d;
    for (const code of ['DISK_FULL', 'NEEDS_REAUTH', 'DRIVE_STORAGE_FULL'])
      expect(body, fn).toContain(`'${code}'`);
  }
});

it('keeps the recovery tables outside the cleanup-fence inventory', async () => {
  expect(
    (await db.root<{ v: boolean }>('select private.task_cleanup_coverage_verified() v'))[0]!.v
  ).toBe(true);
});
