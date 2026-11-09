import { query } from './db.js';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
export interface CatalogGrowthRecord {
  attempt_id: string;
  team_id: string;
  actor_id: string;
  catalog_material_id: string;
  command_id: string;
  base_revision: number;
  base_product_count: number;
  product_count: number;
  target_kind: 'source' | 'video_set';
  video_set_id: string | null;
  recipe_revision: number | null;
  target_bound: boolean;
  applied_at: string | null;
}
export interface CatalogGrowthEvidence {
  status: 'available' | 'unavailable' | 'historical_state_unknown';
  scope: 'current_snapshot_not_transition_history';
  records: CatalogGrowthRecord[];
  truncated: boolean;
  invalid_record_count: number;
  missing_sources: string[];
}
/** Read only the content-free attempt-to-publication join; never frozen recipes or URLs. */
export async function getCatalogGrowthEvidence(
  id: string,
  asOf?: string
): Promise<CatalogGrowthEvidence> {
  if (!uuid(id) || (asOf !== undefined && !Number.isFinite(Date.parse(asOf))))
    throw Error('INVALID_INPUT');
  const result: CatalogGrowthEvidence = {
    status: asOf ? 'historical_state_unknown' : 'available',
    scope: 'current_snapshot_not_transition_history',
    records: [],
    truncated: false,
    invalid_record_count: 0,
    missing_sources: []
  };
  if (asOf) return result;
  try {
    const rows = await query<Record<string, unknown>>(
      `select attempt_id::text,team_id::text,actor_id::text,catalog_material_id::text,command_id::text,
      base_revision,base_product_count,product_count,target_kind,video_set_id::text,recipe_revision,target_bound,applied_at::text
      from public.analytics_catalog_growth_video_recipes
      where attempt_id=$1::uuid or team_id=$1::uuid or actor_id=$1::uuid or catalog_material_id=$1::uuid or command_id=$1::uuid or video_set_id=$1::uuid
      order by attempt_id limit 51`,
      [id]
    );
    result.truncated = rows.length > 50;
    for (const row of rows.slice(0, 50)) {
      if (
        !row ||
        !['attempt_id', 'team_id', 'actor_id', 'catalog_material_id', 'command_id'].every(k =>
          uuid(row[k])
        ) ||
        !positive(row.base_revision) ||
        !positive(row.base_product_count, 400) ||
        !positive(row.product_count, 400) ||
        Number(row.product_count) < Number(row.base_product_count) ||
        !['source', 'video_set'].includes(String(row.target_kind)) ||
        (row.target_kind === 'source'
          ? row.video_set_id !== null || row.recipe_revision !== null
          : !uuid(row.video_set_id) || !positive(row.recipe_revision)) ||
        typeof row.target_bound !== 'boolean' ||
        (row.applied_at !== null &&
          (typeof row.applied_at !== 'string' || !Number.isFinite(Date.parse(row.applied_at)))) ||
        row.target_bound !== (row.applied_at !== null)
      ) {
        result.invalid_record_count++;
        continue;
      }
      result.records.push(
        Object.fromEntries(
          [
            'attempt_id',
            'team_id',
            'actor_id',
            'catalog_material_id',
            'command_id',
            'base_revision',
            'base_product_count',
            'product_count',
            'target_kind',
            'video_set_id',
            'recipe_revision',
            'target_bound',
            'applied_at'
          ].map(key => [key, row[key]])
        ) as unknown as CatalogGrowthRecord
      );
    }
    if (result.invalid_record_count) result.status = 'unavailable';
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;
    result.status = 'unavailable';
    result.missing_sources.push(
      code === '42501'
        ? 'read_denied'
        : code === '42P01' || code === '42703'
          ? 'schema_missing'
          : code === '57014' || code === 'ANALYTICS_QUERY_TIMEOUT'
            ? 'timeout'
            : 'query_failed'
    );
  }
  return result;
}
