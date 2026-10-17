import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { compareVersions } from '../scripts/analytics/investigate';
import {
  buildCommandEnvelope,
  investigateOutputIsPrivate,
  type InvestigateData,
  type InvestigateFinding
} from '../scripts/analytics/types';

/**
 * 033 T009 / SC-001 — `investigate` on the control set: a failed transcription with a code, a
 * link loss with a manual recovery and one without, a picker failure in the agent journal
 * around a stitcher failure without a code, a stale agent, and a user with no events. Each
 * case must come out with the right kind of finding, stage, code and file, or with
 * "insufficient" and the blind spot named.
 */

const AS_OF = '2026-10-09T00:00:00Z';

const U_TRANS = '0a000000-0000-4000-8000-000000000001';
const U_LINK = '0a000000-0000-4000-8000-000000000002';
const U_STITCH = '0a000000-0000-4000-8000-000000000003';
const U_STALE = '0a000000-0000-4000-8000-000000000004';
const U_EMPTY = '0a000000-0000-4000-8000-000000000005';
const U_COPY = '0a000000-0000-4000-8000-000000000006';
const U_ORDER = '0a000000-0000-4000-8000-000000000007';
const COPY_CONFIRMED = '6a000000-0000-4000-8000-000000000001';
const COPY_UNKNOWN = '6a000000-0000-4000-8000-000000000002';
const ORDER_CONFIRMED = '6b000000-0000-4000-8000-000000000001';
const ORDER_UNKNOWN = '6b000000-0000-4000-8000-000000000002';
const ORDER_CONFLICT = '6b000000-0000-4000-8000-000000000003';
const ARCHIVE_CONFIRMED = '6f000000-0000-4000-8000-000000000001';
const ARCHIVE_UNKNOWN = '6f000000-0000-4000-8000-000000000002';
const ARCHIVE_BLOCKED = '6f000000-0000-4000-8000-000000000003';
const BULK_PARTIAL = '6c000000-0000-4000-8000-000000000001';
const BULK_UNKNOWN = '6c000000-0000-4000-8000-000000000002';

const INST_T = '1b000000-0000-4000-8000-000000000001';
const INST_L = '1b000000-0000-4000-8000-000000000002';
const INST_S = '1b000000-0000-4000-8000-000000000003';
const INST_O = '1b000000-0000-4000-8000-000000000004';

const AGENT_T = '2c000000-0000-4000-8000-000000000001';
const AGENT_S = '2c000000-0000-4000-8000-000000000003';

const RUN_T = '3d000000-0000-4000-8000-000000000001';
const RUN_S = '3d000000-0000-4000-8000-000000000003';
const RUN_OK = '3d000000-0000-4000-8000-000000000009';
const FLOW_L1 = '4e000000-0000-4000-8000-000000000001';
const FLOW_L2 = '4e000000-0000-4000-8000-000000000002';
const SESSION_T = '5f000000-0000-4000-8000-000000000001';

let db: AnalyticsTestDb;
let seq = 0;

interface Ev {
  user: string;
  name: string;
  at: string;
  /** Defaults to `at` + 200 ms. */
  created?: string;
  tool?: string;
  run?: string;
  flow?: string;
  installation?: string;
  session?: string;
  agent?: string;
  version?: string;
  web?: string;
  code?: string;
  stage?: string;
  fingerprint?: string;
  outcome?: string;
  props?: Record<string, unknown>;
}

const sql = (value: string | undefined) => (value === undefined ? 'null' : `'${value}'`);

function insertEvents(events: Ev[]): string {
  const rows = events.map(ev => {
    seq += 1;
    const created = ev.created ?? new Date(Date.parse(ev.at) + 200).toISOString();
    return `(${[
      sql(ev.user),
      `'${ev.name}'`,
      sql(ev.tool),
      sql(ev.run),
      sql(ev.flow),
      sql(ev.installation),
      sql(ev.session),
      sql(ev.agent),
      ev.agent ? `'macos'` : 'null',
      sql(ev.version),
      sql(ev.web ?? '1.2.6'),
      `'macos'`,
      sql(ev.code),
      sql(ev.stage),
      sql(ev.fingerprint),
      sql(ev.outcome),
      `'${JSON.stringify(ev.props ?? {})}'`,
      `'${ev.at}'`,
      `'${created}'`,
      `'60000000-0000-4000-8000-${String(seq).padStart(12, '0')}'`,
      String(seq)
    ].join(', ')})`;
  });
  return `insert into public.analytics_events
    (user_id, event_name, tool, run_id, flow_id, installation_id, session_id, agent_instance_id,
     agent_platform, local_app_version, web_build_id, platform, error_code, error_stage,
     error_fingerprint, outcome, properties, occurred_at, created_at, event_id, session_sequence)
    values ${rows.join(',\n')};`;
}

interface Rec {
  user: string;
  installation: string;
  agent: string;
  seq: number;
  at: string;
  received?: string;
  category: string;
  code: string;
  props?: Record<string, unknown>;
}

function insertJournal(records: Rec[]): string {
  const rows = records.map(
    r =>
      `('${r.user}', '${r.installation}', '${r.agent}', ${r.seq}, '${r.at}', '${
        r.received ?? new Date(Date.parse(r.at) + 5000).toISOString()
      }', '${r.category}', '${r.code}', '${JSON.stringify(r.props ?? {})}')`
  );
  return `insert into public.agent_journal_records
    (user_id, installation_id, agent_instance_id, seq, recorded_at, received_at, category, code, props)
    values ${rows.join(',\n')};`;
}

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_users (id, email, email_normalized, last_seen_at, last_login_at) values
      ('${U_TRANS}', 'trans@example.test', 'trans@example.test', '2026-10-05T10:05:00Z', '2026-10-05T09:00:00Z'),
      ('${U_LINK}', 'link@example.test', 'link@example.test', '2026-10-06T10:00:00Z', null),
      ('${U_STITCH}', 'stitch@example.test', 'stitch@example.test', '2026-10-07T10:00:00Z', null),
      ('${U_STALE}', 'stale@example.test', 'stale@example.test', '2026-10-07T10:00:00Z', null),
      ('${U_EMPTY}', 'empty@example.test', 'empty@example.test', '2026-10-08T10:00:00Z', null),
      ('${U_COPY}', 'copy@example.test', 'copy@example.test', '2026-10-08T10:00:00Z', null),
      ('${U_ORDER}', 'order@example.test', 'order@example.test', '2026-10-08T10:00:00Z', null);
  `);

  const T = {
    user: U_TRANS,
    installation: INST_T,
    session: SESSION_T,
    agent: AGENT_T,
    version: '1.2.6'
  };
  const L = { user: U_LINK, installation: INST_L, version: '1.2.6' };
  const S = { user: U_STITCH, installation: INST_S, agent: AGENT_S, version: '1.2.6' };
  const O = { user: U_STALE, installation: INST_O, version: '1.2.3', web: '1.2.3' };

  await db.exec(
    insertEvents([
      // (a) transcription failed with MODEL_MISSING; the page also failed its first read once.
      { ...T, name: 'tool_opened', tool: 'transcription', at: '2026-10-05T09:59:00Z' },
      {
        ...T,
        name: 'tool_ready',
        tool: 'transcription',
        at: '2026-10-05T09:59:05Z',
        outcome: 'failure',
        stage: 'initial_read',
        code: 'CONNECTION_FAILED'
      },
      {
        ...T,
        name: 'operation_started',
        tool: 'transcription',
        run: RUN_T,
        at: '2026-10-05T10:00:00Z',
        // A path smuggled into a property must never come out.
        props: { path: '/Users/someone/Private/interview.mp4', video_count: 1 }
      },
      {
        ...T,
        name: 'error_occurred',
        tool: 'transcription',
        run: RUN_T,
        at: '2026-10-05T10:01:00Z',
        code: 'MODEL_MISSING',
        stage: 'model',
        fingerprint: 'transcription:model:MODEL_MISSING',
        outcome: 'failure'
      },
      {
        ...T,
        name: 'operation_failed',
        tool: 'transcription',
        run: RUN_T,
        at: '2026-10-05T10:01:00.500Z',
        outcome: 'failure'
      },
      // A successful compression is not an operation to report.
      {
        ...T,
        name: 'compression_started',
        tool: 'compressor',
        run: RUN_OK,
        at: '2026-10-05T11:00:00Z'
      },
      {
        ...T,
        name: 'compression_completed',
        tool: 'compressor',
        run: RUN_OK,
        at: '2026-10-05T11:02:00Z',
        outcome: 'success'
      },

      // (b) link: one loss recovered by hand, one never recovered (by the as-of), two pairing rejections.
      {
        ...L,
        name: 'link_check_started',
        flow: FLOW_L1,
        at: '2026-10-06T08:00:00Z',
        props: { link_origin: 'hosted', browser_family: 'safari' }
      },
      {
        ...L,
        name: 'link_lost',
        flow: FLOW_L1,
        at: '2026-10-06T08:10:00Z',
        props: { link_transport: 'stream' }
      },
      {
        ...L,
        name: 'link_recovered',
        flow: FLOW_L1,
        at: '2026-10-06T08:10:42Z',
        props: {
          duration_ms: 42000,
          recovery_mode: 'manual',
          instance_changed: false,
          token_changed: false
        }
      },
      {
        ...L,
        name: 'link_check_completed',
        flow: FLOW_L1,
        at: '2026-10-06T08:20:00Z',
        outcome: 'failure',
        props: { link_reason: 'pairing_rejected', link_stage: 'token', outcome: 'failure' }
      },
      {
        ...L,
        name: 'link_check_completed',
        flow: FLOW_L1,
        at: '2026-10-06T08:21:00Z',
        outcome: 'failure',
        props: { link_reason: 'pairing_rejected', link_stage: 'token', outcome: 'failure' }
      },
      {
        ...L,
        name: 'link_lost',
        flow: FLOW_L2,
        at: '2026-10-06T09:00:00Z',
        props: { link_transport: 'request', link_reason: 'not_running' }
      },
      // Arrives after the as-of instant: a pinned investigation must not see the recovery.
      {
        ...L,
        name: 'link_recovered',
        flow: FLOW_L2,
        at: '2026-10-06T09:05:00Z',
        created: '2026-10-10T00:00:00Z',
        props: { duration_ms: 300000, recovery_mode: 'auto' }
      },

      // (c) stitcher failed without a code while the native picker failed.
      { ...S, name: 'operation_started', tool: 'stitcher', run: RUN_S, at: '2026-10-07T09:00:00Z' },
      {
        ...S,
        name: 'error_occurred',
        tool: 'stitcher',
        run: RUN_S,
        at: '2026-10-07T09:01:00Z',
        code: 'unknown',
        stage: 'stitch',
        fingerprint: 'stitcher:stitch:unknown',
        outcome: 'failure'
      },
      {
        ...S,
        name: 'operation_failed',
        tool: 'stitcher',
        run: RUN_S,
        at: '2026-10-07T09:01:00.200Z',
        outcome: 'failure'
      },

      // (d) a stale agent.
      { ...O, name: 'tool_opened', tool: 'compressor', at: '2026-10-07T10:00:00Z' }
    ])
  );

  await db.exec(
    insertJournal([
      // Far from any failure: never cited.
      {
        user: U_TRANS,
        installation: INST_T,
        agent: AGENT_T,
        seq: 1,
        at: '2026-10-05T08:00:00Z',
        category: 'boot',
        code: 'listening'
      },
      // Within ±2 min of the transcription failure: cited around it.
      {
        user: U_TRANS,
        installation: INST_T,
        agent: AGENT_T,
        seq: 2,
        at: '2026-10-05T10:00:30Z',
        category: 'spawn',
        code: 'started',
        props: { tool: 'ffmpeg' }
      },
      {
        user: U_STITCH,
        installation: INST_S,
        agent: AGENT_S,
        seq: 1,
        at: '2026-10-07T09:00:20Z',
        category: 'picker',
        code: 'launch',
        props: { kind: 'file', platform: 'macos' }
      },
      {
        user: U_STITCH,
        installation: INST_S,
        agent: AGENT_S,
        seq: 2,
        at: '2026-10-07T09:00:40Z',
        category: 'picker',
        code: 'exit',
        // Two values the server fence would have refused, stored here by hand.
        props: {
          kind: 'file',
          outcome: 'failed',
          chosen: 0,
          note: 'Bearer abc',
          where: '/Users/a/b.mov'
        }
      }
    ])
  );

  await db.exec(`
    insert into public.analytics_catalog_sync_jobs
      (team_id, connection_id, owner_email_normalized, state, last_error_code, error_detail, created_at, updated_at)
    values
      ('7a000000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001',
       'trans@example.test', 'failed', 'DRIVE_FORBIDDEN', 'secret detail', '2026-10-04T00:00:00Z', '2026-10-04T01:00:00Z');
  `);
  await db.exec(
    insertEvents([
      {
        user: U_COPY,
        name: 'team_workflow_started',
        at: '2026-10-08T10:00:00Z',
        props: { action: 'copy', workflow_id: COPY_CONFIRMED, category: 'other' }
      },
      {
        user: U_COPY,
        name: 'team_workflow_started',
        at: '2026-10-08T10:01:00Z',
        props: { action: 'copy', workflow_id: COPY_UNKNOWN, category: 'other' }
      }
    ])
  );
  await db.exec(`insert into public.analytics_task_copy_receipts
    (actor_id, request_id, result_count, created_at) values
    ('${U_COPY}', '${COPY_CONFIRMED}', 2, '2026-10-08T10:00:01Z')`);
  await db.exec(
    insertEvents([
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:00:00Z',
        props: { action: 'reorder', workflow_id: ORDER_CONFIRMED }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_completed',
        at: '2026-10-08T11:00:01Z',
        outcome: 'success',
        props: { action: 'reorder', workflow_id: ORDER_CONFIRMED }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:01:00Z',
        props: { action: 'reorder', workflow_id: ORDER_UNKNOWN }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:02:00Z',
        props: { action: 'reorder', workflow_id: ORDER_CONFLICT }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_completed',
        at: '2026-10-08T11:02:01Z',
        outcome: 'blocked',
        props: { action: 'reorder', workflow_id: ORDER_CONFLICT }
      }
    ])
  );
  await db.exec(`insert into public.analytics_account_order_receipts
    (actor_id, request_id, scope_kind, result_version, created_at) values
    ('${U_ORDER}', '${ORDER_CONFIRMED}', 'socials', 5, '2026-10-08T11:00:01Z')`);
  await db.exec(
    insertEvents([
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:10:00Z',
        props: { action: 'archive', workflow_id: ARCHIVE_CONFIRMED }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_completed',
        at: '2026-10-08T11:10:01Z',
        outcome: 'success',
        props: { action: 'archive', workflow_id: ARCHIVE_CONFIRMED }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:11:00Z',
        props: { action: 'restore', workflow_id: ARCHIVE_UNKNOWN }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T11:12:00Z',
        props: { action: 'archive', workflow_id: ARCHIVE_BLOCKED }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_completed',
        at: '2026-10-08T11:12:01Z',
        outcome: 'blocked',
        props: { action: 'archive', workflow_id: ARCHIVE_BLOCKED, archive_reason: 'active_launch' }
      }
    ])
  );
  await db.exec(`insert into public.analytics_account_archive_receipts
    (actor_id, request_id, desired_archived, result_version, created_at) values
    ('${U_ORDER}', '${ARCHIVE_CONFIRMED}', true, 1, '2026-10-08T11:10:01Z')`);
  await db.exec(
    insertEvents([
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T12:00:00Z',
        props: { action: 'trash', workflow_id: BULK_PARTIAL, item_count: 3 }
      },
      {
        user: U_ORDER,
        name: 'team_workflow_started',
        at: '2026-10-08T12:01:00Z',
        props: { action: 'trash', workflow_id: BULK_UNKNOWN, item_count: 2 }
      }
    ])
  );
  await db.exec(`insert into public.analytics_bulk_trash_receipts
    (actor_id,request_id,group_id,item_count,queued_count,active_count,confirmed_count,
     failed_count,unknown_count,error_codes,created_at,last_operation_at) values
    ('${U_ORDER}','${BULK_PARTIAL}','6d000000-0000-4000-8000-000000000001',
     3,0,0,1,1,1,array['PROVIDER_FAILURE'],'2026-10-08T12:00:00Z','2026-10-08T12:00:02Z')`);
  await db.exec(`insert into public.analytics_task_orphan_receipts
    (actor_id,intent_id,detached_at,cleanup_not_before,state,reason_code,
     attempt_count,updated_at,has_operation) values
    ('${U_ORDER}','6e000000-0000-4000-8000-000000000001',
     '2026-10-08T13:00:00Z','2026-10-08T13:00:30Z',
     'cleanup_unverified','PROVENANCE_UNKNOWN',0,'2026-10-08T13:00:00Z',false),
    ('${U_ORDER}','6e000000-0000-4000-8000-000000000002',
     '2026-10-08T13:01:00Z','2026-10-08T13:01:30Z',
     'confirmed_in_trash',null,1,'2026-10-08T13:02:00Z',true)`);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function investigate(subject: string, ...extra: string[]): Promise<InvestigateData> {
  const result = await executeCommand(
    parseArgs(['investigate', subject, '--as-of', AS_OF, '--json', ...extra])
  );
  return result.data as InvestigateData;
}

function finding(data: InvestigateData, rule: string): InvestigateFinding {
  const hit = data.findings.find(f => f.rule === rule);
  if (!hit) throw new Error(`no ${rule} finding in ${data.findings.map(f => f.rule).join(', ')}`);
  return hit;
}

function withoutFiles(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry) => (key === 'files' ? undefined : entry)));
}

describe('investigate · task copy receipt', () => {
  it('proves committed copies and leaves attempts without a receipt unknown', async () => {
    const data = await investigate('copy@example.test');
    expect(data.task_copies).toEqual([
      {
        request_id: COPY_UNKNOWN,
        status: 'unknown',
        result_count: null,
        attempted_at: '2026-10-08T10:01:00.000Z',
        confirmed_at: null
      },
      {
        request_id: COPY_CONFIRMED,
        status: 'confirmed',
        result_count: 2,
        attempted_at: '2026-10-08T10:00:00.000Z',
        confirmed_at: '2026-10-08T10:00:01.000Z'
      }
    ]);
    expect(finding(data, 'task_copy_unconfirmed').kind).toBe('insufficient');
    expect(finding(data, 'task_copy_unconfirmed').code_locations[0]).toMatchObject({
      matched: 'team:task_copy:unconfirmed',
      files: expect.arrayContaining(['apps/web/src/team/tasks/useTaskClipboard.ts'])
    });
    expect(investigateOutputIsPrivate(data)).toBe(true);
  });
});

describe('investigate · account order receipt', () => {
  it('distinguishes a confirmed write, server conflict and unknown delivery without IDs', async () => {
    const data = await investigate('order@example.test');
    expect(data.account_orders.map(row => [row.request_id, row.status])).toEqual([
      [ORDER_CONFLICT, 'conflict'],
      [ORDER_UNKNOWN, 'unknown'],
      [ORDER_CONFIRMED, 'confirmed']
    ]);
    expect(data.account_orders[2]).toMatchObject({ scope_kind: 'socials', result_version: 5 });
    expect(finding(data, 'account_order_unconfirmed').kind).toBe('insufficient');
    expect(finding(data, 'account_order_unconfirmed').code_locations[0]).toMatchObject({
      matched: 'team:account_order:unconfirmed',
      files: expect.arrayContaining(['apps/web/src/team/accounts/useAccounts.ts'])
    });
    expect(investigateOutputIsPrivate(data)).toBe(true);
  });
});

describe('investigate · account archive receipt', () => {
  it('proves commits, explains active-launch refusal and preserves unknown delivery', async () => {
    const data = await investigate('order@example.test');
    expect(data.account_archives.map(row => [row.request_id, row.status])).toEqual([
      [ARCHIVE_BLOCKED, 'blocked'],
      [ARCHIVE_UNKNOWN, 'unknown'],
      [ARCHIVE_CONFIRMED, 'confirmed']
    ]);
    expect(data.account_archives[0].reason).toBe('active_launch');
    expect(data.account_archives[2]).toMatchObject({ action: 'archive', result_version: 1 });
    expect(finding(data, 'account_archive_active_launch').kind).toBe('fact');
    expect(finding(data, 'account_archive_unconfirmed').kind).toBe('insufficient');
    expect(investigateOutputIsPrivate(data)).toBe(true);
  });
});

describe('investigate · bulk trash receipt', () => {
  it('shows per-group partial and unknown outcomes without material details', async () => {
    const data = await investigate('order@example.test');
    expect(data.bulk_trash.map(row => [row.request_id, row.status])).toEqual([
      [BULK_UNKNOWN, 'unknown'],
      [BULK_PARTIAL, 'partial']
    ]);
    expect(data.bulk_trash[1]).toMatchObject({
      item_count: 3,
      confirmed_count: 1,
      failed_count: 1,
      unknown_count: 1,
      error_codes: ['PROVIDER_FAILURE']
    });
    expect(finding(data, 'bulk_trash_unconfirmed').kind).toBe('insufficient');
    expect(finding(data, 'bulk_trash_unconfirmed').code_locations[0]).toMatchObject({
      matched: 'team:bulk_trash:unconfirmed',
      files: expect.arrayContaining(['apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx'])
    });
    expect(investigateOutputIsPrivate(data)).toBe(true);
  });
});

describe('investigate · task orphan receipt', () => {
  it('explains retained cleanup by stable reason without a task ID, material ID or path', async () => {
    const data = await investigate('order@example.test');
    expect(data.task_orphans.map(row => [row.status, row.has_operation])).toEqual([
      ['confirmed_in_trash', true],
      ['cleanup_unverified', false]
    ]);
    expect(data.task_orphans[1]?.reason_code).toBe('PROVENANCE_UNKNOWN');
    expect(finding(data, 'task_orphan_not_confirmed')).toMatchObject({
      kind: 'fact',
      fingerprint: 'task-orphan:PROVENANCE_UNKNOWN'
    });
    expect(investigateOutputIsPrivate(data)).toBe(true);
  });
});

describe('investigate · (a) failed transcription with a code', () => {
  it('reports a fact with the stage, the code and the files', async () => {
    const data = await investigate('trans@example.test');
    const fact = finding(data, 'failed_operation_code');
    expect(fact.kind).toBe('fact');
    expect(fact.severity).toBe('high');
    expect(fact.fingerprint).toBe('transcription:model:MODEL_MISSING');
    expect(fact.title).toContain('stage model');
    expect(fact.title).toContain('MODEL_MISSING');
    expect(fact.evidence).toContain(`run:${RUN_T}`);
    expect(fact.code_locations[0]).toMatchObject({
      fingerprint: 'transcription:model:MODEL_MISSING',
      matched: 'transcription:model:MODEL_MISSING'
    });
    expect(fact.code_locations[0].files).toContain('apps/agent/src/queue/transcription-queue.ts');
    expect(fact.code_locations[0].files).toContain('apps/web/src/analytics/errors.ts');
    // The highest-ranked finding is this fact.
    expect(data.findings[0].id).toBe(fact.id);
  });

  it('rebuilds the run through inspect and leaves the successful one out', async () => {
    const data = await investigate('trans@example.test');
    expect(data.operations.map(op => op.id)).toEqual([RUN_T]);
    const [op] = data.operations;
    expect(op).toMatchObject({
      status: 'failed',
      capability: 'transcription.run',
      tool: 'transcription',
      error_code: 'MODEL_MISSING',
      error_stage: 'model',
      fingerprint: 'transcription:model:MODEL_MISSING',
      terminal: { event: 'operation_failed', outcome: 'failure' },
      agent_instance_ids: [AGENT_T]
    });
    expect(op.chain.map(step => step.event)).toEqual([
      'operation_started',
      'error_occurred',
      'operation_failed'
    ]);
  });

  it('cites the journal within two minutes of the failure and nothing further away', async () => {
    const data = await investigate('trans@example.test');
    const window = data.journal_around_failures.find(w => w.failure.ref === `run:${RUN_T}`);
    expect(window?.records.map(r => `${r.category}:${r.code}`)).toEqual(['spawn:started']);
    expect(window?.records[0]).toMatchObject({ seq: 2, lag_ms: 5000, agent_instance_id: AGENT_T });
  });

  it('reports the failed tool_ready as a fact and the environment, sessions and sync', async () => {
    const data = await investigate('trans@example.test');
    const ready = finding(data, 'tool_ready_failure');
    expect(ready.kind).toBe('fact');
    expect(ready.fingerprint).toBe('readiness:initial_read:CONNECTION_FAILED');
    expect(ready.code_locations[0].matched).toBe('readiness:initial_read:*');
    expect(data.environment).toMatchObject({
      web_builds: ['1.2.6'],
      local_app_versions: ['1.2.6'],
      agent_platforms: ['macos'],
      newest_local_app_version_seen: '1.2.6'
    });
    expect(data.sessions.count).toBe(1);
    expect(data.sessions.recent[0].tools).toEqual(['compressor', 'transcription']);
    expect(data.sync.status).toBe('ok');
    expect(data.sync.connections[0]).toMatchObject({
      jobs: 1,
      states: { failed: 1 },
      error_codes: ['DRIVE_FORBIDDEN']
    });
    expect(data.coverage.blind_spots).toContainEqual(
      expect.objectContaining({ kind: 'image_selection_signal_missing', values: ['1.2.6'] })
    );
    expect(JSON.stringify(data)).not.toContain('secret detail');
  });
});

describe('investigate · (b) link loss and recovery', () => {
  it('reports the manual recovery with its duration and the loss that never came back', async () => {
    const data = await investigate('link@example.test');
    expect(data.link.losses).toBe(2);
    expect(data.link.recoveries).toEqual([
      { flow_id: FLOW_L1, at: '2026-10-06T08:10:42.000Z', duration_ms: 42000, mode: 'manual' }
    ]);
    expect(data.link.unrecovered).toEqual([
      { flow_id: FLOW_L2, at: '2026-10-06T09:00:00.000Z', reason: 'not_running' }
    ]);
    expect(data.link.failed_checks_by_reason).toEqual([{ reason: 'pairing_rejected', events: 2 }]);
    const lost = finding(data, 'link_lost_unrecovered');
    expect(lost).toMatchObject({ kind: 'fact', severity: 'high', fingerprint: 'link:not_running' });
    expect(lost.code_locations[0].files).toContain('apps/web/src/connection.ts');
    expect(finding(data, 'link_manual_recovery').kind).toBe('fact');
    const pairing = finding(data, 'pairing_rejected_repeated');
    expect(pairing.kind).toBe('fact');
    expect(pairing.evidence).toHaveLength(2);
    expect(data.environment.browser_families).toEqual(['safari']);
    expect(data.environment.link_origins).toEqual(['hosted']);
  });

  it('sees the late recovery only without the as-of pin', async () => {
    const result = await executeCommand(
      parseArgs(['investigate', 'link@example.test', '--as-of', '2026-10-11T00:00:00Z', '--json'])
    );
    const data = result.data as InvestigateData;
    expect(data.link.unrecovered).toEqual([]);
    expect(data.findings.some(f => f.rule === 'link_lost_unrecovered')).toBe(false);
  });
});

describe('investigate · (c) picker failure around a stitcher failure without a code', () => {
  it('reports a hypothesis citing the picker journal record, and the picker failure as a fact', async () => {
    const data = await investigate('stitch@example.test');
    const hypothesis = finding(data, 'failed_operation_unknown_with_journal');
    expect(hypothesis.kind).toBe('hypothesis');
    expect(hypothesis.fingerprint).toBe('stitcher:stitch:unknown');
    expect(hypothesis.title).toContain('picker:exit (failed)');
    expect(hypothesis.evidence).toContain(`journal:${AGENT_S}:2`);
    const matched = hypothesis.code_locations.map(location => location.matched);
    expect(matched).toContain('journal:picker:exit');
    expect(matched).toContain('stitcher:*');
    expect(hypothesis.code_locations.flatMap(location => location.files)).toContain(
      'apps/agent/src/files/picker.ts'
    );

    const fact = finding(data, 'journal_tool_failure');
    expect(fact.kind).toBe('fact');
    expect(fact.fingerprint).toBe('journal:picker:exit');
    expect(fact.evidence).toEqual([`journal:${AGENT_S}:2`, `run:${RUN_S}`]);
  });

  it('prints the journal props only after the server fence', async () => {
    const data = await investigate('stitch@example.test');
    const record = data.journal_around_failures[0].records.find(r => r.seq === 2);
    expect(record?.props).toEqual({ chosen: 0, kind: 'file', outcome: 'failed' });
  });
});

describe('investigate · (d) stale agent', () => {
  it('reports a hypothesis when the local app is older than the newest seen', async () => {
    const data = await investigate('stale@example.test');
    const stale = finding(data, 'stale_agent');
    expect(stale.kind).toBe('hypothesis');
    expect(stale.title).toContain('1.2.3');
    expect(stale.title).toContain('1.2.6');
    expect(stale.code_locations[0].matched).toBe('agent:stale_version');
    expect(data.coverage.blind_spots.map(spot => spot.kind)).toEqual(
      expect.arrayContaining(['web_build_without_link_events', 'agent_version_without_journal'])
    );
    expect(
      data.coverage.blind_spots.find(spot => spot.kind === 'web_build_without_link_events')?.values
    ).toEqual(['1.2.3']);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.6')).toBeLessThan(0);
  });
});

describe('investigate · (e) a user with no events', () => {
  it('says "insufficient" and names the blind spots instead of "no problem"', async () => {
    const data = await investigate('empty@example.test');
    expect(data.coverage.events).toBe(0);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({ kind: 'insufficient', rule: 'no_events' });
    expect(data.coverage.blind_spots.map(spot => spot.kind)).toEqual([
      'no_events_in_period',
      'analytics_disabled'
    ]);
    expect(data.findings[0].evidence).toEqual([
      'blind_spot:no_events_in_period',
      'blind_spot:analytics_disabled'
    ]);
  });
});

describe('investigate · subject resolution', () => {
  it('resolves an installation id to the same user', async () => {
    const byInstallation = await investigate(INST_T);
    const byEmail = await investigate('trans@example.test');
    expect(byInstallation.subject).toMatchObject({
      kind: 'installation',
      id: INST_T,
      user_id: U_TRANS
    });
    expect(byInstallation.findings.map(f => f.id)).toEqual(byEmail.findings.map(f => f.id));
  });

  it('resolves a run id and puts that run first', async () => {
    const data = await investigate(RUN_S);
    expect(data.subject).toMatchObject({ kind: 'run', id: RUN_S, user_id: U_STITCH });
    expect(data.operations[0].id).toBe(RUN_S);
  });

  it('resolves a flow id', async () => {
    const data = await investigate(FLOW_L2);
    expect(data.subject).toMatchObject({ kind: 'flow', user_id: U_LINK });
  });

  it('never echoes the email and refuses an unknown subject', async () => {
    const data = await investigate('trans@example.test');
    expect(data.subject.id).toBeNull();
    await expect(
      executeCommand(parseArgs(['investigate', 'nobody@example.test', '--json']))
    ).rejects.toThrow('No user found for that email.');
    await expect(
      executeCommand(parseArgs(['investigate', '99999999-0000-4000-8000-000000000000']))
    ).rejects.toThrow(/Nothing matches/);
  });
});

describe('investigate · privacy and determinism', () => {
  it('prints no address, credential, path or URL; only repo files carry a slash', async () => {
    for (const subject of [
      'trans@example.test',
      'link@example.test',
      'stitch@example.test',
      'stale@example.test',
      'empty@example.test'
    ]) {
      const data = await investigate(subject);
      expect(investigateOutputIsPrivate(data)).toBe(true);
      const text = JSON.stringify(withoutFiles(data));
      expect(text).not.toContain('@');
      expect(text).not.toMatch(/token|bearer/i);
      expect(text).not.toMatch(/[/\\]/);
      expect(text).not.toContain('interview');
      for (const f of data.findings) {
        for (const location of f.code_locations) {
          for (const file of location.files) expect(file).toMatch(/^(apps|packages|supabase)\//);
        }
      }
    }
  });

  it('the guard refuses an email, a path or a credential anywhere', () => {
    expect(investigateOutputIsPrivate({ a: 'x@y.z' })).toBe(false);
    expect(investigateOutputIsPrivate({ a: ['ok', 'C:\\Users\\x'] })).toBe(false);
    expect(investigateOutputIsPrivate({ a: { b: 'Bearer abc' } })).toBe(false);
    expect(investigateOutputIsPrivate({ email: 'none' })).toBe(false);
    expect(investigateOutputIsPrivate({ files: ['apps/agent/src/index.ts'] })).toBe(true);
    expect(investigateOutputIsPrivate({ files: ['/etc/passwd'] })).toBe(false);
  });

  it('returns the same data for the same as-of', async () => {
    const first = await investigate('stitch@example.test');
    const second = await investigate('stitch@example.test');
    expect(second).toEqual(first);
    const envelope = buildCommandEnvelope(
      'investigate',
      { token: '30d', start: null, end: AS_OF, label: '' },
      first
    );
    expect(Object.keys(envelope)).toEqual(['ok', 'command', 'generated_at', 'period', 'data']);
  });

  it('defaults to a 30-day window ending at the as-of', async () => {
    const result = await executeCommand(
      parseArgs(['investigate', 'trans@example.test', '--as-of', AS_OF])
    );
    expect(result.period).toMatchObject({ token: '30d', as_of: '2026-10-09T00:00:00.000Z' });
    expect(result.human).toContain('Findings');
    expect(result.human).toContain('transcription:model:MODEL_MISSING');
    expect(result.human).not.toContain('trans@example.test');
  });
});
