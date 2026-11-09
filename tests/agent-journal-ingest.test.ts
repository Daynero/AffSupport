import { createHash, randomUUID } from 'node:crypto';
import {
  DiagnosticsLog,
  setActiveDiagnosticsLog,
  activeDiagnosticsLogOrNull
} from '../apps/agent/src/server/diagnostics-log';
import { TranscriptionAttemptJournal } from '../apps/agent/src/transcription/diagnostics';
import { setQueryExecutor } from '../scripts/analytics/db';
import { getJournal } from '../scripts/analytics/investigate';
import { getInspect } from '../scripts/analytics/queries';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_CATEGORIES } from '../packages/shared/src/types.js';
import { createTeamTestDb, type TeamTestDb } from './support/team-db.js';

import { mkdtemp, readdir } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import os from 'node:os';
import path from 'node:path';
import { TeamTransferClient } from '../apps/agent/src/team-bridge/transfer';
import { TeamProcessBridge } from '../apps/agent/src/team-bridge/process';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events';
import { assertReadOnlySql } from '../scripts/analytics/db';

/**
 * 033 US2 / FR-001, FR-002, FR-004, FR-011 — the agent journal's server-side
 * fence, run against a real Postgres with every repository migration applied
 * including the latest category fence. The browser that forwards records is
 * not trusted, so everything the agent would refuse must be refused here too.
 */

const MIGRATION = 'supabase/migrations/20261207091000_translation_retirement_diagnostics.sql';
const USER = '33000000-0000-4000-8000-000000000001';
const OTHER = '33000000-0000-4000-8000-000000000002';
const INSTALLATION = '33000000-0000-4000-8000-0000000000a1';
const INSTANCE = '33000000-0000-4000-8000-0000000000b1';
const RESTARTED = '33000000-0000-4000-8000-0000000000b2';
const RECOVERY_INSTANCE = '33000000-0000-4000-8000-0000000000b3';

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

  it('accepts a bounded stitcher recovery reason', async () => {
    const result = await ingest(
      [
        record(1, {
          category: 'stitcher',
          code: 'body_recovery_completed',
          props: {
            reason: 'audio_profile_unknown',
            runId: '00000000-0000-4000-8000-000000000031'
          }
        })
      ],
      { instance: RECOVERY_INSTANCE }
    );
    expect(result).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
  });

  it('preserves correlated stitch timings and cache outcomes for remote diagnosis', async () => {
    const props = {
      runId: '00000000-0000-4000-8000-000000000032',
      stage: 'body',
      durationBucket: 'under_10s',
      fromCache: true
    };
    const result = await ingest(
      [
        record(2, {
          category: 'stitcher',
          code: 'pipeline_stage_started',
          props: { runId: props.runId, stage: 'body' }
        }),
        record(3, { category: 'stitcher', code: 'pipeline_stage_completed', props })
      ],
      { instance: RECOVERY_INSTANCE }
    );
    expect(result).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    const rows = await harness.root<{ props: unknown }>(
      'select props from public.agent_journal_records where agent_instance_id = $1 and seq = 3',
      [RECOVERY_INSTANCE]
    );
    expect(rows[0]?.props).toEqual(props);
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

it('round-trips actual original attempts through the journal sanitizer, ingestion and read-only inspect', async () => {
  const log = new DiagnosticsLog({ now: () => Date.now() - 1000 });
  const flow = randomUUID();
  const attempts: string[] = [];
  const outcomes = ['success', 'failure', 'cancelled', 'interrupted'] as const;
  for (const outcome of outcomes) {
    const attempt = randomUUID();
    attempts.push(attempt);
    const producer = new TranscriptionAttemptJournal(flow, attempt, (code, props) => {
      log.record('transcription', code, props);
    });
    producer.stage('extract');
    producer.stage('transcribe');
    if (outcome === 'success') {
      for (let i = 0; i < 20; i++) {
        producer.stage('recover');
        producer.stage('transcribe');
      }
      producer.stage('saved');
    }
    producer.terminal(
      outcome,
      outcome === 'failure' ? 'TRANSCRIBE_FAILED' : outcome === 'interrupted' ? 'INTERRUPTED' : null
    );
  }
  const unfinished = randomUUID();
  attempts.push(unfinished);
  new TranscriptionAttemptJournal(flow, unfinished, (code, props) => {
    log.record('transcription', code, props);
  }).stage('extract');
  const records = log.since(0);
  const instance = randomUUID();
  expect(await ingest(records, { instance })).toEqual({
    accepted: records.length,
    duplicates: 0,
    rejected: []
  });
  expect(await ingest(records, { instance })).toEqual({
    accepted: 0,
    duplicates: records.length,
    rejected: []
  });
  setQueryExecutor((sql, params) => harness.root(sql, params));
  try {
    for (const [index, attempt] of attempts.entries()) {
      const inspected = await getInspect(attempt, new Date().toISOString());
      expect(inspected.found).toBe(true);
      if (!inspected.found) throw new Error('MISSING_NATIVE_ATTEMPT');
      expect(inspected.transcription_original?.attempts[0]?.outcome).toBe(
        outcomes[index] ?? 'unknown'
      );
      expect(inspected.stages.missing).toContain('result_visible');
      expect(inspected.terminal).toBeNull();
    }
    const flowInspection = await getInspect(flow, new Date().toISOString());
    expect(flowInspection.found && flowInspection.transcription_original?.attempts).toHaveLength(5);
  } finally {
    setQueryExecutor(null);
  }
});

it('delivers a safe native process failure through journal ingestion to the read-only CLI', async () => {
  const instance = randomUUID();
  const operationId = randomUUID();
  const log = new DiagnosticsLog({ now: () => Date.now() - 1000 });
  const props = {
    operationId,
    tool: 'restitch',
    stage: 'uploading',
    outcome: 'failed',
    errorCode: 'SOURCE_CHANGED'
  };
  expect(log.record('team', 'process_terminal', props)).toBe(true);
  expect(await ingest(log.since(0), { instance })).toEqual({
    accepted: 1,
    duplicates: 0,
    rejected: []
  });
  setQueryExecutor((sql, params) => harness.root(sql, params));
  try {
    const evidence = await getJournal(instance, {
      token: 'all',
      start: null,
      end: new Date(Date.now() + 1000).toISOString(),
      label: 'all'
    });
    expect(evidence.available).toBe(true);
    expect(evidence.records[0]).toMatchObject({
      category: 'team',
      code: 'process_terminal',
      props
    });
  } finally {
    setQueryExecutor(null);
  }
});

it('retains empty native claim evidence through the privacy fence, ingestion and read-only CLI', async () => {
  const instance = randomUUID();
  const props = { team_id: randomUUID(), delegation_id: randomUUID(), request_id: randomUUID() };
  const log = new DiagnosticsLog({ now: () => Date.now() - 1000 });
  expect(log.record('team', 'recovery_empty_claim', props)).toBe(true);
  expect(await ingest(log.since(0), { instance })).toEqual({
    accepted: 1,
    duplicates: 0,
    rejected: []
  });
  setQueryExecutor((sql, params) => harness.root(sql, params));
  try {
    const evidence = await getJournal(instance, {
      token: 'all',
      start: null,
      end: new Date(Date.now() + 1000).toISOString(),
      label: 'all'
    });
    expect(evidence.records[0]).toMatchObject({
      category: 'team',
      code: 'recovery_empty_claim',
      props
    });
  } finally {
    setQueryExecutor(null);
  }
});

it('retains a pre-claim executor refusal and installed version through SQL ingestion and the read-only journal CLI', async () => {
  const instance = randomUUID();
  const props = {
    team_id: randomUUID(),
    delegation_id: randomUUID(),
    request_id: randomUUID(),
    stage: 'blocked',
    reason: 'needs_agent_setup',
    error_code: 'AGENT_UPDATE_REQUIRED',
    restitch_contract_version: 2
  };
  const log = new DiagnosticsLog({ now: () => Date.now() - 1000 });
  expect(log.record('team', 'recovery_state', props)).toBe(true);
  expect(await ingest(log.since(0), { instance })).toEqual({
    accepted: 1,
    duplicates: 0,
    rejected: []
  });
  let chain: Promise<unknown> = Promise.resolve();
  setQueryExecutor((sql, params) => {
    const read = chain.then(async () => {
      await harness.db.exec('begin read only;set local role wishly_analytics_ro');
      try {
        const result = await harness.db.query(sql, params);
        await harness.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (error) {
        await harness.db.exec('rollback');
        throw error;
      }
    });
    chain = read.catch(() => {});
    return read;
  });
  try {
    const evidence = await getJournal(instance, {
      token: 'all',
      start: null,
      end: new Date(Date.now() + 1000).toISOString(),
      label: 'all'
    });
    expect(evidence.records[0]).toMatchObject({ category: 'team', code: 'recovery_state', props });
    expect(JSON.stringify(evidence)).not.toContain('operationCredential');
  } finally {
    await chain;
    setQueryExecutor(null);
  }
});

it('diagnoses actual corrupt source bytes before the tool through sanitizer, ingestion and SELECT-only inspect', async () => {
  const instance = randomUUID(),
    operationId = randomUUID();
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-integrity-ingest-'));
  const log = new DiagnosticsLog({ now: () => Date.now() - 1000 });
  const previous = activeDiagnosticsLogOrNull();
  const sourceChecksum = createHash('md5').update('good').digest('hex');
  const transfer = new TeamTransferClient({
    temporaryRoot: root,
    fetchImpl: async () =>
      new Response('evil', {
        headers: {
          'content-length': '4',
          'x-wishly-source-version': 'accepted',
          'x-wishly-source-checksum': sourceChecksum
        }
      })
  });
  const delegate = vi.fn();
  const upload = vi.spyOn(transfer, 'uploadResult');
  const events = new TeamOperationEvents();
  const bridge = new TeamProcessBridge({ transfer, delegates: { compressor: delegate }, events });
  const grant = {
    purpose: 'process_input' as const,
    ticket: 'synthetic-grant-with-enough-entropy',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxUses: 1,
    maxRangeBytes: 4
  };
  let chain: Promise<unknown> = Promise.resolve();
  setActiveDiagnosticsLog(log);
  try {
    await expect(
      bridge.process({
        operationId,
        toolId: 'compressor',
        options: { mode: 'optimal' },
        sourceGrant: grant,
        finalizeGrant: { ...grant, purpose: 'finalize' },
        transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops'
      })
    ).rejects.toThrow('SOURCE_CHANGED');
    expect(delegate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(events.snapshot().operations).toEqual([
      expect.objectContaining({ operationId, state: 'failed', errorCode: 'SOURCE_CHANGED' })
    ]);
    const records = log.since(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'team',
      code: 'process_terminal',
      props: {
        operationId,
        stage: 'downloading',
        errorCode: 'SOURCE_CHANGED',
        sourceIntegrityReason: 'checksum_mismatch'
      }
    });
    expect(JSON.stringify(records)).not.toContain(sourceChecksum);
    expect(await ingest(records, { instance })).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: []
    });
    setQueryExecutor((sql, params) => {
      assertReadOnlySql(sql);
      const read = chain.then(async () => {
        await harness.db.exec('begin read only;set local role wishly_analytics_ro');
        try {
          const result = await harness.db.query(sql, params);
          await harness.db.exec('commit');
          return result.rows as Record<string, unknown>[];
        } catch (error) {
          await harness.db.exec('rollback');
          throw error;
        }
      });
      chain = read.catch(() => {});
      return read;
    });
    const result = await getInspect(operationId, new Date(Date.now() + 1000).toISOString());
    expect(result.found).toBe(true);
    if (!result.found) throw new Error('MISSING_SOURCE_DIAGNOSIS');
    expect(result.team_native?.records[0]).toMatchObject({
      stage: 'downloading',
      error_code: 'SOURCE_CHANGED',
      source_integrity_reason: 'checksum_mismatch'
    });
    expect(result.stages.missing).toContain('result_visible');
    expect(JSON.stringify(result)).not.toContain(sourceChecksum);
  } finally {
    await chain;
    setQueryExecutor(null);
    setActiveDiagnosticsLog(previous);
    await removeTemporaryDirectory(root);
  }
});
