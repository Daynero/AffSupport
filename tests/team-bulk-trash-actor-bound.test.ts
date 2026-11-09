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
  start_team_bulk_trash: ['p_team', 'p_group', 'p_materials']
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
async function material() {
  const id = crypto.randomUUID();
  await db.root(
    `insert into public.team_materials
    (id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
    values($1::uuid,$2,$3,$1::uuid::text,'root','Synthetic catalog','file','other','text/csv')`,
    [id, team, connection]
  );
  return id;
}
const resume = () => {
  const work = controls.sessions.shift();
  if (!work) throw Error('Session boundary not awaited');
  work();
};
it('starts the same authorized actor group through the actual SDK and SQL', async () => {
  const id = crypto.randomUUID(),
    source = await material();
  const pending = teamApi.startBulkTrash(team, id, [source], { expectedActorId: A });
  resume();
  expect(await pending).toMatchObject({ id, teamId: team, actorId: A });
});
it('does not create a new group as a replacement admin after session refresh', async () => {
  const id = crypto.randomUUID(),
    source = await material();
  const pending = teamApi.startBulkTrash(team, id, [source], { expectedActorId: A });
  expect(controls.rpc).not.toHaveBeenCalled();
  authenticatedActor = B;
  resume();
  await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(
    (
      await db.root<{ count: number }>(
        'select count(*)::int count from private.team_bulk_trash_groups where id=$1',
        [id]
      )
    )[0]?.count
  ).toBe(0);
});

it('accepts the server collapse of a selected folder and its selected child', async () => {
  const folder = crypto.randomUUID(),
    child = crypto.randomUUID();
  await db.root(
    `insert into public.team_materials
    (id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type)
    values($1::uuid,$2,$3,$1::uuid::text,'root','Synthetic folder','folder','application/vnd.google-apps.folder'),
      ($4::uuid,$2,$3,$4::uuid::text,$1::uuid::text,'Synthetic child','file','text/csv')`,
    [folder, team, connection, child]
  );
  const pending = teamApi.startBulkTrash(team, crypto.randomUUID(), [folder, child], {
    expectedActorId: A
  });
  resume();
  expect((await pending).items.map(item => item.materialId)).toEqual([folder]);
});
