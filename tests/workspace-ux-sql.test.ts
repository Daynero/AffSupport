import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let h: TeamTestDb;
const actor = '37000000-0000-4000-8000-000000000001';
let team: string;
beforeAll(async () => {
  h = await createTeamTestDb();
  await createUser(h, {
    id: actor,
    email: 'workspace-ux@example.test',
    displayName: 'Workspace owner'
  });
  await h.root('insert into public.admin_users(user_id) values($1)', [actor]);
  const rows = await h.asUser<{ id: string }>(
    actor,
    "select id from public.create_team('Workspace UX')"
  );
  team = rows[0]!.id;
}, 120000);
afterAll(async () => {
  await h?.close();
});
it('replays one task-copy receipt and rejects key reuse with another payload', async () => {
  const task = (
    await h.asUser<{ id: string }>(actor, "select id from public.create_team_task($1,'Task')", [
      team
    ])
  )[0]!.id;
  const request = '37000000-0000-4000-8000-000000000002';
  const copy = () =>
    h.asUser<{ ids: string[] }>(actor, 'select public.copy_team_tasks_once($1,$2::uuid[],$3) ids', [
      team,
      [task],
      request
    ]);
  const first = await copy();
  expect((await copy())[0]!.ids).toEqual(first[0]!.ids);
  await expect(
    h.asUser(actor, 'select public.copy_team_tasks_once($1,$2::uuid[],$3)', [
      team,
      first[0]!.ids,
      request
    ])
  ).rejects.toThrow('INVALID_INPUT');
  await expect(
    h.asUser(null, 'select public.copy_team_tasks_once($1,$2::uuid[],$3)', [team, [task], request])
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('keeps bulk projection permission checked', async () => {
  expect(
    (
      await h.asUser<{ data: unknown[] }>(actor, 'select public.list_team_bulk_trash($1) data', [
        team
      ])
    )[0]!.data
  ).toEqual([]);
  await expect(h.asUser(null, 'select public.list_team_bulk_trash($1)', [team])).rejects.toThrow(
    'PERMISSION_DENIED'
  );
});
let connection: string;
let counter = 0;
async function file(kind = 'file', parent = 'root'): Promise<string> {
  if (!connection) {
    const credential = (
      await h.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('ux-permission','ux@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [actor]
      )
    )[0]!.id;
    connection = (
      await h.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
        [team, credential]
      )
    )[0]!.id;
  }
  return (
    await h.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values($1,$2,$3,$4,'Fixture',$5,$6) returning id",
      [
        team,
        connection,
        `ux-drive-${++counter}`,
        parent,
        kind,
        kind === 'folder' ? 'application/vnd.google-apps.folder' : 'image/png'
      ]
    )
  )[0]!.id;
}
async function ownedAttachment() {
  const task = (
    await h.asUser<{ id: string }>(
      actor,
      "select id from public.create_team_task($1,'Attachment task')",
      [team]
    )
  )[0]!.id;
  const request = crypto.randomUUID();
  await h.asUser(actor, 'select public.begin_task_upload($1,$2,$3)', [team, task, request]);
  const operation = (
    await h.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,idempotency_key,request_nonce) values($1,$2,'upload',$3,$3) returning id",
      [team, actor, request]
    )
  )[0]!.id;
  const material = await file();
  await h.root("update public.team_operations set state='running' where id=$1", [operation]);
  await h.root(
    "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
    [operation, material]
  );
  await h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
    team,
    task,
    [material]
  ]);
  return { task, material, operation };
}
it('keeps shared and unknown-origin files and atomically undoes detach before its deadline', async () => {
  const { task, material } = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string; state: string; undoUntil: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  expect(receipt.state).toBe('waiting');
  expect(Date.parse(receipt.undoUntil) - Date.now()).toBeGreaterThan(20000);
  await h.asUser(actor, 'select public.undo_task_material_detach($1,$2)', [team, receipt.id]);
  expect(
    (
      await h.root<{ n: number }>(
        'select count(*)::int n from public.team_task_attachments where material_id=$1',
        [material]
      )
    )[0]!.n
  ).toBe(1);
  const foreign = await file();
  await h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
    team,
    task,
    [foreign]
  ]);
  const unknown = (
    await h.asUser<{ r: { state: string; reason: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, foreign]
    )
  )[0]!.r;
  expect(unknown).toMatchObject({ state: 'retained', reason: 'cleanup_unverified' });
});
it('tracks execution reservation references and refuses new ones after cleanup is claimed', async () => {
  const first = await ownedAttachment();
  const detached = await h.asUser<{ r: { id: string } }>(
    actor,
    'select public.detach_task_material_safely($1,$2,$3) r',
    [team, first.task, first.material]
  );
  const operation = (
    await h.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,idempotency_key,request_nonce) values($1,$2,'process',gen_random_uuid()::text,gen_random_uuid()::text) returning id",
      [team, actor]
    )
  )[0]!.id;
  await h.root(
    'insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id) values($1,$2,$3,$4)',
    [operation, team, actor, first.material]
  );
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [detached[0]!.r.id]
  );
  await h.root('select public.service_claim_task_cleanup()');
  expect(
    (
      await h.root<{ reason: string }>(
        'select reason from private.task_attachment_cleanup where id=$1',
        [detached[0]!.r.id]
      )
    )[0]!.reason
  ).toBe('cleanup_referenced');
  const second = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, second.task, second.material]
    )
  )[0]!.r;
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [receipt.id]
  );
  const claims = (
    await h.root<{ r: Array<{ id: string }> }>('select public.service_claim_task_cleanup() r')
  )[0]!.r;
  expect(claims.some(x => x.id === receipt.id)).toBe(true);
  await expect(
    h.root(
      'insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id) values($1,$2,$3,$4)',
      [second.operation, team, actor, second.material]
    )
  ).rejects.toThrow('WRONG_STATE');
  await h.root("select public.service_settle_task_cleanup($1,'trashed')", [receipt.id]);
});
it('claims only a verified orphan, fences new references and recovers unknown provider results', async () => {
  const { task, material } = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  expect(
    (await h.root<{ r: unknown[] }>('select public.service_claim_task_cleanup() r'))[0]!.r
  ).toEqual([]);
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [receipt.id]
  );
  const claim = (
    await h.root<{ r: Array<{ id: string }> }>('select public.service_claim_task_cleanup() r')
  )[0]!.r;
  expect(claim.map(item => item.id)).toContain(receipt.id);
  await expect(
    h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
      team,
      task,
      [material]
    ])
  ).rejects.toThrow('WRONG_STATE');
  await h.root("select public.service_settle_task_cleanup($1,'unknown')", [receipt.id]);
  await h.root(
    "update private.task_attachment_cleanup set lease_until=clock_timestamp()-interval '1 second' where id=$1",
    [receipt.id]
  );
  expect(
    (
      await h.root<{ r: Array<{ id: string }> }>('select public.service_claim_task_cleanup() r')
    )[0]!.r.map(item => item.id)
  ).toContain(receipt.id);
  await h.root("select public.service_settle_task_cleanup($1,'trashed')", [receipt.id]);
  expect(
    (
      await h.root<{ lifecycle: string }>(
        'select lifecycle from public.team_materials where id=$1',
        [material]
      )
    )[0]!.lifecycle
  ).toBe('trashed');
});
it('retains an orphan if another reference arrived during the grace window', async () => {
  const { task, material } = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  await h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
    team,
    task,
    [material]
  ]);
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [receipt.id]
  );
  await h.root('select public.service_claim_task_cleanup()');
  expect(
    (
      await h.root<{ state: string }>(
        'select state from private.task_attachment_cleanup where id=$1',
        [receipt.id]
      )
    )[0]!.state
  ).toBe('retained');
});
it('deduplicates selected folders and children, and derives success only from the server operation', async () => {
  const folder = await file('folder');
  const child = await file('file', `ux-drive-${counter}`);
  const id = crypto.randomUUID();
  const group = (
    await h.asUser<{
      r: { items: Array<{ materialId: string; idempotencyKey: string; state: string }> };
    }>(actor, 'select public.start_team_bulk_trash($1,$2,$3::uuid[]) r', [
      team,
      id,
      [folder, child]
    ])
  )[0]!.r;
  expect(group.items).toHaveLength(1);
  expect(group.items[0]!.materialId).toBe(folder);
  const key = group.items[0]!.idempotencyKey;
  await h.asUser(actor, 'select public.mark_team_bulk_trash_request($1,$2,$3)', [team, id, folder]);
  expect(
    (
      await h.root<{ r: { items: Array<{ state: string }> } }>(
        'select private.bulk_trash_snapshot($1) r',
        [id]
      )
    )[0]!.r.items[0]!.state
  ).toBe('unknown');
  await h.root(
    "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce,source_material_id,finished_at) values($1,$2,'trash','succeeded',$3,$3,$4,now())",
    [team, actor, key, folder]
  );
  expect(
    (
      await h.root<{ r: { items: Array<{ state: string }> } }>(
        'select private.bulk_trash_snapshot($1) r',
        [id]
      )
    )[0]!.r.items[0]!.state
  ).toBe('confirmed');
});
it('explains hosted results through the actual read-only CLI projection without content', async () => {
  const { setQueryExecutor } = await import('../scripts/analytics/db');
  const { getWorkspaceEvidence } = await import('../scripts/analytics/workspace');
  setQueryExecutor((sql, params) => h.root(sql, params));
  try {
    const evidence = await getWorkspaceEvidence(
      actor,
      null,
      new Date(Date.now() + 60000).toISOString()
    );
    expect(evidence.supported).toBe(true);
    expect(
      evidence.operations.some(op => op.action === 'task_copy' && op.state === 'confirmed')
    ).toBe(true);
    expect(
      evidence.operations.some(op => op.action === 'task_cleanup' && op.state === 'trashed')
    ).toBe(true);
    expect(evidence.blind_spots.some(spot => spot.includes('browser delivery'))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('Fixture');
    expect(JSON.stringify(evidence)).not.toContain('ux-drive');
    await h.root('set role authenticated');
    await expect(h.root('select * from public.analytics_workspace_operations')).rejects.toThrow(
      'permission denied'
    );
  } finally {
    await h.root('reset role');
    setQueryExecutor(null);
  }
});
it('starts a new detach after reattachment and refuses Undo if the original file has become unavailable', async () => {
  const { task, material } = await ownedAttachment();
  const detach = async () =>
    (
      await h.asUser<{ r: { id: string } }>(
        actor,
        'select public.detach_task_material_safely($1,$2,$3) r',
        [team, task, material]
      )
    )[0]!.r;
  const first = await detach();
  await h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
    team,
    task,
    [material]
  ]);
  const second = await detach();
  expect(second.id).not.toBe(first.id);
  expect(
    (
      await h.root<{ n: number }>(
        'select count(*)::int n from public.team_task_attachments where material_id=$1',
        [material]
      )
    )[0]!.n
  ).toBe(0);
  await h.root(
    "update public.team_materials set lifecycle='missing',missing_at=now() where id=$1",
    [material]
  );
  await expect(
    h.asUser(actor, 'select public.undo_task_material_detach($1,$2)', [team, second.id])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await h.root<{ state: string }>(
        'select state from private.task_attachment_cleanup where id=$1',
        [second.id]
      )
    )[0]!.state
  ).toBe('waiting');
});
it('accepts bounded image-selection telemetry while refusing private content and mistyped flags', async () => {
  const safe = (value: unknown) =>
    h.root<{ ok: boolean }>('select public.analytics_properties_are_safe_v2($1::jsonb) ok', [
      JSON.stringify(value)
    ]);
  expect((await safe({ explicit_start_image: true, explicit_end_image: false }))[0]!.ok).toBe(true);
  expect((await safe({ explicit_start_image: 'private-image.png' }))[0]!.ok).toBe(false);
  expect((await safe({ explicit_start_image: true, path: '/private/file.png' }))[0]!.ok).toBe(
    false
  );
});
it('denies a reader mutation and exposes no diagnostic view to that role', async () => {
  const viewer = '37000000-0000-4000-8000-000000000077';
  await createUser(h, { id: viewer, email: 'viewer-037@example.test', displayName: 'Viewer' });
  await h.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, viewer]
  );
  await expect(
    h.asUser(viewer, 'select public.start_team_bulk_trash($1,$2,$3::uuid[])', [
      team,
      crypto.randomUUID(),
      [await file()]
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('does not manufacture ownership for an existing file by accepting a later browser intent', async () => {
  const material = await file();
  const task = (
    await h.asUser<{ id: string }>(
      actor,
      "select id from public.create_team_task($1,'Existing file')",
      [team]
    )
  )[0]!.id;
  const key = crypto.randomUUID();
  await h.asUser(actor, 'select public.begin_task_upload($1,$2,$3)', [team, task, key]);
  const op = (
    await h.root<{ id: string }>(
      "insert into public.team_operations(team_id,actor_id,kind,state,idempotency_key,request_nonce) values($1,$2,'upload','running',$3,$3) returning id",
      [team, actor, key]
    )
  )[0]!.id;
  await h.root(
    "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
    [op, material]
  );
  expect(
    (
      await h.root<{ n: number }>(
        'select count(*)::int n from private.task_owned_uploads where material_id=$1',
        [material]
      )
    )[0]!.n
  ).toBe(0);
});
it('retains work with unknown coverage when a new reference table has no registered fence', async () => {
  const { task, material } = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  await h.root(
    'create table public.future_material_consumer(id uuid primary key, material_id uuid references public.team_materials(id))'
  );
  try {
    await h.root(
      "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
      [receipt.id]
    );
    await h.root('select public.service_claim_task_cleanup()');
    expect(
      (
        await h.root<{ reason: string }>(
          'select reason from private.task_attachment_cleanup where id=$1',
          [receipt.id]
        )
      )[0]!.reason
    ).toBe('cleanup_unverified');
  } finally {
    await h.root('drop table public.future_material_consumer');
  }
});
it('fences new process operations and live download grants during a claimed cleanup', async () => {
  const { task, material } = await ownedAttachment();
  const receipt = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [receipt.id]
  );
  await h.root('select public.service_claim_task_cleanup()');
  await expect(
    h.root(
      "insert into public.team_operations(team_id,actor_id,kind,source_material_id,idempotency_key,request_nonce) values($1,$2,'process',$3,'blocked-operation','blocked-operation')",
      [team, actor, material]
    )
  ).rejects.toThrow('WRONG_STATE');
  await expect(
    h.root(
      "insert into private.team_transfer_grants(token_hash,team_id,actor_id,purpose,material_id,max_range_bytes,expires_at) values(decode(repeat('ab',32),'hex'),$1,$2,'preview_range',$3,1024,clock_timestamp()+interval '1 minute')",
      [team, actor, material]
    )
  ).rejects.toThrow('WRONG_STATE');
  await h.root("select public.service_settle_task_cleanup($1,'trashed')", [receipt.id]);
});
it('restores the original link when a second task detach supersedes its waiting cleanup', async () => {
  const { task, material } = await ownedAttachment();
  const other = (
    await h.asUser<{ id: string }>(
      actor,
      "select id from public.create_team_task($1,'Other task')",
      [team]
    )
  )[0]!.id;
  await h.asUser(actor, 'select public.attach_team_task_materials($1,$2,$3::uuid[])', [
    team,
    other,
    [material]
  ]);
  const first = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, task, material]
    )
  )[0]!.r;
  const second = (
    await h.asUser<{ r: { id: string } }>(
      actor,
      'select public.detach_task_material_safely($1,$2,$3) r',
      [team, other, material]
    )
  )[0]!.r;
  await h.asUser(actor, 'select public.undo_task_material_detach($1,$2)', [team, first.id]);
  await h.asUser(actor, 'select public.undo_task_material_detach($1,$2)', [team, first.id]);
  expect(
    (
      await h.root<{ n: number }>(
        'select count(*)::int n from public.team_task_attachments where task_id=$1 and material_id=$2',
        [task, material]
      )
    )[0]!.n
  ).toBe(1);
  await h.root(
    "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
    [second.id]
  );
  await h.root('select public.service_claim_task_cleanup()');
  expect(
    (
      await h.root<{ state: string }>(
        'select state from private.task_attachment_cleanup where id=$1',
        [second.id]
      )
    )[0]!.state
  ).toBe('retained');
});

it('tracks offer-profile references and fences future material columns after cleanup is claimed', async () => {
  const offer = (
    await h.asUser<{ result: { id: string } }>(
      actor,
      "select public.create_launch_dictionary($1,'offers','Cleanup profile',$2) as result",
      [team, crypto.randomUUID()]
    )
  )[0].result.id;
  await h.asUser(
    actor,
    `select public.set_launch_offer_defaults($1,$2,null,$3,'{}'::jsonb,
      '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}'::jsonb)`,
    [team, offer, crypto.randomUUID()]
  );
  await h.root(
    'alter table public.team_launch_offer_defaults add column future_material_id uuid references public.team_materials(id)'
  );
  try {
    const first = await ownedAttachment();
    const detach = async (value: Awaited<ReturnType<typeof ownedAttachment>>) => {
      const receipt = (
        await h.asUser<{ r: { id: string } }>(
          actor,
          'select public.detach_task_material_safely($1,$2,$3) r',
          [team, value.task, value.material]
        )
      )[0].r;
      await h.root(
        "update private.task_attachment_cleanup set not_before=clock_timestamp()-interval '1 minute' where id=$1",
        [receipt.id]
      );
      return receipt;
    };
    const firstReceipt = await detach(first);
    await h.root(
      'update public.team_launch_offer_defaults set future_material_id=$1 where team_id=$2 and offer_id=$3',
      [first.material, team, offer]
    );
    await h.root('select public.service_claim_task_cleanup()');
    expect(
      (
        await h.root<{ reason: string }>(
          'select reason from private.task_attachment_cleanup where id=$1',
          [firstReceipt.id]
        )
      )[0].reason
    ).toBe('cleanup_referenced');
    const second = await ownedAttachment();
    const secondReceipt = await detach(second);
    const claims = (
      await h.root<{ r: Array<{ id: string }> }>('select public.service_claim_task_cleanup() r')
    )[0].r;
    expect(claims.some(row => row.id === secondReceipt.id)).toBe(true);
    await expect(
      h.root(
        'update public.team_launch_offer_defaults set future_material_id=$1 where team_id=$2 and offer_id=$3',
        [second.material, team, offer]
      )
    ).rejects.toThrow('WRONG_STATE');
    await h.root("select public.service_settle_task_cleanup($1,'trashed')", [secondReceipt.id]);

    const unverifiedReceipt = await detach(await ownedAttachment());
    await h.root(
      'alter table public.team_launch_offer_defaults disable trigger task_cleanup_reference_fence'
    );
    try {
      await h.root('select public.service_claim_task_cleanup()');
    } finally {
      await h.root(
        'alter table public.team_launch_offer_defaults enable trigger task_cleanup_reference_fence'
      );
    }
    const { setQueryExecutor } = await import('../scripts/analytics/db');
    const { getWorkspaceEvidence } = await import('../scripts/analytics/workspace');
    const { lookupCodeLocations } = await import('../scripts/analytics/code-map');
    setQueryExecutor((sql, params) => h.root(sql, params));
    try {
      await h.root('set default_transaction_read_only=on');
      const evidence = await getWorkspaceEvidence(
        actor,
        null,
        new Date(Date.now() + 60000).toISOString()
      );
      for (const [id, code] of [
        [firstReceipt.id, 'cleanup_referenced'],
        [unverifiedReceipt.id, 'cleanup_unverified']
      ]) {
        expect(evidence.operations.find(operation => operation.id === id)).toMatchObject({
          action: 'task_cleanup',
          state: 'retained',
          code,
          confirmed_count: 0
        });
      }
      expect(lookupCodeLocations('workspace:receipt')?.files).toContain(
        'supabase/migrations/20261206140500_launch_offer_defaults_reference_fence.sql'
      );
      expect(JSON.stringify(evidence)).not.toContain('Cleanup profile');
      expect(JSON.stringify(evidence)).not.toContain('ux-drive');
      expect(evidence.blind_spots.some(spot => spot.includes('browser delivery'))).toBe(true);
    } finally {
      await h.root('set default_transaction_read_only=off');
      setQueryExecutor(null);
    }
  } finally {
    await h.root('alter table public.team_launch_offer_defaults drop column future_material_id');
  }
});

it('forces RLS on every private workspace intent and provenance table', async () => {
  const tables = [
    'team_task_copy_receipts',
    'team_bulk_trash_groups',
    'team_bulk_trash_items',
    'task_upload_intents',
    'task_owned_uploads',
    'task_attachment_cleanup'
  ];
  const rows = await h.root<{ name: string; enabled: boolean; forced: boolean }>(
    `select relname as name, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where relnamespace='private'::regnamespace and relname=any($1::text[])`,
    [tables]
  );
  expect(rows).toHaveLength(tables.length);
  for (const row of rows) expect(row, row.name).toMatchObject({ enabled: true, forced: true });
});
