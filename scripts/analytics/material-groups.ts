import { query } from './db.js';
import { getSchema } from './schema.js';
import type { InspectData } from './types.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STATES = [
  'registered',
  'legacy_unknown',
  'dispatch_unconfirmed',
  'provider_confirmed',
  'accepted',
  'retryable_no_pending',
  'executor_reserved'
] as const;
const CODES = new Set<string>(TEAM_ERROR_CODES);
export interface MaterialGroupRecord {
  id: string;
  operation_id: string;
  team_id: string;
  action: 'move' | 'trash' | 'restore';
  state: (typeof STATES)[number];
  code: string | null;
  member_count: number;
  confirmed_count: number;
  has_unconfirmed_dispatch: boolean;
  created_at: string;
  updated_at: string;
}
export interface MaterialGroupEvidence {
  supported: boolean;
  records: MaterialGroupRecord[];
  blind_spots: string[];
}
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
/** Immutable SQL variants, opaque selectors and SELECT only. Current rows never reconstruct history. */
export async function getMaterialGroupEvidence(input: {
  actorId?: string | null;
  ids?: readonly string[];
  since?: string | null;
  asOf: string;
}): Promise<MaterialGroupEvidence> {
  const schema = await getSchema();
  if (!schema.tables.analytics_material_group_execution)
    return {
      supported: false,
      records: [],
      blind_spots: [
        'Material-group execution projection is unavailable; a prior receipt cannot prove provider nonexecution or delivery.'
      ]
    };
  const ids = [
    ...new Set((input.ids ?? []).filter(id => UUID.test(id)).map(id => id.toLowerCase()))
  ].slice(0, 100);
  const actor = input.actorId && UUID.test(input.actorId) ? input.actorId.toLowerCase() : null;
  if (!actor && !ids.length) return { supported: true, records: [], blind_spots: [] };
  let rows: Record<string, unknown>[];
  try {
    rows = await query<Record<string, unknown>>(
      'select id::text,operation_id::text,team_id::text,actor_id::text,action,state,code,member_count,confirmed_count,has_unconfirmed_dispatch,created_at::text,updated_at::text from public.analytics_material_group_execution where ($1::uuid is null or actor_id=$1::uuid) and ($2::uuid[] is null or id=any($2::uuid[]) or operation_id=any($2::uuid[])) and ($3::timestamptz is null or created_at >= $3::timestamptz) and updated_at <= $4::timestamptz order by updated_at desc,id limit 101',
      [actor, ids.length ? ids : null, input.since ?? null, input.asOf]
    );
  } catch {
    return {
      supported: true,
      records: [],
      blind_spots: [
        'Material-group execution read failed; its provider reservation and result remain unknown.'
      ]
    };
  }
  const records: MaterialGroupRecord[] = [];
  let malformed = false,
    unknown = false;
  for (const row of rows.slice(0, 100)) {
    if (
      typeof row.id !== 'string' ||
      !UUID.test(row.id) ||
      typeof row.operation_id !== 'string' ||
      !UUID.test(row.operation_id) ||
      typeof row.team_id !== 'string' ||
      !UUID.test(row.team_id) ||
      typeof row.actor_id !== 'string' ||
      !UUID.test(row.actor_id) ||
      (actor && row.actor_id !== actor) ||
      (ids.length && !ids.includes(row.id) && !ids.includes(row.operation_id)) ||
      typeof row.action !== 'string' ||
      !['move', 'trash', 'restore'].includes(row.action) ||
      !STATES.includes(row.state as (typeof STATES)[number]) ||
      !Number.isSafeInteger(row.member_count) ||
      Number(row.member_count) < 1 ||
      Number(row.member_count) > 100 ||
      !Number.isSafeInteger(row.confirmed_count) ||
      Number(row.confirmed_count) < 0 ||
      Number(row.confirmed_count) > Number(row.member_count) ||
      typeof row.has_unconfirmed_dispatch !== 'boolean' ||
      !timestamp(row.created_at) ||
      !timestamp(row.updated_at) ||
      (row.code !== null && typeof row.code !== 'string') ||
      (row.state === 'dispatch_unconfirmed' && !row.has_unconfirmed_dispatch) ||
      (row.has_unconfirmed_dispatch &&
        (row.state !== 'dispatch_unconfirmed' || row.confirmed_count === row.member_count)) ||
      (['provider_confirmed', 'registered'].includes(String(row.state)) &&
        Number(row.confirmed_count) !== Number(row.member_count))
    ) {
      malformed = true;
      continue;
    }
    const code =
      row.code === null ? null : CODES.has(String(row.code)) ? String(row.code) : 'UNKNOWN';
    if (code === 'UNKNOWN') unknown = true;
    records.push({
      id: row.id,
      operation_id: row.operation_id,
      team_id: row.team_id,
      action: row.action as MaterialGroupRecord['action'],
      state: row.state as MaterialGroupRecord['state'],
      code,
      member_count: Number(row.member_count),
      confirmed_count: Number(row.confirmed_count),
      has_unconfirmed_dispatch: row.has_unconfirmed_dispatch,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  return {
    supported: true,
    records,
    blind_spots: [
      'A reserved member does not prove that a provider write started. Confirmed members do not prove whole-group registration or browser delivery.',
      'This bounded projection exposes current state only; rows changed after as-of are omitted, not reconstructed.',
      ...(rows.length > 100 ? ['Material-group evidence truncated at 100 records.'] : []),
      ...((input.ids?.length ?? 0) > 100
        ? ['Material-group selectors truncated at 100 identities.']
        : []),
      ...(malformed
        ? [
            'Malformed or conflicting material-group evidence was omitted; its outcome remains unknown.'
          ]
        : []),
      ...(unknown ? ['An unrecognized material-group cause remains UNKNOWN.'] : [])
    ]
  };
}
export function mergeMaterialGroupInspection(
  core: InspectData,
  evidence: MaterialGroupEvidence
): InspectData {
  if (!evidence.records.length)
    return core.found && core.capability?.startsWith('team.workspace_')
      ? { ...core, material_groups: evidence }
      : core;
  if (core.found) return { ...core, material_groups: evidence };
  const latest = evidence.records[0]!;
  const stage =
    latest.state === 'dispatch_unconfirmed'
      ? 'dispatch_reserved'
      : latest.state === 'legacy_unknown'
        ? 'legacy_intent_observed'
        : latest.state;
  const expected = [
    'accepted',
    'executor_reserved',
    'dispatch_reserved',
    'provider_confirmed',
    'registered',
    'result_visible'
  ];
  return {
    found: true,
    id: core.id,
    matched_by: ['authoritative_table'],
    capability: 'team.material_group',
    tool: 'team',
    stages: {
      expected,
      observed: [stage],
      missing: expected.filter(value => value !== stage)
    },
    terminal: null,
    last_proven_stage: stage,
    first_seen_at: evidence.records.at(-1)?.created_at ?? null,
    last_seen_at: latest.updated_at,
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
      note: 'A hosted group receipt proves neither native execution nor browser delivery.'
    },
    events: [],
    material_groups: evidence
  };
}
