import type { CatalogUpdateSchedule } from '../../packages/shared/src/team/catalog-updater.js';
import { query } from './db.js';
import { lookupCodeLocations } from './code-map.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Discover recent attempts without requiring a catalog UUID from the product UI. */
export async function getTeamCatalogUpdateDiagnosis(teamId: string, limit = 10) {
  if (!UUID.test(teamId)) throw new Error('Expected a team UUID.');
  const catalogs = await query<{ catalog_material_id: string }>(
    `select catalog_material_id from public.analytics_catalog_updates
     where team_id = $1::uuid
     group by catalog_material_id
     order by max(started_at) desc
     limit $2`,
    [teamId, Math.min(Math.max(limit, 1), 50)]
  );
  const diagnoses = [];
  for (const catalog of catalogs) {
    diagnoses.push(await getCatalogUpdateDiagnosis(catalog.catalog_material_id, 3));
  }
  return { team_id: teamId, catalogs: diagnoses };
}

interface CatalogAttemptRow {
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

export async function getCatalogUpdateDiagnosis(id: string, limit = 10) {
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
           video_preparation_retry_at, video_preparation_lease_until, video_operation_state, video_operation_stage
    from public.analytics_catalog_updates
    where catalog_material_id = $1::uuid or attempt_id = $1::uuid
    order by started_at desc
    limit $2
  `,
    [id, Math.min(Math.max(limit, 1), 50)]
  );
  const latest = rows[0] ?? null;
  return {
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
          at: latest.last_error_at
        }
      : null,
    video_preparation: latest?.video_preparation_state
      ? {
          state: latest.video_preparation_state,
          operation_state: latest.video_operation_state ?? null,
          operation_stage: latest.video_operation_stage ?? null,
          failure_code: latest.video_preparation_error ?? null,
          retry_at: latest.video_preparation_retry_at ?? null,
          lease_until: latest.video_preparation_lease_until ?? null
        }
      : null,
    attempts: rows.map(row => ({
      attempt_id: row.attempt_id,
      trigger: row.trigger_kind,
      started_at: row.started_at,
      ended_at: row.ended_at,
      result: row.result,
      failure_code: row.failure_code,
      code_locations: row.failure_code
        ? lookupCodeLocations(`catalog:update:${row.failure_code}`)
        : null,
      delivery_verified_at: row.delivery_verified_at,
      profile_version: row.profile_version,
      schedule: row.attempt_schedule ?? null,
      source_attempt_id: row.source_attempt_id,
      stages: row.stage_history ?? [],
      actual_changes: row.actual_changes,
      delivery_proven:
        row.delivery_verified_at !== null && (row.result === 'success' || row.result === 'partial')
    })),
    blind_spots: [
      'Video preparation exposes current queue state and failure code; historical preparation stages before a sheet claim are not retained.',
      'This authoritative catalog projection does not prove browser delivery of profile or filter changes; inspect the correlated catalog_manager UI flow. Missing UI completion is unknown.',
      ...(latest?.result === 'unknown'
        ? ['The last attempt has no conclusive delivery evidence.']
        : [])
    ]
  };
}
