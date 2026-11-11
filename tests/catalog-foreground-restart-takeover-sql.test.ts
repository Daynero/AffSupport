import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11 (QA round 9): a killed agent that restarted was refused its own
 * set for about two more minutes. A new execution instance of the same enrolled
 * agent is that agent's restart, so its predecessor's silent variants are released
 * after 75 seconds instead of two minutes (20261207399900).
 */
let db: TeamTestDb, team: string, source: string, image: string;
const owner = 'c3999000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'foreground-restart@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Restart')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'live','live@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','root','Source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  image = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'image','root','Image','file','image','image/png',4,repeat('b',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)values($1,'end',$2,'file',1,$3)",
    [team, image, owner]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

const random32 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
/** A foreground creation whose only variant works under the agent's first instance. */
async function foreground() {
  const session = crypto.randomUUID(),
    enrollment = crypto.randomUUID(),
    native = crypto.randomUUID(),
    set = crypto.randomUUID(),
    requests = [crypto.randomUUID()],
    ops = [crypto.randomUUID()],
    key = `fg:${crypto.randomUUID()}`,
    proof = random32(),
    token = random32();
  await db.root('insert into auth.sessions(id,user_id)values($1,$2)', [session, owner]);
  await db.root(
    "select public.service_prepare_catalog_video_foreground($1,$2,$3,$4,'create',$5,null,$6,$7,$8,$9)",
    [team, owner, session, source, key, enrollment, native, proof, token]
  );
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [
        team,
        source,
        owner,
        key,
        {
          catalogVideoProtocolVersion: 1,
          foregroundExecutor: {
            protocolVersion: 1,
            enrollmentId: enrollment,
            nativeInstanceId: native,
            proofDigest: proof.toString('hex')
          }
        },
        enrollment
      ]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_foreground_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    enrollment,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    requests.map((requestId, index) => ({ index, requestId })),
    requests.map((_, index) => ({ recipeRowId: crypto.randomUUID(), videoVariantIndex: index }))
  ]);
  await db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)', [
    set,
    enrollment,
    native,
    proof
  ]);
  for (const [index, op] of ops.entries()) {
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
      [op, team, owner, source, 'catalog-variant:' + requests[index]]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
      [op, team]
    );
  }
  const revision = (
    await db.root<{ revision: string }>(
      'select revision from private.catalog_video_sets where id=$1',
      [set]
    )
  )[0]!.revision;
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    set,
    team,
    owner,
    enrollment,
    Number(revision),
    requests.map((requestId, index) => ({
      index,
      requestId,
      operationId: ops[index],
      state: 'working',
      outputId: null
    }))
  ]);
  // A restarted agent: a new execution instance of the same installation.
  const boot = crypto.randomUUID();
  return {
    set,
    ops,
    redeem: () =>
      db.root('select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5,$6)', [
        set,
        enrollment,
        native,
        proof,
        boot,
        native
      ]),
    release: async (execution: string | null = null) =>
      (
        await db.root<{ n: number }>(
          'select public.service_release_silent_catalog_video_foreground($1,$2,$3,$4,$5)n',
          [set, enrollment, native, proof, execution]
        )
      )[0]!.n,
    legacyRelease: async () =>
      (
        await db.root<{ n: number }>(
          'select public.service_release_silent_catalog_video_foreground(p_set=>$1,p_enrollment=>$2,p_native=>$3,p_proof_hash=>$4)n',
          [set, enrollment, native, proof]
        )
      )[0]!.n,
    boot,
    native
  };
}
/** The operations table stamps updated_at on every write; age it past that trigger. */
const silence = async (op: string, seconds: number) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      'update public.team_operations set created_at=clock_timestamp()-make_interval(secs=>$2+60),updated_at=clock_timestamp()-make_interval(secs=>$2) where id=$1',
      [op, seconds]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};
const operation = async (op: string) =>
  (
    await db.root<{ state: string }>('select state from public.team_operations where id=$1', [op])
  )[0]!.state;
const variants = async (set: string) =>
  (
    await db.root<{ state: string }>(
      'select state from private.catalog_video_variants where video_set_id=$1 order by video_variant_index',
      [set]
    )
  ).map(row => row.state);

it('a restart of the same agent takes its silent variant over after 75 seconds', async () => {
  const f = await foreground();
  await silence(f.ops[0]!, 80);
  expect(await f.release(f.boot)).toBe(1);
  expect(await operation(f.ops[0]!)).toBe('failed');
  expect(await variants(f.set)).toEqual(['queued']);
});

it('the same instance, and the edge function from before, keep the two-minute rule', async () => {
  const f = await foreground();
  await silence(f.ops[0]!, 80);
  // The instance the authority already runs on is not a restart.
  expect(await f.release(f.native)).toBe(0);
  // The four-argument call of the edge function deployed before this migration.
  expect(await f.legacyRelease()).toBe(0);
  expect(await variants(f.set)).toEqual(['working']);
  await silence(f.ops[0]!, 130);
  expect(await f.legacyRelease()).toBe(1);
  expect(await variants(f.set)).toEqual(['queued']);
});

it('a restart never takes over a variant that still shows life', async () => {
  const f = await foreground();
  await silence(f.ops[0]!, 40);
  expect(await f.release(f.boot)).toBe(0);
  expect(await operation(f.ops[0]!)).toBe('running');
  expect(await variants(f.set)).toEqual(['working']);
});
