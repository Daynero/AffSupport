import { afterAll, expect, it } from 'vitest';
import { launchRevisionImpact, launchPreview } from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb | undefined;
afterAll(async () => db?.close());
it('applies the duration migration and preserves validated bounds in defaults', async () => {
  db = await createTeamTestDb();
  const owner = '71000000-0000-4000-8000-000000000071';
  await createUser(db, { id: owner, email: 'duration@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [{ id: team }] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Duration test')"
  );
  const catalog = {
    productCount: 3,
    restitchEnabled: true,
    finalDurationMode: 'random-centered',
    customFinalDurationSeconds: 1800,
    finalDurationRangeSeconds: [1200, 2400]
  };
  await db.root(
    'insert into public.team_launch_defaults(team_id,updated_by,config) values ($1,$2,$3)',
    [team, owner, JSON.stringify({ catalog })]
  );
  const [row] = await db.root<{ config: { catalog: typeof catalog } }>(
    'select config from public.team_launch_defaults where team_id=$1',
    [team]
  );
  expect(row.config.catalog.finalDurationRangeSeconds).toEqual([1200, 2400]);
  for (const bounds of [[2400, 1200], [0, 2400], [60, 3660], [61, 120], [60], null]) {
    await expect(
      db.root('update public.team_launch_defaults set config=$2 where team_id=$1', [
        team,
        JSON.stringify({ catalog: { ...catalog, finalDurationRangeSeconds: bounds } })
      ])
    ).rejects.toThrow('INVALID_INPUT');
  }
  await db.root('update public.team_launch_defaults set config=$2 where team_id=$1', [
    team,
    JSON.stringify({ minBudget: 10, maxBudget: 30, catalog })
  ]);
  const [budgetBounds] = await db.root<{ config: { minBudget: number; maxBudget: number } }>(
    'select config from public.team_launch_defaults where team_id=$1',
    [team]
  );
  expect(budgetBounds.config).toMatchObject({ minBudget: 10, maxBudget: 30 });
  for (const minBudget of [0, -1, 1.5, 40]) {
    await expect(
      db.root('update public.team_launch_defaults set config=$2 where team_id=$1', [
        team,
        JSON.stringify({ minBudget, maxBudget: 30, catalog })
      ])
    ).rejects.toThrow('INVALID_INPUT');
  }
  // SQL guards and browser/Edge impact must agree for every active/inactive duration field.
  for (const restitchEnabled of [false, true]) {
    for (const finalDurationMode of [
      'custom',
      'random-centered',
      'random-30-40',
      'random-40-50',
      'random-50-60'
    ] as const) {
      const before = launchConfig({
        method: 'catalog',
        catalog: {
          productCount: 3,
          restitchEnabled,
          finalDurationMode,
          customFinalDurationSeconds: 180,
          finalDurationRangeSeconds: [120, 240]
        }
      });
      const preview = launchPreview(before, launchSources);
      if (!preview.ok) throw new Error('fixture');
      for (const change of [
        { customFinalDurationSeconds: 240 },
        { finalDurationRangeSeconds: [60, 240] as [number, number] },
        { finalDurationRangeSeconds: [120, 300] as [number, number] },
        { finalDurationRangeSeconds: undefined },
        { finalDurationMode: 'random-50-60' as const },
        { restitchEnabled: !restitchEnabled },
        { productCount: 100 }
      ]) {
        const after = { ...before, catalog: { ...before.catalog, ...change } };
        const [row] = await db.root<{ equal: boolean }>(
          'select private.launch_restitch_config_identity($1) = private.launch_restitch_config_identity($2) as equal',
          [JSON.stringify(before.catalog), JSON.stringify(after.catalog)]
        );
        expect(row.equal, JSON.stringify({ restitchEnabled, finalDurationMode, change })).toBe(
          !launchRevisionImpact(preview.value, preview.value, before, after).mediaChanged
        );
      }
    }
  }
}, 60000);
