import { removeTemporaryDirectory } from './support/temp-dir';
import { mkdtemp, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DiagnosticsLog,
  activeDiagnosticsLogOrNull,
  setActiveDiagnosticsLog
} from '../apps/agent/src/server/diagnostics-log';
import { HevcCompatibility } from '../apps/agent/src/stitcher/hevc-normalize';
import { ffmpegPath, ffprobePath } from '../apps/agent/src/ffmpeg/tools';
import { getInspect } from '../scripts/analytics/queries';
import { getHevcJournalEvidence, diagnoseHevcJournal } from '../scripts/analytics/hevc-journal';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { describeRequiring, requireBinaries } from './support/requires';
import { isForwardableRecord } from '../apps/web/src/analytics/journal-forwarder';
const required = await requireBinaries(ffmpegPath, ffprobePath);
const actor = 'cf560000-0000-4000-8000-000000000001';
const instance = 'cf560000-0000-4000-8000-000000000002';
const op = 'cf560000-0000-4000-8000-000000000003';
let db: TeamTestDb,
  root = '';
let serial: Promise<unknown> = Promise.resolve();
describeRequiring(required, 'HEVC producer-to-read-only diagnosis', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'soty-hevc-journal-'));
    db = await createTeamTestDb();
    await createUser(db, { id: actor, email: 'hevc@synthetic.test' });
    const previous = activeDiagnosticsLogOrNull();
    const journal = new DiagnosticsLog({ file: null });
    setActiveDiagnosticsLog(journal);
    try {
      const source = path.join(root, 'private-original.mp4');
      await copyFile('tests/fixtures/hevc-compatibility/pq10.mp4', source);
      const converter = new HevcCompatibility({ root });
      await converter.prepare({
        sourceFile: source,
        workspace: root,
        runId: op,
        signal: new AbortController().signal,
        threads: 1
      });
      // A new consumer can fail independently after the shared result became ready.
      await converter
        .prepare({
          sourceFile: path.join(root, 'missing-secret-name.mp4'),
          workspace: root,
          runId: 'cf560000-0000-4000-8000-000000000004',
          signal: new AbortController().signal
        })
        .catch(() => {});
      const records = journal.since(0).filter(r => r.code.startsWith('hevc_normalization_'));
      expect(records.every(r => isForwardableRecord(r))).toBe(true);
      expect(new Set(records.map(r => r.code))).toEqual(
        new Set([
          'hevc_normalization_started',
          'hevc_normalization_stage',
          'hevc_normalization_completed',
          'hevc_normalization_failed'
        ])
      );
      expect(JSON.stringify(records)).not.toMatch(
        /private-original|missing-secret|sha256|sourceChecksum/iu
      );
      const rows = await db.asUser<{ result: { accepted: number; rejected: unknown[] } }>(
        actor,
        'select public.ingest_agent_journal(null,$1::uuid,$2::jsonb) as result',
        [instance, JSON.stringify(records)]
      );
      expect(rows[0]?.result).toMatchObject({ accepted: records.length, rejected: [] });
    } finally {
      setActiveDiagnosticsLog(previous);
    }
    setQueryExecutor((sql, params) => {
      assertReadOnlySql(sql);
      const next = serial.then(async () => {
        await db.db.exec('begin read only;set local role wishly_analytics_ro');
        try {
          const r = await db.db.query(sql, params);
          await db.db.exec('commit');
          return r.rows as Record<string, unknown>[];
        } catch (e) {
          await db.db.exec('rollback');
          throw e;
        }
      });
      serial = next.catch(() => {});
      return next;
    });
  }, 30000);
  afterAll(async () => {
    await serial;
    setQueryExecutor(null);
    await db?.close();
    await removeTemporaryDirectory(root);
  });
  it('retains the real local verification chain without claiming catalog delivery', async () => {
    const result = await getInspect(op, new Date(Date.now() + 1000).toISOString());
    expect(result.found).toBe(true);
    expect(result.hevc_compatibility?.consumers).toEqual([
      expect.objectContaining({ operation_id: op, local_outcome: 'ready', from_cache: false })
    ]);
    expect(result.hevc_compatibility?.records.map(r => r.stage)).toEqual([
      'started',
      'cache_check',
      'converting',
      'verifying',
      'ready',
      'ready'
    ]);
    if (!result.found) throw Error('HEVC_EVIDENCE_MISSING');
    expect(result.terminal).toBeNull();
    expect(result.stages.missing).toContain('result_visible');
    const attemptId = result.hevc_compatibility!.consumers[0]!.attempt_id;
    expect(attemptId).toMatch(/^[a-f0-9-]{36}$/u);
    const attempt = await getInspect(attemptId!, new Date(Date.now() + 1000).toISOString());
    expect(attempt.hevc_compatibility?.consumers[0]?.operation_id).toBe(op);
  });
  it('retains source-change cause and marks absent or late records as unknown', async () => {
    const detail = await getHevcJournalEvidence(
      'cf560000-0000-4000-8000-000000000004',
      new Date(Date.now() + 1000).toISOString()
    );
    expect(detail.consumers[0]).toMatchObject({
      local_outcome: 'failed',
      error_code: 'SOURCE_CHANGED',
      reason: 'source_changed'
    });
    const before = await getHevcJournalEvidence(op, '2000-01-01T00:00Z');
    expect(before.consumers).toEqual([]);
    expect(before.blind_spots.join(' ')).toContain('does not prove');
    const shared = (await getHevcJournalEvidence(op, new Date(Date.now() + 1000).toISOString()))
      .consumers[0]!.normalization_ids[0]!;
    expect(
      (await getHevcJournalEvidence(shared, new Date(Date.now() + 1000).toISOString())).consumers[0]
        ?.operation_id
    ).toBe(op);
  });
  it('does not use a completion delivered after the selected as-of cutoff', async () => {
    const asOf = new Date(Date.now() + 1000).toISOString();
    await db.root(
      "update public.agent_journal_records set received_at=now()+interval '1 hour' where agent_instance_id=$1 and code='hevc_normalization_completed'",
      [instance]
    );
    const detail = await getHevcJournalEvidence(op, asOf);
    expect(detail.consumers[0]?.local_outcome).toBe('unknown');
    expect(detail.blind_spots.join(' ')).toContain('delayed');
    expect(detail.records.some(r => r.stage === 'verifying')).toBe(true);
  });
});
it('keeps cancellation separate from a ready peer, and refuses a terminal from a truncated/retried chain', () => {
  const rows = [
    {
      category: 'stitcher',
      code: 'hevc_normalization_failed',
      props: {
        operationId: op,
        normalizationId: instance,
        reason: 'cancelled',
        errorCode: 'PROCESS_CANCELED'
      },
      agent_instance_id: instance,
      seq: 1,
      recorded_at: '2026-11-13T10:00Z'
    },
    {
      category: 'stitcher',
      code: 'hevc_normalization_completed',
      props: { operationId: actor, normalizationId: instance, fromCache: false },
      agent_instance_id: instance,
      seq: 2,
      recorded_at: '2026-11-13T10:01Z'
    }
  ];
  expect(diagnoseHevcJournal(rows, true).consumers.map(c => c.local_outcome)).toEqual([
    'cancelled',
    'ready'
  ]);
  expect(diagnoseHevcJournal(rows, true, true).consumers.map(c => c.local_outcome)).toEqual([
    'unknown',
    'unknown'
  ]);
  expect(
    diagnoseHevcJournal([...rows, { ...rows[1]!, props: { operationId: op }, seq: 3 }], true)
      .consumers[0]?.local_outcome
  ).toBe('unknown');
  expect(diagnoseHevcJournal([], false).blind_spots).toContain(
    'Native journal source unavailable.'
  );
});
it('does not reuse an earlier terminal for a later or unfinished preparation of the same operation', () => {
  const base = {
    category: 'stitcher',
    agent_instance_id: instance,
    recorded_at: '2026-11-13T10:00Z'
  };
  const old = { ...base, code: 'hevc_normalization_completed', seq: 1, props: { operationId: op } };
  const restarted = {
    ...base,
    code: 'hevc_normalization_started',
    seq: 2,
    props: { operationId: op }
  };
  expect(diagnoseHevcJournal([old, restarted], true).consumers[0]?.local_outcome).toBe('unknown');
  const separate = [
    { ...old, props: { operationId: op, attemptId: actor } },
    { ...restarted, props: { operationId: op, attemptId: instance } },
    {
      ...base,
      seq: 3,
      code: 'hevc_normalization_stage',
      props: { operationId: op, attemptId: instance, stage: 'converting' }
    }
  ];
  const detail = diagnoseHevcJournal(separate, true);
  expect(detail.consumers.map(c => c.local_outcome)).toEqual(['ready', 'unknown']);
  expect(detail.records.at(-1)?.stage).toBe('converting');
  const interleaved = diagnoseHevcJournal([separate[2]!, separate[0]!, separate[1]!], true);
  expect(interleaved.records.map(r => r.seq)).toEqual([1, 2, 3]);
});
