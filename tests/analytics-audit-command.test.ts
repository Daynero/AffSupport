import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { formatAudit } from '../scripts/analytics/format';
import { resolvePeriod } from '../scripts/analytics/periods';
import { findingId, getAudit } from '../scripts/analytics/queries';
import type { AuditArtifact, AuditData, ResolvedPeriod } from '../scripts/analytics/types';

/**
 * 031 T018 — `audit` compares the coverage registry with one period of
 * events: covered / partial / uncovered / declared_but_never_emitted, orphan
 * starts, unknown codes, delivery counters, builds without link coverage, and
 * findings whose ids survive a re-run on the same snapshot (SC-017).
 */

let db: AnalyticsTestDb;
let ALL: ResolvedPeriod;
const SNAPSHOT = '2026-10-10T00:00:00.000Z';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN_OK = '20000000-0000-4000-8000-000000000001';
const RUN_ORPHAN = '20000000-0000-4000-8000-000000000002';
const RUN_STITCH = '20000000-0000-4000-8000-000000000003';
const FLOW_LINK = '30000000-0000-4000-8000-000000000001';
const tempDirs: string[] = [];

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_events
      (user_id, event_name, tool, run_id, flow_id, web_build_id, error_code, error_stage, properties, occurred_at, created_at)
    values
      -- compressor.run: one run reaches its terminal, one never does.
      ('${ALICE}','tool_opened','compressor',null,null,'1.2.5',null,null,'{"tool_identifier":"compressor"}','2026-10-01T10:00:00Z','2026-10-01T10:00:00.200Z'),
      -- readiness after the open (031 T009): with it the capability has every stage.
      ('${ALICE}','tool_ready','compressor',null,null,'1.2.5',null,null,'{"tool_identifier":"compressor","outcome":"success","duration_ms":120}','2026-10-01T10:00:01Z','2026-10-01T10:00:01.200Z'),
      ('${ALICE}','compression_started','compressor','${RUN_OK}',null,'1.2.5',null,null,'{}','2026-10-01T10:01:00Z','2026-10-01T10:01:00.200Z'),
      ('${ALICE}','compression_completed','compressor','${RUN_OK}',null,'1.2.5',null,null,'{}','2026-10-01T10:02:00Z','2026-10-01T10:02:00.200Z'),
      ('${ALICE}','compression_started','compressor','${RUN_ORPHAN}',null,'1.2.5',null,null,'{}','2026-10-01T10:03:00Z','2026-10-01T10:03:00.200Z'),
      -- a failure with no code or stage: an unknown-code finding for the compressor.
      ('${BOB}','compression_failed','compressor',null,null,'1.2.4',null,null,'{"error_category":"network"}','2026-10-01T10:04:00Z','2026-10-01T10:04:00.200Z'),
      -- stitcher.run: a start without any terminal -> partial.
      ('${BOB}','operation_started','stitcher','${RUN_STITCH}',null,'1.2.5',null,null,'{"file_count":1}','2026-10-02T09:00:00Z','2026-10-02T09:00:00.200Z'),
      -- a fully coded error for the stitcher: no unknown-code finding there.
      ('${BOB}','error_occurred','stitcher','${RUN_STITCH}',null,'1.2.5','NATIVE_PICKER_TIMEOUT','picker','{}','2026-10-02T09:00:30Z','2026-10-02T09:00:30.200Z'),
      -- link.check: start and terminal correlated by flow_id on the new build.
      ('${ALICE}','link_check_started',null,null,'${FLOW_LINK}','1.2.5',null,null,'{"link_trigger":"boot"}','2026-10-03T08:00:00Z','2026-10-03T08:00:00.200Z'),
      ('${ALICE}','link_check_completed',null,null,'${FLOW_LINK}','1.2.5',null,null,'{"outcome":"success"}','2026-10-03T08:00:01Z','2026-10-03T08:00:01.200Z'),
      -- an old web build with no link event at all.
      ('${BOB}','home_viewed',null,null,null,'1.2.4',null,null,'{}','2026-10-03T08:10:00Z','2026-10-03T08:10:00.200Z'),
      -- team.file_ops correlated through the attempt_id property.
      ('${ALICE}','team_file_attempt_started',null,null,null,'1.2.5',null,null,'{"attempt_id":"att_01","action":"upload"}','2026-10-04T08:00:00Z','2026-10-04T08:00:00.200Z'),
      ('${ALICE}','team_file_attempt_completed',null,null,null,'1.2.5',null,null,'{"attempt_id":"att_01","action":"upload","outcome":"success"}','2026-10-04T08:00:05Z','2026-10-04T08:00:05.200Z'),
      -- two delivery reports from the (pending) producer.
      ('${ALICE}','analytics_delivery_report',null,null,null,'1.2.5',null,null,'{"rejected_count":3,"evicted_count":1,"expired_count":0,"rejected_events":"estimate_started,tool_impression","evicted_events":"tool_impression"}','2026-10-05T08:00:00Z','2026-10-05T08:00:00.200Z'),
      ('${BOB}','analytics_delivery_report',null,null,null,'1.2.5',null,null,'{"rejected_count":2,"evicted_count":0,"expired_count":4,"rejected_events":"tool_impression"}','2026-10-05T09:00:00Z','2026-10-05T09:00:00.200Z'),
      -- after the snapshot: must not change a pinned audit.
      ('${ALICE}','compression_completed','compressor','${RUN_ORPHAN}',null,'1.2.5',null,null,'{}','2026-10-11T10:00:00Z','2026-10-11T10:00:00.200Z');

    insert into public.analytics_catalog_sync_jobs (created_at, updated_at) values
      ('2026-10-02T00:00:00Z','2026-10-02T00:00:00Z'),
      ('2026-10-20T00:00:00Z','2026-10-20T00:00:00Z');
  `);
  ALL = resolvePeriod('all', undefined, SNAPSHOT);
}, 30_000);

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capability(data: AuditData, id: string) {
  const found = data.capabilities.find(row => row.id === id);
  if (!found) throw new Error(`capability ${id} missing from audit`);
  return found;
}

describe('audit · capability status', () => {
  it('marks a start that meets its terminal by id as covered and counts the orphan', async () => {
    const data = await getAudit(ALL);
    const compressor = capability(data, 'compressor.run');
    expect(compressor).toMatchObject({
      status: 'covered',
      missing: [],
      samples: 2,
      orphan_starts: 1,
      correlated_pairs: 1,
      producer_status: 'emitted'
    });
    expect(capability(data, 'link.check')).toMatchObject({
      status: 'covered',
      orphan_starts: 0,
      correlated_pairs: 1
    });
    expect(capability(data, 'team.file_ops')).toMatchObject({
      status: 'covered',
      correlated_pairs: 1
    });
  });

  it('lists the missing stages of a partial capability', async () => {
    const data = await getAudit(ALL);
    const stitcher = capability(data, 'stitcher.run');
    expect(stitcher.status).toBe('partial');
    expect(stitcher.missing).toContain('terminal');
    expect(stitcher.samples).toBe(1);
  });

  it('calls a capability with no events uncovered, and has no declared-but-unemitted metric input (SC-004)', async () => {
    const data = await getAudit(ALL);
    expect(capability(data, 'team.tasks')).toMatchObject({
      status: 'uncovered',
      producer_status: 'unsupported_by_producer',
      samples: 0
    });
    expect(capability(data, 'transcription.run')).toMatchObject({
      status: 'uncovered',
      producer_status: 'emitted',
      // `tool_ready` has a producer since 031 T009, so its absence is a missing stage too.
      missing: ['start', 'terminal', 'readiness']
    });
    // 033 T008 gave `team_preview_completed` a producer: no rows yet reads as uncovered, not
    // as a contract nobody emits.
    expect(capability(data, 'team.preview')).toMatchObject({
      status: 'uncovered',
      producer_status: 'emitted',
      missing: ['start', 'terminal']
    });
    expect(data.summary.declared_but_never_emitted).toBe(0);
    expect(data.registry_size).toBe(data.capabilities.length);
  });

  it('reads the authoritative sync table instead of events for team.sync', async () => {
    const data = await getAudit(ALL);
    expect(capability(data, 'team.sync')).toMatchObject({
      status: 'covered',
      source: 'authoritative_table',
      samples: 1
    });
  });
});

describe('audit · probes', () => {
  it('counts unknown error codes and stages per tool', async () => {
    const data = await getAudit(ALL);
    expect(data.unknown_codes).toEqual([
      { tool: 'compressor', errors: 1, unknown_code: 1, unknown_stage: 1 },
      { tool: 'stitcher', errors: 1, unknown_code: 0, unknown_stage: 0 }
    ]);
  });

  it('sums the delivery report counters and splits them by event name', async () => {
    const data = await getAudit(ALL);
    expect(data.delivery).toMatchObject({
      reports: 2,
      rejected: 5,
      evicted: 1,
      expired: 4,
      by_event: [
        { event_name: 'estimate_started', rejected_reports: 1, evicted_reports: 0 },
        { event_name: 'tool_impression', rejected_reports: 2, evicted_reports: 1 }
      ]
    });
  });

  it('names web builds that emit no link event and reports the delivery lag', async () => {
    const data = await getAudit(ALL);
    expect(data.uncovered_builds).toEqual(['1.2.4']);
    expect(data.delivery_lag_ms).toEqual({ p50: 200, p95: 200, samples: 15 });
  });
});

describe('audit · findings', () => {
  it('derives stable ids from capability, status and the sorted missing set', async () => {
    const data = await getAudit(ALL);
    const partial = data.findings.find(
      finding => finding.capability === 'stitcher.run' && finding.status === 'partial'
    );
    expect(partial).toBeDefined();
    const expected = createHash('sha256')
      .update(`stitcher.run|partial|${[...partial!.missing].sort().join(',')}`)
      .digest('hex');
    expect(partial!.id).toBe(expected);
    expect(findingId('stitcher.run', 'partial', partial!.missing)).toBe(expected);

    const statuses = data.findings.map(finding => `${finding.capability}:${finding.status}`);
    expect(statuses).not.toContain('team.preview:declared_but_never_emitted');
    expect(statuses.some(status => status.endsWith(':declared_but_never_emitted'))).toBe(false);
    expect(statuses).toContain('compressor.run:orphan_starts');
    expect(statuses).toContain('compressor:unknown_codes');
    expect(statuses).not.toContain('stitcher:unknown_codes');
    expect(statuses).toContain('link:uncovered_builds');
    expect(statuses).toContain('analytics.delivery:delivery_losses');
    expect(data.findings[0].severity).toBe('high');
  });

  it('is deterministic: the same snapshot yields identical data twice', async () => {
    const first = await getAudit(ALL);
    const second = await getAudit(ALL);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not count rows created after as_of', async () => {
    const later = await getAudit(resolvePeriod('all', undefined, '2026-10-12T00:00:00.000Z'));
    expect(capability(later, 'compressor.run').orphan_starts).toBe(0);
    expect(capability(await getAudit(ALL), 'compressor.run').orphan_starts).toBe(1);
  });
});

describe('audit · command', () => {
  it('writes the artifact only with --write, named after the as-of date, without generated_at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soty-analysis-'));
    tempDirs.push(dir);

    const dry = await executeCommand(parseArgs(['audit', '--period', 'all', '--as-of', SNAPSHOT]), {
      analysisDir: dir
    });
    expect(dry.written).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);

    const written = await executeCommand(
      parseArgs(['audit', '--period', 'all', '--as-of', SNAPSHOT, '--write']),
      { analysisDir: dir }
    );
    const file = join(dir, '2026-10-10.json');
    expect(written.written).toEqual([file]);
    expect(existsSync(file)).toBe(true);
    const artifact = JSON.parse(readFileSync(file, 'utf8')) as AuditArtifact;
    expect(artifact).toMatchObject({ ok: true, command: 'audit', as_of: SNAPSHOT });
    expect(artifact).not.toHaveProperty('generated_at');
    expect(artifact.data).toEqual(written.data);

    // The same snapshot written again is byte-identical (SC-017).
    const before = readFileSync(file, 'utf8');
    await executeCommand(parseArgs(['audit', '--period', 'all', '--as-of', SNAPSHOT, '--write']), {
      analysisDir: dir
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(written.human).toContain('Coverage audit');
    expect(written.human).toContain('declared but never emitted 0');
    expect(formatAudit(written.data as AuditData, written.period, [])).not.toContain('Written:');
  });

  it('returns aggregates only: no user id, email or token in the data', async () => {
    const data = await getAudit(ALL);
    expect(JSON.stringify(data)).not.toMatch(
      /@|bearer|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}/i
    );
  });
});
