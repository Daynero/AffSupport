import { getCatalogVideoSetEvidence } from '../scripts/analytics/catalog-video-sets';
import { readFileSync } from 'node:fs';
import { getCatalogGenerationEvidence } from '../scripts/analytics/catalog-generations';
import { resolvePeriod } from '../scripts/analytics/periods';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { getCatalogPublicationEvidence } from '../scripts/analytics/catalog-publications';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { parseCatalogPublicationSnapshot } from '../packages/shared/src/team/catalog-publication-api';
let db: TeamTestDb, team: string, connection: string;
let seq = 0;
let deferredCatalogForDiagnostic:
  { catalogId: string; setId: string; intentId: string; generationId: string } | undefined;
const owner = '77000000-0000-4000-8000-000000000001',
  worker = '77000000-0000-4000-8000-000000000002';
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261207169000_catalog_publication_jobs.sql' });
  await createUser(db, { id: owner, email: 'publication-owner@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Publication')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('publication','publication@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
}, 180000);
afterAll(async () => {
  await db?.close();
});
async function fixture() {
  const n = ++seq;
  const material = async (video: boolean) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file',$4,$5,'v1') returning id",
        [
          team,
          connection,
          (video ? 'video' : 'catalog') + n,
          video ? 'video' : 'other',
          video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
        ]
      )
    )[0]!.id;
  const source = await material(true),
    catalog = await material(false);
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot) values($1,$2,$3,'https://offer.example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  const initial = (
    await db.root<{ value: { target: { sourceVersion: string } } }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, catalog]
    )
  )[0]!.value;
  return {
    catalog,
    source,
    target: { kind: 'source', materialId: source, sourceVersion: initial.target.sourceVersion }
  };
}
async function save(
  f: Awaited<ReturnType<typeof fixture>>,
  revision = 0,
  mode = 'held',
  request = crypto.randomUUID(),
  due: string | null = null,
  zone: string | null = null
) {
  return (
    await db.root<{ value: unknown }>(
      'select public.service_save_catalog_publication($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) value',
      [team, owner, request, f.catalog, revision, mode, due, zone, JSON.stringify(f.target)]
    )
  )[0]!.value;
}
it('stores held policy without fabricating active delivery and returns a strictly parsed snapshot', async () => {
  const f = await fixture();
  const receipt = await save(f);
  expect(parseCatalogPublicationSnapshot(receipt)).toMatchObject({
    catalogId: f.catalog,
    mode: 'held',
    revision: 1,
    active: null,
    job: { state: 'held' }
  });
});
it('replays only the original request receipt and refuses changed payload or stale revision', async () => {
  const f = await fixture(),
    request = crypto.randomUUID();
  const first = await save(f, 0, 'held', request);
  expect(await save(f, 0, 'held', request)).toEqual(first);
  await expect(save(f, 0, 'immediate', request)).rejects.toThrow('INVALID_INPUT');
  await expect(save(f, 0)).rejects.toThrow('WRONG_STATE');
  const missing = (
    await db.root<{ value: unknown }>(
      'select public.service_read_catalog_publication_command($1,$2,$3,$4) value',
      [team, owner, crypto.randomUUID(), f.catalog]
    )
  )[0]!.value;
  expect(missing).toBeNull();
});
it('claims no held/future work and keeps authenticated users away from service authority', async () => {
  const f = await fixture();
  await save(f);
  const claim = (
    await db.root<{ value: { items: unknown[] } }>(
      'select public.service_claim_catalog_publication_jobs($1,3) value',
      [worker]
    )
  )[0]!.value;
  expect(claim.items).toHaveLength(0);
  const future = await fixture();
  await save(future, 0, 'scheduled', crypto.randomUUID(), '2099-01-01T00:00:00Z', 'UTC');
  expect(
    (
      await db.root<{ value: { items: unknown[] } }>(
        'select public.service_claim_catalog_publication_jobs($1,3) value',
        [worker]
      )
    )[0]!.value.items
  ).toHaveLength(0);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamptz,text,jsonb)','execute') allowed"
      )
    )[0]!.allowed
  ).toBe(false);
});
it('fences dispatch, preserves active on unknown, and swaps only verified original settlement', async () => {
  const f = await fixture();
  await save(f, 0, 'immediate');
  // Simulate the canonical fresh-empty registration proof; no public/client flag can grant it.
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [f.catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where catalog_material_id=$1",
    [f.catalog]
  );
  const claim = (
    await db.root<{ value: { items: Array<{ jobId: string }> } }>(
      'select public.service_claim_catalog_publication_jobs($1,3) value',
      [worker]
    )
  )[0]!.value;
  const job = claim.items.find(() => true)!.jobId;
  const fence = (
    await db.root<{ value: string }>(
      'select public.service_reserve_catalog_publication($1,$2) value',
      [job, worker]
    )
  )[0]!.value;
  expect(
    (
      await db.root<{ value: boolean }>(
        'select public.service_dispatch_catalog_publication($1,$2,$3) value',
        [job, worker, fence]
      )
    )[0]!.value
  ).toBe(true);
  expect(
    (
      await db.root<{ value: boolean }>(
        'select public.service_dispatch_catalog_publication($1,$2,$3) value',
        [job, worker, fence]
      )
    )[0]!.value
  ).toBe(false);
  await expect(save(f, 1, 'held')).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await db.root("select public.service_settle_catalog_publication($1,$2,$3,'unknown',null)", [
    job,
    worker,
    fence
  ]);
  expect(
    (
      await db.root<{ value: { active: unknown } }>(
        'select public.service_read_catalog_publication($1,$2,$3) value',
        [team, owner, f.catalog]
      )
    )[0]!.value.active
  ).toBeNull();
  await expect(
    db.root("select public.service_settle_catalog_publication($1,$2,$3,'verified','v2')", [
      job,
      worker,
      crypto.randomUUID()
    ])
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await db.root("select public.service_settle_catalog_publication($1,$2,$3,'verified','v2')", [
    job,
    worker,
    fence
  ]);
  const result = (
    await db.root<{ value: unknown }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, f.catalog]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(result)).toMatchObject({
    mode: 'immediate',
    job: { state: 'published' },
    active: { target: f.target, providerRevision: 'v2' }
  });
});

it('does not promise a scheduled legacy replacement before existing links are verified', async () => {
  const f = await fixture();
  expect(
    parseCatalogPublicationSnapshot(
      await save(f, 0, 'scheduled', crypto.randomUUID(), '2099-01-01T00:00:00Z', 'UTC')
    )
  ).toMatchObject({
    active: null,
    job: { state: 'blocked', blockedReason: 'legacy_adoption_required' }
  });
});

it('keeps publication and baseline fences invisible to legacy reconciliation/finish', async () => {
  const f = await fixture();
  await save(f);
  const check = crypto.randomUUID();
  const ctx = (
    await db.root<{ value: { fence: string } }>(
      'select public.service_begin_catalog_baseline_check($1,$2,$3,$4,1) value',
      [check, team, owner, f.catalog]
    )
  )[0]!.value;
  expect(
    (
      await db.root<{ value: boolean }>(
        'select public.service_finish_catalog_update_write($1) value',
        [f.catalog]
      )
    )[0]!.value
  ).toBe(false);
  expect(
    (
      await db.root<{ value: boolean }>(
        "select public.service_resolve_catalog_reconciliation($1,$2,'delivered','legacy') value",
        [f.catalog, ctx.fence]
      )
    )[0]!.value
  ).toBe(false);
  expect(
    (
      await db.root<{ value: number }>(
        'select count(*)::integer value from private.catalog_update_reconciliations where catalog_material_id=$1 and marker=$2',
        [f.catalog, ctx.fence]
      )
    )[0]!.value
  ).toBe(1);
  await db.root('select public.service_abort_catalog_baseline_check($1,$2,$3,$4)', [
    check,
    team,
    owner,
    ctx.fence
  ]);
  await expect(
    db.root('select public.service_read_catalog_baseline_check($1,$2,$3,$4)', [
      check,
      team,
      owner,
      f.catalog
    ])
  ).rejects.toThrow('WRONG_STATE');
});
it('adopts only a service-verified original source and releases the exact baseline reservation', async () => {
  const f = await fixture();
  await save(f, 0, 'scheduled', crypto.randomUUID(), '2099-01-01T00:00:00Z', 'UTC');
  const check = crypto.randomUUID();
  const ctx = (
    await db.root<{ value: { fence: string } }>(
      'select public.service_begin_catalog_baseline_check($1,$2,$3,$4,1) value',
      [check, team, owner, f.catalog]
    )
  )[0]!.value;
  await expect(
    db.root("select public.service_finish_catalog_baseline_check($1,$2,$3,$4,'source','v2',$5)", [
      check,
      team,
      owner,
      crypto.randomUUID(),
      'a'.repeat(64)
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  const adopted = (
    await db.root<{ value: unknown }>(
      "select public.service_finish_catalog_baseline_check($1,$2,$3,$4,'source','v2',$5) value",
      [check, team, owner, ctx.fence, 'a'.repeat(64)]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(adopted)).toMatchObject({
    mode: 'scheduled',
    job: { state: 'waiting' },
    active: { target: f.target, providerRevision: 'v2' }
  });
  const replay = (
    await db.root<{ value: { receipt: unknown } }>(
      'select public.service_begin_catalog_baseline_check($1,$2,$3,$4,1) value',
      [check, team, owner, f.catalog]
    )
  )[0]!.value;
  expect(replay.receipt).toEqual(adopted);
  expect(
    (
      await db.root<{ value: number }>(
        'select count(*)::integer value from private.catalog_update_reconciliations where catalog_material_id=$1',
        [f.catalog]
      )
    )[0]!.value
  ).toBe(0);
});
it('verifies an initial blank without inventing an active target', async () => {
  const f = await fixture();
  await save(f, 0, 'scheduled', crypto.randomUUID(), '2099-01-01T00:00:00Z', 'UTC');
  const check = crypto.randomUUID();
  const ctx = (
    await db.root<{ value: { fence: string } }>(
      'select public.service_begin_catalog_baseline_check($1,$2,$3,$4,1) value',
      [check, team, owner, f.catalog]
    )
  )[0]!.value;
  const blank = (
    await db.root<{ value: unknown }>(
      "select public.service_finish_catalog_baseline_check($1,$2,$3,$4,'blank','v2',$5) value",
      [check, team, owner, ctx.fence, 'b'.repeat(64)]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(blank)).toMatchObject({
    active: null,
    job: { state: 'waiting' }
  });
});

it('exposes privacy-safe real SQL projection under SELECT-only diagnosis with microsecond as-of fences', async () => {
  const f = await fixture();
  await save(f, 0, 'immediate');
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [f.catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',blocked_reason=null,provider_revision='v2',created_at='2019-12-31T00:00:00Z',verified_at='2020-01-01T00:00:00.000001Z' where catalog_material_id=$1",
    [f.catalog]
  );
  await db.root('create role publication_diagnostic_reader');
  await db.root('grant wishly_analytics_ro to publication_diagnostic_reader');
  await db.root('grant usage on schema public to publication_diagnostic_reader');
  await db.root(
    'grant select on public.analytics_catalog_video_publications,public.analytics_catalog_video_baselines to publication_diagnostic_reader'
  );
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role publication_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const evidence = await getCatalogPublicationEvidence({
      id: f.catalog,
      asOf: '2020-01-01T00:00:00.000000Z'
    });
    expect(evidence.status).toBe('observed');
    expect(evidence.records[0]).toMatchObject({
      provider_delivery: 'not_observed',
      verified_within_cutoff: false
    });
    expect(JSON.stringify(evidence)).not.toContain('https://');
    expect(evidence.missing_sources).toEqual([{ source: 'preparation', reason: 'schema_missing' }]);
  } finally {
    setQueryExecutor(null);
  }
});

it('matches SQL and TS canonical identity for content/strict modes and metadata sharing bumps', async () => {
  const f = await fixture();
  const source = (
    await db.root<{ connection_id: string; drive_file_id: string }>(
      'select connection_id,drive_file_id from public.team_materials where id=$1',
      [f.source]
    )
  )[0]!;
  const strict = await catalogPublicationSourceIdentity({
    materialId: f.source,
    connectionId: source.connection_id,
    fileId: source.drive_file_id,
    checksum: null,
    mimeType: 'video/mp4',
    sizeBytes: null,
    driveVersion: 'v1'
  });
  expect(strict).toBe(f.target.sourceVersion);
  await db.root('update public.team_materials set checksum=$2,size_bytes=31331 where id=$1', [
    f.source,
    'a'.repeat(32)
  ]);
  const content = await catalogPublicationSourceIdentity({
    materialId: f.source,
    connectionId: source.connection_id,
    fileId: source.drive_file_id,
    checksum: 'a'.repeat(32),
    mimeType: 'video/mp4',
    sizeBytes: 31331,
    driveVersion: 'v1'
  });
  expect(
    (
      await db.root<{ value: string }>(
        'select private.catalog_publication_source_version($1,$2) value',
        [f.source, team]
      )
    )[0]!.value
  ).toBe(content);
  await db.root("update public.team_materials set drive_version='sharing-bump' where id=$1", [
    f.source
  ]);
  expect(
    (
      await db.root<{ value: string }>(
        'select private.catalog_publication_source_version($1,$2) value',
        [f.source, team]
      )
    )[0]!.value
  ).toBe(content);
  await db.root(
    "update public.team_materials set drive_file_id=drive_file_id||'-rebound' where id=$1",
    [f.source]
  );
  expect(
    (
      await db.root<{ value: string }>(
        'select private.catalog_publication_source_version($1,$2) value',
        [f.source, team]
      )
    )[0]!.value
  ).not.toBe(content);
});
it('accepts an authorized later recipe without reusing the initial recipe or another consumer', async () => {
  const f = await fixture(),
    other = await fixture(),
    setId = crypto.randomUUID();
  const attempt = async () =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_catalog_update_attempts(catalog_material_id,team_id,round_due_at,trigger_kind) values($1,$2,clock_timestamp(),'manual') returning attempt_id id",
        [f.catalog, team]
      )
    )[0]!.id;
  const first = await attempt(),
    second = await attempt();
  await db.root(
    "insert into private.catalog_video_sets(id,team_id,actor_id,catalog_material_id,update_attempt_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version) values($1,$2,$3,$4,$5,$6,'original','{}',repeat('a',64),1,3,1,repeat('b',64),1)",
    [setId, team, owner, f.catalog, first, f.source]
  );
  await db.root(
    "insert into private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision,product_count,assignment_seed,assignment_version) values($1,$2,2,3,repeat('c',64),1)",
    [setId, team]
  );
  await db.root(
    'insert into private.catalog_video_recipe_references(video_set_id,team_id,recipe_revision,catalog_material_id,update_attempt_id,actor_id) values($1,$2,2,$3,$4,$5)',
    [setId, team, f.catalog, second, owner]
  );
  const target = JSON.stringify({ kind: 'video_set', videoSetId: setId, recipeRevision: 2 });
  const command = (catalog: string) =>
    db.root<{ value: unknown }>(
      "select public.service_save_catalog_publication($1,$2,$3,$4,0,'held',null,null,$5::jsonb) value",
      [team, owner, crypto.randomUUID(), catalog, target]
    );
  expect(parseCatalogPublicationSnapshot((await command(f.catalog))[0]!.value)).toMatchObject({
    target: { kind: 'video_set', videoSetId: setId, recipeRevision: 2 },
    active: null
  });
  await expect(command(other.catalog)).rejects.toThrow('WRONG_STATE');
});
it('registers a new verified blank catalog with its original accepted due even after that due passed', async () => {
  const f = await fixture(),
    intentId = crypto.randomUUID();
  const publication = {
    mode: 'scheduled',
    localDateTime: '2020-01-02T10:00',
    timeZone: 'UTC',
    resolvedOffset: '+00:00',
    dueAt: '2020-01-02T10:00:00.000Z'
  };
  const request = {
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: publication
  };
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'finalized',$7::jsonb)",
    [
      intentId,
      team,
      f.source,
      owner,
      'initial-' + intentId,
      JSON.stringify(request),
      JSON.stringify({
        materialId: f.catalog,
        sheetRows: Array.from({ length: 5 }, () => []),
        initialVideoPlan: { preferences: request, acceptedAt: Date.parse('2020-01-01T00:00:00Z') }
      })
    ]
  );
  const context = (
    await db.root<{ value: { fence: string; state: string } }>(
      'select public.service_begin_initial_catalog_publication($1,$2,$3,$4) value',
      [team, owner, intentId, f.catalog]
    )
  )[0]!.value;
  expect(context.state).toBe('reading');
  const before = (
    await db.root<{ value: unknown }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, f.catalog]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(before)).toMatchObject({
    mode: 'scheduled',
    active: null,
    job: { state: 'blocked' }
  });
  await db.root('select public.service_finish_initial_catalog_publication($1,$2,$3,$4,$5,$6,$7)', [
    team,
    owner,
    intentId,
    f.catalog,
    context.fence,
    'verified-revision',
    'a'.repeat(64)
  ]);
  const after = (
    await db.root<{ value: unknown }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, f.catalog]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(after)).toMatchObject({
    mode: 'scheduled',
    active: null,
    job: { state: 'waiting' }
  });
  expect(
    (
      await db.root<{ value: { state: string } }>(
        'select public.service_begin_initial_catalog_publication($1,$2,$3,$4) value',
        [team, owner, intentId, f.catalog]
      )
    )[0]!.value.state
  ).toBe('verified');
});
it('diagnoses due unsupported publication without claiming a provider fence', async () => {
  const f = await fixture();
  await save(f);
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [f.catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='waiting' where catalog_material_id=$1",
    [f.catalog]
  );
  await save(f, 1, 'immediate');
  await db.root('select public.service_mark_due_catalog_publications_unsupported(10)');
  const value = (
    await db.root<{ value: unknown }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, owner, f.catalog]
    )
  )[0]!.value;
  expect(parseCatalogPublicationSnapshot(value)).toMatchObject({
    active: null,
    job: { state: 'blocked', blockedReason: 'writer_unsupported', writerFence: null }
  });
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_update_reconciliations where catalog_material_id=$1',
        [f.catalog]
      )
    )[0]!.n
  ).toBe(0);
});
it('cancels queued initial children with a durable replay receipt and blocks later parent resume', async () => {
  const f = await fixture(),
    intent = crypto.randomUUID(),
    set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    key = 'cancel-' + intent;
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1)",
    [intent, team, f.source, owner, key, JSON.stringify({ catalogVideoProtocolVersion: 1 })]
  );
  await db.root(
    "insert into private.catalog_video_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version) values($1,$2,$3,$4,$5,'original','{}',repeat('a',64),1,3,1,repeat('b',64),1)",
    [set, team, owner, intent, f.source]
  );
  await db.root(
    'insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id) values($1,$2,0,gen_random_uuid())',
    [set, team]
  );
  const cancel = () =>
    db.root<{ value: unknown }>(
      'select public.service_cancel_initial_catalog_video($1,$2,$3,$4) value',
      [team, owner, key, request]
    );
  const receipt = (await cancel())[0]!.value;
  expect(receipt).toMatchObject({
    outcome: 'preparing_video',
    state: 'canceled',
    requestedCount: 1,
    registeredCount: 0
  });
  expect((await cancel())[0]!.value).toEqual(receipt);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_intents where id=$1',
        [intent]
      )
    )[0]!.state
  ).toBe('canceled');
  await expect(
    db.root('select public.service_read_initial_catalog_request($1,$2,$3)', [team, owner, key])
  ).rejects.toThrow('WRONG_STATE');
  await expect(
    db.root(
      'select public.service_accept_catalog_video_set($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)',
      [
        team,
        owner,
        worker,
        JSON.stringify({
          setId: crypto.randomUUID(),
          catalogIntentId: intent,
          updateAttemptId: null,
          catalogMaterialId: null,
          sourceMaterialId: f.source,
          sourceVersion: 'v1',
          settings: {},
          settingsDigest: 'a'.repeat(64),
          requestedCount: 1,
          productCount: 3,
          recipeRevision: 1,
          seed: 'b'.repeat(64)
        }),
        JSON.stringify([{ index: 0, requestId: crypto.randomUUID() }]),
        JSON.stringify(
          Array.from({ length: 3 }, () => ({
            recipeRowId: crypto.randomUUID(),
            videoVariantIndex: 0
          }))
        )
      ]
    )
  ).rejects.toThrow('WRONG_STATE');
});
it('wakes original standalone recovery through the existing cron predicate without a new queue', async () => {
  const f = await fixture(),
    intent = crypto.randomUUID(),
    key = 'product-catalog:' + crypto.randomUUID();
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,next_attempt_at,lease_expires_at) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'interrupted',now()-interval '1 minute',now()-interval '1 minute')",
    [
      intent,
      team,
      f.source,
      owner,
      key,
      JSON.stringify({
        teamId: team,
        idempotencyKey: key,
        catalogVideoProtocolVersion: 1,
        restitchEnabled: false
      })
    ]
  );
  const listed = (
    await db.root<{ value: Array<{ idempotencyKey: string }> }>(
      'select public.service_list_initial_catalog_recovery(3) value'
    )
  )[0]!.value;
  expect(listed.some(item => item.idempotencyKey === key)).toBe(true);
  expect(
    (await db.root<{ due: boolean }>('select private.launch_catalog_recovery_due() due'))[0]!.due
  ).toBe(true);
  await db.root("update private.catalog_generation_intents set state='canceled' where id=$1", [
    intent
  ]);
  expect(
    (
      await db.root<{ value: Array<{ idempotencyKey: string }> }>(
        'select public.service_list_initial_catalog_recovery(3) value'
      )
    )[0]!.value.some(item => item.idempotencyKey === key)
  ).toBe(false);
});
it('permits original source-only creation without granting native processing or manager policy authority', async () => {
  const f = await fixture(),
    member = crypto.randomUUID(),
    intent = crypto.randomUUID(),
    key = 'product-catalog:' + crypto.randomUUID();
  await createUser(db, { id: member, email: 'source-only-' + member + '@example.invalid' });
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role,permission_overrides) values($1,$2,'editor','{\"process\":false}')",
    [team, member]
  );
  expect(
    (
      await db.root<{ allowed: boolean }>("select private.can($1,'process',$2) allowed", [
        team,
        member
      ])
    )[0]!.allowed
  ).toBe(false);
  const publication = {
      mode: 'scheduled',
      localDateTime: '2020-01-02T10:00',
      timeZone: 'UTC',
      resolvedOffset: '+00:00',
      dueAt: '2020-01-02T10:00:00.000Z'
    },
    preferences = {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: false,
      videoVariationCount: 1,
      videoPublication: publication
    };
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'finalized',$7::jsonb)",
    [
      intent,
      team,
      f.source,
      member,
      key,
      JSON.stringify(preferences),
      JSON.stringify({
        materialId: f.catalog,
        sheetRows: Array.from({ length: 5 }, () => []),
        initialVideoPlan: { preferences, acceptedAt: Date.parse('2020-01-01T00:00:00Z') }
      })
    ]
  );
  await db.root('select public.service_initial_catalog_video_context($1,$2,$3,null,false)', [
    team,
    member,
    f.source
  ]);
  await expect(
    db.root('select public.service_initial_catalog_video_context($1,$2,$3,null,true)', [
      team,
      member,
      f.source
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  const observed = {
    fileId: 'video' + seq,
    version: 'v2',
    checksum: 'a'.repeat(32),
    sizeBytes: 11,
    mimeType: 'video/mp4'
  };
  await db.root(
    'select public.service_capture_initial_catalog_publication_source($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [team, member, intent, f.source, connection, observed.fileId, 'v1', JSON.stringify(observed)]
  );
  await expect(
    db.root('select public.service_capture_catalog_video_source($1,$2,$3,$4,$5,$6,$7::jsonb)', [
      f.source,
      team,
      member,
      connection,
      observed.fileId,
      'v2',
      JSON.stringify(observed)
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  const initial = (
    await db.root<{ value: { fence: string } }>(
      'select public.service_begin_initial_catalog_publication($1,$2,$3,$4) value',
      [team, member, intent, f.catalog]
    )
  )[0]!.value;
  await db.root('select public.service_finish_initial_catalog_publication($1,$2,$3,$4,$5,$6,$7)', [
    team,
    member,
    intent,
    f.catalog,
    initial.fence,
    'proof',
    'b'.repeat(64)
  ]);
  const snapshot = (
    await db.root<{ value: { target: unknown } }>(
      'select public.service_read_catalog_publication($1,$2,$3) value',
      [team, member, f.catalog]
    )
  )[0]!.value;
  await expect(
    db.root(
      "select public.service_save_catalog_publication($1,$2,$3,$4,1,'held',null,null,$5::jsonb)",
      [team, member, crypto.randomUUID(), f.catalog, JSON.stringify(snapshot.target)]
    )
  ).rejects.toThrow('PERMISSION_DENIED');
});

it('preserves a known pre-set admission cause through the actual 173 restricted view and SELECT-only CLI', async () => {
  const migration = readFileSync(
    'supabase/migrations/20261207173000_catalog_video_diagnostics.sql',
    'utf8'
  );
  const viewStart = migration.indexOf(
    'create or replace view public.analytics_catalog_generations as'
  );
  const viewEnd = migration.indexOf('\n) failure;', viewStart);
  if (viewStart < 0 || viewEnd < viewStart) throw new Error('ACTUAL_173_GENERATION_VIEW_REQUIRED');
  const definition = migration.slice(viewStart, viewEnd + '\n) failure;'.length);
  await db.db.exec(definition);
  const f = await fixture(),
    known = crypto.randomUUID(),
    malformed = crypto.randomUUID();
  for (const [id, code] of [
    [known, 'RESTITCH_NO_SCREENS'],
    [malformed, 'private unexpected text']
  ])
    await db.root(
      "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest','{}', $6,'interrupted',$7::jsonb)",
      [
        id,
        team,
        f.source,
        owner,
        'diagnostic-' + id,
        id === known ? 1 : 2,
        JSON.stringify({ safeErrorCode: code })
      ]
    );
  await db.root('grant usage on schema private to publication_diagnostic_reader');
  await db.root(
    'grant execute on function private.catalog_generation_timings_v1(jsonb) to publication_diagnostic_reader'
  );
  await db.root(
    'grant select on public.analytics_catalog_generations to publication_diagnostic_reader'
  );
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role publication_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const period = resolvePeriod('all', undefined);
    const fact = await getCatalogGenerationEvidence(known, period),
      unknown = await getCatalogGenerationEvidence(malformed, period);
    expect(fact.supported).toBe(true);
    expect(fact.records[0]).toMatchObject({
      intent_id: known,
      safe_error_code: 'RESTITCH_NO_SCREENS'
    });
    expect(unknown.records[0]).toMatchObject({ intent_id: malformed, safe_error_code: 'UNKNOWN' });
    expect(JSON.stringify([fact, unknown])).not.toContain('private unexpected text');
  } finally {
    setQueryExecutor(null);
  }
});
it('verifies a blank scheduled catalog before N completes and cancels only its remaining work', async () => {
  const f = await fixture(),
    intent = crypto.randomUUID(),
    set = crypto.randomUUID(),
    generationId = crypto.randomUUID(),
    key = 'launch:' + generationId + ':catalog';
  deferredCatalogForDiagnostic = {
    catalogId: f.catalog,
    setId: set,
    intentId: intent,
    generationId
  };
  const publication = {
      mode: 'scheduled',
      localDateTime: '2020-01-02T10:00',
      timeZone: 'UTC',
      resolvedOffset: '+00:00',
      dueAt: '2020-01-02T10:00:00.000Z'
    },
    preferences = {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 2,
      videoPublication: publication
    };
  const result = {
    outcome: 'created',
    catalog: {
      materialId: f.catalog,
      name: 'Fixture',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/fixture',
      sourceLink: 'https://example.invalid/',
      productCount: 3,
      createdAt: '2020-01-01T00:00:00Z',
      variant: 1
    },
    videoShared: false,
    videoGeneration: {
      videoSetId: set,
      requestedCount: 2,
      registeredCount: 0,
      state: 'preparing',
      catalogVideoCells: 'deferred_blank',
      providerCas: 'unsupported',
      publicationHeld: false
    }
  };
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'finalized',$7::jsonb)",
    [
      intent,
      team,
      f.source,
      owner,
      key,
      JSON.stringify(preferences),
      JSON.stringify({
        materialId: f.catalog,
        sheetRows: Array.from({ length: 5 }, () => []),
        initialVideoPlan: {
          preferences,
          setId: set,
          recipeRevision: 1,
          acceptedAt: Date.parse('2020-01-01T00:00:00Z')
        }
      })
    ]
  );
  await db.root(
    "insert into private.catalog_video_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,state) values($1,$2,$3,$4,$5,'original','{}',repeat('a',64),2,3,1,repeat('b',64),1,'preparing')",
    [set, team, owner, intent, f.source]
  );
  for (let n = 0; n < 2; n++)
    await db.root(
      'insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id) values($1,$2,$3,gen_random_uuid())',
      [set, team, n]
    );
  const context = (
    await db.root<{ value: { fence: string } }>(
      'select public.service_begin_initial_catalog_publication($1,$2,$3,$4) value',
      [team, owner, intent, f.catalog]
    )
  )[0]!.value;
  await db.root('select public.service_finish_initial_catalog_publication($1,$2,$3,$4,$5,$6,$7)', [
    team,
    owner,
    intent,
    f.catalog,
    context.fence,
    'blank-proof',
    'a'.repeat(64)
  ]);
  await db.root(
    "update private.catalog_generation_intents set state='registered',result=$2::jsonb where id=$1",
    [intent, JSON.stringify(result)]
  );
  const before = (
    await db.root<{ value: unknown }>(
      'select public.service_read_initial_catalog_video($1,$2,$3) value',
      [team, owner, key]
    )
  )[0]!.value;
  expect(before).toMatchObject({
    outcome: 'created',
    videoGenerationObservation: {
      registeredCount: 0,
      state: 'preparing',
      catalogVideoCells: 'deferred_blank',
      providerCas: 'unsupported'
    }
  });
  const frozenResume = (
    await db.root<{ value: unknown }>(
      'select public.service_read_initial_catalog_request($1,$2,$3) value',
      [team, owner, key]
    )
  )[0]!.value;
  expect(frozenResume).toEqual(preferences);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_intents where id=$1',
        [intent]
      )
    )[0]!.state
  ).toBe('registered');
  const cancel = crypto.randomUUID(),
    args = [team, owner, key, cancel];
  const receipt = (
    await db.root<{ value: unknown }>(
      'select public.service_cancel_initial_catalog_video($1,$2,$3,$4) value',
      args
    )
  )[0]!.value;
  expect(receipt).toMatchObject({
    outcome: 'created',
    catalog: { materialId: f.catalog },
    videoGenerationObservation: { state: 'canceled', publicationHeld: true }
  });
  expect(
    (
      await db.root<{ value: unknown }>(
        'select public.service_cancel_initial_catalog_video($1,$2,$3,$4) value',
        args
      )
    )[0]!.value
  ).toEqual(receipt);
  expect(
    (
      await db.root<{ state: string; result: unknown }>(
        'select state,result from private.catalog_generation_intents where id=$1',
        [intent]
      )
    )[0]
  ).toEqual({ state: 'registered', result });
  expect(
    parseCatalogPublicationSnapshot(
      (
        await db.root<{ value: unknown }>(
          'select public.service_read_catalog_publication($1,$2,$3) value',
          [team, owner, f.catalog]
        )
      )[0]!.value
    )
  ).toMatchObject({ mode: 'held', active: null, revision: 2 });
});
it('resolves only the exact canonical READY set without an online executor and rejects broken original receipts', async () => {
  const f = await fixture(),
    intent = crypto.randomUUID(),
    set = crypto.randomUUID(),
    key = 'product-catalog:' + crypto.randomUUID(),
    row = crypto.randomUUID(),
    child = crypto.randomUUID(),
    operation = crypto.randomUUID(),
    output = crypto.randomUUID(),
    seed = 'b'.repeat(64);
  const preferences = {
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 1,
      videoPublication: { mode: 'immediate' }
    },
    payload = { ...preferences, productCount: 1 },
    plan = {
      preferences,
      setId: set,
      recipeRevision: 1,
      assignmentSeed: seed,
      recipeRowIds: [row],
      childRequestIds: [child]
    };
  await db.root(
    "update public.team_materials set checksum=repeat('a',32),size_bytes=11 where id=$1",
    [f.source]
  );
  const file = (
    await db.root<{ file: string }>(
      'select drive_file_id file from public.team_materials where id=$1',
      [f.source]
    )
  )[0]!.file;
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'interrupted',$7::jsonb)",
    [
      intent,
      team,
      f.source,
      owner,
      key,
      JSON.stringify(payload),
      JSON.stringify({ initialVideoPlan: plan })
    ]
  );
  await db.root(
    "insert into private.catalog_video_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_version,source_snapshot,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,state) values($1,$2,$3,$4,$5,'v1',$6::jsonb,'{\"configured\":true}',repeat('a',64),1,1,1,$7,1,'ready')",
    [
      set,
      team,
      owner,
      intent,
      f.source,
      JSON.stringify({
        fileId: file,
        connectionId: connection,
        checksum: 'a'.repeat(32),
        sizeBytes: 11,
        mimeType: 'video/mp4'
      }),
      seed
    ]
  );
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,name,kind,category,mime_type) values($1,$2,$3,$4,'Synthetic','file','video','video/mp4')",
    [output, team, connection, 'ready-' + output]
  );
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,result_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,$3,'process','succeeded',$4,$5,$6,'synthetic-nonce',now())",
    [operation, team, owner, f.source, output, 'catalog-variant:' + child]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version) values($1,$2,'restitch','v1')",
    [operation, team]
  );
  await db.root(
    "insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id,operation_id,state,output_material_id) values($1,$2,0,$3,$4,'registered',$5)",
    [set, team, child, operation, output]
  );
  await db.root(
    'insert into private.catalog_video_assignments(video_set_id,team_id,recipe_revision,recipe_row_id,video_variant_index) values($1,$2,1,$3,0)',
    [set, team, row]
  );
  const read = (requestedKey = key) =>
    db.root<{ value: unknown }>(
      'select public.service_read_initial_catalog_ready_binding($1,$2,$3,$4) value',
      [team, owner, f.source, requestedKey]
    );
  expect((await read())[0]!.value).toEqual({ videoSetId: set, catalogIntentId: intent });
  expect((await read('product-catalog:' + crypto.randomUUID()))[0]!.value).toBeNull();
  await expect(
    db.root("update public.team_operations set state='running',finished_at=null where id=$1", [
      operation
    ])
  ).rejects.toThrow('TERMINAL_OPERATION_IMMUTABLE');
  await db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=now() where id=$1",
    [output]
  );
  expect((await read())[0]!.value).toBeNull();
});

it('finds an initial N consumer by its created catalog UUID under the actual restricted diagnostic views', async () => {
  if (!deferredCatalogForDiagnostic) throw new Error('CREATED_BLANK_FIXTURE_REQUIRED');
  for (const name of [
    '20261207170000_restitch_process_aliases.sql',
    '20261207171000_launch_catalog_video_protocol.sql',
    '20261207172000_catalog_updater_video_variants.sql',
    '20261207173000_catalog_video_diagnostics.sql'
  ])
    await db.db.exec(readFileSync('supabase/migrations/' + name, 'utf8'));
  await db.root(
    'grant select on public.analytics_catalog_video_sets,public.analytics_catalog_video_children,public.analytics_catalog_video_consumers,public.analytics_catalog_updater_video_requests to publication_diagnostic_reader'
  );
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role publication_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const evidence = await getCatalogVideoSetEvidence(deferredCatalogForDiagnostic.catalogId);
    expect(evidence.status).toBe('available');
    expect(evidence.records.map(r => r.video_set_id)).toContain(deferredCatalogForDiagnostic.setId);
    expect(evidence.consumers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          catalog_material_id: deferredCatalogForDiagnostic.catalogId,
          video_set_id: deferredCatalogForDiagnostic.setId
        })
      ])
    );
    expect(evidence.browser_delivery).toBe('not_joined');
    expect(evidence.invalid_record_count).toBe(0);
  } finally {
    setQueryExecutor(null);
  }
});
it('persists private same-table cell binding, refuses rewritten payloads and reclaims dispatched unknown only for original-fence readback', async () => {
  for (const name of [
    '20261207174000_launch_video_reuse_bulk_profiles.sql',
    '20261207175000_catalog_scheduled_video_sets.sql',
    '20261207176000_catalog_video_cell_publication.sql'
  ])
    await db.db.exec(readFileSync('supabase/migrations/' + name, 'utf8'));
  const f = await fixture();
  await save(f, 0, 'immediate');
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [f.catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null,worker_id=$2,lease_until=clock_timestamp()+interval '5 minutes' where catalog_material_id=$1",
    [f.catalog, worker]
  );
  const job = (
    await db.root<{ id: string }>(
      'select id from private.catalog_video_publication_jobs where catalog_material_id=$1',
      [f.catalog]
    )
  )[0]!.id;
  const context = (
    await db.root<{ value: Record<string, unknown> }>(
      'select public.service_catalog_publication_cells_context($1,$2) value',
      [job, worker]
    )
  )[0]!.value;
  expect(context.state).toBe('ready');
  expect(context.sources).toHaveLength(1);
  const source = (
      context.sources as Array<{ materialId: string; sourceVersion: string; fileId: string }>
    )[0]!,
    url = 'https://drive.google.com/file/d/' + source.fileId + '/view?usp=sharing';
  await db.root('select public.service_record_catalog_publication_link($1,$2,$3,$4,$5)', [
    job,
    worker,
    source.materialId,
    source.sourceVersion,
    url
  ]);
  const payload = {
    fileId: context.fileId,
    rootFolderId: context.rootFolderId,
    sheetName: 'catalog_products',
    sheetId: 7,
    idColumn: 0,
    videoColumn: 25,
    idHeaders: ['description', 'id'],
    videoHeaders: ['description', 'video[0].url'],
    products: ['one', 'two', 'three'].map(id => ({ id, url })),
    markerKey: 'soty_video_publication',
    markerValue: job
  };
  await db.root('select public.service_prepare_catalog_publication_cells($1,$2,$3::jsonb)', [
    job,
    worker,
    JSON.stringify(payload)
  ]);
  await expect(
    db.root('select public.service_prepare_catalog_publication_cells($1,$2,$3::jsonb)', [
      job,
      worker,
      JSON.stringify({ ...payload, products: [] })
    ])
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  const fence = (
    await db.root<{ value: string }>(
      'select public.service_reserve_catalog_publication($1,$2) value',
      [job, worker]
    )
  )[0]!.value;
  await db.root('select public.service_dispatch_catalog_publication($1,$2,$3)', [
    job,
    worker,
    fence
  ]);
  await db.root("select public.service_settle_catalog_publication($1,$2,$3,'unknown')", [
    job,
    worker,
    fence
  ]);
  await db.root(
    "update private.catalog_video_publication_jobs set lease_until=clock_timestamp()-interval '1 minute' where id=$1",
    [job]
  );
  const recovered = (
    await db.root<{
      value: { items: Array<{ jobId: string; job: { state: string; writerFence: string } }> };
    }>('select public.service_claim_catalog_publication_jobs($1,3) value', [worker])
  )[0]!.value.items.find(i => i.jobId === job);
  expect(recovered?.job).toMatchObject({ state: 'unknown', writerFence: fence });
  await db.root(
    "update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()-interval '1 day'where id=$1",
    [job]
  );
  await db.root(
    "update private.catalog_publication_link_receipts set prepared_at=clock_timestamp()-interval '1 day',due_verified_at=clock_timestamp()-interval '1 day'where job_id=$1",
    [job]
  );
  expect(
    (
      await db.root<{ value: { links: Array<{ dueVerified: boolean }> } }>(
        'select public.service_catalog_publication_cells_context($1,$2)value',
        [job, worker]
      )
    )[0]!.value.links[0]?.dueVerified
  ).toBe(false);
  await db.root('select public.service_record_catalog_publication_link($1,$2,$3,$4,$5)', [
    job,
    worker,
    source.materialId,
    source.sourceVersion,
    url
  ]);

  expect(
    (
      await db.root<{ value: boolean }>(
        'select public.service_dispatch_catalog_publication($1,$2,$3) value',
        [job, worker, fence]
      )
    )[0]!.value
  ).toBe(false);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_prepare_catalog_publication_cells(uuid,uuid,jsonb)','execute') allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_table_privilege('service_role','private.catalog_publication_cell_writes','select') allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  await db.root(
    'grant select on public.analytics_catalog_publication_preparations to publication_diagnostic_reader'
  );
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    await db.db.exec('begin read only;set local role publication_diagnostic_reader');
    try {
      return (await db.db.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await db.db.exec('rollback');
    }
  });
  try {
    const evidence = await getCatalogPublicationEvidence({ id: f.catalog });
    expect(evidence.preparation).toEqual([
      expect.objectContaining({
        required_unique_links: 1,
        prepared_unique_links: 1,
        due_verified_unique_links: 1,
        private_mapping_prepared: true,
        observation_basis: 'current_snapshot_only'
      })
    ]);
    expect(JSON.stringify(evidence)).not.toContain('https://');
  } finally {
    setQueryExecutor(null);
  }
});

it('prepares original private links before future due and refreshes only stale proof without replacing its URL', async () => {
  const f = await fixture();
  await save(f, 0, 'scheduled', crypto.randomUUID(), '2099-01-01T00:00:00Z', 'UTC');
  await db.root(
    'update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=$1',
    [f.catalog]
  );
  await db.root(
    "update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null,next_attempt_at='2000-01-01T00:00:00Z'where catalog_material_id=$1",
    [f.catalog]
  );
  const claimed = (
    await db.root<{ value: Array<{ jobId: string }> }>(
      'select public.service_claim_catalog_publication_preparations($1,1)value',
      [worker]
    )
  )[0]!.value;
  const job = (
    await db.root<{ id: string }>(
      'select id from private.catalog_video_publication_jobs where catalog_material_id=$1',
      [f.catalog]
    )
  )[0]!.id;
  expect(claimed[0]?.jobId).toBe(job);
  const context = (
    await db.root<{
      value: {
        phase: string;
        sources: Array<{ materialId: string; sourceVersion: string; fileId: string }>;
      };
    }>('select public.service_catalog_publication_cells_context($1,$2)value', [job, worker])
  )[0]!.value;
  expect(context.phase).toBe('eager');
  const source = context.sources[0]!,
    url = 'https://drive.google.com/file/d/' + source.fileId + '/view?usp=sharing';
  await db.root('select public.service_record_catalog_publication_link($1,$2,$3,$4,$5)', [
    job,
    worker,
    source.materialId,
    source.sourceVersion,
    url
  ]);
  expect(
    (
      await db.root<{ dispatched_at: unknown; writer_fence: unknown }>(
        'select dispatched_at,writer_fence from private.catalog_video_publication_jobs where id=$1',
        [job]
      )
    )[0]
  ).toEqual({ dispatched_at: null, writer_fence: null });
  await db.root(
    "update private.catalog_publication_link_receipts set prepared_at=clock_timestamp()-interval '1 hour'where job_id=$1",
    [job]
  );
  await db.root(
    "update private.catalog_video_publication_policies set due_at=clock_timestamp()-interval '1 minute'where catalog_material_id=$1",
    [f.catalog]
  );
  const stale = (
    await db.root<{ value: { phase: string; links: Array<{ dueVerified: boolean }> } }>(
      'select public.service_catalog_publication_cells_context($1,$2)value',
      [job, worker]
    )
  )[0]!.value;
  expect(stale.phase).toBe('due');
  expect(stale.links[0]?.dueVerified).toBe(false);
  await db.root('select public.service_record_catalog_publication_link($1,$2,$3,$4,$5)', [
    job,
    worker,
    source.materialId,
    source.sourceVersion,
    url
  ]);
  await expect(
    db.root('select public.service_record_catalog_publication_link($1,$2,$3,$4,$5)', [
      job,
      worker,
      source.materialId,
      source.sourceVersion,
      url + '&resourcekey=changed'
    ])
  ).rejects.toThrow('SOURCE_CHANGED');
  expect(
    (
      await db.root<{ value: { links: Array<{ url: string; dueVerified: boolean }> } }>(
        'select public.service_catalog_publication_cells_context($1,$2)value',
        [job, worker]
      )
    )[0]!.value.links[0]
  ).toMatchObject({ url, dueVerified: true });
  await db.root(
    "update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()-interval '20 minutes'where id=$1",
    [job]
  );
  await db.root(
    "update private.catalog_publication_link_receipts set prepared_at=clock_timestamp()-interval '1 hour',due_verified_at=clock_timestamp()-interval '16 minutes'where job_id=$1",
    [job]
  );
  expect(
    (
      await db.root<{ value: { links: Array<{ dueVerified: boolean }> } }>(
        'select public.service_catalog_publication_cells_context($1,$2)value',
        [job, worker]
      )
    )[0]!.value.links[0]?.dueVerified
  ).toBe(true);
  await db.root(
    "update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp()-interval '61 minutes'where id=$1",
    [job]
  );
  expect(
    (
      await db.root<{ value: { state: string; reason: string } }>(
        'select public.service_catalog_publication_cells_context($1,$2)value',
        [job, worker]
      )
    )[0]!.value
  ).toEqual({ state: 'blocked', reason: 'validation_epoch_expired' });
});

it('keeps exact N read/cancel available after Launch succeeded without canceling its created catalog', async () => {
  if (!deferredCatalogForDiagnostic) throw Error('SCHEDULED_BLANK_FIXTURE_REQUIRED');
  const { catalogId, setId, intentId, generationId } = deferredCatalogForDiagnostic;
  const launch = (
    await db.root<{ id: string }>(
      'insert into public.team_launches(team_id,created_by)values($1,$2)returning id',
      [team, owner]
    )
  )[0]!.id;
  const revision = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,'generated','{}','{}','https://example.invalid/','https://example.invalid/','{}',$3)returning id",
      [team, launch, owner]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state)values($1,$2,$3,$4,$5,'launch-created-N-control','digest','v1','succeeded')",
    [generationId, team, launch, revision, owner]
  );
  await db.root(
    "insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)select $1,team_id,actor_id,'{}',request_payload,checkpoint->'initialVideoPlan',id,$3 from private.catalog_generation_intents where id=$2",
    [generationId, intentId, setId]
  );
  const read = (
    await db.root<{ value: unknown }>(
      "select public.service_created_launch_catalog_video($1,$2,$3,'read')value",
      [team, owner, generationId]
    )
  )[0]!.value;
  expect(read).toMatchObject({
    outcome: 'created',
    catalog: { materialId: catalogId },
    videoGenerationObservation: { state: 'canceled', publicationHeld: true }
  });
  const cancel = crypto.randomUUID();
  const result = (
    await db.root<{ value: unknown }>(
      "select public.service_created_launch_catalog_video($1,$2,$3,'cancel',$4)value",
      [team, owner, generationId, cancel]
    )
  )[0]!.value;
  expect(result).toMatchObject({ outcome: 'created', catalog: { materialId: catalogId } });
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [generationId]
      )
    )[0]!.state
  ).toBe('succeeded');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_intents where id=$1',
        [intentId]
      )
    )[0]!.state
  ).toBe('registered');
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_created_launch_catalog_video(uuid,uuid,uuid,text,uuid)','execute')allowed"
      )
    )[0]!.allowed
  ).toBe(false);
});
