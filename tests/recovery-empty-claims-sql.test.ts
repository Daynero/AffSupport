import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Backend audit 2026-11-20: every recovery poll wrote a Vault secret and a receipt kept for
 * 30 days — 15 686 a day for 31 delegations, 59 424 of 59 438 saying «no job»
 * (20261220100000). An empty answer now leaves no secret and is pruned after an hour; an
 * answer that hands out a job is stored, replayed and retained exactly as before.
 */
const OWNER = '47000000-0000-4000-8000-0000000000e1';
const ADMIN = '47000000-0000-4000-8000-0000000000e2';
const EMPTY = { job: null, operationCredential: null };
let db: TeamTestDb;
let team: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@empty-claim.test' });
  await createUser(db, { id: ADMIN, email: 'admin@empty-claim.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  await db.asUser(
    ADMIN,
    "select public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('owner@empty-claim.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(0)::integer))"
  );
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Synthetic empty claim')"
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
async function core(action: string, hashByte: string, input: object) {
  return (
    await db.root<{ r: Record<string, unknown> }>(
      `select private.service_team_recovery_core($1,decode(repeat($2,32),'hex'),$3::jsonb) r`,
      [action, hashByte, JSON.stringify(input)]
    )
  )[0]!.r;
}
const claimSecrets = async () =>
  (
    await db.root<{ n: number }>(
      "select count(*)::int n from vault.secrets where name like 'soty-recovery-claim-%'"
    )
  )[0]!.n;
async function receipt(delegation: string, request: string) {
  return (
    await db.root<{
      state: string;
      response_secret_id: string | null;
      operation_id: string | null;
    }>(
      `select state,response_secret_id,operation_id
       from private.team_recovery_claim_receipts where delegation_id=$1 and request_id=$2`,
      [delegation, request]
    )
  )[0];
}

it('confirms an empty answer without a Vault secret and replays it unchanged', async () => {
  const delegation = await delegationWithCredential('c1');
  const request = randomUUID();
  const before = await claimSecrets();
  await core('claim', 'c1', { requestId: request });

  expect(
    await core('register_claim', 'c1', { requestId: request, response: EMPTY, operationHash: null })
  ).toEqual(EMPTY);
  expect(await claimSecrets()).toBe(before);
  expect(await receipt(delegation, request)).toEqual({
    state: 'confirmed',
    response_secret_id: null,
    operation_id: null
  });

  // A lost response is asked for again under the same request id, on either action.
  expect(await core('claim', 'c1', { requestId: request })).toEqual({ replay: EMPTY });
  expect(
    await core('register_claim', 'c1', { requestId: request, response: EMPTY, operationHash: null })
  ).toEqual(EMPTY);
  expect(await claimSecrets()).toBe(before);
});

it('still keeps an answer that hands out a job in Vault and replays it from there', async () => {
  const delegation = await delegationWithCredential('c2');
  const request = randomUUID();
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'process','pending',gen_random_uuid()::text,gen_random_uuid()::text) returning id",
      [team, OWNER]
    )
  )[0]!.id;
  const answer = {
    job: { operationId: operation, jobId: request },
    operationCredential: 'x'.repeat(43)
  };
  const before = await claimSecrets();
  await core('claim', 'c2', { requestId: request });

  expect(
    await core('register_claim', 'c2', {
      requestId: request,
      response: answer,
      operationHash: '\\x' + '77'.repeat(32)
    })
  ).toEqual(answer);
  expect(await claimSecrets()).toBe(before + 1);
  const stored = await receipt(delegation, request);
  expect(stored).toMatchObject({ state: 'confirmed', operation_id: operation });
  expect(stored!.response_secret_id).toBeTruthy();
  expect(await core('claim', 'c2', { requestId: request })).toEqual({ replay: answer });
});

it('sends anything but the exact empty answer to Vault, so a replay can never invent one', async () => {
  // Only the constant is left out of Vault. A jobless answer that names a credential, or
  // carries a field this database has not seen, keeps the encrypted path and its own copy.
  for (const [hashByte, odd] of [
    ['c3', { job: null, operationCredential: 'y'.repeat(43) }],
    ['c6', { job: null, operationCredential: null, retryAfterMs: 30_000 }],
    ['c7', { job: null }]
  ] as const) {
    const delegation = await delegationWithCredential(hashByte);
    const request = randomUUID();
    const before = await claimSecrets();
    await core('claim', hashByte, { requestId: request });
    expect(
      await core('register_claim', hashByte, {
        requestId: request,
        response: odd,
        operationHash: null
      })
    ).toEqual(odd);
    expect(await claimSecrets()).toBe(before + 1);
    expect((await receipt(delegation, request))!.response_secret_id).toBeTruthy();
    expect(await core('claim', hashByte, { requestId: request })).toEqual({ replay: odd });
  }
});

it('prunes jobless receipts after an hour, with a Vault secret when they have one, and nothing else', async () => {
  // A jobless receipt carries a secret when an older build wrote it, or when the answer was
  // not the exact constant. Either way nothing was handed out, so it goes with its secret.
  const delegation = await delegationWithCredential('c4');
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'process','pending',gen_random_uuid()::text,gen_random_uuid()::text) returning id",
      [team, OWNER]
    )
  )[0]!.id;
  const row = async (
    age: string,
    state: 'pending' | 'confirmed',
    options: { secret?: boolean; operation?: string } = {}
  ) => {
    const request = randomUUID();
    const secret = options.secret
      ? (
          await db.root<{ id: string }>(
            "select vault.create_secret('{}','soty-recovery-claim-'||gen_random_uuid()::text,'Scoped recovery claim') id"
          )
        )[0]!.id
      : null;
    await db.root(
      `insert into private.team_recovery_claim_receipts(delegation_id,request_id,state,response_secret_id,operation_id,created_at)
       values($1,$2,$3,$4,$5,clock_timestamp()-$6::interval)`,
      [delegation, request, state, secret, options.operation ?? null, age]
    );
    return { request, secret };
  };
  const oldInline = await row('2 hours', 'confirmed');
  const oldLegacy = await row('3 days', 'confirmed', { secret: true });
  const recent = await row('20 minutes', 'confirmed');
  const recentLegacy = await row('50 minutes', 'confirmed', { secret: true });
  const withJob = await row('3 days', 'confirmed', { secret: true, operation });
  const pending = await row('5 minutes', 'pending');

  await db.root('select private.sweep_workspace_recovery()');

  const present = async (request: string) => (await receipt(delegation, request)) !== undefined;
  const secretPresent = async (id: string | null) =>
    (await db.root('select 1 from vault.secrets where id=$1', [id])).length === 1;
  expect(await present(oldInline.request)).toBe(false);
  expect(await present(oldLegacy.request)).toBe(false);
  expect(await secretPresent(oldLegacy.secret)).toBe(false);
  expect(await present(recent.request)).toBe(true);
  expect(await present(recentLegacy.request)).toBe(true);
  expect(await secretPresent(recentLegacy.secret)).toBe(true);
  expect(await present(withJob.request)).toBe(true);
  expect(await secretPresent(withJob.secret)).toBe(true);
  expect(await present(pending.request)).toBe(true);
});

it('treats a replay that arrives after the prune as a new poll', async () => {
  // The agent keeps the request id of an unanswered poll and may ask again hours later
  // (a laptop that slept). The receipt is gone by then: the same request id is a fresh claim
  // — neither a replay of an answer nobody stored nor a claim stuck behind the old one.
  const delegation = await delegationWithCredential('c8');
  const request = randomUUID();
  await core('claim', 'c8', { requestId: request });
  await core('register_claim', 'c8', { requestId: request, response: EMPTY, operationHash: null });
  await db.root(
    `update private.team_recovery_claim_receipts set created_at=clock_timestamp()-interval '2 hours'
     where delegation_id=$1 and request_id=$2`,
    [delegation, request]
  );
  await db.root('select private.prune_empty_recovery_claims(100)');
  expect(await receipt(delegation, request)).toBeUndefined();
  // The claim rate limit is about polls thirty seconds apart, not about this.
  await db.root(
    `update private.team_recovery_delegations set last_claim_at=clock_timestamp()-interval '2 hours' where id=$1`,
    [delegation]
  );

  const answer = await core('claim', 'c8', { requestId: request });
  expect(answer).not.toHaveProperty('replay');
  expect(answer).not.toHaveProperty('pending');
  expect(answer).toMatchObject({ delegationId: delegation });
  expect(await receipt(delegation, request)).toMatchObject({ state: 'pending' });
  // And it completes like any poll.
  expect(
    await core('register_claim', 'c8', { requestId: request, response: EMPTY, operationHash: null })
  ).toEqual(EMPTY);
});

it('bounds one prune and makes progress on the next', async () => {
  const delegation = await delegationWithCredential('c5');
  await db.root(
    `insert into private.team_recovery_claim_receipts(delegation_id,request_id,state,created_at)
     select $1,gen_random_uuid(),'confirmed',clock_timestamp()-interval '2 hours' from generate_series(1,25)`,
    [delegation]
  );
  const prune = async (limit: number) =>
    (await db.root<{ n: number }>('select private.prune_empty_recovery_claims($1) n', [limit]))[0]!
      .n;
  expect(await prune(10)).toBe(10);
  expect(await prune(10)).toBe(10);
  expect(await prune(10)).toBe(5);
  expect(await prune(10)).toBe(0);
});

it('keeps the prune out of reach of every API role', async () => {
  for (const role of ['anon', 'authenticated', 'service_role'])
    expect(
      await db.root(
        "select has_function_privilege($1,'private.prune_empty_recovery_claims(integer)','EXECUTE') allowed",
        [role]
      )
    ).toEqual([{ allowed: false }]);
});

it('leaves the receipts out of the attachment cleanup inventory, which stays verified', async () => {
  // A jsonb column on the receipts would have listed them among the tables that can hold a
  // material reference and switched cleanup of task-owned uploads off for the whole database.
  expect(
    await db.root(
      "select count(*)::int n from private.task_cleanup_reference_tables() where table_name='team_recovery_claim_receipts'"
    )
  ).toEqual([{ n: 0 }]);
  expect(await db.root('select private.task_cleanup_coverage_verified() ok')).toEqual([
    { ok: true }
  ]);
});
