import { installCatalogContentGenerationProjection } from './support/catalog-content-diagnostic-fragments';
import { planCatalogRows } from '../supabase/functions/_shared/product-catalog';
import { getInspect } from '../scripts/analytics/queries';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { launchDriveMetadata } from './fixtures/launches';
import {
  catalogIntentStore,
  createDurableProductCatalog
} from '../supabase/functions/drive-ops/catalog-durable';
import type { ProductCatalogDeps } from '../supabase/functions/drive-ops/product-catalog';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { getCatalogGenerationEvidence } from '../scripts/analytics/catalog-generations';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigatePrivacyFailure } from '../scripts/analytics/types';

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const body = {
  teamId: ID,
  videoMaterialId: ID,
  sourceLink: 'https://private.invalid',
  productCount: 2,
  replacesMaterialId: null,
  idempotencyKey: 'standalone-fixture'
};
let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`create schema private;
    create role anon;create role authenticated;create role service_role;create role wishly_analytics_ro;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role,wishly_analytics_ro;
    create table public.team_operations(id uuid,team_id uuid,actor_id uuid,state text);
    create function private.can(uuid,text,uuid) returns boolean language sql as 'select true';
    create table private.catalog_generation_intents(
      id uuid primary key,team_id uuid,actor_id uuid,video_material_id uuid,operation_id uuid,
      attempt int default 1,variant int default 1,fence bigint default 1,request_key text,state text,
      safe_error_code text,created_at timestamptz default now(),updated_at timestamptz default now(),
      checkpoint jsonb default '{}',result jsonb,lease_owner uuid,lease_expires_at timestamptz,next_attempt_at timestamptz
    );
    insert into private.catalog_generation_intents(id,team_id,actor_id,video_material_id,request_key,state)
    values('${ID}','${ID}','${ACTOR}','${ID}','standalone-fixture','reserved');`);
  const source = readFileSync(
    'supabase/migrations/20261201113000_catalog_generation_recovery.sql',
    'utf8'
  );
  const checkpoint = source.match(
    /create function public\.service_checkpoint_catalog_intent\([\s\S]*?\nend \$\$;/u
  )?.[0];
  if (!checkpoint) throw new Error('Canonical checkpoint function missing');
  await db.exec(checkpoint);
  await db.exec(
    readFileSync('supabase/migrations/20261207113000_catalog_generation_diagnostics.sql', 'utf8')
  );
  await db.exec(
    readFileSync(
      'supabase/migrations/20261207115000_catalog_generation_failure_diagnostics.sql',
      'utf8'
    )
  );
  await db.exec(
    readFileSync('supabase/migrations/20261207121000_catalog_creation_performance.sql', 'utf8')
  );
  await db.exec(
    readFileSync('supabase/migrations/20261207123000_catalog_native_sheet_timings.sql', 'utf8')
  );
  await installCatalogContentGenerationProjection(db);
}, 30_000);
afterAll(async () => {
  await db.close();
});

// Acceptance is a pre-existing opaque receipt fixture. Every checkpoint goes
// through the production store adapter and exact production SQL with its fences.
function service(): ServiceRpcClient {
  return {
    async rpc(name, p) {
      if (
        name === 'service_catalog_image_request_version_v2' ||
        name === 'service_reconcile_catalog_result'
      )
        return { data: null, error: null };
      if (name === 'service_begin_catalog_intent') {
        const row = (
          await db.db.query<Record<string, unknown>>(
            `update private.catalog_generation_intents set lease_owner=$1,lease_expires_at=clock_timestamp()+interval '180 seconds',fence=fence+1
         where id=$2 returning id,variant,state,fence::text,attempt,checkpoint,result,operation_id`,
            [p.p_owner, ID]
          )
        ).rows[0];
        return { data: { ...row, operationId: row.operation_id }, error: null };
      }
      if (name === 'service_checkpoint_catalog_intent') {
        await db.db.query(
          `select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            p.p_team,
            p.p_intent,
            p.p_actor,
            p.p_owner,
            p.p_fence,
            p.p_state,
            JSON.stringify(p.p_checkpoint),
            p.p_operation,
            p.p_result
          ]
        );
        return { data: null, error: null };
      }
      throw new Error('Unexpected RPC in selected dependency refusal');
    }
  };
}

it.each(['parent', 'type'] as const)(
  'persists actual %s refusal through durable SQL and the private diagnostic projection',
  async reason => {
    await db.db.query(
      "update private.catalog_generation_intents set state='reserved',checkpoint='{}',safe_error_code=null,result=null,operation_id=null"
    );
    const forbidden = vi.fn(async () => {
      throw new Error('Publication must not start');
    });
    const drive = {
      getFile: forbidden,
      listAnyonePermissions: forbidden,
      createAnyoneReaderPermission: forbidden,
      createConvertedFile: forbidden,
      updateFileMetadata: forbidden,
      findCatalogIntentFiles: forbidden
    };
    const deps: ProductCatalogDeps = {
      loadVideo: async () => ({
        id: ID,
        name: 'private-video.mp4',
        category: 'video',
        driveFileId: 'private-provider-id',
        resourceKey: null,
        parentFolderId: 'folder',
        credentialId: 'private-credential'
      }),
      readSettings: async () => ({
        title: 'private-content',
        description: 'private-content',
        imageLink: 'https://private.invalid',
        priceMin: 10,
        priceMax: 20
      }),
      readLiveCatalogs: async () => [],
      driveFor: async () => drive,
      proveVideo: async () => ({
        ...launchDriveMetadata(),
        id: 'private-provider-id',
        name: 'private-video.mp4',
        parents: [reason === 'parent' ? 'moved-parent' : 'folder'],
        mimeType: reason === 'type' ? 'image/png' : 'video/mp4'
      }),
      resolveRestitchedVideo: forbidden,
      drawTexts: forbidden,
      drawImages: forbidden,
      nextVariant: forbidden,
      destination: forbidden,
      planName: forbidden,
      startOperation: forbidden,
      bindIntent: forbidden,
      markRunning: forbidden,
      failOperation: forbidden,
      finalize: forbidden,
      link: forbidden,
      log: vi.fn()
    };
    const store = catalogIntentStore(service(), ID, ID, ACTOR, body.idempotencyKey);
    await expect(
      createDurableProductCatalog(deps, store, async () => drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(forbidden).not.toHaveBeenCalled();
    const stored = (
      await db.db.query<{ legacy_code: string | null; checkpoint_code: string }>(
        "select safe_error_code legacy_code,checkpoint->>'safeErrorCode' checkpoint_code from private.catalog_generation_intents where id=$1",
        [ID]
      )
    ).rows[0];
    expect(stored).toEqual({ legacy_code: null, checkpoint_code: 'SOURCE_CHANGED' });
    const evidence = await getCatalogGenerationEvidence(ACTOR, resolvePeriod('all', undefined));
    expect(evidence).toMatchObject({
      supported: true,
      records: [{ intent_id: ID, state: 'interrupted', safe_error_code: 'SOURCE_CHANGED' }]
    });
    expect(evidence.records[0]?.performance).toMatchObject({
      attempt: 1,
      steps: {
        video_proof: { calls: 1 },
        video_context: { calls: 1 }
      }
    });
    expect(investigatePrivacyFailure(evidence)).toBeNull();
    expect(JSON.stringify(evidence)).not.toMatch(
      /private-provider-id|private-credential|private-content|private-video|private\.invalid|moved-parent/
    );
    const owner = crypto.randomUUID();
    const intent = await store.begin(body, owner);
    await store.checkpoint(intent, owner, 'planning', {});
    expect(
      (await getCatalogGenerationEvidence(ACTOR, resolvePeriod('all', undefined))).records[0]
        .safe_error_code
    ).toBeNull();
  }
);

it('carries a frozen automatic recipe through the real store and SQL to exact-ID inspect without implying visible delivery', async () => {
  await db.db.query(
    "update private.catalog_generation_intents set state='reserved',checkpoint='{\"contentPolicyVersion\":1}',safe_error_code=null,result=null,operation_id=null"
  );
  const store = catalogIntentStore(service(), ID, ID, ACTOR, body.idempotencyKey);
  const owner = crypto.randomUUID();
  const intent = await store.begin(body, owner);
  const selected = await getCatalogGenerationEvidence(ID, resolvePeriod('all', undefined));
  expect(selected.records[0]).toMatchObject({
    content_receipt_status: 'policy_selected',
    content_policy_version: 1,
    planned_row_count: null
  });
  const rowRecipe = planCatalogRows({
    count: 2,
    random: () => 0.5,
    texts: [],
    settings: {
      title: null,
      description: null,
      imageLink: null,
      priceMin: 20,
      priceMax: 40,
      contentPolicyVersion: 1
    },
    images: [
      { link: 'https://private.invalid/a', name: 'tshirt_black_001.png' },
      { link: 'https://private.invalid/b', name: 'wrap-dress_coral_001.png' }
    ]
  });
  if (!rowRecipe) throw new Error('Expected automatic rows');
  await store.checkpoint(intent, owner, 'planned', {
    rowRecipe,
    sheetRows: [['private-content']],
    content_policy_version: 1,
    planned_row_count: 2,
    automatic_row_count: 2,
    retained_row_count: 0
  });
  const evidence = await getCatalogGenerationEvidence(ID, resolvePeriod('all', undefined));
  expect(evidence.records[0]).toMatchObject({
    content_receipt_status: 'frozen',
    content_policy_version: 1,
    planned_row_count: 2,
    automatic_row_count: 2,
    retained_row_count: 0
  });
  const inspect = await getInspect(ID);
  expect(inspect).toMatchObject({
    found: true,
    capability: 'team.product_catalog',
    terminal: null,
    stages: {
      observed: expect.arrayContaining(['content_recipe_frozen', 'rows_planned']),
      missing: expect.arrayContaining(['result_visible'])
    }
  });
  expect(JSON.stringify(inspect)).not.toContain(rowRecipe[0].title);
  expect(JSON.stringify(inspect)).not.toMatch(/private-content|private-provider|garment|variantId/);
  expect(investigatePrivacyFailure(inspect)).toBeNull();
});

it.each([
  'GLOBAL_IMAGE_POOL_UNAVAILABLE',
  'GLOBAL_IMAGE_ALLOCATION_UNKNOWN',
  'IMAGE_TEXT_PAIRING_CONFLICT'
])('preserves %s from a real fenced failure checkpoint to diagnosis', async code => {
  const store = catalogIntentStore(service(), ID, ID, ACTOR, body.idempotencyKey);
  const owner = crypto.randomUUID();
  const intent = await store.begin(body, owner);
  await store.checkpoint(intent, owner, 'interrupted', { safeErrorCode: code });
  const evidence = await getCatalogGenerationEvidence(ID, resolvePeriod('all', undefined));
  expect(evidence.records[0]).toMatchObject({ safe_error_code: code, state: 'interrupted' });
  expect(investigatePrivacyFailure(evidence)).toBeNull();
});

it('fails closed for invalid SQL receipts without failing diagnosis or changing operation success', async () => {
  const valid = {
    contentPolicyVersion: 1,
    content_policy_version: 1,
    planned_row_count: 2,
    automatic_row_count: 2,
    retained_row_count: 0,
    rowRecipe: [{ title: 'private-content' }, { title: 'private-content' }]
  };
  for (const patch of [
    { contentPolicyVersion: 2 },
    { content_policy_version: 2 },
    { planned_row_count: 401 },
    { planned_row_count: '2' },
    { automatic_row_count: 1 },
    { retained_row_count: -1 },
    { rowRecipe: [] },
    { planned_row_count: 1e100 }
  ]) {
    await db.db.query(
      "update private.catalog_generation_intents set state='registered',checkpoint=$1,safe_error_code=null",
      [JSON.stringify({ ...valid, ...patch })]
    );
    const result = await getInspect(ID);
    expect(result).toMatchObject({
      found: true,
      terminal: { outcome: 'success' },
      catalog_generations: {
        unknown_projection: true,
        records: [
          {
            content_receipt_status: 'invalid',
            content_policy_version: null,
            planned_row_count: null
          }
        ]
      }
    });
    expect(investigatePrivacyFailure(result)).toBeNull();
  }
  const malformed = await db.db.query<{ receipt: unknown }>(
    "select private.catalog_content_diagnostic_receipt('[]'::jsonb,null) receipt"
  );
  expect(malformed.rows[0].receipt).toEqual({
    status: 'unavailable',
    content_policy_version: null
  });
});

it('exposes bounded numeric receipt evidence to the real read-only role but never the recipe', async () => {
  await db.exec('set role wishly_analytics_ro');
  try {
    const rows = (
      await db.db.query(
        'select content_receipt_status,content_policy_version,planned_row_count from public.analytics_catalog_generations'
      )
    ).rows;
    expect(rows).toHaveLength(1);
    await expect(
      db.db.query('select checkpoint from private.catalog_generation_intents')
    ).rejects.toThrow(/permission denied/u);
  } finally {
    await db.exec('reset role');
  }
});
