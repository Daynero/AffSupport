import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: a recovery claim interrupted between its 'pending' receipt and the
 * registration left the receipt pending forever, so every later claim for the
 * delegation answered {pending:true} and background work stopped for good.
 * An abandoned pending receipt (older than any claim can live) no longer blocks.
 */
const OWNER = '47000000-0000-4000-8000-0000000000a1';
const ADMIN = '47000000-0000-4000-8000-0000000000a2';
let db: TeamTestDb;
let team: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@stale-claim.test' });
  await createUser(db, { id: ADMIN, email: 'admin@stale-claim.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  await db.asUser(
    ADMIN,
    "select public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('owner@stale-claim.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(0)::integer))"
  );
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Synthetic stale claim')"
    )
  )[0]!.id;
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function delegationWithCredential(hashByte: string) {
  const delegation = randomUUID();
  await db.root(
    `insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash)
     values($1,$2,$3,gen_random_uuid(),decode(repeat($4,32),'hex'))`,
    [delegation, team, OWNER, hashByte]
  );
  await db.root(
    `insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)
     values(decode(repeat($2,32),'hex'),$1,(select version from private.team_recovery_delegations where id=$1),'claim',clock_timestamp()+interval '5 minutes')`,
    [delegation, hashByte]
  );
  return delegation;
}
const claim = (hashByte: string) =>
  db.root<{ r: Record<string, unknown> }>(
    `select private.service_team_recovery_core('claim',decode(repeat($1,32),'hex'),jsonb_build_object('requestId',gen_random_uuid())) r`,
    [hashByte]
  );

it('still holds a recent pending claim', async () => {
  const delegation = await delegationWithCredential('a1');
  await db.root(
    `insert into private.team_recovery_claim_receipts(delegation_id,request_id,created_at)
     values($1,gen_random_uuid(),clock_timestamp()-interval '2 minutes')`,
    [delegation]
  );
  expect((await claim('a1'))[0]!.r).toEqual({ pending: true });
});

it('lets a new claim through once the pending receipt is abandoned', async () => {
  const delegation = await delegationWithCredential('b2');
  await db.root(
    `insert into private.team_recovery_claim_receipts(delegation_id,request_id,created_at)
     values($1,gen_random_uuid(),clock_timestamp()-interval '20 minutes')`,
    [delegation]
  );
  const answer = (await claim('b2'))[0]!.r;
  expect(answer).not.toEqual({ pending: true });
  const left = await db.root<{ n: number }>(
    `select count(*)::int n from private.team_recovery_claim_receipts
     where delegation_id=$1 and created_at<clock_timestamp()-interval '15 minutes'`,
    [delegation]
  );
  expect(left[0]!.n).toBe(0);
});
