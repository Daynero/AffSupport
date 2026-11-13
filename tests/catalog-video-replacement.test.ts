import {
  recoverCatalogVideoReplacement,
  type CatalogVideoReplacementDeps
} from '../supabase/functions/drive-ops/catalog-video-replacement';
import {
  applyPublicationCells,
  type FrozenPublicationCells
} from '../supabase/functions/catalog-updater/publication-cells';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { handleCatalogVideoReplacement } from '../supabase/functions/drive-ops/catalog-video-replacement';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import {
  parseCatalogVideoReplacementContext,
  parseCatalogVideoReplacementReceipt,
  parseCatalogVideoReplacementRequest
} from '../packages/shared/src/team/catalog-video-replacement';
let db: TeamTestDb, team: string, connection: string;
const owner = randomUUID(),
  viewer = randomUUID();
const service: ServiceRpcClient = {
  rpc: async (name, args) => {
    if (
      !/^service_(catalog_video_replacement|accept_catalog_video_replacement|claim_catalog_video_replacement|prepare_catalog_video_move|finish_catalog_video_replacement|defer_catalog_video_replacement|due_catalog_video_replacements)/u.test(
        name
      )
    )
      throw Error('Unexpected RPC');
    const keys = Object.keys(args);
    try {
      return {
        data: (
          await db.root<{ v: unknown }>(
            `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')})v`,
            keys.map(k => args[k])
          )
        )[0]!.v,
        error: null
      };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }
};
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'owner@replacement.test' });
  await createUser(db, { id: viewer, email: 'viewer@replacement.test' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Replacement')")
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role)values($1,$2,'viewer')",
    [team, viewer]
  );
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)values('replacement','owner@replacement.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1)returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)values($1,$2,'root','Root','my_drive','connected',now())returning id",
      [team, credential]
    )
  )[0]!.id;
}, 60000);
afterAll(async () => db?.close());
async function fixture(target?: { teamId: string; connectionId: string }) {
  const fixtureTeam = target?.teamId ?? team,
    fixtureConnection = target?.connectionId ?? connection;
  const suffix = randomUUID();
  const insert = async (name: string, parent: string, category: string, mime: string) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,drive_version,checksum,size_bytes)values($1,$2,$3,$4,$5,'file',$6,$7,'1',$8,512)returning id",
        [
          fixtureTeam,
          fixtureConnection,
          name + '-' + suffix,
          parent,
          name,
          category,
          mime,
          'a'.repeat(32)
        ]
      )
    )[0]!.id;
  const old = await insert('old', 'root', 'video', 'video/mp4');
  const video = await insert('new', 'destination', 'video', 'video/mp4');
  const catalog = await insert(
    'catalog',
    'root',
    'other',
    'application/vnd.google-apps.spreadsheet'
  );
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4::jsonb)', [
    fixtureTeam,
    old,
    catalog,
    JSON.stringify({
      sourceLink: 'https://offer.test/?sub=keep',
      productCount: 2,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' + catalog + '/edit',
      videoLink: 'https://drive.google.com/file/d/old/view',
      settingsSnapshot: {
        title: 'Product',
        description: 'Description',
        price: 10,
        imageLink: 'https://image.test/image'
      },
      createdBy: owner
    })
  ]);
  await db.root(
    "select public.service_save_catalog_publication($1,$2,$3,$4,0,'immediate',null,null,jsonb_build_object('kind','source','materialId',$5::text,'sourceVersion',private.catalog_publication_source_version($5::uuid,$1::uuid)))",
    [fixtureTeam, owner, randomUUID(), catalog, old]
  );
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',provider_revision='1',verified_at=now()where catalog_material_id=$1",
    [catalog]
  );
  await db.root(
    "insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at)select catalog_material_id,team_id,target_id,'1',now()from private.catalog_video_publication_policies where catalog_material_id=$1",
    [catalog]
  );
  await db.root(
    'insert into public.team_catalog_updaters(team_id)values($1)on conflict do nothing',
    [fixtureTeam]
  );
  await db.root(
    'insert into public.team_catalog_updater_items(catalog_material_id,team_id)values($1,$2)',
    [catalog, fixtureTeam]
  );
  const scope = { teamId: fixtureTeam, catalogId: catalog, expectedActorId: owner };
  const context = parseCatalogVideoReplacementContext(
    await handleCatalogVideoReplacement(service, owner, 'context', scope)
  );
  expect(context).not.toBeNull();
  const request = {
    ...scope,
    requestId: randomUUID(),
    newVideoId: video,
    expectedVersion: context!.version,
    moveToVideoFolder: true
  };
  const accept = () => handleCatalogVideoReplacement(service, owner, 'submit', request);
  return { catalog, video, old, request, accept, scope };
}
it('admits once, retains the old binding until verification, and preserves the catalog data', async () => {
  const f = await fixture();
  const before = (
    await db.root(
      'select source_link,product_count,sheet_url,settings_snapshot,update_count,variant from public.team_product_catalogs where material_id=$1',
      [f.catalog]
    )
  )[0];
  const receipt = parseCatalogVideoReplacementReceipt(await f.accept());
  expect(receipt?.state).toBe('publishing');
  expect(await f.accept()).toEqual(receipt);
  const row = (
    await db.root<{ video_material_id: string }>(
      'select video_material_id from public.team_product_catalogs where material_id=$1',
      [f.catalog]
    )
  )[0]!;
  expect(row.video_material_id).toBe(f.old);
  const worker = randomUUID();
  expect(
    (
      await service.rpc('service_claim_catalog_video_replacement', {
        p_request: f.request.requestId,
        p_worker: worker
      })
    ).data
  ).toBeNull();
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',provider_revision='2',verified_at=now()where command_id=$1",
    [f.request.requestId]
  );
  await db.root(
    "insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url)select publication_job_id,source_material_id,source_version,'https://drive.google.com/file/d/new/view'from private.catalog_video_replacements where request_id=$1",
    [f.request.requestId]
  );
  await db.root(
    'update private.catalog_video_replacements set next_check_at=now()where request_id=$1',
    [f.request.requestId]
  );
  const claim = await service.rpc('service_claim_catalog_video_replacement', {
    p_request: f.request.requestId,
    p_worker: worker
  });
  expect(claim.error).toBeNull();
  expect(claim.data).not.toBeNull();
  const file = (
    await db.root<{ drive_file_id: string }>(
      'select drive_file_id from public.team_materials where id=$1',
      [f.catalog]
    )
  )[0]!.drive_file_id;
  const done = await service.rpc('service_finish_catalog_video_replacement', {
    p_request: f.request.requestId,
    p_worker: worker,
    p_observed: { id: file, name: 'catalog', parentId: 'destination', version: '3' }
  });
  expect(done.error).toBeNull();
  expect(parseCatalogVideoReplacementReceipt(done.data)?.state).toBe('confirmed');
  expect(
    (
      await db.root(
        'select source_link,product_count,sheet_url,settings_snapshot,update_count,variant from public.team_product_catalogs where material_id=$1',
        [f.catalog]
      )
    )[0]
  ).toEqual(before);
  expect(
    (
      await db.root(
        'select video_material_id from public.team_product_catalogs where material_id=$1',
        [f.catalog]
      )
    )[0]
  ).toEqual({ video_material_id: f.video });
  expect(
    (
      await db.root('select companion_of,parent_folder_id from public.team_materials where id=$1', [
        f.catalog
      ])
    )[0]
  ).toEqual({ companion_of: f.video, parent_folder_id: 'destination' });
  expect((await db.root('select private.task_cleanup_coverage_verified()ok'))[0]).toEqual({
    ok: true
  });
});
it('refuses a viewer, mismatched actor, stale source and request-key reuse', async () => {
  const f = await fixture();
  await expect(
    handleCatalogVideoReplacement(service, viewer, 'submit', {
      ...f.request,
      expectedActorId: viewer
    })
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(handleCatalogVideoReplacement(service, viewer, 'submit', f.request)).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  await expect(
    handleCatalogVideoReplacement(service, owner, 'submit', {
      ...f.request,
      expectedVersion: 'stale'
    })
  ).rejects.toThrow('STALE_RESULT');
  await f.accept();
  await expect(
    handleCatalogVideoReplacement(service, owner, 'submit', {
      ...f.request,
      moveToVideoFolder: false
    })
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
it('fences profile edits, new publications, source moves and updater claims while pending', async () => {
  const f = await fixture();
  await f.accept();
  await expect(
    db.root(
      'update public.team_catalog_update_profiles set restitch=true where catalog_material_id=$1',
      [f.catalog]
    )
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  await expect(
    db.root(
      'update public.team_catalog_updater_items set reconciliation_required=false where catalog_material_id=$1',
      [f.catalog]
    )
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  await expect(
    db.root(
      'update public.team_catalog_updater_items set round_due_at=now() where catalog_material_id=$1',
      [f.catalog]
    )
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  await expect(
    db.root('update public.team_product_catalogs set product_count=3 where material_id=$1', [
      f.catalog
    ])
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  await expect(
    db.root("update public.team_materials set parent_folder_id='elsewhere'where id=$1", [f.video])
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  await expect(
    db.root(
      'update private.catalog_video_publication_policies set revision=revision+1 where catalog_material_id=$1',
      [f.catalog]
    )
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
  const other = { ...f.request, requestId: randomUUID() };
  await expect(handleCatalogVideoReplacement(service, owner, 'submit', other)).rejects.toThrow(
    'CATALOG_PUBLICATION_PENDING'
  );
});

async function providerFixture(move = true) {
  const f = await fixture();
  f.request.moveToVideoFolder = move;
  await f.accept();
  const r = (
    await db.root<{ publication_job_id: string; catalog_file_id: string; source_version: string }>(
      'select publication_job_id,catalog_file_id,source_version from private.catalog_video_replacements where request_id=$1',
      [f.request.requestId]
    )
  )[0]!;
  const source = (
    await db.root<{ drive_file_id: string }>(
      'select drive_file_id from public.team_materials where id=$1',
      [f.video]
    )
  )[0]!.drive_file_id;
  const url = 'https://drive.google.com/file/d/' + source + '/view';
  const frozen: FrozenPublicationCells = {
    fileId: r.catalog_file_id,
    rootFolderId: 'root',
    sheetName: 'catalog_products',
    sheetId: 0,
    idColumn: 0,
    videoColumn: 25,
    idHeaders: ['IDs', 'id'],
    videoHeaders: ['Video', 'video[0].url'],
    products: [
      { id: 'id-1', url },
      { id: 'id-2', url }
    ],
    markerKey: 'soty_video_publication',
    markerValue: r.publication_job_id
  };
  await db.root(
    'insert into private.catalog_publication_cell_writes(job_id,team_id,catalog_material_id,target_id,connection_id,file_id,payload)select id,team_id,catalog_material_id,target_id,$2,$3,$4::jsonb from private.catalog_video_publication_jobs where id=$1',
    [r.publication_job_id, connection, r.catalog_file_id, JSON.stringify(frozen)]
  );
  await db.root(
    'insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url)values($1,$2,$3,$4)',
    [r.publication_job_id, f.video, r.source_version, url]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',provider_revision='2',verified_at=now()where id=$1",
    [r.publication_job_id]
  );
  const metadata = (
    id: string,
    name: string,
    mimeType: string,
    parents: string[]
  ): DriveFileMetadata => ({
    id,
    name,
    mimeType,
    parents,
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    size: 512,
    modifiedAt: null,
    version: '2',
    checksum: 'a'.repeat(32),
    capabilities: {
      canDownload: true,
      canListChildren: true,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canTrash: true,
      canUntrash: true
    },
    appProperties: {}
  });
  const catalog = metadata(
    r.catalog_file_id,
    'catalog',
    'application/vnd.google-apps.spreadsheet',
    ['root']
  );
  const files = new Map([
    ['root', metadata('root', 'Root', 'application/vnd.google-apps.folder', [])],
    [
      'destination',
      metadata('destination', 'Destination', 'application/vnd.google-apps.folder', ['root'])
    ],
    [source, metadata(source, 'new', 'video/mp4', ['destination'])],
    [catalog.id, catalog]
  ]);
  const markers: string[] = [];
  const columns = new Map<number, string[]>([
    [0, ['IDs', 'id', 'id-1', 'id-2']],
    [25, ['Video', 'video[0].url', 'old-video', 'old-video']],
    [3, ['untouched', 'header', 'manual value', 'other value']]
  ]);
  type Drive = Awaited<ReturnType<CatalogVideoReplacementDeps['driveFor']>>;
  const drive: Drive = {
    getFile: vi.fn(async id => {
      const file = files.get(id);
      if (!file) throw Error('Missing fixture');
      return { ...file, parents: [...file.parents] };
    }),
    getNativeSpreadsheetSheets: vi.fn(async () => [
      { sheetId: 0, title: 'catalog_products', rowCount: 4, columnCount: 64 }
    ]),
    readNativeCatalogColumns: vi.fn(
      async (input: Parameters<Drive['readNativeCatalogColumns']>[0]) =>
        input.columns.map(c => [...(columns.get(c) ?? [])])
    ),
    readNativeSpreadsheetMarkers: vi.fn(async () => [...markers]),
    writeNativeSpreadsheetCells: vi.fn(async input => {
      for (const u of input.updates) {
        const values = columns.get(u.columnIndex)!;
        values.splice(u.rowIndex, u.values.length, ...u.values);
      }
      markers.splice(0, markers.length, input.marker.value);
    }),
    getCatalogRenameFile: vi.fn(async () => ({
      id: catalog.id,
      name: catalog.name,
      parents: [...catalog.parents],
      trashed: false,
      canRename: true,
      etag: '"before-move"'
    })),
    moveCatalogConditionally: vi.fn(async () => {
      catalog.parents = ['destination'];
      catalog.version = '3';
    })
  };
  // Real targeted cell writer, against a provider fixture: only the video column changes.
  const untouched = JSON.stringify(columns.get(3));
  await applyPublicationCells(drive, frozen);
  expect(JSON.stringify(columns.get(3))).toBe(untouched);
  expect(columns.get(0)).toEqual(['IDs', 'id', 'id-1', 'id-2']);
  const deps: CatalogVideoReplacementDeps = { service, driveFor: async () => drive };
  const recover = async () => {
    await db.root(
      'update private.catalog_video_replacements set next_check_at=now()where request_id=$1',
      [f.request.requestId]
    );
    await recoverCatalogVideoReplacement(deps, f.request.requestId);
  };
  return { ...f, drive, catalog, recover, files, columns, source };
}
it.each([true, false])(
  'places only the catalog after verified video cells (move=%s)',
  async move => {
    const f = await providerFixture(move);
    await f.recover();
    const result = await handleCatalogVideoReplacement(service, owner, 'status', {
      ...f.scope,
      requestId: f.request.requestId
    });
    expect(parseCatalogVideoReplacementReceipt(result)?.state).toBe('confirmed');
    expect(f.drive.moveCatalogConditionally).toHaveBeenCalledTimes(move ? 1 : 0);
    expect(
      (
        await db.root('select parent_folder_id from public.team_materials where id=$1', [
          f.request.catalogId
        ])
      )[0]
    ).toEqual({ parent_folder_id: move ? 'destination' : 'root' });
  }
);
it('reconciles a lost move reply without dispatching the move twice', async () => {
  const f = await providerFixture();
  vi.mocked(f.drive.moveCatalogConditionally).mockImplementationOnce(async () => {
    f.catalog.parents = ['destination'];
    f.catalog.version = '3';
    throw Error('reply-lost');
  });
  await f.recover();
  expect(
    (
      await db.root(
        'select video_material_id from public.team_product_catalogs where material_id=$1',
        [f.request.catalogId]
      )
    )[0]
  ).toEqual({ video_material_id: f.old });
  await f.recover();
  expect(f.drive.moveCatalogConditionally).toHaveBeenCalledTimes(1);
  expect(
    (
      await db.root('select state from private.catalog_video_replacements where request_id=$1', [
        f.request.requestId
      ])
    )[0]
  ).toEqual({ state: 'confirmed' });
});
it('retains the old binding and writer fence when published video cells were changed externally', async () => {
  const f = await providerFixture();
  f.columns.get(25)![2] = 'external-video';
  await f.recover();
  expect(f.drive.moveCatalogConditionally).not.toHaveBeenCalled();
  expect(
    (
      await db.root(
        'select video_material_id from public.team_product_catalogs where material_id=$1',
        [f.request.catalogId]
      )
    )[0]
  ).toEqual({ video_material_id: f.old });
  expect(
    (
      await db.root(
        'select state,error_code from private.catalog_video_replacements where request_id=$1',
        [f.request.requestId]
      )
    )[0]
  ).toEqual({ state: 'moving', error_code: 'PROCESS_RESULT_UNCERTAIN' });
  await expect(
    db.root(
      'update public.team_catalog_updater_items set reconciliation_required=false where catalog_material_id=$1',
      [f.request.catalogId]
    )
  ).rejects.toThrow('CATALOG_PUBLICATION_PENDING');
});
it('rechecks source content after moving and never commits a changed source', async () => {
  const f = await providerFixture();
  vi.mocked(f.drive.moveCatalogConditionally).mockImplementationOnce(async () => {
    f.catalog.parents = ['destination'];
    f.catalog.version = '3';
    f.files.get(f.source)!.checksum = 'b'.repeat(32);
  });
  await f.recover();
  expect(
    (
      await db.root(
        'select video_material_id from public.team_product_catalogs where material_id=$1',
        [f.request.catalogId]
      )
    )[0]
  ).toEqual({ video_material_id: f.old });
  expect(
    (
      await db.root(
        'select error_code from private.catalog_video_replacements where request_id=$1',
        [f.request.requestId]
      )
    )[0]
  ).toEqual({ error_code: 'SOURCE_CHANGED' });
  await f.recover();
  expect(f.drive.moveCatalogConditionally).toHaveBeenCalledTimes(1);
});
it('preserves a manual row-ID change as SOURCE_CHANGED rather than a generic unknown', async () => {
  const f = await providerFixture();
  f.columns.get(0)![2] = 'manually-replaced-product-id';
  await f.recover();
  expect(f.drive.moveCatalogConditionally).not.toHaveBeenCalled();
  expect(
    (
      await db.root(
        'select state,error_code from private.catalog_video_replacements where request_id=$1',
        [f.request.requestId]
      )
    )[0]
  ).toEqual({ state: 'moving', error_code: 'SOURCE_CHANGED' });
});
it('normalizes command payloads and rejects a conflicting active catalog scope', async () => {
  const f = await fixture();
  expect(parseCatalogVideoReplacementRequest({ ...f.request, secret: 'excluded' })).toEqual(
    f.request
  );
  const c = parseCatalogVideoReplacementContext(
    await handleCatalogVideoReplacement(service, owner, 'context', f.scope)
  )!;
  expect(
    parseCatalogVideoReplacementContext({
      ...c,
      active: {
        teamId: team,
        catalogId: randomUUID(),
        requestId: randomUUID(),
        newVideoId: f.video,
        state: 'publishing',
        errorCode: null
      }
    })
  ).toBeNull();
});
it('timestamps move dispatch and blocked recovery so as-of diagnosis cannot backdate them', async () => {
  const f = await providerFixture();
  const worker = randomUUID();
  await service.rpc('service_claim_catalog_video_replacement', {
    p_request: f.request.requestId,
    p_worker: worker
  });
  await db.root(
    "update private.catalog_video_replacements set updated_at='2000-01-01' where request_id=$1",
    [f.request.requestId]
  );
  const prepared = await service.rpc('service_prepare_catalog_video_move', {
    p_request: f.request.requestId,
    p_worker: worker,
    p_etag: '"move-etag"'
  });
  expect(prepared.error).toBeNull();
  const time = async () =>
    (
      await db.root<{ fresh: boolean }>(
        "select updated_at>'2000-01-02'::timestamptz fresh from private.catalog_video_replacements where request_id=$1",
        [f.request.requestId]
      )
    )[0]!.fresh;
  expect(await time()).toBe(true);
  await db.root(
    "update private.catalog_video_replacements set updated_at='2000-01-01',lease_until=null,next_check_at=now(),source_version='stale' where request_id=$1",
    [f.request.requestId]
  );
  const claim = await service.rpc('service_claim_catalog_video_replacement', {
    p_request: f.request.requestId,
    p_worker: randomUUID()
  });
  expect(claim).toEqual({ data: null, error: null });
  expect(await time()).toBe(true);
  expect(
    (
      await db.root(
        'select state,error_code from private.catalog_video_replacements where request_id=$1',
        [f.request.requestId]
      )
    )[0]
  ).toEqual({ state: 'blocked', error_code: 'SOURCE_CHANGED' });
});
it('seals a provably absent command before a late submission can arrive', async () => {
  const f = await fixture();
  expect(
    await handleCatalogVideoReplacement(service, owner, 'status', {
      ...f.scope,
      requestId: f.request.requestId
    })
  ).toBeNull();
  await expect(f.accept()).rejects.toThrow('NOT_FOUND');
});

it('rejects absent-command receipts for a foreign workspace catalog and an unrelated file', async () => {
  const own = await fixture();
  const otherTeam = (
    await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Other replacement workspace')"
    )
  )[0]!.id;
  const otherConnection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)select $1,credential_id,$2,'Other root','my_drive','connected',now()from public.team_drive_connections where id=$3 returning id",
      [otherTeam, randomUUID(), connection]
    )
  )[0]!.id;
  const foreign = await fixture({ teamId: otherTeam, connectionId: otherConnection });
  for (const catalogId of [foreign.catalog, own.video]) {
    const requestId = randomUUID();
    await expect(
      handleCatalogVideoReplacement(service, viewer, 'status', {
        teamId: team,
        catalogId,
        expectedActorId: viewer,
        requestId
      })
    ).rejects.toThrow('NOT_FOUND');
    expect(
      await db.root(
        'select request_id from private.catalog_video_replacement_absences where request_id=$1',
        [requestId]
      )
    ).toEqual([]);
  }
});
