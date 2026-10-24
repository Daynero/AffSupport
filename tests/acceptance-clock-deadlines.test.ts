import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

let db: TeamTestDb;
const owner = randomUUID();
const admin = randomUUID();
let team: string;
let connection: string;
const hash = () => '\\x' + randomBytes(32).toString('hex');
async function recovery(action: string, credential: string, input: object = {}) {
  return (
    await db.root<{ r: Record<string, unknown> }>(
      'select public.service_team_recovery($1,$2::text::bytea,$3::jsonb) r',
      [action, credential, JSON.stringify({ protocolVersion: 2, ...input })]
    )
  )[0].r;
}
async function shift(years: number) {
  await db.root(
    'update private.acceptance_tariff_clock set tariff_at=clock_timestamp()+make_interval(years=>$1)',
    [years]
  );
  const [row] = await db.root<{ shifted: boolean; allowed: boolean }>(
    'select abs(extract(epoch from private.tariff_now()-clock_timestamp()))>86400 shifted, private.team_workspace_allowed($1) allowed',
    [team]
  );
  expect(row).toEqual({ shifted: true, allowed: true });
}
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: admin, email: 'deadlines-admin@soty.invalid' });
  await createUser(db, { id: owner, email: 'deadlines-owner@soty.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [admin]);
  await db.asUser(
    admin,
    "select public.admin_grant_space_tariff('deadlines-owner@soty.invalid','lead',(now()+interval '20 years')::date,8)"
  );
  team = (
    await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Clock deadline fixture')"
    )
  )[0].id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('clock-test','clock@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0].id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
      [team, credential]
    )
  )[0].id;
  await db.db.exec(
    await readFile(new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url), 'utf8')
  );
  await db.root(
    "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,'acceptance-clock-deadlines',now(),clock_timestamp()+interval '1 hour')"
  );
}, 120000);
afterAll(async () => db?.close());

it.each([-5, 5])(
  'keeps invitation issuance and expiry on real time with tariff shifted %i years',
  async years => {
    await shift(years);
    for (const expired of [false, true]) {
      const user = randomUUID();
      const email = `${user}@soty.invalid`;
      await createUser(db, { id: user, email });
      const invite = (
        await db.asUser<{ id: string }>(
          owner,
          "select id from public.create_invitation($1,$2,'viewer',$3::text::bytea)",
          [team, email, hash()]
        )
      )[0].id;
      const [lifetime] = await db.root<{ seconds: number }>(
        'select extract(epoch from expires_at-clock_timestamp())::float8 seconds from public.team_invitations where id=$1',
        [invite]
      );
      expect(lifetime.seconds).toBeGreaterThan(14 * 86400 - 10);
      expect(lifetime.seconds).toBeLessThanOrEqual(14 * 86400);
      if (expired)
        await db.root(
          "update public.team_invitations set created_at=clock_timestamp()-interval '15 days',expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [invite]
        );
      const accepting = db.asUser<{ id: string }>(
        user,
        'select id from public.accept_invitation($1)',
        [invite]
      );
      if (expired) await expect(accepting).rejects.toThrow('EXPIRED');
      else expect((await accepting)[0].id).toBe(team);
    }
  }
);

it.each([-5, 5])(
  'keeps enrollment and claim credentials on real time with tariff shifted %i years',
  async years => {
    await shift(years);
    for (const expired of [false, true]) {
      const ticket = hash();
      const refreshHash = hash();
      const challenge = await recovery('delegate', ticket, {
        actorId: owner,
        teamId: team,
        installationId: randomUUID()
      });
      const [lifetime] = await db.root<{ seconds: number }>(
        'select extract(epoch from expires_at-clock_timestamp())::float8 seconds from private.team_recovery_enrollments where id=$1',
        [challenge.challengeId]
      );
      expect(lifetime.seconds).toBeGreaterThan(110);
      expect(lifetime.seconds).toBeLessThanOrEqual(120);
      if (expired)
        await db.root(
          "update private.team_recovery_enrollments set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [challenge.challengeId]
        );
      const redeeming = recovery('redeem', ticket, {
        challengeId: challenge.challengeId,
        refresh: 'a'.repeat(43),
        refreshHash
      });
      if (expired) {
        await expect(redeeming).rejects.toThrow('AUTH_REQUIRED');
        continue;
      }
      await redeeming;
      const claimHash = hash();
      await recovery('rotate', refreshHash, {
        rotationId: randomUUID(),
        refresh: 'b'.repeat(43),
        refreshHash: hash(),
        claim: 'c'.repeat(43),
        claimHash
      });
      const [claim] = await db.root<{ seconds: number }>(
        'select extract(epoch from expires_at-clock_timestamp())::float8 seconds from private.team_recovery_credentials where hash=$1::text::bytea',
        [claimHash]
      );
      expect(claim.seconds).toBeGreaterThan(290);
      expect(claim.seconds).toBeLessThanOrEqual(300);
      expect(await recovery('authorize_claim', claimHash)).toMatchObject({ teamId: team });
      expect(await recovery('claim', claimHash, { requestId: randomUUID() })).toMatchObject({
        teamId: team
      });
      await expect(recovery('claim', claimHash, { requestId: randomUUID() })).rejects.toThrow(
        'RATE_LIMITED'
      );

      await db.root(
        "update private.team_recovery_credentials set expires_at=clock_timestamp()-interval '1 second' where hash=$1::text::bytea",
        [claimHash]
      );
      await expect(recovery('authorize_claim', claimHash)).rejects.toThrow('AUTH_REQUIRED');
    }
  }
);

it.each([-5, 5])(
  'keeps Undo and cleanup eligibility on real time with tariff shifted %i years',
  async years => {
    await shift(years);
    const task = (
      await db.asUser<{ id: string }>(
        owner,
        "select id from public.create_team_task($1,'Clock attachment')",
        [team]
      )
    )[0].id;
    const nonce = randomUUID();
    await db.asUser(owner, 'select public.begin_task_upload($1,$2,$3)', [team, task, nonce]);
    const operation = (
      await db.root<{ id: string }>(
        "insert into public.team_operations(team_id,actor_id,kind,idempotency_key,request_nonce) values($1,$2,'upload',$3,$3) returning id",
        [team, owner, nonce]
      )
    )[0].id;
    const material = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values($1,$2,$3,'synthetic-root','Clock image','file','image/png') returning id",
        [team, connection, randomUUID()]
      )
    )[0].id;
    await db.root("update public.team_operations set state='running' where id=$1", [operation]);
    await db.root(
      "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
      [operation, material]
    );
    await db.asUser(owner, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
      team,
      task,
      [material]
    ]);
    const detach = async () =>
      (
        await db.asUser<{ r: { id: string } }>(
          owner,
          'select public.detach_task_material_safely($1,$2,$3) r',
          [team, task, material]
        )
      )[0].r.id;
    const first = await detach();
    const claims = async () =>
      (
        await db.root<{ r: Array<{ id: string }> }>('select public.service_claim_task_cleanup() r')
      )[0].r;
    expect((await claims()).some(row => row.id === first)).toBe(false);
    await db.asUser(owner, 'select public.undo_task_material_detach($1,$2)', [team, first]);
    const second = await detach();
    await db.root(
      "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 second' where id=$1",
      [second]
    );
    await expect(
      db.asUser(owner, 'select public.undo_task_material_detach($1,$2)', [team, second])
    ).rejects.toThrow('WRONG_STATE');
    expect((await claims()).some(row => row.id === second)).toBe(true);
    expect((await claims()).some(row => row.id === second)).toBe(false);
    const [lease] = await db.root<{ seconds: number }>(
      'select extract(epoch from lease_until-clock_timestamp())::float8 seconds from private.task_attachment_cleanup where id=$1',
      [second]
    );
    expect(lease.seconds).toBeGreaterThan(50);
    expect(lease.seconds).toBeLessThanOrEqual(60);

    await db.root(
      "update private.task_attachment_cleanup set lease_until=clock_timestamp()-interval '1 second' where id=$1",
      [second]
    );
    expect((await claims()).some(row => row.id === second)).toBe(true);
  }
);
