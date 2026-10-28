import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';

const OWNER = '45000000-0000-4000-8000-000000000011';
const VIEWER = '45000000-0000-4000-8000-000000000012';
const OUTSIDER = '45000000-0000-4000-8000-000000000013';
let db: TeamTestDb;
let team: string;
let ordinal = 0;
interface Snapshot {
  id: string;
  revision: number;
  state: string;
  errorCode?: string | null;
  counts: { ready: number; reused: number; expired: number };
  entries: Array<{ id: string; grantGeneration: number; state: string }>;
}
async function control(
  action: string,
  payload: Record<string, unknown>,
  actor = OWNER
): Promise<Snapshot> {
  const rows = await db.root<{ v: Snapshot }>(
    'select public.service_catalog_image_control_v2($1,$2,$3::jsonb) v',
    [action, actor, JSON.stringify(payload)]
  );
  return rows[0]!.v;
}
async function start(name = 'IMG_2031.png') {
  const job = await control('begin', {
    teamId: team,
    contractVersion: 2,
    sourceKind: 'local',
    idempotencyKey: `catalog-test-${++ordinal}`
  });
  const manifest = await control('manifest', {
    jobId: job.id,
    pageKey: 'manifest-page-01',
    entries: [
      {
        name,
        clientFileKey: 'client-file-01',
        declaredSize: 68,
        declaredMime: 'image/png',
        classification: classifyCatalogImageName(name)
      }
    ]
  });
  const seal = { jobId: job.id, revision: manifest.revision, manifestCount: 1 };
  const sealed = await control('seal', seal);
  expect(await control('seal', seal)).toEqual(sealed);
  const grant = await control('grant', {
    jobId: job.id,
    entryId: manifest.entries[0]!.id,
    generation: 0,
    requestKey: 'grant-request-01'
  });
  const generation = (grant as unknown as { generation: number }).generation;
  await control('delivered', {
    jobId: job.id,
    entryId: manifest.entries[0]!.id,
    grantGeneration: generation,
    requestKey: 'delivery-request-01'
  });
  return { jobId: job.id, entry: manifest.entries[0]!.id };
}

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261206152000_catalog_r2_integration.sql' });
  await createUser(db, { id: OWNER, email: 'catalog-owner@example.test' });
  await createUser(db, { id: VIEWER, email: 'catalog-viewer@example.test' });
  await createUser(db, { id: OUTSIDER, email: 'catalog-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 images')")
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, VIEWER]
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe('catalog image metadata authority', () => {
  it('starts disabled and service-only functions do not admit browser roles', async () => {
    await control('capabilities', { teamId: team });
    await expect(
      control('begin', {
        teamId: team,
        contractVersion: 2,
        sourceKind: 'local',
        idempotencyKey: 'disabled-request'
      })
    ).rejects.toThrow(/CATALOG_IMAGE_IMPORT_DISABLED/u);
    await db.root('set role authenticated');
    try {
      await expect(
        db.asUser(OWNER, 'select public.service_catalog_image_control_v2($1,$2,$3::jsonb)', [
          'capabilities',
          OWNER,
          JSON.stringify({ teamId: team })
        ])
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await db.root('reset role');
    }
    await db.root('update private.catalog_image_config set import_enabled=true where team_id=$1', [
      team
    ]);
    await expect(
      control(
        'begin',
        {
          teamId: team,
          contractVersion: 2,
          sourceKind: 'local',
          idempotencyKey: 'viewer-request-01'
        },
        VIEWER
      )
    ).rejects.toThrow(/PERMISSION_DENIED/u);
  });
  it('binds intent identity to its actual payload', async () => {
    const payload = {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'local',
      idempotencyKey: 'same-request-key'
    };
    const first = await control('begin', payload);
    expect((await control('begin', payload)).id).toBe(first.id);
    await expect(
      control('begin', { ...payload, sourceKind: 'drive', sourceMaterialIds: [] })
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
    await control('cancel', {
      jobId: first.id,
      revision: first.revision,
      idempotencyKey: 'cancel-request-01'
    });
  });
  it('denies cross-team discovery, job reads and mutations even with a known valid UUID', async () => {
    const job = await control('begin', {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'local',
      idempotencyKey: 'tenant-boundary-request'
    });
    for (const [action, payload] of [
      ['capabilities', { teamId: team }],
      ['list', { teamId: team }],
      ['dictionary', { teamId: team }],
      ['get', { jobId: job.id }],
      [
        'cancel',
        { jobId: job.id, revision: job.revision, idempotencyKey: 'foreign-cancel-request' }
      ]
    ] as const) {
      await expect(control(action, payload, OUTSIDER)).rejects.toThrow(/PERMISSION_DENIED/u);
    }
    expect((await control('get', { jobId: job.id })).state).toBe('collecting');
    await control('cancel', {
      jobId: job.id,
      revision: job.revision,
      idempotencyKey: 'owner-cancel-tenant-request'
    });
  });
  it('commits generic pictures normally, freezes scoped draws and keeps ready bytes after pool removal', async () => {
    const { entry, jobId } = await start();
    const claim = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_claim_v2($1) v',
        ['schema-worker']
      )
    )[0]!.v;
    expect(claim.id).toBe(entry);
    // Private stages must invalidate the public Realtime snapshot without polling.
    let priorRevision = (await control('get', { jobId })).revision;
    for (const stage of ['validating', 'publishing', 'verifying_public']) {
      await db.root('select public.service_catalog_image_progress_v2($1,$2,$3,$4)', [
        entry,
        'schema-worker',
        claim.fence,
        stage
      ]);
      const current = await control('get', { jobId });
      expect(current.revision).toBeGreaterThan(priorRevision);
      expect(current.entries.find(value => value.id === entry)?.state).toBe(stage);
      priorRevision = current.revision;
    }
    const image = { sha256: 'a'.repeat(64), size: 68, mime: 'image/png', width: 1, height: 1 };
    const publication = (
      await db.root<{ v: { id: string; key: string; fence: number } }>(
        'select public.service_catalog_image_reserve_v2($1,$2,$3,$4::jsonb) v',
        [entry, 'schema-worker', claim.fence, JSON.stringify(image)]
      )
    )[0]!.v;
    await db.root('select public.service_catalog_image_publication_v2($1,$2,$3,$4,$5,$6)', [
      entry,
      'schema-worker',
      claim.fence,
      publication.id,
      publication.fence,
      'public_verified'
    ]);
    const ready = (
      await db.root<{ v: Snapshot }>(
        'select public.service_catalog_image_commit_v2($1,$2,$3,$4,$5,$6) v',
        [
          entry,
          'schema-worker',
          claim.fence,
          publication.id,
          publication.fence,
          `https://media.test/${publication.key}`
        ]
      )
    )[0]!.v;
    expect(ready.counts.ready).toBe(1);
    expect(
      (
        await db.root<{ mode: string }>('select public.service_catalog_image_mode_v2($1) mode', [
          team
        ])
      )[0]!.mode
    ).toBe('v2');
    const attempt = '45000000-0000-4000-8000-000000000099';
    const rows = await db.root<{ v: unknown[] }>(
      'select public.service_draw_product_catalog_images_v2($1,2,$2,$3) v',
      [team, attempt, 'growth']
    );
    expect(rows[0]!.v).toHaveLength(2);
    expect((rows[0]!.v[0] as { classification: { mode: string } }).classification.mode).toBe(
      'unclassified'
    );
    expect(
      (
        await db.root<{ v: unknown[] }>(
          'select public.service_draw_product_catalog_images_v2($1,4,$2,$3) v',
          [team, attempt, 'refresh']
        )
      )[0]!.v
    ).toHaveLength(4);
    const pool = (
      await db.root<{ id: string; revision: number }>(
        'select id,revision from public.team_catalog_image_pool_entries where team_id=$1',
        [team]
      )
    )[0]!;
    await control('remove', {
      entryId: pool.id,
      revision: pool.revision,
      idempotencyKey: 'remove-request-01'
    });
    expect(
      (
        await db.root<{ state: string }>(
          'select state from private.catalog_image_publications where id=$1',
          [publication.id]
        )
      )[0]!.state
    ).toBe('ready');
    expect((await control('get', { jobId })).state).toBe('completed');
    // A durable retry reuses the exact selection even after pool membership changes.
    expect(
      (
        await db.root<{ v: unknown[] }>(
          'select public.service_draw_product_catalog_images_v2($1,2,$2,$3) v',
          [team, attempt, 'growth']
        )
      )[0]!.v
    ).toEqual(rows[0]!.v);
    const retained = rows[0]!.v[0];
    // Pool removal changes active/revision, but historical ready row identity remains valid.
    await db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
      team,
      JSON.stringify([retained])
    ]);
    for (const revision of [0, 2, Number.MAX_SAFE_INTEGER]) {
      await db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
        team,
        JSON.stringify([{ ...(retained as Record<string, unknown>), revision }])
      ]);
    }
    for (const revision of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
          team,
          JSON.stringify([{ ...(retained as Record<string, unknown>), revision }])
        ])
      ).rejects.toThrow(/INVALID_RESPONSE/u);
    }
    for (const image of [
      { ...(retained as Record<string, unknown>), publicUrl: 'https://wrong.example/image' },
      { ...(retained as Record<string, unknown>), poolEntryId: OUTSIDER },
      {
        ...(retained as Record<string, unknown>),
        classification: { mode: 'unclassified', reason: 'tampered' }
      }
    ])
      await expect(
        db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
          team,
          JSON.stringify([image])
        ])
      ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await expect(
      db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
        OUTSIDER,
        JSON.stringify([retained])
      ])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await expect(
      db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
        team,
        JSON.stringify([{ ...(retained as Record<string, unknown>), publicationId: 'malformed' }])
      ])
    ).rejects.toThrow(/INVALID_RESPONSE/u);
    await expect(
      db.root('select public.service_catalog_image_validate_rows_v2($1,$2::jsonb)', [
        team,
        JSON.stringify(Array(401).fill(retained))
      ])
    ).rejects.toThrow(/INVALID_RESPONSE/u);
    await db.root('select public.service_catalog_image_validate_uses_v2($1,$2)', [team, attempt]);
    await db.root('select public.service_catalog_image_finalize_uses_v2($1,$2,false)', [
      team,
      attempt
    ]);
    expect(
      (
        await db.root<{ state: string }>(
          'select distinct state from private.catalog_image_uses where catalog_attempt_id=$1',
          [attempt]
        )
      )[0]!.state
    ).toBe('unknown');
    await db.root("update private.catalog_image_publications set state='revoking' where id=$1", [
      publication.id
    ]);
    await expect(
      db.root('select public.service_catalog_image_validate_uses_v2($1,$2)', [team, attempt])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await expect(
      db.root('select public.service_catalog_image_finalize_uses_v2($1,$2,true)', [team, attempt])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    expect(
      (
        await db.root<{ state: string }>(
          'select distinct state from private.catalog_image_uses where catalog_attempt_id=$1',
          [attempt]
        )
      )[0]!.state
    ).toBe('unknown');
    await db.root("update private.catalog_image_publications set state='ready' where id=$1", [
      publication.id
    ]);
  });
  it('expires abandoned local input, preserving completed results and freeing active job slots', async () => {
    const job = await control('begin', {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'local',
      idempotencyKey: 'abandoned-input-01'
    });
    await db.root(
      "update public.team_catalog_image_imports set source_deadline=now()-interval '1 day' where id=$1",
      [job.id]
    );
    // The scheduler must free quota even when no staged entry or Vault endpoint exists.
    await db.root('select private.invoke_catalog_images_worker()');
    expect((await control('get', { jobId: job.id })).state).toBe('expired');
    const protectedJob = await control('begin', {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'local',
      idempotencyKey: 'leased-input-01'
    });
    const manifest = await control('manifest', {
      jobId: protectedJob.id,
      pageKey: 'leased-page-01',
      entries: [
        {
          name: 'IMG_LEASE.png',
          clientFileKey: 'leased-file-01',
          declaredSize: 68,
          declaredMime: 'image/png',
          classification: classifyCatalogImageName('IMG_LEASE.png')
        }
      ]
    });
    await control('seal', {
      jobId: protectedJob.id,
      revision: manifest.revision,
      manifestCount: 1
    });
    await control('grant', {
      jobId: protectedJob.id,
      entryId: manifest.entries[0]!.id,
      generation: 0,
      requestKey: 'leased-grant-01'
    });
    // Lost browser hints are discovered from staging; the claimed verification owns a lease.
    const leased = (
      await db.root<{ v: { id: string; fence: number } }>(
        'select public.service_catalog_image_claim_v2($1) v',
        ['leased-worker']
      )
    )[0]!.v;
    expect(leased.id).toBe(manifest.entries[0]!.id);
    await db.root(
      "update public.team_catalog_image_imports set source_deadline=now()-interval '1 day' where id=$1",
      [protectedJob.id]
    );
    await db.root('select public.service_catalog_image_expire_v2()');
    await db.root('select public.service_catalog_image_claim_v2($1)', ['parallel-expiry-worker']);
    const protectedSnapshot = await control('get', { jobId: protectedJob.id });
    expect(protectedSnapshot.entries[0]!.state).toBe('waiting_source');
    await db.root('select public.service_catalog_image_progress_v2($1,$2,$3,$4)', [
      leased.id,
      'leased-worker',
      leased.fence,
      'validating'
    ]);
    const afterProgress = await control('get', { jobId: protectedJob.id });
    await control('cancel', {
      jobId: protectedJob.id,
      revision: afterProgress.revision,
      idempotencyKey: 'leased-cancel-01'
    });
  });
  it('retries incomplete Drive enumeration from its durable cursor without losing ready entries', async () => {
    const sourceId = '45000000-0000-4000-8000-000000000066';
    const job = await control('begin', {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'drive',
      sourceMaterialIds: [sourceId],
      idempotencyKey: 'enum-recovery-01'
    });
    const claim = async () =>
      (
        await db.root<{ v: { jobId: string; fence: number; cursor: unknown[] } }>(
          'select public.service_catalog_image_claim_v2($1) v',
          ['enum-worker']
        )
      )[0]!.v;
    const first = await claim();
    expect(first.jobId).toBe(job.id);
    await db.root('select public.service_catalog_image_enumeration_error_v2($1,$2,$3,$4)', [
      job.id,
      'enum-worker',
      first.fence,
      'IMAGE_SOURCE_UNAVAILABLE'
    ]);
    const failed = await control('get', { jobId: job.id });
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('IMAGE_SOURCE_UNAVAILABLE');
    expect(failed.entries).toHaveLength(0);
    const restarted = await control('retry', { jobId: job.id, idempotencyKey: 'enum-retry-01' });
    expect(restarted.state).toBe('enumerating');
    expect(restarted.errorCode).toBeNull();
    const second = await claim();
    expect(second.cursor).toEqual(first.cursor);
    expect(second.fence).toBeGreaterThan(first.fence);
    await expect(
      db.root(
        'select public.service_catalog_image_enumeration_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6)',
        [job.id, 'enum-worker', first.fence, '[]', '[]', true]
      )
    ).rejects.toThrow(/PERMISSION_DENIED/u);
    const entry = {
      fileId: 'enum-image',
      name: 'IMG_ENUM.png',
      size: 68,
      mime: 'image/png',
      classification: classifyCatalogImageName('IMG_ENUM.png'),
      source: { fileId: 'enum-image' }
    };
    const cursor = [
      { kind: 'seen', ids: ['enum-image'] },
      { rootMaterialId: sourceId, fileId: 'next-folder', pageToken: 'page-2' }
    ];
    await db.root(
      'select public.service_catalog_image_enumeration_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6)',
      [job.id, 'enum-worker', second.fence, JSON.stringify([entry]), JSON.stringify(cursor), false]
    );
    const publication = (
      await db.root<{ id: string }>(
        'select id from private.catalog_image_publications where team_id=$1',
        [team]
      )
    )[0]!.id;
    await db.root(
      "update private.catalog_image_import_entries set state='ready',publication_id=$2 where job_id=$1",
      [job.id, publication]
    );
    const third = await claim();
    await db.root('select public.service_catalog_image_enumeration_error_v2($1,$2,$3,$4)', [
      job.id,
      'enum-worker',
      third.fence,
      'IMAGE_PROVIDER_UNAVAILABLE'
    ]);
    await control('retry', { jobId: job.id, idempotencyKey: 'enum-retry-02' });
    const fourth = await claim();
    expect(fourth.cursor).toEqual(cursor);
    await db.root(
      'select public.service_catalog_image_enumeration_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6)',
      [job.id, 'enum-worker', fourth.fence, JSON.stringify([entry]), '[]', true]
    );
    const complete = await control('get', { jobId: job.id });
    expect(complete.state).toBe('completed');
    expect(complete.errorCode).toBeNull();
    expect(complete.entries).toHaveLength(1);
    expect(complete.entries[0]!.state).toBe('ready');
    expect(complete.counts.ready).toBe(1);
  });
  it('uses retryable backpressure for the ninth active upload and frees capacity only on trusted terminal work', async () => {
    const job = await control('begin', {
      teamId: team,
      contractVersion: 2,
      sourceKind: 'local',
      idempotencyKey: 'capacity-job-01'
    });
    const manifest = await control('manifest', {
      jobId: job.id,
      pageKey: 'capacity-page-01',
      entries: Array.from({ length: 9 }, (_, index) => ({
        name: `IMG_${index}.png`,
        clientFileKey: `capacity-file-${index}`,
        declaredSize: 68,
        declaredMime: 'image/png',
        classification: classifyCatalogImageName(`IMG_${index}.png`)
      }))
    });
    await control('seal', { jobId: job.id, revision: manifest.revision, manifestCount: 9 });
    for (const entry of manifest.entries.slice(0, 8))
      await control('grant', {
        jobId: job.id,
        entryId: entry.id,
        generation: 0,
        requestKey: `capacity-${entry.id}`
      });
    const ninth = {
      jobId: job.id,
      entryId: manifest.entries[8]!.id,
      generation: 0,
      requestKey: 'capacity-ninth-01'
    };
    await expect(control('grant', ninth)).rejects.toThrow(/IMAGE_UPLOAD_CAPACITY_BUSY/u);
    await control('delivered', {
      jobId: job.id,
      entryId: manifest.entries[0]!.id,
      grantGeneration: 1,
      requestKey: 'capacity-delivered-01'
    });
    await expect(control('grant', ninth)).rejects.toThrow(/IMAGE_UPLOAD_CAPACITY_BUSY/u);
    await db.root("update private.catalog_image_import_entries set state='failed' where id=$1", [
      manifest.entries[0]!.id
    ]);
    await control('grant', ninth);
    const latest = await control('get', { jobId: job.id });
    await control('cancel', {
      jobId: job.id,
      revision: latest.revision,
      idempotencyKey: 'capacity-cancel-01'
    });
  });
  it('frees abandoned collecting quota immediately when its manager loses authority', async () => {
    await db.root(
      "update public.team_members set base_role='admin' where team_id=$1 and user_id=$2",
      [team, VIEWER]
    );
    const job = await control(
      'begin',
      {
        teamId: team,
        contractVersion: 2,
        sourceKind: 'local',
        idempotencyKey: 'authority-collecting-01'
      },
      VIEWER
    );
    await db.root(
      "update public.team_members set base_role='viewer' where team_id=$1 and user_id=$2",
      [team, VIEWER]
    );
    expect((await control('get', { jobId: job.id })).state).toBe('cancelled');
  });
  it('registers every metadata consumer with the task cleanup reference fence', async () => {
    expect(
      (await db.root<{ ok: boolean }>('select private.task_cleanup_coverage_verified() ok'))[0]!.ok
    ).toBe(true);
  });
  it('admits fresh v2 requests while preserving proven accepted legacy receipt identity', async () => {
    const credential = (
      await db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-r2','r2@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [OWNER]
      )
    )[0]!.id;
    const connection = (
      await db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root-r2','Root','my_drive','connected',now()) returning id",
        [team, credential]
      )
    )[0]!.id;
    const video = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'r2-video','video.mp4','file','video','video/mp4','1') returning id",
        [team, connection]
      )
    )[0]!.id;
    const owner = '45000000-0000-4000-8000-000000000088';
    const payload = {
      teamId: team,
      videoMaterialId: video,
      sourceLink: 'https://example.test/catalog',
      productCount: 3,
      replacesMaterialId: null
    };
    const begin = 'select public.service_begin_catalog_intent($1,$2,$3,$4,$5::jsonb,$6) v';
    await db.root("update private.catalog_image_config set mode='legacy' where team_id=$1", [team]);
    const accepted = (
      await db.root<{ v: { id: string } }>(begin, [
        team,
        video,
        OWNER,
        'accepted-legacy-01',
        JSON.stringify(payload),
        owner
      ])
    )[0]!.v;
    await db.root("update private.catalog_image_config set mode='v2' where team_id=$1", [team]);
    expect(
      (
        await db.root<{ v: number }>(
          'select public.service_catalog_image_request_version_v2($1,$2,$3,$4) v',
          [team, video, OWNER, 'accepted-legacy-01']
        )
      )[0]!.v
    ).toBe(1);
    expect(
      (
        await db.root<{ v: { id: string } }>(begin, [
          team,
          video,
          OWNER,
          'accepted-legacy-01',
          JSON.stringify(payload),
          owner
        ])
      )[0]!.v.id
    ).toBe(accepted.id);
    await expect(
      db.root(begin, [team, video, OWNER, 'new-old-client-01', JSON.stringify(payload), owner])
    ).rejects.toThrow(/CATALOG_IMAGE_UPGRADE_REQUIRED/u);
    expect(
      await db.root(
        'select id from private.catalog_generation_intents where team_id=$1 and request_key=$2',
        [team, 'new-old-client-01']
      )
    ).toHaveLength(0);
    const v2 = { ...payload, catalogImageContractVersion: 2 };
    await db.root(begin, [team, video, OWNER, 'new-v2-client-01', JSON.stringify(v2), owner]);
    expect(
      (
        await db.root<{ v: number }>(
          'select public.service_catalog_image_request_version_v2($1,$2,$3,$4) v',
          [team, video, OWNER, 'new-v2-client-01']
        )
      )[0]!.v
    ).toBe(2);
    await expect(
      db.root(begin, [team, video, OWNER, 'accepted-legacy-01', JSON.stringify(v2), owner])
    ).rejects.toThrow(/REQUEST_REUSE_CONFLICT/u);
    await expect(
      db.asUser(OWNER, 'select public.set_team_product_catalog_image_sources($1,$2::jsonb)', [
        team,
        '[]'
      ])
    ).rejects.toThrow(/CATALOG_IMAGE_UPGRADE_REQUIRED/u);
    const catalog = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'r2-catalog','catalog','file','other','application/vnd.google-apps.spreadsheet','1') returning id",
        [team, connection]
      )
    )[0]!.id;
    await db.root(
      "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://example.test/video','{}',$4,1)",
      [catalog, team, video, OWNER]
    );
    await db.root(
      'insert into public.team_catalog_updaters(team_id) values($1) on conflict do nothing',
      [team]
    );
    await db.root(
      'insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,reconciliation_required) values($1,$2,clock_timestamp(),true)',
      [catalog, team]
    );
    const updateAttempt = (
      await db.root<{ attempt_id: string }>(
        'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.attempt_id;
    const pub = (
      await db.root<{ id: string }>(
        'select id from private.catalog_image_publications where team_id=$1',
        [team]
      )
    )[0]!.id;
    await db.root(
      "insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity,state) values($1,$2,$3,'refresh:1','unknown')",
      [team, pub, updateAttempt]
    );
    const marker = '45000000-0000-4000-8000-000000000077';
    await db.root(
      "insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot) values($1,$2,1,3,'{}')",
      [catalog, marker]
    );
    await db.root("update private.catalog_image_publications set state='revoking' where id=$1", [
      pub
    ]);
    await expect(
      db.root(
        "select public.service_resolve_catalog_reconciliation($1,$2,'delivered','reconciliation-worker')",
        [catalog, marker]
      )
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    expect(
      await db.root(
        'select marker from private.catalog_update_reconciliations where catalog_material_id=$1',
        [catalog]
      )
    ).toHaveLength(1);
    expect(
      (
        await db.root<{ state: string }>(
          'select state from private.catalog_image_uses where catalog_attempt_id=$1',
          [updateAttempt]
        )
      )[0]!.state
    ).toBe('unknown');
    await db.root("update private.catalog_image_publications set state='ready' where id=$1", [pub]);
    expect(
      (
        await db.root<{ v: boolean }>(
          "select public.service_resolve_catalog_reconciliation($1,$2,'delivered','reconciliation-worker') v",
          [catalog, marker]
        )
      )[0]!.v
    ).toBe(true);
    expect(
      (
        await db.root<{ state: string }>(
          'select state from private.catalog_image_uses where catalog_attempt_id=$1',
          [updateAttempt]
        )
      )[0]!.state
    ).toBe('committed');
    // Completion removes an unscheduled item. Open and claim a distinct new round;
    // its normal insert/update trigger creates the canonical attempt, with no R2 draw/use.
    await db.root(
      "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,lease_owner,lease_expires_at) values($1,$2,clock_timestamp(),'retained-worker',clock_timestamp()+interval '5 minutes') on conflict(catalog_material_id) do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
      [catalog, team]
    );
    const retainedAttempts = await db.root<{ attempt_id: string; result: string }>(
      'select a.attempt_id,a.result from public.team_catalog_update_attempts a join public.team_catalog_updater_items i on i.catalog_material_id=a.catalog_material_id and i.round_due_at=a.round_due_at where i.catalog_material_id=$1',
      [catalog]
    );
    expect(retainedAttempts).toHaveLength(1);
    expect(retainedAttempts[0]!.result).toBe('running');
    const retainedAttempt = retainedAttempts[0]!.attempt_id;
    expect(retainedAttempt).not.toBe(updateAttempt);
    expect(
      (
        await db.root<{ id: string }>(
          'select public.service_catalog_image_update_attempt_v2($1,$2) id',
          [catalog, 'retained-worker']
        )
      )[0]!.id
    ).toBe(retainedAttempt);
    expect(
      await db.root(
        'select row_identity from private.catalog_image_uses where catalog_attempt_id=$1',
        [retainedAttempt]
      )
    ).toHaveLength(0);
    const retained = (
      await db.root<{ image: Record<string, unknown> }>(
        "select jsonb_build_object('kind','r2','publicationId',publication_id,'poolEntryId',id,'publicUrl',public_url,'classification',classification,'revision',1) image from public.team_catalog_image_pool_entries where team_id=$1",
        [team]
      )
    )[0]!.image;
    const outgoing = { rows: [{ title: 'New text only', pictureImage: retained }] };
    const complete = 'select public.service_complete_catalog_update($1,$2,$3,null,3,$4::jsonb) v';
    await expect(
      db.root(complete, [
        catalog,
        'retained-worker',
        2,
        JSON.stringify({
          rows: [{ pictureImage: { ...retained, publicUrl: 'https://wrong.example/image' } }]
        })
      ])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await db.root("update private.catalog_image_publications set state='revoked' where id=$1", [
      pub
    ]);
    await expect(
      db.root(complete, [catalog, 'retained-worker', 2, JSON.stringify(outgoing)])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    expect(
      (
        await db.root<{ update_count: number }>(
          'select update_count from public.team_product_catalogs where material_id=$1',
          [catalog]
        )
      )[0]!.update_count
    ).toBe(1);
    await db.root(
      'update public.team_catalog_updater_items set lease_owner=null,lease_expires_at=null,reconciliation_required=true where catalog_material_id=$1',
      [catalog]
    );
    const retainedMarker = '45000000-0000-4000-8000-000000000078';
    await db.root(
      'insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot) values($1,$2,2,3,$3::jsonb)',
      [catalog, retainedMarker, JSON.stringify(outgoing)]
    );
    await expect(
      db.root(
        "select public.service_resolve_catalog_reconciliation($1,$2,'delivered','retained-worker')",
        [catalog, retainedMarker]
      )
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    expect(
      await db.root(
        'select marker from private.catalog_update_reconciliations where catalog_material_id=$1',
        [catalog]
      )
    ).toHaveLength(1);
    await db.root("update private.catalog_image_publications set state='ready' where id=$1", [pub]);
    expect(
      (
        await db.root<{ v: boolean }>(
          "select public.service_resolve_catalog_reconciliation($1,$2,'delivered','retained-worker') v",
          [catalog, retainedMarker]
        )
      )[0]!.v
    ).toBe(true);
    expect(
      (
        await db.root<{ update_count: number }>(
          'select update_count from public.team_product_catalogs where material_id=$1',
          [catalog]
        )
      )[0]!.update_count
    ).toBe(2);
    expect(
      await db.root(
        'select row_identity from private.catalog_image_uses where catalog_attempt_id=$1',
        [retainedAttempt]
      )
    ).toHaveLength(0);
  });
  it('keeps purge tombstones after deleting the team', async () => {
    const before = await db.root<{ object_key: string }>(
      'select object_key from private.catalog_image_publications where team_id=$1',
      [team]
    );
    expect(before).toHaveLength(1);
    await db.root('delete from public.teams where id=$1', [team]);
    expect(
      await db.root('select id from private.catalog_image_purges where scope_id=$1 and reason=$2', [
        team,
        'team_deleted'
      ])
    ).toHaveLength(1);
    expect(
      await db.root('select id from private.catalog_image_publications where team_id=$1', [team])
    ).toHaveLength(0);
  });
});
