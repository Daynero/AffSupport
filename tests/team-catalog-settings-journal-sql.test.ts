import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const OWNER = '27000000-0000-4000-8000-000000000001';
const VIEWER = '27000000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
let connection: string;
let legacy: { sheet: string; video: string };
let seq = 0;
interface Observation {
  source: 'baseline' | 'change';
  baseline_kind: string | null;
  actor_id: string | null;
  actor_kind: string;
  creator_id: string | null;
  changed_fields: string[];
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown>;
  profile_version: number;
}
const history = (catalog: string) =>
  db.root<Observation>(
    'select * from public.analytics_catalog_settings_history where catalog_material_id = $1 order by observed_at,event_id',
    [catalog]
  );
async function catalog() {
  seq += 1;
  const material = async (name: string, mime: string, category: string) =>
    (
      await db.root<{ id: string }>(
        `insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
     values($1,$2,$3,'root',$4,'file',$5,$6) returning id`,
        [team, connection, `journal-drive-${seq}-${category}`, name, category, mime]
      )
    )[0]!.id;
  const video = await material('private-video-name.mp4', 'video/mp4', 'video');
  const sheet = await material(
    'private-catalog-name',
    'application/vnd.google-apps.spreadsheet',
    'other'
  );
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4::jsonb)', [
    team,
    video,
    sheet,
    JSON.stringify({
      sourceLink: 'https://private-offer.test/secret',
      productCount: 3,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/private/edit',
      videoLink: 'https://drive.google.com/file/d/private/view',
      createdBy: OWNER,
      settingsSnapshot: {
        title: 'private-title',
        description: 'private-description',
        price: 10,
        imageLink: 'https://private.test/image.png'
      }
    })
  ]);
  return { sheet, video };
}
const patch = async (id: string, changes: object, actor = OWNER) => {
  const version = Number(
    (
      await db.root<{ version: number }>(
        'select version from public.team_catalog_update_profiles where catalog_material_id = $1',
        [id]
      )
    )[0]!.version
  );
  return db.asUser(actor, 'select public.patch_team_catalog_update_profile($1,$2,$3,$4::jsonb)', [
    team,
    id,
    version,
    JSON.stringify(changes)
  ]);
};

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261204160000_catalog_calendar_schedule.sql' });
  await createUser(db, { id: OWNER, email: 'owner@journal.test' });
  await createUser(db, { id: VIEWER, email: 'viewer@journal.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', ['Journal'])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, VIEWER]
  );
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
    values('journal-permission','private@journal.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id`,
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
    values($1,$2,'root','Private root','my_drive','connected',now()) returning id`,
      [team, credential]
    )
  )[0]!.id;
  legacy = await catalog();
  await db.db.exec(
    readFileSync('supabase/migrations/20261204170000_catalog_settings_journal.sql', 'utf8')
  );
}, 180_000);
afterAll(async () => db?.close());

describe('authoritative catalog settings journal', () => {
  it('backfills observed baselines without fabricating actions or creation history', async () => {
    const rows = await history(legacy.sheet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'baseline',
      baseline_kind: 'migration_observation',
      actor_id: null,
      actor_kind: 'system_unknown',
      creator_id: OWNER,
      changed_fields: [],
      before_state: null
    });
    expect(rows[0]!.after_state).toMatchObject({
      updateInterval: null,
      schedule: null,
      isActive: true,
      isDeleted: false
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /private-video-name|private-catalog-name|private-offer|private-title|private-description|private@/
    );
  });

  it('records creation as first observation rather than a user selection', async () => {
    const item = await catalog();
    expect((await history(item.sheet))[0]).toMatchObject({
      source: 'baseline',
      baseline_kind: 'first_observation',
      changed_fields: [],
      before_state: null
    });
  });

  it('rolls an atomic interval, civil schedule and all five boolean edits into one final change', async () => {
    const item = await catalog();
    const before = (await history(item.sheet))[0]!.after_state;
    const changes = Object.fromEntries(
      ['refreshImages', 'refreshTexts', 'growProducts', 'randomLinkVariation', 'restitch'].map(
        key => [key, !before[key]]
      )
    );
    const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
    await patch(item.sheet, { ...changes, updateInterval: '1w', schedule });
    const rows = await history(item.sheet);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      source: 'change',
      actor_id: OWNER,
      actor_kind: 'user',
      creator_id: OWNER,
      before_state: before
    });
    expect(rows[1]!.after_state).toMatchObject({
      ...changes,
      updateInterval: '1w',
      schedule,
      isActive: true
    });
    expect(rows[1]!.changed_fields).toEqual([
      'growProducts',
      'randomLinkVariation',
      'refreshImages',
      'refreshTexts',
      'restitch',
      'schedule',
      'updateInterval'
    ]);
    expect(
      new Set(
        (
          await db.root<{ transaction_id: string }>(
            'select transaction_id::text from public.analytics_catalog_settings_history where catalog_material_id=$1',
            [item.sheet]
          )
        ).map(row => row.transaction_id)
      ).size
    ).toBe(2);
  });

  it('covers legacy bulk writes and ignores no-op saves and next-run maintenance', async () => {
    const a = await catalog();
    const b = await catalog();
    await db.asUser(OWNER, 'select public.set_team_catalog_update_interval($1,$2,$3)', [
      team,
      [a.sheet, b.sheet],
      '1d'
    ]);
    for (const item of [a, b])
      expect((await history(item.sheet)).at(-1)).toMatchObject({
        source: 'change',
        actor_id: OWNER,
        changed_fields: ['updateInterval'],
        after_state: { updateInterval: '1d' }
      });
    await db.asUser(OWNER, 'select public.set_team_catalog_update_interval($1,$2,$3)', [
      team,
      [a.sheet, b.sheet],
      '1d'
    ]);
    await db.root(
      "update public.team_catalog_updater_items set next_run_at=next_run_at+interval '1 minute' where catalog_material_id=any($1)",
      [[a.sheet, b.sheet]]
    );
    for (const item of [a, b]) expect(await history(item.sheet)).toHaveLength(2);
  });

  it('records system actors as unknown and records reversals as committed changes', async () => {
    const item = await catalog();
    const original = (await history(item.sheet))[0]!.after_state.restitch;
    await db.root(
      'update public.team_catalog_update_profiles set restitch=not restitch where catalog_material_id=$1',
      [item.sheet]
    );
    expect((await history(item.sheet)).at(-1)).toMatchObject({
      actor_id: null,
      actor_kind: 'system_unknown',
      changed_fields: ['restitch']
    });
    await patch(item.sheet, { restitch: original });
    const rows = await history(item.sheet);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)).toMatchObject({ actor_id: OWNER, after_state: { restitch: original } });
  });

  it('deduplicates deferred and explicitly flushed intermediate writes and drops a net no-op', async () => {
    const item = await catalog();
    const before = (await history(item.sheet))[0]!.after_state.restitch;
    await db.root('begin');
    try {
      await db.root(
        'update public.team_catalog_update_profiles set restitch=not restitch where catalog_material_id=$1',
        [item.sheet]
      );
      await db.root('set constraints all immediate');
      await db.root(
        'update public.team_catalog_update_profiles set refresh_images=not refresh_images where catalog_material_id=$1',
        [item.sheet]
      );
      await db.root('commit');
    } catch (error) {
      await db.root('rollback');
      throw error;
    }
    expect(await history(item.sheet)).toHaveLength(2);
    expect((await history(item.sheet)).at(-1)!.changed_fields).toEqual([
      'refreshImages',
      'restitch'
    ]);
    await db.root('begin');
    try {
      await db.root(
        'update public.team_catalog_update_profiles set restitch=$2 where catalog_material_id=$1',
        [item.sheet, before]
      );
      await db.root('set constraints all immediate');
      await db.root(
        'update public.team_catalog_update_profiles set restitch=not restitch where catalog_material_id=$1',
        [item.sheet]
      );
      await db.root('commit');
    } catch (error) {
      await db.root('rollback');
      throw error;
    }
    expect(await history(item.sheet)).toHaveLength(2);
  });

  it('rolls journal observations back with the product transaction', async () => {
    const item = await catalog();
    await db.root('begin');
    try {
      await db.root(
        'update public.team_catalog_update_profiles set restitch=not restitch where catalog_material_id=$1',
        [item.sheet]
      );
      await db.root('set constraints all immediate');
      expect(await history(item.sheet)).toHaveLength(2);
    } finally {
      await db.root('rollback');
    }
    expect(await history(item.sheet)).toHaveLength(1);
  });

  it('closes active distributions on archive and retains a tombstone after catalog deletion', async () => {
    const item = await catalog();
    await db.asUser(
      OWNER,
      "update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=$1",
      [item.video]
    );
    expect((await history(item.sheet)).at(-1)).toMatchObject({
      actor_id: OWNER,
      changed_fields: ['isActive'],
      after_state: { isActive: false, isDeleted: false }
    });
    await db.root('delete from public.team_product_catalogs where material_id=$1', [item.sheet]);
    expect((await history(item.sheet)).at(-1)).toMatchObject({
      changed_fields: ['isDeleted'],
      after_state: { isActive: false, isDeleted: true }
    });
    expect(
      (
        await db.root<{ state: unknown }>(
          'select state from public.analytics_catalog_settings_current where catalog_material_id=$1',
          [item.sheet]
        )
      )[0]!.state
    ).toMatchObject({ isDeleted: true, isActive: false });
  });

  it('reports a real coverage boundary and requires every settings/lifecycle capture trigger', async () => {
    const coverage = async () =>
      (
        await db.root<{ installed_at: string; capture_enabled: boolean; schema_version: number }>(
          'select * from public.analytics_catalog_settings_coverage'
        )
      )[0]!;
    expect(await coverage()).toMatchObject({ capture_enabled: true, schema_version: 1 });
    expect(Number.isFinite(Date.parse((await coverage()).installed_at))).toBe(true);
    for (const [table, trigger] of [
      ['team_catalog_update_profiles', 'catalog_profile_settings_journal'],
      ['team_catalog_updater_items', 'catalog_interval_settings_journal'],
      ['team_product_catalogs', 'catalog_record_settings_journal'],
      ['team_materials', 'catalog_material_settings_journal'],
      ['team_materials', 'catalog_material_deleted_journal']
    ]) {
      await db.root(`alter table public.${table} disable trigger ${trigger}`);
      try {
        expect((await coverage()).capture_enabled).toBe(false);
      } finally {
        await db.root(`alter table public.${table} enable trigger ${trigger}`);
      }
    }
    expect((await coverage()).capture_enabled).toBe(true);
  });

  it('denies application readers/writers and grants only the privacy-scoped analytics views', async () => {
    const grants = (
      await db.root<{ app: boolean; raw: boolean; analytics: boolean; write: boolean }>(`select
      has_table_privilege('authenticated','public.analytics_catalog_settings_history','SELECT') as app,
      has_table_privilege('authenticated','private.catalog_settings_journal','SELECT') as raw,
      has_table_privilege('wishly_analytics_ro','public.analytics_catalog_settings_history','SELECT') as analytics,
      has_table_privilege('wishly_analytics_ro','public.analytics_catalog_settings_history','INSERT') as write`)
    )[0]!;
    expect(grants).toEqual({ app: false, raw: false, analytics: true, write: false });
    await db.root('set role authenticated');
    try {
      await expect(
        db.root('select * from public.analytics_catalog_settings_history')
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.root('reset role');
    }
    await db.root('set role wishly_analytics_ro');
    try {
      expect(
        await db.root('select * from public.analytics_catalog_settings_history limit 1')
      ).toHaveLength(1);
      await expect(db.root('select * from private.catalog_settings_journal')).rejects.toThrow(
        /permission denied/
      );
    } finally {
      await db.root('reset role');
    }
    await expect(patch(legacy.sheet, { restitch: true }, VIEWER)).rejects.toThrow(
      /PERMISSION_DENIED/
    );
  });
});
