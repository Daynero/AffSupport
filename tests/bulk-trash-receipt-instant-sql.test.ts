import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseBulkTrashGroups } from '../packages/shared/src/team/bulk-trash';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: the historical receipt rendered its instant with `+00:00`, the client
 * refused it, and the bulk-trash list it rides in became unreadable. The
 * receipt now spells UTC with `Z` whatever the session time zone is.
 */
let h: TeamTestDb, team: string, connection: string;
const owner = '37000000-0000-4000-8000-000000000711';
beforeAll(async () => {
  h = await createTeamTestDb();
  await createUser(h, { id: owner, email: 'receipt-instant@example.test' });
  await h.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await h.asUser<{ id: string }>(owner, "select id from public.create_team('Instant')"))[0]!
    .id;
  const credential = (
    await h.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('instant','instant@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await h.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
}, 120000);
afterAll(async () => {
  await h?.close();
});

it('spells the observed instant in UTC with Z, and the list it rides in parses', async () => {
  const material = (
    await h.root<{ id: string; drive_file_id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,lifecycle,trashed_at) values($1,$2,'instant-file','root','Fixture','file','image/png','trashed',now()) returning id,drive_file_id",
      [team, connection]
    )
  )[0]!;
  const group = crypto.randomUUID();
  const key = `${group}:${material.id}`;
  await h.root(
    'insert into private.team_bulk_trash_groups(id,team_id,actor_id,source_ids,created_at) values($1,$2,$3,array[$4::uuid],now())',
    [group, team, owner, material.id]
  );
  await h.root(
    'insert into private.team_bulk_trash_items(group_id,material_id,idempotency_key,requested_at) values($1,$2,$3,now())',
    [group, material.id, key]
  );
  const operation = (
    await h.root<{ id: string }>(
      `insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,source_material_id,finished_at)
       values(gen_random_uuid(),$1,$2,'trash','succeeded',$3,$3,$4,now()) returning id`,
      [team, owner, key, material.id]
    )
  )[0]!.id;
  // A snapshot that no longer matches: its receipt is carried in the list.
  await h.root(
    `insert into private.team_material_group_intents(team_id,source_material_id,operation_id,action,member_snapshot,applied_member_ids,state,execution_protocol,execution_closed)
     values($1,$2::uuid,$3,'trash',jsonb_build_array(jsonb_build_object('material_id',$2::text,'drive_file_id',$4::text,'parent_folder_id','elsewhere')),array[$2::uuid],'succeeded',2,true)`,
    [team, material.id, operation, material.drive_file_id]
  );
  // Insert-time triggers reset the execution fields; a closed protocol-1 run is set after.
  await h.root(
    'update private.team_material_group_intents set execution_protocol=1,execution_closed=true where operation_id=$1',
    [operation]
  );
  // The session zone must not leak into the receipt.
  await h.root("set time zone 'Europe/Kyiv'");
  const receipt = (
    await h.root<{ r: { historicalReceipt: { observedAt: string; state: string } } }>(
      "select private.material_historical_receipt($1,$2,$3,$4,'trash',null) r",
      [team, owner, operation, material.id]
    )
  )[0]!.r;
  // Either state rides in the list; the fixture's placement makes it `unknown`.
  expect(['changed', 'unknown']).toContain(receipt.historicalReceipt.state);
  expect(receipt.historicalReceipt.observedAt).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u
  );
  const listed = (
    await h.asUser<{ data: unknown }>(owner, 'select public.list_team_bulk_trash($1) data', [team])
  )[0]!.data;
  const parsed = parseBulkTrashGroups(listed);
  expect(parsed?.rejected).toEqual([]);
  expect(
    parsed?.groups.find(entry => entry.id === group)?.items[0]?.historicalReceipt?.observedAt
  ).toMatch(/Z$/u);
});
