import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, source: string, connection: string, delegation: string;
const owner = 'c1680000-0000-4000-8000-000000000001',
  executor = 'c1680000-0000-4000-8000-000000000002',
  native = 'c1680000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xaa);
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261207170000_restitch_process_aliases.sql' });
  await createUser(db, { id: owner, email: 'variant-closure@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Closure')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'closure','closure@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','Source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  delegation = (
    await db.root<{ id: string }>(
      'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,$4)returning id',
      [team, owner, executor, Buffer.alloc(32, 0xbb)]
    )
  )[0]!.id;
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)values($1,$2,1,'claim',clock_timestamp()+interval '1 hour')",
    [hash, delegation]
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});
it('continues real native dispatch, durable grants and original finalization after the blank catalog is registered', async () => {
  const set = crypto.randomUUID(),
    children = Array.from({ length: 2 }, () => ({
      requestId: crypto.randomUUID(),
      operationId: null as string | null,
      state: 'queued',
      outputId: null as string | null
    }));
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, 'created:' + set, {}, executor]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: 2,
      productCount: 2,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    children.map((v, index) => ({ index, requestId: v.requestId })),
    children.map((_, index) => ({ recipeRowId: crypto.randomUUID(), videoVariantIndex: index }))
  ]);
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,companion_of,companion_kind)values($1,$2,$3,'Created blank catalog','file','other','application/vnd.google-apps.spreadsheet',$4,'product_catalog')returning id",
      [team, connection, 'blank-' + set, source]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by)values($1,$2,$3,'https://example.invalid/',2,'https://docs.google.com/spreadsheets/d/created/edit','https://drive.google.com/file/d/source/view','{}',$4)",
    [catalog, team, source, owner]
  );
  await db.root(
    "update private.catalog_generation_intents set state='registered',checkpoint=checkpoint||jsonb_build_object('materialId',$2::text,'initialVideoPlan',jsonb_build_object('setId',$3::text)),result=jsonb_build_object('catalog',jsonb_build_object('materialId',$2::text))where id=$1",
    [intent, catalog, set]
  );
  const authority = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_authorize_catalog_video_executor($1,$2,$3,1)v',
      [set, hash, native]
    )
  )[0]!.v;
  expect(authority).toMatchObject({ teamId: team, actorId: owner });
  for (const [index, child] of children.entries()) {
    const op = crypto.randomUUID();
    child.operationId = op;
    child.state = 'working';
    await db.root(
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
      [op, team, owner, source, 'catalog-variant:' + child.requestId]
    );
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
      [op, team]
    );
    const checkpoint = async () => {
      const revision = (
        await db.root<{ revision: number }>(
          'select revision from private.catalog_video_sets where id=$1',
          [set]
        )
      )[0]!.revision;
      expect(
        (
          await db.root<{ v: boolean }>(
            'select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)v',
            [set, team, owner, executor, revision, children.map((v, index) => ({ index, ...v }))]
          )
        )[0]!.v
      ).toBe(true);
    };
    await checkpoint();
    expect(
      (
        await db.root<{ v: Record<string, unknown> }>(
          'select public.service_dispatch_catalog_video_variant($1,$2,$3,1,$4,$5,$6)v',
          [set, hash, native, index, child.requestId, op]
        )
      )[0]!.v
    ).toMatchObject({ executionAllowed: true });
    const args = [set, hash, native, 1, index, child.requestId, op];
    expect(
      (
        await db.root<{ v: Record<string, unknown> }>(
          'select public.service_reserve_catalog_video_grants($1,$2,$3,$4,$5,$6,$7)v',
          args
        )
      )[0]!.v
    ).toMatchObject({ acquisition: 1 });
    expect(
      (
        await db.root<{ v: boolean }>(
          'select public.service_issue_catalog_video_grants($1,$2,$3,$4,$5,$6,$7,1,$8,$9,9)v',
          [...args, Buffer.alloc(32, 0xc0 + index), Buffer.alloc(32, 0xd0 + index)]
        )
      )[0]!.v
    ).toBe(true);
    const file = 'continued-' + op;
    await db.root("select public.service_prepare_process_upload($1,$2,$3,$4,repeat('a',32))", [
      op,
      owner,
      connection,
      file
    ]);
    await db.root('select public.service_start_process_upload($1,$2)', [op, owner]);
    const finalized = (
      await db.root<{ v: Record<string, unknown> }>(
        'select public.service_finalize_uploaded_material($1,$2,$3)v',
        [
          op,
          owner,
          {
            driveFileId: file,
            parentFolderId: 'root',
            name: 'copy.mp4',
            mimeType: 'video/mp4',
            fileExtension: 'mp4',
            kind: 'file',
            category: 'video',
            classificationSource: 'mime',
            sizeBytes: 4,
            driveVersion: '2',
            checksum: 'a'.repeat(32)
          }
        ]
      )
    )[0]!.v;
    expect(finalized).toBeTruthy();
    const reconciled = (
      await db.root<{ v: { kind: string; outputId: string } }>(
        'select public.service_reconcile_catalog_video_variant($1,$2,$3,$4,1,$5,$6)v',
        [set, team, owner, executor, index, child.requestId]
      )
    )[0]!.v;
    expect(reconciled.kind).toBe('registered');
    child.outputId = reconciled.outputId;
    child.state = 'registered';
    await checkpoint();
  }
  expect(
    (
      await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
        set
      ])
    )[0]!.state
  ).toBe('ready');
  expect(
    (
      await db.root<{ n: number }>(
        "select count(distinct output_material_id)::integer n from private.catalog_video_variants where video_set_id=$1 and state='registered'",
        [set]
      )
    )[0]!.n
  ).toBe(2);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_intents where id=$1',
        [intent]
      )
    )[0]!.state
  ).toBe('registered');
});
