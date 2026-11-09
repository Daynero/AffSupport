import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import { query } from './db.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const states = new Set([
  'accepted',
  'preparing',
  'ready',
  'cancel_requested',
  'canceled',
  'unknown'
]);
const childStates = new Set(['queued', 'working', 'unknown', 'registered']);
const operationStates = new Set(['pending', 'running', 'succeeded', 'failed', 'canceled']);
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idOrNull = (value: unknown) =>
  value === null || (typeof value === 'string' && UUID.test(value));
const count = (value: unknown, maximum = 400) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const instant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export interface CatalogVideoSetRecord {
  video_set_id: string;
  state: string;
  requested_count: number;
  product_count: number;
  registered_count: number;
  working_count: number;
  unknown_count: number;
  queued_count: number;
  catalog_material_id: string | null;
  catalog_intent_id: string | null;
  update_attempt_id: string | null;
  recipe_revision: number;
  executor_bound: boolean;
  native_boot_observed: boolean;
  created_at: string;
  updated_at: string;
}
export interface CatalogVideoChildRecord {
  video_set_id: string;
  video_variant_index: number;
  request_id: string;
  operation_id: string | null;
  state: string;
  output_registered: boolean;
  operation_state: string | null;
  registration_chain: 'proved' | 'unknown';
}
export interface CatalogVideoManagerRequest {
  request_id: string;
  video_set_id: string;
  catalog_material_id: string;
  attempt_id: string;
  requested_count: number;
  profile_version: number;
  created_at: string;
  canceled: boolean;
  set_admission_missing: boolean;
  state: string;
  failure_observed: boolean;
  safe_failure_code: string | null;
  last_proven_stage: 'admitted' | 'source_proven' | 'set_admitted';
}
export interface CatalogVideoConsumer {
  reference_id: string;
  video_set_id: string;
  recipe_revision: number;
  product_count: number;
  catalog_material_id: string | null;
  catalog_intent_id: string | null;
  update_attempt_id: string | null;
}
export interface CatalogVideoSetEvidence {
  status: 'available' | 'unavailable' | 'historical_state_unknown';
  scope: 'current_snapshot_not_transition_history';
  records: CatalogVideoSetRecord[];
  children: CatalogVideoChildRecord[];
  commands: CatalogVideoManagerRequest[];
  consumers: CatalogVideoConsumer[];
  truncated: boolean;
  invalid_record_count: number;
  missing_sources: string[];
  browser_delivery: 'not_joined';
}
/** A set's registered outputs are not proof that its catalog reached the browser. */
export async function getCatalogVideoSetEvidence(
  id: string,
  asOf?: string
): Promise<CatalogVideoSetEvidence> {
  if (!UUID.test(id) || (asOf !== undefined && !Number.isFinite(Date.parse(asOf))))
    throw Error('INVALID_INPUT');
  const result: CatalogVideoSetEvidence = {
    status: asOf ? 'historical_state_unknown' : 'available',
    scope: 'current_snapshot_not_transition_history',
    records: [],
    children: [],
    commands: [],
    consumers: [],
    truncated: false,
    invalid_record_count: 0,
    missing_sources: [],
    browser_delivery: 'not_joined'
  };
  if (asOf) return result;
  try {
    const rows = await query<Record<string, unknown>>(
      `select s.video_set_id::text,s.state,s.requested_count,s.product_count,s.registered_count,s.working_count,s.unknown_count,s.queued_count,s.catalog_material_id::text,s.catalog_intent_id::text,s.update_attempt_id::text,s.recipe_revision,s.executor_bound,s.native_boot_observed,s.created_at::text,s.updated_at::text
      from public.analytics_catalog_video_sets s
      where s.video_set_id=$1::uuid or s.team_id=$1::uuid or s.actor_id=$1::uuid or s.catalog_material_id=$1::uuid or s.catalog_intent_id=$1::uuid or s.update_attempt_id=$1::uuid
      or exists(select 1 from public.analytics_catalog_video_children c where c.video_set_id=s.video_set_id and (c.request_id=$1::uuid or c.operation_id=$1::uuid))
      or exists(select 1 from public.analytics_catalog_video_consumers consumer where consumer.video_set_id=s.video_set_id and (consumer.catalog_material_id=$1::uuid or consumer.catalog_intent_id=$1::uuid or consumer.update_attempt_id=$1::uuid or consumer.actor_id=$1::uuid))
      order by s.updated_at desc,s.video_set_id limit 51`,
      [id]
    );
    result.truncated = rows.length > 50;
    for (const row of rows.slice(0, 50)) {
      if (
        !object(row) ||
        typeof row.video_set_id !== 'string' ||
        !UUID.test(row.video_set_id) ||
        !states.has(String(row.state)) ||
        !count(row.requested_count) ||
        Number(row.requested_count) < 1 ||
        !count(row.product_count) ||
        Number(row.requested_count) > Number(row.product_count) ||
        !['registered_count', 'working_count', 'unknown_count', 'queued_count'].every(key =>
          count(row[key], Number(row.requested_count))
        ) ||
        ['registered_count', 'working_count', 'unknown_count', 'queued_count'].reduce(
          (sum, key) => sum + Number(row[key]),
          0
        ) !== row.requested_count ||
        !['catalog_material_id', 'catalog_intent_id', 'update_attempt_id'].every(key =>
          idOrNull(row[key])
        ) ||
        !Number.isSafeInteger(row.recipe_revision) ||
        Number(row.recipe_revision) < 1 ||
        typeof row.executor_bound !== 'boolean' ||
        typeof row.native_boot_observed !== 'boolean' ||
        !instant(row.created_at) ||
        !instant(row.updated_at)
      ) {
        result.invalid_record_count++;
        continue;
      }
      result.records.push(
        Object.fromEntries(
          [
            'video_set_id',
            'state',
            'requested_count',
            'product_count',
            'registered_count',
            'working_count',
            'unknown_count',
            'queued_count',
            'catalog_material_id',
            'catalog_intent_id',
            'update_attempt_id',
            'recipe_revision',
            'executor_bound',
            'native_boot_observed',
            'created_at',
            'updated_at'
          ].map(key => [key, row[key]])
        ) as unknown as CatalogVideoSetRecord
      );
    }
    if (result.records.length) {
      const children = await query<Record<string, unknown>>(
        `select video_set_id::text,video_variant_index,request_id::text,operation_id::text,state,output_registered,operation_state from public.analytics_catalog_video_children where video_set_id=any($1::uuid[]) order by video_set_id,video_variant_index limit 401`,
        [result.records.map(row => row.video_set_id)]
      );
      if (children.length > 400) result.truncated = true;
      for (const row of children.slice(0, 400)) {
        if (
          !object(row) ||
          typeof row.video_set_id !== 'string' ||
          !result.records.some(parent => parent.video_set_id === row.video_set_id) ||
          !count(row.video_variant_index, 399) ||
          typeof row.request_id !== 'string' ||
          !UUID.test(row.request_id) ||
          !idOrNull(row.operation_id) ||
          !childStates.has(String(row.state)) ||
          typeof row.output_registered !== 'boolean' ||
          (row.state === 'registered') !== row.output_registered ||
          (row.operation_state !== null && !operationStates.has(String(row.operation_state)))
        ) {
          result.invalid_record_count++;
          continue;
        }
        result.children.push(
          Object.assign(
            Object.fromEntries(
              [
                'video_set_id',
                'video_variant_index',
                'request_id',
                'operation_id',
                'state',
                'output_registered',
                'operation_state'
              ].map(key => [key, row[key]])
            ) as unknown as Omit<CatalogVideoChildRecord, 'registration_chain'>,
            {
              registration_chain:
                row.state === 'registered' &&
                row.operation_id !== null &&
                row.operation_state === 'succeeded'
                  ? ('proved' as const)
                  : ('unknown' as const)
            }
          )
        );
      }
    }
  } catch (cause) {
    result.status = 'unavailable';
    const code = object(cause) ? cause.code : null;
    result.missing_sources.push(
      code === 'ANALYTICS_QUERY_TIMEOUT' || code === '57014'
        ? 'timeout'
        : code === '42501'
          ? 'read_denied'
          : code === '42P01' || code === '42703'
            ? 'schema_missing'
            : 'query_failed'
    );
  }
  if (result.records.length)
    try {
      const consumers = await query<Record<string, unknown>>(
        `select reference_id::text,video_set_id::text,recipe_revision,product_count,catalog_material_id::text,catalog_intent_id::text,update_attempt_id::text from public.analytics_catalog_video_consumers where video_set_id=any($1::uuid[]) order by reference_id limit 101`,
        [result.records.map(row => row.video_set_id)]
      );
      if (consumers.length > 100) result.truncated = true;
      for (const row of consumers.slice(0, 100)) {
        if (
          !object(row) ||
          typeof row.reference_id !== 'string' ||
          !UUID.test(row.reference_id) ||
          typeof row.video_set_id !== 'string' ||
          !result.records.some(parent => parent.video_set_id === row.video_set_id) ||
          !Number.isSafeInteger(row.recipe_revision) ||
          Number(row.recipe_revision) < 1 ||
          !count(row.product_count) ||
          Number(row.product_count) < 1 ||
          !['catalog_material_id', 'catalog_intent_id', 'update_attempt_id'].every(key =>
            idOrNull(row[key])
          )
        ) {
          result.invalid_record_count++;
          continue;
        }
        result.consumers.push(
          Object.fromEntries(
            [
              'reference_id',
              'video_set_id',
              'recipe_revision',
              'product_count',
              'catalog_material_id',
              'catalog_intent_id',
              'update_attempt_id'
            ].map(key => [key, row[key]])
          ) as unknown as CatalogVideoConsumer
        );
      }
    } catch {
      result.status = 'unavailable';
      result.missing_sources.push('consumers_unavailable');
    }
  try {
    const commands = await query<Record<string, unknown>>(
      `select request_id::text,video_set_id::text,catalog_material_id::text,attempt_id::text,requested_count,profile_version,created_at::text,canceled,set_admission_missing,state,failure_observed,safe_failure_code,last_proven_stage from public.analytics_catalog_updater_video_requests where request_id=$1::uuid or video_set_id=$1::uuid or catalog_material_id=$1::uuid or attempt_id=$1::uuid or actor_id=$1::uuid or team_id=$1::uuid order by created_at desc,request_id limit 51`,
      [id]
    );
    if (commands.length > 50) result.truncated = true;
    for (const row of commands.slice(0, 50)) {
      if (
        !object(row) ||
        !['request_id', 'video_set_id', 'catalog_material_id', 'attempt_id'].every(
          key => typeof row[key] === 'string' && UUID.test(row[key] as string)
        ) ||
        !count(row.requested_count) ||
        Number(row.requested_count) < 1 ||
        !Number.isSafeInteger(row.profile_version) ||
        Number(row.profile_version) < 1 ||
        !instant(row.created_at) ||
        !['canceled', 'set_admission_missing', 'failure_observed'].every(
          key => typeof row[key] === 'boolean'
        ) ||
        !states.has(String(row.state)) ||
        !['admitted', 'source_proven', 'set_admitted'].includes(String(row.last_proven_stage)) ||
        (row.safe_failure_code !== null &&
          !(TEAM_ERROR_CODES as readonly unknown[]).includes(row.safe_failure_code))
      ) {
        result.invalid_record_count++;
        continue;
      }
      result.commands.push(
        Object.fromEntries(
          [
            'request_id',
            'video_set_id',
            'catalog_material_id',
            'attempt_id',
            'requested_count',
            'profile_version',
            'created_at',
            'canceled',
            'set_admission_missing',
            'state',
            'failure_observed',
            'safe_failure_code',
            'last_proven_stage'
          ].map(key => [key, row[key]])
        ) as unknown as CatalogVideoManagerRequest
      );
    }
  } catch (cause) {
    result.status = 'unavailable';
    const code = object(cause) ? cause.code : null;
    result.missing_sources.push(
      code === 'ANALYTICS_QUERY_TIMEOUT' || code === '57014'
        ? 'commands_timeout'
        : code === '42501'
          ? 'commands_read_denied'
          : code === '42P01' || code === '42703'
            ? 'commands_schema_missing'
            : 'commands_query_failed'
    );
  }
  if (result.invalid_record_count) result.status = 'unavailable';
  return result;
}
