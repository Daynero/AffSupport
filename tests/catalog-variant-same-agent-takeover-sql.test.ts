import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11, set 4c9717d4 (API gateway paused for 150 s mid-restitch):
 * the agent stopped its own stitch after 90 s without a heartbeat and stayed
 * online. Its next redeem came from the SAME native instance, and the 2-minute
 * silence takeover ran only for a NEW one, so the variant stayed 'working' with
 * a running operation until the 15-minute sweep.
 */
let db: TeamTestDb, team: string, source: string, image: string;
const owner = 'c3450000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207345000_catalog_variant_same_agent_takeover.sql'
  });
  await createUser(db, { id: owner, email: 'variant-same-agent@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Same agent')")
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
/** A foreground creation whose only variant runs under the agent's first instance. */
async function foreground() {
  const session = crypto.randomUUID(),
    enrollment = crypto.randomUUID(),
    native = crypto.randomUUID(),
    set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    op = crypto.randomUUID(),
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
      // Legacy source mode skips the screen pool, which this rule never reads.
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    [{ index: 0, requestId: request }],
    [{ recipeRowId: crypto.randomUUID(), videoVariantIndex: 0 }]
  ]);
  const redeem = (boot?: string) =>
    db.root<{ v: Record<string, unknown> }>(
      boot
        ? 'select public.service_redeem_catalog_video_foreground($1,$2,$3,$4,$5,$6)v'
        : 'select public.service_redeem_catalog_video_foreground($1,$2,$3,$4)v',
      boot ? [set, enrollment, native, proof, boot, native] : [set, enrollment, native, proof]
    );
  await redeem();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + request]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
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
    [{ index: 0, requestId: request, operationId: op, state: 'working', outputId: null }]
  ]);
  return { set, op, native, redeem };
}
/** The operations table stamps updated_at on every write; age it past that trigger. */
const silence = async (op: string, minutes: number) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      'update public.team_operations set created_at=clock_timestamp()-make_interval(mins=>$2+1),updated_at=clock_timestamp()-make_interval(mins=>$2) where id=$1',
      [op, minutes]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};
const state = async (set: string, op: string) =>
  (
    await db.root<{ variant: string; operation: string; error: string | null; retry: number }>(
      'select v.state variant,o.state operation,o.error_code error,v.retry_count retry from private.catalog_video_variants v,public.team_operations o where v.video_set_id=$1 and v.video_variant_index=0 and o.id=$2',
      [set, op]
    )
  )[0]!;

it('the same agent instance takes over its own variant silent for two minutes', async () => {
  const f = await foreground();
  await silence(f.op, 3);
  await f.redeem(f.native);
  expect(await state(f.set, f.op)).toEqual({
    variant: 'queued',
    operation: 'failed',
    error: 'PROCESS_RESULT_UNCERTAIN',
    retry: 1
  });
});

it('leaves a variant alone while its operation still shows life', async () => {
  const f = await foreground();
  await silence(f.op, 1);
  await f.redeem(f.native);
  expect(await state(f.set, f.op)).toMatchObject({ variant: 'working', operation: 'running' });
});

it('an observation without an execution instance takes nothing over', async () => {
  const f = await foreground();
  await silence(f.op, 3);
  await f.redeem();
  expect(await state(f.set, f.op)).toMatchObject({ variant: 'working', operation: 'running' });
});
