import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig, launchDriveMetadata } from './fixtures/launches';
import {
  runLaunchCleanupTick,
  runLaunchCatalogRecovery
} from '../supabase/functions/drive-ops/launch-recovery';
import { vi } from 'vitest';
import { getCatalogUpdateDiagnosis } from '../scripts/analytics/catalog-updates';
import { getLaunchEvidence } from '../scripts/analytics/launches';
import { setQueryExecutor } from '../scripts/analytics/db';
import { updateLaunchCatalog } from './support/launch-catalog-updater';
import {
  launchPreview,
  launchRevisionImpact,
  parseLaunchSources,
  type LaunchConfig
} from '../packages/shared/src/team/launches';
const ACTOR = '72000000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let material: string;
let agent: string;
let buyer: string;
let offer: string;
let account: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'launch-state@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  team = (
    await db.asUser<{ id: string }>(ACTOR, "select id from public.create_team('Launch state')")
  )[0].id;
  account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g1') returning id",
      [team, ACTOR]
    )
  )[0].id;
  agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'1234567892') returning id",
      [team, account, ACTOR]
    )
  )[0].id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('perm-launch','test@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [ACTOR]
    )
  )[0].id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0].id;
  material = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'launch-video','v5.mp4','file','video','video/mp4','1') returning id",
      [team, connection]
    )
  )[0].id;
  buyer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'buyers','patrik','state-buyer-001') v",
      [team]
    )
  )[0].v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'offers','ProCaps TR','state-offer-001') v",
      [team]
    )
  )[0].v.id;
  await db.root(
    "insert into public.team_product_catalog_settings(team_id,title,description,price,image_link,updated_by) values($1,'Launch product','Synthetic description',10,'https://example.invalid/image.jpg',$2)",
    [team, ACTOR]
  );
}, 90_000);
afterAll(async () => {
  await db?.close();
});
it('prepares restitch from the selected video and duration without any saved workspace setup', async () => {
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 3,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const g = await accept(p.args);
  const read = async () =>
    (
      await db.asUser<{
        v: {
          defaults: { automaticEndFrame: boolean; customFinalDurationSeconds: number };
          draw: { screens: unknown[] };
          processKey: string;
        };
      }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [team, g.id])
    )[0].v;
  const preparation = await read();
  expect(preparation.defaults).toMatchObject({
    automaticEndFrame: true,
    customFinalDurationSeconds: 120
  });
  expect(preparation.draw.screens).toEqual([]);
  expect(await read()).toEqual(preparation);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from public.team_restitch_defaults where team_id=$1',
        [team]
      )
    )[0].n
  ).toBe(0);
  expect(
    (
      await db.root<{ stage: string; state: string }>(
        'select stage,state from public.team_launch_generations where id=$1',
        [g.id]
      )
    )[0]
  ).toMatchObject({ stage: 'restitch_preparing', state: 'waiting_dependency' });
});

it('uses the space image pool when its owner creates a Launch and records an empty pool explicitly', async () => {
  const pictures = await db.root<{ id: string }>(
    `insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)
     select team_id,connection_id,'launch-screen-'||n,'root','screen.png','file','image','image/png',100,repeat(n::text,32),'1'
     from public.team_materials cross join generate_series(1,2) n where id=$1 returning id`,
    [material]
  );
  try {
    await db.asUser(ACTOR, 'select public.set_restitch_defaults($1,$2::jsonb)', [
      team,
      JSON.stringify({ operation: 'restitch', sourceMode: 'drive' })
    ]);
    for (const [index, slot] of ['start', 'end'].entries())
      await db.asUser(ACTOR, 'select public.set_restitch_sources($1,$2,$3::jsonb)', [
        team,
        slot,
        JSON.stringify([{ materialId: pictures[index].id }])
      ]);
    const p = await prepare({
      method: 'catalog',
      catalog: {
        productCount: 3,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120
      }
    });
    const g = await accept(p.args);
    const first = (
      await db.asUser<{ v: { draw: { screens: { slot: string; materialId: string }[] } } }>(
        ACTOR,
        'select public.prepare_launch_restitch($1,$2) v',
        [team, g.id]
      )
    )[0].v;
    expect(first).toMatchObject({
      draw: {
        screens: [
          { slot: 'start', materialId: pictures[0].id },
          { slot: 'end', materialId: pictures[1].id }
        ]
      }
    });
    expect(
      (
        await db.asUser<{ v: unknown }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [
          team,
          g.id
        ])
      )[0].v
    ).toEqual(first);
    const settingsVersion = async (actor = ACTOR) =>
      (
        await db.root<{ v: string }>('select private.launch_restitch_settings_version($1,$2) v', [
          team,
          actor
        ])
      )[0].v;
    const originalVersion = await settingsVersion();
    const member = crypto.randomUUID();
    await createUser(db, { id: member, email: 'launch-pool-member@example.test' });
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
      [team, member]
    );
    const createForMember = async () => {
      const pending = await prepare(
        {
          method: 'catalog',
          catalog: {
            productCount: 3,
            restitchEnabled: true,
            finalDurationMode: 'custom',
            customFinalDurationSeconds: 120
          }
        },
        member
      );
      const accepted = await accept(pending.args);
      return (
        await db.asUser<{ v: unknown }>(member, 'select public.prepare_launch_restitch($1,$2) v', [
          team,
          accepted.id
        ])
      )[0].v;
    };
    expect(await settingsVersion(member)).toBe(originalVersion);
    expect(await createForMember()).toMatchObject({ draw: first.draw });
    await db.asUser(member, 'select public.set_member_restitch_defaults($1,$2::jsonb)', [
      team,
      JSON.stringify({ operation: 'restitch', sourceMode: 'drive', endEnabled: false })
    ]);
    await db.asUser(member, 'select public.set_member_restitch_sources($1,$2,$3::jsonb)', [
      team,
      'start',
      JSON.stringify([{ materialId: pictures[1].id }])
    ]);
    expect(await settingsVersion(member)).not.toBe(originalVersion);
    expect(await createForMember()).toMatchObject({
      draw: { screens: [{ slot: 'start', materialId: pictures[1].id }] }
    });
    await db.asUser(member, 'select public.set_member_restitch_use_owner($1,true)', [team]);
    expect(await createForMember()).toMatchObject({ draw: first.draw });
    for (const slot of ['start', 'end'])
      await db.asUser(ACTOR, "select public.set_restitch_sources($1,$2,'[]'::jsonb)", [team, slot]);
    expect(await settingsVersion()).not.toBe(originalVersion);
    expect(
      (
        await db.asUser<{ v: unknown }>(
          ACTOR,
          'select public.prepare_launch_restitch($1,$2,$3::uuid[]) v',
          [team, g.id, [pictures[0].id]]
        )
      )[0].v
    ).toEqual({ errorCode: 'SOURCE_CHANGED' });
    const empty = await prepare({
      method: 'catalog',
      catalog: {
        productCount: 3,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120
      }
    });
    const failed = await accept(empty.args);
    expect(
      (
        await db.asUser<{ v: unknown }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [
          team,
          failed.id
        ])
      )[0].v
    ).toEqual({ errorCode: 'RESTITCH_POOL_EMPTY' });
    expect(
      (
        await db.root<{ stage: string; state: string; safe_error_code: string }>(
          'select stage,state,safe_error_code from public.analytics_launch_generations where generation_id=$1',
          [failed.id]
        )
      )[0]
    ).toMatchObject({
      stage: 'restitch_preparing',
      state: 'failed',
      safe_error_code: 'RESTITCH_POOL_EMPTY'
    });
  } finally {
    await db.root('delete from public.team_restitch_defaults where team_id=$1', [team]);
    await db.root('delete from public.team_restitch_sources where team_id=$1', [team]);
  }
});

it('freezes catalog settings before video work and rejects changes before the first resource plan', async () => {
  const p = await prepare({ method: 'catalog' });
  const g = await accept(p.args);
  const frozen = (
    await db.root<{ v: { settings: { title: string }; settingsVersion: string } }>(
      'select private.freeze_launch_catalog_resources($1,$2,$3) v',
      [team, g.id, ACTOR]
    )
  )[0].v;
  expect(frozen.settings.title).toBe('Launch product');
  await db.root(
    "update public.team_launch_generations set safe_error_code='AGENT_REQUIRED' where id=$1",
    [g.id]
  );
  const diagnostic = (
    await db.root<{ safe_error_code: string; steps: unknown }>(
      'select safe_error_code,steps from public.analytics_launch_generations where generation_id=$1',
      [g.id]
    )
  )[0];
  expect(diagnostic.safe_error_code).toBe('AGENT_REQUIRED');
  expect(JSON.stringify(diagnostic.steps)).not.toContain('Launch product');
  await db.root(
    "update public.team_product_catalog_settings set title='Changed after freeze' where team_id=$1",
    [team]
  );
  expect(
    (
      await db.root<{ v: unknown }>('select private.freeze_launch_catalog_resources($1,$2,$3) v', [
        team,
        g.id,
        ACTOR
      ])
    )[0].v
  ).toEqual(frozen);
  const next = await prepare({ method: 'catalog' });
  const nextGeneration = await accept(next.args);
  await db.root(
    "update public.team_product_catalog_settings set title='Changed before freeze' where team_id=$1",
    [team]
  );
  await expect(
    db.root('select private.freeze_launch_catalog_resources($1,$2,$3)', [
      team,
      nextGeneration.id,
      ACTOR
    ])
  ).rejects.toThrow('SOURCE_CHANGED');
  expect(
    (
      await db.root<{ n: number }>(
        "select count(*)::integer n from public.team_launch_generation_steps where generation_id=$1 and stable_step_key='catalog_resources'",
        [nextGeneration.id]
      )
    )[0].n
  ).toBe(0);
  await db.root(
    "update public.team_product_catalog_settings set title='Launch product' where team_id=$1",
    [team]
  );
  for (const [launch, generation] of [
    [p.id, g.id],
    [next.id, nextGeneration.id]
  ])
    await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
      team,
      launch,
      generation,
      `resource-test-cleanup-${generation}`
    ]);
  await db.root('select public.service_settle_launch_batch(10)');
});
let seq = 0;
async function prepare(
  overrides: Partial<import('../packages/shared/src/team/launches').LaunchConfig> = {},
  actor = ACTOR
) {
  const config = launchConfig({
    agentRowId: agent,
    materialId: material,
    buyerId: buyer,
    offerId: offer,
    ...overrides
  });
  const key = `state-draft-${++seq}`;
  const saved = (
    await db.asUser<{ v: { id: string; version: string } }>(
      actor,
      'select public.save_launch_draft($1,null,null,$2,$3,null) v',
      [team, key, JSON.stringify(config)]
    )
  )[0].v;
  const source = (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_sources($1,$2) v', [
      team,
      saved.id
    ])
  )[0].v;
  const parsed = parseLaunchSources(source);
  expect(parsed).not.toBeNull();
  if (!parsed) throw new Error('fixture');
  const savedSource = (
    await db.asUser<{ v: { id: string; version: string } }>(
      actor,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [
        team,
        saved.id,
        saved.version,
        `${key}-source`,
        JSON.stringify(config),
        JSON.stringify(source)
      ]
    )
  )[0].v;
  const preview = launchPreview(config, parsed);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error('fixture');
  const args = [
    team,
    saved.id,
    actor,
    savedSource.version,
    `state-generate-${seq}`,
    `digest-${seq}`,
    JSON.stringify(config),
    JSON.stringify(source),
    JSON.stringify(preview.value)
  ];
  return { id: saved.id, args, config };
}
async function accept(args: unknown[]) {
  return (
    await db.root<{
      v: { id: string; revisionId: string; fence: string; state: string; replayed: boolean };
    }>('select public.service_accept_launch_generation($1,$2,$3,$4,$5,$6,$7,$8,$9) v', args)
  )[0].v;
}
describe('Launch authoritative state', () => {
  it('rejects a renamed Buyer before acceptance and replays an accepted immutable intent', async () => {
    const p = await prepare();
    await db.root(
      "update public.team_launch_buyers set value='renamed_buyer',normalized_key='renamed_buyer' where id=$1",
      [buyer]
    );
    await expect(accept(p.args)).rejects.toThrow('SOURCE_CHANGED');
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
          [p.id]
        )
      )[0].n
    ).toBe(0);
    await db.root(
      "update public.team_launch_buyers set value='patrik',normalized_key='patrik' where id=$1",
      [buyer]
    );
    const accepted = await accept(p.args);
    await db.root(
      "update public.team_launch_buyers set value='renamed_buyer',normalized_key='renamed_buyer' where id=$1",
      [buyer]
    );
    const replay = await accept(p.args);
    expect(replay.id).toBe(accepted.id);
    expect(replay.replayed).toBe(true);
    expect(
      (
        await db.root<{ buyer: string; sub1: string }>(
          "select sources->>'buyer' buyer,sub_values->>'sub1' sub1 from public.team_launch_revisions where id=$1",
          [accepted.revisionId]
        )
      )[0]
    ).toEqual({ buyer: 'patrik', sub1: 'patrik' });
    await db.root(
      "update public.team_launch_buyers set value='patrik',normalized_key='patrik' where id=$1",
      [buyer]
    );
  });
  it('rejects source rename at the same Launch version before accepting an intent', async () => {
    const p = await prepare();
    await db.root("update public.team_accounts set name='g2' where id=$1", [account]);
    await expect(accept(p.args)).rejects.toThrow('SOURCE_CHANGED');
    const count = (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
        [p.id]
      )
    )[0].n;
    expect(count).toBe(0);
    await db.root("update public.team_accounts set name='g1' where id=$1", [account]);
  });
  it('rejects a removed creative before accepting a new generation', async () => {
    const p = await prepare();
    await db.root(
      "update public.team_materials set lifecycle='missing',missing_at=now() where id=$1",
      [material]
    );
    try {
      await expect(accept(p.args)).rejects.toThrow('SOURCE_CHANGED');
      await expect(
        db.asUser(ACTOR, 'select public.get_launch_sources($1,$2)', [team, p.id])
      ).rejects.toThrow('SOURCE_CHANGED');
      const count = (
        await db.root<{ n: number }>(
          'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
          [p.id]
        )
      )[0].n;
      expect(count).toBe(0);
    } finally {
      await db.root(
        "update public.team_materials set lifecycle='active',missing_at=null where id=$1",
        [material]
      );
    }
  });
  it('locks edits, replays once, cancel fences late publication and leaves draft intact', async () => {
    const p = await prepare();
    const g = await accept(p.args);
    const replay = await accept(p.args);
    expect(replay.id).toBe(g.id);
    expect(replay.replayed).toBe(true);
    await expect(
      db.asUser(
        ACTOR,
        "select public.save_launch_draft($1,$2,'3','locked-draft-request','{}',null)",
        [team, p.id]
      )
    ).rejects.toThrow('LAUNCH_BUSY');
    await db.asUser(ACTOR, "select public.cancel_launch_generation($1,$2,$3,'state-cancel-001')", [
      team,
      p.id,
      g.id
    ]);
    await expect(
      db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
        team,
        g.id,
        ACTOR,
        g.fence
      ])
    ).rejects.toThrow('WRONG_STATE');
    const detail = (
      await db.asUser<{
        v: { activeRevision: unknown; draft: unknown; generation: { state: string } };
      }>(ACTOR, 'select public.get_launch($1,$2,null) v', [team, p.id])
    )[0].v;
    expect(detail.activeRevision).toBeNull();
    expect(detail.draft).toEqual(p.config);
    expect(detail.generation.state).toBe('canceled');
  });
  it('success before cancel wins; historical snapshots remain immutable after source rename', async () => {
    const p = await prepare();
    const g = await accept(p.args);
    await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
      team,
      g.id,
      ACTOR,
      g.fence
    ]);
    const canceled = (
      await db.asUser<{ v: { state: string } }>(
        ACTOR,
        "select public.cancel_launch_generation($1,$2,$3,'state-cancel-002') v",
        [team, p.id, g.id]
      )
    )[0].v;
    expect(canceled.state).toBe('succeeded');
    await db.root("update public.team_accounts set name='g3' where id=$1", [account]);
    const detail = (
      await db.asUser<{ v: { activeRevision: { baseline: { campaigns: { name: string }[] } } } }>(
        ACTOR,
        'select public.get_launch($1,$2,null) v',
        [team, p.id]
      )
    )[0].v;
    expect(detail.activeRevision.baseline.campaigns[0].name).toContain('[g1-892-v5]');
    await expect(
      db.root("update public.team_launch_revisions set generated_url='bad' where id=$1", [
        g.revisionId
      ])
    ).rejects.toThrow('WRONG_STATE');
    await db.root("update public.team_accounts set name='g1' where id=$1", [account]);
  });
});

it('saves manual revisions without mutating baseline or generating operations', async () => {
  const p = await prepare();
  const g = await accept(p.args);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    g.id,
    ACTOR,
    g.fence
  ]);
  const detail = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v;
  const overrides = {
    advertisingUrl: 'https://example.invalid/manual',
    campaigns: { '1': { budget: '77', name: 'manually changed' } }
  };
  await db.asUser(
    ACTOR,
    "select public.save_launch_overrides($1,$2,$3,$4,'manual-result-save',$5)",
    [team, p.id, g.revisionId, detail.version, JSON.stringify(overrides)]
  );
  const saved = (
    await db.asUser<{
      v: {
        activeRevision: {
          kind: string;
          overrides: unknown;
          baseline: { advertisingUrl: string; campaigns: { budget: number }[] };
        };
      };
    }>(ACTOR, 'select public.get_launch($1,$2,null) v', [team, p.id])
  )[0].v;
  expect(saved.activeRevision.kind).toBe('manual');
  expect(saved.activeRevision.overrides).toEqual(overrides);
  expect(saved.activeRevision.baseline.campaigns[0].budget).toBe(10);
  expect(saved.activeRevision.baseline.advertisingUrl).not.toBe(overrides.advertisingUrl);
  const count = (
    await db.root<{ n: number }>(
      'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
      [p.id]
    )
  )[0].n;
  expect(count).toBe(1);
});
it('atomically saves a working draft and manual outputs before historical restore, with replay and rollback on baseline conflict', async () => {
  const p = await prepare();
  const generation = await accept(p.args);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    generation.id,
    ACTOR,
    generation.fence
  ]);
  type Detail = { version: string; draft: { age: number }; activeRevision: { overrides: unknown } };
  const read = async () =>
    (
      await db.asUser<{ v: Detail }>(ACTOR, 'select public.get_launch($1,$2,null) v', [team, p.id])
    )[0].v;
  const before = await read();
  const config = JSON.stringify({ ...p.config, age: 50 });
  const overrides = JSON.stringify({ campaigns: { '1': { name: 'Saved before restore' } } });
  const sql =
    'select public.save_launch_working_copy($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb) v';
  await expect(
    db.asUser(ACTOR, sql, [
      team,
      p.id,
      before.version,
      'working-copy-bad-baseline',
      config,
      p.args[7],
      crypto.randomUUID(),
      overrides
    ])
  ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  expect(await read()).toEqual(before);
  const args = [
    team,
    p.id,
    before.version,
    'working-copy-save-once',
    config,
    p.args[7],
    generation.revisionId,
    overrides
  ];
  const saved = await db.asUser<{ v: { id: string; version: string } }>(ACTOR, sql, args);
  expect(await db.asUser(ACTOR, sql, args)).toEqual(saved);
  const after = await read();
  expect(after.version).toBe(saved[0].v.version);
  expect(after.draft.age).toBe(50);
  expect(after.activeRevision.overrides).toEqual(JSON.parse(overrides));
  expect(
    (
      await db.root<{ count: number }>(
        'select count(*)::integer count from public.team_launch_generations where launch_id=$1',
        [p.id]
      )
    )[0].count
  ).toBe(1);
});

it('reserves distinct catalog variants and refuses simultaneous executors of the same intent', async () => {
  const one = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: 'https://example.invalid/catalog',
    productCount: 3,
    replacesMaterialId: null
  };
  const owner = '72000000-0000-4000-8000-000000000010';
  const call = 'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v';
  const first = (
    await db.root<{ v: { id: string; variant: number; fence: string } }>(call, [
      team,
      material,
      ACTOR,
      'catalog-reservation-001',
      JSON.stringify(one),
      owner
    ])
  )[0].v;
  const same = (
    await db.root<{ v: { id: string; variant: number; fence: string } }>(call, [
      team,
      material,
      ACTOR,
      'catalog-reservation-001',
      JSON.stringify(one),
      owner
    ])
  )[0].v;
  expect(first.id).toBe(same.id);
  expect(first.variant).toBe(same.variant);
  const second = (
    await db.root<{ v: { variant: number } }>(call, [
      team,
      material,
      ACTOR,
      'catalog-reservation-002',
      JSON.stringify(one),
      owner
    ])
  )[0].v;
  expect(second.variant).toBe(first.variant + 1);
  await expect(
    db.root(call, [
      team,
      material,
      ACTOR,
      'catalog-reservation-001',
      JSON.stringify(one),
      '72000000-0000-4000-8000-000000000011'
    ])
  ).rejects.toThrow('GROUP_RECONCILING');
  await expect(
    db.root(call, [
      team,
      material,
      ACTOR,
      'catalog-reservation-001',
      JSON.stringify({ ...one, productCount: 4 }),
      owner
    ])
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});

it('fences every coordinator checkpoint after cancel and retains the previous result', async () => {
  const p = await prepare();
  const accepted = await accept(p.args);
  const owner = 'launch-worker-test';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  await db.root(
    "select public.service_touch_launch_generation($1,$2,$3,$4,$5,'catalog_creating')",
    [team, accepted.id, ACTOR, owner, claim.fence]
  );
  await db.asUser(
    ACTOR,
    "select public.cancel_launch_generation($1,$2,$3,'cancel-catalog-fence')",
    [team, p.id, accepted.id]
  );
  await expect(
    db.root("select public.service_touch_launch_generation($1,$2,$3,$4,$5,'catalog_registering')", [
      team,
      accepted.id,
      ACTOR,
      owner,
      claim.fence
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  await expect(
    db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', [
      team,
      accepted.id,
      ACTOR,
      owner,
      claim.fence
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  const detail = (
    await db.asUser<{ v: { activeRevision: unknown; generation: { state: string } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(detail.activeRevision).toBeNull();
  expect(detail.generation.state).toBe('cancel_requested');
});

it('rejects malformed workspace defaults without persisting them', async () => {
  const subs = { schemaVersion: 1, sub1: ['buyer'], sub2: [], sub3: [] };
  for (const config of [
    { campaignCount: 0 },
    { maxBudget: 1.2 },
    { age: 9007199254740992 },
    { gender: null },
    { advantagePlus: 'true' },
    {
      catalog: {
        productCount: 3,
        restitchEnabled: false,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 3660
      }
    }
  ]) {
    await expect(
      db.asUser(ACTOR, 'select public.set_launch_defaults($1,null,$2,$3,$4)', [
        team,
        `invalid-defaults-${++seq}`,
        JSON.stringify(config),
        JSON.stringify(subs)
      ])
    ).rejects.toThrow('INVALID_INPUT');
  }
  await expect(
    db.asUser(ACTOR, 'select public.set_launch_defaults($1,null,$2,$3,$4)', [
      team,
      `invalid-subs-${++seq}`,
      '{}',
      JSON.stringify({ schemaVersion: 1 })
    ])
  ).rejects.toThrow('INVALID_INPUT');
  const saved = (
    await db.asUser<{ v: { version: string } }>(
      ACTOR,
      'select public.set_launch_defaults($1,null,$2,$3,$4) v',
      [
        team,
        `valid-defaults-${++seq}`,
        JSON.stringify({ campaignCount: 3, maxBudget: 30, age: 100 }),
        JSON.stringify(subs)
      ]
    )
  )[0].v;
  expect(saved.version).toBe('1');
});

it('updates a published catalog manually and on schedule, reuses it, and preserves Launch history', async () => {
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    material,
    'a'.repeat(32)
  ]);
  const p = await prepare({
    method: 'catalog',
    catalog: { ...launchConfig().catalog, productCount: 3 }
  });
  const accepted = await accept(p.args);
  const owner = 'catalog-executor-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  const url = (
    await db.root<{ url: string }>(
      'select generated_url url from public.team_launch_revisions where id=$1',
      [accepted.revisionId]
    )
  )[0].url;
  const key = `launch:${accepted.id}:catalog`;
  const childOwner = '72000000-0000-4000-8000-000000000020';
  const payload = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: url,
    productCount: 3,
    replacesMaterialId: null,
    restitchOperationId: null,
    idempotencyKey: key,
    randomLinkVariation: true
  };
  const intent = (
    await db.root<{ v: { id: string; fence: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  const cat = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,'Launch catalog','file','other','application/vnd.google-apps.spreadsheet','1' from public.team_materials where id=$1 returning id",
      [material, `catalog-${seq}`]
    )
  )[0].id;
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog' where id=$1",
    [cat, material]
  );
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/launch-synthetic';
  await db.root(
    'insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,$4,3,$5,$6,$7,$8,$9)',
    [
      cat,
      team,
      material,
      url,
      sheetUrl,
      'https://drive.google.com/file/d/synthetic',
      JSON.stringify({
        title: 'Synthetic',
        description: 'Product',
        price: 10,
        imageLink: 'https://example.invalid/image.jpg'
      }),
      ACTOR,
      intent.variant
    ]
  );
  const result = {
    outcome: 'created',
    videoShared: false,
    catalog: {
      materialId: cat,
      name: 'Launch catalog',
      sheetUrl,
      sourceLink: url,
      productCount: 3,
      createdAt: null,
      variant: intent.variant
    }
  };
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered',jsonb_build_object('materialId',$7::text),null,$6)",
    [team, intent.id, ACTOR, childOwner, intent.fence, JSON.stringify(result), cat]
  );
  expect(
    (
      await db.asUser<{ v: { hasCatalog: boolean } }>(
        ACTOR,
        'select public.get_launch_archive_warning($1,$2) v',
        [team, p.id]
      )
    )[0].v.hasCatalog
  ).toBe(true);
  expect(
    (
      await db.root<{ retained: boolean }>(
        'select private.launch_output_is_referenced($1,$2) retained',
        [team, cat]
      )
    )[0].retained
  ).toBe(true);
  await db.root(
    'insert into public.team_catalog_updaters(team_id) values($1) on conflict do nothing',
    [team]
  );
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,update_interval,next_run_at,round_due_at) values($1,$2,'15h',now(),now())",
    [cat, team]
  );
  expect(
    (
      await db.root(
        'select update_interval,next_run_at,round_due_at from public.team_catalog_updater_items where catalog_material_id=$1',
        [cat]
      )
    )[0]
  ).toEqual({ update_interval: null, next_run_at: null, round_due_at: null });
  const recovered = (
    await db.root<{ v: boolean }>(
      'select public.service_restore_registered_launch_catalog($1,$2,$3,$4,$5) v',
      [team, accepted.id, ACTOR, owner, claim.fence]
    )
  )[0].v;
  expect(recovered).toBe(true);
  await expect(
    db.root('select public.service_restore_registered_launch_catalog($1,$2,$3,$4,$5)', [
      team,
      accepted.id,
      ACTOR,
      owner,
      '0'
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    claim.fence
  ]);
  const detail = (
    await db.asUser<{
      v: { version: string; activeRevision: { catalog: { materialId: string } } };
    }>(ACTOR, 'select public.get_launch($1,$2,null) v', [team, p.id])
  )[0].v;
  expect(detail.activeRevision.catalog.materialId).toBe(cat);
  // A published Launch owns an enduring reference, not a frozen working spreadsheet.
  let profile = (
    await db.root<{ version: number }>(
      'select version from public.team_catalog_update_profiles where catalog_material_id=$1',
      [cat]
    )
  )[0];
  for (const interval of ['1h', '1d', '1w', '15h']) {
    await db.asUser(ACTOR, 'select public.patch_team_catalog_update_profile($1,$2,$3,$4)', [
      team,
      cat,
      profile.version,
      JSON.stringify({
        updateInterval: interval,
        schedule: null,
        refreshImages: false,
        refreshTexts: false,
        growProducts: true,
        restitch: false
      })
    ]);
    profile = (
      await db.root<{ version: number }>(
        'select version from public.team_catalog_update_profiles where catalog_material_id=$1',
        [cat]
      )
    )[0];
  }
  const history = () =>
    db.root(
      'select to_jsonb(r) revision,to_jsonb(c) catalog from public.team_launch_revisions r join public.team_launch_revision_catalogs c on c.revision_id=r.id where r.launch_id=$1 order by r.created_at,r.id',
      [p.id]
    );
  const originalHistory = await history();
  expect(
    (
      await db.asUser<{ n: number }>(ACTOR, 'select public.run_team_catalog_update_now($1,$2) n', [
        team,
        [cat]
      ])
    )[0].n
  ).toBe(1);
  expect(await updateLaunchCatalog(db, cat)).toMatchObject({ updated: 1, failed: 0 });
  expect(await history()).toEqual(originalHistory);
  await db.root("update public.team_materials set drive_version='2' where id=$1", [material]);
  const config = { ...p.config, age: 50 };
  const sources = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_sources($1,$2) v', [
      team,
      p.id
    ])
  )[0].v;
  const saved = (
    await db.asUser<{ v: { version: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [
        team,
        p.id,
        detail.version,
        `reuse-draft-${++seq}`,
        JSON.stringify(config),
        JSON.stringify(sources)
      ]
    )
  )[0].v;
  const source = parseLaunchSources(sources);
  if (!source) throw new Error('fixture');
  const preview = launchPreview(config, source);
  if (!preview.ok) throw new Error('fixture');
  const generated = await accept([
    team,
    p.id,
    ACTOR,
    saved.version,
    `reuse-generation-${seq}`,
    'digest-reuse',
    JSON.stringify(config),
    JSON.stringify(sources),
    JSON.stringify(preview.value)
  ]);
  const newClaim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, generated.id, ACTOR, owner]
    )
  )[0].v;
  const reused = (
    await db.root<{ v: boolean }>('select public.service_reuse_launch_catalog($1,$2,$3,$4,$5) v', [
      team,
      generated.id,
      ACTOR,
      owner,
      newClaim.fence
    ])
  )[0].v;
  expect(reused).toBe(true);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    generated.id,
    ACTOR,
    newClaim.fence
  ]);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_product_catalogs where material_id=$1',
        [cat]
      )
    )[0].n
  ).toBe(1);
  await expect(
    db.root(
      "select public.service_start_team_operation($1,$2,'trash','protected-trash-request','protected-nonce',$3,null,null,null,null)",
      [team, ACTOR, cat]
    )
  ).rejects.toThrow('WRONG_STATE');
  const reusedHistory = await history();
  await db.root(
    "update public.team_catalog_updater_items set next_run_at=now()-interval '1 minute' where catalog_material_id=$1",
    [cat]
  );
  expect(await updateLaunchCatalog(db, cat)).toMatchObject({ rounds: 1, updated: 1, failed: 0 });
  expect(await history()).toEqual(reusedHistory);
  expect(
    (
      await db.root<{ update_count: number; sheet_url: string }>(
        'select update_count,sheet_url from public.team_product_catalogs where material_id=$1',
        [cat]
      )
    )[0]
  ).toEqual({ update_count: 2, sheet_url: sheetUrl });
  setQueryExecutor(async (sql, params) => db.root(sql, params));
  try {
    const diagnosis = await getCatalogUpdateDiagnosis(cat);
    expect(diagnosis.profile?.interval).toBe('15h');
    expect(diagnosis.attempts).toHaveLength(2);
    expect(diagnosis.attempts.map(attempt => attempt.trigger).sort()).toEqual([
      'manual',
      'schedule'
    ]);
    expect(
      diagnosis.attempts.every(attempt => attempt.result === 'success' && attempt.delivery_proven)
    ).toBe(true);
    expect(JSON.stringify(diagnosis)).not.toContain(sheetUrl);
    expect(JSON.stringify(diagnosis)).not.toContain(url);
  } finally {
    setQueryExecutor(null);
  }
  for (const kind of ['rename', 'move', 'content_edit', 'new_version']) {
    await expect(
      db.root(
        "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,$3,'pending',$4,$5,$6)",
        [team, ACTOR, kind, cat, `protected-${kind}-${++seq}`, `protected-nonce-${seq}`]
      )
    ).rejects.toThrow('WRONG_STATE');
  }
  await expect(
    db.root('select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)', [
      team,
      material,
      ACTOR,
      'recreate-protected-catalog',
      JSON.stringify({ ...payload, replacesMaterialId: cat }),
      childOwner
    ])
  ).rejects.toThrow('WRONG_STATE');
  const overwrite = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'upload','pending','launch-overwrite-attempt','launch-overwrite-nonce') returning id",
      [team, ACTOR]
    )
  )[0].id;
  for (const column of ['replace_material_id', 'version_of_material_id']) {
    // These are fixed test column identifiers, not user content.
    await expect(
      db.root(
        `insert into private.team_operation_intents(operation_id,team_id,${column}) values($1,$2,$3)`,
        [overwrite, team, cat]
      )
    ).rejects.toThrow('WRONG_STATE');
  }
  await expect(
    db.root('select public.service_link_product_catalog_companion($1,$2,$3,$4,$5)', [
      team,
      material,
      cat,
      cat,
      JSON.stringify({
        sourceLink: url,
        productCount: 100,
        sheetUrl,
        videoLink: 'https://example.invalid/video',
        settingsSnapshot: {},
        createdBy: ACTOR,
        variant: 1
      })
    ])
  ).rejects.toThrow('WRONG_STATE');
  const folder = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type) select team_id,connection_id,'launch-protected-folder','Protected folder','folder','application/vnd.google-apps.folder' from public.team_materials where id=$1 returning id",
      [material]
    )
  )[0].id;
  await db.root(
    "update public.team_materials set parent_folder_id='launch-protected-folder' where id=$1",
    [cat]
  );
  await expect(
    db.root(
      "select public.service_start_team_operation($1,$2,'trash','protected-folder-trash','protected-folder-nonce',$3,null,null,null,null)",
      [team, ACTOR, folder]
    )
  ).rejects.toThrow('WRONG_STATE');
});

it('normalizes dictionary spaces while rejecting controls and Cyrillic before storage', async () => {
  for (const value of [' guru\u00a0roman ', 'guru\u2003roman']) {
    const rows = await db.asUser<{ v: { value: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'buyers',$2,$3) v",
      [team, value, `dictionary-parity-${++seq}`]
    );
    expect(rows[0].v.value).toBe('guru_roman');
  }
  for (const value of ['guru\troman', 'guru\nroman', 'роман']) {
    await expect(
      db.asUser(ACTOR, "select public.create_launch_dictionary($1,'buyers',$2,$3)", [
        team,
        value,
        `dictionary-invalid-${++seq}`
      ])
    ).rejects.toThrow('LAUNCH_SUB_INVALID');
  }
});

it('dispatches and settles provider-free Launch work without an updater or browser', async () => {
  const p = await prepare();
  const accepted = await accept(p.args);
  await db.root(
    'update public.team_launch_generations set next_attempt_at=now(),lease_expires_at=null where id=$1',
    [accepted.id]
  );
  expect(
    (await db.root<{ due: boolean }>('select private.launch_settlement_due() due'))[0].due
  ).toBe(true);
  await db.root(
    'create or replace view vault.decrypted_secrets as select id,secret as decrypted_secret,name,now() as created_at from vault.secrets'
  );
  await db.root(
    "insert into vault.secrets(name,secret) values('wishly_catalog_sync_url','https://example.test/functions/v1/catalog-sync'),('wishly_catalog_sync_secret',repeat('x',32))"
  );
  await db.root(
    "create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 60000) returns bigint language sql as $$ select 123::bigint $$"
  );
  expect(
    (
      await db.root<{ request: number }>('select private.invoke_catalog_updater_worker() request')
    )[0].request
  ).toBe(123);
  const first = (
    await db.root<{ v: { completed: number } }>('select public.service_settle_launch_batch(3) v')
  )[0].v;
  expect(first.completed).toBeGreaterThanOrEqual(1);
  const detail = (
    await db.asUser<{ v: { generation: { state: string }; activeRevision: { id: string } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(detail.generation.state).toBe('succeeded');
  expect(detail.activeRevision.id).toBe(accepted.revisionId);
  expect(
    (
      await db.root<{ v: { completed: number } }>('select public.service_settle_launch_batch(3) v')
    )[0].v.completed
  ).toBe(0);
});

it('settles cancellation after a preparing-only attempt without touching external resources', async () => {
  const p = await prepare({ method: 'catalog' });
  const accepted = await accept(p.args);
  const owner = 'cancel-settlement-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  await db.root("select public.service_touch_launch_generation($1,$2,$3,$4,$5,'preparing')", [
    team,
    accepted.id,
    ACTOR,
    owner,
    claim.fence
  ]);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `cancel-settlement-${++seq}`
  ]);
  await db.root('update public.team_launch_generations set lease_expires_at=now() where id=$1', [
    accepted.id
  ]);
  const counts = (
    await db.root<{ v: { canceled: number } }>('select public.service_settle_launch_batch(3) v')
  )[0].v;
  expect(counts.canceled).toBe(1);
  const result = (
    await db.asUser<{ v: { activeRevision: unknown; generation: { state: string } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(result.activeRevision).toBeNull();
  expect(result.generation.state).toBe('canceled');
});

it('isolates an unavailable registered catalog instead of rolling back other settlements', async () => {
  const broken = await prepare({ method: 'catalog' });
  const bad = await accept(broken.args);
  const childOwner = '72000000-0000-4000-8000-000000000032';
  const key = `launch:${bad.id}:catalog`;
  const url = (
    await db.root<{ url: string }>(
      'select generated_url url from public.team_launch_revisions where id=$1',
      [bad.revisionId]
    )
  )[0].url;
  const payload = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: url,
    productCount: 100,
    replacesMaterialId: null,
    restitchOperationId: null,
    idempotencyKey: key,
    randomLinkVariation: true
  };
  const child = (
    await db.root<{ v: { id: string; fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered','{}',null,$6)",
    [
      team,
      child.id,
      ACTOR,
      childOwner,
      child.fence,
      JSON.stringify({ catalog: { materialId: '72000000-0000-4000-8000-000000000033' } })
    ]
  );
  const healthy = await prepare();
  const good = await accept(healthy.args);
  await db.root(
    'update public.team_launch_generations set next_attempt_at=now(),lease_expires_at=null where id=any($1::uuid[])',
    [[bad.id, good.id]]
  );
  const result = (
    await db.root<{ v: { completed: number } }>('select public.service_settle_launch_batch(3) v')
  )[0].v;
  expect(result.completed).toBe(1);
  const states = await db.root<{ id: string; state: string; safe_error_code: string | null }>(
    'select id,state,safe_error_code from public.team_launch_generations where id=any($1::uuid[])',
    [[bad.id, good.id]]
  );
  expect(states.find(row => row.id === bad.id)).toMatchObject({
    state: 'failed',
    safe_error_code: 'SOURCE_CHANGED'
  });
  expect(states.find(row => row.id === good.id)).toMatchObject({
    state: 'succeeded',
    safe_error_code: null
  });
  expect(
    (
      await db.root<{ v: { examined: number } }>('select public.service_settle_launch_batch(3) v')
    )[0].v.examined
  ).toBe(0);
});

it('claims cancellation cleanup, trashes only its unindexed output and fences late publication', async () => {
  const p = await prepare({ method: 'catalog' });
  const accepted = await accept(p.args);
  const owner = 'cleanup-parent-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  await db.root("select public.service_touch_launch_generation($1,$2,$3,$4,$5,'preparing')", [
    team,
    accepted.id,
    ACTOR,
    owner,
    claim.fence
  ]);
  const childOwner = '72000000-0000-4000-8000-000000000040';
  const key = `launch:${accepted.id}:catalog`;
  const child = (
    await db.root<{ v: { id: string; fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        material,
        ACTOR,
        key,
        JSON.stringify({ sourceLink: 'https://example.invalid/', productCount: 100 }),
        childOwner
      ]
    )
  )[0].v;
  const credential = (
    await db.root<{ id: string }>(
      'select c.credential_id id from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id where m.id=$1',
      [material]
    )
  )[0].id;
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'created',$6,null,null)",
    [
      team,
      child.id,
      ACTOR,
      childOwner,
      child.fence,
      JSON.stringify({
        createStarted: true,
        providerFileId: 'cleanup-sheet',
        parentId: 'parent',
        credentialId: credential
      })
    ]
  );
  await db.root(
    "select public.service_record_catalog_permission($1,$2,$3,$4,$5,'cleanup-sheet',$6,'sheet-grant',false,'created')",
    [team, child.id, ACTOR, childOwner, child.fence, credential]
  );
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `cleanup-cancel-${++seq}`
  ]);
  await db.root('update public.team_launch_generations set lease_expires_at=now() where id=$1', [
    accepted.id
  ]);
  await db.root(
    'update private.catalog_generation_intents set lease_expires_at=now() where id=$1',
    [child.id]
  );
  // A missing lease field must revoke cleanup authority, even when the fence matches.
  const cleanupOwner = '72000000-0000-4000-8000-000000000041';
  const plan = (
    await db.root<{ v: { generationId: string; fence: string; intentFence: string }[] }>(
      'select public.service_claim_launch_cleanup($1,3) v',
      [cleanupOwner]
    )
  )[0].v.find(item => item.generationId === accepted.id)!;
  expect(plan).toBeTruthy();
  const cleanupArgs = [
    team,
    accepted.id,
    cleanupOwner,
    plan.fence,
    plan.intentFence,
    'cleanup-sheet'
  ];
  for (const [table, id, column] of [
    ['public.team_launch_generations', accepted.id, 'lease_owner'],
    ['public.team_launch_generations', accepted.id, 'lease_expires_at'],
    ['private.catalog_generation_intents', child.id, 'lease_owner'],
    ['private.catalog_generation_intents', child.id, 'lease_expires_at']
  ]) {
    await db.root(`update ${table} set ${column}=null where id=$1`, [id]);
    expect(
      (
        await db.root<{ v: string }>(
          'select public.service_authorize_launch_cleanup($1,$2,$3,$4,$5,$6) v',
          cleanupArgs
        )
      )[0].v
    ).toBe('unknown');
    await expect(
      db.root('select public.service_finish_launch_cleanup($1,$2,$3,$4,$5,$6)', cleanupArgs)
    ).rejects.toThrow('LEASE_MISMATCH');
    await db.root(
      `update ${table} set lease_owner=$2,lease_expires_at=now()+interval '180 seconds' where id=$1`,
      [id, cleanupOwner]
    );
  }
  await db.root(
    'update public.team_launch_generations set lease_expires_at=now(),next_attempt_at=now() where id=$1',
    [accepted.id]
  );
  await db.root(
    'update private.catalog_generation_intents set lease_expires_at=now(),next_attempt_at=now() where id=$1',
    [child.id]
  );
  const names: Record<string, string[]> = {
    service_claim_launch_cleanup: ['p_owner', 'p_limit'],
    service_authorize_launch_cleanup: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence',
      'p_file'
    ],
    service_finish_launch_cleanup: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence',
      'p_cleaned_file'
    ]
  };
  const service = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = names[name];
      if (!keys) throw new Error('unexpected RPC');
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(',');
      const result = await db.root<{ v: unknown }>(
        `select public.${name}(${placeholders}) v`,
        keys.map(k => args[k])
      );
      return { data: result[0].v, error: null };
    }
  };
  const metadata = {
    ...launchDriveMetadata(),
    id: 'cleanup-sheet',
    appProperties: { 'soty.catalog.intent': child.id }
  };
  const trash = vi.fn(async () => ({ ...metadata, trashed: true }));
  const driveFor = vi.fn(async () => ({
    getFile: vi.fn(async () => metadata),
    updateFileMetadata: trash,
    listAnyonePermissions: vi.fn(async () => []),
    deletePermission: vi.fn(async () => undefined)
  }));
  expect(await runLaunchCleanupTick(service, driveFor)).toEqual({ completed: 1, pending: 0 });
  expect(trash).toHaveBeenCalledTimes(1);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_sharing where intent_id=$1 and file_id=$2',
        [child.id, 'cleanup-sheet']
      )
    )[0].state
  ).toBe('cleaned');
  expect(await runLaunchCleanupTick(service, driveFor)).toEqual({ completed: 0, pending: 0 });
  const detail = (
    await db.asUser<{ v: { generation: { state: string }; activeRevision: unknown } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(detail.generation.state).toBe('canceled');
  expect(detail.activeRevision).toBeNull();
  await expect(
    db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
      team,
      accepted.id,
      ACTOR,
      claim.fence
    ])
  ).rejects.toThrow('WRONG_STATE');
});

it('dispatches transient catalog recovery to the authenticated endpoint and avoids leased retries', async () => {
  const p = await prepare({ method: 'catalog' });
  const accepted = await accept(p.args);
  await db.root(
    'update public.team_launch_generations set next_attempt_at=now(),lease_expires_at=null where id=$1',
    [accepted.id]
  );
  await db.root('create table public.launch_dispatch_test(url text)');
  await db.root(
    "create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 60000) returns bigint language plpgsql as $$ begin insert into public.launch_dispatch_test values(url);return 123;end $$"
  );
  await db.root('select private.invoke_catalog_updater_worker()');
  const urls = await db.root<{ url: string }>('select url from public.launch_dispatch_test');
  expect(
    urls.some(row => row.url === 'https://example.test/functions/v1/drive-ops/launches/recover')
  ).toBe(true);
  const service = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_settle_launch_authority_losses')
        return {
          data: (
            await db.root<{ v: number }>(
              'select public.service_settle_launch_authority_losses($1) v',
              [args.p_limit]
            )
          )[0].v,
          error: null
        };
      expect(name).toBe('service_list_launch_catalog_recovery');
      return {
        data: (
          await db.root<{ v: unknown }>(
            'select public.service_list_launch_catalog_recovery($1) v',
            [args.p_limit]
          )
        )[0].v,
        error: null
      };
    }
  };
  const execute = vi.fn(async (t: string, g: string, a: string) => {
    await db.root('select public.service_claim_launch_generation($1,$2,$3,$4)', [
      t,
      g,
      a,
      'hosted-recovery-owner'
    ]);
    return { state: 'running' };
  });
  expect(await runLaunchCatalogRecovery(service, execute)).toEqual({ completed: 0, pending: 1 });
  expect(execute).toHaveBeenCalledWith(team, accepted.id, ACTOR);
  expect(await runLaunchCatalogRecovery(service, execute)).toEqual({ completed: 0, pending: 0 });
  await db.root(
    "update public.team_launch_generations set state='failed',safe_error_code='SOURCE_CHANGED',lease_expires_at=null,next_attempt_at=now() where id=$1",
    [accepted.id]
  );
  expect(await runLaunchCatalogRecovery(service, execute)).toEqual({ completed: 0, pending: 0 });
});

it('freezes Launch restitch settings and replays the same preparation without another draw', async () => {
  await db.root(
    'insert into public.team_restitch_defaults(team_id,configured,end_image_ids,updated_by) values($1,true,array[$2::uuid],$3) on conflict(team_id) do update set configured=true,end_image_ids=excluded.end_image_ids',
    [team, material, ACTOR]
  );
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(p.args);
  const first = (
    await db.asUser<{
      v: { defaults: { customFinalDurationSeconds: number }; processKey: string; draw: unknown };
    }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [team, accepted.id])
  )[0].v;
  expect(first.defaults.customFinalDurationSeconds).toBe(120);
  await db.asUser(ACTOR, 'select public.pause_launch_restitch($1,$2,$3)', [
    team,
    accepted.id,
    'AGENT_REQUIRED'
  ]);
  expect(
    (
      await db.root<{ state: string; safe_error_code: string }>(
        'select state,safe_error_code from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]
  ).toEqual({ state: 'waiting_dependency', safe_error_code: 'AGENT_REQUIRED' });
  await expect(
    db.asUser(ACTOR, 'select public.pause_launch_restitch($1,$2,$3)', [
      team,
      accepted.id,
      'RAW_PROVIDER_ERROR'
    ])
  ).rejects.toThrow('INVALID_INPUT');

  await db.root(
    'update public.team_restitch_defaults set custom_final_duration_seconds=300 where team_id=$1',
    [team]
  );
  const replay = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [
      team,
      accepted.id
    ])
  )[0].v;
  expect(replay).toEqual(first);
  const detail = (
    await db.asUser<{ v: { generation: { state: string } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(detail.generation.state).toBe('waiting_dependency');
  await expect(
    db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [
      team,
      accepted.id,
      '72000000-0000-4000-8000-000000000099'
    ])
  ).rejects.toThrow('WRONG_STATE');
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,'launch-child-nonce') returning id",
      [team, ACTOR, material, first.processKey]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [operation, team]
  );
  // Recover a start reply lost before bind without selecting a second child.
  const unbound = (
    await db.asUser<{ v: { operationId: string; processKey: string } }>(
      ACTOR,
      'select public.get_launch_restitch_preparation($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  expect(unbound.operationId).toBe(operation);
  expect(unbound.processKey).toBe(first.processKey);
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [
    team,
    accepted.id,
    operation
  ]);
  const beforeRead = (
    await db.root<{ stage: string; state_version: string }>(
      'select stage,state_version from public.team_launch_generations where id=$1',
      [accepted.id]
    )
  )[0];
  await db.asUser(ACTOR, 'select public.get_launch_restitch_preparation($1,$2)', [
    team,
    accepted.id
  ]);
  expect(
    (
      await db.root<{ stage: string; state_version: string }>(
        'select stage,state_version from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]
  ).toEqual(beforeRead);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `restitch-cancel-${++seq}`
  ]);
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        operation
      ])
    )[0].state
  ).toBe('canceled');
  await expect(
    db.asUser(ACTOR, 'select public.get_launch_restitch_preparation($1,$2)', [team, accepted.id])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await db.root<{ n: number }>(
        'select public.service_settle_launch_restitch_cancellations(3) n'
      )
    )[0].n
  ).toBe(1);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0].state
  ).toBe('canceled');
  expect(
    (
      await db.root<{ n: number }>(
        'select public.service_settle_launch_restitch_cancellations(3) n'
      )
    )[0].n
  ).toBe(0);
  await expect(
    db.root(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,'late-child-nonce')",
      [team, ACTOR, material, first.processKey]
    )
  ).rejects.toThrow('WRONG_STATE');
});

it('settles a completed restitch receipt once and never advances a canceled parent', async () => {
  await db.root(
    'insert into public.team_restitch_defaults(team_id,configured,end_image_ids,updated_by) values($1,true,array[$2::uuid],$3) on conflict(team_id) do update set configured=true,end_image_ids=excluded.end_image_ids',
    [team, material, ACTOR]
  );
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'random-centered',
      customFinalDurationSeconds: 180,
      finalDurationRangeSeconds: [120, 240]
    }
  });
  const accepted = await accept(p.args);
  const preparation = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,'settle-child-nonce') returning id",
      [team, ACTOR, material, preparation.processKey]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [operation, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [
    team,
    accepted.id,
    operation
  ]);
  expect(
    (await db.root<{ n: number }>('select public.service_settle_launch_restitch_batch(3) n'))[0].n
  ).toBe(0);
  await db.root("update public.team_operations set state='running' where id=$1", [operation]);
  const copy = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) select team_id,connection_id,$2,'restitch.mp4','file','video','video/mp4','1',$3 from public.team_materials where id=$1 returning id",
      [material, `restitch-${seq}`, 'b'.repeat(32)]
    )
  )[0].id;
  await db.root(
    "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
    [operation, copy]
  );
  expect(
    (await db.root<{ n: number }>('select public.service_settle_launch_restitch_batch(3) n'))[0].n
  ).toBe(1);
  expect(
    (await db.root<{ n: number }>('select public.service_settle_launch_restitch_batch(3) n'))[0].n
  ).toBe(0);
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0].state
  ).toBe('accepted');
  const owner = 'restitch-attach-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  const certified = (
    await db.root<{ v: { operationId: string; materialId: string } }>(
      'select public.service_launch_restitch_receipt($1,$2,$3,$4,$5) v',
      [team, accepted.id, ACTOR, owner, claim.fence]
    )
  )[0].v;
  expect(certified).toMatchObject({ operationId: operation, materialId: copy });
  await expect(
    db.root('select public.service_launch_restitch_receipt($1,$2,$3,$4,$5)', [
      team,
      accepted.id,
      ACTOR,
      owner,
      '0'
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  const url = (
    await db.root<{ url: string }>(
      'select generated_url url from public.team_launch_revisions where id=$1',
      [accepted.revisionId]
    )
  )[0].url;
  const key = `launch:${accepted.id}:catalog`;
  const childOwner = '72000000-0000-4000-8000-000000000025';
  const payload = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: url,
    productCount: 100,
    replacesMaterialId: null,
    restitchOperationId: operation,
    idempotencyKey: key,
    randomLinkVariation: true
  };
  const child = (
    await db.root<{ v: { id: string; fence: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  const cat = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,'Restitched catalog','file','other','application/vnd.google-apps.spreadsheet','1' from public.team_materials where id=$1 returning id",
      [material, `restitch-catalog-${seq}`]
    )
  )[0].id;
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog' where id=$1",
    [cat, material]
  );
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/restitch-synthetic';
  await db.root(
    'insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,$4,100,$5,$6,$7,$8,$9)',
    [
      cat,
      team,
      material,
      url,
      sheetUrl,
      'https://drive.google.com/file/d/original',
      JSON.stringify({
        title: 'Synthetic',
        description: 'Product',
        price: 10,
        imageLink: 'https://example.invalid/image.jpg'
      }),
      ACTOR,
      child.variant
    ]
  );
  const catalogResult = {
    outcome: 'created',
    videoShared: false,
    catalog: {
      materialId: cat,
      name: 'Restitched catalog',
      sheetUrl,
      sourceLink: url,
      productCount: 100,
      createdAt: null,
      variant: child.variant
    }
  };
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered','{}',null,$6)",
    [team, child.id, ACTOR, childOwner, child.fence, JSON.stringify(catalogResult)]
  );
  await expect(
    db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', [
      team,
      accepted.id,
      ACTOR,
      owner,
      claim.fence
    ])
  ).rejects.toThrow('SOURCE_CHANGED');
  await db.root(
    "insert into public.team_catalog_restitch_copies(material_id,catalog_material_id,team_id,role,drive_file_id,shared_link,operation_id) values($1,$2,$3,'in_use',$4,$5,$6)",
    [copy, cat, team, `restitch-${seq}`, 'https://drive.google.com/file/d/restitch', operation]
  );
  await db.root(
    "update public.team_product_catalogs set current_video_link='https://drive.google.com/file/d/restitch' where material_id=$1",
    [cat]
  );
  await db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', [
    team,
    accepted.id,
    ACTOR,
    owner,
    claim.fence
  ]);
  const reference = (
    await db.root<{
      restitch_material_id: string;
      restitch_operation_id: string;
      settings_snapshot: Record<string, unknown>;
    }>(
      'select restitch_material_id,restitch_operation_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=$1',
      [accepted.revisionId]
    )
  )[0];
  expect(reference.restitch_material_id).toBe(copy);
  expect(reference.restitch_operation_id).toBe(operation);
  expect(reference.settings_snapshot._launchRestitchIdentity).toEqual([
    `restitch-${seq}`,
    `md5:${'b'.repeat(32)}`
  ]);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    claim.fence
  ]);
  const spare = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) select team_id,connection_id,$2,'Updater spare','file','video','video/mp4','1',$3 from public.team_materials where id=$1 returning id",
      [material, `updater-spare-${seq}`, 'd'.repeat(32)]
    )
  )[0].id;
  const profile = (
    await db.root<{ version: number }>(
      'select version from public.team_catalog_update_profiles where catalog_material_id=$1',
      [cat]
    )
  )[0];
  await db.asUser(ACTOR, 'select public.patch_team_catalog_update_profile($1,$2,$3,$4)', [
    team,
    cat,
    profile.version,
    JSON.stringify({
      updateInterval: '15h',
      restitch: true,
      refreshImages: false,
      refreshTexts: false,
      growProducts: false
    })
  ]);
  await db.root(
    "insert into public.team_catalog_restitch_copies(material_id,catalog_material_id,team_id,role,drive_file_id,shared_link) values($1,$2,$3,'spare',$4,'https://example.invalid/spare')",
    [spare, cat, team, `updater-spare-${seq}`]
  );
  await db.asUser(ACTOR, 'select public.run_team_catalog_update_now($1,$2)', [team, [cat]]);
  expect(await updateLaunchCatalog(db, cat)).toMatchObject({ updated: 1, failed: 0 });
  expect(
    (
      await db.root<{ role: string }>(
        'select role from public.team_catalog_restitch_copies where material_id=$1',
        [copy]
      )
    )[0].role
  ).toBe('retired');
  expect(
    (
      await db.root<{ role: string }>(
        'select role from public.team_catalog_restitch_copies where material_id=$1',
        [spare]
      )
    )[0].role
  ).toBe('in_use');
  expect(
    (
      await db.root(
        'select restitch_material_id,restitch_operation_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=$1',
        [accepted.revisionId]
      )
    )[0]
  ).toEqual(reference);
  expect(
    (
      await db.root<{ current_video_link: string }>(
        'select current_video_link from public.team_product_catalogs where material_id=$1',
        [cat]
      )
    )[0].current_video_link
  ).toBe('https://example.invalid/spare');
  await db.asUser(ACTOR, 'select public.set_team_catalog_update_interval($1,$2,null)', [
    team,
    [cat]
  ]);
  // Exercise the public revision boundary against a real completed video/catalog.
  // Roll back each scenario so every edit is compared with the same proven baseline.
  const regenerate = async (config: LaunchConfig) => {
    const detail = (
      await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
        team,
        p.id
      ])
    )[0].v;
    const sources = (
      await db.root<{ v: unknown }>('select private.launch_sources_from_config($1,$2,$3) v', [
        team,
        JSON.stringify(config),
        ACTOR
      ])
    )[0].v;
    const parsed = parseLaunchSources(sources);
    if (!parsed) throw new Error('fixture');
    const saved = (
      await db.asUser<{ v: { version: string } }>(
        ACTOR,
        'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
        [
          team,
          p.id,
          detail.version,
          `reuse-matrix-save-${++seq}`,
          JSON.stringify(config),
          JSON.stringify(sources)
        ]
      )
    )[0].v;
    const preview = launchPreview(config, parsed);
    if (!preview.ok) throw new Error('fixture');
    const generation = await accept([
      team,
      p.id,
      ACTOR,
      saved.version,
      `reuse-matrix-generate-${seq}`,
      `reuse-matrix-digest-${seq}`,
      JSON.stringify(config),
      JSON.stringify(sources),
      JSON.stringify(preview.value)
    ]);
    return { generation, sources: parsed, preview: preview.value };
  };
  const evidenceFor = async (generationId: string) => {
    setQueryExecutor((sql, params) => db.root(sql, params));
    try {
      return (await getLaunchEvidence(generationId)).generations[0];
    } finally {
      setQueryExecutor(null);
    }
  };
  expect((await evidenceFor(accepted.id)).reuse_evidence).toEqual({
    video_operation_id: operation,
    video_generation_id: accepted.id,
    catalog_revision_id: null
  });
  const originalSources = parseLaunchSources(JSON.parse(p.args[7] as string));
  if (!originalSources) throw new Error('fixture');
  const originalPreview = launchPreview(p.config, originalSources);
  if (!originalPreview.ok) throw new Error('fixture');
  const replacement = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,'other.mp4','file','video','video/mp4','1' from public.team_materials where id=$1 returning id",
      [material, `replacement-${seq}`]
    )
  )[0].id;
  const cases: Array<{
    name: string;
    config: LaunchConfig;
    video: boolean;
    catalog: boolean;
    mutate?: () => Promise<unknown>;
  }> = [
    {
      name: 'lower duration bound',
      config: {
        ...p.config,
        catalog: { ...p.config.catalog, finalDurationRangeSeconds: [60, 240] }
      },
      video: false,
      catalog: false
    },
    {
      name: 'upper duration bound',
      config: {
        ...p.config,
        catalog: { ...p.config.catalog, finalDurationRangeSeconds: [120, 300] }
      },
      video: false,
      catalog: false
    },
    {
      name: 'center duration',
      config: { ...p.config, catalog: { ...p.config.catalog, customFinalDurationSeconds: 240 } },
      video: false,
      catalog: false
    },
    {
      name: 'duration mode',
      config: { ...p.config, catalog: { ...p.config.catalog, finalDurationMode: 'custom' } },
      video: false,
      catalog: false
    },
    {
      name: 'restitch disabled',
      config: { ...p.config, catalog: { ...p.config.catalog, restitchEnabled: false } },
      video: false,
      catalog: false
    },
    {
      name: 'product count',
      config: { ...p.config, catalog: { ...p.config.catalog, productCount: 3 } },
      video: true,
      catalog: false
    },
    {
      name: 'URL',
      config: { ...p.config, originalUrl: 'https://example.invalid/changed' },
      video: true,
      catalog: false
    },
    {
      name: 'names and budgets',
      config: { ...p.config, age: 50, maxBudget: 60, adsCount: 4, creativeAlias: 'renamed' },
      video: true,
      catalog: true
    },
    { name: 'unchanged inputs', config: p.config, video: true, catalog: true },
    {
      name: 'selected creative',
      config: { ...p.config, materialId: replacement },
      video: false,
      catalog: false
    },
    {
      name: 'selected restitch image',
      config: p.config,
      video: false,
      catalog: false,
      mutate: async () => {
        const screen = (
          await db.root<{ id: string }>(
            "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version) select team_id,connection_id,$2,'root','new.png','file','image','image/png',100,repeat('e',32),'1' from public.team_materials where id=$1 returning id",
            [material, `new-screen-${seq}`]
          )
        )[0].id;
        await db.asUser(ACTOR, "select public.set_restitch_sources($1,'end',$2::jsonb)", [
          team,
          JSON.stringify([{ materialId: screen }])
        ]);
      }
    },
    {
      name: 'source file identity',
      config: p.config,
      video: false,
      catalog: false,
      mutate: () =>
        db.root("update public.team_materials set drive_file_id='replacement-video' where id=$1", [
          material
        ])
    },
    {
      name: 'source bytes',
      config: p.config,
      video: false,
      catalog: false,
      mutate: () =>
        db.root('update public.team_materials set checksum=$2 where id=$1', [
          material,
          'd'.repeat(32)
        ])
    },
    {
      name: 'restitch defaults',
      config: p.config,
      video: false,
      catalog: false,
      mutate: () =>
        db.root("update public.team_restitch_defaults set fit_mode='contain' where team_id=$1", [
          team
        ])
    },
    {
      name: 'catalog price',
      config: p.config,
      video: true,
      catalog: false,
      mutate: () =>
        db.root('update public.team_product_catalog_settings set price=20 where team_id=$1', [team])
    },
    {
      name: 'catalog image',
      config: p.config,
      video: true,
      catalog: false,
      mutate: () =>
        db.root(
          "update public.team_product_catalog_settings set image_link='https://example.invalid/new.jpg' where team_id=$1",
          [team]
        )
    },
    {
      name: 'catalog title',
      config: p.config,
      video: true,
      catalog: false,
      mutate: () =>
        db.root(
          "update public.team_product_catalog_settings set title='Changed title' where team_id=$1",
          [team]
        )
    }
  ];
  for (const scenario of cases) {
    await db.root('begin');
    try {
      await scenario.mutate?.();
      const next = await regenerate(scenario.config);
      const video = (
        await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_restitch_reuse($1,$2) v', [
          team,
          next.generation.id
        ])
      )[0].v;
      expect(video !== null, scenario.name).toBe(scenario.video);
      if (!scenario.video && scenario.config.catalog.restitchEnabled) {
        await db.root('savepoint before_preparation');
        const prepared = (
          await db.asUser<{
            v: {
              processKey: string;
              defaults: { finalDurationMode: string; customFinalDurationSeconds: number };
            };
          }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [team, next.generation.id])
        )[0].v;
        expect(prepared.processKey, scenario.name).not.toBe(preparation.processKey);
        expect(prepared.defaults.finalDurationMode).toBe('custom');
        if (scenario.config.catalog.finalDurationMode === 'random-centered') {
          const [min, max] = scenario.config.catalog.finalDurationRangeSeconds!;
          expect(prepared.defaults.customFinalDurationSeconds).toBeGreaterThanOrEqual(min);
          expect(prepared.defaults.customFinalDurationSeconds).toBeLessThanOrEqual(max);
        } else
          expect(prepared.defaults.customFinalDurationSeconds).toBe(
            scenario.config.catalog.customFinalDurationSeconds
          );
        expect(
          (
            await db.asUser<{ v: unknown }>(
              ACTOR,
              'select public.prepare_launch_restitch($1,$2) v',
              [team, next.generation.id]
            )
          )[0].v
        ).toEqual(prepared);
        expect(
          (
            await db.root<{ stage: string; catalog_registered: boolean }>(
              'select stage,catalog_registered from public.analytics_launch_generations where generation_id=$1',
              [next.generation.id]
            )
          )[0]
        ).toEqual({ stage: 'restitch_preparing', catalog_registered: false });
        await db.root('rollback to savepoint before_preparation');
      }
      const claim = (
        await db.root<{ v: { fence: string } }>(
          'select public.service_claim_launch_generation($1,$2,$3,$4) v',
          [team, next.generation.id, ACTOR, owner]
        )
      )[0].v;
      const catalog = (
        await db.root<{ v: boolean }>(
          'select public.service_reuse_launch_catalog($1,$2,$3,$4,$5) v',
          [team, next.generation.id, ACTOR, owner, claim.fence]
        )
      )[0].v;
      expect(catalog, scenario.name).toBe(scenario.catalog);
      if (!catalog)
        expect(
          (
            await db.root<{ stage: string }>(
              'select stage from public.team_launch_generations where id=$1',
              [next.generation.id]
            )
          )[0].stage,
          scenario.name
        ).toBe('preparing');
      if (catalog)
        expect((await evidenceFor(next.generation.id)).reuse_evidence).toEqual({
          video_operation_id: operation,
          video_generation_id: accepted.id,
          catalog_revision_id: accepted.revisionId
        });
      const impact = launchRevisionImpact(
        originalPreview.value,
        next.preview,
        p.config,
        scenario.config,
        originalSources,
        next.sources
      );
      expect(!impact.catalogChanged, scenario.name).toBe(scenario.catalog);
      expect(!impact.mediaChanged, scenario.name).toBe(scenario.video);
    } finally {
      await db.root('rollback');
    }
  }
  // Simulate the already-published bad range-only reuse from the old implementation.
  // The next revision must reject it even when its labels now match the requested range.
  await db.root('begin');
  try {
    const changed = {
      ...p.config,
      catalog: { ...p.config.catalog, finalDurationRangeSeconds: [300, 420] as [number, number] }
    };
    const bad = await regenerate(changed);
    const claim = (
      await db.root<{ v: { fence: string } }>(
        'select public.service_claim_launch_generation($1,$2,$3,$4) v',
        [team, bad.generation.id, ACTOR, owner]
      )
    )[0].v;
    await db.root(
      'insert into public.team_launch_revision_catalogs select team_id,$2,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=$1',
      [accepted.revisionId, bad.generation.revisionId]
    );
    await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
      team,
      bad.generation.id,
      ACTOR,
      claim.fence
    ]);
    const repair = await regenerate(changed);
    expect(
      (
        await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_restitch_reuse($1,$2) v', [
          team,
          repair.generation.id
        ])
      )[0].v
    ).toBeNull();
    const repairClaim = (
      await db.root<{ v: { fence: string } }>(
        'select public.service_claim_launch_generation($1,$2,$3,$4) v',
        [team, repair.generation.id, ACTOR, owner]
      )
    )[0].v;
    expect(
      (
        await db.root<{ v: boolean }>(
          'select public.service_reuse_launch_catalog($1,$2,$3,$4,$5) v',
          [team, repair.generation.id, ACTOR, owner, repairClaim.fence]
        )
      )[0].v
    ).toBe(false);
  } finally {
    await db.root('rollback');
  }
  const baseline = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v;
  const nextConfig = { ...p.config, originalUrl: 'https://example.invalid/?next=1' };
  const nextSources = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_sources($1,$2) v', [
      team,
      p.id
    ])
  )[0].v;
  const nextSaved = (
    await db.asUser<{ v: { version: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [
        team,
        p.id,
        baseline.version,
        `restitch-url-draft-${++seq}`,
        JSON.stringify(nextConfig),
        JSON.stringify(nextSources)
      ]
    )
  )[0].v;
  const parsedSources = parseLaunchSources(nextSources);
  if (!parsedSources) throw new Error('fixture');
  const nextPreview = launchPreview(nextConfig, parsedSources);
  if (!nextPreview.ok) throw new Error('fixture');
  const nextGeneration = await accept([
    team,
    p.id,
    ACTOR,
    nextSaved.version,
    `restitch-url-generation-${seq}`,
    'restitch-url-digest',
    JSON.stringify(nextConfig),
    JSON.stringify(nextSources),
    JSON.stringify(nextPreview.value)
  ]);
  const reused = (
    await db.asUser<{ v: { operationId: string; materialId: string } }>(
      ACTOR,
      'select public.get_launch_restitch_reuse($1,$2) v',
      [team, nextGeneration.id]
    )
  )[0].v;
  expect(reused).toMatchObject({ operationId: operation, materialId: copy });
  expect(
    (
      await db.root<{ v: Array<{ generationId: string }> }>(
        'select public.service_list_launch_catalog_recovery(10) v'
      )
    )[0].v.some(item => item.generationId === nextGeneration.id)
  ).toBe(true);
  const nextClaim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, nextGeneration.id, ACTOR, owner]
    )
  )[0].v;
  const nextKey = `launch:${nextGeneration.id}:catalog`;
  const nextIntent = (
    await db.root<{ v: { id: string; fence: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        material,
        ACTOR,
        nextKey,
        JSON.stringify({
          ...payload,
          sourceLink: nextPreview.value.advertisingUrl,
          idempotencyKey: nextKey
        }),
        childOwner
      ]
    )
  )[0].v;
  const nextCat = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,'New URL catalog','file','other','application/vnd.google-apps.spreadsheet','1' from public.team_materials where id=$1 returning id",
      [material, `next-restitch-catalog-${seq}`]
    )
  )[0].id;
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'finalized',$6,null,null)",
    [
      team,
      nextIntent.id,
      ACTOR,
      childOwner,
      nextIntent.fence,
      JSON.stringify({ materialId: nextCat })
    ]
  );
  const record = {
    sourceLink: nextPreview.value.advertisingUrl,
    productCount: 100,
    sheetUrl,
    videoLink: 'https://drive.google.com/file/d/original',
    currentVideoLink: 'https://drive.google.com/file/d/restitch',
    restitchOperationId: operation,
    restitchMaterialId: copy,
    settingsSnapshot: { title: 'Synthetic' },
    createdBy: ACTOR,
    variant: nextIntent.variant
  };
  const linked = (
    await db.root<{ v: { linked: boolean } }>(
      'select public.service_link_launch_restitch_catalog($1,$2,$3,$4,$5,$6,$7) v',
      [team, nextGeneration.id, ACTOR, owner, nextClaim.fence, nextCat, JSON.stringify(record)]
    )
  )[0].v;
  expect(linked.linked).toBe(true);
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered','{}',null,$6)",
    [
      team,
      nextIntent.id,
      ACTOR,
      childOwner,
      nextIntent.fence,
      JSON.stringify({
        ...catalogResult,
        catalog: {
          ...catalogResult.catalog,
          materialId: nextCat,
          sourceLink: nextPreview.value.advertisingUrl,
          variant: nextIntent.variant
        }
      })
    ]
  );
  await db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', [
    team,
    nextGeneration.id,
    ACTOR,
    owner,
    nextClaim.fence
  ]);
  expect((await evidenceFor(nextGeneration.id)).reuse_evidence).toEqual({
    video_operation_id: operation,
    video_generation_id: accepted.id,
    catalog_revision_id: null
  });
  await db.root(
    "update public.team_materials set lifecycle='missing',missing_at=now()-interval '2 days' where id=$1",
    [material]
  );
  await db.root('select private.retire_unused_restitch_copies()');
  await db.root('select private.queue_orphan_cleanups()');
  expect(
    (
      await db.root<{ role: string }>(
        'select role from public.team_catalog_restitch_copies where material_id=$1',
        [copy]
      )
    )[0].role
  ).toBe('retired');
  const orphanClaims = await db.root<{ material_id: string }>(
    "select * from public.service_claim_orphan_cleanups('launch-orphan-test',50,60)"
  );
  expect(orphanClaims.some(row => row.material_id === cat || row.material_id === nextCat)).toBe(
    false
  );
  const copyClaims = await db.root<{ material_id: string }>(
    'select * from public.service_claim_retired_restitch_copies(50)'
  );
  expect(copyClaims.some(row => row.material_id === copy)).toBe(false);
  await db.root("update public.team_materials set lifecycle='active',missing_at=null where id=$1", [
    material
  ]);

  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_catalog_restitch_copies where material_id=$1',
        [copy]
      )
    )[0].n
  ).toBe(1);
  expect(
    (
      await db.root<{ id: string }>(
        'select restitch_material_id id from public.team_launch_revision_catalogs where revision_id=$1',
        [nextGeneration.revisionId]
      )
    )[0].id
  ).toBe(copy);
  await db.root('update public.team_materials set checksum=$2 where id=$1', [copy, 'c'.repeat(32)]);
  expect(
    (
      await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_restitch_reuse($1,$2) v', [
        team,
        nextGeneration.id
      ])
    )[0].v
  ).toBeNull();
  await db.root('update public.team_materials set checksum=$2 where id=$1', [copy, 'b'.repeat(32)]);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    nextGeneration.id,
    `settle-cancel-${++seq}`
  ]);
  expect(
    (
      await db.asUser<{ v: boolean }>(ACTOR, 'select public.settle_launch_restitch($1,$2) v', [
        team,
        nextGeneration.id
      ])
    )[0].v
  ).toBe(false);
});

it('retries a failed restitch only by explicit replay-safe action while retaining inputs and old attempts', async () => {
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(p.args);
  const preparation = (
    await db.asUser<{ v: { processKey: string; defaults: unknown; draw: unknown } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  const operation = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,'failed-restitch-nonce') returning id",
      [team, ACTOR, material, preparation.processKey]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [operation, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [
    team,
    accepted.id,
    operation
  ]);
  const key = `restitch-retry-${++seq}`;
  await expect(
    db.asUser(ACTOR, 'select public.retry_launch_restitch($1,$2,$3)', [team, accepted.id, key])
  ).rejects.toThrow('WRONG_STATE');
  await db.root("update public.team_operations set state='running' where id=$1", [operation]);
  await db.root(
    "update public.team_operations set state='failed',finished_at=now(),error_code='PROCESS_FAILED' where id=$1",
    [operation]
  );
  await db.root('select public.service_settle_launch_restitch_batch(3)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0].state
  ).toBe('failed');
  const retry = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.retry_launch_restitch($1,$2,$3) v',
      [team, accepted.id, key]
    )
  )[0].v;
  expect(retry.processKey).toBe(`launch-restitch:${accepted.id}:2`);
  expect(
    (
      await db.asUser<{ v: unknown }>(ACTOR, 'select public.retry_launch_restitch($1,$2,$3) v', [
        team,
        accepted.id,
        key
      ])
    )[0].v
  ).toEqual(retry);
  const resumed = (
    await db.asUser<{ v: { defaults: unknown; draw: unknown; operationId: null } }>(
      ACTOR,
      'select public.get_launch_restitch_preparation($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  expect(resumed.defaults).toEqual(preparation.defaults);
  expect(resumed.draw).toEqual(preparation.draw);
  expect(resumed.operationId).toBeNull();
  const second = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,'second-restitch-nonce') returning id",
      [team, ACTOR, material, retry.processKey]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [second, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [
    team,
    accepted.id,
    second
  ]);
  const steps = await db.root<{ team_operation_id: string; state: string }>(
    "select team_operation_id,state from public.team_launch_generation_steps where generation_id=$1 and stage='restitch_processing' order by stable_step_key",
    [accepted.id]
  );
  expect(steps).toEqual([
    { team_operation_id: operation, state: 'failed' },
    { team_operation_id: second, state: 'running' }
  ]);
});

it.each([
  ['not_started', false, 'canceled'],
  ['started', true, 'canceled_with_cleanup_pending']
] as const)(
  'settles only positively unstarted native uploads (%s)',
  async (_phase, startUpload, expectedState) => {
    const p = await prepare({
      method: 'catalog',
      catalog: {
        productCount: 100,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120
      }
    });
    const accepted = await accept(p.args);
    const prep = (
      await db.asUser<{ v: { processKey: string } }>(
        ACTOR,
        'select public.prepare_launch_restitch($1,$2) v',
        [team, accepted.id]
      )
    )[0].v;
    const op = (
      await db.root<{ id: string }>(
        "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,$5) returning id",
        [team, ACTOR, material, prep.processKey, `phase-${++seq}`]
      )
    )[0].id;
    await db.root(
      "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
      [op, team]
    );
    await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, accepted.id, op]);
    await expect(
      db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR])
    ).rejects.toThrow('WRONG_STATE');
    expect(
      (
        await db.root<{ v: boolean }>('select public.service_is_launch_restitch_process($1,$2) v', [
          op,
          ACTOR
        ])
      )[0].v
    ).toBe(true);
    expect(
      (
        await db.root<{ v: boolean }>(
          'select public.service_prepare_launch_process_upload($1,$2) v',
          [op, ACTOR]
        )
      )[0].v
    ).toBe(true);
    await db.root(
      'select public.service_set_team_operation_intent($1,$2,null,null,100,null,null,$3,2)',
      [op, ACTOR, 'restitch']
    );
    if (startUpload) {
      expect(
        (
          await db.root<{ v: boolean }>(
            'select public.service_start_launch_process_upload($1,$2) v',
            [op, ACTOR]
          )
        )[0].v
      ).toBe(true);
      await expect(
        db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR])
      ).rejects.toThrow('WRONG_STATE');
    }
    await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
      team,
      p.id,
      accepted.id,
      `phase-cancel-${++seq}`
    ]);
    expect(
      (await db.root<{ due: boolean }>('select private.launch_cleanup_due() due'))[0].due
    ).toBe(!startUpload);
    await expect(
      db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR])
    ).rejects.toThrow('WRONG_STATE');
    await db.root('select public.service_settle_launch_restitch_cancellations(3)');
    expect(
      (
        await db.root<{ state: string }>(
          'select state from public.team_launch_generations where id=$1',
          [accepted.id]
        )
      )[0].state
    ).toBe(expectedState);
  }
);

it('keeps cancellation with a durably planned local upload pending rather than claiming no file exists', async () => {
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(p.args);
  const prep = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  const op = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,'unknown-upload-nonce') returning id",
      [team, ACTOR, material, prep.processKey]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation,expected_size) values($1,$2,'restitch',2,'processed_from',100)",
    [op, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, accepted.id, op]);
  await expect(
    db.root('select public.service_prepare_launch_process_upload($1,$2)', [op, ACTOR])
  ).rejects.toThrow('WRONG_STATE');
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `unknown-upload-cancel-${++seq}`
  ]);
  await db.root('select public.service_settle_launch_restitch_cancellations(3)');
  expect(
    (
      await db.root<{ state: string; safe_error_code: string }>(
        'select state,safe_error_code from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]
  ).toEqual({ state: 'canceled_with_cleanup_pending', safe_error_code: 'LAUNCH_RESULT_UNCERTAIN' });
  expect(
    (
      await db.root<{ n: number }>(
        'select public.service_settle_launch_restitch_cancellations(3) n'
      )
    )[0].n
  ).toBe(0);
});

it('claims and settles only a canceled unregistered native upload after an exact cleanup receipt', async () => {
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(p.args);
  const prep = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  const op = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,$5) returning id",
      [team, ACTOR, material, prep.processKey, `cleanup-video-${++seq}`]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation,mime_type) values($1,$2,'restitch',2,'processed_from','video/mp4')",
    [op, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, accepted.id, op]);
  await db.root('select public.service_prepare_launch_process_upload($1,$2)', [op, ACTOR]);
  await db.root(
    "select public.service_set_team_operation_intent($1,$2,null,'video/mp4',100,null,null,'restitch',2)",
    [op, ACTOR]
  );
  await db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR]);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `cleanup-video-cancel-${++seq}`
  ]);
  const owner = '72000000-0000-4000-8000-000000000080';
  expect((await db.root<{ due: boolean }>('select private.launch_cleanup_due() due'))[0].due).toBe(
    false
  );
  expect(
    (
      await db.root<{ v: unknown[] }>('select public.service_claim_launch_video_cleanup($1,3) v', [
        owner
      ])
    )[0].v
  ).toEqual([]);
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at) values(decode(repeat('ab',32),'hex'),$1,$2,$3,'finalize','restitch',1048576,clock_timestamp()+interval '1 hour')",
    [op, team, ACTOR]
  );
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_ack_launch_upload_quiescence($1,decode(repeat('cd',32),'hex')) v",
        [op]
      )
    )[0].v
  ).toBe(false);
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_ack_launch_upload_quiescence($1,decode(repeat('ab',32),'hex')) v",
        [op]
      )
    )[0].v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_ack_launch_upload_quiescence($1,decode(repeat('ab',32),'hex')) v",
        [op]
      )
    )[0].v
  ).toBe(true);
  const plans = (
    await db.root<{ v: { operationId: string; parentId: string; fence: string }[] }>(
      'select public.service_claim_launch_video_cleanup($1,3) v',
      [owner]
    )
  )[0].v;
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ operationId: op, parentId: 'root' });
  const authority = [team, accepted.id, op, owner, plans[0].fence, 'orphan-video'];
  const registered = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type) select $1,connection_id,'orphan-video','registered.mp4','file','video','video/mp4' from public.team_materials where id=$2 returning id",
      [team, material]
    )
  )[0].id;
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_authorize_launch_video_cleanup($1,$2,$3,$4,$5,$6) v',
        authority
      )
    )[0].v
  ).toBe('unknown');
  await db.root('delete from public.team_materials where id=$1', [registered]);
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_authorize_launch_video_cleanup($1,$2,$3,$4,$5,$6) v',
        [team, accepted.id, op, owner, '999', 'orphan-video']
      )
    )[0].v
  ).toBe('unknown');
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_authorize_launch_video_cleanup($1,$2,$3,$4,$5,$6) v',
        authority
      )
    )[0].v
  ).toBe('owned_unpublished');
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_finish_launch_video_cleanup($1,$2,$3,$4,$5,null) v',
        authority.slice(0, 5)
      )
    )[0].v
  ).toBe('pending');
  expect(
    (
      await db.root<{ deferred: boolean }>(
        "select next_attempt_at > clock_timestamp()+interval '4 minutes' deferred from public.team_launch_generations where id=$1",
        [accepted.id]
      )
    )[0].deferred
  ).toBe(true);
  expect((await db.root<{ due: boolean }>('select private.launch_cleanup_due() due'))[0].due).toBe(
    false
  );
  await db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
    [accepted.id]
  );
  const retryPlans = (
    await db.root<{ v: { fence: string }[] }>(
      'select public.service_claim_launch_video_cleanup($1,3) v',
      [owner]
    )
  )[0].v;
  expect(retryPlans).toHaveLength(1);
  authority[4] = retryPlans[0].fence;
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_finish_launch_video_cleanup($1,$2,$3,$4,$5,$6) v',
        authority
      )
    )[0].v
  ).toBe('cleaned');
  expect((await db.root<{ due: boolean }>('select private.launch_cleanup_due() due'))[0].due).toBe(
    true
  );
  await db.root('select public.service_settle_launch_restitch_cancellations(3)');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0].state
  ).toBe('canceled');
});

it('retains an agent quiescence receipt sent before the parent cancellation', async () => {
  const p = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(p.args);
  const prep = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  const op = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,$5) returning id",
      [team, ACTOR, material, prep.processKey, `early-quiescence-${++seq}`]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation,mime_type) values($1,$2,'restitch',2,'processed_from','video/mp4')",
    [op, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, accepted.id, op]);
  await db.root('select public.service_prepare_launch_process_upload($1,$2)', [op, ACTOR]);
  await db.root(
    "select public.service_set_team_operation_intent($1,$2,null,'video/mp4',100,null,null,'restitch',2)",
    [op, ACTOR]
  );
  await db.root('select public.service_start_launch_process_upload($1,$2)', [op, ACTOR]);
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at) values(decode(repeat('ef',32),'hex'),$1,$2,$3,'finalize','restitch',1048576,clock_timestamp()+interval '1 hour')",
    [op, team, ACTOR]
  );
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_ack_launch_upload_quiescence($1,decode(repeat('ef',32),'hex')) v",
        [op]
      )
    )[0].v
  ).toBe(true);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    accepted.id,
    `early-quiescence-cancel-${++seq}`
  ]);
  expect((await db.root<{ due: boolean }>('select private.launch_cleanup_due() due'))[0].due).toBe(
    true
  );
  const plans = (
    await db.root<{ v: { operationId: string }[] }>(
      'select public.service_claim_launch_video_cleanup($1,3) v',
      ['72000000-0000-4000-8000-000000000081']
    )
  )[0].v;
  expect(plans).toHaveLength(1);
  expect(plans[0].operationId).toBe(op);
});

it('leaves unrelated restitch operations and legacy planned uploads outside the new proof', async () => {
  const unrelated = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','running',$3,$4,$5) returning id",
      [team, ACTOR, material, `unrelated-restitch-${++seq}`, `unrelated-nonce-${seq}`]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [unrelated, team]
  );
  expect(
    (
      await db.root<{ v: boolean }>('select public.service_is_launch_restitch_process($1,$2) v', [
        unrelated,
        ACTOR
      ])
    )[0].v
  ).toBe(false);
  await expect(
    db.root('select public.service_prepare_launch_process_upload($1,$2)', [unrelated, ACTOR])
  ).rejects.toThrow('WRONG_STATE');
  await expect(
    db.asUser(ACTOR, 'select public.service_prepare_launch_process_upload($1,$2)', [
      unrelated,
      ACTOR
    ])
  ).rejects.toThrow();
});

it('accepts permission-only source revisions with proven checksum while rejecting changed or unknown content', async () => {
  await db.root('update public.team_materials set checksum=$2,drive_version=$3 where id=$1', [
    material,
    'a'.repeat(32),
    'content-1'
  ]);
  const unchanged = await prepare();
  await db.root('update public.team_materials set drive_version=$2 where id=$1', [
    material,
    'content-2'
  ]);
  expect((await accept(unchanged.args)).state).toBe('accepted');
  const changed = await prepare();
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    material,
    'd'.repeat(32)
  ]);
  await expect(accept(changed.args)).rejects.toThrow('SOURCE_CHANGED');
  await db.root('update public.team_materials set checksum=null where id=$1', [material]);
  const unknown = await prepare();
  await db.root('update public.team_materials set drive_version=$2 where id=$1', [
    material,
    'content-3'
  ]);
  await expect(accept(unknown.args)).rejects.toThrow('SOURCE_CHANGED');
});

it('locks uncertain edits and fences publication after a newer manual revision becomes active', async () => {
  const p = await prepare();
  const first = await accept(p.args);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    first.id,
    ACTOR,
    first.fence
  ]);
  let detail = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v;
  const sources = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.get_launch_sources($1,$2) v', [
      team,
      p.id
    ])
  )[0].v;
  const saved = (
    await db.asUser<{ v: { version: string } }>(
      ACTOR,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6) v',
      [
        team,
        p.id,
        detail.version,
        `fence-draft-${++seq}`,
        JSON.stringify(p.config),
        JSON.stringify(sources)
      ]
    )
  )[0].v;
  const parsed = parseLaunchSources(sources);
  if (!parsed) throw new Error('fixture');
  const preview = launchPreview(p.config, parsed);
  if (!preview.ok) throw new Error('fixture');
  const pending = await accept([
    team,
    p.id,
    ACTOR,
    saved.version,
    `fence-generate-${seq}`,
    'fence-digest',
    JSON.stringify(p.config),
    JSON.stringify(sources),
    JSON.stringify(preview.value)
  ]);
  await db.root(
    "update public.team_launch_generations set state='interrupted',safe_error_code='DRIVE_UNAVAILABLE' where id=$1",
    [pending.id]
  );
  detail = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v;
  await expect(
    db.asUser(ACTOR, 'select public.save_launch_overrides($1,$2,$3,$4,$5,$6)', [
      team,
      p.id,
      first.revisionId,
      detail.version,
      `blocked-manual-${++seq}`,
      JSON.stringify({ advertisingUrl: 'https://example.invalid/manual' })
    ])
  ).rejects.toThrow('LAUNCH_BUSY');
  await db.root("update public.team_launch_generations set state='failed' where id=$1", [
    pending.id
  ]);
  await db.asUser(ACTOR, 'select public.save_launch_overrides($1,$2,$3,$4,$5,$6)', [
    team,
    p.id,
    first.revisionId,
    detail.version,
    `newer-manual-${++seq}`,
    JSON.stringify({ advertisingUrl: 'https://example.invalid/manual' })
  ]);
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, pending.id, ACTOR, 'stale-publication-owner']
    )
  )[0].v;
  await expect(
    db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
      team,
      pending.id,
      ACTOR,
      claim.fence
    ])
  ).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  await db.root(
    "update public.team_launch_generations set lease_expires_at=now()-interval '1 second',next_attempt_at=now() where id=$1",
    [pending.id]
  );
  await db.root('select public.service_settle_launch_batch(10)');
  expect(
    (
      await db.root<{ state: string; safe_error_code: string }>(
        'select state,safe_error_code from public.team_launch_generations where id=$1',
        [pending.id]
      )
    )[0]
  ).toEqual({ state: 'failed', safe_error_code: 'LAUNCH_VERSION_CONFLICT' });
});

it('explicit catalog recovery keeps its reservation and selected resources across request replay', async () => {
  const p = await prepare({ method: 'catalog' });
  const accepted = await accept(p.args);
  const key = `launch:${accepted.id}:catalog`;
  const owner = '72000000-0000-4000-8000-000000000030';
  const child = (
    await db.root<{ v: { id: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify({ productCount: 100 }), owner]
    )
  )[0].v;
  await db.root(
    "update private.catalog_generation_intents set lease_expires_at=now()-interval '1 second' where id=$1",
    [child.id]
  );
  await db.root(
    "update public.team_launch_generations set state='interrupted',stage='catalog_creating',safe_error_code='DRIVE_UNAVAILABLE',lease_expires_at=null where id=$1",
    [accepted.id]
  );
  const retryKey = `catalog-resume-${++seq}`;
  const result = (
    await db.asUser<{ v: unknown }>(ACTOR, 'select public.retry_launch_generation($1,$2,$3) v', [
      team,
      accepted.id,
      retryKey
    ])
  )[0].v;
  expect(
    (
      await db.asUser<{ v: unknown }>(ACTOR, 'select public.retry_launch_generation($1,$2,$3) v', [
        team,
        accepted.id,
        retryKey
      ])
    )[0].v
  ).toEqual(result);
  expect(
    (
      await db.root<{ id: string; variant: number }>(
        'select id,variant from private.catalog_generation_intents where team_id=$1 and request_key=$2',
        [team, key]
      )
    )[0]
  ).toMatchObject({ id: child.id, variant: child.variant });
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0].state
  ).toBe('accepted');
});

it('replaces a failed catalog child only once per explicit Launch retry', async () => {
  const p = await prepare({ method: 'catalog' });
  const accepted = await accept(p.args);
  const owner = '72000000-0000-4000-8000-000000000031';
  const intent = (
    await db.root<{ v: { id: string; fence: string; attempt: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        material,
        ACTOR,
        `launch:${accepted.id}:catalog`,
        JSON.stringify({ productCount: 100 }),
        owner
      ]
    )
  )[0].v;
  const first = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,'upload','failed',$3,$4,$5,now()) returning id",
      [team, ACTOR, material, `catalog-failed-${++seq}`, `catalog-failed-nonce-${seq}`]
    )
  )[0].id;
  await db.root('update private.catalog_generation_intents set operation_id=$2 where id=$1', [
    intent.id,
    first
  ]);
  await expect(
    db.root('select public.service_retry_catalog_child($1,$2,$3,$4,$5)', [
      team,
      intent.id,
      ACTOR,
      owner,
      intent.fence
    ])
  ).rejects.toThrow('WRONG_STATE');

  await db.root(
    "update private.catalog_generation_intents set lease_expires_at=now()-interval '1 second' where id=$1",
    [intent.id]
  );
  await db.root(
    "update public.team_launch_generations set state='interrupted',stage='catalog_creating',safe_error_code='WRONG_STATE',lease_expires_at=null where id=$1",
    [accepted.id]
  );
  await db.asUser(ACTOR, 'select public.retry_launch_generation($1,$2,$3)', [
    team,
    accepted.id,
    `catalog-child-retry-${++seq}`
  ]);
  expect(
    (
      await db.root<{ attempt_no: number; catalog_retry_from_attempt: number }>(
        'select attempt_no,catalog_retry_from_attempt from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0]
  ).toEqual({ attempt_no: 2, catalog_retry_from_attempt: 1 });
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, 'catalog-child-retry-owner']
    )
  )[0].v;
  expect(claim.fence).toBeTruthy();
  const resumed = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        material,
        ACTOR,
        `launch:${accepted.id}:catalog`,
        JSON.stringify({ productCount: 100 }),
        owner
      ]
    )
  )[0].v;
  expect(
    (
      await db.root<{ v: number }>('select public.service_retry_catalog_child($1,$2,$3,$4,$5) v', [
        team,
        intent.id,
        ACTOR,
        owner,
        resumed.fence
      ])
    )[0].v
  ).toBe(2);
  const second = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,'upload','failed',$3,$4,$5,now()) returning id",
      [team, ACTOR, material, `catalog-failed-${++seq}`, `catalog-failed-nonce-${seq}`]
    )
  )[0].id;
  await db.root('update private.catalog_generation_intents set operation_id=$2 where id=$1', [
    intent.id,
    second
  ]);
  await expect(
    db.root('select public.service_retry_catalog_child($1,$2,$3,$4,$5)', [
      team,
      intent.id,
      ACTOR,
      owner,
      resumed.fence
    ])
  ).rejects.toThrow('WRONG_STATE');
});

it('keeps a grant seen after a lost create reply uncertain instead of treating it as preexisting', async () => {
  const credential = (
    await db.root<{ credential_id: string }>(
      'select c.credential_id from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id where m.id=$1',
      [material]
    )
  )[0].credential_id;
  const owner = '72000000-0000-4000-8000-000000000032';
  const intent = (
    await db.root<{ v: { id: string; fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        material,
        ACTOR,
        `catalog-lost-grant-${++seq}`,
        JSON.stringify({ productCount: 2 }),
        owner
      ]
    )
  )[0].v;
  const record = (permission: string | null, prior: boolean, state: string) =>
    db.root('select public.service_record_catalog_permission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      team,
      intent.id,
      ACTOR,
      owner,
      intent.fence,
      'launch-video',
      credential,
      permission,
      prior,
      state
    ]);
  await record(null, false, 'pending');
  await record('seen-after-lost-reply', true, 'preserved');
  expect(
    (
      await db.root<{ state: string; prior_anyone: boolean; created_by_attempt: boolean }>(
        'select state,prior_anyone,created_by_attempt from private.catalog_generation_sharing where intent_id=$1 and file_id=$2',
        [intent.id, 'launch-video']
      )
    )[0]
  ).toEqual({ state: 'cleanup_pending', prior_anyone: false, created_by_attempt: false });
});

it('fences and removes only an owned unused source grant before settling cancellation', async () => {
  const driveFileId = `grant-source-video-${++seq}`;
  const source = (
    await db.root<{ id: string }>(
      `insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version)
       select team_id,connection_id,$2,'grant-source.mp4','file','video','video/mp4','1'
       from public.team_materials where id=$1 returning id`,
      [material, driveFileId]
    )
  )[0].id;
  const credential = (
    await db.root<{ id: string }>(
      'select c.credential_id id from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id where m.id=$1',
      [source]
    )
  )[0].id;
  const prepared = await prepare({ method: 'catalog', materialId: source });
  const generation = await accept(prepared.args);
  const owner = 'grant-parent-owner';
  const claimed = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, generation.id, ACTOR, owner]
    )
  )[0].v;
  await db.root("select public.service_touch_launch_generation($1,$2,$3,$4,$5,'preparing')", [
    team,
    generation.id,
    ACTOR,
    owner,
    claimed.fence
  ]);
  const childOwner = '72000000-0000-4000-8000-000000000060';
  const child = (
    await db.root<{ v: { id: string; fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        source,
        ACTOR,
        `launch:${generation.id}:catalog`,
        JSON.stringify({ sourceLink: 'https://example.invalid/', productCount: 100 }),
        childOwner
      ]
    )
  )[0].v;
  await db.root(
    "select public.service_record_catalog_permission($1,$2,$3,$4,$5,$6,$7,'exact-source-grant',false,'created')",
    [team, child.id, ACTOR, childOwner, child.fence, driveFileId, credential]
  );
  const competing = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [
        team,
        source,
        ACTOR,
        `competing-before-revoke-${++seq}`,
        JSON.stringify({ productCount: 2 }),
        childOwner
      ]
    )
  )[0].v;
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    prepared.id,
    generation.id,
    `grant-cancel-${++seq}`
  ]);
  await db.root('update public.team_launch_generations set lease_expires_at=now() where id=$1', [
    generation.id
  ]);
  await db.root(
    'update private.catalog_generation_intents set lease_expires_at=now() where id=$1',
    [child.id]
  );
  const names: Record<string, string[]> = {
    service_claim_launch_cleanup: ['p_owner', 'p_limit'],
    service_list_launch_cleanup_permissions: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence'
    ],
    service_authorize_launch_permission_cleanup: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence',
      'p_file',
      'p_credential',
      'p_permission'
    ],
    service_mark_launch_permission_cleaned: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence',
      'p_file',
      'p_credential',
      'p_permission'
    ],
    service_finish_launch_cleanup: [
      'p_team',
      'p_generation',
      'p_owner',
      'p_fence',
      'p_intent_fence',
      'p_cleaned_file'
    ]
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const keys = names[name];
    if (!keys) throw new Error('unexpected RPC');
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(',');
    const result = await db.root<{ v: unknown }>(
      `select public.${name}(${placeholders}) v`,
      keys.map(key => args[key])
    );
    return { data: result[0].v, error: null };
  };
  let permissionPresent = true;
  const deletePermission = vi.fn(async (fileId: string, permissionId: string) => {
    expect([fileId, permissionId]).toEqual([driveFileId, 'exact-source-grant']);
    await expect(
      db.root('select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)', [
        team,
        source,
        ACTOR,
        `competing-during-revoke-${++seq}`,
        JSON.stringify({ productCount: 2 }),
        childOwner
      ])
    ).rejects.toThrow('GROUP_RECONCILING');
    permissionPresent = false;
  });
  const driveFor = vi.fn(async () => ({
    getFile: vi.fn(),
    updateFileMetadata: vi.fn(),
    listAnyonePermissions: vi.fn(async () =>
      permissionPresent ? [{ id: 'exact-source-grant', role: 'reader' }] : []
    ),
    deletePermission
  }));
  expect(await runLaunchCleanupTick({ rpc }, driveFor)).toEqual({ completed: 0, pending: 1 });
  expect(deletePermission).not.toHaveBeenCalled();
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_sharing where intent_id=$1 and file_id=$2',
        [child.id, driveFileId]
      )
    )[0].state
  ).toBe('created');
  await db.root("update private.catalog_generation_intents set state='canceled' where id=$1", [
    competing.id
  ]);
  await db.root(
    'update public.team_launch_generations set lease_expires_at=now(),next_attempt_at=now() where id=$1',
    [generation.id]
  );
  await db.root(
    'update private.catalog_generation_intents set lease_expires_at=now(),next_attempt_at=now() where id=$1',
    [child.id]
  );
  expect(await runLaunchCleanupTick({ rpc }, driveFor)).toEqual({ completed: 1, pending: 0 });
  expect(deletePermission).toHaveBeenCalledOnce();
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_sharing where intent_id=$1 and file_id=$2',
        [child.id, driveFileId]
      )
    )[0].state
  ).toBe('cleaned');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from public.team_launch_generations where id=$1',
        [generation.id]
      )
    )[0].state
  ).toBe('canceled');
});

it('retains an exact grant for a registered competing catalog and settles the canceled parent', async () => {
  const driveFileId = `retained-source-video-${++seq}`;
  const source = (
    await db.root<{ id: string }>(
      `insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version)
       select team_id,connection_id,$2,'retained-source.mp4','file','video','video/mp4','1'
       from public.team_materials where id=$1 returning id`,
      [material, driveFileId]
    )
  )[0].id;
  const credential = (
    await db.root<{ id: string }>(
      'select c.credential_id id from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id where m.id=$1',
      [source]
    )
  )[0].id;
  const prepared = await prepare({ method: 'catalog', materialId: source });
  const generation = await accept(prepared.args);
  const parentOwner = 'retained-parent-owner';
  const parentClaim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, generation.id, ACTOR, parentOwner]
    )
  )[0].v;
  await db.root("select public.service_touch_launch_generation($1,$2,$3,$4,$5,'preparing')", [
    team,
    generation.id,
    ACTOR,
    parentOwner,
    parentClaim.fence
  ]);
  const childOwner = '72000000-0000-4000-8000-000000000061';
  const begin = async (key: string) =>
    (
      await db.root<{ v: { id: string; fence: string } }>(
        'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
        [team, source, ACTOR, key, JSON.stringify({ productCount: 2 }), childOwner]
      )
    )[0].v;
  const child = await begin(`launch:${generation.id}:catalog`);
  await db.root(
    "select public.service_record_catalog_permission($1,$2,$3,$4,$5,$6,$7,'retained-exact-grant',false,'created')",
    [team, child.id, ACTOR, childOwner, child.fence, driveFileId, credential]
  );
  const consumer = await begin(`registered-consumer-${++seq}`);
  await db.root("update private.catalog_generation_intents set state='registered' where id=$1", [
    consumer.id
  ]);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    prepared.id,
    generation.id,
    `retained-cancel-${++seq}`
  ]);
  await db.root('update public.team_launch_generations set lease_expires_at=now() where id=$1', [
    generation.id
  ]);
  await db.root(
    'update private.catalog_generation_intents set lease_expires_at=now() where id=$1',
    [child.id]
  );
  const owner = '72000000-0000-4000-8000-000000000062';
  const plan = (
    await db.root<{ v: { generationId: string; fence: string; intentFence: string }[] }>(
      'select public.service_claim_launch_cleanup($1,3) v',
      [owner]
    )
  )[0].v.find(item => item.generationId === generation.id);
  expect(plan).toBeTruthy();
  if (!plan) throw new Error('retained grant plan missing');
  const args = [team, generation.id, owner, plan.fence, plan.intentFence];
  expect(
    (
      await db.root<{ v: { fileId: string; permissionId: string }[] }>(
        'select public.service_list_launch_cleanup_permissions($1,$2,$3,$4,$5) v',
        args
      )
    )[0].v
  ).toEqual([
    expect.objectContaining({ fileId: driveFileId, permissionId: 'retained-exact-grant' })
  ]);
  const grantArgs = [...args, driveFileId, credential, 'retained-exact-grant'];
  await db.root('update public.team_launch_generations set lease_owner=null where id=$1', [
    generation.id
  ]);
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_authorize_launch_permission_cleanup($1,$2,$3,$4,$5,$6,$7,$8) v',
        grantArgs
      )
    )[0].v
  ).toBe('unknown');
  await expect(
    db.root(
      'select public.service_mark_launch_permission_retained($1,$2,$3,$4,$5,$6,$7,$8)',
      grantArgs
    )
  ).rejects.toThrow('LEASE_MISMATCH');
  await db.root('update public.team_launch_generations set lease_owner=$2 where id=$1', [
    generation.id,
    owner
  ]);
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_authorize_launch_permission_cleanup($1,$2,$3,$4,$5,$6,$7,$8) v',
        grantArgs
      )
    )[0].v
  ).toBe('retained');
  await db.root(
    'select public.service_mark_launch_permission_retained($1,$2,$3,$4,$5,$6,$7,$8)',
    grantArgs
  );
  expect(
    (
      await db.root<{ v: string }>(
        'select public.service_finish_launch_cleanup($1,$2,$3,$4,$5,null) v',
        args
      )
    )[0].v
  ).toBe('canceled');
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_generation_sharing where intent_id=$1 and file_id=$2',
        [child.id, driveFileId]
      )
    )[0].state
  ).toBe('retained');
});

it('does not report later or auxiliary work complete when recovery re-enters an earlier checkpoint', async () => {
  const prepared = await prepare({ method: 'catalog' });
  const accepted = await accept(prepared.args);
  const owner = 'checkpoint-reentry-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  const touch = (stage: string) =>
    db.root('select public.service_touch_launch_generation($1,$2,$3,$4,$5,$6)', [
      team,
      accepted.id,
      ACTOR,
      owner,
      claim.fence,
      stage
    ]);
  await touch('catalog_registering');
  await db.root(
    "insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence) values($1,$2,'native_restitch','native-proof','running',$3)",
    [team, accepted.id, claim.fence]
  );
  await touch('preparing');
  const states = async () =>
    Object.fromEntries(
      (
        await db.root<{ stage: string; state: string }>(
          'select stage,state from public.team_launch_generation_steps where generation_id=$1',
          [accepted.id]
        )
      ).map(row => [row.stage, row.state])
    );
  expect(await states()).toMatchObject({
    preparing: 'running',
    catalog_registering: 'running',
    native_restitch: 'running'
  });
  await touch('catalog_planning');
  expect(await states()).toMatchObject({
    preparing: 'succeeded',
    catalog_planning: 'running',
    catalog_registering: 'running',
    native_restitch: 'running'
  });
});

it('durably rejects a late acceptance after canceling its request before acceptance', async () => {
  const prepared = await prepare();
  const args = [team, prepared.id, prepared.args[4], `preaccept-cancel-${++seq}`];
  const canceled = (
    await db.asUser<{ v: unknown }>(
      ACTOR,
      'select public.cancel_launch_request($1,$2,$3,$4) v',
      args
    )
  )[0].v;
  expect(canceled).toMatchObject({ state: 'canceled' });
  expect(
    (
      await db.asUser<{ v: unknown }>(
        ACTOR,
        'select public.cancel_launch_request($1,$2,$3,$4) v',
        args
      )
    )[0].v
  ).toEqual(canceled);
  await expect(accept(prepared.args)).rejects.toThrow('PROCESS_CANCELED');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from public.team_launch_generations where launch_id=$1',
        [prepared.id]
      )
    )[0].n
  ).toBe(0);
});

it('delegates request cancellation after acceptance and preserves a success that committed first', async () => {
  const prepared = await prepare();
  const accepted = await accept(prepared.args);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    accepted.fence
  ]);
  const result = (
    await db.asUser<{ v: { state: string } }>(
      ACTOR,
      'select public.cancel_launch_request($1,$2,$3,$4) v',
      [team, prepared.id, prepared.args[4], `success-cancel-${++seq}`]
    )
  )[0].v;
  expect(result.state).toBe('succeeded');
  const pending = await prepare();
  await accept(pending.args);
  const canceled = (
    await db.asUser<{ v: { state: string } }>(
      ACTOR,
      'select public.cancel_launch_request($1,$2,$3,$4) v',
      [team, pending.id, pending.args[4], `accepted-cancel-${++seq}`]
    )
  )[0].v;
  expect(canceled.state).toBe('canceled');
});

it('rejects a Buyer from a different workspace during source resolution before accepting generation', async () => {
  const foreignTeam = (
    await db.asUser<{ id: string }>(
      ACTOR,
      "select id from public.create_team('Foreign Launch Buyer')"
    )
  )[0].id;
  const foreignBuyer = (
    await db.asUser<{ v: { id: string } }>(
      ACTOR,
      "select public.create_launch_dictionary($1,'buyers','foreign_buyer','foreign-buyer-request') v",
      [foreignTeam]
    )
  )[0].v.id;
  await expect(prepare({ buyerId: foreignBuyer })).rejects.toThrow('SOURCE_CHANGED');
});
it('resolves advertising accounts by their row UUID when their displayed suffixes match', async () => {
  const secondAccount = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name) values($1,$2,'g2') returning id",
      [team, ACTOR]
    )
  )[0].id;
  const secondAgent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id) values($1,$2,$3,'9876543892') returning id",
      [team, secondAccount, ACTOR]
    )
  )[0].id;
  const selected = await prepare({ agentRowId: secondAgent });
  const snapshot = JSON.parse(String(selected.args[7])) as {
    accountId: string;
    social: string;
    agentId: string;
  };
  expect(snapshot).toMatchObject({ accountId: secondAccount, social: 'g2', agentId: '9876543892' });
  const accepted = await accept(selected.args);
  const name = (
    await db.root<{ name: string }>(
      'select name from public.team_launch_campaigns where revision_id=$1 and ordinal=1',
      [accepted.revisionId]
    )
  )[0].name;
  expect(name).toContain('[g2-892-v5]');
  expect(name).not.toContain('[g1-892-v5]');
});

it('persists a closed preparation failure after acceptance and replays it without a new draw', async () => {
  const prepared = await prepare({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = await accept(prepared.args);
  await db.root('update public.team_restitch_defaults set configured=false where team_id=$1', [
    team
  ]);
  const first = (
    await db.asUser<{ v: { errorCode: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, accepted.id]
    )
  )[0].v;
  expect(first).toEqual({ errorCode: 'SOURCE_CHANGED' });
  const state = async () =>
    (
      await db.root<{
        state: string;
        stage: string;
        safe_error_code: string;
        state_version: string;
      }>(
        'select state,stage,safe_error_code,state_version from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0];
  const recorded = await state();
  expect(recorded).toMatchObject({
    state: 'failed',
    stage: 'restitch_preparing',
    safe_error_code: 'SOURCE_CHANGED'
  });
  const projected = (
    await db.asUser<{ v: { generation: { steps: unknown[]; stepsTruncated: boolean } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, prepared.id]
    )
  )[0].v.generation;
  expect(projected.steps).toEqual([
    expect.objectContaining({
      stage: 'restitch_preparing',
      state: 'failed',
      errorCode: 'SOURCE_CHANGED'
    })
  ]);
  expect(projected.stepsTruncated).toBe(false);
  expect(JSON.stringify(projected.steps)).not.toContain('checkpoint');

  expect(
    (
      await db.asUser<{ v: unknown }>(ACTOR, 'select public.prepare_launch_restitch($1,$2) v', [
        team,
        accepted.id
      ])
    )[0].v
  ).toEqual(first);
  expect(await state()).toEqual(recorded);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.launch_restitch_preparations where generation_id=$1',
        [accepted.id]
      )
    )[0].n
  ).toBe(0);
  await db.root('update public.team_restitch_defaults set configured=true where team_id=$1', [
    team
  ]);
});

it('records revoked actor authority once and drains those rows from recovery without publishing their results', async () => {
  const prepared = await prepare({ method: 'catalog' });
  const editor = '72000000-0000-4000-8000-000000000099';
  await createUser(db, { id: editor, email: 'revoked-launch-editor@example.test' });
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'editor')",
    [team, editor]
  );
  const args = [...prepared.args];
  args[2] = editor;
  const accepted = await accept(args);
  await db.root(
    "update public.team_members set status='removed',removed_at=now() where team_id=$1 and user_id=$2",
    [team, editor]
  );
  try {
    const healthy = await prepare({ method: 'catalog' });
    const valid = await accept(healthy.args);
    await db.root(
      "update public.team_launch_generations set next_attempt_at=now()-interval '1 year' where id=$1",
      [valid.id]
    );
    const selected = (
      await db.root<{ v: { generationId: string }[] }>(
        'select public.service_list_launch_catalog_recovery(1) v'
      )
    )[0].v;
    expect(selected.map(item => item.generationId)).toEqual([valid.id]);
    for (let round = 0; round < 5; round++)
      await db.root('select public.service_settle_launch_authority_losses(10)');
    const row = (
      await db.root<{ state: string; safe_error_code: string; state_version: string }>(
        'select state,safe_error_code,state_version from public.team_launch_generations where id=$1',
        [accepted.id]
      )
    )[0];
    expect(row).toMatchObject({ state: 'failed', safe_error_code: 'PERMISSION_DENIED' });
    expect(
      (
        await db.root<{ v: number }>('select public.service_settle_launch_authority_losses(10) v')
      )[0].v
    ).toBe(0);
    expect(
      (
        await db.root<{ id: string | null }>(
          'select active_revision_id id from public.team_launches where id=$1',
          [prepared.id]
        )
      )[0].id
    ).toBeNull();
    expect(
      (
        await db.root<{ n: number }>(
          "select count(*)::integer n from public.team_launch_generation_steps where generation_id=$1 and stable_step_key like 'authority:%'",
          [accepted.id]
        )
      )[0].n
    ).toBe(1);
  } finally {
    await db.root(
      "update public.team_members set status='active',removed_at=null where team_id=$1 and user_id=$2",
      [team, editor]
    );
  }
});

it('binds the exact reserved catalog version without changing the child request, then freezes the published SUB', async () => {
  const p = await prepare({
    method: 'catalog',
    originalUrl: 'https://example.invalid/?sub1=old&x={{campaign.id}}',
    subConfig: { schemaVersion: 1, sub1: ['catalogName'], sub2: [], sub3: [] }
  });
  const accepted = await accept(p.args);
  const owner = 'versioned-catalog-executor';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, accepted.id, ACTOR, owner]
    )
  )[0].v;
  const original = (
    await db.root<{ url: string }>(
      'select generated_url url from public.team_launch_revisions where id=$1',
      [accepted.revisionId]
    )
  )[0].url;
  const key = `launch:${accepted.id}:catalog`;
  const childOwner = '72000000-0000-4000-8000-000000000029';
  const payload = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: original,
    productCount: 100,
    replacesMaterialId: null,
    restitchOperationId: null,
    idempotencyKey: key,
    randomLinkVariation: true
  };
  const intent = (
    await db.root<{ v: { id: string; fence: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  const name = `creative_v${intent.variant}_catalog`;
  const source = parseLaunchSources(JSON.parse(p.args[7] as string))!;
  const resolved = launchPreview(p.config, source, name);
  if (!resolved.ok) throw new Error('fixture');
  const authority = [team, accepted.id, ACTOR, owner, claim.fence];
  const bind = 'select public.service_bind_launch_catalog_subs($1,$2,$3,$4,$5,$6,$7,$8)';
  await expect(
    db.root(bind, [
      ...authority,
      name,
      resolved.value.advertisingUrl,
      JSON.stringify(resolved.value.subValues)
    ])
  ).rejects.toThrow('WRONG_STATE');
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'planned',$6,null,null)",
    [
      team,
      intent.id,
      ACTOR,
      childOwner,
      intent.fence,
      JSON.stringify({ namePlan: { name, reservationKey: name } })
    ]
  );
  await expect(
    db.root(bind, [
      team,
      accepted.id,
      ACTOR,
      owner,
      '0',
      name,
      resolved.value.advertisingUrl,
      JSON.stringify(resolved.value.subValues)
    ])
  ).rejects.toThrow('LEASE_MISMATCH');
  await db.root(bind, [
    ...authority,
    name,
    resolved.value.advertisingUrl,
    JSON.stringify(resolved.value.subValues)
  ]);
  expect(
    (
      await db.root<{ url: string }>(
        'select generated_url url from public.team_launch_revisions where id=$1',
        [accepted.revisionId]
      )
    )[0].url
  ).toBe(original);
  // Retry preserves the version and acquires a fresh child fence.
  const replay = (
    await db.root<{ v: { variant: number; fence: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  expect(replay.variant).toBe(intent.variant);
  intent.fence = replay.fence;
  const cat = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,$3,'file','other','application/vnd.google-apps.spreadsheet','1' from public.team_materials where id=$1 returning id",
      [material, `versioned-catalog-${seq}`, name]
    )
  )[0].id;
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/versioned-synthetic';
  await db.root(
    'insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,$4,100,$5,$6,$7,$8,$9)',
    [
      cat,
      team,
      material,
      resolved.value.advertisingUrl,
      sheetUrl,
      'https://drive.google.com/file/d/synthetic',
      JSON.stringify({ title: 'Synthetic' }),
      ACTOR,
      intent.variant
    ]
  );
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered','{}',null,$6)",
    [
      team,
      intent.id,
      ACTOR,
      childOwner,
      intent.fence,
      JSON.stringify({
        outcome: 'created',
        videoShared: false,
        catalog: {
          materialId: cat,
          name,
          sheetUrl,
          sourceLink: resolved.value.advertisingUrl,
          productCount: 100,
          createdAt: null,
          variant: intent.variant
        }
      })
    ]
  );
  await db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', authority);
  const baseline = (
    await db.root<{ url: string; sub: string }>(
      "select generated_url url,sub_values->>'sub1' sub from public.team_launch_revisions where id=$1",
      [accepted.revisionId]
    )
  )[0];
  expect(baseline).toEqual({ url: resolved.value.advertisingUrl, sub: name });
  expect(
    (
      await db.root<{ binding: unknown }>(
        'select catalog_sub_binding binding from public.analytics_launch_generations where generation_id=$1',
        [accepted.id]
      )
    )[0].binding
  ).toEqual({ required: true, resolved: true, committed: false });
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    claim.fence
  ]);
  setQueryExecutor((sql, params) => db.root(sql, params));
  try {
    const evidence = await getLaunchEvidence(accepted.id);
    expect(evidence.generations[0].catalog_sub_binding).toEqual({
      required: true,
      resolved: true,
      committed: true
    });
    expect(JSON.stringify(evidence)).not.toContain(name);
  } finally {
    setQueryExecutor(null);
  }
  await expect(
    db.root(
      "update public.team_launch_revisions set generated_url='https://changed.invalid/' where id=$1",
      [accepted.revisionId]
    )
  ).rejects.toThrow('WRONG_STATE');
});

it('persists Launch notes in drafts and immutable history while rejecting malformed payloads', async () => {
  const notes = [
    { id: '80000000-0000-4000-8000-000000000001', title: 'Audience', text: 'Line one\nLine two' },
    { id: '80000000-0000-4000-8000-000000000002', title: '', text: 'Another' }
  ];
  const p = await prepare({ notes });
  const draft = (
    await db.asUser<{ v: { draft: { notes: unknown } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(draft.draft.notes).toEqual(notes);
  const accepted = await accept(p.args);
  expect(
    (
      await db.root<{ notes: unknown }>(
        "select config->'notes' notes from public.team_launch_revisions where id=$1",
        [accepted.revisionId]
      )
    )[0].notes
  ).toEqual(notes);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    accepted.fence
  ]);
  // The historical revision keeps the text even when current notes change.
  const version = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v.version;
  await db.asUser(ACTOR, 'select public.save_launch_draft($1,$2,$3,$4,$5,null)', [
    team,
    p.id,
    version,
    `notes-clear-${++seq}`,
    JSON.stringify({ ...p.config, notes: [] })
  ]);
  expect(
    (
      await db.root<{ notes: unknown }>(
        "select config->'notes' notes from public.team_launch_revisions where id=$1",
        [accepted.revisionId]
      )
    )[0].notes
  ).toEqual(notes);
  for (const invalid of [
    { notes: [{ ...notes[0], text: 12 }] },
    { notes: [notes[0], notes[0]] },
    { notes: null }
  ]) {
    await expect(
      db.asUser(ACTOR, 'select public.save_launch_draft($1,null,null,$2,$3,null)', [
        team,
        `notes-invalid-${++seq}`,
        JSON.stringify({ ...p.config, ...invalid })
      ])
    ).rejects.toThrow('INVALID_INPUT');
  }
});

it('keeps copy receipts personal, value-sensitive and stable across manual saves without changing Launch versions', async () => {
  const noteId = '82000000-0000-4000-8000-000000000001';
  const p = await prepare({
    notes: [{ id: noteId, title: 'Private title', text: 'SYNTHETIC_NOTE\nbody' }]
  });
  const accepted = await accept(p.args);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    accepted.id,
    ACTOR,
    accepted.fence
  ]);
  const get = 'select public.get_launch_copy_marks($1,$2,$3,$4,$5) v';
  const set = 'select public.set_launch_copy_marks($1,$2,$3,$4,$5,$6)';
  const values = {
    'campaign:1': 'SYNTHETIC_CAMPAIGN',
    advertising_url: 'https://secret.example.invalid/?token=SYNTHETIC_COPY_SECRET',
    [`note:${noteId}`]: 'SYNTHETIC_NOTE\nbody'
  };
  const args = [team, p.id, accepted.revisionId, ACTOR, JSON.stringify(values)];
  expect((await db.asUser<{ v: string[] }>(ACTOR, get, args))[0].v).toEqual([]);
  const version = (
    await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
      team,
      p.id
    ])
  )[0].v.version;
  await db.asUser(ACTOR, set, [...args, true]);
  expect((await db.asUser<{ v: string[] }>(ACTOR, get, args))[0].v).toEqual(
    Object.keys(values).sort()
  );
  expect(
    (
      await db.asUser<{ v: { version: string } }>(ACTOR, 'select public.get_launch($1,$2,null) v', [
        team,
        p.id
      ])
    )[0].v.version
  ).toBe(version);
  const changed = { ...values, 'campaign:1': 'Changed campaign' };
  expect(
    (
      await db.asUser<{ v: string[] }>(ACTOR, get, [...args.slice(0, 4), JSON.stringify(changed)])
    )[0].v
  ).not.toContain('campaign:1');
  const viewer = '82000000-0000-4000-8000-000000000002';
  await createUser(db, { id: viewer, email: 'copy-viewer@example.test' });
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, viewer]
  );
  const viewerArgs = [team, p.id, accepted.revisionId, viewer, JSON.stringify(values)];
  expect((await db.asUser<{ v: string[] }>(viewer, get, viewerArgs))[0].v).toEqual([]);
  await db.asUser(viewer, set, [...viewerArgs, true]);
  expect((await db.asUser<{ v: string[] }>(viewer, get, viewerArgs))[0].v).toHaveLength(3);
  await expect(db.asUser(ACTOR, set, [...viewerArgs, true])).rejects.toThrow('PERMISSION_DENIED');
  const fingerprints = await db.root<{ fingerprint: string }>(
    "select encode(fingerprint,'hex') fingerprint from private.launch_copy_marks where launch_id=$1 and field='campaign:1' order by user_id",
    [p.id]
  );
  expect(fingerprints[0].fingerprint).not.toBe(fingerprints[1].fingerprint);
  expect(
    JSON.stringify(
      await db.root('select * from private.launch_copy_marks where launch_id=$1', [p.id])
    )
  ).not.toContain('SYNTHETIC_COPY_SECRET');
  await db.asUser(ACTOR, 'select public.save_launch_overrides($1,$2,$3,$4,$5,$6)', [
    team,
    p.id,
    accepted.revisionId,
    version,
    `copy-marks-manual-${++seq}`,
    JSON.stringify({ campaigns: { '1': { name: 'SYNTHETIC_CAMPAIGN' } } })
  ]);
  const manual = (
    await db.asUser<{ v: { version: string; activeRevision: { id: string } } }>(
      ACTOR,
      'select public.get_launch($1,$2,null) v',
      [team, p.id]
    )
  )[0].v;
  expect(
    (
      await db.asUser<{ v: string[] }>(ACTOR, get, [
        team,
        p.id,
        manual.activeRevision.id,
        ACTOR,
        JSON.stringify(values)
      ])
    )[0].v
  ).toHaveLength(3);
  await db.asUser(ACTOR, set, [...args, false]);
  expect((await db.asUser<{ v: string[] }>(ACTOR, get, args))[0].v).toEqual([]);
  expect((await db.asUser<{ v: string[] }>(viewer, get, viewerArgs))[0].v).toHaveLength(3);
  // A stale tab clearing old content cannot erase a newer value's receipt.
  const edited = { 'campaign:1': 'SYNTHETIC_EDITED_VALUE' };
  await db.asUser(ACTOR, set, [
    team,
    p.id,
    accepted.revisionId,
    ACTOR,
    JSON.stringify(edited),
    true
  ]);
  await db.asUser(ACTOR, set, [...args, false]);
  expect(
    (
      await db.asUser<{ v: string[] }>(ACTOR, get, [
        team,
        p.id,
        accepted.revisionId,
        ACTOR,
        JSON.stringify(edited)
      ])
    )[0].v
  ).toEqual(['campaign:1']);
  // Undo restores only this actor; a new generation resets ordinary fields, not unchanged note bodies.
  await db.asUser(ACTOR, set, [...args, true]);
  const nextArgs = [...p.args];
  nextArgs[3] = manual.version;
  nextArgs[4] = `copy-marks-generation-${++seq}`;
  nextArgs[5] = `copy-marks-digest-${seq}`;
  const next = await accept(nextArgs);
  expect(
    (
      await db.asUser<{ v: string[] }>(ACTOR, get, [
        team,
        p.id,
        next.revisionId,
        ACTOR,
        JSON.stringify(values)
      ])
    )[0].v
  ).toEqual([`note:${noteId}`]);
  await db.asUser(ACTOR, 'select public.cancel_launch_generation($1,$2,$3,$4)', [
    team,
    p.id,
    next.id,
    `copy-marks-cancel-${++seq}`
  ]);
  await db.root(
    "update public.team_members set status='removed',removed_at=clock_timestamp() where team_id=$1 and user_id=$2",
    [team, viewer]
  );
  await expect(db.asUser(viewer, get, viewerArgs)).rejects.toThrow();
});

it('registers a restitched catalog with the staged versioned SUB before publishing the revision', async () => {
  await db.root('update public.team_restitch_defaults set configured=false where team_id=$1', [
    team
  ]);
  const p = await prepare({
    method: 'catalog',
    originalUrl: 'https://example.invalid/?sub1=old&x={{campaign.id}}',
    subConfig: { schemaVersion: 1, sub1: ['catalogName'], sub2: [], sub3: [] },
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const g = await accept(p.args);
  const prep = (
    await db.asUser<{ v: { processKey: string } }>(
      ACTOR,
      'select public.prepare_launch_restitch($1,$2) v',
      [team, g.id]
    )
  )[0].v;
  const op = (
    await db.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1,$2,'process','pending',$3,$4,$5) returning id",
      [team, ACTOR, material, prep.processKey, `versioned-restitch-${++seq}`]
    )
  )[0].id;
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,tool_contract_version,relation) values($1,$2,'restitch',2,'processed_from')",
    [op, team]
  );
  await db.asUser(ACTOR, 'select public.bind_launch_restitch($1,$2,$3)', [team, g.id, op]);
  await db.root("update public.team_operations set state='running' where id=$1", [op]);
  const video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) select team_id,connection_id,$2,'sub-restitch.mp4','file','video','video/mp4','1',$3 from public.team_materials where id=$1 returning id",
      [material, `sub-restitch-${seq}`, 'a'.repeat(32)]
    )
  )[0].id;
  await db.root(
    "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
    [op, video]
  );
  await db.asUser(ACTOR, 'select public.settle_launch_restitch($1,$2)', [team, g.id]);
  const owner = 'versioned-restitch-owner';
  const claim = (
    await db.root<{ v: { fence: string } }>(
      'select public.service_claim_launch_generation($1,$2,$3,$4) v',
      [team, g.id, ACTOR, owner]
    )
  )[0].v;
  const authority = [team, g.id, ACTOR, owner, claim.fence];
  const original = (
    await db.root<{ url: string }>(
      'select generated_url url from public.team_launch_revisions where id=$1',
      [g.revisionId]
    )
  )[0].url;
  const key = `launch:${g.id}:catalog`;
  const childOwner = crypto.randomUUID();
  const payload = {
    teamId: team,
    videoMaterialId: material,
    sourceLink: original,
    productCount: 100,
    replacesMaterialId: null,
    restitchOperationId: op,
    idempotencyKey: key,
    randomLinkVariation: true
  };
  const child = (
    await db.root<{ v: { id: string; fence: string; variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6) v',
      [team, material, ACTOR, key, JSON.stringify(payload), childOwner]
    )
  )[0].v;
  const name = `v5_v${child.variant}_catalog`;
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'planned',$6,null,null)",
    [
      team,
      child.id,
      ACTOR,
      childOwner,
      child.fence,
      JSON.stringify({ namePlan: { name, reservationKey: name } })
    ]
  );
  const source = parseLaunchSources(JSON.parse(p.args[7] as string))!;
  const preview = launchPreview(p.config, source, name);
  if (!preview.ok) throw new Error('fixture');
  const cat = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) select team_id,connection_id,$2,$3,'file','other','application/vnd.google-apps.spreadsheet','1' from public.team_materials where id=$1 returning id",
      [material, `sub-sheet-${seq}`, name]
    )
  )[0].id;
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'finalized',$6,null,null)",
    [team, child.id, ACTOR, childOwner, child.fence, JSON.stringify({ materialId: cat })]
  );
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/sub-restitch-synthetic';
  const record = {
    sourceLink: preview.value.advertisingUrl,
    productCount: 100,
    sheetUrl,
    videoLink: 'https://drive.google.com/file/d/original',
    currentVideoLink: 'https://drive.google.com/file/d/restitch',
    restitchMaterialId: video,
    restitchOperationId: op,
    settingsSnapshot: {
      title: 'Synthetic',
      description: 'Product',
      price: 10,
      imageLink: 'https://example.invalid/image.jpg'
    },
    createdBy: ACTOR,
    variant: child.variant
  };
  const link = 'select public.service_link_launch_restitch_catalog($1,$2,$3,$4,$5,$6,$7) v';
  await expect(db.root(link, [...authority, cat, JSON.stringify(record)])).rejects.toThrow(
    'WRONG_STATE'
  );
  await db.root('select public.service_bind_launch_catalog_subs($1,$2,$3,$4,$5,$6,$7,$8)', [
    ...authority,
    name,
    preview.value.advertisingUrl,
    JSON.stringify(preview.value.subValues)
  ]);
  await expect(
    db.root(link, [...authority, cat, JSON.stringify({ ...record, sourceLink: original })])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await db.root<{ v: { linked: boolean } }>(link, [...authority, cat, JSON.stringify(record)])
    )[0].v.linked
  ).toBe(true);
  expect(
    (
      await db.root<{ url: string }>(
        'select generated_url url from public.team_launch_revisions where id=$1',
        [g.revisionId]
      )
    )[0].url
  ).toBe(original);
  const result = {
    outcome: 'created',
    videoShared: true,
    catalog: {
      materialId: cat,
      name,
      sheetUrl,
      sourceLink: preview.value.advertisingUrl,
      productCount: 100,
      createdAt: null,
      variant: child.variant
    }
  };
  await db.root(
    "select public.service_checkpoint_catalog_intent($1,$2,$3,$4,$5,'registered','{}',null,$6)",
    [team, child.id, ACTOR, childOwner, child.fence, JSON.stringify(result)]
  );
  await db.root('select public.service_attach_launch_catalog($1,$2,$3,$4,$5)', authority);
  await db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
    team,
    g.id,
    ACTOR,
    claim.fence
  ]);
  setQueryExecutor((sql, params) => db.root(sql, params));
  try {
    const evidence = (await getLaunchEvidence(g.id)).generations[0];
    expect(evidence.state).toBe('succeeded');
    expect(evidence.catalog_sub_binding).toEqual({
      required: true,
      resolved: true,
      committed: true
    });
    expect(JSON.stringify(evidence)).not.toContain(preview.value.advertisingUrl);
  } finally {
    setQueryExecutor(null);
  }
  await expect(
    db.root(
      "update public.team_launch_revisions set generated_url='https://changed.invalid/' where id=$1",
      [g.revisionId]
    )
  ).rejects.toThrow('WRONG_STATE');
});
