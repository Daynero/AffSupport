import { readFileSync } from 'node:fs';
import { activeBinding } from '../lib/release/bindings.mjs';
import { assertReadOnlySql, query } from './db.js';

function managementCredentials() {
  const token =
    process.env.SUPABASE_ACCESS_TOKEN?.trim() ||
    /^SUPABASE_ACCESS_TOKEN=(.+)$/mu
      .exec(readFileSync('config/keys/supabase-release-cli.env', 'utf8'))?.[1]
      ?.trim();
  if (!token) throw new Error('Supabase management token is unavailable.');
  return { token, ref: activeBinding().supabaseProject };
}

/** Explicit on-demand audit: exact counts of the largest non-grant relations. */
export async function getDatabaseTables() {
  const relations = await managementQuery<{
    schema: string;
    name: string;
    total_bytes: number;
    age_column: string | null;
  }>(`
    select n.nspname as schema, c.relname as name,
      pg_total_relation_size(c.oid) as total_bytes,
      (select a.attname from pg_attribute a where a.attrelid = c.oid
        and a.attnum > 0 and not a.attisdropped
        and a.attname in ('created_at', 'occurred_at', 'start_time')
        and a.atttypid in (1114, 1184)
        order by a.attnum limit 1) as age_column
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public', 'private', 'storage', 'auth', 'cron', 'net')
      and c.relname <> 'team_transfer_grants'
    order by pg_total_relation_size(c.oid) desc limit 25
  `);
  const identifier = (name: string) => {
    if (!/^[a-z_][a-z_0-9]*$/i.test(name)) throw new Error('Unexpected diagnostic identifier.');
    return `"${name}"`;
  };
  const counts = await managementQuery(
    relations
      .map(row => {
        const relation = `${identifier(row.schema)}.${identifier(row.name)}`;
        const age = row.age_column ? identifier(row.age_column) : null;
        return `select '${row.schema}.${row.name}' as relation, count(*) as records,
      coalesce(sum(pg_column_size(t)), 0) as row_bytes,
      ${age ? `min(${age})` : 'null::timestamptz'} as oldest,
      ${age ? `max(${age})` : 'null::timestamptz'} as newest,
      ${age ? `count(*) filter (where ${age} < clock_timestamp() - interval '30 days')` : 'null::bigint'} as older_than_30_days
      from ${relation} t`;
      })
      .join(' union all ')
  );
  const indexes = await managementQuery(`
    select s.schemaname, s.relname, s.indexrelname,
      pg_relation_size(s.indexrelid) as bytes, s.idx_scan,
      i.indisunique, i.indisprimary, pg_get_indexdef(s.indexrelid) as definition
    from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
    where s.relname <> 'team_transfer_grants'
    order by pg_relation_size(s.indexrelid) desc limit 40
  `);
  const duplicates = await managementQuery(`
    select a.indrelid::regclass::text as relation,
      a.indexrelid::regclass::text as first_index, b.indexrelid::regclass::text as second_index
    from pg_index a join pg_index b on a.indrelid = b.indrelid and a.indexrelid < b.indexrelid
      and a.indkey = b.indkey and a.indclass = b.indclass
      and a.indcollation = b.indcollation and a.indoption = b.indoption
      and a.indisunique = b.indisunique
      and coalesce(a.indexprs::text, '') = coalesce(b.indexprs::text, '')
      and coalesce(a.indpred::text, '') = coalesce(b.indpred::text, '')
    join pg_class c on c.oid = a.indrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private')
  `);
  const bloatSupport = await managementQuery(`
    select n.nspname as schema, p.proname,
      has_function_privilege(current_user, p.oid, 'EXECUTE') as executable
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'pgstattuple_approx'
  `);
  const retention = await managementQuery(`
    select 'cron.job_run_details' as relation, '7 days' as age, count(*) as records,
      coalesce(sum(pg_column_size(d)), 0) as row_bytes
    from cron.job_run_details d where end_time < clock_timestamp() - interval '7 days'
      and status in ('succeeded', 'failed')
    union all
    select 'cron.job_run_details', '30 days', count(*), coalesce(sum(pg_column_size(d)), 0)
    from cron.job_run_details d where end_time < clock_timestamp() - interval '30 days'
      and status in ('succeeded', 'failed')
    union all
    select 'public.team_catalog_events', '7 days', count(*), coalesce(sum(pg_column_size(e)), 0)
    from public.team_catalog_events e where occurred_at < clock_timestamp() - interval '7 days'
  `);
  const materials = await managementQuery(`
    select lifecycle, count(*) as records,
      coalesce(sum(pg_column_size(search_tsv)), 0) as search_vector_bytes
    from public.team_materials group by lifecycle
  `);
  const storage = await managementQuery(`
    select case when bucket_id = 'team-restitch-images' then 'legacy_restitch_images'
      when bucket_id = 'team-thumbnail-cache' then 'thumbnail_cache' else 'other' end as purpose,
      count(*) as objects,
      coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$'
        then (metadata->>'size')::numeric else 0 end), 0) as bytes
    from storage.objects group by purpose
  `);
  const scans = await managementQuery(`
    select g.state, j.job_kind, j.state as job_state, count(*) as generations,
      min(g.updated_at) as oldest_updated
    from private.catalog_scan_generations g join private.catalog_sync_jobs j on j.id = g.job_id
    group by g.state, j.job_kind, j.state
  `);
  const legacySources = await managementQuery(`
    select 'space_defaults' as scope, count(*) as configurations,
      count(*) filter (where source_mode = 'legacy'
        and cardinality(start_image_ids) + cardinality(end_image_ids) > 0) as legacy_with_images
    from public.team_restitch_defaults
    union all
    select 'member_preferences', count(*), count(*) filter (where source_mode = 'legacy'
      and cardinality(start_image_ids) + cardinality(end_image_ids) > 0)
    from public.team_member_restitch_preferences
  `);
  return {
    relations,
    counts,
    indexes,
    duplicates,
    bloat_support: bloatSupport,
    retention_candidates: retention,
    material_lifecycles: materials,
    storage_purposes: storage,
    scan_generations: scans,
    legacy_sources: legacySources,
    note: 'Current snapshot; row_bytes excludes some out-of-line TOAST storage and is not an exact bloat estimate. Low index scan counts since reset do not prove an index is unnecessary.'
  };
}

async function managementQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  const { token, ref } = managementCredentials();
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: true }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Read-only database diagnostic HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error('Invalid database diagnostic response.');
  return rows as T[];
}

async function serviceHealth() {
  const { token, ref } = managementCredentials();
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/health?services=auth,rest`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) return { status: 'unavailable', http_status: response.status };
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) return { status: 'invalid_response' };
  return rows.map((row: { name?: string; status?: string }) => ({
    name: row.name,
    status: row.status
  }));
}

/** Small post-deploy probe; does not scan grant or application tables. */
export async function getDatabaseRetention() {
  const jobs = await managementQuery(`
    select j.jobname, j.schedule, j.active, r.status as last_status,
      r.start_time, r.end_time, r.return_message
    from cron.job j left join lateral (
      select status, start_time, end_time, return_message
      from cron.job_run_details d where d.jobid = j.jobid
      order by d.runid desc limit 1
    ) r on true
    where j.jobname in ('soty-catalog-event-retention', 'soty-cron-history-retention',
      'soty-transfer-grants-retention')
    order by j.jobname
  `);
  const indexes = await managementQuery(`
    select to_regclass('public.team_catalog_events_retention_idx') is not null as catalog_expiry_index,
      to_regclass('private.team_transfer_grants_retention_idx') is not null as grant_expiry_index,
      pg_relation_size(to_regclass('private.team_transfer_grants_expiry_idx')) as legacy_grant_expiry_index_bytes,
      pg_relation_size(to_regclass('private.team_transfer_grants_retention_idx')) as grant_retention_index_bytes,
      to_regclass('private.team_transfer_grants_idle_landing_idx') is not null as landing_reuse_index,
      to_regprocedure('public.issue_landing_preview_grant(uuid,bytea,text,uuid,uuid,uuid,text,integer)')
        is not null as landing_reuse_rpc,
      (select idx_scan from pg_stat_user_indexes where schemaname = 'private'
        and indexrelname = 'team_transfer_grants_idle_landing_idx')
        as landing_reuse_index_scans_since_stats_reset,
      (select n_tup_ins from pg_stat_user_tables where schemaname = 'private'
        and relname = 'team_transfer_grants') as grant_insertions_since_stats_reset,
      (select n_tup_del from pg_stat_user_tables where schemaname = 'private'
        and relname = 'team_transfer_grants') as grant_deletions_since_stats_reset,
      exists (select 1 from pg_constraint where conrelid = to_regclass('public.team_account_agents')
        and conname = 'team_account_agents_id_team_unique') as tenant_key_preserved,
      exists (select 1 from pg_constraint where conrelid = to_regclass('public.team_account_agents')
        and conname = 'team_agents_tenant_key') as duplicate_tenant_key_present,
      (select n_tup_del from pg_stat_user_tables where schemaname = 'public'
        and relname = 'team_catalog_events') as catalog_deletions_since_stats_reset,
      (select n_tup_del from pg_stat_user_tables where schemaname = 'cron'
        and relname = 'job_run_details') as cron_deletions_since_stats_reset
  `);
  return {
    jobs,
    indexes,
    services: await serviceHealth(),
    note: 'Current metadata only; history keeps seven days, expired grants keep one diagnostic day, and backlog drains gradually.'
  };
}

/** Catalog estimates avoid scanning user tables on an already overloaded server. */
export async function getDatabaseHealth(management = false) {
  const read = management ? managementQuery : query;
  const tables = await read(`
    select s.schemaname, s.relname, s.n_live_tup, s.n_dead_tup,
      pg_total_relation_size(s.relid) as total_bytes,
      pg_relation_size(s.relid) as heap_bytes,
      pg_indexes_size(s.relid) as index_bytes,
      s.n_tup_ins, s.n_tup_upd, s.n_tup_del,
      s.seq_scan, s.idx_scan, s.last_autovacuum, s.last_autoanalyze
    from pg_stat_user_tables s
    order by pg_total_relation_size(s.relid) desc limit 40
  `);
  const database = await read(`
    select pg_database_size(current_database()) as bytes,
      numbackends, blks_read, blks_hit, temp_files, temp_bytes, deadlocks,
      stats_reset from pg_stat_database where datname = current_database()
  `);
  const connections = await read(`
    select state, wait_event_type, count(*) as connections,
      current_setting('max_connections')::integer as max_connections
    from pg_stat_activity where datname = current_database()
    group by state, wait_event_type order by count(*) desc
  `);
  const access = await read<{ readable: boolean }>(`
    select (has_schema_privilege(current_user, n.oid, 'USAGE')
      and has_table_privilege(current_user, c.oid, 'SELECT')) as readable
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'team_transfer_grants'
  `);
  const grants = access[0]?.readable
    ? await read(`
        select purpose,
          case when tool_id = 'preview:media' then 'media'
            when tool_id like 'preview:landing:%' then 'landing'
            when tool_id like 'preview:archive:%' then 'archive'
            when tool_id like 'landing-render:%' then 'landing_image'
            when tool_id like 'landing-upload:%' then 'landing_upload'
            when tool_id = 'thumbnail:session' then 'thumbnail_session'
            else 'other' end as producer,
          count(*) as records,
          count(*) filter (where uses = 0) as unused,
          count(*) filter (where material_id is not null) as material_scoped_records,
          count(*) filter (where expires_at <= clock_timestamp()) as expired,
          count(*) filter (where expires_at < clock_timestamp() - interval '1 day') as cleanup_eligible,
          count(*) filter (where revoked_at is not null) as revoked,
          count(*) filter (where created_at > clock_timestamp() - interval '1 hour') as issued_last_hour,
          count(*) filter (where created_at > clock_timestamp() - interval '1 day') as issued_last_day,
          min(created_at) as oldest, max(created_at) as newest
        from private.team_transfer_grants group by purpose, producer order by count(*) desc
      `)
    : {
        status: 'insufficient_privileges',
        note: 'Grant purpose/expiry distribution is unobservable to this read-only role.'
      };
  const cron = management
    ? await read(`
    select j.jobname, j.schedule, j.active,
      count(d.runid) as recent_runs,
      count(d.runid) filter (where d.status = 'failed') as failed_runs,
      max(d.end_time) as last_finished
    from cron.job j left join cron.job_run_details d on d.jobid = j.jobid
      and d.start_time > clock_timestamp() - interval '1 hour'
    group by j.jobid, j.jobname, j.schedule, j.active order by j.jobname
  `)
    : { status: 'not_requested' };
  const cronHistory = management
    ? await read(`
    select count(*) as records, min(start_time) as oldest,
      count(*) filter (where end_time < clock_timestamp() - interval '30 days'
        and status in ('succeeded', 'failed')) as terminal_older_than_30_days
    from cron.job_run_details
  `)
    : { status: 'not_requested' };
  return {
    services: management ? await serviceHealth() : { status: 'not_requested' },
    storage_capacity: management
      ? await read(`
        select count(*) as objects,
          coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$'
            then (metadata->>'size')::numeric else 0 end), 0) as bytes,
          count(*) filter (where metadata->>'size' is null
            or metadata->>'size' !~ '^[0-9]+$') as objects_without_known_size
        from storage.objects
      `)
      : { status: 'not_requested' },
    database,
    connections,
    tables,
    grants,
    cron,
    cron_history: cronHistory,
    note: 'Row counts are estimates; counters are cumulative since stats reset. Size alone does not prove the cause of connection failures.'
  };
}
