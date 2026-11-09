import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import { query } from './db.js';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const states = [
  'prepared',
  'accepted_unbound',
  'accepted',
  'redeemed',
  'ready',
  'cancel_requested',
  'canceled',
  'expired',
  'session_revoked',
  'unknown'
] as const;
export interface CatalogVideoSessionAuthority {
  authority_id: string;
  set_id: string | null;
  team_id: string;
  actor_id: string;
  consumer_kind: 'create' | 'launch' | 'updater';
  original_request_id: string | null;
  state: (typeof states)[number];
  session_valid: boolean;
  redeemed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  safe_error_code: string | null;
}
export interface CatalogVideoSessionEvidence {
  status: 'available' | 'unavailable' | 'historical_state_unknown';
  scope: 'current_snapshot_not_transition_history';
  records: CatalogVideoSessionAuthority[];
  truncated: boolean;
  invalid_record_count: number;
  missing_sources: string[];
  blind_spots: string[];
}
/** Closed SELECT projection only: neither browser sessions nor native proof secrets are diagnostics. */
export async function getCatalogVideoSessionEvidence(
  id: string,
  asOf?: string
): Promise<CatalogVideoSessionEvidence> {
  if (!uuid(id) || (asOf !== undefined && !instant(asOf))) throw Error('INVALID_INPUT');
  const result: CatalogVideoSessionEvidence = {
    status: asOf ? 'historical_state_unknown' : 'available',
    scope: 'current_snapshot_not_transition_history',
    records: [],
    truncated: false,
    invalid_record_count: 0,
    missing_sources: [],
    blind_spots: [
      'Session validity and authority state are current observations, not reconstructed historical permission.',
      'An authority or native redemption is not proof of physical output registration or published catalog delivery.',
      'A prepared receipt alone does not prove consumer rejection or absence of accepted work; correlate its original request and server stages.',
      'Local preparation before the first server receipt requires correlated native journal evidence; absence of a row does not prove no attempt.'
    ]
  };
  if (asOf) return result;
  try {
    const rows = await query<Record<string, unknown>>(
      `select authority_id::text,set_id::text,team_id::text,actor_id::text,consumer_kind,original_request_id::text,state,session_valid,redeemed_at::text,expires_at::text,created_at::text,updated_at::text,safe_error_code
       from public.analytics_catalog_video_session_authorities
       where authority_id=$1::uuid or set_id=$1::uuid or team_id=$1::uuid or actor_id=$1::uuid or original_request_id=$1::uuid or launch_id=$1::uuid or catalog_material_id=$1::uuid
       order by created_at desc,authority_id limit 51`,
      [id]
    );
    result.truncated = rows.length > 50;
    const fields = [
      'authority_id',
      'set_id',
      'team_id',
      'actor_id',
      'consumer_kind',
      'original_request_id',
      'state',
      'session_valid',
      'redeemed_at',
      'expires_at',
      'created_at',
      'updated_at',
      'safe_error_code'
    ] as const;
    for (const row of rows.slice(0, 50)) {
      if (
        !row ||
        !['authority_id', 'team_id', 'actor_id'].every(key => uuid(row[key])) ||
        (row.set_id !== null && !uuid(row.set_id)) ||
        (row.original_request_id !== null && !uuid(row.original_request_id)) ||
        !['create', 'launch', 'updater'].includes(String(row.consumer_kind)) ||
        !states.includes(row.state as (typeof states)[number]) ||
        typeof row.session_valid !== 'boolean' ||
        (row.redeemed_at !== null && !instant(row.redeemed_at)) ||
        !instant(row.expires_at) ||
        !instant(row.created_at) ||
        !instant(row.updated_at) ||
        (row.safe_error_code !== null &&
          !TEAM_ERROR_CODES.some(code => code === row.safe_error_code)) ||
        (['accepted', 'redeemed', 'ready'].includes(String(row.state)) && !uuid(row.set_id)) ||
        (['redeemed', 'ready'].includes(String(row.state)) && !instant(row.redeemed_at)) ||
        Date.parse(String(row.updated_at)) < Date.parse(String(row.created_at)) ||
        Date.parse(String(row.expires_at)) < Date.parse(String(row.created_at))
      ) {
        result.invalid_record_count++;
        continue;
      }
      result.records.push(
        Object.fromEntries(
          fields.map(key => [key, row[key]])
        ) as unknown as CatalogVideoSessionAuthority
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
