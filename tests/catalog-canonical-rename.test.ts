import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  handleCatalogRename,
  recoverCatalogRenames,
  type CatalogRenameDeps
} from '../supabase/functions/drive-ops/catalog-rename';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
import type {
  CatalogRenameContext,
  CatalogRenameRequest,
  CatalogRenameReceipt
} from '../packages/shared/src/team/catalog-rename';

const id = (n: number) => 'cf530000-0000-4000-8000-' + String(n).padStart(12, '0');
const OWNER = id(1),
  ACTOR = id(2),
  VIEWER = id(3);
let db: TeamTestDb,
  team: string,
  connection: string,
  sequence = 0;
const names = new Set([
  'service_catalog_rename_context',
  'service_catalog_rename_status',
  'service_accept_catalog_rename',
  'service_claim_catalog_rename',
  'service_prepare_catalog_rename',
  'service_settle_catalog_rename',
  'service_due_catalog_renames'
]);
const service: ServiceRpcClient = {
  rpc: async (name, args) => {
    if (!names.has(name)) throw Error('Unexpected RPC ' + name);
    const keys = Object.keys(args);
    if (keys.some(key => !/^p_[a-z_]+$/u.test(key))) throw Error('Unexpected argument');
    try {
      return {
        data: (
          await db.root<{ value: unknown }>(
            `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) value`,
            keys.map(key => args[key])
          )
        )[0].value,
        error: null
      };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }
};
beforeAll(async () => {
  db = await createTeamTestDb();
  for (const [user, role] of [
    [OWNER, 'owner'],
    [ACTOR, 'editor'],
    [VIEWER, 'viewer']
  ])
    await createUser(db, { id: user, email: `${role}@canonical-rename.test` });
  await db.root('insert into public.admin_users(user_id)values($1)', [OWNER]);
  team = (await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Rename')"))[0]
    .id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role)values($1,$2,'editor'),($1,$3,'viewer')",
    [team, ACTOR, VIEWER]
  );
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)values('rename-perm','owner@rename.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1)returning id",
      [OWNER]
    )
  )[0].id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)values($1,$2,'root','Root','my_drive','connected',now())returning id",
      [team, credential]
    )
  )[0].id;
}, 60_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.root(
    "update public.team_members set base_role='editor'where team_id=$1 and user_id=$2",
    [team, ACTOR]
  );
});

it('retains cleanup coverage and rejects late rename records after task-file cleanup claims the catalog', async () => {
  const f = await fixture();
  const command = await f.command();
  const task = crypto.randomUUID(),
    upload = crypto.randomUUID();
  await db.root(
    "insert into public.team_tasks(id,team_id,created_by,title)values($1,$2,$3,'Synthetic task')",
    [task, team, OWNER]
  );
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,finished_at)values($1::uuid,$2,$3,'upload','succeeded',$1::text,$1::text,now())",
    [upload, team, OWNER]
  );
  await db.root(
    "insert into private.task_owned_uploads(material_id,team_id,task_id,actor_id,upload_operation_id,parent_folder_id,drive_file_id)select id,team_id,$2,$3,$4,'root',drive_file_id from public.team_materials where id=$1",
    [f.material, task, OWNER, upload]
  );
  await db.root(
    "insert into private.task_attachment_cleanup(team_id,task_id,material_id,actor_id,state)values($1,$2,$3,$4,'claimed')",
    [team, task, f.material, OWNER]
  );
  try {
    expect(
      (
        await db.root<{ covered: boolean }>(
          'select private.task_cleanup_coverage_verified() covered'
        )
      )[0].covered
    ).toBe(true);
    await expect(f.apply(command)).rejects.toThrow('WRONG_STATE');
    await expect(f.status(command)).rejects.toThrow('WRONG_STATE');
    await expect(
      db.root(
        "insert into private.catalog_name_aliases(team_id,material_id,name,operation_id)values($1,$2,'Late alias',$3)",
        [team, f.material, upload]
      )
    ).rejects.toThrow('WRONG_STATE');
    expect(
      await db.root('select id from private.catalog_rename_requests where material_id=$1', [
        f.material
      ])
    ).toEqual([]);
    expect(
      await db.root(
        'select request_key from private.catalog_rename_absent_commands where material_id=$1',
        [f.material]
      )
    ).toEqual([]);
    expect(await f.aliases()).toEqual([]);
    expect(f.patch).not.toHaveBeenCalled();
  } finally {
    await db.root(
      "update private.task_attachment_cleanup set state='cancelled' where material_id=$1",
      [f.material]
    );
  }
});
async function fixture(name = 'Original catalog', sourceLink = 'https://offer.test/?sub=plain') {
  sequence++;
  const video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version)values($1,$2,$3,'root','Video','file','video','video/mp4','1')returning id",
      [team, connection, `video-${sequence}`]
    )
  )[0].id;
  const material = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version)values($1,$2,$3,'root',$4,'file','other','application/vnd.google-apps.spreadsheet','1')returning id",
      [team, connection, `sheet-${sequence}`, name]
    )
  )[0].id;
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4::jsonb)', [
    team,
    video,
    material,
    JSON.stringify({
      sourceLink,
      productCount: 10,
      sheetUrl: `https://docs.google.com/spreadsheets/d/sheet-${sequence}/edit`,
      videoLink: 'https://drive.google.com/file/d/video/view',
      settingsSnapshot: {
        title: 'Product',
        description: 'Description',
        price: 10,
        imageLink: 'https://image.test/image'
      },
      createdBy: OWNER
    })
  ]);
  const state = { name, etag: '"v1"', version: '1', trashed: false, parent: 'root' };
  const fileId = `sheet-${sequence}`;
  const live = () =>
    ({
      id: fileId,
      name: state.name,
      parents: [state.parent],
      trashed: state.trashed,
      version: state.version,
      checksum: null,
      size: null
    }) as DriveFileMetadata;
  const read = vi.fn(async () => ({
    id: fileId,
    name: state.name,
    etag: state.etag,
    parents: [state.parent],
    trashed: state.trashed,
    canRename: true
  }));
  const patch = vi.fn(async (_fileId: string, etag: string, newName: string) => {
    if (etag !== state.etag) throw new TeamFunctionError('SOURCE_CHANGED');
    state.name = newName;
    state.etag = '"v2"';
    state.version = '2';
  });
  const deps: CatalogRenameDeps = {
    service,
    prove: vi.fn(async () => ({
      live: live(),
      drive: { getCatalogRenameFile: read, renameCatalogConditionally: patch }
    }))
  };
  const context = async (actor = ACTOR) =>
    handleCatalogRename(
      'context',
      { teamId: team, materialId: material, expectedActorId: actor },
      actor,
      deps
    ) as Promise<CatalogRenameContext>;
  const command = async (newName = 'Updated catalog'): Promise<CatalogRenameRequest> => {
    const ctx = await context();
    return {
      teamId: team,
      materialId: material,
      expectedActorId: ACTOR,
      requestKey: crypto.randomUUID(),
      newName,
      expectedMaterialVersion: ctx.materialVersion,
      impactVersion: ctx.impactVersion,
      acknowledgeBoundNames: ctx.requiresAcknowledgement
    };
  };
  const apply = (input: CatalogRenameRequest) =>
    handleCatalogRename('apply', input, ACTOR, deps) as Promise<CatalogRenameReceipt>;
  const accept = async (input: CatalogRenameRequest) =>
    (
      await service.rpc('service_accept_catalog_rename', {
        p_team: team,
        p_material: material,
        p_actor: ACTOR,
        p_key: input.requestKey,
        p_request: input
      })
    ).data as CatalogRenameReceipt;
  const status = (input: CatalogRenameRequest) =>
    handleCatalogRename('status', input, ACTOR, deps) as Promise<CatalogRenameReceipt>;
  const aliases = () =>
    db.root<{ name: string }>(
      'select name from private.catalog_name_aliases where team_id=$1 and material_id=$2 order by name',
      [team, material]
    );
  return {
    video,
    material,
    state,
    deps,
    read,
    patch,
    context,
    command,
    apply,
    accept,
    status,
    aliases
  };
}
it.each(['https://offer.test/?sub=Old%20Catalog', 'https://offer.test/?sub=Old+Catalog'])(
  'proves saved manual URL binding without catalogName SUB configuration: %s',
  async url => {
    const f = await fixture('Old Catalog', url);
    expect(await f.context()).toMatchObject({
      boundNames: ['Old Catalog'],
      requiresAcknowledgement: true
    });
    const command = await f.command();
    await expect(f.apply({ ...command, acknowledgeBoundNames: false })).rejects.toThrow(
      'SOURCE_CHANGED'
    );
    expect(f.patch).not.toHaveBeenCalled();
  }
);
it('also proves a literal saved name and leaves malformed URL escapes as unknown text', async () => {
  const f = await fixture('OldCatalog', 'https://offer.test/?sub=buyer-OldCatalog');
  expect(await f.context()).toMatchObject({
    boundNames: ['OldCatalog'],
    requiresAcknowledgement: true
  });
  expect(
    await db.root<{ value: string }>("select private.catalog_decode_url('%FFbroken')value")
  ).toEqual([{ value: '%FFbroken' }]);
});
it('rejects viewer/cross-actor mutation and stale binding acknowledgements', async () => {
  const f = await fixture();
  await expect(f.context(VIEWER)).rejects.toThrow('PERMISSION_DENIED');
  const command = await f.command();
  await expect(handleCatalogRename('apply', command, VIEWER, f.deps)).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  await db.root('update public.team_product_catalogs set source_link=$1 where material_id=$2', [
    'https://offer.test/?sub=Original%20catalog',
    f.material
  ]);
  await expect(f.apply(command)).rejects.toThrow('SOURCE_CHANGED');
  expect(f.patch).not.toHaveBeenCalled();
});
it('commits one canonical operation, exhaustive old-name aliases/search and idempotent receipt', async () => {
  const f = await fixture('Original searchable catalog');
  const command = await f.command();
  const completed = await f.apply(command);
  expect(completed).toMatchObject({
    state: 'confirmed',
    currentName: command.newName,
    errorCode: null
  });
  expect(await f.apply(command)).toEqual(completed);
  expect(f.patch).toHaveBeenCalledOnce();
  expect(await f.aliases()).toEqual([{ name: 'Original searchable catalog' }]);
  const listed = await db.asUser<{ name: string; name_aliases: string[] }>(
    ACTOR,
    'select name,name_aliases from public.list_team_product_catalogs($1)where catalog_id=$2',
    [team, f.material]
  );
  expect(listed).toEqual([
    { name: command.newName, name_aliases: ['Original searchable catalog'] }
  ]);
  const search = (
    await db.asUser<{ value: { items: Array<{ id: string }> } }>(
      ACTOR,
      'select public.search_materials($1,$2) value',
      [team, 'Original searchable catalog']
    )
  )[0].value;
  expect(JSON.stringify(search)).toContain(f.material);
  await expect(f.apply({ ...command, newName: 'Another' })).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
});
it('reconciles a lost PATCH reply through readback with no second provider mutation', async () => {
  const f = await fixture();
  const command = await f.command();
  f.patch.mockImplementationOnce(async (_id, etag, newName) => {
    expect(etag).toBe('"v1"');
    f.state.name = newName;
    f.state.etag = '"v2"';
    f.state.version = '2';
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  });
  expect(await f.apply(command)).toMatchObject({
    state: 'confirmed',
    currentName: command.newName
  });
  expect(await f.status(command)).toMatchObject({ state: 'confirmed' });
  expect(f.patch).toHaveBeenCalledOnce();
});
it('keeps an unapplied uncertain PATCH pending, then worker safely replays the captured ETag after cooldown', async () => {
  const f = await fixture();
  const command = await f.command();
  f.patch.mockRejectedValueOnce(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  expect(await f.apply(command)).toMatchObject({ state: 'pending' });
  expect(await f.aliases()).toEqual([]);
  expect(await f.status(command)).toMatchObject({ state: 'pending' });
  expect(f.patch).toHaveBeenCalledOnce();
  await db.root(
    "update private.catalog_rename_requests set next_attempt_at=clock_timestamp()-interval '1 second'where request_key=$1",
    [command.requestKey]
  );
  await recoverCatalogRenames(f.deps);
  expect(await f.status(command)).toMatchObject({ state: 'confirmed' });
  expect(f.patch.mock.calls.map(call => call[1])).toEqual(['"v1"', '"v1"']);
});
it('resumes an admitted command after server/browser closure before any PATCH', async () => {
  const f = await fixture();
  const command = await f.command();
  expect(await f.accept(command)).toMatchObject({ state: 'pending' });
  expect(await f.status(command)).toMatchObject({ state: 'pending' });
  expect(f.patch).not.toHaveBeenCalled();
  await recoverCatalogRenames(f.deps);
  expect(await f.status(command)).toMatchObject({ state: 'confirmed' });
});
it('fences a never-admitted request before unlocking its outbox and refuses the delayed original POST', async () => {
  const f = await fixture();
  const command = await f.command();
  expect(await f.status(command)).toMatchObject({
    state: 'failed',
    operationId: null,
    errorCode: 'NOT_FOUND'
  });
  expect(await f.apply(command)).toMatchObject({
    state: 'failed',
    operationId: null,
    errorCode: 'NOT_FOUND'
  });
  expect(f.patch).not.toHaveBeenCalled();
  expect(
    await db.root('select id from private.catalog_rename_requests where request_key=$1', [
      command.requestKey
    ])
  ).toEqual([]);
});
it('never overwrites a concurrent provider rename and never records an unconfirmed alias', async () => {
  const f = await fixture();
  const command = await f.command();
  f.patch.mockImplementationOnce(async () => {
    f.state.name = 'Changed outside Soty';
    f.state.etag = '"outside"';
    f.state.version = '3';
    throw new TeamFunctionError('SOURCE_CHANGED');
  });
  expect(await f.apply(command)).toMatchObject({ state: 'failed', errorCode: 'SOURCE_CHANGED' });
  expect(f.state.name).toBe('Changed outside Soty');
  expect(await f.aliases()).toEqual([]);
});
it('denies stale actor permission before dispatch and keeps independent catalogs executable', async () => {
  const f = await fixture();
  const command = await f.command();
  await f.accept(command);
  await db.root(
    "update public.team_members set base_role='viewer'where team_id=$1 and user_id=$2",
    [team, ACTOR]
  );
  await recoverCatalogRenames(f.deps);
  expect(f.patch).not.toHaveBeenCalled();
  expect(await f.status(command)).toMatchObject({
    state: 'failed',
    errorCode: 'PERMISSION_DENIED'
  });
});
it('holds the same target against sibling mutations while rename authority is pending', async () => {
  const f = await fixture();
  const command = await f.command();
  await f.accept(command);
  await expect(
    db.root(
      "select*from public.service_start_team_operation($1,$2,'trash',$3,$3,$4,null,null,null,null)",
      [team, OWNER, 'other:' + crypto.randomUUID(), f.material]
    )
  ).rejects.toThrow('LAUNCH_BUSY');
  expect(f.patch).not.toHaveBeenCalled();
});

it('retains immutable historical names, generated URLs and SUB values while refreshing live projections', async () => {
  const f = await fixture('Bound catalog');
  const url = 'https://offer.test/?sub1=buyer-Bound%20catalog&manual=unchanged';
  const launch = (
    await db.asUser<{ value: { id: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,null,null,$2,$3::jsonb,null)value',
      [team, crypto.randomUUID(), JSON.stringify({ originalUrl: url })]
    )
  )[0].value.id;
  const revision = (
    await db.root<{ id: string }>(
      'insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,\'generated\',\'{"method":"catalog","subConfig":{"sub1":["buyer"]}}\',\'{}\',$3,$3,\'{"sub1":"buyer-Bound catalog"}\',$4)returning id',
      [team, launch, url, ACTOR]
    )
  )[0].id;
  const generation = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_generations(team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage)values($1,$2,$3,$4,$5,'digest','1','succeeded','completed')returning id",
      [team, launch, revision, ACTOR, crypto.randomUUID()]
    )
  )[0].id;
  await db.root(
    "insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)values($1,$2,$3,$3,1,'Bound catalog','https://docs.google.com/spreadsheets/d/sheet/edit','{}')",
    [team, revision, f.material]
  );
  const frozen = await db.root(
    'select to_jsonb(r)value from public.team_launch_revisions r where id=$1',
    [revision]
  );
  const historical = await db.root(
    'select to_jsonb(c)value from public.team_launch_revision_catalogs c where revision_id=$1',
    [revision]
  );
  expect(await f.context()).toMatchObject({ boundNames: ['Bound catalog'] });
  const command = await f.command('Current catalog');
  const signalBefore = (
    await db.root<{ updated_at: string }>(
      'select updated_at from public.team_launch_signals where launch_id=$1',
      [launch]
    )
  )[0].updated_at;
  expect(await f.apply(command)).toMatchObject({ state: 'confirmed' });
  expect(
    await db.root('select to_jsonb(r)value from public.team_launch_revisions r where id=$1', [
      revision
    ])
  ).toEqual(frozen);
  expect(
    await db.root(
      'select to_jsonb(c)value from public.team_launch_revision_catalogs c where revision_id=$1',
      [revision]
    )
  ).toEqual(historical);
  const projection = (
    await db.root<{ value: { catalog: unknown } }>(
      'select private.launch_revision_json($1,$2)value',
      [team, revision]
    )
  )[0].value;
  expect(projection.catalog).toMatchObject({
    name: 'Bound catalog',
    currentName: 'Current catalog',
    boundNames: ['Bound catalog']
  });
  expect(
    await db.root('select launch_id from public.team_launch_signals where launch_id=$1', [launch])
  ).toEqual([{ launch_id: launch }]);
  expect(
    (
      await db.root<{ updated_at: string }>(
        'select updated_at from public.team_launch_signals where launch_id=$1',
        [launch]
      )
    )[0].updated_at
  ).not.toEqual(signalBefore);
  await db.root("update public.team_launch_generations set state='running'where id=$1", [
    generation
  ]);
  await expect(f.context()).rejects.toThrow('LAUNCH_BUSY');
});
it('does not replay while Retry-After is active and exposes only safe diagnostic columns', async () => {
  const f = await fixture();
  const command = await f.command();
  f.patch.mockRejectedValueOnce(
    new TeamFunctionError('RATE_LIMITED', { details: { retryAfterMs: 3_600_000 } })
  );
  expect(await f.apply(command)).toMatchObject({ state: 'pending', errorCode: 'RATE_LIMITED' });
  const evidence = (
    await db.root<{ value: Record<string, unknown> }>(
      'select to_jsonb(v)value from public.analytics_catalog_renames v where request_key=$1',
      [command.requestKey]
    )
  )[0].value;
  expect(evidence).toMatchObject({
    dispatched: true,
    attempt_count: 1,
    state: 'pending',
    origin: 'provider_intent',
    error_code: 'RATE_LIMITED'
  });
  expect(
    Date.parse(String(evidence.next_attempt_at)) - Date.parse(String(evidence.updated_at))
  ).toBeGreaterThanOrEqual(3_599_000);
  expect(Object.keys(evidence).sort()).toEqual(
    [
      'request_key',
      'team_id',
      'actor_id',
      'material_id',
      'operation_id',
      'state',
      'error_code',
      'created_at',
      'updated_at',
      'confirmed_at',
      'dispatched',
      'attempt_count',
      'next_attempt_at',
      'origin'
    ].sort()
  );
  await db.root('set role authenticated');
  try {
    await expect(db.root('select*from public.analytics_catalog_renames')).rejects.toThrow(
      /permission denied/iu
    );
  } finally {
    await db.root('reset role');
  }
  expect(await f.apply(command)).toMatchObject({ state: 'pending', errorCode: 'RATE_LIMITED' });
  await recoverCatalogRenames(f.deps);
  expect(f.patch).toHaveBeenCalledOnce();
});
it('can cancel only a provably unissued rename and never reports an unknown provider write undone', async () => {
  const f = await fixture();
  const command = await f.command();
  const accepted = await f.accept(command);
  await db.asUser(ACTOR, 'select*from public.cancel_team_operation($1,$2)', [
    team,
    accepted.operationId
  ]);
  expect(await f.status(command)).toMatchObject({ state: 'failed', errorCode: 'PROCESS_CANCELED' });
  expect(f.patch).not.toHaveBeenCalled();
  const next = await f.command();
  f.patch.mockRejectedValueOnce(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  const unknown = await f.apply(next);
  await expect(
    db.asUser(ACTOR, 'select*from public.cancel_team_operation($1,$2)', [team, unknown.operationId])
  ).rejects.toThrow('WRONG_STATE');
  expect(await f.status(next)).toMatchObject({ state: 'pending' });
});
it('reconciles a provider success after permission returns without repeating its write', async () => {
  const f = await fixture();
  const command = await f.command();
  f.patch.mockImplementationOnce(async (_id, _etag, newName) => {
    f.state.name = newName;
    f.state.version = '2';
    f.state.etag = '"v2"';
    await db.root(
      "update public.team_members set base_role='viewer'where team_id=$1 and user_id=$2",
      [team, ACTOR]
    );
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  });
  expect(await f.apply(command)).toMatchObject({
    state: 'pending',
    errorCode: 'PERMISSION_DENIED'
  });
  expect(await f.aliases()).toEqual([]);
  await db.root(
    "update public.team_members set base_role='editor'where team_id=$1 and user_id=$2",
    [team, ACTOR]
  );
  await db.root(
    "update private.catalog_rename_requests set next_attempt_at=clock_timestamp()-interval '1 second'where request_key=$1",
    [command.requestKey]
  );
  expect(await f.status(command)).toMatchObject({ state: 'confirmed' });
  expect(f.patch).toHaveBeenCalledOnce();
});
it('fences an expired worker lease before dispatch and bounds the due-list lookup itself', async () => {
  const f = await fixture();
  const command = await f.command();
  const accepted = await f.accept(command);
  const oldOwner = crypto.randomUUID(),
    newOwner = crypto.randomUUID();
  const input = { p_team: team, p_material: f.material, p_actor: ACTOR, p_key: command.requestKey };
  await service.rpc('service_claim_catalog_rename', { ...input, p_owner: oldOwner });
  await db.root(
    "update private.catalog_rename_requests set lease_expires_at=clock_timestamp()-interval '1 second'where request_key=$1",
    [command.requestKey]
  );
  await service.rpc('service_claim_catalog_rename', { ...input, p_owner: newOwner });
  const denied = await service.rpc('service_prepare_catalog_rename', {
    p_operation: accepted.operationId,
    p_owner: oldOwner,
    p_etag: '"v1"',
    p_live_name: 'Original catalog',
    p_live_version: '1'
  });
  expect(denied.error?.message).toBe('WRONG_STATE');
  await expect(
    recoverCatalogRenames({ ...f.deps, service: { rpc: () => new Promise(() => {}) } }, 5)
  ).rejects.toThrow('DRIVE_UNAVAILABLE');
  expect(f.patch).not.toHaveBeenCalled();
});
it('fences later generation admission, resume and catalog attachment behind the pending rename', async () => {
  const f = await fixture();
  const launch = (
    await db.asUser<{ value: { id: string } }>(
      ACTOR,
      "select public.save_launch_draft($1,null,null,$2,'{}'::jsonb,null)value",
      [team, crypto.randomUUID()]
    )
  )[0].value.id;
  const baseline = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,'generated','{}','{}','https://offer.test','https://offer.test','{}',$3)returning id",
      [team, launch, ACTOR]
    )
  )[0].id;
  await db.root(
    "insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)values($1,$2,$3,$3,1,'Original catalog','https://docs.google.com/spreadsheets/d/sheet/edit','{}')",
    [team, baseline, f.material]
  );
  const revision = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,base_revision_id,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,2,'generated',$3,'{}','{}','https://offer.test','https://offer.test','{}',$4)returning id",
      [team, launch, baseline, ACTOR]
    )
  )[0].id;
  const command = await f.command();
  const accepted = await f.accept(command);
  const insert = (state: string) =>
    db.root<{ id: string }>(
      "insert into public.team_launch_generations(team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage)values($1,$2,$3,$4,$5,'digest','1',$6,'accepted')returning id",
      [team, launch, revision, ACTOR, crypto.randomUUID(), state]
    );
  await expect(insert('accepted')).rejects.toThrow('LAUNCH_BUSY');
  const generation = (await insert('canceled'))[0].id;
  await expect(
    db.root("update public.team_launch_generations set state='running'where id=$1", [generation])
  ).rejects.toThrow('LAUNCH_BUSY');
  await expect(
    db.root(
      "insert into public.team_launch_revision_catalogs(team_id,revision_id,catalog_id,material_id,variant,name_snapshot,sheet_url,settings_snapshot)values($1,$2,$3,$3,1,'Original catalog','https://docs.google.com/spreadsheets/d/sheet/edit','{}')",
      [team, revision, f.material]
    )
  ).rejects.toThrow('LAUNCH_BUSY');
  await db.asUser(ACTOR, 'select*from public.cancel_team_operation($1,$2)', [
    team,
    accepted.operationId
  ]);
  await expect(
    db.root("update public.team_launch_generations set state='running'where id=$1", [generation])
  ).resolves.toEqual([]);
  expect(f.patch).not.toHaveBeenCalled();
});
it('fences a late material/name binding into a catalog intent while rename is unresolved', async () => {
  const f = await fixture();
  const intent = (
    await db.root<{ id: string }>(
      "insert into private.catalog_generation_intents(team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant)values($1,$2,$3,$4,'digest','{}',1)returning id",
      [team, f.video, ACTOR, 'launch:' + crypto.randomUUID() + ':catalog']
    )
  )[0].id;
  const command = await f.command();
  await f.accept(command);
  await expect(
    db.root(
      "update private.catalog_generation_intents set checkpoint=jsonb_build_object('materialId',$2::text,'launchSubBinding',jsonb_build_object('name','Original catalog'))where id=$1",
      [intent, f.material]
    )
  ).rejects.toThrow('LAUNCH_BUSY');
  expect(
    await db.root('select checkpoint from private.catalog_generation_intents where id=$1', [intent])
  ).toEqual([{ checkpoint: {} }]);
});
