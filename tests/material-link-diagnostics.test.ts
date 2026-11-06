// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { useMaterialLink } from '../apps/web/src/team/materials/useMaterialLink';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
vi.mock('../apps/web/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../apps/web/src/components/toast', () => ({ useToasts: () => ({ push: vi.fn() }) }));
import { analytics, ProductAnalytics } from '../apps/web/src/analytics/service';
import { beginMaterialLinkFlow } from '../apps/web/src/team/materials/link-analytics';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getInspect, getAudit } from '../scripts/analytics/queries';
import { getInvestigation } from '../scripts/analytics/investigate';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
import {
  getMaterialSharingEvidence,
  getOwnedMaterialSharingEvidence,
  inspectMaterialSharing
} from '../scripts/analytics/material-sharing';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '47000000-0000-4000-8000-000000000071';
let db: TeamTestDb;
let chain: Promise<unknown> = Promise.resolve();
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'link-diagnostics@example.invalid' });
  await db.root('create role material_link_reader bypassrls');
  await db.root('grant usage on schema public to material_link_reader');
  await db.root('grant select on all tables in schema public to material_link_reader');
  setQueryExecutor((sql, params) => {
    assertReadOnlySql(sql);
    const read = chain.then(async () => {
      await db.db.exec('begin read only; set local role material_link_reader');
      try {
        const result = await db.db.query(sql, params);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (cause) {
        await db.db.exec('rollback');
        throw cause;
      }
    });
    chain = read.catch(() => {});
    return read;
  });
}, 180_000);
afterAll(async () => {
  vi.restoreAllMocks();
  setQueryExecutor(null);
  await db?.close();
});
it('keeps real clipboard child failures separate from the successful URL through ingestion and SELECT-only inspect', async () => {
  const ingested: Array<{ accepted: boolean; reason: string }> = [];
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean; reason: string }>(
      OWNER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    ingested.push(...rows);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  const actor = vi
    .spyOn(analytics, 'journalContext')
    .mockImplementation(service.journalContext.bind(service));
  try {
    const parent = beginMaterialLinkFlow('get_link');
    parent.stage('url_verified');
    parent.stage('url_visible');
    parent.complete(true);
    const children = Array.from({ length: 3 }, () => {
      const child = beginMaterialLinkFlow('clipboard', { parentFlowId: parent.commandId });
      child.fail('CLIPBOARD_UNAVAILABLE', 'clipboard_denied');
      return child;
    });
    await service.flush();
    expect(ingested).toHaveLength(10);
    expect(ingested.every(row => row.accepted)).toBe(true);
    const result = await getInspect(parent.commandId);
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('Missing parent URL flow');
    expect(result.capability).toBe('team.material_link_get_link');
    expect(result.terminal?.event).toBe('operation_completed');
    expect(result.events.every(event => event.flow_id === parent.commandId)).toBe(true);
    expect(
      result.material_sharing?.related_ui_events.filter(
        event => event.code === 'CLIPBOARD_UNAVAILABLE'
      )
    ).toHaveLength(3);
    const child = await getInspect(children[0]!.commandId);
    expect(child.found && child.capability).toBe('team.material_link_clipboard');
    expect(child.found && child.terminal?.event).toBe('operation_failed');
    expect(JSON.stringify(result.material_sharing)).not.toMatch(
      /https?:|example.invalid|drive_file_id/
    );
    expect(
      (await getMaterialSharingEvidence(parent.commandId, '2000-01-01T00:00:00Z')).related_ui_events
    ).toEqual([]);
  } finally {
    track.mockRestore();
    actor.mockRestore();
  }
});
it('does not invent a browser success from a current server permission observation after the cutoff', async () => {
  const evidence = await getMaterialSharingEvidence(crypto.randomUUID());
  const item = {
    intent_id: crypto.randomUUID(),
    command_id: crypto.randomUUID(),
    team_id: crypto.randomUUID(),
    actor_id: OWNER,
    material_id: null,
    request_state: 'confirmed',
    write_may_have_started: true,
    permission_acknowledged: true,
    created_at: '2026-01-01T00:00:00.000Z',
    public_observed_at: '2026-01-03T00:00:00.000Z'
  };
  const result = inspectMaterialSharing(
    item.command_id,
    { ...evidence, items: [item] },
    '2026-01-02T00:00:00Z'
  );
  expect(result?.terminal).toBeNull();
  expect(result?.last_proven_stage).toBe('request_recorded');
  expect(result?.stages.missing).toContain('browser_result');
});

it('discovers a real server-only pending permission request without browser events', async () => {
  await db.root(`create or replace function extensions.digest(bytea,text) returns bytea language sql immutable
    as $$select decode(md5($1)||md5($1),'hex')$$`);
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  const team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', [
      'Share diagnostics'
    ])
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
    (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
    values('synthetic-secret-provider-id','fixture@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id`,
      [OWNER]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections
    (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
    values($1,$2,'synthetic-private-root','Root','my_drive','connected',now()) returning id`,
      [team, credential]
    )
  )[0]!.id;
  const material = (
    await db.root<{ id: string }>(
      `insert into public.team_materials
    (team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
    values($1,$2,'synthetic-private-file','synthetic-private-root','Private name','file','other','text/csv') returning id`,
      [team, connection]
    )
  )[0]!.id;
  const command = crypto.randomUUID();
  await db.root('select public.service_begin_material_share($1,$2,$3,$4,$5,$6,false,false,null)', [
    team,
    OWNER,
    material,
    connection,
    'synthetic-private-file',
    `share.v2:${Date.now()}:${command}`
  ]);
  const period = {
    token: 'all',
    label: 'all',
    start: '2000-01-01T00:00:00Z',
    end: '2099-01-01T00:00:00Z',
    as_of: '2099-01-01T00:00:00Z'
  };
  const evidence = await getOwnedMaterialSharingEvidence(OWNER, period);
  expect(evidence.items).toHaveLength(1);
  expect(evidence.items[0]).toMatchObject({
    command_id: command,
    request_state: 'write_started',
    write_may_have_started: true,
    permission_acknowledged: false
  });
  const result = await getInspect(command);
  expect(result.found && result.capability).toBe('team.material_sharing');
  expect(result.found && result.terminal).toBeNull();
  expect(evidence.related_ui_events).toEqual([]);
  const audit = await getAudit(period);
  expect(audit.capabilities.find(item => item.id === 'team.material_sharing')).toMatchObject({
    status: 'partial',
    samples: 1,
    missing: expect.arrayContaining([
      'permission_reconciliation_pending',
      'browser_result_unobserved'
    ])
  });
  const investigation = await getInvestigation('link-diagnostics@example.invalid', period);
  expect(investigateOutputIsPrivate(investigation)).toBe(true);
  expect(investigation.material_sharing?.items[0]?.command_id).toBe(command);
  const byCommand = await getInvestigation(command, period);
  expect(byCommand.subject.user_id).toBe(OWNER);
  expect(byCommand.material_sharing?.items[0]?.command_id).toBe(command);
  expect(
    investigation.findings.some(item => item.rule === 'material_sharing_currently_pending')
  ).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/synthetic-private|fixture@example|Private name/);
  expect((await getOwnedMaterialSharingEvidence(crypto.randomUUID(), period)).items).toEqual([]);
});
it('reports a missing receipt projection as unsupported rather than no permission writes', async () => {
  await db.root(
    'alter view public.analytics_material_share_intents rename to material_share_projection_held'
  );
  try {
    const evidence = await getMaterialSharingEvidence(crypto.randomUUID());
    expect(evidence.supported).toBe(false);
    expect(evidence.items).toEqual([]);
    expect(evidence.blind_spots.some(text => text.includes('not proof of no write'))).toBe(true);
  } finally {
    await db.root(
      'alter view public.material_share_projection_held rename to analytics_material_share_intents'
    );
  }
});

it('diagnoses the real hook delivery and clipboard refusal without leaking the returned URL', async () => {
  const service = new ProductAnalytics(async events => {
    const rows = await db.asUser<{ event_id: string; accepted: boolean; reason: string }>(
      OWNER,
      'select * from public.ingest_analytics_events($1::jsonb)',
      [JSON.stringify(events)]
    );
    expect(rows.every(row => row.accepted)).toBe(true);
    return { acceptedEventIds: rows.filter(row => row.accepted).map(row => row.event_id) };
  }, null);
  service.setUser(OWNER);
  const track = vi.spyOn(analytics, 'track').mockImplementation(service.track.bind(service));
  const actor = vi
    .spyOn(analytics, 'journalContext')
    .mockImplementation(service.journalContext.bind(service));
  setPrivateCacheScope(OWNER, 'owner');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
  });
  const client = {
    shareLibraryMaterial: vi.fn().mockResolvedValue({
      state: 'ready',
      linkProtocol: 2,
      url: 'https://drive.google.com/file/d/synthetic-private/view',
      public: true,
      canShare: true,
      permissionChanged: false,
      sharing: 'unchanged',
      shareVersion: null,
      serverNow: new Date().toISOString()
    }),
    getLibrarySharePreference: vi.fn()
  };
  const teamId = crypto.randomUUID(),
    materialId = crypto.randomUUID();
  const view = renderHook(() =>
    useMaterialLink({
      teamId,
      materialId,
      storageKind: 'shared_drive',
      surface: 'catalog_manager',
      canShare: true,
      client
    })
  );
  try {
    await act(async () => {
      await view.result.current.open('get_link');
    });
    const shown = view.result.current.visible;
    expect(shown?.result.public).toBe(true);
    await service.flush();
    const result = await getInspect(shown!.commandId);
    expect(result.found && result.capability).toBe('team.material_link_get_link');
    expect(result.found && result.terminal?.event).toBe('operation_completed');
    expect(
      result.material_sharing?.related_ui_events.some(
        event => event.code === 'CLIPBOARD_UNAVAILABLE'
      )
    ).toBe(true);
    expect(client.shareLibraryMaterial).toHaveBeenCalledTimes(1);
    expect(client.getLibrarySharePreference).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  } finally {
    cleanup();
    track.mockRestore();
    actor.mockRestore();
  }
});
