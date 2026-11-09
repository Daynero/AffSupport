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
  claim_protocol: 1 | 2 | null;
  execution_epoch: number | null;
  created_at: string;
  updated_at: string;
}
export interface MaterialHistoricalObservation {
  id: string;
  operation_id: string;
  team_id: string;
  action: 'trash' | 'restore';
  basis: 'catalog_snapshot';
  observed_at: string;
  state: 'matches' | 'changed' | 'unknown';
  member_count: number;
  matching_count: number;
  missing_count: number;
}
export interface MaterialHistoricalEvidence {
  basis: 'current_catalog_snapshot_only';
  status: 'observed' | 'read_failed' | 'malformed';
  records: MaterialHistoricalObservation[];
  blind_spots: string[];
}
export interface MaterialGroupEvidence {
  supported: boolean;
  records: MaterialGroupRecord[];
  historical_observations?: MaterialHistoricalEvidence;
  blind_spots: string[];
}
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
async function readHistoricalObservations(
  actor: string | null,
  ids: string[],
  since: string | null,
  asOf: string
): Promise<MaterialHistoricalEvidence> {
  const limitations = [
    'These are current catalog lifecycle and placement observations, not current provider verification or reconstructed state at as-of. Original receipt completion and UI delivery are independent evidence.'
  ];
  if (!ids.length)
    return {
      basis: 'current_catalog_snapshot_only',
      status: 'observed',
      records: [],
      blind_spots: limitations
    };
  let rows: Record<string, unknown>[];
  try {
    rows = await query<Record<string, unknown>>(
      'select id::text,operation_id::text,team_id::text,actor_id::text,action,basis,observed_at::text,state,member_count,matching_count,missing_count from public.analytics_material_historical_observations where ($1::uuid is null or actor_id=$1::uuid) and ($2::uuid[] is null or id=any($2::uuid[]) or operation_id=any($2::uuid[])) and ($3::timestamptz is null or created_at >= $3::timestamptz) and updated_at <= $4::timestamptz order by updated_at desc,id limit 101',
      [actor, ids.length ? ids : null, since, asOf]
    );
  } catch {
    return {
      basis: 'current_catalog_snapshot_only',
      status: 'read_failed',
      records: [],
      blind_spots: [
        ...limitations,
        'Historical material observation read failed; current generation remains unknown.'
      ]
    };
  }
  const records: MaterialHistoricalObservation[] = [];
  let malformed = false;
  for (const row of rows.slice(0, 100)) {
    const total = Number(row.member_count),
      matching = Number(row.matching_count),
      missing = Number(row.missing_count);
    if (
      (ids.length > 0 &&
        !ids.includes(String(row.id)) &&
        !ids.includes(String(row.operation_id))) ||
      ['member_count', 'matching_count', 'missing_count'].some(
        key => typeof row[key] !== 'number'
      ) ||
      !UUID.test(String(row.id)) ||
      !UUID.test(String(row.operation_id)) ||
      !UUID.test(String(row.team_id)) ||
      (actor && row.actor_id !== actor) ||
      !['trash', 'restore'].includes(String(row.action)) ||
      row.basis !== 'catalog_snapshot' ||
      !timestamp(row.observed_at) ||
      !['matches', 'changed', 'unknown'].includes(String(row.state)) ||
      ![total, matching, missing].every(Number.isSafeInteger) ||
      total < 1 ||
      total > 5000 ||
      matching < 0 ||
      missing < 0 ||
      matching + missing > total ||
      (row.state === 'matches' && (matching !== total || missing !== 0)) ||
      (row.state === 'changed' && (missing !== 0 || matching === total)) ||
      (row.state === 'unknown' && missing === 0)
    ) {
      malformed = true;
      continue;
    }
    records.push({
      id: String(row.id),
      operation_id: String(row.operation_id),
      team_id: String(row.team_id),
      action: row.action as 'trash' | 'restore',
      basis: 'catalog_snapshot',
      observed_at: row.observed_at,
      state: row.state as 'matches' | 'changed' | 'unknown',
      member_count: total,
      matching_count: matching,
      missing_count: missing
    });
  }
  return {
    basis: 'current_catalog_snapshot_only',
    status: malformed ? 'malformed' : 'observed',
    records,
    blind_spots: [
      ...limitations,
      ...(rows.length > 100 ? ['Historical material observations truncated at 100 records.'] : []),
      ...(malformed
        ? [
            'Malformed historical material observations were omitted; current generation remains unknown.'
          ]
        : [])
    ]
  };
}
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
      "select id::text,operation_id::text,team_id::text,actor_id::text,action,state,code,member_count,confirmed_count,has_unconfirmed_dispatch,created_at::text,updated_at::text,to_jsonb(e)->'claim_protocol' as claim_protocol,to_jsonb(e)->'execution_epoch' as execution_epoch,(to_jsonb(e)?'execution_epoch') as ownership_observed from public.analytics_material_group_execution e where ($1::uuid is null or actor_id=$1::uuid) and ($2::uuid[] is null or id=any($2::uuid[]) or operation_id=any($2::uuid[])) and ($3::timestamptz is null or created_at >= $3::timestamptz) and updated_at <= $4::timestamptz order by updated_at desc,id limit 101",
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
    unknown = false,
    ownershipMissing = false,
    ownershipMalformed = false,
    legacyOwnership = false;
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
    let claimProtocol: 1 | 2 | null = null,
      epoch: number | null = null;
    if (row.ownership_observed === true) {
      if (row.claim_protocol === 1 && row.execution_epoch === null) {
        claimProtocol = 1;
        legacyOwnership = true;
      } else if (
        row.claim_protocol === 2 &&
        typeof row.execution_epoch === 'number' &&
        Number.isSafeInteger(row.execution_epoch) &&
        row.execution_epoch >= 1
      ) {
        claimProtocol = 2;
        epoch = row.execution_epoch;
      } else if (row.claim_protocol !== null || row.execution_epoch !== null)
        ownershipMalformed = true;
      else legacyOwnership = true;
    } else ownershipMissing = true;
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
      claim_protocol: claimProtocol,
      execution_epoch: epoch,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  const historical = schema.tables.analytics_material_historical_observations
    ? await readHistoricalObservations(
        actor,
        records.map(record => record.id),
        input.since ?? null,
        input.asOf
      )
    : undefined;
  return {
    supported: true,
    records,
    ...(historical ? { historical_observations: historical } : {}),
    blind_spots: [
      ...(historical?.blind_spots ?? [
        'Current material-generation observation is unavailable; a registered original receipt does not prove present lifecycle, placement or provider state.'
      ]),
      ...(historical &&
      records.some(
        record =>
          record.state === 'registered' &&
          record.action !== 'move' &&
          !historical.records.some(observation => observation.operation_id === record.operation_id)
      )
        ? [
            'A registered original operation has no verified current catalog observation; legacy or unobservable generation remains unknown.'
          ]
        : []),
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
      ...(unknown ? ['An unrecognized material-group cause remains UNKNOWN.'] : []),
      ...(ownershipMissing
        ? [
            'Execution epoch projection is unavailable; ownership and prior claim counts remain unknown.'
          ]
        : []),
      ...(ownershipMalformed
        ? ['Malformed execution ownership was omitted; the independent group state remains usable.']
        : []),
      ...(legacyOwnership
        ? [
            'Legacy ownership has no observed epoch; current rows do not reconstruct earlier claims.'
          ]
        : [])
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
