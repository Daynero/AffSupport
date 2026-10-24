import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { captureVerifiedFixtureNotices } from '../scripts/acceptance/mail-capture.mjs';
import { storeNoticeCapture } from '../scripts/acceptance/mail-capture-store.mjs';
import { writePrivateState } from '../scripts/acceptance/private-state.mjs';
import { removeTemporaryDirectory } from './support/temp-dir';
const namespace = 'acceptance-mail-sql';
const fixture = {
  actors: Object.fromEntries(['A', 'B', 'C', 'X', 'S'].map(alias => [alias, { id: randomUUID() }])),
  teams: {} as Record<string, string>
};
let db: TeamTestDb;
let root: string;
const roots: string[] = [];
let sqlFailure = '';
const client = {
  query: async (sql: string, params?: unknown[]) => {
    try {
      return { rows: await db.root<Record<string, unknown>>(sql, params) };
    } catch (error) {
      sqlFailure = error instanceof Error ? error.message : 'unknown';
      throw error;
    }
  }
};
const record = async (id: string, kind: string, message: unknown) => {
  await storeNoticeCapture(namespace, id, kind, message, { root });
};
beforeAll(async () => {
  db = await createTeamTestDb();
  for (const [alias, actor] of Object.entries(fixture.actors)) {
    await createUser(db, {
      id: actor.id,
      email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
      displayName: 'PRIVATE_NAME'
    });
    await db.root(
      "update auth.users set raw_user_meta_data=jsonb_build_object('acceptance_namespace',$2::text) where id=$1",
      [actor.id, namespace]
    );
  }
  await db.root('insert into public.admin_users(user_id) values($1)', [fixture.actors.S.id]);
  for (const [alias, owner] of [
    ['W1', 'A'],
    ['W2', 'X']
  ]) {
    await db.asUser(
      fixture.actors.S.id,
      "select public.admin_grant_space_tariff($1,'lead',private.kyiv_today()+30,0)",
      [`${namespace}-${owner.toLowerCase()}@soty.invalid`]
    );
    fixture.teams[alias] = (
      await db.asUser<{ id: string }>(
        fixture.actors[owner].id,
        'select id from public.create_team($1)',
        [`${namespace} ${alias}`]
      )
    )[0].id;
  }
}, 120000);
beforeEach(async () => {
  sqlFailure = '';
  root = await mkdtemp(path.join(tmpdir(), 'soty-mail-sql-'));
  roots.push(root);
  await db.root('delete from public.space_tariff_notices');
  await db.root(
    "insert into public.space_tariff_notices(tariff_id,kind,period_end) select id,'granted',ends_on from public.space_tariffs where owner_id=any($1::uuid[])",
    [[fixture.actors.A.id, fixture.actors.X.id]]
  );
});
afterAll(async () => {
  await db?.close();
  for (const item of roots) await removeTemporaryDirectory(item);
});
const snapshot = () =>
  db.root(
    'select id,state,attempts,sent_at,lease_until,last_error from public.space_tariff_notices order by id'
  );
it('uses the actual claim, renderer, immutable store and skipped receipt without delivering mail', async () => {
  const result = await captureVerifiedFixtureNotices(client, namespace, fixture, record);
  expect(result, JSON.stringify({ result, sqlFailure })).toMatchObject({
    ok: true,
    delivered: false,
    databaseCommitted: true,
    summary: { claimed: 2, captured: 2, skipped: 2, sent: 0, failed: 0 }
  });
  const rows = await snapshot();
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row).toMatchObject({ state: 'skipped', sent_at: null, attempts: 1 });
  const files = await readdir(path.join(root, namespace));
  expect(files).toHaveLength(2);
  for (const file of files) {
    const stored = await readFile(path.join(root, namespace, file), 'utf8');
    expect(stored).not.toContain('PRIVATE_NAME');
    expect(stored).not.toContain('@soty.invalid');
    expect(JSON.parse(stored)).toMatchObject({
      delivered: false,
      message: { html: expect.stringContaining('QA owner') }
    });
  }
  expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject({
    ok: true,
    summary: { claimed: 0, captured: 0, sent: 0 }
  });
  expect(await readdir(path.join(root, namespace))).toEqual(files);
});
it.each([false, true])(
  'refuses foreign pending notices before any claim, leased=%s',
  async leased => {
    const id = randomUUID();
    const email = `${id}@soty.invalid`;
    await createUser(db, { id, email });
    const tariff = (
      await db.asUser<{ id: string }>(
        fixture.actors.S.id,
        "select public.admin_grant_space_tariff($1,'lead',private.kyiv_today()+30,0)->>'id' id",
        [email]
      )
    )[0].id;
    await db.root("select private.queue_space_tariff_letter($1,'granted')", [tariff]);
    expect(
      (
        await db.root<{ n: number }>(
          "select count(*)::int n from public.space_tariff_notices where tariff_id=$1 and state='pending'",
          [tariff]
        )
      )[0].n
    ).toBe(1);
    if (leased)
      await db.root(
        "update public.space_tariff_notices set lease_until=clock_timestamp()+interval '1 hour' where tariff_id=$1",
        [tariff]
      );
    const before = await snapshot();
    const capture = vi.fn(record);
    expect(await captureVerifiedFixtureNotices(client, namespace, fixture, capture)).toMatchObject({
      ok: false,
      stage: 'scope',
      captured: 0,
      databaseCommitted: false
    });
    expect(capture).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  }
);
it('rolls back notice claims on partial local-write failure and safely reuses the retained artifact', async () => {
  const before = await snapshot();
  let calls = 0;
  const partial = async (id: string, kind: string, message: unknown) => {
    if (++calls === 2) throw Error('PRIVATE_STORAGE_ERROR');
    await record(id, kind, message);
  };
  expect(await captureVerifiedFixtureNotices(client, namespace, fixture, partial)).toMatchObject({
    ok: false,
    captured: 1,
    databaseCommitted: false
  });
  expect(await snapshot()).toEqual(before);
  expect(await readdir(path.join(root, namespace))).toHaveLength(1);
  expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject({
    ok: true,
    summary: { captured: 2, sent: 0 }
  });
  expect(await readdir(path.join(root, namespace))).toHaveLength(2);
});
it('reports a lost commit reply as unconfirmed and never manufactures delivery', async () => {
  const lost = {
    query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (sql === 'commit') throw Error('LOST_REPLY');
      return result;
    }
  };
  expect(await captureVerifiedFixtureNotices(lost, namespace, fixture, record)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_MAIL_CAPTURE_UNCONFIRMED',
    stage: 'commit',
    captured: 2,
    delivered: false,
    databaseCommitted: null
  });
  for (const row of await snapshot())
    expect(row).toMatchObject({ state: 'skipped', sent_at: null });
  expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject({
    ok: true,
    summary: { claimed: 0, captured: 0 }
  });
});

it('reports an owned leased notice as pending instead of implying the whole queue was captured', async () => {
  const id = (
    await db.root<{ id: string }>('select id from public.space_tariff_notices order by id limit 1')
  )[0].id;
  await db.root(
    "update public.space_tariff_notices set lease_until=clock_timestamp()+interval '1 hour' where id=$1",
    [id]
  );
  expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject({
    ok: true,
    state: 'partial',
    pending: 1,
    summary: { claimed: 1, captured: 1, skipped: 1, sent: 0 }
  });
  expect((await snapshot()).find(row => row.id === id)).toMatchObject({
    state: 'pending',
    attempts: 0,
    sent_at: null
  });
});

it('rechecks pending fixture cleanup after acquiring the namespace lock', async () => {
  const before = await snapshot();
  await writePrivateState(namespace, 'cleanup.json', { state: 'pending' }, { createOnly: true });
  const capture = vi.fn(record);
  try {
    expect(await captureVerifiedFixtureNotices(client, namespace, fixture, capture)).toMatchObject({
      ok: false,
      stage: 'lifecycle',
      reason: 'ACCEPTANCE_FIXTURE_CLEANUP_PENDING',
      captured: 0,
      databaseCommitted: false
    });
    expect(capture).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  } finally {
    await rm(path.resolve('release/acceptance-private', namespace, 'cleanup.json'));
  }
});

it('bounds a stalled recording, reports uncertain capture and safely replays a late immutable file', async () => {
  let resume!: () => void;
  const held = new Promise<void>(resolve => {
    resume = resolve;
  });
  let lateWrite = Promise.resolve();
  let calls = 0;
  const running = captureVerifiedFixtureNotices(
    client,
    namespace,
    fixture,
    (id: string, kind: string, message: unknown) => {
      calls++;
      lateWrite = held.then(() => record(id, kind, message));
      return lateWrite;
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      running,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 6500);
      })
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: 'CAPTURE_TIMEOUT',
      captured: 0,
      captureUnconfirmed: 1,
      delivered: false,
      databaseCommitted: false
    });
    expect(calls).toBe(1);
    expect((await snapshot()).every(row => row.state === 'pending' && row.attempts === 0)).toBe(
      true
    );
    resume();
    await lateWrite;
    expect(result).toMatchObject({ captured: 0, captureUnconfirmed: 1 });
    expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject({
      ok: true,
      summary: { captured: 2, skipped: 2, sent: 0 }
    });
    expect(await readdir(path.join(root, namespace))).toHaveLength(2);
  } finally {
    clearTimeout(timer);
    resume();
    await running;
    await lateWrite;
  }
}, 20000);

const noticeCases = [
  ['warn_3d', 3, 'діє до', 'is active through'],
  ['warn_1d', 1, 'закінчується завтра', 'ends tomorrow'],
  ['grace', -1, 'Тариф закінчився', 'Your plan has ended'],
  ['blocked', -4, 'Простір призупинено', 'The space is paused'],
  ['granted', 30, 'Простір відкрито', 'Your space is open'],
  ['renewed', 30, 'продовжено до', 'is extended through'],
  ['member_nudge', -4, 'просить відновити доступ', 'asks you to restore access']
] as const;
for (const [kind, days, uk, en] of noticeCases) {
  for (const locale of ['uk', 'en'] as const) {
    it(`captures actual due ${kind} notice in ${locale} through SQL, renderer and immutable file`, async () => {
      await db.root('delete from public.space_tariff_notices');
      await db.root('update public.profiles set language=$2 where id=$1', [
        fixture.actors.A.id,
        locale
      ]);
      const tariff = (
        await db.root<{ id: string; ends_on: string }>(
          "update public.space_tariffs set starts_at=now()-interval '30 days',ends_on=private.kyiv_today()+$2::int where owner_id=$1 returning id,ends_on",
          [fixture.actors.A.id, days]
        )
      )[0];
      const id = randomUUID();
      await db.root(
        'insert into public.space_tariff_notices(id,tariff_id,kind,period_end,requested_by) values($1,$2,$3,$4,$5)',
        [id, tariff.id, kind, tariff.ends_on, kind === 'member_nudge' ? fixture.actors.B.id : null]
      );
      expect(
        (
          await db.root<{ due: boolean }>(
            'select private.tariff_notice_still_due(n) due from public.space_tariff_notices n where id=$1',
            [id]
          )
        )[0].due
      ).toBe(true);
      expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject(
        {
          ok: true,
          state: 'captured',
          pending: 0,
          summary: { claimed: 1, captured: 1, skipped: 1, sent: 0, failed: 0 }
        }
      );
      const raw = await readFile(path.join(root, namespace, `mail-${id}.json`), 'utf8');
      const file = JSON.parse(raw);
      expect(file).toMatchObject({
        id,
        kind,
        delivered: false,
        message: {
          html: expect.stringContaining(`lang="${locale}"`),
          text: expect.stringContaining(locale === 'uk' ? uk : en)
        }
      });
      expect(raw).not.toContain('PRIVATE_NAME');
      expect(raw).not.toContain('@soty.invalid');
      expect(await snapshot()).toEqual([
        expect.objectContaining({ id, state: 'skipped', attempts: 1, sent_at: null })
      ]);
      expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject(
        { ok: true, state: 'idle', summary: { claimed: 0, captured: 0, sent: 0 } }
      );
      expect(await readdir(path.join(root, namespace))).toEqual([`mail-${id}.json`]);
    });
  }
}

it('scheduled grace producer captures the actual updater start/stop distinction in both locales', async () => {
  const team = fixture.teams.W1,
    owner = fixture.actors.A.id;
  await db.root(
    'update public.space_tariffs set ends_on=private.kyiv_today()+30 where owner_id=$1',
    [owner]
  );
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('mail-updater','synthetic@example.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0].id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'synthetic-root','Synthetic root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0].id;
  const material = async (name: string, category: string, mime: string) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5) returning id",
        [team, connection, name, category, mime]
      )
    )[0].id;
  const video = await material('synthetic-video', 'video', 'video/mp4');
  const sheet = await material(
    'synthetic-sheet',
    'other',
    'application/vnd.google-apps.spreadsheet'
  );
  expect(
    (
      await db.root<{ value: { linked: boolean } }>(
        'select public.service_link_product_catalog_companion($1,$2,$3,null,$4) value',
        [
          team,
          video,
          sheet,
          JSON.stringify({
            sourceLink: 'https://example.test/offer',
            productCount: 3,
            sheetUrl: 'https://example.test/sheet',
            videoLink: 'https://example.test/video',
            settingsSnapshot: {},
            createdBy: owner
          })
        ]
      )
    )[0].value.linked
  ).toBe(true);
  for (const locale of ['uk', 'en']) {
    for (const running of [true, false]) {
      await db.root('delete from public.space_tariff_notices');
      await db.root('update public.profiles set language=$2 where id=$1', [owner, locale]);
      await db.root(
        'update public.space_tariffs set ends_on=private.kyiv_today()+30 where owner_id=$1',
        [owner]
      );
      if (running)
        await db.asUser(owner, 'select public.save_team_catalog_updater($1,$2,$3,false)', [
          team,
          [sheet],
          '1h'
        ]);
      else await db.asUser(owner, 'select public.stop_team_catalog_updater($1)', [team]);
      expect(
        (
          await db.root<{ running: boolean }>('select private.team_updater_running($1) running', [
            team
          ])
        )[0].running
      ).toBe(running);
      await db.root(
        'update public.space_tariffs set ends_on=private.kyiv_today()-1 where owner_id=$1',
        [owner]
      );
      await db.root('select private.queue_tariff_notices()');
      const notices = await db.root<{ id: string; kind: string }>(
        'select id,kind from public.space_tariff_notices'
      );
      expect(notices).toHaveLength(1);
      expect(notices[0].kind).toBe('grace');
      expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject(
        { ok: true, summary: { captured: 1, skipped: 1, sent: 0, failed: 0 } }
      );
      const file = JSON.parse(
        await readFile(path.join(root, namespace, `mail-${notices[0].id}.json`), 'utf8')
      );
      const phrase =
        locale === 'uk'
          ? 'Потім оновлення каталогів зупиниться.'
          : 'Then catalog updates will stop.';
      expect(file.message.text.includes(phrase)).toBe(running);
      expect(file.message.html).toContain(`lang="${locale}"`);
      // Repeating the scheduled producer must not enqueue a duplicate for this tariff period.
      await db.root('select private.queue_tariff_notices()');
      expect(await snapshot()).toHaveLength(1);
      expect(await captureVerifiedFixtureNotices(client, namespace, fixture, record)).toMatchObject(
        { ok: true, state: 'idle', summary: { claimed: 0, captured: 0, sent: 0 } }
      );
    }
  }
  expect(await readdir(path.join(root, namespace))).toHaveLength(4);
});
