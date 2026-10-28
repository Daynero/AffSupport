import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

let db: TeamTestDb;
const worker = 'storage-worker';
const hash = (n: number) => n.toString(16).padStart(64, '0');
interface Usage {
  usedBytes: number;
  reservedBytes: number;
  pendingDeletionBytes: number;
  retainedBytes: number;
  libraryBytes: number;
  totalImages: number;
  availableBytes: number;
  teamBytes: number;
  otherTeamBytes: number;
  limitBytes: number;
  limitImages: number;
}
async function setup() {
  const owner = randomUUID();
  await createUser(db, { id: owner, email: `${owner}@storage.test.invalid` });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  const team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Storage synthetic')")
  )[0]!.id;
  await db.root(
    'insert into private.catalog_image_config(team_id,import_enabled) values($1,true)',
    [team]
  );
  return { owner, team };
}
async function entry(team: string, owner: string, bytes = 68) {
  const job = randomUUID(),
    id = randomUUID();
  await db.root(
    `insert into public.team_catalog_image_imports(id,team_id,actor_id,actor_scope,source_kind,state) values($1,$2,$3,$3,'local','running')`,
    [job, team, owner]
  );
  await db.root(
    `insert into private.catalog_image_import_intents(job_id,team_id,actor_scope,intent_key,request_digest,enumeration_complete) values($1::uuid,$2,$3,($1::uuid)::text,'fixture',true)`,
    [job, team, owner]
  );
  await db.root(
    `insert into private.catalog_image_import_entries(id,job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,state,fence,lease_owner,lease_until) values($1::uuid,$2,$3,($1::uuid)::text,'IMG_TEST.png',$4,'image/png',$5::jsonb,'validating',1,$6,clock_timestamp()+interval '5 minutes')`,
    [id, job, team, bytes, JSON.stringify(classifyCatalogImageName('IMG_TEST.png')), worker]
  );
  return { id, job, team, owner };
}
function image(n = 1, size = 32) {
  return {
    sha256: hash(n),
    sourceSha256: hash(n + 100),
    sourceSize: 68,
    optimizationVersion: 'lossless-v1',
    size,
    mime: 'image/png',
    width: 1,
    height: 1
  };
}
async function reserve(id: string, value = image()) {
  return (
    await db.root<{ v: { id: string; key: string; fence: number; ready: boolean } }>(
      'select public.service_catalog_image_reserve_v2($1,$2,1,$3::jsonb) v',
      [id, worker, JSON.stringify(value)]
    )
  )[0]!.v;
}
async function ready(e: Awaited<ReturnType<typeof entry>>, value = image()) {
  const p = await reserve(e.id, value);
  if (!p.ready)
    await db.root(
      "select public.service_catalog_image_publication_v2($1,$2,1,$3,$4,'public_verified')",
      [e.id, worker, p.id, p.fence]
    );
  await db.root('select public.service_catalog_image_commit_v2($1,$2,1,$3,$4,$5)', [
    e.id,
    worker,
    p.id,
    p.fence,
    `https://media.test/${p.key}`
  ]);
  return p;
}
async function control<T = Record<string, unknown>>(
  action: string,
  owner: string,
  payload: Record<string, unknown>
) {
  return (
    await db.root<{ v: T }>('select public.service_catalog_image_control_v2($1,$2,$3::jsonb) v', [
      action,
      owner,
      JSON.stringify(payload)
    ])
  )[0]!.v;
}
const usage = (team: string, owner: string) => control<Usage>('storage', owner, { teamId: team });
async function sibling(owner: string) {
  return (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Storage sibling')")
  )[0]!.id;
}
async function signal(team: string) {
  return (
    await db.root<{ v: number }>(
      'select coalesce((select revision from public.team_catalog_image_storage_signals where team_id=$1),0) v',
      [team]
    )
  )[0]!.v;
}

beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261206159000_catalog_image_storage_quota.sql'
  });
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe('045 owner physical storage budget', () => {
  it('forward-only quota reduction preserves existing over-limit publications and exact reuse', async () => {
    const old = await createTeamTestDb({
      throughMigration: '20261206158000_catalog_image_optimization_diagnostics.sql'
    });
    try {
      const owner = randomUUID();
      await createUser(old, { id: owner, email: `${owner}@quota-upgrade.test.invalid` });
      await old.root('insert into public.admin_users(user_id) values($1)', [owner]);
      const scope = (
        await old.asUser<{ id: string }>(
          owner,
          "select id from public.create_team('Quota upgrade')"
        )
      )[0]!.id;
      await old.root(
        'insert into private.catalog_image_config(team_id,import_enabled) values($1,true)',
        [scope]
      );
      for (let n = 1; n <= 3; n++)
        await old.root(
          `insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state,public_url)
        values($1,$2,50000000,'image/png',1,1,$3::jsonb,'ready','https://media.test/legacy')`,
          [scope, hash(n), JSON.stringify(classifyCatalogImageName('IMG.png'))]
        );
      await old.root(
        "update private.catalog_image_publications set public_url='https://media.test/'||object_key where team_id=$1",
        [scope]
      );
      const before = await old.root(
        'select id,state,sha256,size_bytes,object_key,public_url from private.catalog_image_publications order by id'
      );
      const signalBefore = (
        await old.root<{ revision: number }>(
          'select revision from public.team_catalog_image_storage_signals where team_id=$1',
          [scope]
        )
      )[0]!.revision;
      await old.db.exec(
        readFileSync('supabase/migrations/20261206159000_catalog_image_storage_quota.sql', 'utf8')
      );
      expect(
        await old.root(
          'select id,state,sha256,size_bytes,object_key,public_url from private.catalog_image_publications order by id'
        )
      ).toEqual(before);
      const updated = (
        await old.root<{ v: Usage }>(
          "select public.service_catalog_image_control_v2('storage',$1,jsonb_build_object('teamId',$2::text)) v",
          [owner, scope]
        )
      )[0]!.v;
      expect(updated).toMatchObject({
        limitBytes: 100000000,
        limitImages: 500,
        usedBytes: 150000000,
        totalImages: 3,
        availableBytes: 0
      });
      expect(
        (
          await old.root<{ revision: number }>(
            'select revision from public.team_catalog_image_storage_signals where team_id=$1',
            [scope]
          )
        )[0]!.revision
      ).toBeGreaterThan(signalBefore);
      const job = randomUUID(),
        reuse = randomUUID(),
        growth = randomUUID();
      await old.root(
        "insert into public.team_catalog_image_imports(id,team_id,actor_id,actor_scope,source_kind,state) values($1,$2,$3,$3,'local','running')",
        [job, scope, owner]
      );
      for (const [id, size] of [
        [reuse, 50000000],
        [growth, 1]
      ] as const)
        await old.root(
          `insert into private.catalog_image_import_entries(id,job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,state,fence,lease_owner,lease_until)
        values($1::uuid,$2,$3,($1::uuid)::text,'IMG.png',$4,'image/png',$5::jsonb,'validating',1,$6,clock_timestamp()+interval '5 minutes')`,
          [id, job, scope, size, JSON.stringify(classifyCatalogImageName('IMG.png')), worker]
        );
      await expect(
        old.root('select public.service_catalog_image_reserve_v2($1,$2,1,$3::jsonb)', [
          reuse,
          worker,
          JSON.stringify({
            size: 50000000,
            sha256: hash(1),
            mime: 'image/png',
            width: 1,
            height: 1
          })
        ])
      ).resolves.toHaveLength(1);
      await expect(
        old.root('select public.service_catalog_image_reserve_v2($1,$2,1,$3::jsonb)', [
          growth,
          worker,
          JSON.stringify({ size: 1, sha256: hash(4), mime: 'image/png', width: 1, height: 1 })
        ])
      ).rejects.toThrow('IMAGE_QUOTA_EXCEEDED');
    } finally {
      await old.close();
    }
  }, 60000);

  it('freezes raw/final identity, counts final bytes once, and permits exact legacy in-flight identity', async () => {
    expect((await db.root('select private.task_cleanup_coverage_verified() ok'))[0]!.ok).toBe(true);
    const s = await setup(),
      e = await entry(s.team, s.owner);
    const p = await ready(e);
    expect(await usage(s.team, s.owner)).toMatchObject({
      limitBytes: 100000000,
      limitImages: 500,
      usedBytes: 32,
      libraryBytes: 32,
      reservedBytes: 0,
      totalImages: 1
    });
    expect(
      (
        await db.root(
          'select source_size,source_sha256,optimization_version,canonical_size,canonical_sha256,canonical_mime from private.catalog_image_import_entries where id=$1',
          [e.id]
        )
      )[0]
    ).toMatchObject({
      source_size: 68,
      source_sha256: hash(101),
      optimization_version: 'lossless-v1',
      canonical_size: 32,
      canonical_sha256: hash(1),
      canonical_mime: 'image/png'
    });
    expect((await reserve(e.id)).id).toBe(p.id);
    await expect(reserve(e.id, { ...image(), sourceSize: 67 })).rejects.toThrow(
      'IMAGE_CONTENT_INVALID'
    );
    await expect(reserve(e.id, { ...image(), sourceSha256: hash(999) })).rejects.toThrow(
      'IMAGE_SOURCE_CHANGED'
    );
    await expect(reserve(e.id, { ...image(), sha256: hash(888) })).rejects.toThrow(
      'IMAGE_SOURCE_CHANGED'
    );
    const legacy = await entry(s.team, s.owner);
    const old = { sha256: hash(2), size: 68, mime: 'image/png', width: 1, height: 1 };
    await db.root('select public.service_catalog_image_reserve_v2($1,$2,1,$3::jsonb)', [
      legacy.id,
      worker,
      JSON.stringify(old)
    ]);
    expect(
      (
        await db.root(
          'select optimization_version,canonical_size from private.catalog_image_import_entries where id=$1',
          [legacy.id]
        )
      )[0]
    ).toMatchObject({ optimization_version: 'legacy-v0', canonical_size: 68 });
    await expect(reserve(legacy.id, image(2))).rejects.toThrow('IMAGE_SOURCE_CHANGED');
  });

  it('retains quota after library removal and releases only a known explicit purge, with Realtime invalidation', async () => {
    const s = await setup(),
      e = await entry(s.team, s.owner),
      p = await ready(e);
    const pool = (
      await db.root<{ id: string }>(
        'select id from public.team_catalog_image_pool_entries where publication_id=$1',
        [p.id]
      )
    )[0]!.id;
    await control('remove', s.owner, { entryId: pool, revision: 1, idempotencyKey: randomUUID() });
    expect(await usage(s.team, s.owner)).toMatchObject({
      usedBytes: 32,
      retainedBytes: 32,
      libraryBytes: 0
    });
    const library = await control<{
      items: Array<{ active: boolean; sizeBytes: number; inUse: boolean }>;
    }>('library', s.owner, { teamId: s.team });
    expect(library.items).toMatchObject([{ active: false, sizeBytes: 32, inUse: false }]);
    await control('revoke', s.owner, {
      publicationId: p.id,
      revision: 2,
      explicitRevocation: true,
      idempotencyKey: randomUUID()
    });
    expect(await usage(s.team, s.owner)).toMatchObject({
      usedBytes: 32,
      pendingDeletionBytes: 32,
      availableBytes: 99999968
    });
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    const before = await signal(s.team);
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      q.id,
      q.fence
    ]);
    expect(await usage(s.team, s.owner)).toMatchObject({
      usedBytes: 0,
      totalImages: 0,
      availableBytes: 100000000
    });
    expect(await signal(s.team)).toBeGreaterThan(before);
    await expect(
      db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [q.id, q.fence])
    ).rejects.toThrow('LEASE_MISMATCH');
  });

  it('invalidates another owned workspace for charge, commit, removal, reactivation and confirmed deletion without replay noise', async () => {
    const s = await setup(),
      other = await sibling(s.owner),
      e = await entry(s.team, s.owner);
    const initial = await signal(other);
    const p = await reserve(e.id);
    const charged = await signal(other);
    expect(charged).toBeGreaterThan(initial);
    await ready(e);
    const committed = await signal(other);
    expect(committed).toBeGreaterThan(charged);
    const pool = (
      await db.root<{ id: string }>(
        'select id from public.team_catalog_image_pool_entries where publication_id=$1',
        [p.id]
      )
    )[0]!.id;
    const removal = { entryId: pool, revision: 1, idempotencyKey: randomUUID() };
    await control('remove', s.owner, removal);
    const removed = await signal(other);
    expect(removed).toBeGreaterThan(committed);
    await control('remove', s.owner, removal);
    expect(await signal(other)).toBe(removed);
    const replacement = await entry(s.team, s.owner),
      reactivated = await ready(replacement);
    const active = await signal(other);
    expect(active).toBeGreaterThan(removed);
    await db.root('select public.service_catalog_image_commit_v2($1,$2,1,$3,$4,$5)', [
      replacement.id,
      worker,
      reactivated.id,
      reactivated.fence,
      `https://media.test/${reactivated.key}`
    ]);
    expect(await signal(other)).toBe(active);
    const revision = (
      await db.root<{ revision: number }>(
        'select revision from public.team_catalog_image_pool_entries where id=$1',
        [pool]
      )
    )[0]!.revision;
    const deletion = {
      publicationId: p.id,
      revision,
      explicitRevocation: true,
      idempotencyKey: randomUUID()
    };
    await control('revoke', s.owner, deletion);
    const pending = await signal(other);
    expect(pending).toBeGreaterThan(active);
    await control('revoke', s.owner, deletion);
    expect(await signal(other)).toBe(pending);
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      q.id,
      q.fence
    ]);
    expect(await signal(other)).toBeGreaterThan(pending);
    expect((await usage(other, s.owner)).usedBytes).toBe(0);
  });

  it('does not credit arbitrary revoked state, retained orphan completion or uncertain deletion', async () => {
    const s = await setup(),
      e = await entry(s.team, s.owner),
      p = await ready(e);
    await db.root(
      "update private.catalog_image_purges set state='complete' where publication_id=$1",
      [p.id]
    );
    await db.root("update private.catalog_image_publications set state='revoked' where id=$1", [
      p.id
    ]);
    expect((await usage(s.team, s.owner)).usedBytes).toBe(32);
    await db.root("update private.catalog_image_publications set state='ready' where id=$1", [
      p.id
    ]);
    await db.root(
      'update private.catalog_image_publications set uncertain_write=true where id=$1',
      [p.id]
    );
    await control('revoke', s.owner, {
      publicationId: p.id,
      revision: 1,
      explicitRevocation: true,
      idempotencyKey: randomUUID()
    });
    expect(
      (
        await control<{ items: Array<{ publicationState: string }> }>('library', s.owner, {
          teamId: s.team
        })
      ).items[0]!.publicationState
    ).toBe('purge_unknown');
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      q.id,
      q.fence
    ]);
    expect(await usage(s.team, s.owner)).toMatchObject({ usedBytes: 32, pendingDeletionBytes: 32 });
  });

  it('shows real failed cleanup as unknown without inventing a publication transition or quota credit', async () => {
    const s = await setup(),
      other = await sibling(s.owner),
      p = await ready(await entry(s.team, s.owner));
    await control('revoke', s.owner, {
      publicationId: p.id,
      revision: 1,
      explicitRevocation: true,
      idempotencyKey: randomUUID()
    });
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    const before = await signal(other);
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,false)', [
      q.id,
      q.fence
    ]);
    expect(await signal(other)).toBeGreaterThan(before);
    expect(
      (
        await db.root('select state from private.catalog_image_publications where id=$1', [p.id])
      )[0]!.state
    ).toBe('revoking');
    expect(
      (
        await control<{ items: Array<{ publicationState: string }> }>('library', s.owner, {
          teamId: s.team
        })
      ).items[0]!.publicationState
    ).toBe('purge_unknown');
    expect(await usage(s.team, s.owner)).toMatchObject({ usedBytes: 32, pendingDeletionBytes: 32 });
  });

  it('credits actual known orphan deletion while keeping a ready orphan completion charged', async () => {
    const s = await setup(),
      e = await entry(s.team, s.owner),
      p = await reserve(e.id);
    await db.root(
      "update private.catalog_image_import_entries set state='failed',lease_until=null where id=$1",
      [e.id]
    );
    await db.root(
      'update private.catalog_image_purges set not_before=clock_timestamp() where publication_id=$1',
      [p.id]
    );
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    expect(
      (
        await db.root('select state from private.catalog_image_publications where id=$1', [p.id])
      )[0]!.state
    ).toBe('purging');
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      q.id,
      q.fence
    ]);
    expect((await usage(s.team, s.owner)).usedBytes).toBe(0);
    const kept = await ready(await entry(s.team, s.owner), image(2));
    await db.root(
      'update private.catalog_image_purges set not_before=clock_timestamp() where publication_id=$1',
      [kept.id]
    );
    expect(
      (await db.root<{ v: unknown }>('select public.service_catalog_image_purge_claim_v2() v'))[0]!
        .v
    ).toBeNull();
    expect(
      (
        await db.root('select state from private.catalog_image_purges where publication_id=$1', [
          kept.id
        ])
      )[0]!.state
    ).toBe('complete');
    expect(await usage(s.team, s.owner)).toMatchObject({ usedBytes: 32, libraryBytes: 32 });
  });

  it('charges reserved bytes across owned teams, blocks only growth and permits retained dedup over quota', async () => {
    const s = await setup(),
      e = await entry(s.team, s.owner),
      p = await ready(e);
    const other = (
      await db.asUser<{ id: string }>(s.owner, "select id from public.create_team('Other storage')")
    )[0]!.id;
    await db.root(
      'insert into private.catalog_image_config(team_id,import_enabled) values($1,true)',
      [other]
    );
    const e2 = await entry(other, s.owner);
    await reserve(e2.id, image(2));
    expect(await usage(s.team, s.owner)).toMatchObject({
      usedBytes: 64,
      reservedBytes: 32,
      teamBytes: 32,
      otherTeamBytes: 32
    });
    // Existing over-limit accounts are legal; this trusted fixture represents retained legacy bytes.
    await db.root(
      `insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes) select gen_random_uuid(),gen_random_uuid()::text,$1,$2,50000000 from generate_series(1,2)`,
      [s.team, s.owner]
    );
    const e3 = await entry(s.team, s.owner);
    expect((await reserve(e3.id)).id).toBe(p.id);
    await expect(reserve((await entry(other, s.owner)).id, image(3))).rejects.toThrow(
      'IMAGE_QUOTA_EXCEEDED'
    );
    expect((await usage(s.team, s.owner)).availableBytes).toBe(0);
  });

  it('enforces the unique-object count independently of bytes and does not persist failed output metadata', async () => {
    const s = await setup();
    await db.root(
      `insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes) select gen_random_uuid(),gen_random_uuid()::text,$1,$2,1 from generate_series(1,500)`,
      [s.team, s.owner]
    );
    const e = await entry(s.team, s.owner);
    await expect(reserve(e.id)).rejects.toThrow('IMAGE_QUOTA_EXCEEDED');
    expect((await usage(s.team, s.owner)).totalImages).toBe(500);
    expect(
      (
        await db.root(
          'select canonical_size,optimization_version from private.catalog_image_import_entries where id=$1',
          [e.id]
        )
      )[0]
    ).toMatchObject({ canonical_size: null, optimization_version: null });
  });

  it('reattributes existing bytes on owner transfer, survives deletion, and credits the last owner only after purge', async () => {
    const s = await setup(),
      recipient = await setup(),
      e = await entry(s.team, s.owner),
      p = await ready(e);
    await db.root(
      `insert into private.catalog_image_storage(publication_id,object_key,team_scope,owner_scope,size_bytes) select gen_random_uuid(),gen_random_uuid()::text,$1,$2,50000000 from generate_series(1,2)`,
      [recipient.team, recipient.owner]
    );
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
      [s.team, recipient.owner]
    );
    const oldSibling = await sibling(s.owner);
    const oldSignal = await signal(oldSibling),
      newSignal = await signal(recipient.team),
      movingSignal = await signal(s.team);
    await db.root('update public.teams set owner_id=$2 where id=$1', [s.team, recipient.owner]);
    expect(await signal(oldSibling)).toBeGreaterThan(oldSignal);
    expect(await signal(recipient.team)).toBeGreaterThan(newSignal);
    expect(await signal(s.team)).toBeGreaterThan(movingSignal);
    expect(await usage(recipient.team, recipient.owner)).toMatchObject({
      usedBytes: 100000032,
      otherTeamBytes: 32,
      availableBytes: 0
    });
    await expect(reserve((await entry(s.team, recipient.owner)).id, image(2))).rejects.toThrow(
      'IMAGE_QUOTA_EXCEEDED'
    );
    expect(
      (
        await db.root(
          'select owner_scope from private.catalog_image_storage where publication_id=$1',
          [p.id]
        )
      )[0]!.owner_scope
    ).toBe(recipient.owner);
    const beforeDeletion = await signal(recipient.team);
    await db.root('delete from public.teams where id=$1', [s.team]);
    expect(await signal(s.team)).toBe(0);
    expect(await signal(recipient.team)).toBeGreaterThan(beforeDeletion);
    expect(
      (
        await db.root('select private.catalog_image_storage_lock($1,$2) account', [s.team, s.owner])
      )[0]!.account
    ).toBe(recipient.owner);
    expect(await usage(recipient.team, recipient.owner)).toMatchObject({
      usedBytes: 100000032,
      pendingDeletionBytes: 32
    });
    await db.root(
      'update private.catalog_image_purges set not_before=clock_timestamp(),next_attempt_at=clock_timestamp() where publication_id=$1',
      [p.id]
    );
    const q = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_purge_claim_v2() v'
      )
    )[0]!.v;
    await db.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      q.id,
      q.fence
    ]);
    expect((await usage(recipient.team, recipient.owner)).usedBytes).toBe(100000000);
  });

  it('permits storage aggregates to viewers while library identities and cross-team reads stay private', async () => {
    const s = await setup(),
      foreign = await setup(),
      viewer = randomUUID();
    await createUser(db, { id: viewer, email: `${viewer}@storage.test.invalid` });
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
      [s.team, viewer]
    );
    const p = await ready(await entry(s.team, s.owner));
    await ready(await entry(foreign.team, foreign.owner));
    await db.root(
      "insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity,state) values($1,$2,$3,'create:1','unknown')",
      [s.team, p.id, randomUUID()]
    );
    const aggregate = await usage(s.team, viewer);
    expect(Object.keys(aggregate)).toHaveLength(11);
    expect(aggregate.usedBytes).toBe(32);
    await expect(control('library', viewer, { teamId: s.team })).rejects.toThrow(
      'PERMISSION_DENIED'
    );
    await expect(usage(s.team, foreign.owner)).rejects.toThrow('PERMISSION_DENIED');
    expect(
      (await control<{ items: Array<{ inUse: boolean }> }>('library', s.owner, { teamId: s.team }))
        .items[0]!.inUse
    ).toBe(true);
    await db.root('set role authenticated');
    try {
      expect(
        await db.asUser(
          viewer,
          'select team_id from public.team_catalog_image_storage_signals where team_id in ($1,$2)',
          [s.team, foreign.team]
        )
      ).toEqual([{ team_id: s.team }]);
      await expect(
        db.asUser(
          viewer,
          'update public.team_catalog_image_storage_signals set revision=revision+1 where team_id=$1',
          [s.team]
        )
      ).rejects.toThrow(/permission denied/u);
      await expect(db.root('select * from private.catalog_image_storage')).rejects.toThrow(
        /permission denied/u
      );
    } finally {
      await db.root('reset role');
    }
  });

  it('refuses unattributable history and distinguishes known orphan deletion from kept-ready backfill', async () => {
    const old = await createTeamTestDb({
      throughMigration: '20261206156000_catalog_r2_revoke_purge.sql'
    });
    try {
      await old.root(
        "insert into private.catalog_image_purges(scope_id,bucket_kind,object_key,reason) values($1,'public','v1/unattributed','team_deleted')",
        [randomUUID()]
      );
      await expect(
        old.db.exec(
          readFileSync('supabase/migrations/20261206157000_catalog_image_storage.sql', 'utf8')
        )
      ).rejects.toThrow('CATALOG_IMAGE_STORAGE_BACKFILL_UNATTRIBUTABLE');
      await old.root("delete from private.catalog_image_purges where object_key='v1/unattributed'");
      const account = randomUUID();
      await createUser(old, { id: account, email: `${account}@backfill.test.invalid` });
      await old.root('insert into public.admin_users(user_id) values($1)', [account]);
      const scope = (
        await old.asUser<{ id: string }>(
          account,
          "select id from public.create_team('Backfill synthetic')"
        )
      )[0]!.id;
      for (const state of ['ready', 'revoked']) {
        const publication = randomUUID();
        await old.root(
          `insert into private.catalog_image_publications(id,team_id,sha256,size_bytes,mime,width,height,classification,state)
          values($1,$2,$3,32,'image/png',1,1,$4::jsonb,$5)`,
          [
            publication,
            scope,
            publication.replaceAll('-', '').repeat(2),
            JSON.stringify(classifyCatalogImageName('IMG.png')),
            state
          ]
        );
        await old.root(
          `insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,state)
          select id,team_id,'public',object_key,'orphan_candidate','complete' from private.catalog_image_publications where id=$1`,
          [publication]
        );
      }
      await old.db.exec(
        readFileSync('supabase/migrations/20261206157000_catalog_image_storage.sql', 'utf8')
      );
      expect(
        await old.root(
          'select p.state,s.charged from private.catalog_image_storage s join private.catalog_image_publications p on p.id=s.publication_id order by p.state'
        )
      ).toEqual([
        { state: 'ready', charged: true },
        { state: 'revoked', charged: false }
      ]);
    } finally {
      await old.close();
    }
  }, 60000);
});
