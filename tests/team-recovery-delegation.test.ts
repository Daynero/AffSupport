import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
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
      [action, hash, JSON.stringify({ protocolVersion: 2, ...input })]
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
async function executionFixture() {
  await enroll();
  await rotate();
  await call('claim', H(4), { requestId: REQUEST });
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'process','pending',gen_random_uuid()::text,gen_random_uuid()::text) returning id",
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
  return operation;
}
async function beginExecution(operation: string, hash = H(7), job = REQUEST) {
  return (
    await db.root<{ r: { executionAllowed: boolean } }>(
      'select public.service_begin_team_recovery_execution($1::text::bytea,$2::jsonb) r',
      [hash, JSON.stringify({ operationId: operation, jobId: job })]
    )
  )[0]!.r;
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
  describe('actor-bound retirement', () => {
    it.each(['redeem', 'claim', 'checkpoint'])(
      'fences an older Edge RPC %s without relying on its handler',
      async action => {
        await expect(call(action, H(99), { protocolVersion: undefined })).rejects.toThrow(
          /AGENT_UPDATE_REQUIRED/u
        );
      }
    );

    beforeEach(async () => {
      await db.root('delete from private.team_recovery_rate_buckets where installation_id=$1', [
        INSTALL
      ]);
    });
    afterEach(async () => {
      await db.root('delete from private.team_recovery_rate_buckets where installation_id=$1', [
        INSTALL
      ]);
    });
    it('retires an authenticated actor only on the selected installation, including its unfinished bound work', async () => {
      const operation = await executionFixture();
      const otherInstallation = '34000000-0000-4000-8000-000000000099';
      await db.root(
        `insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)
        values($1,$2,$3,$4::text::bytea),($1,$5,$6,$7::text::bytea)`,
        [team, OWNER, otherInstallation, H(80), ADMIN, INSTALL, H(81)]
      );
      await db.root(
        `insert into private.team_recovery_enrollments(team_id,actor_id,installation_id,ticket_hash)
        values($1,$2,$3,$4::text::bytea),($1,$5,$3,$6::text::bytea)`,
        [team, OWNER, INSTALL, H(82), ADMIN, H(83)]
      );
      const result = await db.asUser<{ retired: number }>(
        OWNER,
        'select public.retire_team_recovery_installation($1) retired',
        [INSTALL]
      );
      expect(result[0]!.retired).toBe(1);
      const rows = await db.root<{ actor_id: string; installation_id: string; revoked: boolean }>(
        'select actor_id,installation_id,revoked_at is not null revoked from private.team_recovery_delegations'
      );
      expect(
        rows.find(row => row.actor_id === OWNER && row.installation_id === INSTALL)?.revoked
      ).toBe(true);
      expect(
        rows
          .filter(row => row.actor_id !== OWNER || row.installation_id !== INSTALL)
          .every(row => !row.revoked)
      ).toBe(true);
      expect(
        (
          await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
            operation
          ])
        )[0]!.state
      ).toBe('canceled');
      const enrollments = await db.root<{ actor_id: string }>(
        'select actor_id from private.team_recovery_enrollments where consumed_at is null'
      );
      expect(enrollments.some(row => row.actor_id === OWNER)).toBe(false);
      expect(enrollments.some(row => row.actor_id === ADMIN)).toBe(true);
      await expect(
        call('authorize_execute', H(7), { operationId: operation, jobId: REQUEST })
      ).rejects.toThrow(/AUTH_REQUIRED/u);
      const before = await db.root(
        'select id,version,revoked_at from private.team_recovery_delegations order by id'
      );
      await db.asUser(OWNER, 'select public.retire_team_recovery_installation($1)', [INSTALL]);
      expect(
        await db.root(
          'select id,version,revoked_at from private.team_recovery_delegations order by id'
        )
      ).toEqual(before);
    });

    it('preserves a completed process when the installation is retired', async () => {
      const operation = await executionFixture();
      await db.root("update public.team_operations set state='running' where id=$1", [operation]);
      await db.root(
        "update public.team_operations set state='succeeded',finished_at=clock_timestamp() where id=$1",
        [operation]
      );
      await db.asUser(OWNER, 'select public.retire_team_recovery_installation($1)', [INSTALL]);
      expect(
        (
          await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
            operation
          ])
        )[0]!.state
      ).toBe('succeeded');
    });

    it('does not let another authenticated actor retire the installation owner', async () => {
      await enroll();
      expect(
        (
          await db.asUser<{ retired: number }>(
            ADMIN,
            'select public.retire_team_recovery_installation($1) retired',
            [INSTALL]
          )
        )[0]!.retired
      ).toBe(0);
      expect(
        (
          await db.root<{ n: number }>(
            'select count(*)::int n from private.team_recovery_delegations where revoked_at is null'
          )
        )[0]!.n
      ).toBe(1);
    });

    it('keeps the installation retirement helper private and denies anonymous cleanup', async () => {
      const acl = await db.root<{
        anon_allowed: boolean;
        user_allowed: boolean;
        helper_allowed: boolean;
      }>(`select
        has_function_privilege('anon','public.retire_team_recovery_installation(uuid)','EXECUTE') anon_allowed,
        has_function_privilege('authenticated','public.retire_team_recovery_installation(uuid)','EXECUTE') user_allowed,
        has_function_privilege('authenticated','private.retire_team_recovery_delegation(uuid)','EXECUTE') helper_allowed`);
      expect(acl[0]).toEqual({ anon_allowed: false, user_allowed: true, helper_allowed: false });
      await expect(
        db.asUser(OWNER, 'select public.retire_team_recovery_installation(null)')
      ).rejects.toThrow(/INVALID_INPUT/u);
    });

    it('returns the authoritative actor on desktop redeem instead of a supplied actor hint', async () => {
      await db.root('delete from private.team_recovery_delegations');
      const challenge = await call('delegate', H(1), {
        actorId: OWNER,
        teamId: team,
        installationId: INSTALL
      });
      const receipt = await call('redeem', H(1), {
        challengeId: challenge.challengeId,
        refresh: 'a'.repeat(43),
        refreshHash: H(2),
        actorId: ADMIN
      });
      expect(receipt.actorId).toBe(OWNER);
    });
    it('retires only the refresh-bound delegation and its unfinished operations', async () => {
      const operation = await executionFixture();
      const unrelated = (
        await db.root<{ id: string }>(
          "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'process','pending',gen_random_uuid()::text,gen_random_uuid()::text) returning id",
          [team, OWNER]
        )
      )[0]!.id;
      expect(await call('disconnect', H(3), { operationId: unrelated, actorId: ADMIN })).toEqual({
        revoked: true
      });
      const rows = await db.root<{ id: string; state: string }>(
        'select id,state from public.team_operations where id=any($1::uuid[])',
        [[operation, unrelated]]
      );
      expect(rows.find(row => row.id === operation)?.state).toBe('canceled');
      expect(rows.find(row => row.id === unrelated)?.state).toBe('pending');
      await expect(
        call('authorize_execute', H(7), { operationId: operation, jobId: REQUEST })
      ).rejects.toThrow(/AUTH_REQUIRED/u);
    });
    it('accepts the previous refresh only for idempotent retirement after a lost rotation response', async () => {
      await executionFixture();
      expect(await call('disconnect', H(2), {})).toEqual({ revoked: true });
      const before = await db.root(
        'select version,revoked_at from private.team_recovery_delegations'
      );
      expect(await call('disconnect', H(2), {})).toEqual({ revoked: true });
      expect(
        await db.root('select version,revoked_at from private.team_recovery_delegations')
      ).toEqual(before);
      await expect(call('authorize_claim', H(4), {})).rejects.toThrow(/AUTH_REQUIRED/u);
    });
    it('cannot retire any delegation with an unknown refresh hash', async () => {
      await enroll();
      await expect(call('disconnect', H(99), {})).rejects.toThrow(/AUTH_REQUIRED/u);
      expect(
        (
          await db.root<{ n: number }>(
            'select count(*)::int n from private.team_recovery_delegations where revoked_at is null'
          )
        )[0]!.n
      ).toBe(1);
    });
  });

  it('allows only one execution checkpoint for an operation even after the reply is lost', async () => {
    const operation = await executionFixture();
    const begin = async () =>
      (
        await db.root<{ r: { executionAllowed: boolean } }>(
          'select public.service_begin_team_recovery_execution($1::text::bytea,$2::jsonb) r',
          [H(7), JSON.stringify({ operationId: operation, jobId: REQUEST })]
        )
      )[0]!.r;
    expect((await begin()).executionAllowed).toBe(true);
    expect((await begin()).executionAllowed).toBe(false);
    expect((await begin()).executionAllowed).toBe(false);
    await expect(
      call('checkpoint', H(7), { operationId: operation, jobId: REQUEST })
    ).rejects.toThrow(/PROCESS_RESULT_UNCERTAIN/);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.team_recovery_execution_fences where operation_id=$1',
          [operation]
        )
      )[0]!.n
    ).toBe(1);
  });
  it.each(['succeeded', 'canceled', 'failed'])(
    'does not authorize a terminal %s operation',
    async state => {
      const operation = await executionFixture();
      await db.root("update public.team_operations set state='running' where id=$1", [operation]);
      await db.root(
        'update public.team_operations set state=$2,finished_at=clock_timestamp() where id=$1',
        [operation, state]
      );
      expect((await beginExecution(operation)).executionAllowed).toBe(false);
    }
  );
  it.each(['audience', 'job', 'expired', 'revoked'])(
    'keeps the %s boundary before reservation',
    async kind => {
      const operation = await executionFixture();
      if (kind === 'expired')
        await db.root(
          "update private.team_recovery_credentials set expires_at=clock_timestamp()-interval '1 second'"
        );
      if (kind === 'revoked')
        await db.root('update private.team_recovery_delegations set revoked_at=clock_timestamp()');
      await expect(
        beginExecution(
          operation,
          kind === 'audience' ? H(4) : H(7),
          kind === 'job' ? ROTATION : REQUEST
        )
      ).rejects.toThrow(/AUTH_REQUIRED|PERMISSION_DENIED/);
      expect(
        (
          await db.root<{ n: number }>(
            'select count(*)::int n from private.team_recovery_execution_fences where operation_id=$1',
            [operation]
          )
        )[0]!.n
      ).toBe(0);
    }
  );
  it('retains the operation fence after execution credentials are reissued', async () => {
    const operation = await executionFixture();
    expect((await beginExecution(operation)).executionAllowed).toBe(true);
    await db.root(
      'insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at,operation_id,job_id,epoch) select $1::text::bytea,delegation_id,version,audience,expires_at,operation_id,job_id,epoch from private.team_recovery_credentials where hash=$2::text::bytea',
      [H(8), H(7)]
    );
    expect((await beginExecution(operation, H(8))).executionAllowed).toBe(false);
    const p = (
      await db.root<{ anon: boolean; authenticated: boolean; core: boolean }>(
        "select has_function_privilege('anon','public.service_begin_team_recovery_execution(bytea,jsonb)','execute') anon,has_function_privilege('authenticated','public.service_begin_team_recovery_execution(bytea,jsonb)','execute') authenticated,has_function_privilege('service_role','private.service_team_recovery_core(text,bytea,jsonb)','execute') core"
      )
    )[0]!;
    expect(p).toEqual({ anon: false, authenticated: false, core: false });
  });
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
  it('rejects expired enrollment without consuming it or issuing a refresh handle', async () => {
    const before = (await db.root<{ t: string }>('select clock_timestamp()::text t'))[0]!.t;
    const challenge = await call('delegate', H(20), {
      actorId: OWNER,
      teamId: team,
      installationId: INSTALL
    });
    expect(
      await db.root(
        `select expires_at between $2::timestamptz+interval '120 seconds'
          and clock_timestamp()+interval '120 seconds' as bounded
         from private.team_recovery_enrollments where id=$1`,
        [challenge.challengeId, before]
      )
    ).toEqual([{ bounded: true }]);
    await db.root(
      "update private.team_recovery_enrollments set expires_at=clock_timestamp()-interval '1 microsecond' where id=$1",
      [challenge.challengeId]
    );
    await expect(
      call('redeem', H(20), {
        challengeId: challenge.challengeId,
        refresh: 'j'.repeat(43),
        refreshHash: H(21)
      })
    ).rejects.toThrow(/AUTH_REQUIRED/);
    expect(
      await db.root(
        'select consumed_at is null as unused from private.team_recovery_enrollments where id=$1',
        [challenge.challengeId]
      )
    ).toEqual([{ unused: true }]);
    expect(
      await db.root(
        'select count(*)::int n from private.team_recovery_delegations where refresh_hash=$1::text::bytea',
        [H(21)]
      )
    ).toEqual([{ n: 0 }]);
  });
  it('rejects enrollment into an unrelated open tenant', async () => {
    const unrelated = (
      await db.asUser<{ id: string }>(ADMIN, "select id from public.create_team('Other tenant')")
    )[0]!.id;
    await expect(
      call('delegate', H(25), {
        actorId: OWNER,
        teamId: unrelated,
        installationId: INSTALL
      })
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(
      await db.root(
        'select count(*)::int n from private.team_recovery_enrollments where team_id=$1',
        [unrelated]
      )
    ).toEqual([{ n: 0 }]);
  });
  it('scopes replacement and explicit revocation to the authenticated actor and installation', async () => {
    await enroll();
    const otherInstallation = '34000000-0000-4000-8000-000000000008';
    const other = await call('delegate', H(20), {
      actorId: OWNER,
      teamId: team,
      installationId: otherInstallation
    });
    await call('redeem', H(20), {
      challengeId: other.challengeId,
      refresh: 'j'.repeat(43),
      refreshHash: H(21)
    });
    const replacement = await call('delegate', H(22), {
      actorId: OWNER,
      teamId: team,
      installationId: INSTALL
    });
    await call('redeem', H(22), {
      challengeId: replacement.challengeId,
      refresh: 'k'.repeat(43),
      refreshHash: H(23)
    });
    await expect(call('probe', H(2))).rejects.toThrow(/AUTH_REQUIRED/);
    expect((await call('probe', H(21))).allowed).toBe(true);
    expect((await call('probe', H(23))).allowed).toBe(true);
    await db.asUser(ADMIN, 'select public.revoke_team_recovery($1,$2)', [team, INSTALL]);
    const activeInstallations = () =>
      db.root<{ installation_id: string }>(
        'select installation_id from private.team_recovery_delegations where team_id=$1 and actor_id=$2 and revoked_at is null order by installation_id',
        [team, OWNER]
      );
    expect(await activeInstallations()).toEqual([
      { installation_id: INSTALL },
      { installation_id: otherInstallation }
    ]);
    await db.asUser(OWNER, 'select public.revoke_team_recovery($1,$2)', [team, INSTALL]);
    await expect(call('probe', H(23))).rejects.toThrow(/AUTH_REQUIRED/);
    expect(await activeInstallations()).toEqual([{ installation_id: otherInstallation }]);
  });
  it('bounds replay and claim lifetimes and revokes an expired rotation replay', async () => {
    await enroll();
    await rotate();
    expect(
      await db.root(
        `select round(extract(epoch from (delegation.rotation_replay_until-delegation.last_rotation_at)))::int replay_seconds,
          round(extract(epoch from (credential.expires_at-delegation.last_rotation_at)))::int claim_seconds
         from private.team_recovery_delegations delegation
         join private.team_recovery_credentials credential on credential.delegation_id=delegation.id
         where credential.hash=$1::text::bytea`,
        [H(4)]
      )
    ).toEqual([{ replay_seconds: 60, claim_seconds: 300 }]);
    await db.root(
      "update private.team_recovery_delegations set rotation_replay_until=clock_timestamp()-interval '1 microsecond' where refresh_hash=$1::text::bytea",
      [H(3)]
    );
    expect(await rotate()).toEqual({ error: 'AUTH_REQUIRED' });
    await expect(call('authorize_claim', H(4))).rejects.toThrow(/AUTH_REQUIRED/);
    expect(
      await db.root(
        'select revoked_at is not null as revoked from private.team_recovery_delegations where refresh_hash=$1::text::bytea',
        [H(3)]
      )
    ).toEqual([{ revoked: true }]);
  });
  it('rejects an expired delegation even while its claim credential is still valid', async () => {
    await enroll();
    await rotate();
    await db.root(
      "update private.team_recovery_delegations set expires_at=clock_timestamp()-interval '1 microsecond' where refresh_hash=$1::text::bytea",
      [H(3)]
    );
    expect(
      await db.root(
        'select expires_at > clock_timestamp() as live from private.team_recovery_credentials where hash=$1::text::bytea',
        [H(4)]
      )
    ).toEqual([{ live: true }]);
    await expect(call('probe', H(3))).rejects.toThrow(/AUTH_REQUIRED/);
    await expect(call('authorize_claim', H(4))).rejects.toThrow(/AUTH_REQUIRED/);
  });
});
