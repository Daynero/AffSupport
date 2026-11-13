import {
  createScreenSelectionBudget,
  selectScreenCandidate,
  reserveScreenTransfer,
  settleScreenTransfer,
  reacquireScreenCandidate
} from '@video-compressor/shared';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';

// Only the acceptance runner's disposable clone, never a beta/source database.
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  team = randomUUID();
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
function holdSql(statement: string): { commit: () => Promise<string> } {
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
  void result.catch(() => undefined);
  child.stdin!.write(`begin;${statement};\n`);
  return {
    commit: () => {
      child.stdin!.end('commit;\n');
      return result;
    }
  };
}
async function held(marker: string, event = 'PgSleep') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
    and pid<>pg_backend_pid() and query like '%${marker}%' and ${event === 'Lock' ? "wait_event_type='Lock'" : event === 'Idle' ? "state='idle in transaction'" : "wait_event='PgSleep'"}`)) ===
      '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `isolated transaction ${marker} ${event}` }
  );
}

const connection = randomUUID();
async function fixture() {
  const video = randomUUID(),
    sheet = randomUUID();
  const metadata = JSON.stringify({
    sourceLink: 'https://offer.example.invalid/',
    productCount: 3,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    videoLink: 'https://drive.google.com/file/d/synthetic/view',
    createdBy: owner,
    settingsSnapshot: {
      title: 'Fixture',
      description: 'Fixture',
      price: 1,
      imageLink: 'https://images.example.invalid/a.png'
    }
  });
  await sql(`begin;
    insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
      ('${video}','${team}','${connection}','${video}','root','Video','file','video','video/mp4'),
      ('${sheet}','${team}','${connection}','${sheet}','root','Catalog','file','other','application/vnd.google-apps.spreadsheet');
    select public.service_link_product_catalog_companion('${team}','${video}','${sheet}',null,'${metadata}'::jsonb);commit;`);
  return sheet;
}
const request = (command: string, sheet: string) =>
  `select public.request_team_catalog_update_command('${team}','${command}',array['${sheet}']::uuid[],'${owner}')`;
const cancel = (command: string, sheet: string) =>
  `select public.cancel_team_catalog_command_intent('${team}','${command}',array['${sheet}']::uuid[],'${owner}')`;
const asActor = (statement: string) =>
  `begin;select set_config('request.jwt.claim.sub','${owner}',true);set local role authenticated;${statement};commit;`;
const receipt = (text: string) => JSON.parse(text.split('\n').find(line => line.startsWith('{'))!);
const count = (sheet: string) =>
  sql(
    `select count(*) from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
  );
async function materialExecutionFixture(create = true, withChild = false) {
  const material = randomUUID(),
    child = randomUUID(),
    operation = randomUUID(),
    intent = randomUUID();
  await sql(`begin;
    insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values
    ('${material}','${team}','${connection}','${material}','root','Synthetic execution','file','video/mp4'),
    ('${child}','${team}','${connection}','${child}','root','Synthetic member','file','text/plain');
    insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
    values('${operation}','${team}','${owner}','trash','running','${material}','${operation}','group-v1:${'a'.repeat(64)}');commit;`);
  const members = JSON.stringify([
    {
      material_id: material,
      drive_file_id: material,
      parent_folder_id: 'root',
      resource_key: null,
      role: 'source'
    },
    ...(withChild
      ? [
          {
            material_id: child,
            drive_file_id: child,
            parent_folder_id: 'root',
            resource_key: null,
            role: 'transcript'
          }
        ]
      : [])
  ]);
  const statement = `insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
    values('${intent}','${team}','${material}','${operation}','trash','${members}'::jsonb,'running')`;
  if (create) await sql(statement);
  return { material, child, operation, intent, statement };
}

async function selectionStorageFixture() {
  const video = randomUUID(),
    image = randomUUID(),
    root = randomUUID(),
    version = randomUUID(),
    requestId = randomUUID();
  const recipe = JSON.stringify({
    schemaVersion: 1,
    seed: randomUUID(),
    defaults: {
      sourceMode: 'drive',
      operation: 'restitch',
      configured: true,
      startEnabled: false,
      endEnabled: true
    }
  });
  await sql(
    "begin;insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values('" +
      video +
      "','" +
      team +
      "','" +
      connection +
      "','" +
      video +
      "','root','Synthetic selection source','file','video','video/mp4',4,repeat('c',32),'1'),('" +
      image +
      "','" +
      team +
      "','" +
      connection +
      "','" +
      image +
      "','root','Synthetic selection image','file','image','image/png',4,repeat('a',32),'1');" +
      "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values('" +
      root +
      "','" +
      team +
      "','" +
      owner +
      "','download','running','" +
      video +
      "','" +
      root +
      "','selection:" +
      root +
      "');" +
      "insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe) values('" +
      root +
      "','" +
      team +
      "','" +
      owner +
      "','" +
      video +
      "','1','" +
      owner +
      "','" +
      randomUUID() +
      "','" +
      recipe +
      "'::jsonb);" +
      "insert into private.restitch_selection_candidates(root_operation_id,slot,version_id,material_id,ordinal,size_bytes,mime_type,checksum,drive_version) values('" +
      root +
      "','end','" +
      version +
      "','" +
      image +
      "',1,4,'image/png',repeat('a',32),'1');" +
      "update private.restitch_selection_slots set snapshot_complete=true where root_operation_id='" +
      root +
      "';commit;"
  );
  const empty = createScreenSelectionBudget(),
    selected = selectScreenCandidate(empty, version, 4);
  const reserved = reserveScreenTransfer(selected, version, requestId, 0).state;
  const f = { root, video, image, version, requestId, empty, selected, reserved };
  expect(await sql(selectionStorageCas(f, empty, selected))).toBe('t');
  return f;
}
function selectionStorageCas(f: { root: string }, before: unknown, after: unknown) {
  return (
    "select public.service_cas_restitch_selection_slot('" +
    f.root +
    "','" +
    team +
    "','" +
    owner +
    "','end','" +
    JSON.stringify(before) +
    "'::jsonb,'" +
    JSON.stringify(after) +
    "'::jsonb)"
  );
}
function selectionStorageSettle(
  f: { root: string; requestId: string; reserved: { transfers: unknown[] } },
  bytes: number
) {
  return (
    "select public.service_settle_restitch_selection_range('" +
    f.root +
    "','" +
    team +
    "','" +
    owner +
    "','end','" +
    f.requestId +
    "','" +
    JSON.stringify(f.reserved.transfers[0]) +
    "'::jsonb,'" +
    JSON.stringify({ bytes, ioMs: 5, complete: false }) +
    "'::jsonb)"
  );
}

async function manualSelectionFixture() {
  const f = await selectionStorageFixture(),
    key = 'manual:' + randomUUID(),
    client = randomUUID();
  await sql(`update public.team_materials set name='Synthetic screen.png' where id='${f.image}'`);
  await sql(
    asActor(
      `select public.set_restitch_defaults('${team}','{"operation":"restitch","sourceMode":"drive","fitMode":"cover","startEnabled":false,"endEnabled":true,"finalDurationMode":"custom","customFinalDurationSeconds":60}'::jsonb);`
    )
  );
  await sql(
    `insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by) values('${team}','end','${f.image}','file',1,'${owner}') on conflict do nothing;`
  );
  const accept = `select public.service_accept_manual_restitch_download('${team}','${owner}','${f.video}','${key}','${client}')`;
  return { ...f, accept };
}
function claimSelection(root: string, claim: string, native: string) {
  return `select public.service_claim_restitch_executor('${root}','${team}','${owner}','${claim}','${native}',1)`;
}
function ownedSelectionCas(
  root: string,
  executor: string,
  epoch: number,
  before: unknown,
  after: unknown
) {
  return `select public.service_cas_restitch_selection_slot_owned('${root}','${team}','${owner}','end','${JSON.stringify(before)}'::jsonb,'${JSON.stringify(after)}'::jsonb,'${executor}',${epoch})`;
}

async function screenRangeAuthorityFixture() {
  const f = await manualSelectionFixture();
  const root = JSON.parse(await sql(f.accept)).operationId as string;
  const executor = JSON.parse(await sql(claimSelection(root, randomUUID(), randomUUID()))) as {
    executorId: string;
    epoch: number;
  };
  const version = await sql(
    `select version_id from private.restitch_selection_candidates where root_operation_id='${root}' and slot='end' order by ordinal limit 1`
  );
  const empty = createScreenSelectionBudget(),
    selected = selectScreenCandidate(empty, version, 4);
  expect(
    await sql(ownedSelectionCas(root, executor.executorId, executor.epoch, empty, selected))
  ).toBe('t');
  const request = randomUUID(),
    grant = randomUUID(),
    hash = grant.replaceAll('-', '').padEnd(64, '0');
  const next = reserveScreenTransfer(selected, version, request, 0);
  const issue = `select public.service_issue_restitch_screen_range('${root}','${team}','${owner}','end','${version}',0,'${request}','${JSON.stringify(selected)}'::jsonb,'${JSON.stringify(next.state)}'::jsonb,'${grant}',decode('${hash}','hex'),'${executor.executorId}',${executor.epoch})`;
  const consume = (dispatch = randomUUID()) =>
    `select public.service_consume_restitch_screen_range(decode('${hash}','hex'),'${dispatch}','restitch_screen_range_v1')`;
  const abandon = `select public.service_abandon_restitch_screen_range('${root}','${team}','${owner}','end','${request}','${grant}','${executor.executorId}',${executor.epoch})`;
  return { root, grant, issue, consume, abandon };
}

async function nativeControlAuthorityFixture() {
  const f = await manualSelectionFixture();
  const root = JSON.parse(await sql(f.accept)).operationId as string;
  // Two grants from the same boot must still have distinct immutable ownership.
  const session = randomUUID(),
    native = randomUUID();
  await sql(`insert into auth.sessions(id,user_id) values('${session}','${owner}')`);
  const enroll = async () => {
    const grant = randomUUID(),
      enrollment = randomUUID();
    const proof = randomUUID().replaceAll('-', '').padEnd(64, 'a');
    const ticket = randomUUID().replaceAll('-', '').padEnd(64, 'b');
    await sql(`select public.service_issue_restitch_native_control('${root}','${team}','${owner}',
      '${session}','${grant}','${enrollment}','${native}',decode('${proof}','hex'),decode('${ticket}','hex'))`);
    await sql(
      `select public.service_redeem_restitch_native_control('${grant}',decode('${proof}','hex'))`
    );
    return {
      grant,
      claim: (claim: string) =>
        `select public.service_claim_restitch_native_control('${grant}',decode('${ticket}','hex'),'${claim}',1)`,
      authorize: `select public.service_authorize_restitch_native_control('${grant}',decode('${ticket}','hex'))`,
      read: (claim: string) =>
        `select public.service_read_restitch_native_control_claim('${grant}',decode('${ticket}','hex'),'${claim}')`,
      close: (claim: string, nonce: string) =>
        `select public.service_quiesce_restitch_native_control('${grant}',decode('${ticket}','hex'),'${claim}','${nonce}')`
    };
  };
  return { root, session, enroll };
}

async function controlledNativeRangeFixture() {
  const f = await nativeControlAuthorityFixture(),
    control = await f.enroll(),
    claim = randomUUID();
  const owned = JSON.parse(await sql(control.claim(claim))) as {
    executorId: string;
    epoch: number;
  };
  const controlHash = await sql(
    `select encode(token_hash,'hex') from private.restitch_native_controls where id='${control.grant}'`
  );
  const version = await sql(
    `select version_id from private.restitch_selection_candidates where root_operation_id='${f.root}' and slot='end' order by ordinal limit 1`
  );
  const empty = createScreenSelectionBudget(),
    selected = selectScreenCandidate(empty, version, 4);
  expect(await sql(ownedSelectionCas(f.root, owned.executorId, owned.epoch, empty, selected))).toBe(
    't'
  );
  const request = randomUUID(),
    range = randomUUID(),
    rangeHash = randomUUID().replaceAll('-', '').padEnd(64, 'c');
  const next = reserveScreenTransfer(selected, version, request, 0);
  await sql(
    `select public.service_issue_restitch_control_screen_range('${control.grant}',decode('${controlHash}','hex'),'end','${version}',0,'${request}','${JSON.stringify(selected)}'::jsonb,'${JSON.stringify(next.state)}'::jsonb,'${range}',decode('${rangeHash}','hex'))`
  );
  return {
    ...f,
    range,
    consume: (dispatch: string) =>
      `select public.service_consume_restitch_control_screen_range(decode('${rangeHash}','hex'),'${dispatch}','restitch_screen_range_v1')`,
    check: (dispatch: string) =>
      `select public.service_check_restitch_control_screen_range(decode('${rangeHash}','hex'),'${dispatch}')`,
    read: (dispatch: string) =>
      `select public.service_read_restitch_control_screen_range_consumption(decode('${rangeHash}','hex'),'${dispatch}')`,
    abandon: `select public.service_abandon_restitch_control_screen_range('${control.grant}',decode('${controlHash}','hex'),'end','${request}','${range}')`
  };
}

/** Real PG fixtures: all data is synthetic and exists only in the isolated clone. */
async function foregroundCatalogFixture() {
  const source = randomUUID(),
    image = randomUUID(),
    enrollment = randomUUID(),
    native = randomUUID(),
    session = randomUUID(),
    set = randomUUID(),
    key = `fg:${randomUUID()}`;
  const proof = randomUUID().replaceAll('-', '').padEnd(64, 'a'),
    token = randomUUID().replaceAll('-', '').padEnd(64, 'b');
  const children = Array.from({ length: 2 }, (_, index) => ({ index, requestId: randomUUID() }));
  const settings = {
    configured: true,
    operation: 'restitch',
    sourceMode: 'drive',
    fitMode: 'cover',
    startDurationMode: 'one-frame',
    customStartDurationMs: 1,
    startEnabled: false,
    endEnabled: true,
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 3
  };
  await sql(`begin;
    insert into auth.sessions(id,user_id) values('${session}','${owner}');
    insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) values
    ('${source}','${team}','${connection}','${source}','root','Foreground source','file','video','video/mp4',4,repeat('a',32),'1'),
    ('${image}','${team}','${connection}','${image}','root','Foreground image','file','image','image/png',4,repeat('b',32),'1');
    insert into public.team_restitch_sources(team_id,slot,material_id,kind,sort_order,added_by)values('${team}','end','${image}','file',1,'${owner}');
    select public.service_prepare_catalog_video_foreground('${team}','${owner}','${session}','${source}','create','${key}',null,'${enrollment}','${native}',decode('${proof}','hex'),decode('${token}','hex'));
    commit;`);
  const payload = {
    catalogVideoProtocolVersion: 1,
    foregroundExecutor: {
      protocolVersion: 1,
      enrollmentId: enrollment,
      nativeInstanceId: native,
      proofDigest: proof
    }
  };
  const intent = (
    JSON.parse(
      await sql(
        `select public.service_begin_catalog_intent('${team}','${source}','${owner}','${key}','${JSON.stringify(payload)}'::jsonb,'${enrollment}')`
      )
    ) as { id: string }
  ).id;
  const accepted = {
    setId: set,
    catalogIntentId: intent,
    sourceMaterialId: source,
    sourceVersion: '1',
    settings,
    settingsDigest: 'a'.repeat(64),
    requestedCount: 2,
    productCount: 2,
    recipeRevision: 1,
    seed: 'b'.repeat(64)
  };
  await sql(
    `select public.service_accept_foreground_catalog_video_set('${team}','${owner}','${enrollment}','${JSON.stringify(accepted)}'::jsonb,'${JSON.stringify(children)}'::jsonb,'${JSON.stringify(children.map(c => ({ recipeRowId: randomUUID(), videoVariantIndex: c.index })))}'::jsonb)`
  );
  const redeem = (boot?: string, expectedBoot?: string) =>
    `select public.service_redeem_catalog_video_foreground('${set}','${enrollment}','${native}',decode('${proof}','hex')${boot ? `,'${boot}'${expectedBoot ? `,'${expectedBoot}'` : ''}` : ''})`;
  await sql(redeem());
  return {
    source,
    session,
    enrollment,
    native,
    set,
    intent,
    key,
    children,
    proof,
    token,
    redeem,
    authorize: `select public.service_authorize_catalog_video_executor('${set}',decode('${token}','hex'),'${native}',1)`
  };
}
async function foregroundWorkingChildren(f: Awaited<ReturnType<typeof foregroundCatalogFixture>>) {
  const operations = f.children.map(() => randomUUID());
  await sql(
    `begin;${operations
      .map(
        (operation, index) => `
    insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
    values('${operation}','${team}','${owner}','process','running','${f.source}','catalog-variant:${f.children[index]!.requestId}','catalog-variant:${f.children[index]!.requestId}');
    insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)
    values('${operation}','${team}','restitch','1','${f.source}',repeat('a',32),'copy.mp4',4,'video/mp4');`
      )
      .join('')}commit;`
  );
  const revision = await sql(`select revision from private.catalog_video_sets where id='${f.set}'`);
  await sql(
    `select public.service_checkpoint_catalog_video_set('${f.set}','${team}','${owner}','${f.enrollment}',1,${revision},'${JSON.stringify(f.children.map((c, index) => ({ ...c, operationId: index === 0 ? operations[index] : null, state: index === 0 ? 'working' : 'queued', outputId: null })))}'::jsonb)`
  );
  return {
    operations,
    dispatch: (index: number) =>
      `select public.service_dispatch_catalog_video_variant('${f.set}',decode('${f.token}','hex'),'${f.native}',1,${index},'${f.children[index]!.requestId}','${operations[index]}')`,
    close: (index: number, operation = operations[index]!, token = f.token) =>
      `select public.service_complete_catalog_video_variant('${f.set}',decode('${token}','hex'),'${f.native}',1,${index},'${f.children[index]!.requestId}','${operation}','failed','PROCESS_FAILED')`
  };
}

describe.skipIf(!container)(
  '047 command acceptance [needs: disposable PostgreSQL container]',
  () => {
    it('serializes video replacement acceptance and an absent-command check on real connections', async () => {
      const sheet = await fixture(),
        video = randomUUID(),
        key = randomUUID(),
        secondKey = randomUUID();
      const old = await sql(
        `select video_material_id from public.team_product_catalogs where material_id='${sheet}'`
      );
      await sql(`begin;
       update public.team_materials set drive_version='1',checksum=repeat('a',32),size_bytes=4 where id in('${old}','${sheet}');
       insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version,checksum,size_bytes)values('${video}','${team}','${connection}','${video}','root','Replacement video','file','video','video/mp4','1',repeat('b',32),4);
       select public.service_save_catalog_publication('${team}','${owner}','${randomUUID()}','${sheet}',0,'immediate',null,null,jsonb_build_object('kind','source','materialId','${old}','sourceVersion',private.catalog_publication_source_version('${old}','${team}')));
       update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id='${sheet}';
       update private.catalog_video_publication_jobs set state='published',provider_revision='1',verified_at=now()where catalog_material_id='${sheet}';
       insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at)select catalog_material_id,team_id,target_id,'1',now()from private.catalog_video_publication_policies where catalog_material_id='${sheet}';commit;`);
      const context = JSON.parse(
        await sql(
          `select public.service_catalog_video_replacement_context('${team}','${sheet}','${owner}')`
        )
      );
      const payload = (request: string) =>
        JSON.stringify({
          teamId: team,
          catalogId: sheet,
          expectedActorId: owner,
          requestId: request,
          newVideoId: video,
          expectedVersion: context.version,
          moveToVideoFolder: true
        });
      const command = (request: string) =>
        `select public.service_accept_catalog_video_replacement('${team}','${sheet}','${owner}','${payload(request)}'::jsonb)`;
      const marker = 'replace_' + randomUUID().replaceAll('-', '');
      const first = holdSql(command(key) + `;select 1 /*${marker}*/`);
      await held(marker, 'Idle');
      const second = sql(command(secondKey)).catch(e => e as Error);
      const check = sql(
        `select public.service_catalog_video_replacement_status('${team}','${sheet}','${owner}','${key}')`
      );
      await first.commit();
      expect(await second).toBeInstanceOf(Error);
      expect(
        String((await second) instanceof Error ? await second : 'unexpected success')
      ).toContain('CATALOG_PUBLICATION_PENDING');
      expect(JSON.parse(await check).state).toBe('publishing');
      expect(
        await sql(
          `select count(*)from private.catalog_video_replacements where catalog_material_id='${sheet}'`
        )
      ).toBe('1');
      expect(
        await sql(
          `select count(*)from private.catalog_video_replacement_absences where request_id='${key}'`
        )
      ).toBe('0');
    }, 15000);
    beforeAll(async () => {
      const credential = randomUUID();
      await sql(`begin;
      insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
        values('${owner}','authenticated','authenticated','${owner}@command-race.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      insert into public.teams(id,name,owner_id) values('${team}','Synthetic command race','${owner}');
      insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
      insert into private.google_drive_credentials(id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
        values('${credential}','${credential}','${owner}@command-race.test.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),'${owner}');
      insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
        values('${connection}','${team}','${credential}','root','Root','my_drive','connected',now());commit;`);
    });
    it('serializes replay of the same request key while the first acceptance is uncommitted', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_accept_hold */`)
      );
      await held('command_accept_hold');
      const second = sql(asActor(`${request(command, sheet)} /* command_replay_wait */`));
      await held('command_replay_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
      expect(await count(sheet)).toBe('1');
    }, 15000);
    it('lets a cancellation tombstone win before a delayed request arrives', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${cancel(command, sheet)};select pg_sleep(2) /* command_cancel_hold */`)
      );
      await held('command_cancel_hold');
      const second = sql(asActor(`${request(command, sheet)} /* command_late_wait */`));
      await held('command_late_wait', 'Lock');
      const result = receipt(await second);
      expect(result).toEqual(receipt(await first));
      expect(result.status).toBe('cancelled');
      expect(await count(sheet)).toBe('0');
    }, 15000);
    it('returns acceptance when cancellation loses the race and leaves the accepted run intact', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_first_hold */`)
      );
      await held('command_first_hold');
      const second = sql(asActor(`${cancel(command, sheet)} /* command_cancel_wait */`));
      await held('command_cancel_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
      expect(await count(sheet)).toBe('1');
      expect(
        await sql(
          `select round_due_at is not null from public.team_catalog_updater_items where catalog_material_id='${sheet}'`
        )
      ).toBe('t');
    }, 15000);
    it('serializes different commands for the same catalog without binding another accepted attempt', async () => {
      const sheet = await fixture(),
        command = randomUUID(),
        other = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_parent_hold */`)
      );
      await held('command_parent_hold');
      const second = sql(asActor(`${request(other, sheet)} /* command_parent_wait */`));
      await held('command_parent_wait', 'Lock');
      const result = receipt(await second),
        initial = receipt(await first);
      expect(initial.acceptedCount).toBe(1);
      expect(result.acceptedCount).toBe(0);
      expect(result.items[0].reason).toBe('already_pending');
      expect(await count(sheet)).toBe('1');
      expect(
        await sql(
          `select command_id from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
        )
      ).toBe(command);
    }, 15000);
    it('does not quarantine a replacement lease after waiting for its item lock', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      await sql(asActor(request(command, sheet)));
      await sql(`update public.team_catalog_update_attempts set result='failed',ended_at=clock_timestamp() where catalog_material_id='${sheet}';
        update public.team_catalog_updater_items set lease_owner='old-claim',lease_expires_at=clock_timestamp()+interval '1 minute' where catalog_material_id='${sheet}';`);
      const replacement = sql(
        `begin;update public.team_catalog_updater_items set lease_owner='new-claim' where catalog_material_id='${sheet}';select pg_sleep(2) /* claim_replacement_hold */;commit;`
      );
      await held('claim_replacement_hold');
      const park = sql(
        `select public.service_park_catalog_update_claim('${sheet}','old-claim') /* claim_replacement_wait */`
      );
      await held('claim_replacement_wait', 'Lock');
      await replacement;
      expect(await park).toBe('f');
      expect(
        await sql(
          `select lease_owner||':'||reconciliation_required::text from public.team_catalog_updater_items where catalog_material_id='${sheet}'`
        )
      ).toBe('new-claim:false');
    }, 15000);
    it('keeps an old terminal and closes its finished round before a racing Stop (1.4.3)', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      await sql(asActor(request(command, sheet)));
      await sql(`update public.team_catalog_update_attempts set result='failed',failure_code='DRIVE_UNAVAILABLE',ended_at=clock_timestamp() where catalog_material_id='${sheet}';
        update public.team_catalog_updater_items set lease_owner='park-owner',lease_expires_at=clock_timestamp()+interval '1 minute' where catalog_material_id='${sheet}';`);
      const parked = sql(
        `begin;select public.service_park_catalog_update_claim('${sheet}','park-owner');select pg_sleep(2) /* claim_quarantine_hold */;commit;`
      );
      await held('claim_quarantine_hold');
      const stopping = sql(
        asActor(
          `select public.cancel_team_catalog_update('${team}','${sheet}') /* claim_stop_wait */`
        )
      );
      // A finished attempt's round is closed by the park, not quarantined, so the
      // racing Stop finds nothing left to stop instead of a permanent hold.
      const resolved = expect(stopping).resolves.toBeDefined();
      await held('claim_stop_wait', 'Lock');
      await parked;
      await resolved;
      expect(
        await sql(
          `select coalesce(reconciliation_required,false)::text from public.team_catalog_updater_items where catalog_material_id='${sheet}' union all select 'false' limit 1`
        )
      ).toBe('false');
      expect(
        await sql(
          `select result||':'||failure_code from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
        )
      ).toBe('failed:DRIVE_UNAVAILABLE');
      expect(await count(sheet)).toBe('1');
    }, 15000);
    it('serializes replacement bulk groups before either acceptance becomes visible', async () => {
      const sheet = await fixture(),
        firstId = randomUUID(),
        otherId = randomUUID();
      const start = (id: string) =>
        `select public.start_team_bulk_trash_as_actor('${team}','${id}',array['${sheet}']::uuid[],'${owner}')`;
      const first = sql(asActor(`${start(firstId)};select pg_sleep(2) /* trash_accept_hold */`));
      await held('trash_accept_hold');
      const second = sql(asActor(`${start(otherId)} /* trash_overlap_wait */`)).then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      );
      await held('trash_overlap_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select count(*) from private.team_bulk_trash_groups where id in ('${firstId}','${otherId}')`
        )
      ).toBe('1');
    }, 15000);
    it('allows same-key bulk replay after a concurrent acceptance commits', async () => {
      const sheet = await fixture(),
        group = randomUUID();
      const start = `select public.start_team_bulk_trash('${team}','${group}',array['${sheet}']::uuid[])`;
      const first = sql(asActor(`${start};select pg_sleep(2) /* trash_replay_hold */`));
      await held('trash_replay_hold');
      const second = sql(asActor(`${start} /* trash_replay_wait */`));
      await held('trash_replay_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
    }, 15000);
    it('fences a racing child selection by another actor behind the accepted parent', async () => {
      const sheet = await fixture(),
        folder = randomUUID(),
        otherActor = randomUUID(),
        firstId = randomUUID(),
        otherId = randomUUID();
      await sql(`begin;
        insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values('${otherActor}','authenticated','authenticated','${otherActor}@bulk-race.test.invalid','{}','{}');
        insert into public.admin_users(user_id) values('${otherActor}');
        insert into public.team_members(team_id,user_id,base_role) values('${team}','${otherActor}','admin');
        insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values('${folder}','${team}','${connection}','${folder}','root','Synthetic folder','folder','application/vnd.google-apps.folder');
        update public.team_materials set parent_folder_id='${folder}' where id='${sheet}';commit;`);
      const first = sql(
        asActor(
          `select public.start_team_bulk_trash('${team}','${firstId}',array['${folder}']::uuid[]);select pg_sleep(2) /* trash_parent_hold */`
        )
      );
      await held('trash_parent_hold');
      const second = sql(
        `begin;select set_config('request.jwt.claim.sub','${otherActor}',true);set local role authenticated;select public.start_team_bulk_trash_as_actor('${team}','${otherId}',array['${sheet}']::uuid[],'${otherActor}') /* trash_child_wait */;commit;`
      ).then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      );
      await held('trash_child_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select count(*) from private.team_bulk_trash_groups where id in ('${firstId}','${otherId}')`
        )
      ).toBe('1');
    }, 15000);
    it('grants one material executor across independent concurrent SQL sessions', async () => {
      const f = await materialExecutionFixture(),
        firstOwner = randomUUID(),
        otherOwner = randomUUID();
      const first = sql(
        `begin;select public.service_claim_material_group_execution('${f.intent}','${firstOwner}');select pg_sleep(2) /* material_claim_hold */;commit;`
      );
      await held('material_claim_hold');
      const second = sql(
        `begin;select public.service_claim_material_group_execution('${f.intent}','${otherOwner}') /* material_claim_wait */;commit;`
      );
      await held('material_claim_wait', 'Lock');
      expect(receipt(await first).acquired).toBe(true);
      expect(receipt(await second).acquired).toBe(false);
      expect(
        await sql(
          `select execution_owner from private.team_material_group_intents where id='${f.intent}'`
        )
      ).toBe(firstOwner);
    }, 15000);
    it('never reissues a member reservation while a concurrent request is committing it', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID();
      expect(
        receipt(
          await sql(
            `select public.service_claim_material_group_execution('${f.intent}','${executor}')`
          )
        ).acquired
      ).toBe(true);
      const first = sql(
        `begin;select public.service_begin_material_group_dispatch('${f.intent}','${executor}','${f.material}');select pg_sleep(2) /* material_member_hold */;commit;`
      );
      await held('material_member_hold');
      const second = sql(
        `begin;select public.service_begin_material_group_dispatch('${f.intent}','${executor}','${f.material}') /* material_member_wait */;commit;`
      );
      await held('material_member_wait', 'Lock');
      expect(await first).toBe('t');
      expect(await second).toBe('f');
      await sql(`select public.service_end_material_group_execution('${f.intent}','${executor}')`);
      expect(
        receipt(
          await sql(
            `select public.service_claim_material_group_execution('${f.intent}','${randomUUID()}')`
          )
        ).acquired
      ).toBe(false);
    }, 15000);
    it('retains a cancellation committed while confirmed-group reconciliation waits', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID();
      await sql(`update public.team_materials set placement_state='moving' where id='${f.material}';
        select public.service_claim_material_group_execution('${f.intent}','${executor}');
        select public.service_begin_material_group_dispatch('${f.intent}','${executor}','${f.material}');
        select public.service_checkpoint_material_group_execution('${f.intent}','${executor}','${f.material}');`);
      const first = sql(
        asActor(
          `select public.cancel_team_operation('${team}','${f.operation}');select pg_sleep(2) /* group_completion_cancel_hold */`
        )
      );
      await held('group_completion_cancel_hold');
      const second = sql(
        `select public.service_reconcile_confirmed_material_group('${team}','${owner}','${f.operation}','${f.material}','trash',null) /* group_completion_cancel_wait */`
      ).then(
        value => ({ value, error: null }),
        error => ({ value: null, error: error as Error })
      );
      await held('group_completion_cancel_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(await sql(`select state from public.team_operations where id='${f.operation}'`)).toBe(
        'canceled'
      );
      expect(
        await sql(`select lifecycle from public.team_materials where id='${f.material}'`)
      ).toBe('active');
    }, 15000);
    it('refuses a late executor failure after concurrent registration commits', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID();
      await sql(`update public.team_materials set placement_state='moving' where id='${f.material}';
        select public.service_claim_material_group_execution('${f.intent}','${executor}');
        select public.service_begin_material_group_dispatch('${f.intent}','${executor}','${f.material}');
        select public.service_checkpoint_material_group_execution('${f.intent}','${executor}','${f.material}');`);
      const first = sql(
        `begin;select public.service_reconcile_confirmed_material_group('${team}','${owner}','${f.operation}','${f.material}','trash',null);select pg_sleep(2) /* material_completion_hold */;commit;`
      );
      await held('material_completion_hold');
      const second = sql(
        `select public.service_mark_material_group_execution_reconciling('${f.intent}','${executor}','DRIVE_UNAVAILABLE') /* material_late_failure_wait */`
      );
      await held('material_late_failure_wait', 'Lock');
      await first;
      expect(await second).toBe('f');
      expect(
        await sql(`select placement_state from public.team_materials where id='${f.material}'`)
      ).toBe('ready');
      expect(await sql(`select state from public.team_operations where id='${f.operation}'`)).toBe(
        'succeeded'
      );
    }, 15000);
    it('finishes an acknowledged intent after concurrent catalog observation commits', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID();
      await sql(`update public.team_materials set placement_state='moving' where id='${f.material}';
        select public.service_claim_material_group_execution('${f.intent}','${executor}');
        select public.service_begin_material_group_dispatch('${f.intent}','${executor}','${f.material}');
        select public.service_checkpoint_material_group_execution('${f.intent}','${executor}','${f.material}');`);
      const first = sql(
        `begin;update public.team_materials set lifecycle='trashed',trashed_at=now() where id='${f.material}';select pg_sleep(2) /* material_observation_hold */;commit;`
      );
      await held('material_observation_hold');
      const second = sql(
        `select public.service_reconcile_confirmed_material_group('${team}','${owner}','${f.operation}','${f.material}','trash',null) /* material_observation_wait */`
      );
      await held('material_observation_wait', 'Lock');
      await first;
      expect(receipt(await second).state).toBe('succeeded');
      expect(
        await sql(
          `select lifecycle||':'||placement_state from public.team_materials where id='${f.material}'`
        )
      ).toBe('trashed:ready');
    }, 15000);
    it('serializes overlapping member snapshots even when their primary sources differ', async () => {
      const f = await materialExecutionFixture(false, true),
        secondIntent = randomUUID(),
        secondOperation = randomUUID();
      await sql(`insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
        values('${secondOperation}','${team}','${owner}','trash','running','${f.child}','${secondOperation}','group-v1:${'b'.repeat(64)}')`);
      const first = sql(
        `begin;${f.statement};select pg_sleep(2) /* material_overlap_hold */;commit;`
      );
      await held('material_overlap_hold');
      const second =
        sql(`begin;insert into private.team_material_group_intents(id,team_id,source_material_id,operation_id,action,member_snapshot,state)
        values('${secondIntent}','${team}','${f.child}','${secondOperation}','trash',jsonb_build_array(jsonb_build_object('material_id','${f.child}','role','source')),'running') /* material_overlap_wait */;commit;`).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
      await held('material_overlap_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('GROUP_RECONCILING');
      expect(
        await sql(
          `select count(*) from private.team_material_group_intents where id='${secondIntent}'`
        )
      ).toBe('0');
    }, 15000);

    it('grants one screen range to overlapping same-state callers without replay dispatch', async () => {
      const f = await selectionStorageFixture();
      const first = sql(
        'begin;' +
          selectionStorageCas(f, f.selected, f.reserved) +
          ';select pg_sleep(2) /* screen_reservation_hold */;commit;'
      );
      await held('screen_reservation_hold');
      const second = sql(
        selectionStorageCas(f, f.selected, f.reserved) + ' /* screen_reservation_wait */'
      );
      await held('screen_reservation_wait', 'Lock');
      expect(await first).toBe('t');
      expect(await second).toBe('f');
      expect(
        await sql(
          "select range_count||':'||unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='" +
            f.root +
            "' and slot='end'"
        )
      ).toBe('1:1');
    }, 15000);
    it('refuses a range whose parent was canceled while its CAS waited', async () => {
      const f = await selectionStorageFixture();
      const first = sql(
        asActor(
          "select public.cancel_team_operation('" +
            team +
            "','" +
            f.root +
            "');select pg_sleep(2) /* screen_cancel_hold */"
        )
      );
      await held('screen_cancel_hold');
      const second = sql(
        selectionStorageCas(f, f.selected, f.reserved) + ' /* screen_cancel_wait */'
      ).then(
        value => ({ value, error: null }),
        error => ({ value: null, error: error as Error })
      );
      await held('screen_cancel_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('WRONG_STATE');
      expect(
        await sql(
          "select range_count from public.analytics_restitch_selection_slots where operation_id='" +
            f.root +
            "' and slot='end'"
        )
      ).toBe('0');
    }, 15000);
    it('waits for settled prefix accounting before reacquiring lost unvalidated bytes', async () => {
      const f = await selectionStorageFixture();
      expect(await sql(selectionStorageCas(f, f.selected, f.reserved))).toBe('t');
      const settled = settleScreenTransfer(f.reserved, f.requestId, {
        bytes: 2,
        ioMs: 5,
        complete: false
      });
      const reacquired = reacquireScreenCandidate(settled, f.reserved.candidates[0]!.versionId);
      const first = holdSql(selectionStorageSettle(f, 2) + ' /* screen_prefix_hold */');
      let second: Promise<string> | undefined;
      try {
        await held('screen_prefix_hold', 'Idle');
        // pg_stat_activity truncates long JSON queries at track_activity_query_size.
        second = sql(
          '/* screen_prefix_wait */ ' + selectionStorageCas(f, settled, reacquired) + ';'
        );
        void second.catch(() => undefined);
        await held('screen_prefix_wait', 'Lock');
      } finally {
        expect(await first.commit()).toBe('t');
      }
      expect(await second).toBe('t');
      expect(
        await sql(
          "select confirmed_bytes||':'||retry_count||':'||state from public.analytics_restitch_selection_slots where operation_id='" +
            f.root +
            "' and slot='end'"
        )
      ).toBe('2:1:candidate_selected');
      expect(await sql("select state from public.team_operations where id='" + f.root + "'")).toBe(
        'running'
      );
    }, 15000);
    it('records a reserved range after concurrent cancellation without reviving its parent', async () => {
      const f = await selectionStorageFixture();
      expect(await sql(selectionStorageCas(f, f.selected, f.reserved))).toBe('t');
      const first = sql(
        asActor(
          "select public.cancel_team_operation('" +
            team +
            "','" +
            f.root +
            "');select pg_sleep(2) /* screen_accounting_cancel_hold */"
        )
      );
      await held('screen_accounting_cancel_hold');
      const second = sql(selectionStorageSettle(f, 2) + ' /* screen_accounting_cancel_wait */');
      await held('screen_accounting_cancel_wait', 'Lock');
      await first;
      expect(await second).toBe('t');
      expect(
        await sql(
          "select confirmed_bytes||':'||unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='" +
            f.root +
            "' and slot='end'"
        )
      ).toBe('2:0');
      expect(await sql("select state from public.team_operations where id='" + f.root + "'")).toBe(
        'canceled'
      );
    }, 15000);
    it('serializes an atomic manual selection root behind a missing first acknowledgement', async () => {
      const f = await manualSelectionFixture();
      const first = holdSql(f.accept + ' /* manual_selection_accept_hold */');
      let second: Promise<string> | undefined, original: string;
      try {
        await held('manual_selection_accept_hold', 'Idle');
        second = sql(f.accept + ' /* manual_selection_accept_wait */');
        void second.catch(() => undefined);
        await held('manual_selection_accept_wait', 'Lock');
      } finally {
        original = await first.commit();
      }
      const a = JSON.parse(original),
        b = JSON.parse((await second)!);
      expect(a.operationId).toBe(b.operationId);
      expect(a.reused).toBe(false);
      expect(b.reused).toBe(true);
      expect(
        await sql(
          `select count(*) from private.restitch_selection_executors where root_operation_id='${a.operationId}' and state='unclaimed'`
        )
      ).toBe('1');
    }, 15000);
    it('admits only one native executor when claims arrive concurrently', async () => {
      const f = await manualSelectionFixture(),
        root = JSON.parse(await sql(f.accept)).operationId as string;
      const claim = randomUUID(),
        native = randomUUID();
      const first = holdSql(
        claimSelection(root, claim, native) + ' /* manual_executor_claim_hold */'
      );
      let second: Promise<{ error: Error | null }> | undefined, original: string;
      try {
        await held('manual_executor_claim_hold', 'Idle');
        second = sql(
          claimSelection(root, randomUUID(), randomUUID()) + ' /* manual_executor_claim_wait */'
        ).then(
          () => ({ error: null }),
          error => ({ error: error as Error })
        );
        await held('manual_executor_claim_wait', 'Lock');
      } finally {
        original = await first.commit();
      }
      expect((await second)?.error?.message).toContain('WRONG_STATE');
      const accepted = JSON.parse(original);
      expect(accepted.active).toBe(true);
      expect(accepted.epoch).toBe(1);
      expect(JSON.parse(await sql(claimSelection(root, claim, native)))).toEqual(accepted);
      expect(
        JSON.parse(
          await sql(
            `select public.service_read_restitch_executor_claim('${root}','${team}','${owner}','${claim}','${native}')`
          )
        )
      ).toEqual(accepted);
    }, 15000);
    it('refuses a delayed old-owner range after a newer claim commits', async () => {
      const f = await manualSelectionFixture(),
        root = JSON.parse(await sql(f.accept)).operationId as string;
      const old = JSON.parse(await sql(claimSelection(root, randomUUID(), randomUUID()))) as {
        executorId: string;
        epoch: number;
      };
      const version = await sql(
        `select version_id from private.restitch_selection_candidates where root_operation_id='${root}' and slot='end' order by ordinal limit 1`
      );
      const selected = selectScreenCandidate(createScreenSelectionBudget(), version, 4),
        reserved = reserveScreenTransfer(selected, version, randomUUID(), 0).state;
      expect(
        await sql(
          ownedSelectionCas(
            root,
            old.executorId,
            old.epoch,
            createScreenSelectionBudget(),
            selected
          )
        )
      ).toBe('t');
      expect(
        await sql(
          `select public.service_quiesce_restitch_executor('${root}','${team}','${owner}','${old.executorId}',${old.epoch},'${randomUUID()}')`
        )
      ).toBe('t');
      const first = holdSql(
        claimSelection(root, randomUUID(), randomUUID()) + ' /* newer_executor_hold */'
      );
      let second: Promise<{ error: Error | null }> | undefined;
      try {
        await held('newer_executor_hold', 'Idle');
        second = sql(
          '/* old_executor_range_wait */ ' +
            ownedSelectionCas(root, old.executorId, old.epoch, selected, reserved)
        ).then(
          () => ({ error: null }),
          error => ({ error: error as Error })
        );
        await held('old_executor_range_wait', 'Lock');
      } finally {
        expect(JSON.parse(await first.commit()).epoch).toBe(2);
      }
      expect((await second)?.error?.message).toContain('WRONG_STATE');
      expect(
        await sql(
          `select range_count from public.analytics_restitch_selection_slots where operation_id='${root}' and slot='end'`
        )
      ).toBe('0');
    }, 15000);
    it('grants one epoch CAS across concurrent material claim sessions', async () => {
      const f = await materialExecutionFixture(),
        firstOwner = randomUUID(),
        other = randomUUID();
      const first = holdSql(
        `select public.service_claim_material_group_execution_v2('${f.intent}','${firstOwner}',0) /* group_epoch_claim_hold */`
      );
      let second: Promise<string> | undefined;
      let original: string;
      try {
        await held('group_epoch_claim_hold', 'Idle');
        second = sql(
          `select public.service_claim_material_group_execution_v2('${f.intent}','${other}',0) /* group_epoch_claim_wait */`
        );
        void second.catch(() => undefined);
        await held('group_epoch_claim_wait', 'Lock');
      } finally {
        original = await first.commit();
      }
      expect(JSON.parse(original)).toMatchObject({
        acquired: true,
        epoch: 1,
        executorId: firstOwner
      });
      expect(JSON.parse((await second)!)).toMatchObject({
        acquired: false,
        epoch: 1,
        executorId: null
      });
    }, 15000);
    it('retains a concurrently committed unconfirmed provider dispatch across epoch takeover', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID(),
        other = randomUUID();
      expect(
        JSON.parse(
          await sql(
            `select public.service_claim_material_group_execution_v2('${f.intent}','${executor}',0)`
          )
        ).acquired
      ).toBe(true);
      const first = holdSql(
        `select public.service_begin_material_group_dispatch_v2('${f.intent}','${executor}',1,'${f.material}') /* group_epoch_dispatch_hold */`
      );
      let second: Promise<string> | undefined;
      try {
        await held('group_epoch_dispatch_hold', 'Idle');
        second = sql(
          `select public.service_claim_material_group_execution_v2('${f.intent}','${other}',1) /* group_epoch_dispatch_wait */`
        );
        void second.catch(() => undefined);
        await held('group_epoch_dispatch_wait', 'Lock');
      } finally {
        expect(await first.commit()).toBe('t');
      }
      expect(JSON.parse((await second)!)).toMatchObject({
        acquired: false,
        hasPendingDispatch: true
      });
      expect(
        await sql(
          `select execution_epoch||':'||(dispatch_member is not null)::text from private.team_material_group_intents where id='${f.intent}'`
        )
      ).toBe('1:true');
    }, 15000);
    it('refuses a delayed old epoch close after a replacement material owner commits', async () => {
      const f = await materialExecutionFixture(),
        old = randomUUID(),
        current = randomUUID();
      expect(
        JSON.parse(
          await sql(
            `select public.service_claim_material_group_execution_v2('${f.intent}','${old}',0)`
          )
        ).acquired
      ).toBe(true);
      const first = holdSql(
        `select public.service_claim_material_group_execution_v2('${f.intent}','${current}',1) /* group_epoch_replace_hold */`
      );
      let second: Promise<string> | undefined;
      try {
        await held('group_epoch_replace_hold', 'Idle');
        second = sql(
          `select public.service_end_material_group_execution_v2('${f.intent}','${old}',1,null,null) /* group_epoch_close_wait */`
        );
        void second.catch(() => undefined);
        await held('group_epoch_close_wait', 'Lock');
      } finally {
        expect(JSON.parse(await first.commit()).epoch).toBe(2);
      }
      expect(await second).toBe('f');
      expect(
        await sql(
          `select public.service_begin_material_group_dispatch_v2('${f.intent}','${current}',2,'${f.material}')`
        )
      ).toBe('t');
      expect(
        await sql(`select public.service_end_material_group_execution('${f.intent}','${old}')`)
      ).toBe('f');
      expect(
        await sql(
          `select execution_epoch||':'||execution_closed::text||':'||(dispatch_member is not null)::text from private.team_material_group_intents where id='${f.intent}'`
        )
      ).toBe('2:false:true');
    }, 15000);
    it('refuses material dispatch when cancellation commits before its operation lock', async () => {
      const f = await materialExecutionFixture(),
        executor = randomUUID();
      expect(
        JSON.parse(
          await sql(
            `select public.service_claim_material_group_execution_v2('${f.intent}','${executor}',0)`
          )
        ).acquired
      ).toBe(true);
      const first = holdSql(
        `update public.team_operations set state='canceled',stage='canceled',finished_at=clock_timestamp() where id='${f.operation}' /* group_epoch_cancel_hold */`
      );
      let second: Promise<string> | undefined;
      try {
        await held('group_epoch_cancel_hold', 'Idle');
        second = sql(
          `select public.service_begin_material_group_dispatch_v2('${f.intent}','${executor}',1,'${f.material}') /* group_epoch_cancel_wait */`
        );
        void second.catch(() => undefined);
        await held('group_epoch_cancel_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect(await second).toBe('f');
      expect(
        await sql(
          `select (dispatch_member is null)::text from private.team_material_group_intents where id='${f.intent}'`
        )
      ).toBe('true');
      expect(await sql(`select state from public.team_operations where id='${f.operation}'`)).toBe(
        'canceled'
      );
    }, 15000);
    it('serializes exact range issuance with one reserved budget behind a lost first acknowledgement', async () => {
      const f = await screenRangeAuthorityFixture();
      // pg_stat_activity truncates long query text; keep the barrier in its visible prefix.
      const first = holdSql('/* range_grant_issue_hold */ ' + f.issue);
      let second: Promise<string> | undefined, original: string;
      try {
        await held('range_grant_issue_hold', 'Idle');
        second = sql('/* range_grant_issue_wait */ ' + f.issue);
        void second.catch(() => undefined);
        await held('range_grant_issue_wait', 'Lock');
      } finally {
        original = await first.commit();
      }
      expect(JSON.parse((await second)!)).toEqual(JSON.parse(original));
      expect(
        await sql(
          `select count(*) from private.restitch_screen_range_grants where root_operation_id='${f.root}'`
        )
      ).toBe('1');
      expect(
        await sql(
          `select range_count||':'||unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='${f.root}' and slot='end'`
        )
      ).toBe('1:1');
    }, 15000);
    it('keeps a concurrently consumed range held instead of abandoning unknown provider cost', async () => {
      const f = await screenRangeAuthorityFixture();
      await sql(f.issue);
      const first = holdSql(f.consume() + ' /* range_consume_hold */');
      let second: Promise<string> | undefined, claimed: string;
      try {
        await held('range_consume_hold', 'Idle');
        second = sql(f.abandon + ' /* range_abandon_wait */');
        void second.catch(() => undefined);
        await held('range_abandon_wait', 'Lock');
      } finally {
        claimed = await first.commit();
      }
      expect(JSON.parse(claimed).dispatch).toBe(true);
      expect(await second).toBe('f');
      expect(
        await sql(
          `select unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='${f.root}' and slot='end'`
        )
      ).toBe('1');
    }, 15000);
    it('refuses a waiting consumer after authoritative zero-cost abandonment commits', async () => {
      const f = await screenRangeAuthorityFixture();
      await sql(f.issue);
      const first = holdSql(f.abandon + ' /* range_abandon_hold */');
      let second: Promise<string> | undefined;
      try {
        await held('range_abandon_hold', 'Idle');
        second = sql(f.consume() + ' /* range_consume_wait */');
        void second.catch(() => undefined);
        await held('range_consume_wait', 'Lock');
      } finally {
        expect(await first.commit()).toBe('t');
      }
      expect(JSON.parse((await second)!).dispatch).toBe(false);
      expect(
        await sql(
          `select confirmed_bytes||':'||unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='${f.root}' and slot='end'`
        )
      ).toBe('0:0');
    }, 15000);
    it('binds one control grant atomically before a concurrent grant can adopt its claim UUID', async () => {
      const f = await nativeControlAuthorityFixture(),
        a = await f.enroll(),
        b = await f.enroll(),
        claim = randomUUID();
      const first = holdSql('/* native_control_claim_hold */ ' + a.claim(claim));
      let second: Promise<{ value: string | null; error: Error | null }> | undefined,
        accepted: string;
      try {
        await held('native_control_claim_hold', 'Idle');
        second = sql('/* native_control_claim_wait */ ' + b.claim(claim)).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('native_control_claim_wait', 'Lock');
      } finally {
        accepted = await first.commit();
      }
      expect(JSON.parse(accepted).active).toBe(true);
      expect((await second)!.error?.message).toContain('REQUEST_REUSE_CONFLICT');
      expect(
        await sql(
          `select count(*) from private.restitch_selection_executor_claims where root_operation_id='${f.root}'`
        )
      ).toBe('1');
      expect(
        await sql(
          `select count(*) from private.restitch_native_controls where root_operation_id='${f.root}' and claim_id is not null`
        )
      ).toBe('1');
      expect(JSON.parse(await sql(a.read(claim))).active).toBe(true);
    }, 15000);
    it('refuses a native I/O authorization that was waiting while logout removed its Auth session', async () => {
      const f = await nativeControlAuthorityFixture(),
        control = await f.enroll(),
        claim = randomUUID();
      await sql(control.claim(claim));
      const first = holdSql(
        `/* native_control_logout_hold */ delete from auth.sessions where id='${f.session}'`
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('native_control_logout_hold', 'Idle');
        second = sql('/* native_control_logout_wait */ ' + control.authorize).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('native_control_logout_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('AUTH_REQUIRED');
      expect(JSON.parse(await sql(control.read(claim))).active).toBe(true);
      expect(await sql(control.close(claim, randomUUID()))).toBe('t');
    }, 15000);
    it('refuses a controlled screen consume waiting behind actual Auth-session removal without consuming the leaf', async () => {
      const f = await controlledNativeRangeFixture();
      const first = holdSql(
        `/* controlled_screen_logout_hold */ delete from auth.sessions where id='${f.session}'`
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('controlled_screen_logout_hold', 'Idle');
        second = sql('/* controlled_screen_consume_wait */ ' + f.consume(randomUUID())).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('controlled_screen_consume_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('AUTH_REQUIRED');
      expect(
        await sql(`select state from private.restitch_screen_range_grants where id='${f.range}'`)
      ).toBe('issued');
      expect(await sql(f.abandon)).toBe('t');
      expect(
        await sql(
          `select confirmed_bytes||':'||unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='${f.root}' and slot='end'`
        )
      ).toBe('0:0');
    }, 15000);
    it('keeps consumed cost held when logout wins over a waiting protected-upstream authority check', async () => {
      const f = await controlledNativeRangeFixture(),
        dispatch = randomUUID();
      expect(JSON.parse(await sql(f.consume(dispatch))).dispatch).toBe(true);
      const first = holdSql(
        `/* controlled_upstream_logout_hold */ delete from auth.sessions where id='${f.session}'`
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('controlled_upstream_logout_hold', 'Idle');
        second = sql('/* controlled_upstream_check_wait */ ' + f.check(dispatch)).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('controlled_upstream_check_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('AUTH_REQUIRED');
      expect(JSON.parse(await sql(f.read(dispatch))).consumedByInvocation).toBe(true);
      expect(await sql(f.abandon)).toBe('f');
      expect(
        await sql(
          `select unconfirmed_range_count from public.analytics_restitch_selection_slots where operation_id='${f.root}' and slot='end'`
        )
      ).toBe('1');
    }, 15000);

    it('blocks a foreground NEW-I/O authorization waiting behind real Auth-session logout', async () => {
      const f = await foregroundCatalogFixture();
      const first = holdSql(
        `/* foreground_logout_hold */ delete from auth.sessions where id='${f.session}'`
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('foreground_logout_hold', 'Idle');
        second = sql('/* foreground_authorize_wait */ ' + f.authorize).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('foreground_authorize_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('AUTH_REQUIRED');
      expect(await sql(`select state from private.catalog_video_sets where id='${f.set}'`)).toBe(
        'accepted'
      );
      expect(
        await sql(
          `select count(*) from private.team_recovery_execution_fences fence join public.team_operations op on op.id=fence.operation_id where op.source_material_id='${f.source}'`
        )
      ).toBe('0');
      expect(
        await sql(
          `select count(*) from private.restitch_screen_range_grants g join public.team_operations op on op.id=g.root_operation_id where op.source_material_id='${f.source}'`
        )
      ).toBe('0');
      expect(
        await sql(
          `select count(*) from private.catalog_video_variants where video_set_id='${f.set}' and state<>'queued'`
        )
      ).toBe('0');
    }, 15000);
    it('permits only one quiescent foreground boot rotation when independent redeemers race', async () => {
      const f = await foregroundCatalogFixture(),
        bootA = randomUUID(),
        bootB = randomUUID();
      const beforeEpoch = Number(
        await sql(`select epoch from private.catalog_video_sets where id='${f.set}'`)
      );
      const first = holdSql('/* foreground_rotation_hold */ ' + f.redeem(bootA));
      let second: Promise<{ value: string | null; error: Error | null }> | undefined,
        winner: string;
      try {
        await held('foreground_rotation_hold', 'Idle');
        second = sql('/* foreground_rotation_wait */ ' + f.redeem(bootB)).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('foreground_rotation_wait', 'Lock');
      } finally {
        winner = await first.commit();
      }
      expect(JSON.parse(winner).executionNativeInstanceId).toBe(bootA);
      expect((await second)!.error?.message).toContain('REQUEST_REUSE_CONFLICT');
      expect(
        await sql(
          `select native_instance_id||':'||epoch from private.catalog_video_sets where id='${f.set}'`
        )
      ).toBe(`${bootA}:${beforeEpoch + 1}`);
      expect(
        await sql(
          `select execution_native_instance_id from private.catalog_video_foreground_authorities where enrollment_id='${f.enrollment}'`
        )
      ).toBe(bootA);
      await sql(
        `update private.catalog_video_variants set state='unknown' where video_set_id='${f.set}' and video_variant_index=0`
      );
      expect(JSON.parse(await sql(f.redeem(bootA))).executionNativeInstanceId).toBe(bootA);
      await expect(sql(f.redeem(randomUUID(), bootA))).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select native_instance_id||':'||epoch from private.catalog_video_sets where id='${f.set}'`
        )
      ).toBe(`${bootA}:${beforeEpoch + 1}`);
      const active = await foregroundCatalogFixture(),
        work = await foregroundWorkingChildren(active);
      expect(JSON.parse(await sql(work.dispatch(0))).executionAllowed).toBe(true);
      await expect(sql(active.redeem(randomUUID()))).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select native_instance_id||':'||epoch from private.catalog_video_sets where id='${active.set}'`
        )
      ).toBe(`${active.native}:1`);
    }, 15000);
    it('refuses a waiting foreground dispatch after logout but accepts only its original dispatched closure', async () => {
      const f = await foregroundCatalogFixture(),
        work = await foregroundWorkingChildren(f);
      const first = holdSql(
        `/* foreground_dispatch_logout_hold */ delete from auth.sessions where id='${f.session}'`
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('foreground_dispatch_logout_hold', 'Idle');
        second = sql('/* foreground_dispatch_wait */ ' + work.dispatch(0)).then(
          value => ({ value, error: null }),
          error => ({ value: null, error: error as Error })
        );
        await held('foreground_dispatch_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('AUTH_REQUIRED');
      expect(
        await sql(
          `select count(*) from private.team_recovery_execution_fences where operation_id in('${work.operations[0]}','${work.operations[1]}')`
        )
      ).toBe('0');
      expect(
        await sql(
          `select dispatch_credential_hash is null from private.catalog_video_variants where video_set_id='${f.set}' and video_variant_index=0`
        )
      ).toBe('t');
      expect(
        await sql(
          `select count(*) from private.restitch_screen_range_grants where root_operation_id in('${work.operations[0]}','${work.operations[1]}')`
        )
      ).toBe('0');
      // A distinct valid original dispatch proves late closure independently of
      // the never-authorized NEW dispatch above, without two working N children.
      const prior = await foregroundCatalogFixture(),
        old = await foregroundWorkingChildren(prior);
      expect(JSON.parse(await sql(old.dispatch(0))).executionAllowed).toBe(true);
      await sql(`delete from auth.sessions where id='${prior.session}'`);
      await expect(sql(old.close(0, old.operations[1]))).rejects.toThrow('PERMISSION_DENIED');
      await expect(sql(old.close(0, old.operations[0], 'f'.repeat(64)))).rejects.toThrow(
        'PERMISSION_DENIED'
      );
      expect(JSON.parse(await sql(old.close(0)))).toMatchObject({
        kind: 'terminal',
        state: 'failed'
      });
      expect(
        await sql(
          `select count(*) from private.team_recovery_execution_fences where operation_id='${old.operations[1]}'`
        )
      ).toBe('0');
    }, 15000);

    it('rejects a late variant admission waiting behind a committed quiescent cancellation settlement', async () => {
      const f = await foregroundCatalogFixture(),
        operation = randomUUID(),
        child = f.children[0]!;
      await sql(`update private.catalog_generation_intents set checkpoint=checkpoint||'${JSON.stringify({ initialVideoPlan: { setId: f.set } })}'::jsonb where id='${f.intent}';
        update private.catalog_video_sets set state='cancel_requested'where id='${f.set}'`);
      const first = holdSql(
        '/* cancellation_settlement_hold */ select public.service_settle_catalog_video_cancellations(10)'
      );
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('cancellation_settlement_hold', 'Idle');
        second =
          sql(`/* canceled_variant_admission_wait */ insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
          values('${operation}','${team}','${owner}','process','pending','${f.source}','catalog-variant:${child.requestId}','catalog-variant:${child.requestId}')`).then(
            value => ({ value, error: null }),
            error => ({ value: null, error: error as Error })
          );
        await held('canceled_variant_admission_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error?.message).toContain('WRONG_STATE');
      expect(await sql(`select state from private.catalog_video_sets where id='${f.set}'`)).toBe(
        'canceled'
      );
      expect(await sql(`select count(*)from public.team_operations where id='${operation}'`)).toBe(
        '0'
      );
      expect(
        await sql(
          `select count(*)from private.catalog_video_variants where video_set_id='${f.set}'and(operation_id is not null or output_material_id is not null or state='registered')`
        )
      ).toBe('0');
      expect(
        await sql(
          `select count(*)from private.team_recovery_execution_fences where operation_id='${operation}'`
        )
      ).toBe('0');
    }, 15000);
    it('settles only original pending metadata when variant admission commits before the waiting cancellation', async () => {
      const f = await foregroundCatalogFixture(),
        operation = randomUUID(),
        child = f.children[0]!;
      await sql(
        `update private.catalog_generation_intents set checkpoint=checkpoint||'${JSON.stringify({ initialVideoPlan: { setId: f.set } })}'::jsonb where id='${f.intent}'`
      );
      const first =
        holdSql(`/* pending_variant_admission_hold */ insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)
        values('${operation}','${team}','${owner}','process','pending','${f.source}','catalog-variant:${child.requestId}','catalog-variant:${child.requestId}');
        insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)
        values('${operation}','${team}','restitch','1','${f.source}',repeat('a',32),'copy.mp4',4,'video/mp4') /* pending_variant_admission_hold */`);
      let second: Promise<{ value: string | null; error: Error | null }> | undefined;
      try {
        await held('pending_variant_admission_hold', 'Idle');
        second =
          sql(`begin;/* admitted_variant_cancel_wait */ update private.catalog_video_sets set state='cancel_requested'where id='${f.set}';
          select public.service_settle_catalog_video_cancellations(10);commit;`).then(
            value => ({ value, error: null }),
            error => ({ value: null, error: error as Error })
          );
        await held('admitted_variant_cancel_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect((await second)!.error).toBeNull();
      expect(
        await sql(
          `select state||':'||(result_material_id is null)::text from public.team_operations where id='${operation}'`
        )
      ).toBe('canceled:true');
      expect(await sql(`select state from private.catalog_video_sets where id='${f.set}'`)).toBe(
        'canceled'
      );
      expect(
        await sql(
          `select provider_result_id is null from private.team_operation_intents where operation_id='${operation}'`
        )
      ).toBe('t');
      expect(
        await sql(
          `select count(*)from private.catalog_video_variants where video_set_id='${f.set}'and(output_material_id is not null or state='registered')`
        )
      ).toBe('0');
      expect(
        await sql(`select (select count(*)from private.team_recovery_execution_fences where operation_id='${operation}')+
        (select count(*)from private.process_upload_ownership where operation_id='${operation}')+
        (select count(*)from private.team_transfer_grants where operation_id='${operation}')+
        (select count(*)from private.restitch_process_aliases where root_operation_id='${operation}')+
        (select count(*)from private.restitch_screen_range_grants where root_operation_id='${operation}')`)
      ).toBe('0');
    }, 15000);
  }
);
