import { catalogDriveScope } from '../supabase/functions/_shared/catalog-drive-scope';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  CATALOG_TIMING_STAGES,
  catalogTimings,
  timeCatalogMethods
} from '../supabase/functions/_shared/catalog-timings';
import { parseCatalogPerformance } from '../scripts/analytics/catalog-generations';
import { catalogConflictSearchPrefix } from '../supabase/functions/drive-ops/handler';
import { GoogleDriveClient, proveLiveAncestry } from '../supabase/functions/_shared/drive';
import { providerFile } from './fixtures/catalog-sync';
import { ensureAnyoneReader } from '../supabase/functions/_shared/link-sharing';
const owner = '45000000-0000-4000-8000-000000000101';
let db: TeamTestDb;
let team: string;
const migration = '20261207123000_catalog_native_sheet_timings.sql';

it('records failed boundaries, joins totals, bounds collection and excludes all arguments/results', async () => {
  let clock = 0;
  const timings = catalogTimings(2, () => clock);
  const target = timeCatalogMethods(
    {
      async run(_secret: string) {
        clock += 13;
        throw Error('private-content');
      }
    },
    timings,
    { run: 'sheet_upload' }
  );
  await expect(target.run('Bearer private')).rejects.toThrow('private-content');
  await expect(target.run('https://private.invalid')).rejects.toThrow();
  expect(timings.snapshot()).toEqual({
    attempt: 2,
    steps: { sheet_upload: { calls: 2, total_ms: 26 } }
  });
  expect(parseCatalogPerformance(timings.snapshot(), 2)).toEqual(timings.snapshot());
  expect(parseCatalogPerformance(timings.snapshot(), 3)).toBeNull();
  expect(
    parseCatalogPerformance({ attempt: 2, steps: { sheet_upload: { calls: 1, total_ms: -1 } } }, 2)
  ).toBeNull();
});

it('preserves real Drive private-field receivers through both measured and unmeasured methods', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(providerFile())));
  const drive = timeCatalogMethods(
    new GoogleDriveClient('test-token-long-enough', fetcher),
    catalogTimings(1),
    { listAnyonePermissions: 'permission_read' }
  );
  expect((await drive.getFile('video')).id).toBe(providerFile().id);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('shares the observed permission list while still proving the newly granted permission', async () => {
  const drive = {
    listAnyonePermissions: vi.fn(async () => [{ id: 'permission', role: 'reader' }]),
    createAnyoneReaderPermission: vi.fn(async () => ({ id: 'permission', role: 'reader' as const }))
  };
  await ensureAnyoneReader(drive, 'video', []);
  expect(drive.listAnyonePermissions).toHaveBeenCalledOnce();
  drive.listAnyonePermissions.mockResolvedValueOnce([]);
  await expect(ensureAnyoneReader(drive, 'video', [])).rejects.toMatchObject({
    code: 'SHARE_NOT_ALLOWED'
  });
});

it('narrows Drive discovery with escaped prefixes and retains pagination and coverage', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ files: [providerFile()], nextPageToken: 'next' }))
    );
  const drive = new GoogleDriveClient('test-token-long-enough', fetcher);
  expect(
    await drive.listChildren({ parentId: 'root', namePrefix: "a\\b'c", pageToken: 'previous' })
  ).toMatchObject({ nextPageToken: 'next', complete: false });
  const url = fetcher.mock.calls[0]![0] as URL;
  expect(url.searchParams.get('q')).toBe(
    "'root' in parents and trashed = false and name contains 'a\\\\b\\'c'"
  );
  expect(url.searchParams.get('pageToken')).toBe('previous');
  expect(catalogConflictSearchPrefix('IN 40.v2_catalog')).toBe('IN');
  expect(catalogConflictSearchPrefix('IN40.v2_catalog')).toBe('IN40');
  expect(catalogConflictSearchPrefix('відео_catalog')).toBeUndefined();
});

it('joins in-flight OAuth clients only within the same credential and request', async () => {
  const create = vi.fn(async () => new GoogleDriveClient('test-token-long-enough'));
  const first = catalogDriveScope(create);
  const clients = await Promise.all([
    first.driveFor('a'),
    first.driveFor('a'),
    first.driveFor('b')
  ]);
  expect(create).toHaveBeenCalledTimes(2);
  expect(clients[0]).toBe(clients[1]);
  expect(clients[0]).not.toBe(clients[2]);
  await catalogDriveScope(create).driveFor('a');
  expect(create).toHaveBeenCalledTimes(3);
});

it('caches ancestors without treating a previously read target as fresh', async () => {
  const getFile = vi.fn(
    async (id: string) =>
      ({
        ...providerFile(),
        id,
        parents: id === 'video' ? ['folder'] : ['root'],
        trashed: false
      }) as never
  );
  const cache = new Map<string, ReturnType<typeof getFile>>();
  const readAncestor = (id: string) => {
    let value = cache.get(id);
    if (!value) {
      value = getFile(id);
      cache.set(id, value);
    }
    return value;
  };
  await proveLiveAncestry({
    client: { getFile },
    fileId: 'video',
    rootFolderId: 'root',
    readAncestor
  });
  await proveLiveAncestry({
    client: { getFile },
    fileId: 'video',
    rootFolderId: 'root',
    readAncestor
  });
  expect(getFile.mock.calls.map(([id]) => id)).toEqual(['video', 'folder', 'video']);
});

describe('canonical catalog performance SQL', () => {
  beforeAll(async () => {
    db = await createTeamTestDb({ throughMigration: migration });
    await createUser(db, { id: owner, email: 'performance@example.test' });
    await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
    team = (
      await db.asUser<{ id: string }>(owner, "select id from public.create_team('Performance')")
    )[0]!.id;
    await db.root(
      "insert into private.catalog_image_config(team_id,mode,import_enabled) values($1,'v2',true) on conflict(team_id) do update set mode='v2',import_enabled=true",
      [team]
    );
    await db.root(
      `with pubs as (insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state,public_url)
      select $1,repeat(n::text,64),68,'image/png',1,1,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}'::jsonb,'ready','https://media.example/'||n from generate_series(1,3) n returning *)
      insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification) select team_id,id,public_url,classification from pubs`,
      [team]
    );
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  async function draw(count: number, attempt: string | null = null) {
    return (
      await db.root<{ v: Array<{ poolEntryId: string; publicationId: string }> }>(
        'select public.service_draw_product_catalog_images_v2($1,$2,$3) v',
        [team, count, attempt]
      )
    )[0]!.v;
  }
  it('exhausts the current round before repeats, cycles small pools, and saves exact retries', async () => {
    const first = await draw(2);
    const second = await draw(4, owner);
    expect(new Set([...first, ...second.slice(0, 1)].map(x => x.poolEntryId)).size).toBe(3);
    expect(new Set(second.slice(1).map(x => x.poolEntryId)).size).toBe(3);
    expect(await draw(4, owner)).toEqual(second);
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.catalog_image_uses where catalog_attempt_id=$1',
          [owner]
        )
      )[0]!.n
    ).toBe(4);
    await db.root('select public.service_catalog_image_validate_uses_v2($1,$2)', [team, owner]);
    await db.root('select public.service_catalog_image_finalize_uses_v2($1,$2,true)', [
      team,
      owner
    ]);
    await db.root('select public.service_catalog_image_finalize_uses_v2($1,$2,false)', [
      team,
      owner
    ]);
    expect(
      (
        await db.root<{ n: number }>(
          "select count(*)::int n from private.catalog_image_uses where catalog_attempt_id=$1 and state='committed'",
          [owner]
        )
      )[0]!.n
    ).toBe(4);
    expect(
      (
        await db.root<{ n: number }>(
          "select count(*)::int n from public.analytics_catalog_image_journal where team_id=$1 and stage='use_committed'",
          [team]
        )
      )[0]!.n
    ).toBe(4);
    expect(await draw(400)).toHaveLength(400);
    await db.root(
      'update public.team_catalog_image_pool_entries set active=(id=$2::uuid) where team_id=$1',
      [team, first[0]!.poolEntryId]
    );
    expect(new Set((await draw(400)).map(image => image.poolEntryId))).toEqual(
      new Set([first[0]!.poolEntryId])
    );
    await db.root(
      'update public.team_catalog_image_pool_entries set active=false where team_id=$1',
      [team]
    );
    expect(await draw(1)).toEqual([]);
    await expect(
      db.root('select public.service_draw_product_catalog_images_v2($1,null)', [team])
    ).rejects.toThrow(/INVALID_INPUT/u);
    await db.root("update private.catalog_image_publications set state='revoked' where id=$1", [
      second[0]!.publicationId
    ]);
    await expect(
      db.root('select public.service_catalog_image_validate_uses_v2($1,$2)', [team, owner])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await expect(
      db.root('select public.service_catalog_image_finalize_uses_v2($1,$2,true)', [team, owner])
    ).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
    await expect(draw(4, owner)).rejects.toThrow(/IMAGE_PUBLICATION_REVOKED/u);
  });
  it('indexes the exact privacy-projected diagnostic key used by every image-use trigger', async () => {
    const rows = await db.root<{ definition: string }>(
      "select pg_get_indexdef(indexrelid) definition from pg_index where indexrelid='private.catalog_image_journal_evidence_id'::regclass"
    );
    expect(rows[0]!.definition).toContain('(seq)::text');
    await db.root('set enable_seqscan=off');
    try {
      const plan = await db.root<Record<string, string>>(
        "explain select stage,code from public.analytics_catalog_image_journal where evidence_id='123'"
      );
      expect(JSON.stringify(plan)).toContain('catalog_image_journal_evidence_id');
    } finally {
      await db.root('reset enable_seqscan');
    }
  });
  it('projects only allowlisted numeric timings and rejects browser execution of the combined RPC', async () => {
    const output = await db.root<{ v: unknown }>(
      `select private.catalog_generation_timings_v1($1::jsonb) v`,
      [
        JSON.stringify({
          attempt: 1,
          secret: 'Bearer private',
          steps: {
            sheet_upload: { calls: 1, total_ms: 42, url: 'https://private.invalid' },
            private: { calls: 1, total_ms: 1 }
          }
        })
      ]
    );
    expect(output[0]!.v).toEqual({
      attempt: 1,
      steps: { sheet_upload: { calls: 1, total_ms: 42 } }
    });
    const steps = Object.fromEntries(
      CATALOG_TIMING_STAGES.map(stage => [stage, { calls: 1, total_ms: 7 }])
    );
    expect(
      (
        await db.root<{ v: unknown }>('select private.catalog_generation_timings_v1($1::jsonb) v', [
          JSON.stringify({ attempt: 1, steps })
        ])
      )[0]!.v
    ).toEqual({ attempt: 1, steps });
    const grants = await db.root<{ allowed: boolean }>(
      "select has_function_privilege('authenticated','public.service_checkpoint_launch_catalog_intent_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid,jsonb,uuid,text,text,text)','execute') allowed"
    );
    expect(grants[0]!.allowed).toBe(false);
  });
  it('atomically validates both real fences and parent binding before advancing either journal', async () => {
    const launch = (
      await db.root<{ id: string }>(
        'insert into public.team_launches(team_id,created_by) values($1,$2) returning id',
        [team, owner]
      )
    )[0]!.id;
    const revision = (
      await db.root<{ id: string }>(
        `insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)
      values($1,$2,1,'generated','{"method":"other"}','{}','https://example.invalid','https://example.invalid','{}',$3) returning id`,
        [team, launch, owner]
      )
    )[0]!.id;
    const generation = (
      await db.root<{ id: string }>(
        `insert into public.team_launch_generations(team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,lease_owner,lease_expires_at)
      values($1,$2,$3,$4,'performance-generation','digest','1','running','parent',clock_timestamp()+interval '180 seconds') returning id`,
        [team, launch, revision, owner]
      )
    )[0]!.id;
    const intent = (
      await db.root<{ id: string }>(
        `insert into private.catalog_generation_intents(team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,lease_owner,lease_expires_at)
      values($1,$2,$2,$3,'digest','{}',1,$2,clock_timestamp()+interval '180 seconds') returning id`,
        [team, owner, `launch:${generation}:catalog`]
      )
    )[0]!.id;
    const checkpoint = (childFence: string, parentFence: string) =>
      db.root(
        `select public.service_checkpoint_launch_catalog_intent_v1($1,$2,$3,$3,$4,'planned','{"rows":true}',null,null,$5,'parent',$6,'catalog_planning')`,
        [team, intent, owner, childFence, generation, parentFence]
      );
    await expect(checkpoint('bad', '1')).rejects.toThrow(/LEASE_MISMATCH/u);
    expect(
      (
        await db.root<{ stage: string }>(
          'select stage from public.team_launch_generations where id=$1',
          [generation]
        )
      )[0]!.stage
    ).toBe('accepted');
    await expect(checkpoint('1', 'bad')).rejects.toThrow(/LEASE_MISMATCH/u);
    expect(
      (
        await db.root<{ checkpoint: unknown }>(
          'select checkpoint from private.catalog_generation_intents where id=$1',
          [intent]
        )
      )[0]!.checkpoint
    ).toEqual({});
    await db.root(
      "update private.catalog_generation_intents set request_key='unrelated-intent' where id=$1",
      [intent]
    );
    await expect(checkpoint('1', '1')).rejects.toThrow(/PERMISSION_DENIED/u);
    expect(
      (
        await db.root<{ stage: string }>(
          'select stage from public.team_launch_generations where id=$1',
          [generation]
        )
      )[0]!.stage
    ).toBe('accepted');
    await db.root('update private.catalog_generation_intents set request_key=$2 where id=$1', [
      intent,
      `launch:${generation}:catalog`
    ]);
    await checkpoint('1', '1');
    expect(
      (
        await db.root<{ stage: string }>(
          'select stage from public.team_launch_generations where id=$1',
          [generation]
        )
      )[0]!.stage
    ).toBe('catalog_planning');
    expect(
      (
        await db.root<{ checkpoint: unknown }>(
          'select checkpoint from private.catalog_generation_intents where id=$1',
          [intent]
        )
      )[0]!.checkpoint
    ).toEqual({ rows: true });
  });
});
