import {
  CATALOG_VIDEO_R2_REASONS,
  CATALOG_VIDEO_R2_STAGES
} from '../../packages/shared/src/team/catalog-video-r2.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import { lookupCodeLocations } from './code-map.js';
import type { ResolvedPeriod } from './types.js';

/**
 * Optional catalog video publication to R2 (050): the immutable journal read
 * through bounded SELECT-only projections. No provider I/O, no production writes.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODES: readonly string[] = [...CATALOG_VIDEO_R2_REASONS, 'UNKNOWN'];
const STAGES: readonly string[] = [...CATALOG_VIDEO_R2_STAGES, 'unknown'];
/** A healthy copy, in order (AD-002). */
export const CATALOG_VIDEO_R2_EXPECTED_STAGES = [
  'configured',
  'planned',
  'uploading',
  'part_verified',
  'verifying',
  'ready',
  'confirmed'
];
const TERMINAL = new Set(['ready', 'deleted', 'purged', 'failed']);
const nullableUuid = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && UUID.test(v));
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));

export interface CatalogVideoR2EvidenceRow {
  evidence_id: string;
  team_id: string | null;
  copy_id: string | null;
  catalog_material_id: string | null;
  source_material_id: string | null;
  stage: string;
  code: string | null;
  link_kind: string | null;
  part_verification: string | null;
  size_bucket: string | null;
  duration_bucket: string | null;
  full_hash_verified: boolean | null;
  occurred_at: string;
  received_at: string;
}
export interface CatalogVideoR2Diagnosis {
  supported: boolean;
  evidence: CatalogVideoR2EvidenceRow[];
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
  /** Whether the last ready copy in the page was proven by a full checksum or only by parts and probes. */
  proof: { full_hash_verified: boolean | null; part_verification: string[] };
  observed_copies: {
    status: 'not_observed' | 'historical_unknown' | 'current_observation';
    ready: number | null;
    retiring: number | null;
    in_progress: number | null;
    failed: number | null;
    deleted: number | null;
    note: string;
  };
  costs: { status: 'estimate_only'; note: string };
  next_cursor: string | null;
  truncated: boolean;
  omitted_malformed: number;
  blind_spots: string[];
}
const BLIND_SPOTS = [
  'A public HEAD and byte probes prove availability at the moment of the check; acceptance by an advertising platform or a specific viewer is not observed (AD-006).',
  'When a copy did not fit into one invocation, the full source checksum was not compared: parts, size and probes are the proof, and full_hash_verified says so.',
  'Deletion proves a 404 and an accepted CDN purge; caches outside the own CDN are not observable.',
  'Storage and request billing are not measured here; any cost is an estimate from the public price list.'
];

export async function getCatalogVideoR2Diagnosis(
  id: string | null,
  period: ResolvedPeriod,
  options: { userId?: string | null; limit?: number; cursor?: string | null } = {}
): Promise<CatalogVideoR2Diagnosis> {
  if (id !== null && !UUID.test(id))
    throw new Error('Expected a team, catalog, source material or copy UUID.');
  if (options.userId && !UUID.test(options.userId)) throw new Error('Expected a user UUID.');
  if (
    options.cursor &&
    (!/^\d{1,19}$/u.test(options.cursor) || BigInt(options.cursor) > 9223372036854775807n)
  )
    throw new Error('Invalid evidence cursor.');
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
    throw new Error('Expected a positive integer row limit.');
  const schema = await getSchema();
  const base: CatalogVideoR2Diagnosis = {
    supported: false,
    evidence: [],
    last_proven_stage: null,
    terminal: null,
    findings: [],
    coverage: {
      schema_version: null,
      installed_at: null,
      capture_enabled: null,
      missing_stages: [...CATALOG_VIDEO_R2_EXPECTED_STAGES]
    },
    proof: { full_hash_verified: null, part_verification: [] },
    observed_copies: {
      status: period.as_of ? 'historical_unknown' : 'not_observed',
      ready: null,
      retiring: null,
      in_progress: null,
      failed: null,
      deleted: null,
      note: 'Current copy states for the teams represented in the bounded journal only; historical bytes are not reconstructed.'
    },
    costs: {
      status: 'estimate_only',
      note: 'Provider billing is not measured; the space tariff page shows an estimate from the public R2 price list.'
    },
    next_cursor: null,
    truncated: false,
    omitted_malformed: 0,
    blind_spots: [...BLIND_SPOTS]
  };
  if (!schema.tables.analytics_catalog_video_r2_journal)
    return {
      ...base,
      blind_spots: [
        'Catalog-video R2 diagnostic projection is unavailable or not readable by this role.',
        ...base.blind_spots
      ]
    };
  if (id === null && !options.userId)
    return {
      ...base,
      supported: true,
      blind_spots: ['No authenticated subject for catalog video copies.', ...base.blind_spots]
    };
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const coverage = schema.tables.analytics_catalog_video_r2_coverage
    ? await query<{ installed_at: string; schema_version: number; capture_enabled: boolean }>(
        'select installed_at::text,schema_version,capture_enabled from public.analytics_catalog_video_r2_coverage',
        []
      )
    : [];
  const rows = await query<CatalogVideoR2EvidenceRow>(
    `select j.evidence_id,j.team_id::text,j.copy_id::text,j.catalog_material_id::text,j.source_material_id::text,
       j.stage,j.code,j.link_kind,j.part_verification,j.size_bucket,j.duration_bucket,j.full_hash_verified,
       j.occurred_at::text,j.received_at::text
     from public.analytics_catalog_video_r2_journal j
     where ($1::uuid is null or j.team_id=$1::uuid or j.copy_id=$1::uuid or j.catalog_material_id=$1::uuid or j.source_material_id=$1::uuid)
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
      nullableUuid(row.copy_id) &&
      nullableUuid(row.catalog_material_id) &&
      nullableUuid(row.source_material_id) &&
      typeof row.stage === 'string' &&
      STAGES.includes(row.stage) &&
      (row.code === null || CODES.includes(row.code)) &&
      (row.link_kind === null || row.link_kind === 'drive' || row.link_kind === 'r2') &&
      (row.part_verification === null ||
        row.part_verification === 'provider_checksum' ||
        row.part_verification === 'readback') &&
      timestamp(row.occurred_at) &&
      timestamp(row.received_at)
  );
  const stages = new Set(evidence.map(row => row.stage));
  const latest = evidence[0];
  const terminalRow = evidence.find(row => TERMINAL.has(row.stage));
  const meta = coverage[0];
  const capture =
    meta &&
    timestamp(meta.installed_at) &&
    Number.isSafeInteger(meta.schema_version) &&
    typeof meta.capture_enabled === 'boolean'
      ? meta
      : null;
  const findings = evidence
    .filter(row => row.code !== null || row.stage === 'failed' || row.stage === 'unknown')
    .map(row => ({
      kind: row.code && row.code !== 'UNKNOWN' ? ('fact' as const) : ('insufficient' as const),
      code: row.code ?? 'UNKNOWN',
      evidence: `catalog-video-r2:${row.evidence_id}`,
      code_locations: lookupCodeLocations(`catalog:video_r2:${row.code ?? 'UNKNOWN'}`)
    }));
  const ready = evidence.find(row => row.stage === 'ready');
  const proof = {
    full_hash_verified: ready?.full_hash_verified ?? null,
    part_verification: [
      ...new Set(evidence.flatMap(row => (row.part_verification ? [row.part_verification] : [])))
    ]
  };
  const teams = [...new Set(evidence.flatMap(row => (row.team_id ? [row.team_id] : [])))].slice(
    0,
    50
  );
  let observed = base.observed_copies;
  if (!period.as_of && teams.length && schema.tables.analytics_catalog_video_r2_copies) {
    const totals = await query<Record<string, unknown>>(
      `select count(*) filter(where state='ready')::int ready,count(*) filter(where state='retiring')::int retiring,
       count(*) filter(where state in ('planned','uploading','verifying'))::int in_progress,
       count(*) filter(where state='failed')::int failed,count(*) filter(where state='deleted')::int deleted
       from public.analytics_catalog_video_r2_copies where team_id=any($1::uuid[])`,
      [teams]
    );
    const row = totals[0];
    if (
      row &&
      Object.values(row).every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
    )
      observed = {
        ...observed,
        status: 'current_observation',
        ready: Number(row.ready),
        retiring: Number(row.retiring),
        in_progress: Number(row.in_progress),
        failed: Number(row.failed),
        deleted: Number(row.deleted)
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
      missing_stages: CATALOG_VIDEO_R2_EXPECTED_STAGES.filter(stage => !stages.has(stage))
    },
    proof,
    observed_copies: observed,
    next_cursor:
      rows.length > limit && page.length ? String(page[page.length - 1]!.evidence_id) : null,
    truncated: rows.length > limit,
    omitted_malformed: page.length - evidence.length,
    blind_spots: [
      ...(proof.full_hash_verified === false
        ? [
            'The last ready copy was verified by parts and probes only; the full source checksum was not compared.'
          ]
        : []),
      ...base.blind_spots
    ]
  };
}
