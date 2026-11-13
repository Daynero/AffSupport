import { parseCatalogContentEvidence, type CatalogContentEvidence } from './catalog-content.js';
import type { ResolvedPeriod } from './types.js';
import type { CatalogUpdateSchedule } from '../../packages/shared/src/team/catalog-updater.js';
import { query } from './db.js';
import { lookupCodeLocations } from './code-map.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Discover recent attempts without requiring a catalog UUID from the product UI. */
export async function getTeamCatalogUpdateDiagnosis(
  teamId: string,
  limit = 10,
  period?: ResolvedPeriod
) {
  if (!UUID.test(teamId)) throw new Error('Expected a team UUID.');
  const catalogs = await query<{ catalog_material_id: string }>(
    `select catalog_material_id from public.analytics_catalog_updates
     where team_id = $1::uuid
       ${period ? 'and ($3::timestamptz is null or started_at >= $3::timestamptz) and started_at <= $4::timestamptz' : ''}
     group by catalog_material_id
     order by max(started_at) desc
     limit $2`,
    [teamId, Math.min(Math.max(limit, 1), 50), ...(period ? [period.start, period.end] : [])]
  );
  const diagnoses = [];
  for (const catalog of catalogs) {
    diagnoses.push(await getCatalogUpdateDiagnosis(catalog.catalog_material_id, 3, period));
  }
  return { team_id: teamId, catalogs: diagnoses };
}

interface CatalogAttemptRow extends Partial<CatalogContentEvidence> {
  attempt_id: string;
  catalog_material_id: string;
  team_id: string;
  trigger_kind: string;
  started_at: string;
  ended_at: string | null;
  result: string;
  failure_code: string | null;
  delivery_verified_at: string | null;
  profile_version: number | null;
  source_attempt_id: string | null;
  stage_history: Array<{ stage: string; at: string }> | null;
  actual_changes: Record<string, boolean> | null;
  current_profile_version: number;
  update_interval: string | null;
  next_run_at: string | null;
  schedule?: CatalogUpdateSchedule | null;
  attempt_schedule?: CatalogUpdateSchedule | null;
  reconciliation_required: boolean | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  video_preparation_state?: string | null;
  video_operation_state?: string | null;
  video_operation_stage?: string | null;
  video_preparation_error?: string | null;
  video_preparation_retry_at?: string | null;
  video_preparation_lease_until?: string | null;
}

export async function getCatalogUpdateDiagnosis(id: string, limit = 10, period?: ResolvedPeriod) {
  if (!UUID.test(id)) throw new Error('Expected a catalog or attempt UUID.');
  const rows = await query<CatalogAttemptRow>(
    `
    select attempt_id, catalog_material_id, team_id, trigger_kind,
           started_at, ended_at, result, failure_code, delivery_verified_at,
           profile_version, source_attempt_id, stage_history, actual_changes,
           current_profile_version,
           update_interval, next_run_at, reconciliation_required, schedule, attempt_schedule,
           last_success_at, last_error_code, last_error_at,
           video_preparation_state, video_preparation_error,
           video_preparation_retry_at, video_preparation_lease_until, video_operation_state, video_operation_stage,
           to_jsonb(a)->'content_receipt_status' content_receipt_status,
           to_jsonb(a)->'content_policy_version' content_policy_version,
           to_jsonb(a)->'planned_row_count' planned_row_count,
           to_jsonb(a)->'automatic_row_count' automatic_row_count,
           to_jsonb(a)->'retained_row_count' retained_row_count
    from public.analytics_catalog_updates a
    where (catalog_material_id = $1::uuid or attempt_id = $1::uuid)
      ${period ? 'and ($3::timestamptz is null or started_at >= $3::timestamptz) and started_at <= $4::timestamptz' : ''}
    order by started_at desc
    limit $2
  `,
    [id, Math.min(Math.max(limit, 1), 50), ...(period ? [period.start, period.end] : [])]
  );
  const latest = rows[0] ?? null;
  // Optional projection: old deployments must report missing coverage explicitly.
  const available = await query<{ present: boolean }>(
    `select exists(select 1 from information_schema.views
      where table_schema='public' and table_name='analytics_catalog_claim_eligibility') as present`
  );
  const eligibility =
    !period?.as_of && available[0]?.present === true
      ? await query<Record<string, unknown>>(
          `select catalog_id, team_id, blockers, open_operations, prior_operations, native_claimants, native_claimants_truncated, observed_at from public.analytics_catalog_claim_eligibility where catalog_id=$1::uuid`,
          [latest?.catalog_material_id ?? id]
        )
      : null;
  const historical = Boolean(period?.as_of);
  const endedInWindow = (row: CatalogAttemptRow) =>
    !period || Boolean(row.ended_at && Date.parse(row.ended_at) <= Date.parse(period.end));
  return {
    temporal_scope: {
      attempts: period ? 'started_at_in_requested_window' : 'bounded_recent_attempts',
      current_fields: ['profile', 'last_success_at', 'last_error', 'video_preparation'],
      current_fields_basis: 'current_snapshot_only',
      observed_at: new Date().toISOString(),
      as_of: period?.as_of ?? null
    },
    claim_eligibility: {
      status: eligibility === null ? 'unavailable' : eligibility.length ? 'observed' : 'not_found',
      temporal_scope: 'current_snapshot_only',
      evidence: eligibility?.[0] ?? null
    },
    subject: latest ? { catalog_id: latest.catalog_material_id, team_id: latest.team_id } : null,
    profile: latest
      ? {
          version: latest.current_profile_version,
          interval: latest.update_interval,
          schedule: latest.schedule ?? null,
          next_run_at: latest.next_run_at,
          reconciliation_required: latest.reconciliation_required === true
        }
      : null,
    last_success_at: latest?.last_success_at ?? null,
    last_error: latest?.last_error_code
      ? {
          code: latest.last_error_code,
          at: latest.last_error_at,
          code_locations: lookupCodeLocations(`catalog:update:${latest.last_error_code}`)
        }
      : null,
    video_preparation: latest?.video_preparation_state
      ? {
          state: latest.video_preparation_state,
          operation_state: latest.video_operation_state ?? null,
          operation_stage: latest.video_operation_stage ?? null,
          failure_code: latest.video_preparation_error ?? null,
          code_locations: latest.video_preparation_error
            ? lookupCodeLocations(`catalog:video:${latest.video_preparation_error}`)
            : null,
          retry_blocked_by_open_operation:
            latest.video_preparation_state === 'queued' &&
            ['pending', 'running'].includes(latest.video_operation_state ?? ''),
          retry_at: latest.video_preparation_retry_at ?? null,
          lease_until: latest.video_preparation_lease_until ?? null
        }
      : null,
    attempts: rows.map(row => ({
      ...parseCatalogContentEvidence(historical && !endedInWindow(row) ? {} : row),
      attempt_id: row.attempt_id,
      trigger: row.trigger_kind,
      started_at: row.started_at,
      ended_at: endedInWindow(row) ? row.ended_at : null,
      result: historical && !endedInWindow(row) ? 'unknown' : row.result,
      failure_code: endedInWindow(row) ? row.failure_code : null,
      code_locations:
        endedInWindow(row) && row.failure_code
          ? lookupCodeLocations(`catalog:update:${row.failure_code}`)
          : null,
      delivery_verified_at:
        !period ||
        (row.delivery_verified_at && Date.parse(row.delivery_verified_at) <= Date.parse(period.end))
          ? row.delivery_verified_at
          : null,
      profile_version: row.profile_version,
      schedule: row.attempt_schedule ?? null,
      source_attempt_id: row.source_attempt_id,
      stages: (row.stage_history ?? []).filter(
        stage => !period || Date.parse(stage.at) <= Date.parse(period.end)
      ),
      actual_changes: historical && !endedInWindow(row) ? null : row.actual_changes,
      delivery_proven:
        Boolean(row.delivery_verified_at) &&
        (!period || Date.parse(row.delivery_verified_at!) <= Date.parse(period.end)) &&
        endedInWindow(row) &&
        (row.result === 'success' || row.result === 'partial')
    })),
    blind_spots: [
      ...(historical
        ? [
            'Current profile, last error/success and video preparation are live snapshots, not reconstructed as-of state. Attempts without a terminal at the cutoff remain unknown.'
          ]
        : []),
      ...(eligibility === null
        ? [
            'Server claim eligibility is not exposed by this deployment; an empty native claim does not explain why work was withheld.'
          ]
        : []),
      'Content receipts describe the frozen attempt only. Automatic counts exclude retained rows, even if those rows were generated automatically by an older attempt. Receipt quality never changes the recorded operation outcome or proves browser visibility.',
      ...(rows.some(row => parseCatalogContentEvidence(row).content_receipt_status === 'invalid')
        ? ['Some content receipts are invalid; their counts and policy remain unknown.']
        : []),
      ...(rows.some(
        row => parseCatalogContentEvidence(row).content_receipt_status === 'unavailable'
      )
        ? ['Some attempts have no available content receipt; their content policy is unknown.']
        : []),
      'Claim eligibility describes current predicates, not historical claim decisions or proof of execution.',
      'Video preparation exposes current queue state and failure code; historical preparation stages before a sheet claim are not retained.',
      'This authoritative catalog projection does not prove browser delivery of profile or filter changes; inspect the correlated catalog_manager UI flow. Missing UI completion is unknown.',
      ...(latest?.result === 'unknown'
        ? ['The last attempt has no conclusive delivery evidence.']
        : [])
    ]
  };
}

/** Bounded live evidence for owned teams; never reconstruct history from today's queue. */
export async function getOwnedCatalogClaimEvidence(userId: string | null, asOf?: string) {
  const scope = 'owned_teams_current_snapshot_only' as const;
  if (!userId || asOf)
    return {
      scope,
      status: 'unavailable',
      records: [],
      truncated: false,
      blind_spots: [
        asOf
          ? 'Historical catalog claim eligibility is not retained.'
          : 'Catalog claim owner identity is unresolved.'
      ]
    };
  const available = await query<{ present: boolean }>(
    `select exists(select 1 from information_schema.views where table_schema='public'
      and table_name='analytics_catalog_claim_eligibility') as present`
  );
  if (available[0]?.present !== true)
    return {
      scope,
      status: 'unavailable',
      records: [],
      truncated: false,
      blind_spots: ['Catalog claim eligibility projection is unavailable on this deployment.']
    };
  const records = await query<{ catalog_id: string; blockers: string[]; observed_at: string }>(
    `select catalog_id, team_id, blockers, open_operations, prior_operations, native_claimants,
      native_claimants_truncated, observed_at from public.analytics_catalog_claim_eligibility
      where owner_id=$1::uuid and job_state='queued' order by catalog_id limit 51`,
    [userId]
  );
  return {
    scope,
    status: 'observed',
    records: records
      .slice(0, 50)
      .map(record => ({ ...record, observed_at: new Date(record.observed_at).toISOString() })),
    truncated: records.length > 50,
    blind_spots: [
      'Only current queued catalogs in owned teams are included; member-only teams and historical claim decisions are unobserved.'
    ]
  };
}
