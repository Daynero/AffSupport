import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';

/**
 * Backend audit 2026-11-20 (20261220120000): every event repeated the connected app's tool
 * contract list — 309 bytes, 40% of the largest table, eight distinct values in 537 000 rows,
 * read by nothing. A plain list is stored once and referenced; four indexes that were never
 * read or duplicated the leading column of another are gone.
 */
const USER = '47000000-0000-4000-8000-0000000000f1';
const OTHER = '47000000-0000-4000-8000-0000000000f2';
// The shape released clients send: tool name → contract version.
const CONTRACTS = { compressor: 3, stitcher: 1, teamWorkspace: 2 };
const BEFORE = '20261220110000_restitch_copy_retirement_cheap.sql';
let db: TeamTestDb;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: USER, email: 'lean-events@example.invalid' });
  await createUser(db, { id: OTHER, email: 'lean-events-other@example.invalid' });
}, 120_000);
afterAll(async () => {
  await db?.close();
});

interface Verdict {
  event_id: string | null;
  accepted: boolean;
  reason: string | null;
}
const event = (extra: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  event_name: 'tool_opened',
  properties: {},
  ...extra
});
const ingest = (user: string, events: unknown[]) =>
  db.asUser<Verdict>(user, 'select * from public.ingest_analytics_events($1::jsonb)', [
    JSON.stringify(events)
  ]);
const stored = async (eventId: string) =>
  (
    await db.root<{ tool_contracts: unknown; tool_contract_set_id: number | null }>(
      'select tool_contracts, tool_contract_set_id from public.analytics_events where event_id=$1',
      [eventId]
    )
  )[0];
const sets = () =>
  db.root<{ id: number; contracts: unknown }>(
    'select id, contracts from public.analytics_tool_contract_sets order by id'
  );

it('stores a tool contract list once and points every event at it', async () => {
  const first = [
    event({ tool_contracts: CONTRACTS }),
    event({ tool_contracts: CONTRACTS }),
    // Key order is not a different list.
    event({ tool_contracts: { teamWorkspace: 2, stitcher: 1, compressor: 3 } })
  ];
  expect((await ingest(USER, first)).map(row => row.accepted)).toEqual([true, true, true]);
  const second = [event({ tool_contracts: CONTRACTS })];
  expect((await ingest(OTHER, second)).map(row => row.accepted)).toEqual([true]);

  const dictionary = await sets();
  expect(dictionary).toHaveLength(1);
  expect(dictionary[0]!.contracts).toEqual(CONTRACTS);
  for (const sent of [...first, ...second])
    expect(await stored(sent.event_id)).toEqual({
      tool_contracts: {},
      tool_contract_set_id: dictionary[0]!.id
    });
});

it('gives a different list its own entry and leaves an absent one unreferenced', async () => {
  const other = { compressor: 4 };
  const batch = [event({ tool_contracts: other }), event(), event({ tool_contracts: {} })];
  expect((await ingest(USER, batch)).map(row => row.accepted)).toEqual([true, true, true]);

  const dictionary = await sets();
  expect(dictionary.map(row => row.contracts)).toEqual([CONTRACTS, other]);
  expect(await stored(batch[0]!.event_id)).toEqual({
    tool_contracts: {},
    tool_contract_set_id: dictionary[1]!.id
  });
  for (const sent of batch.slice(1))
    expect(await stored(sent.event_id)).toEqual({ tool_contracts: {}, tool_contract_set_id: null });
});

it('keeps anything that is not a plain name/version map in its own event, never in the dictionary', async () => {
  // The dictionary outlives retention and is searched by the attachment cleanup inventory,
  // so it takes the one shape clients send and nothing a caller could use to park text or
  // an identifier there for good.
  const before = (await sets()).length;
  const odd = [
    { compressor: { version: 3 } },
    { note: 'free text a caller wants kept' },
    { 'a1b2c3d4-0000-4000-8000-000000000001': 1 },
    { '1DriveFileIdThatIsLongerThanAnyToolNameEverIs': 1 },
    { compressor: 3.5 },
    { compressor: -1 },
    { compressor: 12345678 },
    { 'team-workspace': 2 }
  ];
  const batch = odd.map(tool_contracts => event({ tool_contracts }));
  expect((await ingest(USER, batch)).map(row => row.accepted)).toEqual(odd.map(() => true));
  expect((await sets()).length).toBe(before);
  for (const [index, sent] of batch.entries())
    expect(await stored(sent.event_id)).toEqual({
      tool_contracts: odd[index],
      tool_contract_set_id: null
    });
});

it('still refuses an event whose list is not an object or is too large, and only that event', async () => {
  const before = (await sets()).length;
  const batch = [
    event({ tool_contracts: [1, 2, 3] }),
    event({ tool_contracts: { blob: 'x'.repeat(2100) } }),
    event({ tool_contracts: null }),
    event({ tool_contracts: CONTRACTS })
  ];
  const verdicts = await ingest(USER, batch);
  expect(verdicts.map(row => row.accepted)).toEqual([false, false, false, true]);
  for (const refused of batch.slice(0, 3)) expect(await stored(refused.event_id)).toBeUndefined();
  expect((await sets()).length).toBe(before);
});

it('does not hand a later event the id of a list a refused event took down with it', async () => {
  // The first event adds a new list and is then refused by the table (an architecture the
  // envelope does not know), which rolls its dictionary row back. The second carries the
  // same list and must get a row that exists.
  const fresh = { compressor: 9 };
  const batch = [
    event({ tool_contracts: fresh, architecture: 'riscv' }),
    event({ tool_contracts: fresh })
  ];
  const verdicts = await ingest(USER, batch);
  expect(verdicts.map(row => row.accepted)).toEqual([false, true]);
  const row = await stored(batch[1]!.event_id);
  expect(row!.tool_contract_set_id).not.toBeNull();
  expect(
    await db.root('select contracts from public.analytics_tool_contract_sets where id=$1', [
      row!.tool_contract_set_id
    ])
  ).toEqual([{ contracts: fresh }]);
});

it('keeps the list in the row once the dictionary is full, so a flood cannot grow it', async () => {
  await db.root(
    `insert into public.analytics_tool_contract_sets(digest, contracts)
     select 'filler-'||i, jsonb_build_object('filler', i) from generate_series(1, 500) i`
  );
  const before = (await sets()).length;
  const novel = { compressor: 77 };
  // Twice in one batch: the second must land the same way as the first.
  const sent = [event({ tool_contracts: novel }), event({ tool_contracts: novel })];
  expect((await ingest(USER, sent)).map(row => row.accepted)).toEqual([true, true]);
  expect((await sets()).length).toBe(before);
  for (const item of sent)
    expect(await stored(item.event_id)).toEqual({
      tool_contracts: novel,
      tool_contract_set_id: null
    });
  // A list already known is still referenced.
  const known = event({ tool_contracts: CONTRACTS });
  await ingest(USER, [known]);
  expect((await stored(known.event_id))!.tool_contract_set_id).not.toBeNull();
  await db.root("delete from public.analytics_tool_contract_sets where digest like 'filler-%'");
});

it('never trusts a digest alone: a row with the same digest and another list is not the list', async () => {
  const mine = { compressor: 55 };
  const digest = (
    await db.root<{ digest: string }>('select md5($1::jsonb::text) digest', [JSON.stringify(mine)])
  )[0]!.digest;
  await db.root(
    `insert into public.analytics_tool_contract_sets(digest, contracts) values($1, '{"impostor":1}'::jsonb)`,
    [digest]
  );
  const sent = event({ tool_contracts: mine });
  expect((await ingest(USER, [sent])).map(row => row.accepted)).toEqual([true]);
  expect(await stored(sent.event_id)).toEqual({ tool_contracts: mine, tool_contract_set_id: null });
  await db.root('delete from public.analytics_tool_contract_sets where digest=$1', [digest]);
});

it('refuses a dictionary row that is not a plain list, whoever writes it', async () => {
  await expect(
    db.root(
      `insert into public.analytics_tool_contract_sets(digest, contracts) values('x', '{"note":"text"}'::jsonb)`
    )
  ).rejects.toThrow(/analytics_tool_contract_sets_shape/);
});

it('delivers a repeated event once', async () => {
  const sent = event({ tool_contracts: CONTRACTS });
  await ingest(USER, [sent]);
  expect((await ingest(USER, [sent])).map(row => row.accepted)).toEqual([true]);
  expect(
    await db.root('select count(*)::int n from public.analytics_events where event_id=$1', [
      sent.event_id
    ])
  ).toEqual([{ n: 1 }]);
});

it('carries the attachment cleanup guard like every table with a jsonb column', async () => {
  // Without it private.task_cleanup_coverage_verified() is false for the whole database and
  // no orphaned upload can be claimed.
  expect(
    await db.root(
      "select tgname from pg_trigger where tgrelid='public.analytics_tool_contract_sets'::regclass and not tgisinternal"
    )
  ).toEqual([{ tgname: 'task_cleanup_reference_fence' }]);
  expect(await db.root('select private.task_cleanup_coverage_verified() ok')).toEqual([
    { ok: true }
  ]);
});

it('keeps the indexes that are read and drops the ones that were not', async () => {
  const names = (
    await db.root<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname='public' and tablename='analytics_events'"
    )
  ).map(row => row.indexname);
  for (const kept of [
    'analytics_events_pkey',
    'analytics_events_event_id_idx',
    'analytics_events_event_created_idx',
    'analytics_events_user_created_idx',
    'analytics_events_tool_created_idx',
    'analytics_events_created_at_idx',
    'analytics_events_attempt_created_idx',
    'analytics_events_run_created_idx',
    // `analytics investigate <installation id>` resolves its subject through this one.
    'analytics_events_installation_created_idx'
  ])
    expect(names).toContain(kept);
  for (const dropped of [
    'analytics_events_local_build_idx',
    'analytics_events_event_name_idx',
    'analytics_events_tool_idx',
    'analytics_events_user_id_idx'
  ])
    expect(names).not.toContain(dropped);
});

it('takes the dictionary back from every API role even where new tables are granted by default', async () => {
  // Supabase grants each new public table to anon, authenticated and service_role. The
  // shared harness does not model that, so a suite built on it would pass with the revoke
  // deleted; this one meets the migration with those defaults in place.
  const hosted = await createTeamTestDb({ throughMigration: BEFORE });
  try {
    await hosted.db.exec(
      'alter default privileges in schema public grant all on tables to anon, authenticated, service_role;'
    );
    await applyMigrationsAfter(hosted, BEFORE);
    for (const role of ['anon', 'authenticated', 'service_role'])
      for (const privilege of ['select', 'insert', 'update', 'delete'])
        expect(
          await hosted.root(
            "select has_table_privilege($1,'public.analytics_tool_contract_sets',$2) allowed",
            [role, privilege]
          ),
          `${role} ${privilege}`
        ).toEqual([{ allowed: false }]);
    expect(
      await hosted.root(
        "select relrowsecurity from pg_class where oid='public.analytics_tool_contract_sets'::regclass"
      )
    ).toEqual([{ relrowsecurity: true }]);
    for (const role of ['anon', 'authenticated', 'service_role'])
      expect(
        await hosted.root(
          "select has_function_privilege($1,'private.analytics_tool_contract_list_is_plain(jsonb)','EXECUTE') allowed",
          [role]
        )
      ).toEqual([{ allowed: false }]);
  } finally {
    await hosted.close();
  }
}, 120_000);
