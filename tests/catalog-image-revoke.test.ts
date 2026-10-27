import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = randomUUID();
let db: TeamTestDb;
let team: string;
let originalFailure: unknown;
let originalAfter: Record<string, unknown>;
const migration = 'supabase/migrations/20261206156000_catalog_r2_revoke_purge.sql';

async function fixture(state = 'pending', publicationState = 'ready', scope = team) {
  const publication = randomUUID();
  const pool = randomUUID();
  const purge = randomUUID();
  const classification = JSON.stringify(classifyCatalogImageName('IMG_TEST.png'));
  await db.root(
    `insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification,state,public_url)
     values($1::uuid,$2,$3,68,'image/png',1,1,$4::jsonb,$5,'https://media.test/'||($1::uuid)::text)`,
    [
      publication,
      scope,
      publication.replaceAll('-', '').repeat(2),
      classification,
      publicationState
    ]
  );
  await db.root(
    `insert into public.team_catalog_image_pool_entries(id,team_id,publication_id,public_url,classification)
     values($1,$2,$3::uuid,'https://media.test/'||($3::uuid)::text,$4::jsonb)`,
    [pool, scope, publication, classification]
  );
  await db.root(
    `insert into private.catalog_image_purges(id,publication_id,scope_id,bucket_kind,object_key,reason,state,fence,attempts,not_before)
     select $1,id,team_id,'public',object_key,'orphan_candidate',$3,7,8,clock_timestamp()+interval '24 hours'
     from private.catalog_image_publications where id=$2`,
    [purge, publication, state]
  );
  return { publication, pool, purge };
}

async function revoke(publication: string, key = randomUUID(), revision = 1, actor = owner) {
  return (
    await db.root<{ v: unknown }>(
      `select public.service_catalog_image_control_v2('revoke',$1,$2::jsonb) v`,
      [
        actor,
        JSON.stringify({
          publicationId: publication,
          revision,
          explicitRevocation: true,
          idempotencyKey: key
        })
      ]
    )
  )[0]!.v;
}

beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261206155000_catalog_r2_launch_resource_freeze.sql'
  });
  await createUser(db, { id: owner, email: `${owner}@revoke.test.invalid` });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Revoke synthetic')")
  )[0]!.id;
  const old = await fixture();
  try {
    await revoke(old.publication);
  } catch (error) {
    originalFailure = error;
  }
  originalAfter = (
    await db.root(
      `select p.state,e.active,e.revision from private.catalog_image_publications p join public.team_catalog_image_pool_entries e on e.publication_id=p.id where p.id=$1`,
      [old.publication]
    )
  )[0]!;
  await db.db.exec(readFileSync(migration, 'utf8'));
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe('045 additive publication revoke repair', () => {
  it('reproduces the applied alias failure before the new migration without mutating publication or pool', () => {
    expect(String(originalFailure)).toMatch(/e\.publication_id.*ambiguous/u);
    expect(originalAfter).toMatchObject({ state: 'ready', active: true, revision: 1 });
  });

  it.each(['pending', 'complete'])(
    'promotes a %s orphan tombstone, honors revision and replays exactly once',
    async state => {
      const target = await fixture(state);
      const untouched = await fixture();
      await expect(revoke(target.publication, randomUUID(), 2)).rejects.toThrow('NOT_FOUND');
      const key = randomUUID();
      const response = await revoke(target.publication, key);
      const after = (
        await db.root(
          `select p.state,e.active,e.revision,q.reason,q.state purge_state,q.fence,q.attempts,q.lease_until,q.not_before<=clock_timestamp() due from private.catalog_image_publications p join public.team_catalog_image_pool_entries e on e.publication_id=p.id join private.catalog_image_purges q on q.publication_id=p.id where p.id=$1`,
          [target.publication]
        )
      )[0]!;
      expect(after).toMatchObject({
        state: 'revoking',
        active: false,
        revision: 2,
        reason: 'explicit_revoke',
        purge_state: 'pending',
        fence: 8,
        attempts: 0,
        lease_until: null,
        due: true
      });
      expect(await revoke(target.publication, key)).toEqual(response);
      expect(
        (
          await db.root(`select revision from public.team_catalog_image_pool_entries where id=$1`, [
            target.pool
          ])
        )[0]!.revision
      ).toBe(2);
      expect(
        (
          await db.root(
            `select state,revision,active from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.id=$1`,
            [untouched.pool]
          )
        )[0]
      ).toMatchObject({ state: 'ready', active: true, revision: 1 });
      const claim = (
        await db.root<{ v: { id: string; fence: number } }>(
          'select public.service_catalog_image_purge_claim_v2() v'
        )
      )[0]!.v;
      expect(claim.id).toBe(target.purge);
      await expect(
        db.root('select public.service_catalog_image_purge_finish_v2($1,7,true)', [target.purge])
      ).rejects.toThrow('LEASE_MISMATCH');
      await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
        target.purge,
        claim.fence
      ]);
    }
  );

  it('fences prior cleanup receipts and preserves unknown writes and an existing explicit hold', async () => {
    const f = await fixture('deleting', 'put_unknown');
    await db.root(
      `update private.catalog_image_purges set lease_until=clock_timestamp()+interval '90 seconds',reason='explicit_revoke',not_before=clock_timestamp()+interval '10 minutes' where id=$1`,
      [f.purge]
    );
    await revoke(f.publication);
    expect(
      (
        await db.root(
          `select fence,lease_until,uncertain_write,not_before>clock_timestamp()+interval '9 minutes' held from private.catalog_image_purges where id=$1`,
          [f.purge]
        )
      )[0]
    ).toMatchObject({ fence: 8, lease_until: null, uncertain_write: true, held: true });
    await expect(
      db.root('select public.service_catalog_image_purge_finish_v2($1,7,true)', [f.purge])
    ).rejects.toThrow('LEASE_MISMATCH');
  });

  it('keeps an unknown provider write unknown even after a successful deletion observation', async () => {
    const f = await fixture('complete', 'put_unknown');
    await revoke(f.publication);
    // Earlier fixtures may have pending rows; leave only this synthetic key eligible.
    await db.root(
      "update private.catalog_image_purges set next_attempt_at='infinity' where id<>$1",
      [f.purge]
    );
    const claim = (
      await db.root<{ v: { id: string; fence: number; uncertain: boolean } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    expect(claim).toMatchObject({ id: f.purge, uncertain: true });
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      f.purge,
      claim.fence
    ]);
    expect(
      (
        await db.root(
          'select state,uncertain_write from private.catalog_image_purges where id=$1',
          [f.purge]
        )
      )[0]
    ).toMatchObject({ state: 'unknown', uncertain_write: true });
    expect(
      (
        await db.root('select state from private.catalog_image_publications where id=$1', [
          f.publication
        ])
      )[0]!.state
    ).toBe('revoking');
  });

  it('preserves viewer and cross-team denial and rechecks authority on exact replay', async () => {
    const viewer = randomUUID(),
      outsider = randomUUID(),
      manager = randomUUID();
    for (const id of [viewer, outsider, manager])
      await createUser(db, { id, email: `${id}@revoke.test.invalid` });
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer'),($1,$3,'admin')",
      [team, viewer, manager]
    );
    const otherTeam = (
      await db.asUser<{ id: string }>(
        owner,
        "select id from public.create_team('Other revoke team')"
      )
    )[0]!.id;
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
      [otherTeam, outsider]
    );
    const f = await fixture();
    for (const actor of [viewer, outsider])
      await expect(revoke(f.publication, randomUUID(), 1, actor)).rejects.toThrow(
        'PERMISSION_DENIED'
      );
    expect(
      (
        await db.root(
          'select active,revision from public.team_catalog_image_pool_entries where id=$1',
          [f.pool]
        )
      )[0]
    ).toMatchObject({ active: true, revision: 1 });
    const key = randomUUID();
    await revoke(f.publication, key, 1, manager);
    await db.root('delete from public.team_members where team_id=$1 and user_id=$2', [
      team,
      manager
    ]);
    await expect(revoke(f.publication, key, 1, manager)).rejects.toThrow('PERMISSION_DENIED');
    expect(
      (
        await db.root('select revision from public.team_catalog_image_pool_entries where id=$1', [
          f.pool
        ])
      )[0]!.revision
    ).toBe(2);
  });

  it.each(['pending', 'complete'])(
    'team deletion promotes a %s orphan with the two-minute hold and sticky uncertainty',
    async state => {
      const scope = (
        await db.asUser<{ id: string }>(
          owner,
          "select id from public.create_team('Delete synthetic')"
        )
      )[0]!.id;
      const f = await fixture(state, 'put_unknown', scope);
      await db.root('delete from public.teams where id=$1', [scope]);
      expect(
        (
          await db.root(
            `select reason,state,fence,attempts,lease_until,uncertain_write,not_before>clock_timestamp()+interval '119 seconds' held,not_before<clock_timestamp()+interval '3 minutes' bounded from private.catalog_image_purges where id=$1`,
            [f.purge]
          )
        )[0]
      ).toMatchObject({
        reason: 'team_deleted',
        state: 'pending',
        fence: 8,
        attempts: 0,
        lease_until: null,
        uncertain_write: true,
        held: true,
        bounded: true
      });
      expect(
        await db.root('select id from private.catalog_image_publications where id=$1', [
          f.publication
        ])
      ).toEqual([]);
    }
  );
});
