import { query } from './db.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOB_STATES = [
  'waiting',
  'preparing',
  'applying',
  'verifying',
  'retry_wait',
  'unknown',
  'blocked',
  'cancel_requested',
  'published',
  'superseded',
  'held'
];
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const instant = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const nullableTime = (v: unknown) => v === null || instant(v);
const count = (v: unknown, max = 400) =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const optionalUuid = (v: unknown) => v === null || (typeof v === 'string' && UUID.test(v));
const unavailable = (cause: unknown) => {
  const code = record(cause) ? cause.code : null;
  return code === 'ANALYTICS_QUERY_TIMEOUT' || code === '57014'
    ? 'timeout'
    : code === '42501'
      ? 'read_denied'
      : code === '42P01' || code === '42703'
        ? 'schema_missing'
        : null;
};
type PublicationMode = 'immediate' | 'scheduled' | 'held';
type TargetKind = 'source' | 'video_set';
type PublicationJobState =
  | 'waiting'
  | 'preparing'
  | 'applying'
  | 'verifying'
  | 'retry_wait'
  | 'unknown'
  | 'blocked'
  | 'cancel_requested'
  | 'published'
  | 'superseded'
  | 'held';
interface PublicationDiagnosticRow {
  catalog_material_id: string;
  team_id: string;
  policy_revision: number;
  publication_mode: PublicationMode;
  due_at: string | null;
  job_due_at: string | null;
  job_time_zone: string | null;
  requested_mode: PublicationMode | null;
  job_target_kind: TargetKind | null;
  job_source_material_id: string | null;
  job_source_version: string | null;
  job_video_set_id: string | null;
  job_recipe_revision: number | null;
  requested_generated_video_count: number | null;
  registered_generated_video_count: number | null;
  job_id: string | null;
  command_id: string | null;
  job_revision: number | null;
  job_state: PublicationJobState | null;
  blocked_reason: string | null;
  writer_fence_present: boolean;
  dispatched_at: string | null;
  lease_until: string | null;
  job_created_at: string | null;
  job_provider_revision: string | null;
  job_verified_at: string | null;
  active_verified_at: string | null;
  active_target_kind: TargetKind | null;
  legacy_delivery_unverified: boolean;
  observed_at: string;
  verified_within_cutoff: boolean;
}
interface BaselineDiagnosticRow {
  check_id: string;
  revision: number;
  job_id: string;
  state: 'reading' | 'verified' | 'aborted';
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  cell_proof_present: boolean;
  receipt_present: boolean;
  observed_at: string;
  closed_within_cutoff: boolean;
}
const PUBLICATION_FIELDS = [
  'catalog_material_id',
  'team_id',
  'policy_revision',
  'publication_mode',
  'due_at',
  'job_due_at',
  'job_time_zone',
  'requested_mode',
  'job_target_kind',
  'job_source_material_id',
  'job_source_version',
  'job_video_set_id',
  'job_recipe_revision',
  'requested_generated_video_count',
  'registered_generated_video_count',
  'job_id',
  'command_id',
  'job_revision',
  'job_state',
  'blocked_reason',
  'writer_fence_present',
  'dispatched_at',
  'lease_until',
  'job_created_at',
  'job_provider_revision',
  'job_verified_at',
  'active_verified_at',
  'active_target_kind',
  'legacy_delivery_unverified',
  'observed_at',
  'verified_within_cutoff'
] as const;
const BASELINE_FIELDS = [
  'check_id',
  'revision',
  'job_id',
  'state',
  'expires_at',
  'created_at',
  'closed_at',
  'cell_proof_present',
  'receipt_present',
  'observed_at',
  'closed_within_cutoff'
] as const;
const publicationProjection = (row: PublicationDiagnosticRow): PublicationDiagnosticRow =>
  Object.fromEntries(
    PUBLICATION_FIELDS.map(key => [key, row[key]])
  ) as unknown as PublicationDiagnosticRow;
const baselineProjection = (row: BaselineDiagnosticRow): BaselineDiagnosticRow =>
  Object.fromEntries(
    BASELINE_FIELDS.map(key => [key, row[key]])
  ) as unknown as BaselineDiagnosticRow;
function publicationRow(v: unknown): v is PublicationDiagnosticRow {
  if (
    !record(v) ||
    typeof v.catalog_material_id !== 'string' ||
    !UUID.test(v.catalog_material_id) ||
    typeof v.team_id !== 'string' ||
    !UUID.test(v.team_id) ||
    !positive(v.policy_revision) ||
    !['immediate', 'scheduled', 'held'].includes(String(v.publication_mode)) ||
    !nullableTime(v.due_at) ||
    !nullableTime(v.job_due_at) ||
    !instant(v.observed_at) ||
    typeof v.legacy_delivery_unverified !== 'boolean' ||
    typeof v.writer_fence_present !== 'boolean' ||
    typeof v.verified_within_cutoff !== 'boolean'
  )
    return false;
  if (
    (v.job_time_zone !== null &&
      (typeof v.job_time_zone !== 'string' ||
        !/^[A-Za-z0-9_+/-]{1,128}$/u.test(v.job_time_zone))) ||
    (v.requested_mode !== null &&
      !['immediate', 'scheduled', 'held'].includes(String(v.requested_mode))) ||
    (v.active_target_kind !== null &&
      !['source', 'video_set'].includes(String(v.active_target_kind))) ||
    (v.job_source_version !== null &&
      (typeof v.job_source_version !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(v.job_source_version))) ||
    (v.job_recipe_revision !== null && !positive(v.job_recipe_revision))
  )
    return false;
  if (
    v.job_id === null &&
    (v.job_revision !== null ||
      v.job_state !== null ||
      v.command_id !== null ||
      v.job_created_at !== null)
  )
    return false;
  if (
    v.blocked_reason !== null &&
    ![
      'writer_unsupported',
      'legacy_adoption_required',
      'target_unavailable',
      'job_blocked',
      'stale_job',
      'clock_unavailable',
      'invalid_due'
    ].includes(String(v.blocked_reason))
  )
    return false;
  if (
    v.job_provider_revision !== null &&
    (typeof v.job_provider_revision !== 'string' ||
      !/^(?:W\/)?"?[A-Za-z0-9._:-]{1,1000}"?$/u.test(v.job_provider_revision))
  )
    return false;
  if (
    v.job_target_kind === 'source' &&
    (typeof v.job_source_version !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(v.job_source_version))
  )
    return false;
  if (v.job_target_kind !== null && !['source', 'video_set'].includes(String(v.job_target_kind)))
    return false;
  if (
    !optionalUuid(v.job_id) ||
    !optionalUuid(v.command_id) ||
    !optionalUuid(v.job_source_material_id) ||
    !optionalUuid(v.job_video_set_id)
  )
    return false;
  if (
    v.job_id !== null &&
    (!positive(v.job_revision) ||
      !JOB_STATES.includes(String(v.job_state)) ||
      !instant(v.job_created_at))
  )
    return false;
  if (
    ![v.job_verified_at, v.active_verified_at, v.dispatched_at, v.lease_until].every(nullableTime)
  )
    return false;
  if (v.requested_generated_video_count !== null && !positive(v.requested_generated_video_count))
    return false;
  if (v.registered_generated_video_count !== null && !count(v.registered_generated_video_count))
    return false;
  if (v.requested_generated_video_count !== null && Number(v.requested_generated_video_count) > 400)
    return false;
  if (
    v.requested_generated_video_count !== null &&
    v.registered_generated_video_count !== null &&
    Number(v.registered_generated_video_count) > Number(v.requested_generated_video_count)
  )
    return false;
  return true;
}
function baselineRow(v: unknown): v is BaselineDiagnosticRow {
  return (
    record(v) &&
    typeof v.check_id === 'string' &&
    UUID.test(v.check_id) &&
    positive(v.revision) &&
    typeof v.job_id === 'string' &&
    UUID.test(v.job_id) &&
    ['reading', 'verified', 'aborted'].includes(String(v.state)) &&
    instant(v.expires_at) &&
    instant(v.created_at) &&
    instant(v.observed_at) &&
    nullableTime(v.closed_at) &&
    typeof v.cell_proof_present === 'boolean' &&
    typeof v.receipt_present === 'boolean' &&
    typeof v.closed_within_cutoff === 'boolean'
  );
}
/** Current configuration is separate from immutable job verification. Timestamp
 * comparisons run in PostgreSQL so microseconds cannot cross an as-of cutoff. */
export async function getCatalogPublicationEvidence(input: {
  id: string;
  limit?: number;
  asOf?: string;
  catalogIds?: readonly string[];
}) {
  if (!UUID.test(input.id)) throw new Error('Expected a catalog, job, command or baseline UUID.');
  const maximum = input.limit ?? 10;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50)
    throw new Error('Expected a limit from 1 to 50.');
  if (
    input.asOf !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      input.asOf
    ) ||
      !instant(input.asOf))
  )
    throw new Error('Expected an ISO observation instant.');
  if (
    input.catalogIds &&
    (input.catalogIds.length > 50 || input.catalogIds.some(id => !UUID.test(id)))
  )
    throw new Error('Invalid bounded catalog identities.');
  const cutoff = input.asOf ?? null;
  const missingSources: Array<{
    source: 'publications' | 'baselines' | 'preparation';
    reason: string;
  }> = [];
  let baselineIds: string[] = [];
  try {
    const found = await query<{ catalog_material_id: unknown }>(
      `select catalog_material_id from public.analytics_catalog_video_baselines where check_id=$1::uuid and ($2::timestamptz is null or created_at<=$2::timestamptz) limit 1`,
      [input.id, cutoff]
    );
    if (
      found.some(
        row => typeof row.catalog_material_id !== 'string' || !UUID.test(row.catalog_material_id)
      )
    )
      missingSources.push({ source: 'baselines', reason: 'malformed' });
    else baselineIds = found.map(row => row.catalog_material_id as string);
  } catch (cause) {
    const reason = unavailable(cause);
    if (!reason) throw cause;
    missingSources.push({ source: 'baselines', reason });
  }
  let rawRows: unknown[] = [];
  try {
    rawRows = await query<Record<string, unknown>>(
      `select catalog_material_id,team_id,policy_revision,publication_mode,due_at::text due_at,job_due_at,job_time_zone,requested_mode,
 job_target_kind,job_source_material_id,job_source_version,job_video_set_id,job_recipe_revision,requested_generated_video_count,registered_generated_video_count,
 job_id,command_id,job_revision,job_state,blocked_reason,writer_fence_present,dispatched_at::text dispatched_at,lease_until::text lease_until,job_created_at::text job_created_at,
 job_provider_revision,job_verified_at::text job_verified_at,active_verified_at::text active_verified_at,active_target_kind,legacy_delivery_unverified,observed_at::text observed_at,
 (job_verified_at is not null and ($3::timestamptz is null or job_verified_at<=$3::timestamptz)) verified_within_cutoff
 from public.analytics_catalog_video_publications
 where (catalog_material_id=$1::uuid or job_id=$1::uuid or command_id=$1::uuid or actor_id=$1::uuid or team_id=$1::uuid or desired_video_set_id=$1::uuid or job_video_set_id=$1::uuid or catalog_material_id=any($4::uuid[]))
 and ($3::timestamptz is null or job_created_at is null or job_created_at<=$3::timestamptz)
 order by public.analytics_catalog_video_publications.job_created_at desc nulls last limit $2`,
      [
        input.id,
        maximum,
        cutoff,
        [...new Set([...baselineIds, ...(input.catalogIds ?? [])])].slice(0, 50)
      ]
    );
  } catch (cause) {
    const reason = unavailable(cause);
    if (!reason) throw cause;
    missingSources.push({ source: 'publications', reason });
  }
  const rows = rawRows.filter(publicationRow),
    invalidRows = rawRows.length - rows.length;
  if (invalidRows) missingSources.push({ source: 'publications', reason: 'malformed' });
  const catalogIds = [...new Set([...baselineIds, ...rows.map(row => row.catalog_material_id)])];
  let rawBaselines: unknown[] = [];
  if (catalogIds.length && !missingSources.some(x => x.source === 'baselines'))
    try {
      rawBaselines = await query<Record<string, unknown>>(
        `select check_id,revision,job_id,state,expires_at::text expires_at,created_at::text created_at,closed_at::text closed_at,cell_proof_present,receipt_present,observed_at::text observed_at,
 (closed_at is not null and ($3::timestamptz is null or closed_at<=$3::timestamptz)) closed_within_cutoff
 from public.analytics_catalog_video_baselines where catalog_material_id=any($1::uuid[]) and ($3::timestamptz is null or created_at<=$3::timestamptz)
 order by public.analytics_catalog_video_baselines.expires_at desc limit $2`,
        [catalogIds, maximum, cutoff]
      );
    } catch (cause) {
      const reason = unavailable(cause);
      if (!reason) throw cause;
      missingSources.push({ source: 'baselines', reason });
    }
  const baselines = rawBaselines.filter(baselineRow),
    invalidBaselines = rawBaselines.length - baselines.length;
  const preparation: Array<{
    job_id: string;
    required_unique_links: number;
    prepared_unique_links: number;
    due_verified_unique_links: number;
    private_mapping_prepared: boolean;
    preparation_error_code: string | null;
    observed_at: string;
    source_observation_window: {
      first_at: string | null;
      last_at: string | null;
      epoch_started_at: string | null;
    };
    stage:
      | 'preparing_private_links'
      | 'binding_product_ids'
      | 'waiting_due'
      | 'validating_sources'
      | 'ready_for_sheet_dispatch'
      | 'validation_window_expired'
      | 'held'
      | 'published'
      | 'unknown';
    observation_basis: 'current_snapshot_only';
  }> = [];
  if (rows.length) {
    try {
      const pending = await query<Record<string, unknown>>(
        `select job_id,required_unique_links,prepared_unique_links,due_verified_unique_links,private_mapping_prepared,preparation_error_code,job_state,publication_mode,due_at::text due_at,validation_epoch_expired,first_source_observed_at::text first_source_observed_at,last_source_observed_at::text last_source_observed_at,validation_epoch_started_at::text validation_epoch_started_at,observed_at::text observed_at from public.analytics_catalog_publication_preparations where job_id=any($1::uuid[]) limit $2`,
        [rows.flatMap(r => (r.job_id ? [r.job_id] : [])), maximum]
      );
      for (const p of pending) {
        if (
          !nullableTime(p.first_source_observed_at) ||
          !nullableTime(p.last_source_observed_at) ||
          !nullableTime(p.validation_epoch_started_at) ||
          typeof p.validation_epoch_expired !== 'boolean' ||
          !JOB_STATES.includes(String(p.job_state)) ||
          Number(p.required_unique_links) < 1 ||
          Number(p.prepared_unique_links) > Number(p.required_unique_links) ||
          Number(p.due_verified_unique_links) > Number(p.prepared_unique_links) ||
          !instant(p.observed_at) ||
          !['held', 'scheduled', 'immediate'].includes(String(p.publication_mode)) ||
          !nullableTime(p.due_at) ||
          typeof p.job_id !== 'string' ||
          !UUID.test(p.job_id) ||
          ['required_unique_links', 'prepared_unique_links', 'due_verified_unique_links'].some(
            k => !Number.isSafeInteger(p[k]) || (p[k] as number) < 0 || (p[k] as number) > 400
          ) ||
          typeof p.private_mapping_prepared !== 'boolean' ||
          (p.preparation_error_code !== null &&
            ![
              'SOURCE_CHANGED',
              'PERMISSION_DENIED',
              'SHARE_NOT_ALLOWED',
              'DRIVE_UNAVAILABLE',
              'RATE_LIMITED',
              'PROCESS_RESULT_UNCERTAIN',
              'INVALID_RESPONSE'
            ].includes(String(p.preparation_error_code)))
        ) {
          missingSources.push({ source: 'preparation', reason: 'malformed' });
          continue;
        }
        preparation.push({
          job_id: p.job_id,
          required_unique_links: p.required_unique_links as number,
          prepared_unique_links: p.prepared_unique_links as number,
          due_verified_unique_links: p.due_verified_unique_links as number,
          private_mapping_prepared: p.private_mapping_prepared,
          preparation_error_code: p.preparation_error_code as string | null,
          observed_at: p.observed_at as string,
          source_observation_window: {
            first_at: p.first_source_observed_at as string | null,
            last_at: p.last_source_observed_at as string | null,
            epoch_started_at: p.validation_epoch_started_at as string | null
          },
          stage:
            p.job_state === 'published'
              ? 'published'
              : p.validation_epoch_expired === true
                ? 'validation_window_expired'
                : p.publication_mode === 'held'
                  ? 'held'
                  : ['unknown', 'applying', 'verifying'].includes(String(p.job_state))
                    ? 'unknown'
                    : Number(p.prepared_unique_links) < Number(p.required_unique_links)
                      ? 'preparing_private_links'
                      : p.private_mapping_prepared !== true
                        ? 'binding_product_ids'
                        : p.publication_mode === 'scheduled' &&
                            instant(p.due_at) &&
                            Date.parse(p.due_at) > Date.parse(p.observed_at as string)
                          ? 'waiting_due'
                          : Number(p.due_verified_unique_links) < Number(p.required_unique_links)
                            ? 'validating_sources'
                            : 'ready_for_sheet_dispatch',
          observation_basis: 'current_snapshot_only'
        });
      }
    } catch (cause) {
      const reason = unavailable(cause);
      if (!reason) throw cause;
      missingSources.push({ source: 'preparation', reason });
    }
  }
  if (invalidBaselines) missingSources.push({ source: 'baselines', reason: 'malformed' });
  return {
    status: rows.length
      ? ('observed' as const)
      : missingSources.length
        ? ('unavailable' as const)
        : ('not_found' as const),
    temporal_scope: {
      current_fields: 'current_snapshot_only',
      as_of_requested: cutoff,
      historical_configuration_reconstruction: false,
      immutable_verification_cutoff: 'postgres_timestamp_comparison'
    },
    preparation,
    records: rows.map(row => ({
      ...publicationProjection(row),
      configuration: 'server_accepted_current_snapshot' as const,
      provider_delivery:
        row.job_state === 'published' && row.verified_within_cutoff
          ? ('verified_settlement' as const)
          : ('not_observed' as const),
      active_delivery_basis: 'current_snapshot_only_not_reconstructed' as const,
      ui_delivery: 'not_joined' as const,
      lateness_ms: instant(row.job_due_at)
        ? Math.max(
            0,
            (instant(row.job_verified_at) && row.verified_within_cutoff
              ? Date.parse(row.job_verified_at)
              : Math.min(Date.parse(row.observed_at), cutoff ? Date.parse(cutoff) : Infinity)) -
              Date.parse(row.job_due_at)
          )
        : null
    })),
    baselines: baselines.map(row => ({
      ...baselineProjection(row),
      state_at_cutoff:
        cutoff && !row.closed_within_cutoff && row.state !== 'reading' ? 'unknown' : row.state
    })),
    invalid_record_count: invalidRows,
    invalid_baseline_count: invalidBaselines,
    missing_sources: missingSources,
    detail_limit: maximum,
    truncation:
      rows.length === maximum || baselines.length === maximum
        ? ('possibly_truncated' as const)
        : ('not_truncated' as const),
    blind_spots: [
      'Current policy and active delivery cannot reconstruct historical configuration or provider state.',
      'Provider state after its recorded verification is not observed; source and output access must be revalidated before writing.',
      'UI configuration feedback is not video delivery; visibility events are not joined by this reader.',
      ...(missingSources.length
        ? [
            'Missing or malformed sources remain unknown; empty details are not proof that no work occurred.'
          ]
        : [])
    ]
  };
}
export type CatalogPublicationEvidence = Awaited<ReturnType<typeof getCatalogPublicationEvidence>>;
