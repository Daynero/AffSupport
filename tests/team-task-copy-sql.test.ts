import { expect, it } from 'vitest';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';

it('copies a batch atomically with fresh workflow/date and preserved content, assignee, tags and all attachments', async () => {
  const f = await financeFixture();
  try {
    await f.db.root(
      "update public.team_tasks set title='Old task',note='Brief',assignee_id=$2,status='done',completed_at=now(),progress_value=100,progress_manually_set=true,task_date='2020-01-01',created_at='2020-01-01' where id=$1",
      [f.task, FINANCE_VIEWER]
    );
    const label = (
      await f.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select id from public.create_team_label($1,'Tag','blue','task')",
        [f.team]
      )
    )[0]!.id;
    await f.db.asUser(FINANCE_OWNER, 'select public.attach_team_task_label($1,$2,$3)', [
      f.team,
      f.task,
      label
    ]);
    const credential = (
      await f.db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('copy','copy@test.local','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [FINANCE_OWNER]
      )
    )[0]!.id;
    const connection = (
      await f.db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
        [f.team, credential]
      )
    )[0]!.id;
    // More than the hover's first page, so copying cannot depend on its cache.
    await f.db.root(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind) select $1,$2,'file-'||n,'File '||n,'file' from generate_series(1,15) n",
      [f.team, connection]
    );
    await f.db.root(
      'insert into public.team_task_attachments(team_id,task_id,material_id,position,attached_by) select $1,$2,id,row_number() over(order by id)-1,$3 from public.team_materials where team_id=$1',
      [f.team, f.task, FINANCE_OWNER]
    );
    const second = (
      await f.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select id from public.create_team_task($1,'Second')",
        [f.team]
      )
    )[0]!.id;
    const copies = (
      await f.db.asUser<{ ids: string[] }>(
        FINANCE_OWNER,
        'select public.copy_team_tasks($1,$2) as ids',
        [f.team, [f.task, second]]
      )
    )[0]!.ids;
    expect(copies).toHaveLength(2);
    const row = (
      await f.db.root<Record<string, unknown>>(
        'select *,created_at::date=current_date as today from public.team_tasks where id=$1',
        [copies[0]]
      )
    )[0]!;
    expect(row).toMatchObject({
      title: 'Old task',
      note: 'Brief',
      assignee_id: FINANCE_VIEWER,
      status: 'todo',
      progress_value: 0,
      progress_manually_set: false,
      completed_at: null,
      task_date: null,
      today: true
    });
    expect(
      await f.db.root('select * from public.team_task_agents where task_id=any($1)', [copies])
    ).toHaveLength(0);
    expect(
      await f.db.root('select label_id from public.team_task_label_links where task_id=$1', [
        copies[0]
      ])
    ).toEqual([{ label_id: label }]);
    expect(
      await f.db.root(
        'select material_id,position from public.team_task_attachments where task_id=$1 order by position',
        [copies[0]]
      )
    ).toEqual(
      await f.db.root(
        'select material_id,position from public.team_task_attachments where task_id=$1 order by position',
        [f.task]
      )
    );
    const before = await f.db.root('select id from public.team_tasks');
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.copy_team_tasks($1,$2)', [
        f.team,
        [f.task, '00000000-0000-4000-8000-000000000001']
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    expect(await f.db.root('select id from public.team_tasks')).toEqual(before);
    await expect(
      f.db.asUser(FINANCE_VIEWER, 'select public.copy_team_tasks($1,$2)', [f.team, [f.task]])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.copy_team_tasks($1,$2)', [f.otherTeam, [f.task]])
    ).rejects.toThrow(/NOT_FOUND/);
  } finally {
    await f.db.close();
  }
}, 60000);
