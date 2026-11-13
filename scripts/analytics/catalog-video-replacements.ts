import { query } from './db.js';
import { getSchema } from './schema.js';
import { isLaunchUuid } from '../../packages/shared/src/team/launches.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import type { InspectData } from './types.js';
import { INSPECT_AGENT_NOTE } from './types.js';
export interface CatalogVideoReplacementEvidence {
  supported: boolean;
  records: {
    request_id: string;
    catalog_material_id: string;
    publication_job_id: string | null;
    state: string;
    error_code: string | null;
    move_requested: boolean | null;
    move_dispatched: boolean | null;
    created_at: string;
    updated_at: string;
    snapshot_at_as_of: 'available' | 'unknown';
  }[];
  truncated: boolean;
  blind_spots: string[];
}
/** Current safe receipts only. Never select URL, file name, paths or frozen provider cells. */
export async function getCatalogVideoReplacementEvidence(
  id: string,
  asOf?: string
): Promise<CatalogVideoReplacementEvidence> {
  if (asOf !== undefined && !Number.isFinite(Date.parse(asOf))) throw Error('INVALID_INPUT');
  const result: CatalogVideoReplacementEvidence = {
    supported: !!(await getSchema()).tables.analytics_catalog_video_replacements,
    records: [],
    truncated: false,
    blind_spots: []
  };
  if (!result.supported) {
    result.blind_spots.push(
      'Catalog video replacement receipts are unavailable; missing events do not prove no replacement was accepted.'
    );
    return result;
  }
  if (!isLaunchUuid(id)) return result;
  const rows = await query<Record<string, unknown>>(
    `select request_id::text,catalog_material_id::text,publication_job_id::text,state,error_code,move_to_video_folder,move_dispatched,created_at::text,updated_at::text from public.analytics_catalog_video_replacements
 where (request_id=$1::uuid or team_id=$1::uuid or actor_id=$1::uuid or catalog_material_id=$1::uuid or publication_job_id=$1::uuid)and created_at<=$2::timestamptz order by created_at desc,request_id desc limit 101`,
    [id, asOf ?? '9999-12-31T23:59:59Z']
  );
  result.truncated = rows.length > 100;
  for (const r of rows.slice(0, 100)) {
    if (
      !isLaunchUuid(r.request_id) ||
      !isLaunchUuid(r.catalog_material_id) ||
      (r.publication_job_id !== null && !isLaunchUuid(r.publication_job_id)) ||
      typeof r.created_at !== 'string' ||
      typeof r.updated_at !== 'string' ||
      !Number.isFinite(Date.parse(r.created_at)) ||
      !Number.isFinite(Date.parse(r.updated_at))
    ) {
      result.blind_spots.push('Malformed receipt excluded.');
      continue;
    }
    const current = asOf === undefined || Date.parse(r.updated_at) <= Date.parse(asOf);
    result.records.push({
      request_id: r.request_id,
      catalog_material_id: r.catalog_material_id,
      publication_job_id: r.publication_job_id as string | null,
      state:
        current && ['publishing', 'moving', 'confirmed', 'blocked'].includes(String(r.state))
          ? String(r.state)
          : 'unknown',
      error_code:
        current && r.error_code !== null
          ? (TEAM_ERROR_CODES.find(c => c === r.error_code) ?? 'UNKNOWN')
          : null,
      move_requested:
        current && typeof r.move_to_video_folder === 'boolean' ? r.move_to_video_folder : null,
      move_dispatched: current && typeof r.move_dispatched === 'boolean' ? r.move_dispatched : null,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
      snapshot_at_as_of: current ? 'available' : 'unknown'
    });
  }
  result.blind_spots.push(
    'Current replacement receipts are not transition history. Confirmed binding proves verified publication and placement, not browser delivery or an advertising platform reading the feed.'
  );
  if (!result.records.length)
    result.blind_spots.push(
      'No matching server receipt is visible in this bounded projection. Missing data does not prove no accepted mutation; browser stages remain separate evidence.'
    );
  if (result.records.some(r => r.snapshot_at_as_of === 'unknown'))
    result.blind_spots.push('Receipt changed after as-of; earlier state is unknown.');
  if (result.truncated)
    result.blind_spots.push('Only the latest 100 matching receipts are included.');
  return result;
}
export function mergeCatalogVideoReplacementInspection(
  core: InspectData,
  evidence: CatalogVideoReplacementEvidence
): InspectData {
  if (!evidence.records.length)
    return core.found && core.capability === 'team.catalog_manager_replace_video'
      ? { ...core, catalog_video_replacements: evidence }
      : core;
  if (core.found) return { ...core, catalog_video_replacements: evidence };
  const confirmed = evidence.records.some(r => r.state === 'confirmed');
  const observed = [
    'accepted',
    ...(evidence.records.some(r => r.move_dispatched) ? ['move_dispatched'] : []),
    ...(confirmed ? ['binding_confirmed'] : [])
  ];
  const expected = ['accepted', 'binding_confirmed', 'result_visible'];
  return {
    ...core,
    found: true,
    matched_by: ['authoritative_table'],
    capability: 'team.catalog_manager_replace_video',
    tool: 'team',
    stages: { expected, observed, missing: expected.filter(s => !observed.includes(s)) },
    terminal: null,
    last_proven_stage: observed.at(-1)!,
    first_seen_at: evidence.records.map(r => r.created_at).sort()[0]!,
    last_seen_at: evidence.records
      .map(r => (r.snapshot_at_as_of === 'available' ? r.updated_at : r.created_at))
      .sort()
      .at(-1)!,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: INSPECT_AGENT_NOTE
    },
    events: [],
    catalog_video_replacements: evidence
  };
}
