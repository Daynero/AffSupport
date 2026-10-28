import { CATALOG_IMAGE_ERROR_CODES } from '../../packages/shared/src/team/catalog-images.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import { lookupCodeLocations } from './code-map.js';
import type { ResolvedPeriod } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODES: readonly string[] = [
  ...CATALOG_IMAGE_ERROR_CODES,
  'PERMISSION_DENIED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'UNKNOWN'
];
export const CATALOG_IMAGE_EXPECTED_STAGES = [
  'staged',
  'validating',
  'optimizing',
  'optimized',
  'deduplicating',
  'publishing',
  'verifying_origin',
  'verifying_public',
  'committing',
  'ready'
];
const STAGE =
  /^(?:import_(?:collecting|enumerating|sealed|running|completed|partial|failed|cancelled|expired|awaiting_reconciliation)|waiting_source|staged|validating|optimizing|optimized|deduplicating|publishing|verifying_origin|verifying_public|committing|ready|reused|failed|cancelled|expired|awaiting_reconciliation|publication_(?:candidate|put_unknown|origin_verified|public_verified|ready|purging|revoking|revoked|purge_unknown)|use_(?:reserved|committed|superseded|unknown)|pool_(?:added|removed)|purge_(?:pending|deleting|cache_purging|complete|unknown)|unknown)$/u;
const nullableUuid = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && UUID.test(v));
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));
export interface CatalogImageEvidenceRow {
  evidence_id: string;
  team_id: string | null;
  job_id: string | null;
  entry_id: string | null;
  publication_id: string | null;
  stage: string;
  code: string | null;
  occurred_at: string;
  received_at: string;
}
export interface CatalogImageDiagnosis {
  supported: boolean;
  evidence: CatalogImageEvidenceRow[];
  last_proven_stage: string | null;
  terminal: { stage: string; at: string; code: string | null } | null;
  findings: Array<{
    kind: 'fact' | 'insufficient';
    code: string;
    evidence: string;
    code_locations: ReturnType<typeof lookupCodeLocations>;
  }>;
  coverage: {
    schema_version: number | null;
    installed_at: string | null;
    capture_enabled: boolean | null;
    missing_stages: string[];
  };
  delivery_lag_ms: { p50: number | null; p95: number | null; samples: number };
  fresh_through: string | null;
  next_cursor: string | null;
  truncated: boolean;
  omitted_malformed: number;
  observed_storage: {
    status: 'not_observed' | 'historical_unknown' | 'current_observation';
    publications: number | null;
    ready_bytes: number | null;
    matched: number | null;
    unclassified: number | null;
    note: string;
  };
  storage_budget?: {
    status:
      'current_observation' | 'historical_unknown' | 'not_observed' | 'projection_unavailable';
    accounts: number | null;
    used_bytes: number | null;
    limit_bytes: number | null;
    reserved_bytes: number | null;
    pending_deletion_bytes: number | null;
    retained_bytes: number | null;
    note: string;
  };
  costs: { status: 'unsupported_by_producer'; note: string };
  blind_spots: string[];
}
const BLIND_SPOTS = [
  'A public readback proves availability at its check only; external generation, visual truth, browser visibility and advertising-platform ingestion remain unobserved.',
  'Current mutable import and publication totals cannot reconstruct historical as-of state. This command uses immutable journal records within the fixed period.',
  'A source name without classification is normal random selection, not a failed upload.',
  'Missing or expired stage evidence is unknown, never proof that an operation stopped there.'
];
export async function getCatalogImageDiagnosis(
  id: string | null,
  period: ResolvedPeriod,
  options: { userId?: string | null; limit?: number; cursor?: string | null } = {}
): Promise<CatalogImageDiagnosis> {
  if (id !== null && !UUID.test(id))
    throw new Error('Expected an image import, entry, publication, catalog attempt or team UUID.');
  if (options.userId && !UUID.test(options.userId)) throw new Error('Expected a user UUID.');
  if (
    options.cursor &&
    (!/^\d{1,19}$/u.test(options.cursor) || BigInt(options.cursor) > 9223372036854775807n)
  )
    throw new Error('Invalid evidence cursor.');
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
    throw new Error('Expected a positive integer row limit.');
  const schema = await getSchema();
  const expectedStages = CATALOG_IMAGE_EXPECTED_STAGES.filter(
    stage =>
      schema.tables.analytics_catalog_image_optimization ||
      !['optimizing', 'optimized'].includes(stage)
  );
  const base: CatalogImageDiagnosis = {
    supported: false,
    evidence: [],
    last_proven_stage: null,
    terminal: null,
    findings: [],
    coverage: {
      schema_version: null,
      installed_at: null,
      capture_enabled: null,
      missing_stages: [...expectedStages]
    },
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    fresh_through: null,
    next_cursor: null,
    truncated: false,
    omitted_malformed: 0,
    observed_storage: {
      status: period.as_of ? 'historical_unknown' : 'not_observed',
      publications: null,
      ready_bytes: null,
      matched: null,
      unclassified: null,
      note: 'Current retained-ready storage for teams represented in the bounded journal only. Historical bytes, request charges and provider billing are not reconstructed.'
    },
    costs: {
      status: 'unsupported_by_producer',
      note: 'Object-request billing, cache hits and provider cost are not measured by the import journal. Use the versioned offline cost model as an estimate only.'
    },
    storage_budget: {
      status: period.as_of
        ? 'historical_unknown'
        : schema.tables.analytics_catalog_image_storage
          ? 'not_observed'
          : 'projection_unavailable',
      accounts: null,
      used_bytes: null,
      limit_bytes: null,
      reserved_bytes: null,
      pending_deletion_bytes: null,
      retained_bytes: null,
      note: 'Current physical quota for owners represented by this bounded subject only. Includes retained, reserved and uncertain objects; pending deletion is not free space. Accounts are counted once across workspaces. Historical usage and provider billing are not reconstructed.'
    },
    blind_spots: [...BLIND_SPOTS]
  };
  if (!schema.tables.analytics_catalog_image_journal)
    return {
      ...base,
      blind_spots: [
        'Catalog-image diagnostic projection is unavailable or not readable by this role.',
        ...base.blind_spots
      ]
    };
  if (id === null && !options.userId)
    return {
      ...base,
      supported: true,
      blind_spots: ['No authenticated subject for image imports.', ...base.blind_spots]
    };
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const coverage = await query<{
    installed_at: string;
    schema_version: number;
    capture_enabled: boolean;
  }>(
    'select installed_at::text,schema_version,capture_enabled from public.analytics_catalog_image_coverage',
    []
  );
  const rows = await query<CatalogImageEvidenceRow>(
    `select j.evidence_id,j.team_id::text,j.job_id::text,j.entry_id::text,j.publication_id::text,
       j.stage,j.code,j.occurred_at::text,j.received_at::text
     from public.analytics_catalog_image_journal j
     where ($1::uuid is null or j.team_id=$1::uuid or j.job_id=$1::uuid or j.entry_id=$1::uuid or j.publication_id=$1::uuid
       or exists(select 1 from public.analytics_catalog_image_uses u where u.publication_id=j.publication_id and u.catalog_attempt_id=$1::uuid))
       and ($2::uuid is null or j.actor_id=$2::uuid)
       and ($3::timestamptz is null or j.received_at >= $3::timestamptz)
       and j.received_at <= $4::timestamptz and j.occurred_at <= $4::timestamptz
       and ($5::bigint is null or j.evidence_id::bigint < $5::bigint)
     order by j.evidence_id::bigint desc limit $6`,
    [id, options.userId ?? null, period.start, period.end, options.cursor ?? null, limit + 1]
  );
  const page = rows.slice(0, limit);
  const evidence = page.filter(
    row =>
      /^\d{1,19}$/u.test(String(row.evidence_id)) &&
      nullableUuid(row.team_id) &&
      nullableUuid(row.job_id) &&
      nullableUuid(row.entry_id) &&
      nullableUuid(row.publication_id) &&
      typeof row.stage === 'string' &&
      STAGE.test(row.stage) &&
      (row.code === null || CODES.includes(row.code)) &&
      timestamp(row.occurred_at) &&
      timestamp(row.received_at)
  );
  const stages = new Set(evidence.map(row => row.stage));
  const latest = evidence[0];
  const terminalRow = evidence.find(row =>
    [
      'ready',
      'reused',
      'failed',
      'cancelled',
      'expired',
      'import_completed',
      'import_partial',
      'import_failed',
      'import_cancelled',
      'import_expired'
    ].includes(row.stage)
  );
  const meta = coverage[0];
  const capture =
    meta &&
    timestamp(meta.installed_at) &&
    Number.isSafeInteger(meta.schema_version) &&
    typeof meta.capture_enabled === 'boolean'
      ? meta
      : null;
  const missing = expectedStages.filter(stage => !stages.has(stage));
  const findings = evidence
    .filter(
      row => row.code !== null || row.stage === 'awaiting_reconciliation' || row.stage === 'unknown'
    )
    .map(row => ({
      kind: row.code && row.code !== 'UNKNOWN' ? ('fact' as const) : ('insufficient' as const),
      code:
        row.code ?? (row.stage === 'awaiting_reconciliation' ? 'IMAGE_WRITE_UNCERTAIN' : 'UNKNOWN'),
      evidence: `catalog-image:${row.evidence_id}`,
      code_locations: lookupCodeLocations(`catalog:image:${row.code ?? 'IMAGE_WRITE_UNCERTAIN'}`)
    }));
  for (const row of evidence.filter(item => item.stage === 'pool_removed'))
    findings.push({
      kind: 'fact',
      code: 'POOL_REMOVED',
      evidence: `catalog-image:${row.evidence_id}`,
      code_locations: lookupCodeLocations('catalog:image:POOL_REMOVED')
    });
  const teams = [...new Set(evidence.flatMap(row => (row.team_id ? [row.team_id] : [])))].slice(
    0,
    50
  );
  let observedStorage = base.observed_storage;
  let storageBudget = base.storage_budget;
  const budgetTeams = [...new Set([...teams, ...(id ? [id] : [])])];
  if (!period.as_of && budgetTeams.length && schema.tables.analytics_catalog_image_storage) {
    const rows = await query<Record<string, unknown>>(
      `select count(*)::int accounts,coalesce(sum(used_bytes),0)::bigint used_bytes,
       coalesce(sum(limit_bytes),0)::bigint limit_bytes,coalesce(sum(reserved_bytes),0)::bigint reserved_bytes,
       coalesce(sum(pending_deletion_bytes),0)::bigint pending_deletion_bytes,
       coalesce(sum(retained_bytes),0)::bigint retained_bytes
       from (select distinct on(account_id) account_id,used_bytes,limit_bytes,reserved_bytes,pending_deletion_bytes,retained_bytes
        from public.analytics_catalog_image_storage where team_id=any($1::uuid[]) order by account_id) accounts`,
      [budgetTeams]
    );
    const row = rows[0];
    if (
      storageBudget &&
      row &&
      Number(row.accounts) > 0 &&
      Object.values(row).every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
    ) {
      storageBudget = {
        ...storageBudget,
        status: 'current_observation',
        accounts: Number(row.accounts),
        used_bytes: Number(row.used_bytes),
        limit_bytes: Number(row.limit_bytes),
        reserved_bytes: Number(row.reserved_bytes),
        pending_deletion_bytes: Number(row.pending_deletion_bytes),
        retained_bytes: Number(row.retained_bytes)
      };
    }
  }
  if (!period.as_of && teams.length) {
    const totals = await query<{
      publications: number;
      ready_bytes: number;
      matched: number;
      unclassified: number;
    }>(
      `select count(*)::int publications,coalesce(sum(size_bytes),0)::bigint ready_bytes,
       count(*) filter(where classification_mode='matched')::int matched,
       count(*) filter(where classification_mode='unclassified')::int unclassified
       from public.analytics_catalog_image_publications where team_id=any($1::uuid[]) and state='ready'`,
      [teams]
    );
    const totalsRow = totals[0];
    if (
      totalsRow &&
      Object.values(totalsRow).every(
        value => Number.isSafeInteger(Number(value)) && Number(value) >= 0
      )
    )
      observedStorage = {
        ...observedStorage,
        status: 'current_observation',
        publications: Number(totalsRow.publications),
        ready_bytes: Number(totalsRow.ready_bytes),
        matched: Number(totalsRow.matched),
        unclassified: Number(totalsRow.unclassified)
      };
  }
  return {
    ...base,
    supported: true,
    evidence,
    last_proven_stage: latest?.stage ?? null,
    terminal: terminalRow
      ? { stage: terminalRow.stage, at: terminalRow.occurred_at, code: terminalRow.code }
      : null,
    findings,
    coverage: {
      schema_version: capture?.schema_version ?? null,
      installed_at: capture?.installed_at ?? null,
      capture_enabled: capture?.capture_enabled ?? null,
      missing_stages: missing
    },
    fresh_through: latest?.received_at ?? null,
    next_cursor: rows.length > limit ? String(page.at(-1)?.evidence_id ?? '') || null : null,
    truncated: rows.length > limit,
    omitted_malformed: page.length - evidence.length,
    observed_storage: observedStorage,
    storage_budget: storageBudget,
    blind_spots: [
      ...base.blind_spots,
      ...(missing.length
        ? [`Stage evidence missing in this bounded window: ${missing.join(', ')}.`]
        : []),
      ...(!capture || !capture.capture_enabled
        ? ['Diagnostic capture trigger health is unavailable or disabled.']
        : []),
      ...(page.length !== evidence.length
        ? ['Malformed diagnostic evidence was omitted; those outcomes remain unknown.']
        : [])
    ]
  };
}

export async function getCatalogImageAudit(period: ResolvedPeriod) {
  const schema = await getSchema();
  if (!schema.tables.analytics_catalog_image_journal)
    return { supported: false, samples: 0, missing: ['catalog_image_projection_unavailable'] };
  const health = await query<{
    capture_enabled: boolean;
    installed_at: string;
    schema_version: number;
  }>(
    'select installed_at::text,schema_version,capture_enabled from public.analytics_catalog_image_coverage',
    []
  );
  const rows = await query<{ stage: string; samples: number; unknown_codes?: number }>(
    `select stage,count(*)::int samples,count(*) filter(where code='UNKNOWN')::int unknown_codes from public.analytics_catalog_image_journal
     where ($1::timestamptz is null or received_at >= $1::timestamptz) and received_at <= $2::timestamptz
     group by stage`,
    [period.start, period.end]
  );
  const observed = new Set(rows.map(row => row.stage));
  const missing: string[] = [];
  if (health[0]?.capture_enabled !== true || health[0]?.schema_version !== 1)
    missing.push('catalog_image_capture_unverified');
  if (
    !health[0] ||
    !timestamp(health[0].installed_at) ||
    Date.parse(health[0].installed_at) > Date.parse(period.end)
  )
    missing.push('catalog_image_not_installed_at_snapshot');
  else if (period.start === null || Date.parse(period.start) < Date.parse(health[0].installed_at))
    missing.push('catalog_image_before_installation_unobserved');
  if (!observed.has('ready') && !observed.has('reused'))
    missing.push('catalog_image_ready_unobserved');
  for (const stage of CATALOG_IMAGE_EXPECTED_STAGES.filter(
    stage =>
      stage !== 'ready' &&
      (schema.tables.analytics_catalog_image_optimization ||
        !['optimizing', 'optimized'].includes(stage))
  ))
    if (!observed.has(stage)) missing.push(`catalog_image_${stage}_unobserved`);
  if (observed.has('unknown')) missing.push('catalog_image_unknown_stage');
  if (rows.some(row => Number(row.unknown_codes ?? 0) > 0))
    missing.push('catalog_image_unknown_code');
  const complete = await query<{ chains: number }>(
    `select count(*)::int chains from (
       select entry_id from public.analytics_catalog_image_journal
       where entry_id is not null and ($1::timestamptz is null or received_at >= $1::timestamptz)
         and received_at <= $2::timestamptz
       group by entry_id
       having array['validating','deduplicating','publishing','verifying_origin','verifying_public','committing']::text[] <@ array_agg(distinct stage)
         and (not $3::boolean or array['optimizing','optimized']::text[] <@ array_agg(distinct stage))
         and bool_or(stage in ('ready','reused'))
     ) chains`,
    [period.start, period.end, schema.tables.analytics_catalog_image_optimization === true]
  );
  if (!complete[0]?.chains) missing.push('catalog_image_complete_correlated_chain_unobserved');
  return {
    supported: true,
    samples: rows.reduce((sum, row) => sum + Number(row.samples), 0),
    missing
  };
}

export async function getCatalogImageUserDiagnosis(
  email: string,
  period: ResolvedPeriod,
  limit = 100
) {
  const rows = await query<{ id: string }>(
    'select id::text from public.analytics_users where email_normalized=lower($1) limit 1',
    [email]
  );
  return getCatalogImageDiagnosis(null, period, { userId: rows[0]?.id ?? null, limit });
}
