/**
 * Which of the newer analytics objects this database actually has.
 *
 * The CLI ships ahead of the migrations it reads: envelope v3 (20261117110000) adds
 * `attempt_id`, `agent_instance_id` and `agent_platform` to `analytics_events`, retention
 * (20261120100000) adds the daily rollup tables, and 033 (20261124100000) adds
 * `agent_journal_records`. Until a database has them, every query that names them would fail.
 *
 * One read-only probe of `information_schema`, cached per process (and per test executor),
 * tells each query which closed SQL variant to use. Nothing a user typed is ever interpolated:
 * the only SQL this module returns is one of the fixed fragments below, chosen by a boolean.
 *
 * `information_schema` only lists what the current role holds a privilege on, so an object the
 * read-only role cannot read reads as absent — which is the honest answer for this CLI too.
 */
import { query, queryExecutorGeneration } from './db.js';
import type { AnalyticsSchema, SchemaSummary } from './types.js';

export type { AnalyticsSchema, SchemaSummary };

const EVENT_COLUMNS = ['attempt_id', 'agent_instance_id', 'agent_platform'] as const;
const TABLES = [
  'agent_journal_records',
  'analytics_daily_events',
  'analytics_daily_tool_outcomes',
  'analytics_catalog_sync_jobs'
] as const;

let cached: { generation: number; schema: Promise<AnalyticsSchema> } | null = null;

async function probe(): Promise<AnalyticsSchema> {
  const rows = await query<{ kind: string; name: string }>(
    `select 'column' as kind, c.column_name::text as name
     from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'analytics_events'
       and c.column_name = any($1::text[])
     union all
     select 'table' as kind, t.table_name::text as name
     from information_schema.tables t
     where t.table_schema = 'public' and t.table_name = any($2::text[])`,
    [[...EVENT_COLUMNS], [...TABLES]]
  );
  const has = (kind: string, name: string) =>
    rows.some(row => row.kind === kind && row.name === name);
  return {
    events: {
      attempt_id: has('column', 'attempt_id'),
      agent_instance_id: has('column', 'agent_instance_id'),
      agent_platform: has('column', 'agent_platform')
    },
    tables: {
      agent_journal_records: has('table', 'agent_journal_records'),
      analytics_daily_events: has('table', 'analytics_daily_events'),
      analytics_daily_tool_outcomes: has('table', 'analytics_daily_tool_outcomes'),
      analytics_catalog_sync_jobs: has('table', 'analytics_catalog_sync_jobs')
    }
  };
}

/** The probe, run once per process (and again when a test swaps the database). */
export function getSchema(): Promise<AnalyticsSchema> {
  const generation = queryExecutorGeneration();
  if (!cached || cached.generation !== generation) {
    const schema = probe();
    cached = { generation, schema };
    // A failed probe must not poison the cache for the next command.
    schema.catch(() => {
      if (cached?.schema === schema) cached = null;
    });
  }
  return cached.schema;
}

export function missingObjects(schema: AnalyticsSchema): string[] {
  return [
    ...EVENT_COLUMNS.filter(column => !schema.events[column]).map(
      column => `analytics_events.${column}`
    ),
    ...TABLES.filter(table => !schema.tables[table])
  ];
}

export function schemaSummary(schema: AnalyticsSchema): SchemaSummary {
  return {
    events: { ...schema.events },
    tables: { ...schema.tables },
    missing: missingObjects(schema)
  };
}

/** True when every envelope v3 column is present. */
export function hasEnvelopeV3(schema: AnalyticsSchema): boolean {
  return EVENT_COLUMNS.every(column => schema.events[column]);
}

/**
 * The SQL expressions for the envelope v3 values of `public.analytics_events e`, each one of two
 * fixed fragments. Rows written before v3 keep `attempt_id` in `properties`; without the column
 * that is the only place it can be.
 */
export interface EventColumnSql {
  attemptId: string;
  agentInstanceId: string;
  agentPlatform: string;
}

export function eventColumnSql(schema: AnalyticsSchema): EventColumnSql {
  return {
    attemptId: schema.events.attempt_id
      ? `coalesce(e.attempt_id, e.properties ->> 'attempt_id')`
      : `(e.properties ->> 'attempt_id')`,
    agentInstanceId: schema.events.agent_instance_id ? `e.agent_instance_id::text` : `null::text`,
    agentPlatform: schema.events.agent_platform ? `e.agent_platform` : `null::text`
  };
}
