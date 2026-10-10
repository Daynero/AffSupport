import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CATEGORIES } from '../packages/shared/src/types.js';
import { createTeamTestDb, type TeamTestDb } from './support/team-db.js';

/**
 * 033 US2 / FR-001, FR-002, FR-004, FR-011 — the agent journal's server-side
 * fence, run against a real Postgres with every repository migration applied
 * (20261124100000_agent_journal.sql last). The browser that forwards records is
 * not trusted, so everything the agent would refuse must be refused here too.
 */

const MIGRATION = 'supabase/migrations/20261124100000_agent_journal.sql';
const USER = '33000000-0000-4000-8000-000000000001';
const OTHER = '33000000-0000-4000-8000-000000000002';
const INSTALLATION = '33000000-0000-4000-8000-0000000000a1';
const INSTANCE = '33000000-0000-4000-8000-0000000000b1';
const RESTARTED = '33000000-0000-4000-8000-0000000000b2';

type IngestResult = {
  accepted: number;
  duplicates: number;
  rejected: { seq: number | null; reason: string }[];
};

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  for (const [id, email] of [
    [USER, 'journal@agent.test'],
    [OTHER, 'other@agent.test']
  ]) {
    await harness.root(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  }
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function ingest(
  records: unknown,
  options: { as?: string | null; instance?: string; installation?: string | null } = {}
): Promise<IngestResult> {
  const rows = await harness.asUser<{ result: IngestResult }>(
    options.as === undefined ? USER : options.as,
    'select public.ingest_agent_journal($1::uuid, $2::uuid, $3::jsonb) as result',
    [
      options.installation === undefined ? INSTALLATION : options.installation,
      options.instance ?? INSTANCE,
      JSON.stringify(records)
    ]
  );
  return rows[0]!.result;
}

function record(seq: number, extra: Record<string, unknown> = {}) {
  return { seq, at: Date.now() - 60_000, category: 'spawn', code: 'exit_nonzero', ...extra };
}

describe('agent journal ingestion (PGlite, real migration)', () => {
  it('keeps the SQL category list identical to DIAGNOSTIC_CATEGORIES', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const match = /v_category not in \(([\s\S]*?)\)/.exec(sql);
    expect(match, 'the migration names its category list').not.toBeNull();
    const listed = [...match![1]!.matchAll(/'([a-z_]+)'/g)].map(item => item[1]);
    expect(listed).toEqual([...DIAGNOSTIC_CATEGORIES]);
  });

  it('accepts safe records and stores them against the caller', async () => {
    const at = Date.UTC(2026, 9, 10, 12, 0, 0);
    const result = await ingest([
      record(1, { at, props: { duration: 'under_10s', exitCode: 1, killed: false } }),
      record(2, { category: 'stream', code: 'subscriber_evicted' })
    ]);
    expect(result).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    const rows = await harness.root<{
      user_id: string;
      installation_id: string;
      category: string;
      props: Record<string, unknown>;
      recorded_at: Date;
    }>(
      `select user_id, installation_id, category, props, recorded_at
         from public.agent_journal_records where agent_instance_id = $1 and seq = 1`,
      [INSTANCE]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER);
    expect(rows[0]!.installation_id).toBe(INSTALLATION);
    expect(rows[0]!.props).toEqual({ duration: 'under_10s', exitCode: 1, killed: false });
    expect(new Date(rows[0]!.recorded_at).getTime()).toBe(at);
  });

  it('treats a record already stored as a no-op, and a restarted agent as new rows', async () => {
    const again = await ingest([record(1), record(2), record(3)]);
    expect(again).toEqual({ accepted: 1, duplicates: 2, rejected: [] });
    const restarted = await ingest([record(1)], { instance: RESTARTED });
    expect(restarted).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    const count = await harness.root<{ count: number }>(
      `select count(*)::int as count from public.agent_journal_records
        where agent_instance_id in ($1, $2)`,
      [INSTANCE, RESTARTED]
    );
    expect(count[0]!.count).toBe(4);
  });

  it.each([
    ['not an object', 'just text', null, 'invalid_record'],
    ['seq zero', record(0), null, 'invalid_seq'],
    ['seq fractional', record(1.5), null, 'invalid_seq'],
    ['seq as text', record(1, { seq: '7' }), null, 'invalid_seq'],
    ['time as text', record(40, { at: '2026-10-10' }), 40, 'invalid_time'],
    ['time far ahead', record(41, { at: Date.now() + 2 * 86_400_000 }), 41, 'future_time'],
    ['unknown category', record(42, { category: 'filesystem' }), 42, 'invalid_category'],
    ['bad code', record(43, { code: 'Exit-Code' }), 43, 'invalid_code'],
    ['props as array', record(44, { props: ['a'] }), 44, 'invalid_props'],
    [
      'seventeen props',
      record(45, {
        props: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))
      }),
      45,
      'too_many_props'
    ],
    ['bad prop key', record(46, { props: { 'file-name': 'x' } }), 46, 'invalid_prop_key'],
    ['nested prop', record(47, { props: { nested: { a: 1 } } }), 47, 'invalid_prop_value'],
    ['long string', record(48, { props: { v: 'a'.repeat(65) } }), 48, 'invalid_prop_value'],
    ['empty string', record(49, { props: { v: '' } }), 49, 'invalid_prop_value'],
    ['a path', record(50, { props: { v: 'Users/me' } }), 50, 'unsafe_prop_value'],
    ['a windows path', record(51, { props: { v: 'C:\\Users' } }), 51, 'unsafe_prop_value'],
    ['a url', record(52, { props: { v: 'https:\\\\x' } }), 52, 'unsafe_prop_value'],
    ['a scheme separator', record(56, { props: { v: 'a://b' } }), 56, 'unsafe_prop_value'],
    ['a token', record(53, { props: { v: 'AccessToken' } }), 53, 'unsafe_prop_value'],
    ['a bearer', record(54, { props: { v: 'BEARER abc' } }), 54, 'unsafe_prop_value'],
    ['an email', record(55, { props: { v: 'me@x.test' } }), 55, 'unsafe_prop_value']
  ] as const)('refuses %s', async (_label, input, seq, reason) => {
    const result = await ingest([input]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toEqual([{ seq, reason }]);
    if (seq !== null) {
      const stored = await harness.root<{ count: number }>(
        `select count(*)::int as count from public.agent_journal_records
          where agent_instance_id = $1 and seq = $2`,
        [INSTANCE, seq]
      );
      expect(stored[0]!.count).toBe(0);
    }
  });

  it('keeps the good records of a mixed batch', async () => {
    const result = await ingest([
      record(60),
      record(61, { props: { v: 'tmp/secret' } }),
      record(62, { props: { finite: 3.5, ok: true } })
    ]);
    expect(result).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [{ seq: 61, reason: 'unsafe_prop_value' }]
    });
  });

  it('refuses a batch of more than 200, an anonymous caller and a missing instance', async () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => record(1_000 + index));
    await expect(ingest(tooMany)).rejects.toThrow(/at most 200/);
    await expect(ingest(Array.from({ length: 200 }, (_, i) => record(2_000 + i)))).resolves.toEqual(
      { accepted: 200, duplicates: 0, rejected: [] }
    );
    await expect(ingest({ seq: 1 })).rejects.toThrow(/at most 200/);
    await expect(ingest([record(3_000)], { as: null })).rejects.toThrow(/Authentication/);
    await expect(
      harness.asUser(USER, 'select public.ingest_agent_journal($1, null, $2::jsonb)', [
        INSTALLATION,
        '[]'
      ])
    ).rejects.toThrow(/agent instance/);
  });

  it('grants nothing but execute to authenticated and select to admins', async () => {
    const rows = await harness.root<Record<string, boolean>>(
      `select
         has_function_privilege('authenticated',
           'public.ingest_agent_journal(uuid, uuid, jsonb)', 'execute') as auth_exec,
         has_function_privilege('anon',
           'public.ingest_agent_journal(uuid, uuid, jsonb)', 'execute') as anon_exec,
         has_table_privilege('authenticated', 'public.agent_journal_records', 'insert') as auth_ins,
         has_table_privilege('anon', 'public.agent_journal_records', 'select') as anon_sel,
         has_table_privilege('service_role', 'public.agent_journal_records', 'insert') as svc_ins,
         (select relrowsecurity from pg_class
           where oid = 'public.agent_journal_records'::regclass) as rls`
    );
    expect(rows[0]).toEqual({
      auth_exec: true,
      anon_exec: false,
      auth_ins: false,
      anon_sel: false,
      svc_ins: false,
      rls: true
    });
  });

  it('purges journal records older than 30 days in the retention job', async () => {
    await harness.root(
      `insert into public.agent_journal_records
         (user_id, agent_instance_id, seq, recorded_at, category, code)
       values ($1, $2, 1, now() - interval '31 days', 'boot', 'started'),
              ($1, $2, 2, now() - interval '29 days', 'boot', 'started')`,
      [OTHER, '33000000-0000-4000-8000-0000000000c1']
    );
    const purge = await harness.root<{ result: Record<string, unknown> }>(
      'select private.purge_analytics_events(90) as result'
    );
    expect(purge[0]!.result).toMatchObject({ deleted_journal_records: 1, deleted_events: 0 });
    const left = await harness.root<{ seq: number }>(
      `select seq::int as seq from public.agent_journal_records where agent_instance_id = $1`,
      ['33000000-0000-4000-8000-0000000000c1']
    );
    expect(left).toEqual([{ seq: 2 }]);
  });

  it('deletes a user’s journal with the account', async () => {
    await harness.root('delete from auth.users where id = $1', [OTHER]);
    const left = await harness.root<{ count: number }>(
      `select count(*)::int as count from public.agent_journal_records where user_id = $1`,
      [OTHER]
    );
    expect(left[0]!.count).toBe(0);
  });
});
