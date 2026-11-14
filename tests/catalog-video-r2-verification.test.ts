import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { Md5 } from '../supabase/functions/_shared/md5';
import { setQueryExecutor } from '../scripts/analytics/db';
import { getCatalogVideoR2Diagnosis } from '../scripts/analytics/catalog-video-r2';
import { investigatePrivacyFailure } from '../scripts/analytics/types';

const OWNER = '50000000-0000-4000-8000-000000000011';
const WORKER = 'catalog-video-r2:verification-test';
const PART = 5242880;
let db: TeamTestDb;
let team: string;
let source: string;
const rpc = async <T = unknown>(name: string, args: unknown[]) =>
  (
    await db.root<{ v: T }>(
      `select public.service_catalog_video_r2_${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`,
      args
    )
  )[0]!.v;
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261208130000_catalog_video_r2_verification.sql'
  });
  setQueryExecutor(async (sql, params) => db.root(sql, params));
  await createUser(db, { id: OWNER, email: 'verification@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Verification')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('verify','verify@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,'video','root','Video','file','video','video/mp4',$3,$4) returning id",
      [team, connection, PART + 1, 'a'.repeat(32)]
    )
  )[0]!.id;
}, 120000);
afterAll(async () => {
  setQueryExecutor(null);
  await db?.close();
});

async function fixture() {
  const bytes = new Uint8Array(PART + 1);
  bytes[PART] = 17;
  const hash = new Md5().update(bytes);
  const copy = (
    await db.root<{ id: string }>(
      "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,size_bytes,source_md5,part_bytes,state,lease_owner,lease_until,fence,attempts) values($1,$2,gen_random_uuid()::text,$3,$4,$5,'uploading',$6,clock_timestamp()+interval '90 seconds',1,23) returning id",
      [team, source, bytes.length, hash.digest(), PART, WORKER]
    )
  )[0]!.id;
  const base = [copy, WORKER, 1];
  const manifest = [
    {
      partNumber: 1,
      sizeBytes: PART,
      sha256: 'a'.repeat(64),
      etag: '"part1"',
      verifiedBy: 'readback'
    },
    { partNumber: 2, sizeBytes: 1, sha256: 'b'.repeat(64), etag: '"part2"', verifiedBy: 'readback' }
  ];
  for (const p of manifest)
    await rpc('part', [...base, p.partNumber, p.sizeBytes, p.sha256, p.etag, p.verifiedBy, 1]);
  await rpc('verifying', base);
  const binding = [...base, '"staging"', manifest];
  const open = () => rpc<Record<string, unknown>>('verification_open', [...binding, hash.digest()]);
  const prefix = new Md5().update(bytes.subarray(0, PART));
  return { copy, base, manifest, binding, hash, prefix, open };
}

describe('service-only durable video integrity', () => {
  it('preserves workspace cleanup coverage and dispatches an isolated staging obligation after lost acknowledgement', async () => {
    expect(await db.root('select private.task_cleanup_coverage_verified() ok')).toEqual([
      { ok: true }
    ]);
    const hasWork = async () =>
      (
        await db.root<{ work: boolean }>("select private.catalog_video_r2_has_work('sweep') work")
      )[0]!.work;
    expect(await hasWork()).toBe(false);
    const copy = '50000000-0000-4000-8000-000000000099';
    await db.root(
      `insert into private.catalog_video_r2_staging_cleanup(copy_id,team_id,object_key,staging_etag)
       values($1,$2,'isolated-staging','"staging"')`,
      [copy, team]
    );
    expect(await hasWork()).toBe(true);
    const claim = await rpc<{ fence: number }>('claim_staging_cleanup', [WORKER, copy]);
    expect(await hasWork()).toBe(false);
    await rpc('finish_staging_cleanup', [copy, claim.fence, false, 'VIDEO_R2_CLEANUP_PARTIAL']);
    expect(await hasWork()).toBe(false);
    await db.root(
      'update private.catalog_video_r2_staging_cleanup set next_attempt_at=clock_timestamp() where copy_id=$1',
      [copy]
    );
    expect(await hasWork()).toBe(true);
    const retry = await rpc<{ fence: number }>('claim_staging_cleanup', [WORKER, copy]);
    await rpc('finish_staging_cleanup', [copy, retry.fence, true, null]);
    expect(await hasWork()).toBe(false);
  });
  it('resumes exact contiguous checkpoints, prevents skipping/replaying, and atomically queues staging-only cleanup', async () => {
    const f = await fixture();
    expect(await f.open()).toEqual({
      partsChecked: 0,
      bytesChecked: 0,
      hashState: null,
      finalMd5: null
    });
    await expect(rpc('ready', [...f.base, true, 1])).rejects.toThrow('VIDEO_R2_CHECKSUM_MISMATCH');
    await expect(
      rpc('verification_advance', [...f.binding, 1, f.hash.snapshot(), f.hash.digest()])
    ).rejects.toThrow('LEASE_MISMATCH');
    await rpc('verification_advance', [...f.binding, 0, f.prefix.snapshot(), null]);
    const observed = await f.open();
    expect(observed).toMatchObject({ partsChecked: 1, bytesChecked: PART, finalMd5: null });
    expect(
      Md5.restore(observed.hashState, PART)
        .update(new Uint8Array([17]))
        .digest()
    ).toBe(f.hash.digest());
    await expect(
      rpc('verification_advance', [...f.binding, 0, f.prefix.snapshot(), null])
    ).rejects.toThrow('LEASE_MISMATCH');
    await rpc('verification_advance', [...f.binding, 1, f.hash.snapshot(), f.hash.digest()]);
    await rpc('ready', [...f.base, true, 1]);
    expect(
      await db.root(
        'select state,full_hash_verified from private.catalog_video_r2_copies where id=$1',
        [f.copy]
      )
    ).toEqual([{ state: 'ready', full_hash_verified: true }]);
    const cleanup = await rpc<{ copyId: string; fence: number }>('claim_staging_cleanup', [
      WORKER,
      f.copy
    ]);
    expect(cleanup.copyId).toBe(f.copy);
    await rpc('finish_staging_cleanup', [f.copy, cleanup.fence, false, 'VIDEO_R2_CLEANUP_PARTIAL']);
    expect(
      await db.root('select state from private.catalog_video_r2_copies where id=$1', [f.copy])
    ).toEqual([{ state: 'ready' }]);
    expect(await rpc('claim_staging_cleanup', [WORKER, f.copy])).toBeNull();
    await db.root(
      'update private.catalog_video_r2_staging_cleanup set next_attempt_at=clock_timestamp() where copy_id=$1',
      [f.copy]
    );
    const retry = await rpc<{ fence: number }>('claim_staging_cleanup', [WORKER, f.copy]);
    await expect(
      rpc('finish_staging_cleanup', [f.copy, cleanup.fence, true, null])
    ).rejects.toThrow('LEASE_MISMATCH');
    await rpc('finish_staging_cleanup', [f.copy, retry.fence, true, null]);
    expect(await rpc('claim_staging_cleanup', [WORKER, f.copy])).toBeNull();
  });
  it('rejects changed staging, manifest, digest, source and expired or replaced leases', async () => {
    const f = await fixture();
    await f.open();
    await expect(
      rpc('verification_open', [...f.base, '"other"', f.manifest, f.hash.digest()])
    ).rejects.toThrow('VIDEO_R2_CHECKSUM_MISMATCH');
    await expect(rpc('verification_open', [...f.binding, 'f'.repeat(32)])).rejects.toThrow(
      'VIDEO_R2_CHECKSUM_MISMATCH'
    );
    await expect(
      rpc('verification_open', [...f.base, '"staging"', [], f.hash.digest()])
    ).rejects.toThrow('VIDEO_R2_CHECKSUM_MISMATCH');
    await expect(
      rpc('verification_advance', [
        f.copy,
        WORKER,
        0,
        '"staging"',
        f.manifest,
        0,
        f.prefix.snapshot(),
        null
      ])
    ).rejects.toThrow('LEASE_MISMATCH');
    await rpc('verification_advance', [...f.binding, 0, f.prefix.snapshot(), null]);
    await expect(
      rpc('verification_advance', [...f.binding, 1, f.hash.snapshot(), 'f'.repeat(32)])
    ).rejects.toThrow('VIDEO_R2_CHECKSUM_MISMATCH');
    await db.root(
      "update private.catalog_video_r2_copies set lease_until=clock_timestamp()-interval '1 second' where id=$1",
      [f.copy]
    );
    await expect(f.open()).rejects.toThrow('LEASE_MISMATCH');
    await expect(rpc('ready', [...f.base, true, 1])).rejects.toThrow('LEASE_MISMATCH');
  });
  it('rejects malformed hash state without advancing and resets failures only on durable progress', async () => {
    const f = await fixture();
    await f.open();
    await db.root('update private.catalog_video_r2_copies set attempts=23 where id=$1', [f.copy]);
    await f.open();
    for (const patch of [
      { version: 2 },
      { state: [1, 2, 3] },
      { tail: [1] },
      { bytes: PART - 1 },
      { state: [4294967296, 1, 2, 3] }
    ]) {
      await expect(
        rpc('verification_advance', [...f.binding, 0, { ...f.prefix.snapshot(), ...patch }, null])
      ).rejects.toThrow('INVALID_INPUT');
    }
    expect(
      await db.root('select attempts from private.catalog_video_r2_copies where id=$1', [f.copy])
    ).toEqual([{ attempts: 23 }]);
    await rpc('verification_advance', [...f.binding, 0, f.prefix.snapshot(), null]);
    expect(
      await db.root('select attempts from private.catalog_video_r2_copies where id=$1', [f.copy])
    ).toEqual([{ attempts: 0 }]);
    await db.root(
      "update private.catalog_video_r2_parts set etag='changed' where copy_id=$1 and part_number=1",
      [f.copy]
    );
    await expect(
      rpc('verification_advance', [...f.binding, 1, f.hash.snapshot(), f.hash.digest()])
    ).rejects.toThrow('LEASE_MISMATCH');
  });
  it('keeps checkpoint and cleanup private and permits only service RPCs', async () => {
    const privileges = await db.root<{ ok: boolean }>(
      "select not has_table_privilege('service_role','private.catalog_video_r2_verification','SELECT') and not has_table_privilege('authenticated','private.catalog_video_r2_staging_cleanup','SELECT') and not has_function_privilege('authenticated','public.service_catalog_video_r2_verification_open(uuid,text,bigint,text,jsonb,text)','EXECUTE') and has_function_privilege('service_role','public.service_catalog_video_r2_verification_open(uuid,text,bigint,text,jsonb,text)','EXECUTE') ok"
    );
    expect(privileges[0]!.ok).toBe(true);
  });
  it('explains the actual private checkpoint through the read-only CLI without hashes, media or keys', async () => {
    const f = await fixture();
    await f.open();
    await rpc('verification_advance', [...f.binding, 0, f.prefix.snapshot(), null]);
    const period = { token: 'all', start: null, end: '2099-01-01T00:00:00.000Z', label: 'all' };
    const before = await getCatalogVideoR2Diagnosis(f.copy, period);
    expect(investigatePrivacyFailure(before)).toBeNull();
    expect(before.verification).toMatchObject({
      status: 'current_observation',
      copies: [
        {
          copy_id: f.copy,
          parts_checked: 1,
          total_parts: 2,
          full_source_proof: false,
          staging_cleanup: 'not_queued'
        }
      ]
    });
    await rpc('verification_advance', [...f.binding, 1, f.hash.snapshot(), f.hash.digest()]);
    await rpc('ready', [...f.base, true, 1]);
    const ready = await getCatalogVideoR2Diagnosis(f.copy, period);
    expect(investigatePrivacyFailure(ready)).toBeNull();
    expect(ready.verification.copies).toMatchObject([
      { state: 'ready', parts_checked: 2, full_source_proof: true, staging_cleanup: 'pending' }
    ]);
    const serialized = JSON.stringify(ready);
    for (const secret of [f.hash.digest(), '"staging"', 'hash_state', 'manifest', 'object_key'])
      expect(serialized).not.toContain(secret);
    const historical = await getCatalogVideoR2Diagnosis(f.copy, { ...period, as_of: period.end });
    expect(investigatePrivacyFailure(historical)).toBeNull();
    expect(historical.verification).toMatchObject({ status: 'historical_unknown', copies: [] });
  });
});
