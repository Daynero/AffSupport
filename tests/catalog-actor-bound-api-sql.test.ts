import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const controls = vi.hoisted(() => ({ rpc: vi.fn(), sessions: [] as Array<() => void> }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(work: () => PromiseLike<T>) =>
    new Promise<T>((resolve, reject) => {
      controls.sessions.push(() => {
        Promise.resolve().then(work).then(resolve, reject);
      });
    }),
  requireSupabaseClient: () => ({ rpc: controls.rpc }),
  getSupabaseClient: () => ({ rpc: controls.rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const A = '47000000-0000-4000-8000-000000000081';
const B = '47000000-0000-4000-8000-000000000082';
let db: TeamTestDb, team: string, connection: string;
let authenticatedActor = A;
const routes: Record<string, string[]> = {
  patch_team_catalog_update_profile: ['p_team', 'p_catalog', 'p_expected_version', 'p_patch'],
  cancel_team_catalog_update_attempt: [
    'p_team',
    'p_catalog',
    'p_expected_round',
    'p_expected_attempt'
  ],
  set_team_catalog_updater_restitch: ['p_team', 'p_restitch'],
  set_team_catalog_updater_refresh_images: ['p_team', 'p_refresh'],
  set_team_catalog_updater_refresh_texts: ['p_team', 'p_refresh'],
  set_team_catalog_updater_random_link_variation: ['p_team', 'p_enabled'],
  set_team_catalog_updater_grow: ['p_team', 'p_grow']
};
for (const [name, args] of Object.entries({ ...routes }))
  routes[name + '_as_actor'] = [...args, 'p_expected_actor'];
beforeAll(async () => {
  db = await createTeamTestDb();
  for (const id of [A, B]) {
    await createUser(db, { id, email: id + '@actor-bound.invalid' });
    await db.root('insert into public.admin_users(user_id) values($1)', [id]);
  }
  team = (
    await db.asUser<{ id: string }>(A, 'select id from public.create_team($1)', ['Actor binding'])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
    [team, B]
  );
  expect(
    (
      await db.root<{ a: boolean; b: boolean }>(
        "select private.can($1,'process',$2) a,private.can($1,'process',$3) b",
        [team, A, B]
      )
    )[0]
  ).toMatchObject({ a: true, b: true });
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
    (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
    values('actor-fixture','fixture@actor-bound.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id`,
      [A]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections
    (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
    values($1,$2,'root','Root','my_drive','connected',now()) returning id`,
      [team, credential]
    )
  )[0]!.id;
  controls.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const keys = routes[name];
    if (!keys) throw Error('Unexpected test RPC route');
    try {
      const rows = await db.asUser<{ value: unknown }>(
        authenticatedActor,
        `select public.${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) value`,
        keys.map(key => (key === 'p_patch' ? JSON.stringify(args[key]) : args[key]))
      );
      return { data: rows[0]!.value, error: null };
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      return { data: null, error: { code: error.code, message: error.message } };
    }
  });
}, 180_000);
beforeEach(() => {
  authenticatedActor = A;
  controls.sessions.length = 0;
  controls.rpc.mockClear();
});
afterAll(() => db?.close());
const resume = () => {
  const work = controls.sessions.shift();
  if (!work) throw Error('Session boundary not awaited');
  work();
};
async function fixture() {
  const video = crypto.randomUUID(),
    catalog = crypto.randomUUID();
  for (const [id, isVideo] of [
    [video, true],
    [catalog, false]
  ] as const)
    await db.root(
      `insert into public.team_materials
      (id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
      values($1::uuid,$2,$3,$1::uuid::text,'root','Synthetic fixture','file',$4,$5)`,
      [
        id,
        team,
        connection,
        isVideo ? 'video' : 'other',
        isVideo ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
      ]
    );
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4)', [
    team,
    video,
    catalog,
    JSON.stringify({
      sourceLink: 'https://offer.example.invalid/',
      productCount: 3,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${catalog}/edit`,
      videoLink: 'https://drive.google.com/file/d/fixture/view',
      createdBy: A,
      settingsSnapshot: {
        title: 'Fixture',
        description: 'Fixture',
        price: 1,
        imageLink: 'https://image.example.invalid/a.png'
      }
    })
  ]);
  return catalog;
}
const profile = async (catalog: string) =>
  (
    await db.root<{ version: number; refresh_images: boolean }>(
      'select version::int,refresh_images from public.team_catalog_update_profiles where catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
it('allows the intended authorized actor to patch through the actual API and SQL contract', async () => {
  const catalog = await fixture(),
    before = await profile(catalog);
  const pending = teamApi.patchCatalogUpdateProfile(
    team,
    catalog,
    before.version,
    { refreshImages: !before.refresh_images },
    { expectedActorId: A }
  );
  resume();
  expect((await pending).version).toBe(before.version + 1);
});
it('refuses an old profile intent when a different authorized admin owns the refreshed session', async () => {
  const catalog = await fixture(),
    before = await profile(catalog);
  const pending = teamApi.patchCatalogUpdateProfile(
    team,
    catalog,
    before.version,
    { refreshImages: !before.refresh_images },
    { expectedActorId: A }
  );
  expect(controls.rpc).not.toHaveBeenCalled();
  authenticatedActor = B;
  resume();
  await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(await profile(catalog)).toEqual(before);
});
it('does not stop a round under the replacement admin after the session boundary', async () => {
  const catalog = await fixture(),
    command = crypto.randomUUID();
  await db.asUser(A, 'select public.request_team_catalog_update_command($1,$2,$3,$4,null)', [
    team,
    command,
    [catalog],
    A
  ]);
  const round = (
    await db.root<{ round_at: string; attempt_id: string }>(
      `select i.round_due_at::text round_at,a.attempt_id::text
    from public.team_catalog_updater_items i join public.team_catalog_update_attempts a
      on a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at where i.catalog_material_id=$1`,
      [catalog]
    )
  )[0]!;
  const pending = teamApi.cancelCatalogUpdate(
    team,
    catalog,
    { roundAt: new Date(round.round_at).toISOString(), attemptId: round.attempt_id },
    { expectedActorId: A }
  );
  authenticatedActor = B;
  resume();
  await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(
    (
      await db.root<{ active: boolean }>(
        'select round_due_at is not null active from public.team_catalog_updater_items where catalog_material_id=$1',
        [catalog]
      )
    )[0]?.active
  ).toBe(true);
});
for (const [method, column] of [
  ['setCatalogUpdaterRestitch', 'restitch'],
  ['setCatalogUpdaterRefreshImages', 'refresh_images'],
  ['setCatalogUpdaterRefreshTexts', 'refresh_texts'],
  ['setCatalogUpdaterRandomLinkVariation', 'random_link_variation'],
  ['setCatalogUpdaterGrow', 'grow_products']
] as const)
  it(method + ' retains its original actor across session refresh', async () => {
    const before = (
      await db.root<{ value: boolean }>(
        `select ${column} value from public.team_catalog_updaters where team_id=$1`,
        [team]
      )
    )[0]!.value;
    const pending = teamApi[method](team, !before, { expectedActorId: A });
    authenticatedActor = B;
    resume();
    await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(
      (
        await db.root<{ value: boolean }>(
          `select ${column} value from public.team_catalog_updaters where team_id=$1`,
          [team]
        )
      )[0]?.value
    ).toBe(before);
  });
