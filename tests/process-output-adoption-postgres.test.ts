import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';

// Only the acceptance runner's disposable clone, never a beta/source database.
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  team = randomUUID(),
  credential = randomUUID(),
  connection = randomUUID(),
  source = randomUUID();
async function sql(statement: string): Promise<string> {
  assertDisposablePostgresContainer(container);
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      '-d',
      'postgres'
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024 }
  );
  const result = new Promise<string>((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout!.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr!.on('data', chunk => {
      error = (error + String(chunk)).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error(error))));
  });
  child.stdin!.end(statement);
  return result;
}
async function held(marker: string, event = 'PgSleep') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
    and pid<>pg_backend_pid() and query like '%${marker}%' and ${event === 'Lock' ? "wait_event_type='Lock'" : "wait_event='PgSleep'"}`)) ===
      '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `isolated transaction ${marker} ${event}` }
  );
}
async function operation(file = `reserved-${randomUUID()}`) {
  const id = randomUUID(),
    worker = randomUUID();
  await sql(`insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
    values('${id}','${team}','${owner}','process','running','${source}','${id}','${id}');
    insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version)
    values('${id}','${team}','output.mp4','video/mp4',16,'compressor',1);
    insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
    values(decode(md5('${id}')||md5('${id}:grant'),'hex'),'${id}','${team}','${owner}','finalize','compressor',2097152,now()+interval '1 hour',4);`);
  const prepare = `select public.service_prepare_process_upload('${id}','${owner}','${connection}','${file}',repeat('a',32))`;
  return { id, file, worker, prepare };
}
async function canceled() {
  const f = await operation();
  await sql(`${f.prepare};select public.service_start_process_upload('${f.id}','${owner}');
    select set_config('request.jwt.claim.sub','${owner}',false);select public.cancel_team_operation('${team}','${f.id}');`);
  const plans = JSON.parse(
    await sql(`select public.service_claim_process_output_cleanup('${f.worker}',3)`)
  ) as { operationId: string; fence: string }[];
  const plan = plans.find(p => p.operationId === f.id)!;
  expect(plan).toBeDefined();
  return {
    ...f,
    begin: `select public.service_begin_process_output_trash('${f.id}','${f.worker}','${plan.fence}')`
  };
}
const adoption = (
  file: string
) => `insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type)
  values('${team}','${connection}','${file}','adopted.mp4','file','video/mp4')`;

async function catalogVariantOperation() {
  const set = randomUUID(),
    request = randomUUID(),
    id = randomUUID(),
    video = randomUUID(),
    installation = randomUUID(),
    native = randomUUID(),
    delegation = randomUUID();
  const hash = `decode(md5('${request}')||md5('${request}:claim'),'hex')`;
  await sql(`insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
    values('${video}','${team}','${connection}','${video}','Variant source','file','video','video/mp4',16,repeat('a',32),'1');
    insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash)values('${delegation}','${team}','${owner}','${installation}',decode(md5('${request}:refresh')||md5('${request}:refresh2'),'hex'));
    insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)values(${hash},'${delegation}',1,'claim',clock_timestamp()+interval '1 hour');`);
  const intent = JSON.parse(
    await sql(
      `select public.service_begin_catalog_intent('${team}','${video}','${owner}','variant-concurrency:${set}','{}','${installation}')`
    )
  ) as { id: string };
  const payload = {
    setId: set,
    catalogIntentId: intent.id,
    sourceMaterialId: video,
    sourceVersion: '1',
    settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
    settingsDigest: 'a'.repeat(64),
    requestedCount: 1,
    productCount: 1,
    recipeRevision: 1,
    seed: 'b'.repeat(64)
  };
  await sql(`do $fixture$begin
    perform public.service_accept_catalog_video_set('${team}','${owner}','${installation}','${JSON.stringify(payload)}','${JSON.stringify([{ index: 0, requestId: request }])}','${JSON.stringify([{ recipeRowId: randomUUID(), videoVariantIndex: 0 }])}');
    insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
      values('${id}','${team}','${owner}','process','running','${video}','catalog-variant:${request}','catalog-variant:${request}');
    insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version,expected_source_version,expected_source_drive_file_id,expected_source_checksum)
      values('${id}','${team}','output.mp4','video/mp4',16,'restitch',1,'1','${video}',repeat('a',32));
    perform public.service_checkpoint_catalog_video_set('${set}','${team}','${owner}','${installation}',1,0,'${JSON.stringify([{ index: 0, requestId: request, operationId: id, state: 'working', outputId: null }])}');
    perform public.service_dispatch_catalog_video_variant('${set}',${hash},'${native}',1,0,'${request}','${id}');
    insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)
      values(decode(md5('${id}:output')||md5('${id}:output2'),'hex'),'${id}','${team}','${owner}','finalize','restitch',2097152,clock_timestamp()+interval '1 hour',4);
  end;$fixture$;`);
  const file = `variant-result-${randomUUID()}`;
  const metadata = {
    driveFileId: file,
    parentFolderId: 'own-root',
    name: 'output.mp4',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    kind: 'file',
    category: 'video',
    classificationSource: 'mime',
    sizeBytes: 16,
    driveVersion: '2',
    checksum: 'a'.repeat(32)
  };
  return {
    id,
    set,
    request,
    file,
    prepare: `select public.service_prepare_process_upload('${id}','${owner}','${connection}','${file}',repeat('a',32))`,
    complete: `select public.service_complete_catalog_video_variant('${set}',${hash},'${native}',1,0,'${request}','${id}','canceled','PROCESS_CANCELED')`,
    finalize: `select public.service_finalize_uploaded_material('${id}','${owner}','${JSON.stringify(metadata)}')`,
    cancel: `update private.catalog_video_sets set state='cancel_requested'where id='${set}'`
  };
}

describe.skipIf(!container)(
  '036 process ownership [needs: disposable process PostgreSQL container]',
  () => {
    beforeAll(async () => {
      await sql(`begin;insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
      values('${owner}','authenticated','authenticated','${owner}@output-race.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      insert into public.teams(id,name,owner_id) values('${team}','Synthetic output concurrency','${owner}');
      insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
      insert into private.google_drive_credentials(id,connected_by,google_permission_id,google_account_email,vault_secret_id,scope)
      values('${credential}','${owner}','${owner}','${owner}@output-race.test.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file');
      insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
      values('${connection}','${team}','${credential}','own-root','Synthetic','my_drive','connected',now());
      insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,mime_type)
      values('${source}','${team}','${connection}','source-${source}','original.mp4','file','video/mp4');commit;`);
    });

    it('serializes native N cancel before output start and refuses the waiting provider allocation', async () => {
      const f = await catalogVariantOperation();
      await sql(f.cancel);
      const first = sql(`begin;${f.complete};select pg_sleep(2) /* variant_cancel_hold */;commit;`);
      await held('variant_cancel_hold');
      const second = sql(`${f.prepare} /* variant_output_wait */;`).then(
        () => 'STARTED',
        error => String(error)
      );
      await held('variant_output_wait', 'Lock');
      await first;
      expect(await second).toContain('WRONG_STATE');
      expect(await sql(`select state from public.team_operations where id='${f.id}'`)).toBe(
        'canceled'
      );
      expect(
        await sql(
          `select count(*)from private.process_upload_ownership where operation_id='${f.id}'`
        )
      ).toBe('0');
    }, 15000);
    it('retains an earlier started upload as unknown when native N cancellation waits for its original lock', async () => {
      const f = await catalogVariantOperation();
      const first = sql(
        `begin;${f.prepare};select public.service_start_process_upload('${f.id}','${owner}');select pg_sleep(2) /* variant_output_hold */;commit;`
      );
      await held('variant_output_hold');
      await sql(f.cancel);
      const second = sql(`${f.complete} /* variant_cancel_wait */;`);
      await held('variant_cancel_wait', 'Lock');
      await first;
      expect(JSON.parse(await second)).toMatchObject({ kind: 'unknown', operationId: f.id });
      expect(await sql(`select state from public.team_operations where id='${f.id}'`)).toBe(
        'running'
      );
      expect(
        await sql(
          `select count(*)from private.process_upload_ownership where operation_id='${f.id}'and file_id='${f.file}'and upload_state='started'`
        )
      ).toBe('1');
    }, 15000);
    it('retains original finalized registration when native N cancellation waits behind real finalization', async () => {
      const f = await catalogVariantOperation();
      const first = sql(
        `begin;${f.finalize};select pg_sleep(2) /* variant_finalize_hold */;commit;`
      );
      await held('variant_finalize_hold');
      await sql(f.cancel);
      const second = sql(`${f.complete} /* variant_finalize_cancel_wait */;`);
      await held('variant_finalize_cancel_wait', 'Lock');
      await first;
      expect(JSON.parse(await second)).toMatchObject({ kind: 'registered', operationId: f.id });
      expect(await sql(`select state from public.team_operations where id='${f.id}'`)).toBe(
        'succeeded'
      );
      expect(
        await sql(`select count(*)from public.team_materials where drive_file_id='${f.file}'`)
      ).toBe('1');
    }, 15000);

    it('blocks concurrent adoption until begin-trash commits, then refuses the adoption', async () => {
      const f = await canceled();
      const first = sql(`begin;${f.begin};select pg_sleep(2) /* process_begin_hold */;commit;`);
      await held('process_begin_hold');
      const second = sql(`${adoption(f.file)} /* process_adopt_wait */;`).then(
        () => 'ADOPTED',
        e => String(e)
      );
      await held('process_adopt_wait', 'Lock');
      await first;
      expect(await second).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(`select count(*) from public.team_materials where drive_file_id='${f.file}'`)
      ).toBe('0');
    }, 15000);

    it('lets an earlier adoption commit and refuses the waiting cleanup reservation', async () => {
      const f = await canceled();
      const first = sql(
        `begin;${adoption(f.file)};select pg_sleep(2) /* process_adoption_hold */;commit;`
      );
      await held('process_adoption_hold');
      const second = sql(`${f.begin} /* process_begin_wait */;`);
      await held('process_begin_wait', 'Lock');
      await first;
      expect(await second).toBe('f');
      expect(
        await sql(`select count(*) from public.team_materials where drive_file_id='${f.file}'`)
      ).toBe('1');
    }, 15000);

    it('serializes first ownership capture with a material insert for the same provider ID', async () => {
      const f = await operation();
      const first = sql(
        `begin;${adoption(f.file)};select pg_sleep(2) /* process_prepare_adoption_hold */;commit;`
      );
      await held('process_prepare_adoption_hold');
      const second = sql(`${f.prepare} /* process_prepare_wait */;`).then(
        () => 'PREPARED',
        e => String(e)
      );
      await held('process_prepare_wait', 'Lock');
      await first;
      expect(await second).toContain('SOURCE_CHANGED');
      expect(
        await sql(
          `select count(*) from private.process_upload_ownership where operation_id='${f.id}'`
        )
      ).toBe('0');
    }, 15000);
    // The same disposable schema/fixture is shared with the three adoption races.
    it('skips incremental ingestion when first capture commits after the prefilter snapshot', async () => {
      const f = await operation();
      const first = sql(
        `begin;${f.prepare};select pg_sleep(2) /* process_capture_ingest_hold */;commit;`
      );
      await held('process_capture_ingest_hold');
      const row = JSON.stringify([
        {
          drive_file_id: f.file,
          parent_folder_id: 'own-root',
          name: 'output.mp4',
          kind: 'file',
          mime_type: 'video/mp4',
          category: 'video',
          size_bytes: 16,
          checksum: 'a'.repeat(32)
        }
      ]);
      const second =
        sql(`select public.service_upsert_catalog_page('${connection}','own-root','${row}'::jsonb) /* process_ingest_wait */;
    select coalesce(current_setting('soty.process_output_catalog_ingest',true),'')='';`);
      await held('process_ingest_wait', 'Lock');
      await first;
      expect((await second).split('\n')).toEqual(['0', 't']);
      expect(
        await sql(`select count(*) from public.team_materials where drive_file_id='${f.file}'`)
      ).toBe('0');
    }, 15000);
  }
);
