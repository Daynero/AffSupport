// @vitest-environment jsdom
import { getInspect } from '../scripts/analytics/queries';
import { getCatalogCommandEvidence } from '../scripts/analytics/catalog-commands';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { analytics, ProductAnalytics } from '../apps/web/src/analytics/service';
import { beginCatalogUiFlow } from '../apps/web/src/team/catalog-updater/analytics';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TeamApiError } from '../apps/web/src/api/team';
import { useCatalogCommands } from '../apps/web/src/team/catalog-updater/useCatalogCommands';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import type { CatalogCommandReceipt } from '@video-compressor/shared';
const OWNER = '47000000-0000-4000-8000-000000000071';
const VIEWER = '47000000-0000-4000-8000-000000000072';
let db: TeamTestDb;
let team: string;
let connection: string;
let seq = 0;
let chain: Promise<unknown> = Promise.resolve();
beforeAll(async () => {
  db = await createTeamTestDb();
  await db.root('create role command_diagnostics_reader bypassrls');
  await db.root('grant wishly_analytics_ro to command_diagnostics_reader');
  await db.root('grant usage on schema public to command_diagnostics_reader');
  await db.root('grant select on all tables in schema public to command_diagnostics_reader');
  setQueryExecutor((sql, params) => {
    assertReadOnlySql(sql);
    const read = chain.then(async () => {
      await db.db.exec('begin read only; set local role command_diagnostics_reader');
      try {
        const result = await db.db.query(sql, params);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (error) {
        await db.db.exec('rollback');
        throw error;
      }
    });
    chain = read.catch(() => {});
    return read;
  });
  await createUser(db, { id: OWNER, email: 'command-owner@example.invalid' });
  await createUser(db, { id: VIEWER, email: 'command-viewer@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', ['Commands'])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, VIEWER]
  );
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
    (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
    values('command-permission','command-owner@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1)
    returning id`,
      [OWNER]
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
}, 180_000);
afterAll(async () => {
  setQueryExecutor(null);
  await db?.close();
});
async function catalog() {
  const n = ++seq;
  const material = async (video: boolean) =>
    (
      await db.root<{ id: string }>(
        `insert into public.team_materials
    (team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
    values($1,$2,$3,'root',$4,'file',$5,$6) returning id`,
        [
          team,
          connection,
          `${video ? 'video' : 'sheet'}-${n}`,
          `${video ? 'Video' : 'Catalog'} ${n}`,
          video ? 'video' : 'other',
          video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
        ]
      )
    )[0]!.id;
  const video = await material(true);
  const sheet = await material(false);
  await db.root('select public.service_link_product_catalog_companion($1,$2,$3,null,$4)', [
    team,
    video,
    sheet,
    JSON.stringify({
      sourceLink: 'https://offer.example.invalid/',
      productCount: 3,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
      videoLink: 'https://drive.google.com/file/d/fixture/view',
      settingsSnapshot: {
        title: 'Fixture',
        description: 'Fixture',
        price: 1,
        imageLink: 'https://images.example.invalid/a.png'
      },
      createdBy: OWNER
    })
  ]);
  return sheet;
}
const request = async (command: string, ids: string[], source: string | null = null) =>
  (
    await db.asUser<{ receipt: CatalogCommandReceipt }>(
      OWNER,
      'select public.request_team_catalog_update_command($1,$2,$3,$4,$5) receipt',
      [team, command, ids, OWNER, source]
    )
  )[0]!.receipt;
const cancel = async (command: string, ids: string[]) =>
  (
    await db.asUser<{ receipt: CatalogCommandReceipt }>(
      OWNER,
      'select public.cancel_team_catalog_command_intent($1,$2,$3,$4) receipt',
      [team, command, ids, OWNER]
    )
  )[0]!.receipt;
const attemptCount = async (sheet: string) =>
  Number(
    (
      await db.root<{ n: number }>(
        'select count(*) n from public.team_catalog_update_attempts where catalog_material_id=$1',
        [sheet]
      )
    )[0]!.n
  );

it('commits the command and its exact attempt ID together, without claiming provider delivery', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const receipt = await request(command, [sheet]);
  expect(receipt).toMatchObject({
    commandId: command,
    status: 'accepted',
    requestedCount: 1,
    acceptedCount: 1,
    items: [{ catalogId: sheet, accepted: true, reason: 'accepted' }]
  });
  const attempt = (
    await db.root<{ attempt_id: string; delivery_verified_at: string | null }>(
      'select attempt_id,delivery_verified_at from public.team_catalog_update_attempts where catalog_material_id=$1',
      [sheet]
    )
  )[0]!;
  expect(receipt.items[0]!.attemptId).toBe(attempt.attempt_id);
  expect(attempt.delivery_verified_at).toBeNull();
});
it('replays a lost reply even after the accepted round finishes, instead of opening another run', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const first = await request(command, [sheet]);
  await db.root(
    'update public.team_catalog_updater_items set round_due_at=null where catalog_material_id=$1',
    [sheet]
  );
  expect(await request(command, [sheet])).toEqual(first);
  expect(await attemptCount(sheet)).toBe(1);
});
it('rejects changed payload under a retained command key', async () => {
  const a = await catalog();
  const b = await catalog();
  const command = crypto.randomUUID();
  const first = await request(command, [a]);
  await expect(request(command, [b])).rejects.toThrow(/INVALID_INPUT/);
  expect(await request(command, [a])).toEqual(first);
  expect(await attemptCount(b)).toBe(0);
});
it('records an honest partial batch when another catalog is already pending', async () => {
  const a = await catalog();
  const b = await catalog();
  const prior = await request(crypto.randomUUID(), [a]);
  const receipt = await request(crypto.randomUUID(), [a, b]);
  expect(receipt).toMatchObject({ requestedCount: 2, acceptedCount: 1 });
  expect(receipt.items.find(item => item.catalogId === a)).toMatchObject({
    accepted: false,
    reason: 'already_pending',
    attemptId: prior.items[0]!.attemptId
  });
  expect(receipt.items.find(item => item.catalogId === b)).toMatchObject({
    accepted: true,
    reason: 'accepted'
  });
});
it('seals cancellation before acceptance so a late original request cannot create an attempt', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const sealed = await cancel(command, [sheet]);
  expect(sealed).toMatchObject({
    status: 'cancelled',
    acceptedCount: 0,
    items: [{ reason: 'cancelled_before_acceptance' }]
  });
  expect(await request(command, [sheet])).toEqual(sealed);
  expect(await attemptCount(sheet)).toBe(0);
});
it('returns already accepted work when cancellation arrives later, without promising to stop that update', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const accepted = await request(command, [sheet]);
  expect(await cancel(command, [sheet])).toEqual(accepted);
  expect(await attemptCount(sheet)).toBe(1);
});
it('keeps a missing receipt unknown, and does not expose another actor command to a viewer', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  await request(command, [sheet]);
  const read = async (actor: string, id: string) =>
    (
      await db.asUser<{ receipt: unknown }>(
        actor,
        'select public.get_team_catalog_update_command($1,$2) receipt',
        [team, id]
      )
    )[0]!.receipt;
  expect(await read(OWNER, crypto.randomUUID())).toBeNull();
  expect(await read(VIEWER, command)).toBeNull();
  await expect(
    db.asUser(VIEWER, 'select public.request_team_catalog_update_command($1,$2,$3,$4)', [
      team,
      crypto.randomUUID(),
      [sheet],
      VIEWER
    ])
  ).rejects.toThrow(/PERMISSION_DENIED/);
});
it('normalizes duplicate IDs and binds Retry to its exact source failure', async () => {
  const sheet = await catalog();
  const first = await request(crypto.randomUUID(), [sheet, sheet]);
  expect(first.requestedCount).toBe(1);
  const source = first.items[0]!.attemptId!;
  await db.root(
    "update public.team_catalog_update_attempts set result='failed',ended_at=now(),failure_code='DRIVE_UNAVAILABLE' where attempt_id=$1",
    [source]
  );
  await db.root(
    'update public.team_catalog_updater_items set round_due_at=null where catalog_material_id=$1',
    [sheet]
  );
  const retried = await request(crypto.randomUUID(), [sheet], source);
  expect(retried).toMatchObject({ kind: 'retry', sourceAttemptId: source, acceptedCount: 1 });
  expect(retried.items[0]!.attemptId).not.toBe(source);
  const rows = await db.root<{ source_attempt_id: string }>(
    'select source_attempt_id from public.team_catalog_update_attempts where attempt_id=$1',
    [retried.items[0]!.attemptId]
  );
  expect(rows[0]!.source_attempt_id).toBe(source);
});

it('rejects a replacement authenticated actor before accepting an older UI intent', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  await expect(
    db.asUser(OWNER, 'select public.request_team_catalog_update_command($1,$2,$3,$4)', [
      team,
      command,
      [sheet],
      VIEWER
    ])
  ).rejects.toThrow(/PERMISSION_DENIED/);
  expect(await attemptCount(sheet)).toBe(0);
});

it('diagnoses immutable acceptance without missing UI signals becoming provider success', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const receipt = await request(command, [sheet]);
  const result = await getInspect(command);
  expect(result.found).toBe(true);
  expect(result.catalog_commands?.items).toMatchObject([
    { command_id: command, attempt_id: receipt.items[0]!.attemptId, accepted: true }
  ]);
  if (!result.found) throw new Error('Missing authoritative receipt');
  expect(result.terminal).toBeNull();
  expect(result.stages.missing).toContain('terminal');
  const reverse = await getCatalogCommandEvidence(receipt.items[0]!.attemptId!);
  expect(reverse.items[0]?.command_id).toBe(command);
  expect((await getCatalogCommandEvidence(command, '2000-01-01T00:00:00Z')).items).toEqual([]);
});
it('carries the real UI producer through sanitizer, SQL ingestion, and SELECT-only command diagnosis', async () => {
  const sheet = await catalog();
  const command = crypto.randomUUID();
  const ingestions: Array<{ accepted: boolean }> = [];
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean; reason: string }>(
      OWNER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    ingestions.push(...rows);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(OWNER);
  const flow = beginCatalogUiFlow('run', { parentFlowId: command, count: 1 }, service);
  flow.stage('command_requested');
  const receipt = await request(command, [sheet]);
  flow.stage('command_accepted');
  await service.flush();
  expect(ingestions.every(row => row.accepted)).toBe(true);
  expect(ingestions).toHaveLength(3);
  const accepted = await getInspect(command);
  expect(accepted.found).toBe(true);
  if (!accepted.found) throw new Error('Missing command UI flow');
  expect(accepted.capability).toBe('team.catalog_manager_run');
  expect(accepted.terminal).toBeNull();
  expect(accepted.catalog_commands?.items[0]?.attempt_id).toBe(receipt.items[0]!.attemptId);
  expect(accepted.events.every(event => event.properties.production_completed === false)).toBe(
    true
  );
  flow.complete();
  await service.flush();
  const visible = await getInspect(flow.id);
  expect(visible.found && visible.terminal?.event).toBe('operation_completed');
  expect(visible.catalog_commands?.items[0]?.command_id).toBe(command);
  expect((await getCatalogCommandEvidence(receipt.items[0]!.attemptId!)).items[0]?.command_id).toBe(
    command
  );
  expect(JSON.stringify(visible.catalog_commands)).not.toMatch(/example.invalid|root|Fixture/);
});

it('retains reference coverage and rolls back acceptance when cleanup already holds the catalog', async () => {
  const sheet = await catalog(),
    command = crypto.randomUUID(),
    task = crypto.randomUUID(),
    upload = crypto.randomUUID();
  await db.root(
    `insert into public.team_tasks(id,team_id,created_by,title) values($1,$2,$3,'Synthetic task')`,
    [task, team, OWNER]
  );
  await db.root(
    `insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,finished_at)
    values($1::uuid,$2,$3,'upload','succeeded',$1::text,$1::text,now())`,
    [upload, team, OWNER]
  );
  await db.root(
    `insert into private.task_owned_uploads(material_id,team_id,task_id,actor_id,upload_operation_id,parent_folder_id,drive_file_id)
    select id,team_id,$2,$3,$4,'root',drive_file_id from public.team_materials where id=$1`,
    [sheet, task, OWNER, upload]
  );
  await db.root(
    `insert into private.task_attachment_cleanup(team_id,task_id,material_id,actor_id,state)
    values($1,$2,$3,$4,'claimed')`,
    [team, task, sheet, OWNER]
  );
  expect(
    (
      await db.root<{ verified: boolean }>(
        'select private.task_cleanup_coverage_verified() verified'
      )
    )[0]?.verified
  ).toBe(true);
  await expect(request(command, [sheet])).rejects.toThrow(/WRONG_STATE/);
  expect(await attemptCount(sheet)).toBe(0);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_catalog_update_commands where id=$1',
        [command]
      )
    )[0]?.n
  ).toBe(0);
});

it('diagnoses a real pre-dispatch browser storage refusal without inventing a server attempt', async () => {
  const ingestions: Array<{ accepted: boolean }> = [];
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean }>(
      OWNER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    ingestions.push(...rows);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  vi.spyOn(analytics, 'journalContext').mockImplementation(service.journalContext.bind(service));
  setPrivateCacheScope(OWNER, 'owner');
  const key = `soty.catalog-command.v1:${OWNER}:${team}:${crypto.randomUUID()}`;
  localStorage.setItem(key, '{broken');
  const client = {
    requestCatalogUpdateCommand: vi.fn(),
    getCatalogUpdateCommand: vi.fn(),
    cancelCatalogCommandIntent: vi.fn()
  };
  const hook = renderHook(() =>
    useCatalogCommands({
      teamId: team,
      client,
      reloadFresh: async () => true,
      onConfirmed: vi.fn()
    })
  );
  try {
    await act(async () => {
      expect(await hook.result.current.submit([crypto.randomUUID()])).toMatchObject({
        kind: 'rejected',
        error: { code: 'CATALOG_COMMAND_STORAGE_UNAVAILABLE' }
      });
    });
    expect(client.requestCatalogUpdateCommand).not.toHaveBeenCalled();
    const started = track.mock.calls.find(([event]) => event === 'operation_started')?.[1];
    const command = started && 'flow_id' in started ? started.flow_id : undefined;
    expect(typeof command).toBe('string');
    await service.flush();
    expect(ingestions.length).toBeGreaterThanOrEqual(2);
    expect(ingestions.every(row => row.accepted)).toBe(true);
    const diagnosis = await getInspect(command as string);
    expect(diagnosis.found).toBe(true);
    if (!diagnosis.found) throw new Error('Missing failed UI attempt');
    expect(diagnosis.terminal?.event).toBe('operation_failed');
    expect(
      diagnosis.events.find(event => event.event_name === 'operation_failed')?.properties
    ).toMatchObject({
      error_code: 'CATALOG_COMMAND_STORAGE_UNAVAILABLE',
      action_identifier: 'command_requested',
      error_fingerprint: 'team:library:CATALOG_COMMAND_STORAGE_UNAVAILABLE',
      production_completed: false
    });
    expect(diagnosis.catalog_commands?.items ?? []).toEqual([]);
    expect(
      lookupCodeLocations('team:library:CATALOG_COMMAND_STORAGE_UNAVAILABLE')?.files
    ).toContain('apps/web/src/team/catalog-updater/catalogCommandJournal.ts');
  } finally {
    hook.unmount();
    localStorage.removeItem(key);
    vi.restoreAllMocks();
  }
});

it('diagnoses an uncertain offline command through the actual hook, ingestion and read-only CLI', async () => {
  const ingestions: Array<{ accepted: boolean }> = [];
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean }>(
      OWNER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    ingestions.push(...rows);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  vi.spyOn(analytics, 'journalContext').mockImplementation(service.journalContext.bind(service));
  setPrivateCacheScope(OWNER, 'owner');
  const client = {
    requestCatalogUpdateCommand: vi
      .fn()
      .mockRejectedValue(new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true)),
    getCatalogUpdateCommand: vi.fn().mockResolvedValue(null),
    cancelCatalogCommandIntent: vi.fn()
  };
  const sheet = await catalog();
  const hook = renderHook(() =>
    useCatalogCommands({
      teamId: team,
      client,
      reloadFresh: async () => true,
      onConfirmed: vi.fn()
    })
  );
  let command: string | undefined;
  try {
    await act(async () => {
      expect(await hook.result.current.submit([sheet])).toMatchObject({
        kind: 'unknown',
        error: { code: 'TEAM_TRANSPORT_UNAVAILABLE' }
      });
    });
    const started = track.mock.calls.find(([event]) => event === 'operation_started')?.[1];
    command = started && 'flow_id' in started ? String(started.flow_id) : undefined;
    expect(command).toBeTruthy();
    await service.flush();
    expect(ingestions.length).toBeGreaterThanOrEqual(3);
    expect(ingestions.every(row => row.accepted)).toBe(true);
    const diagnosis = await getInspect(command!);
    expect(diagnosis.found).toBe(true);
    if (!diagnosis.found) throw new Error('Missing offline command evidence');
    expect(diagnosis.terminal?.event).toBe('operation_failed');
    expect(
      diagnosis.events.find(event => event.event_name === 'operation_failed')?.properties
    ).toMatchObject({
      error_code: 'TEAM_TRANSPORT_UNAVAILABLE',
      error_fingerprint: 'team:library:TEAM_TRANSPORT_UNAVAILABLE',
      production_completed: false
    });
    expect(diagnosis.catalog_commands?.items ?? []).toEqual([]);
    expect(await attemptCount(sheet)).toBe(0);
    expect(client.requestCatalogUpdateCommand).toHaveBeenCalledTimes(1);
    expect(lookupCodeLocations('team:library:TEAM_TRANSPORT_UNAVAILABLE')?.files).toContain(
      'apps/web/src/api/team.ts'
    );
  } finally {
    hook.unmount();
    if (command) localStorage.removeItem(`soty.catalog-command.v1:${OWNER}:${team}:${command}`);
    vi.restoreAllMocks();
  }
});
